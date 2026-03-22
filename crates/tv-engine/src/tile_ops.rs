use crate::dispatch::{
    is_cloud_kind, read_full_dispatch, read_tile_dispatch, read_with_pushdown, slice_batches,
};
use crate::error::EngineError;
use crate::external_sort::ExternalSorter;
use crate::filter_util::{
    classify_pipeline, extract_combined_filter, mark_qualifying_rgs, pred_col_for_roaring,
    PipelineClass,
};
use crate::materializer::MaterializedView;
use crate::query::{maybe_dict_encode_batch, project_tile_columns, serialize_to_arrow_ipc};
use crate::spill_pipeline::SpillPipeline;
use crate::Engine;
use crate::{executor, reader};
use crate::{sort_index, sparse_sort_index};
use arrow::array::Array;
use arrow::record_batch::RecordBatch;
use std::sync::Arc;
use tracing::debug;
use tv_core::{
    needed_column_indices, BatchTileRequest, SourceFormat, TileRequest, TileResponse, ViewExpr,
    ViewOp,
};

impl Engine {
    pub async fn query_tile(&self, req: &TileRequest) -> Result<TileResponse, EngineError> {
        let meta = self
            .catalog
            .get(&req.source_id)
            .ok_or_else(|| EngineError::SourceNotFound(req.source_id.clone()))?;

        if let Some(sort) = &req.sort {
            let cache_key = format!("{}:sort:{:?}", req.source_id, sort);
            let meta_c = meta.clone();
            let sort_c = sort.clone();
            let mat_view = self
                .materializer
                .get_or_materialize(cache_key, move || async move {
                    let all = read_full_dispatch(&meta_c, None).await?;
                    let sorted = executor::apply_sort_spec(all, &sort_c)?;
                    let total_rows: u64 = sorted.iter().map(|b| b.num_rows() as u64).sum();
                    Ok(MaterializedView::Batches {
                        batches: sorted,
                        total_rows,
                    })
                })
                .await?;

            if let MaterializedView::Batches { batches, .. } = mat_view.as_ref() {
                let total: usize = batches.iter().map(|b| b.num_rows()).sum();
                let start = req.row as usize;
                let len = (req.rows as usize).min(total.saturating_sub(start));
                let sliced = slice_batches(batches, start, len);
                let projected: Vec<RecordBatch> = sliced
                    .iter()
                    .map(|b| project_tile_columns(b, req.col, req.cols))
                    .collect::<Result<_, _>>()?;
                let data = serialize_to_arrow_ipc(&projected)?;
                return Ok(TileResponse {
                    source_id: req.source_id.clone(),
                    row: req.row,
                    col: req.col,
                    data,
                    is_provisional: false,
                    job_id: None,
                });
            }
        }

        let col_end = (req.col + req.cols).min(meta.n_cols);
        let col_indices: Vec<usize> = (req.col..col_end).collect();
        let tile_meta_arc = if matches!(meta.format, SourceFormat::Parquet)
            && !is_cloud_kind(&meta.kind)
            && meta.files.len() <= 1
        {
            let path = meta.files.first().map(|s| s.as_str()).unwrap_or(&meta.uri);
            self.metadata_cache.read().unwrap().get(path).cloned()
        } else {
            None
        };
        let mut batches = read_tile_dispatch(
            &meta,
            req.row as usize,
            &col_indices,
            req.rows as usize,
            tile_meta_arc,
        )
        .await?;

        if let Some(filter) = &req.filter {
            batches = executor::apply_filter_expr(batches, filter)?;
        }

        let data = serialize_to_arrow_ipc(&batches)?;
        Ok(TileResponse {
            source_id: req.source_id.clone(),
            row: req.row,
            col: req.col,
            data,
            is_provisional: false,
            job_id: None,
        })
    }

