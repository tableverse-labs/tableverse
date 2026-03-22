use crate::dispatch::{is_cloud_kind, read_with_pushdown};
use crate::error::EngineError;
use crate::filter_util::{
    classify_pipeline, extract_combined_filter, mark_qualifying_rgs, pred_col_for_roaring,
    PipelineClass,
};
use crate::materializer::MaterializedView;
use crate::spill_pipeline::SpillPipeline;
use crate::Engine;
use crate::{compiler, executor, reader};
use tv_core::{
    normalize_ops, optimize_with_quantiles, view_hash, ColumnInfo, ColumnStats, SourceFormat,
    ViewExpr, ViewOp,
};

impl Engine {
    pub async fn query_view_count(&self, expr: &ViewExpr) -> Result<u64, EngineError> {
        if let Some(true) = self.check_source_stale(&expr.source_id) {
            return Err(EngineError::Query("source_modified".into()));
        }
        let meta = self
            .catalog
            .get(&expr.source_id)
            .ok_or_else(|| EngineError::SourceNotFound(expr.source_id.clone()))?;

        let stats_for_opt: Vec<ColumnStats> = {
            let cache = self.stats_cache.read().unwrap();
            let id = &meta.id;
            let mut by_col: Vec<Option<ColumnStats>> = vec![None; meta.n_cols];
            for ((sid, col_idx), stats) in cache.iter() {
                if sid == id && *col_idx < meta.n_cols {
                    by_col[*col_idx] = Some(stats.clone());
                }
            }
            by_col.into_iter().flatten().collect()
        };
        let stats_hint = if stats_for_opt.is_empty() {
            None
        } else {
            Some(stats_for_opt.as_slice())
        };
        let source_path_for_q = meta.files.first().map(|s| s.as_str()).unwrap_or(&meta.uri);
        let quantile_arc = self
            .quantile_cache
            .read()
            .unwrap()
            .get(source_path_for_q)
            .cloned();
        let optimized = optimize_with_quantiles(&expr.ops, stats_hint, quantile_arc.as_deref());
        let normalized = normalize_ops(&optimized);
        let norm_hash = view_hash(&format!("{:?}", normalized));

        let count_changes = normalized.iter().any(|op| {
            matches!(
                op,
                ViewOp::Filter { .. }
                    | ViewOp::Deduplicate { .. }
                    | ViewOp::Sample { .. }
                    | ViewOp::GroupBy { .. }
                    | ViewOp::Limit { .. }
                    | ViewOp::TopK { .. }
            )
        });

        if !count_changes {
            return Ok(meta.n_rows);
        }

        let sort_only = normalized
            .iter()
            .all(|op| matches!(op, ViewOp::Sort { .. }));
        if sort_only {
            return Ok(meta.n_rows);
        }

        if let Some(ViewOp::TopK { n, .. }) = normalized
            .iter()
            .find(|op| matches!(op, ViewOp::TopK { .. }))
        {
            let only_topk_and_stateless = normalized.iter().all(|op| {
                matches!(
                    op,
                    ViewOp::TopK { .. }
                        | ViewOp::Sort { .. }
                        | ViewOp::Select { .. }
                        | ViewOp::Drop { .. }
                        | ViewOp::Derive { .. }
                        | ViewOp::Rename { .. }
                )
            });
            if only_topk_and_stateless {
                return Ok((*n).min(meta.n_rows));
            }
        }

        let only_filter = normalized.iter().all(|op| {
            matches!(
                op,
                ViewOp::Filter { .. }
                    | ViewOp::Sort { .. }
                    | ViewOp::Select { .. }
                    | ViewOp::Drop { .. }
                    | ViewOp::Rename { .. }
            )
        });
        if only_filter && !meta.quick_stats.is_empty() {
            if let Some(pred) = extract_combined_filter(&normalized) {
                let fast_count = match &pred {
                    tv_core::Predicate::IsNull { column } => meta
                        .columns
                        .iter()
                        .position(|c| &c.name == column)
                        .and_then(|idx| meta.quick_stats.get(idx))
                        .map(|qs| qs.null_count),
                    tv_core::Predicate::IsNotNull { column } => meta
                        .columns
                        .iter()
                        .position(|c| &c.name == column)
                        .and_then(|idx| meta.quick_stats.get(idx))
                        .map(|qs| meta.n_rows.saturating_sub(qs.null_count)),
                    _ => None,
                };
                if let Some(c) = fast_count {
                    return Ok(c);
                }
            }
        }

        let cache_key = format!("{}:{}", expr.source_id, norm_hash);
        if let Some(mat_view) = self.materializer.get(&cache_key).await {
            return Ok(mat_view.row_count());
        }

        match classify_pipeline(&normalized) {
            PipelineClass::PureRead => Ok(meta.n_rows),

            PipelineClass::StatelessOnly => {
                if matches!(meta.format, SourceFormat::Parquet) && !is_cloud_kind(&meta.kind) {
                    if let Some(pred) = extract_combined_filter(&normalized) {
                        let path = meta.files.first().map(|s| s.as_str()).unwrap_or(&meta.uri);
                        let schema = match self.schema_cache.read().unwrap().get(&meta.id).cloned()
                        {
                            Some(s) => s,
                            None => reader::parquet_schema_and_rows(path).map(|(s, _)| s)?,
                        };
                        if meta.files.len() <= 1 {
                            let bloom_arc = self.bloom_cache.read().unwrap().get(path).cloned();
                            let metadata_arc =
                                self.metadata_cache.read().unwrap().get(path).cloned();
                            let roaring_arc =
                                if let Some(pred_col) = pred_col_for_roaring(&pred, &schema) {
                                    self.roaring_cache
                                        .read()
                                        .unwrap()
                                        .get(&(path.to_string(), pred_col))
                                        .cloned()
                                } else {
                                    None
                                };
                            let mark_rgs =
                                mark_qualifying_rgs(&pred, &schema, path, &self.mark_cache);
                            return reader::count_parquet_filtered(
                                path,
                                &pred,
                                &schema,
                                bloom_arc.as_deref(),
                                roaring_arc.as_deref(),
                                metadata_arc,
                                mark_rgs.as_deref(),
                            );
                        } else {
                            use rayon::prelude::*;
                            let total: u64 = meta
                                .files
                                .par_iter()
                                .map(|fp| {
                                    reader::count_parquet_filtered(
                                        fp, &pred, &schema, None, None, None, None,
                                    )
                                })
                                .collect::<Result<Vec<_>, _>>()?
                                .into_iter()
                                .sum();
                            return Ok(total);
                        }
                    }
                }
                let sl_cache_key = format!("{}:sl:{}", expr.source_id, norm_hash);
                if let Some(mat_view) = self.materializer.get(&sl_cache_key).await {
                    return Ok(mat_view.row_count());
                }
                let meta_c = meta.clone();
                let ops_c = normalized.clone();
                let schema_hint = self.schema_cache.read().unwrap().get(&meta.id).cloned();
                let mat_view = self
                    .materializer
                    .get_or_materialize(sl_cache_key, move || async move {
                        let all_batches = read_with_pushdown(&meta_c, &ops_c, schema_hint).await?;
                        let processed =
                            executor::execute_pipeline_skip_filter(all_batches, &ops_c)?;
                        let total_rows: u64 = processed.iter().map(|b| b.num_rows() as u64).sum();
                        Ok(MaterializedView::Batches {
                            batches: processed,
                            total_rows,
                        })
                    })
                    .await?;
                Ok(mat_view.row_count())
            }

            PipelineClass::NeedsMaterialization => {
                let meta_c = meta.clone();
                let ops_c = normalized.clone();
                let schema_hint = self.schema_cache.read().unwrap().get(&meta.id).cloned();
                let temp_root = self.temp_root.clone();
                let mat_view = self
                    .materializer
                    .get_or_materialize(cache_key, move || async move {
                        tokio::task::spawn_blocking(move || {
                            SpillPipeline::new(temp_root).build(&meta_c, &ops_c, schema_hint)
                        })
                        .await
                        .map_err(|e| EngineError::Query(e.to_string()))?
                    })
                    .await?;
                Ok(mat_view.row_count())
            }
        }
    }

    pub fn query_view_schema(&self, expr: &ViewExpr) -> Result<Vec<ColumnInfo>, EngineError> {
        if let Some(true) = self.check_source_stale(&expr.source_id) {
            return Err(EngineError::Query("source_modified".into()));
        }
        let meta = self
            .catalog
            .get(&expr.source_id)
            .ok_or_else(|| EngineError::SourceNotFound(expr.source_id.clone()))?;

        let normalized = normalize_ops(&expr.ops);
        let schema = compiler::schema::infer_schema(&meta.columns, &normalized)
            .map_err(|e| EngineError::Query(e.to_string()))?;

        Ok(schema)
    }

    pub fn ops_view_hash(expr: &ViewExpr) -> String {
        view_hash(&format!("{:?}", expr.ops))
    }
}