    pub async fn query_view_tile(
        &self,
        expr: &ViewExpr,
        row: u64,
        col_offset: usize,
        rows: u64,
        cols: usize,
    ) -> Result<TileResponse, EngineError> {
        if let Some(true) = self.check_source_stale(&expr.source_id) {
            return Err(EngineError::Query("source_modified".into()));
        }

        let meta = self
            .catalog
            .get(&expr.source_id)
            .ok_or_else(|| EngineError::SourceNotFound(expr.source_id.clone()))?;

        let stats_for_opt: Vec<tv_core::ColumnStats> = {
            let cache = self.stats_cache.read().unwrap();
            let id = &meta.id;
            let mut by_col: Vec<Option<tv_core::ColumnStats>> = vec![None; meta.n_cols];
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
        let optimized =
            tv_core::optimize_with_quantiles(&expr.ops, stats_hint, quantile_arc.as_deref());
        let normalized = tv_core::normalize_ops(&optimized);
        let norm_hash = tv_core::view_hash(&format!("{:?}", normalized));

        if matches!(meta.format, SourceFormat::Parquet)
            && !is_cloud_kind(&meta.kind)
            && meta.files.len() == 1
        {
            if let Some(sort_keys) = normalized.iter().find_map(|op| {
                if let ViewOp::Sort { keys } = op {
                    Some(keys.clone())
                } else {
                    None
                }
            }) {
                let counter_key = format!("{}:{:?}", meta.id, sort_keys);
                let should_build = {
                    let mut counter = self.sort_access_counter.lock().unwrap();
                    let cnt = counter.entry(counter_key).or_insert(0);
                    *cnt += 1;
                    *cnt == 1
                };
                if should_build {
                    let cache_key_bg = format!("{}:{}", expr.source_id, norm_hash);
                    let already_cached = self.materializer.get(&cache_key_bg).await.is_some();
                    if !already_cached {
                        let meta_bg = meta.clone();
                        let ops_bg = normalized.clone();
                        let schema_hint_bg =
                            self.schema_cache.read().unwrap().get(&meta.id).cloned();
                        let temp_root_bg = self.temp_root.clone();
                        let materializer_bg = Arc::clone(&self.materializer);
                        let index_catalog_bg = Arc::clone(&self.index_catalog);
                        let source_path_bg = meta
                            .files
                            .first()
                            .cloned()
                            .unwrap_or_else(|| meta.uri.clone());
                        let sort_keys_bg: Option<Vec<tv_core::SortKey>> =
                            ops_bg.iter().find_map(|op| {
                                if let ViewOp::Sort { keys } = op {
                                    Some(keys.clone())
                                } else {
                                    None
                                }
                            });
                        tokio::spawn(async move {
                            if let Ok(Ok(full_view)) = tokio::task::spawn_blocking(move || {
                                SpillPipeline::new(temp_root_bg).build_full(
                                    &meta_bg,
                                    &ops_bg,
                                    schema_hint_bg,
                                )
                            })
                            .await
                            {
                                let sparse_spill =
                                    if let MaterializedView::SparseSortIndexBacked {
                                        ref spill_path,
                                        ..
                                    } = full_view
                                    {
                                        Some(spill_path.clone())
                                    } else {
                                        None
                                    };
                                if let Some(spill) = sparse_spill {
                                    if let Some(sort_keys) = sort_keys_bg {
                                        if let Ok(tvs_path) = index_catalog_bg
                                            .register_sparse_sort_index(&source_path_bg, &sort_keys)
                                        {
                                            let _ =
                                                sparse_sort_index::build_sparse(&spill, &tvs_path);
                                        }
                                    }
                                }
                                materializer_bg.replace(cache_key_bg, full_view).await;
                            }
                        });
                    }
                }
            }
        }

        let pipeline_class = classify_pipeline(&normalized);
        debug!(
            source = %expr.source_id,
            row = row,
            col = col_offset,
            class = ?pipeline_class,
            "tile request"
        );
        match pipeline_class {
            PipelineClass::PureRead => {
                let col_end = (col_offset + cols).min(meta.n_cols);
                let col_indices: Vec<usize> = (col_offset..col_end).collect();
                let pure_metadata_arc = if matches!(meta.format, SourceFormat::Parquet)
                    && !is_cloud_kind(&meta.kind)
                    && meta.files.len() <= 1
                {
                    let path = meta.files.first().map(|s| s.as_str()).unwrap_or(&meta.uri);
                    self.metadata_cache.read().unwrap().get(path).cloned()
                } else {
                    None
                };
                let batches = read_tile_dispatch(
                    &meta,
                    row as usize,
                    &col_indices,
                    rows as usize,
                    pure_metadata_arc,
                )
                .await?;
                let dict_mask = if let Some(first) = batches.first() {
                    self.build_dict_mask(&expr.source_id, col_offset, &first.schema())
                } else {
                    vec![]
                };
                let encoded: Vec<RecordBatch> = if dict_mask.iter().any(|&b| b) {
                    batches
                        .iter()
                        .map(|b| maybe_dict_encode_batch(b, &dict_mask))
                        .collect::<Result<_, _>>()?
                } else {
                    batches
                };
                let data = serialize_to_arrow_ipc(&encoded)?;
                Ok(TileResponse {
                    source_id: expr.source_id.clone(),
                    row,
                    col: col_offset,
                    data,
                    is_provisional: false,
                    job_id: None,
                })
            }

            PipelineClass::StatelessOnly => {
                let filter_pred = extract_combined_filter(&normalized);
                if let Some(pred) = filter_pred {
                    if matches!(meta.format, SourceFormat::Parquet) && !is_cloud_kind(&meta.kind) {
                        let schema = match self.schema_cache.read().unwrap().get(&meta.id).cloned()
                        {
                            Some(s) => s,
                            None => {
                                let path =
                                    meta.files.first().map(|s| s.as_str()).unwrap_or(&meta.uri);
                                reader::parquet_schema_and_rows(path).map(|(s, _)| s)?
                            }
                        };

                        if meta.files.len() <= 1 {
                            let path = meta.files.first().map(|s| s.as_str()).unwrap_or(&meta.uri);
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
                            let index_key = (meta.id.clone(), norm_hash.clone());
                            let existing_index = self
                                .filter_rg_index
                                .read()
                                .unwrap()
                                .get(&index_key)
                                .cloned();

                            let col_end = (col_offset + cols).min(schema.fields().len());
                            let display_indices: Vec<usize> = (col_offset..col_end).collect();
                            let op_indices = needed_column_indices(&normalized, &schema);
                            let col_selection: Option<Vec<usize>> =
                                if let Some(mut op_idx) = op_indices {
                                    for &di in &display_indices {
                                        if !op_idx.contains(&di) {
                                            op_idx.push(di);
                                        }
                                    }
                                    op_idx.sort_unstable();
                                    op_idx.dedup();
                                    if op_idx.len() == schema.fields().len() {
                                        None
                                    } else {
                                        Some(op_idx)
                                    }
                                } else {
                                    None
                                };

                            let mark_rgs =
                                mark_qualifying_rgs(&pred, &schema, path, &self.mark_cache);
                            let batches = if let Some(rg_index) = existing_index {
                                let path_r = path.to_string();
                                let pred_r = pred.clone();
                                let schema_r = Arc::clone(&schema);
                                let bloom_r = bloom_arc.clone();
                                let roaring_r = roaring_arc.clone();
                                let col_sel_r = col_selection.clone();
                                let mark_r = mark_rgs.clone();
                                let row_r = row as usize;
                                let rows_r = rows as usize;
                                tokio::task::spawn_blocking(move || {
                                    reader::read_parquet_filtered_tile_indexed(
                                        &path_r,
                                        &pred_r,
                                        &schema_r,
                                        bloom_r.as_deref(),
                                        roaring_r.as_deref(),
                                        row_r,
                                        rows_r,
                                        &rg_index,
                                        col_sel_r.as_deref(),
                                        mark_r.as_deref(),
                                    )
                                })
                                .await
                                .map_err(|e| EngineError::Query(e.to_string()))??
                            } else {
                                let path_r = path.to_string();
                                let pred_r = pred.clone();
                                let schema_r = Arc::clone(&schema);
                                let bloom_r = bloom_arc.clone();
                                let roaring_r = roaring_arc.clone();
                                let metadata_r = metadata_arc.clone();
                                let col_sel_r = col_selection.clone();
                                let mark_r = mark_rgs.clone();
                                let row_r = row as usize;
                                let rows_r = rows as usize;
                                let result = tokio::task::spawn_blocking(move || {
                                    reader::read_parquet_filtered_tile(
                                        &path_r,
                                        &pred_r,
                                        &schema_r,
                                        bloom_r.as_deref(),
                                        roaring_r.as_deref(),
                                        row_r,
                                        rows_r,
                                        metadata_r,
                                        col_sel_r.as_deref(),
                                        mark_r.as_deref(),
                                    )
                                })
                                .await
                                .map_err(|e| EngineError::Query(e.to_string()))??;
                                let filter_rg_index = Arc::clone(&self.filter_rg_index);
                                let path_owned = path.to_string();
                                let pred_c = pred.clone();
                                let schema_c = Arc::clone(&schema);
                                let key_c = index_key;
                                let bloom_bg = bloom_arc.clone();
                                let roaring_bg = roaring_arc.clone();
                                let metadata_bg = metadata_arc.clone();
                                tokio::task::spawn_blocking(move || {
                                    if let Ok(index) = reader::build_filter_rg_index(
                                        &path_owned,
                                        &pred_c,
                                        &schema_c,
                                        bloom_bg.as_deref(),
                                        roaring_bg.as_deref(),
                                        metadata_bg,
                                    ) {
                                        filter_rg_index
                                            .write()
                                            .unwrap()
                                            .insert(key_c, Arc::new(index));
                                    }
                                });
                                result
                            };

                            let processed =
                                executor::execute_pipeline_skip_filter(batches, &normalized)?;
                            let projected: Vec<RecordBatch> = if col_selection.is_some() {
                                let display_names: Vec<String> = (col_offset..col_end)
                                    .map(|i| schema.field(i).name().clone())
                                    .collect();
                                processed
                                    .iter()
                                    .map(|b| {
                                        project_batch_by_names(b, &display_names)
                                            .map_err(EngineError::Arrow)
                                    })
                                    .collect::<Result<_, _>>()?
                            } else {
                                processed
                                    .iter()
                                    .map(|b| project_tile_columns(b, col_offset, cols))
                                    .collect::<Result<_, _>>()?
                            };
                            let dict_mask = if let Some(first) = projected.first() {
                                self.build_dict_mask(&expr.source_id, col_offset, &first.schema())
                            } else {
                                vec![]
                            };
                            let encoded: Vec<RecordBatch> = if dict_mask.iter().any(|&b| b) {
                                projected
                                    .iter()
                                    .map(|b| maybe_dict_encode_batch(b, &dict_mask))
                                    .collect::<Result<_, _>>()?
                            } else {
                                projected
                            };
                            let data = serialize_to_arrow_ipc(&encoded)?;
                            return Ok(TileResponse {
                                source_id: expr.source_id.clone(),
                                row,
                                col: col_offset,
                                data,
                                is_provisional: false,
                                job_id: None,
                            });
                        } else {
                            let batches = reader::read_filtered_tile_multifile(
                                &meta.files,
                                &pred,
                                &schema,
                                &normalized,
                                row as usize,
                                rows as usize,
                            )?;
                            let projected: Vec<RecordBatch> = batches
                                .iter()
                                .map(|b| project_tile_columns(b, col_offset, cols))
                                .collect::<Result<_, _>>()?;
                            let dict_mask = if let Some(first) = projected.first() {
                                self.build_dict_mask(&expr.source_id, col_offset, &first.schema())
                            } else {
                                vec![]
                            };
                            let encoded: Vec<RecordBatch> = if dict_mask.iter().any(|&b| b) {
                                projected
                                    .iter()
                                    .map(|b| maybe_dict_encode_batch(b, &dict_mask))
                                    .collect::<Result<_, _>>()?
                            } else {
                                projected
                            };
                            let data = serialize_to_arrow_ipc(&encoded)?;
                            return Ok(TileResponse {
                                source_id: expr.source_id.clone(),
                                row,
                                col: col_offset,
                                data,
                                is_provisional: false,
                                job_id: None,
                            });
                        }
                    }
                }

                let cache_key = format!("{}:sl:{}", expr.source_id, norm_hash);
                let meta_c = meta.clone();
                let ops_c = normalized.clone();
                let schema_hint = self.schema_cache.read().unwrap().get(&meta.id).cloned();
                let mat_view = self
                    .materializer
                    .get_or_materialize(cache_key, move || async move {
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

                if let MaterializedView::Batches { batches, .. } = mat_view.as_ref() {
                    let total: usize = batches.iter().map(|b| b.num_rows()).sum();
                    let start = (row as usize).min(total);
                    let len = (rows as usize).min(total.saturating_sub(start));
                    let sliced = slice_batches(batches, start, len);
                    let projected: Vec<RecordBatch> = sliced
                        .iter()
                        .map(|b| project_tile_columns(b, col_offset, cols))
                        .collect::<Result<_, _>>()?;
                    let dict_mask = if let Some(first) = projected.first() {
                        self.build_dict_mask(&expr.source_id, col_offset, &first.schema())
                    } else {
                        vec![]
                    };
                    let encoded: Vec<RecordBatch> = if dict_mask.iter().any(|&b| b) {
                        projected
                            .iter()
                            .map(|b| maybe_dict_encode_batch(b, &dict_mask))
                            .collect::<Result<_, _>>()?
                    } else {
                        projected
                    };
                    let data = serialize_to_arrow_ipc(&encoded)?;
                    return Ok(TileResponse {
                        source_id: expr.source_id.clone(),
                        row,
                        col: col_offset,
                        data,
                        is_provisional: false,
                        job_id: None,
                    });
                }

                Err(EngineError::Query(
                    "unexpected materialized view type".into(),
                ))
            }

            PipelineClass::NeedsMaterialization => {
                if is_sort_satisfied_by_presort(&normalized, &meta) {
                    let col_end = (col_offset + cols).min(meta.n_cols);
                    let col_indices: Vec<usize> = (col_offset..col_end).collect();
                    let presort_metadata_arc = if matches!(meta.format, SourceFormat::Parquet)
                        && !is_cloud_kind(&meta.kind)
                        && meta.files.len() <= 1
                    {
                        let path = meta.files.first().map(|s| s.as_str()).unwrap_or(&meta.uri);
                        self.metadata_cache.read().unwrap().get(path).cloned()
                    } else {
                        None
                    };
                    let batches = read_tile_dispatch(
                        &meta,
                        row as usize,
                        &col_indices,
                        rows as usize,
                        presort_metadata_arc,
                    )
                    .await?;
                    let dict_mask = if let Some(first) = batches.first() {
                        self.build_dict_mask(&expr.source_id, col_offset, &first.schema())
                    } else {
                        vec![]
                    };
                    let encoded: Vec<RecordBatch> = if dict_mask.iter().any(|&b| b) {
                        batches
                            .iter()
                            .map(|b| maybe_dict_encode_batch(b, &dict_mask))
                            .collect::<Result<_, _>>()?
                    } else {
                        batches
                    };
                    let data = serialize_to_arrow_ipc(&encoded)?;
                    return Ok(TileResponse {
                        source_id: expr.source_id.clone(),
                        row,
                        col: col_offset,
                        data,
                        is_provisional: false,
                        job_id: None,
                    });
                }

                let cache_key = format!("{}:{}", expr.source_id, norm_hash);
                let meta_c = meta.clone();
                let ops_c = normalized.clone();
                let schema_hint = self.schema_cache.read().unwrap().get(&meta.id).cloned();
                let temp_root = self.temp_root.clone();

                let mat_view = self
                    .materializer
                    .get_or_materialize(cache_key.clone(), move || async move {
                        tokio::task::spawn_blocking(move || {
                            SpillPipeline::new(temp_root).build(&meta_c, &ops_c, schema_hint)
                        })
                        .await
                        .map_err(|e| EngineError::Query(e.to_string()))?
                    })
                    .await?;

                if mat_view.is_provisional() {
                    let job_id_bg = mat_view.job_id().unwrap_or("").to_string();
                    if !job_id_bg.is_empty()
                        && self.job_registry.get_job(&job_id_bg).await.is_none()
                    {
                        let job = self
                            .job_registry
                            .register_with_id(job_id_bg, expr.clone(), norm_hash.clone())
                            .await;
                        let cache_key_bg = cache_key.clone();
                        let meta_bg = meta.clone();
                        let ops_bg = normalized.clone();
                        let schema_hint_bg =
                            self.schema_cache.read().unwrap().get(&meta.id).cloned();
                        let temp_root_bg = self.temp_root.clone();
                        let materializer_bg = Arc::clone(&self.materializer);
                        tokio::spawn(async move {
                            let t0 = std::time::Instant::now();
                            match tokio::task::spawn_blocking(move || {
                                SpillPipeline::new(temp_root_bg).build_full(
                                    &meta_bg,
                                    &ops_bg,
                                    schema_hint_bg,
                                )
                            })
                            .await
                            {
                                Ok(Ok(full_view)) => {
                                    let total = full_view.row_count();
                                    materializer_bg.replace(cache_key_bg, full_view).await;
                                    job.set_phase(crate::job_registry::JobPhase::Complete).await;
                                    job.emit(crate::job_registry::JobEvent::Complete {
                                        total_rows: total,
                                        elapsed_ms: t0.elapsed().as_millis() as u64,
                                    })
                                    .await;
                                }
                                Ok(Err(e)) => {
                                    let msg = e.to_string();
                                    job.set_phase(crate::job_registry::JobPhase::Failed(
                                        msg.clone(),
                                    ))
                                    .await;
                                    job.emit(crate::job_registry::JobEvent::Failed {
                                        message: msg,
                                    })
                                    .await;
                                }
                                Err(e) => {
                                    let msg = e.to_string();
                                    job.set_phase(crate::job_registry::JobPhase::Failed(
                                        msg.clone(),
                                    ))
                                    .await;
                                    job.emit(crate::job_registry::JobEvent::Failed {
                                        message: msg,
                                    })
                                    .await;
                                }
                            }
                        });
                    }
                }

                let dict_mask_nm = {
                    let schema_hint = self.schema_cache.read().unwrap().get(&meta.id).cloned();
                    if let Some(schema) = schema_hint {
                        let col_end = (col_offset + cols).min(schema.fields().len());
                        let projected_fields: Vec<_> =
                            schema.fields()[col_offset..col_end].to_vec();
                        let projected_schema =
                            Arc::new(arrow::datatypes::Schema::new(projected_fields));
                        self.build_dict_mask(&expr.source_id, col_offset, &projected_schema)
                    } else {
                        vec![]
                    }
                };
                serve_materialized_tile(
                    mat_view.as_ref(),
                    row,
                    col_offset,
                    rows,
                    cols,
                    &expr.source_id,
                    &dict_mask_nm,
                )
            }
        }
    }

    pub async fn query_view_tile_agg(
        &self,
        expr: &ViewExpr,
        row: u64,
        col_offset: usize,
        rows: u64,
        cols: usize,
    ) -> Result<TileResponse, EngineError> {
        let raw = self
            .query_view_tile(expr, row, col_offset, rows, cols)
            .await?;
        let raw_batches = deserialize_ipc_to_batches(&raw.data)?;
        let agg_batch = aggregate_tile_batch(&raw_batches)?;
        let agg_data = crate::query::serialize_to_arrow_ipc(&[agg_batch])?;
        Ok(TileResponse {
            source_id: raw.source_id,
            row: raw.row,
            col: raw.col,
            data: agg_data,
            is_provisional: raw.is_provisional,
            job_id: raw.job_id,
        })
    }

    pub async fn query_view_tile_batch(
        &self,
        expr: &ViewExpr,
        tiles: &[BatchTileRequest],
    ) -> Result<Vec<TileResponse>, EngineError> {
        if tiles.is_empty() {
            return Ok(vec![]);
        }
        let futs: Vec<_> = tiles
            .iter()
            .map(|t| self.query_view_tile(expr, t.row, t.col, t.rows, t.cols))
            .collect();
        futures::future::join_all(futs).await.into_iter().collect()
    }

    pub fn build_dict_mask(
        &self,
        source_id: &str,
        col_offset: usize,
        projected_batch_schema: &arrow::datatypes::Schema,
    ) -> Vec<bool> {
        let stats_cache = self.stats_cache.read().unwrap();
        projected_batch_schema
            .fields()
            .iter()
            .enumerate()
            .map(|(i, field)| {
                let source_col = col_offset + i;
                if !matches!(
                    field.data_type(),
                    arrow::datatypes::DataType::Utf8 | arrow::datatypes::DataType::LargeUtf8
                ) {
                    return false;
                }
                let key = (source_id.to_string(), source_col);
                stats_cache
                    .get(&key)
                    .and_then(|s| s.distinct_count)
                    .map(|dc| dc < 1000)
                    .unwrap_or(false)
            })
            .collect()
    }
}

fn is_sort_satisfied_by_presort(normalized: &[ViewOp], meta: &tv_core::SourceMeta) -> bool {
    let pre_sorted = match &meta.pre_sorted_by {
        Some(p) if !p.is_empty() => p,
        _ => return false,
    };
    let sort_keys = match normalized.iter().find_map(|op| {
        if let ViewOp::Sort { keys } = op {
            Some(keys)
        } else {
            None
        }
    }) {
        Some(k) => k,
        None => return false,
    };
    let non_sort_ops: Vec<&ViewOp> = normalized
        .iter()
        .filter(|op| !matches!(op, ViewOp::Sort { .. }))
        .collect();
    if !non_sort_ops.is_empty() {
        return false;
    }
    sort_keys.len() <= pre_sorted.len()
        && sort_keys
            .iter()
            .zip(pre_sorted.iter())
            .all(|(req, existing)| {
                req.column == existing.column
                    && req.descending == existing.descending
                    && req.nulls_last == existing.nulls_last
            })
}

fn project_batch_by_names(
    batch: &RecordBatch,
    names: &[String],
) -> Result<RecordBatch, arrow::error::ArrowError> {
    let indices: Vec<usize> = names
        .iter()
        .filter_map(|name| batch.schema().index_of(name).ok())
        .collect();
    batch.project(&indices)
}

fn serve_materialized_tile(
    mat_view: &MaterializedView,
    row: u64,
    col_offset: usize,
    rows: u64,
    cols: usize,
    source_id: &str,
    dict_mask: &[bool],
) -> Result<TileResponse, EngineError> {
    match mat_view {
        MaterializedView::Batches { batches, .. } => {
            let total: usize = batches.iter().map(|b| b.num_rows()).sum();
            let start = (row as usize).min(total);
            let len = (rows as usize).min(total.saturating_sub(start));
            let sliced = slice_batches(batches, start, len);
            let projected: Vec<RecordBatch> = sliced
                .iter()
                .map(|b| project_tile_columns(b, col_offset, cols))
                .collect::<Result<_, _>>()?;
            let encoded: Vec<RecordBatch> = if dict_mask.iter().any(|&b| b) {
                projected
                    .iter()
                    .map(|b| maybe_dict_encode_batch(b, dict_mask))
                    .collect::<Result<_, _>>()?
            } else {
                projected
            };
            let data = serialize_to_arrow_ipc(&encoded)?;
            Ok(TileResponse {
                source_id: source_id.to_string(),
                row,
                col: col_offset,
                data,
                is_provisional: false,
                job_id: None,
            })
        }
        MaterializedView::SortedRuns {
            runs,
            cumulative_rows,
            schema,
            sort_keys,
            dedup_columns,
            ..
        } => {
            let sorter = ExternalSorter::new(sort_keys.clone(), schema.clone());
            let batches = match dedup_columns {
                None => sorter.merge_tile(runs, cumulative_rows, row as usize, rows as usize)?,
                Some(dedup_cols) => sorter.merge_dedup_tile(
                    runs,
                    cumulative_rows,
                    dedup_cols,
                    row as usize,
                    rows as usize,
                )?,
            };
            let projected: Vec<RecordBatch> = batches
                .iter()
                .map(|b| project_tile_columns(b, col_offset, cols))
                .collect::<Result<_, _>>()?;
            let encoded: Vec<RecordBatch> = if dict_mask.iter().any(|&b| b) {
                projected
                    .iter()
                    .map(|b| maybe_dict_encode_batch(b, dict_mask))
                    .collect::<Result<_, _>>()?
            } else {
                projected
            };
            let data = serialize_to_arrow_ipc(&encoded)?;
            Ok(TileResponse {
                source_id: source_id.to_string(),
                row,
                col: col_offset,
                data,
                is_provisional: false,
                job_id: None,
            })
        }
        MaterializedView::AggregateResult { run, schema, .. } => {
            let n_cols = schema.fields().len();
            let col_end = (col_offset + cols).min(n_cols);
            let col_indices: Vec<usize> = (col_offset..col_end).collect();
            let batches = crate::reader::read_parquet_tile(
                run.path.to_str().unwrap_or(""),
                row as usize,
                &col_indices,
                rows as usize,
                None,
            )?;
            let data = serialize_to_arrow_ipc(&batches)?;
            Ok(TileResponse {
                source_id: source_id.to_string(),
                row,
                col: col_offset,
                data,
                is_provisional: false,
                job_id: None,
            })
        }
        MaterializedView::SortIndexBacked {
            index_path,
            source_path,
            n_cols,
            ..
        } => {
            let row_ids = sort_index::tile_lookup(index_path, row as usize, rows as usize)?;
            let col_end = (col_offset + cols).min(*n_cols);
            let col_indices: Vec<usize> = (col_offset..col_end).collect();
            let batches = sort_index::read_rows_by_ids(source_path, &row_ids, &col_indices)?;
            let data = serialize_to_arrow_ipc(&batches)?;
            Ok(TileResponse {
                source_id: source_id.to_string(),
                row,
                col: col_offset,
                data,
                is_provisional: false,
                job_id: None,
            })
        }
        MaterializedView::ProvisionalAgg {
            batches, job_id, ..
        } => {
            let total: usize = batches.iter().map(|b| b.num_rows()).sum();
            let start = (row as usize).min(total);
            let len = (rows as usize).min(total.saturating_sub(start));
            let sliced = slice_batches(batches, start, len);
            let projected: Vec<RecordBatch> = sliced
                .iter()
                .map(|b| project_tile_columns(b, col_offset, cols))
                .collect::<Result<_, _>>()?;
            let encoded: Vec<RecordBatch> = if dict_mask.iter().any(|&b| b) {
                projected
                    .iter()
                    .map(|b| maybe_dict_encode_batch(b, dict_mask))
                    .collect::<Result<_, _>>()?
            } else {
                projected
            };
            let data = serialize_to_arrow_ipc(&encoded)?;
            Ok(TileResponse {
                source_id: source_id.to_string(),
                row,
                col: col_offset,
                data,
                is_provisional: true,
                job_id: Some(job_id.clone()),
            })
        }
        MaterializedView::ProvisionalSort {
            runs,
            cumulative_rows,
            schema,
            sort_keys,
            job_id,
            ..
        } => {
            let sorter = ExternalSorter::new(sort_keys.clone(), schema.clone());
            let batches = sorter.merge_tile(runs, cumulative_rows, row as usize, rows as usize)?;
            let projected: Vec<RecordBatch> = batches
                .iter()
                .map(|b| project_tile_columns(b, col_offset, cols))
                .collect::<Result<_, _>>()?;
            let encoded: Vec<RecordBatch> = if dict_mask.iter().any(|&b| b) {
                projected
                    .iter()
                    .map(|b| maybe_dict_encode_batch(b, dict_mask))
                    .collect::<Result<_, _>>()?
            } else {
                projected
            };
            let data = serialize_to_arrow_ipc(&encoded)?;
            Ok(TileResponse {
                source_id: source_id.to_string(),
                row,
                col: col_offset,
                data,
                is_provisional: true,
                job_id: Some(job_id.clone()),
            })
        }
        MaterializedView::BitmapGroupBy { batches, .. } => {
            let total: usize = batches.iter().map(|b| b.num_rows()).sum();
            let start = (row as usize).min(total);
            let len = (rows as usize).min(total.saturating_sub(start));
            let sliced = slice_batches(batches, start, len);
            let projected: Vec<RecordBatch> = sliced
                .iter()
                .map(|b| project_tile_columns(b, col_offset, cols))
                .collect::<Result<_, _>>()?;
            let encoded: Vec<RecordBatch> = if dict_mask.iter().any(|&b| b) {
                projected
                    .iter()
                    .map(|b| maybe_dict_encode_batch(b, dict_mask))
                    .collect::<Result<_, _>>()?
            } else {
                projected
            };
            let data = serialize_to_arrow_ipc(&encoded)?;
            Ok(TileResponse {
                source_id: source_id.to_string(),
                row,
                col: col_offset,
                data,
                is_provisional: false,
                job_id: None,
            })
        }
        MaterializedView::SparseSortIndexBacked {
            index,
            spill_path,
            schema,
            ..
        } => {
            let lookups = sparse_sort_index::sparse_tile_lookup(index, row as usize, rows as usize);
            let batches = sparse_sort_index::read_sparse_tile(
                spill_path, &lookups, col_offset, cols, schema,
            )?;
            let data = serialize_to_arrow_ipc(&batches)?;
            Ok(TileResponse {
                source_id: source_id.to_string(),
                row,
                col: col_offset,
                data,
                is_provisional: false,
                job_id: None,
            })
        }
        MaterializedView::RowCount { .. } => Err(EngineError::Query(
            "unexpected RowCount materialized view for tile".into(),
        )),
    }
}

fn deserialize_ipc_to_batches(ipc: &[u8]) -> Result<Vec<RecordBatch>, EngineError> {
    let reader = arrow::ipc::reader::StreamReader::try_new(std::io::Cursor::new(ipc), None)
        .map_err(EngineError::Arrow)?;
    reader
        .collect::<Result<Vec<_>, _>>()
        .map_err(EngineError::Arrow)
}

fn aggregate_tile_batch(batches: &[RecordBatch]) -> Result<RecordBatch, EngineError> {
    use arrow::array::{Float32Array, Float64Array, UInt8Array};
    use arrow::datatypes::{DataType, Field, Schema};

    if batches.is_empty() {
        return Ok(RecordBatch::new_empty(Arc::new(Schema::empty())));
    }

    let schema = batches[0].schema();
    let total_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    if total_rows == 0 {
        return Ok(RecordBatch::new_empty(Arc::new(Schema::empty())));
    }

    let mut fields = Vec::new();
    let mut cols: Vec<Arc<dyn arrow::array::Array>> = Vec::new();

    for field in schema.fields() {
        let arrays: Vec<&dyn arrow::array::Array> = batches
            .iter()
            .map(|b| {
                b.column_by_name(field.name())
                    .map(|c| c.as_ref())
                    .unwrap_or_else(|| b.column(0).as_ref())
            })
            .collect();

        let null_count: usize = arrays.iter().map(|a| a.null_count()).sum();
        let null_pct = null_count as f32 / total_rows as f32;

        let type_char: u8 = match field.data_type() {
            DataType::Boolean => 2,
            DataType::Utf8 | DataType::LargeUtf8 => 1,
            DataType::Null => 3,
            DataType::Int8
            | DataType::Int16
            | DataType::Int32
            | DataType::Int64
            | DataType::UInt8
            | DataType::UInt16
            | DataType::UInt32
            | DataType::UInt64
            | DataType::Float32
            | DataType::Float64 => 0,
            _ => 1,
        };

        let mean: f64 = if type_char == 0 {
            let mut sum = 0.0f64;
            let mut count = 0u64;
            for arr in &arrays {
                if let Ok(f64_col) = arrow::compute::cast(*arr, &DataType::Float64) {
                    if let Some(fa) = f64_col.as_any().downcast_ref::<Float64Array>() {
                        for i in 0..fa.len() {
                            if !fa.is_null(i) {
                                sum += fa.value(i);
                                count += 1;
                            }
                        }
                    }
                }
            }
            if count > 0 {
                sum / count as f64
            } else {
                0.0
            }
        } else {
            0.0
        };

        fields.push(Field::new(
            format!("{}_mean", field.name()),
            DataType::Float64,
            false,
        ));
        fields.push(Field::new(
            format!("{}_null_pct", field.name()),
            DataType::Float32,
            false,
        ));
        fields.push(Field::new(
            format!("{}_type_char", field.name()),
            DataType::UInt8,
            false,
        ));

        cols.push(Arc::new(Float64Array::from(vec![mean])));
        cols.push(Arc::new(Float32Array::from(vec![null_pct])));
        cols.push(Arc::new(UInt8Array::from(vec![type_char])));
    }

    let agg_schema = Arc::new(Schema::new(fields));
    RecordBatch::try_new(agg_schema, cols).map_err(EngineError::Arrow)
}
