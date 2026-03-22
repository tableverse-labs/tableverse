use crate::dispatch::read_with_pushdown;
use crate::error::EngineError;
use crate::external_sort::ExternalSorter;
use crate::filter_util::{classify_pipeline, PipelineClass};
use crate::materializer::MaterializedView;
use crate::query::serialize_to_arrow_ipc;
use crate::spill_pipeline::SpillPipeline;
use crate::Engine;
use crate::{executor, export};
use crate::{sparse_sort_index, spill};
use arrow::record_batch::RecordBatch;
use std::sync::Arc;
use tv_core::{normalize_ops, view_hash, ViewExpr};

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadFormat {
    Parquet,
    Csv,
    Arrow,
    Jsonl,
}

impl DownloadFormat {
    pub fn extension(&self) -> &'static str {
        match self {
            DownloadFormat::Parquet => "parquet",
            DownloadFormat::Csv => "csv",
            DownloadFormat::Arrow => "arrow",
            DownloadFormat::Jsonl => "jsonl",
        }
    }

    pub fn content_type(&self) -> &'static str {
        match self {
            DownloadFormat::Parquet => "application/octet-stream",
            DownloadFormat::Csv => "text/csv",
            DownloadFormat::Arrow => "application/vnd.apache.arrow.stream",
            DownloadFormat::Jsonl => "application/jsonlines",
        }
    }
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodegenTarget {
    DuckdbSql,
    AnsiSql,
    PythonPandas,
    PythonPolars,
    PythonDuckdb,
    Shell,
    ShellCsv,
    Dbt,
}

impl Engine {
    pub fn codegen(&self, expr: &ViewExpr, target: CodegenTarget) -> Result<String, EngineError> {
        let meta = self
            .catalog
            .get(&expr.source_id)
            .ok_or_else(|| EngineError::SourceNotFound(expr.source_id.clone()))?;
        Ok(match target {
            CodegenTarget::DuckdbSql => export::sql::render_sql(expr, &meta.uri, &meta.format),
            CodegenTarget::AnsiSql => export::ansi_sql::render_ansi_sql(expr, &meta.name),
            CodegenTarget::PythonPandas => export::python::render_python(
                expr,
                &meta.uri,
                &meta.format,
                export::python::PythonDialect::Pandas,
            ),
            CodegenTarget::PythonPolars => export::python::render_python(
                expr,
                &meta.uri,
                &meta.format,
                export::python::PythonDialect::Polars,
            ),
            CodegenTarget::PythonDuckdb => export::python::render_python(
                expr,
                &meta.uri,
                &meta.format,
                export::python::PythonDialect::DuckDb,
            ),
            CodegenTarget::Shell => export::shell::render_shell(expr, &meta.uri, &meta.format),
            CodegenTarget::ShellCsv => {
                export::shell::render_shell_csv(expr, &meta.uri, &meta.format)
            }
            CodegenTarget::Dbt => export::dbt::render_dbt(expr, &meta.name),
        })
    }

    pub async fn download_view(
        &self,
        expr: &ViewExpr,
        format: DownloadFormat,
    ) -> Result<(Vec<u8>, &'static str), EngineError> {
        let meta = self
            .catalog
            .get(&expr.source_id)
            .ok_or_else(|| EngineError::SourceNotFound(expr.source_id.clone()))?;

        let normalized = normalize_ops(&expr.ops);

        let batches = match classify_pipeline(&normalized) {
            PipelineClass::NeedsMaterialization => {
                let cache_key = format!(
                    "{}:{}",
                    expr.source_id,
                    view_hash(&format!("{:?}", normalized))
                );
                let schema_hint = self.schema_cache.read().unwrap().get(&meta.id).cloned();
                let mat_view = if let Some(mv) = self.materializer.get(&cache_key).await {
                    mv
                } else {
                    let meta_c = meta.clone();
                    let ops_c = normalized.clone();
                    let temp_root = self.temp_root.clone();
                    self.materializer
                        .get_or_materialize(cache_key, move || async move {
                            let pipeline = SpillPipeline::new(temp_root);
                            pipeline.build(&meta_c, &ops_c, schema_hint)
                        })
                        .await?
                };
                collect_materialized_view(mat_view.as_ref())?
            }
            _ => {
                let schema_hint = self.schema_cache.read().unwrap().get(&meta.id).cloned();
                let batches = read_with_pushdown(&meta, &normalized, schema_hint).await?;
                executor::execute_pipeline_skip_filter(batches, &normalized)?
            }
        };

        let data = match format {
            DownloadFormat::Arrow => serialize_to_arrow_ipc(&batches)?,
            DownloadFormat::Parquet => {
                let schema = if batches.is_empty() {
                    Arc::new(arrow::datatypes::Schema::empty())
                } else {
                    batches[0].schema()
                };
                let tmp = std::env::temp_dir().join(format!("tv_{}.parquet", uuid::Uuid::new_v4()));
                let file = std::fs::File::create(&tmp)?;
                let mut writer = parquet::arrow::ArrowWriter::try_new(file, schema, None)?;
                for batch in &batches {
                    writer.write(batch)?;
                }
                writer.close()?;
                let bytes = std::fs::read(&tmp)?;
                let _ = std::fs::remove_file(&tmp);
                bytes
            }
            DownloadFormat::Csv => {
                let mut buf = Vec::new();
                {
                    let mut writer = arrow_csv::WriterBuilder::new()
                        .with_header(true)
                        .build(&mut buf);
                    for batch in &batches {
                        writer.write(batch)?;
                    }
                }
                buf
            }
            DownloadFormat::Jsonl => write_jsonl(&batches),
        };

        Ok((data, format.content_type()))
    }
}

fn collect_materialized_view(mat_view: &MaterializedView) -> Result<Vec<RecordBatch>, EngineError> {
    match mat_view {
        MaterializedView::Batches { batches, .. } => Ok(batches.clone()),
        MaterializedView::SortedRuns {
            runs,
            schema,
            sort_keys,
            dedup_columns,
            ..
        } => {
            let sorter = ExternalSorter::new(sort_keys.clone(), schema.clone());
            match dedup_columns {
                None => sorter.merge_all(runs),
                Some(dedup_cols) => sorter.merge_dedup_tile(runs, &[], dedup_cols, 0, usize::MAX),
            }
        }
        MaterializedView::AggregateResult { run, .. } => {
            spill::SpillReader::open(&run.path).map(|r| r.collect::<Result<Vec<_>, _>>())?
        }
        MaterializedView::SortIndexBacked {
            index_path,
            source_path,
            n_cols,
            ..
        } => {
            let row_ids = crate::sort_index::tile_lookup(index_path, 0, usize::MAX)?;
            let col_indices: Vec<usize> = (0..*n_cols).collect();
            crate::sort_index::read_rows_by_ids(source_path, &row_ids, &col_indices)
        }
        MaterializedView::SparseSortIndexBacked {
            index,
            spill_path,
            schema,
            total_rows,
            ..
        } => {
            let lookups = sparse_sort_index::sparse_tile_lookup(index, 0, *total_rows as usize);
            sparse_sort_index::read_sparse_tile(
                spill_path,
                &lookups,
                0,
                schema.fields().len(),
                schema,
            )
        }
        MaterializedView::ProvisionalAgg { batches, .. }
        | MaterializedView::BitmapGroupBy { batches, .. } => Ok(batches.clone()),
        MaterializedView::ProvisionalSort {
            runs,
            schema,
            sort_keys,
            ..
        } => {
            let sorter = ExternalSorter::new(sort_keys.clone(), schema.clone());
            sorter.merge_all(runs)
        }
        MaterializedView::RowCount { .. } => Ok(vec![]),
    }
}

fn write_jsonl(batches: &[RecordBatch]) -> Vec<u8> {
    use arrow::array::Array;
    use arrow::datatypes::DataType as Dt;
    let mut buf = Vec::new();
    for batch in batches {
        let schema = batch.schema();
        for row_idx in 0..batch.num_rows() {
            buf.push(b'{');
            let mut first = true;
            for (col_idx, field) in schema.fields().iter().enumerate() {
                if !first {
                    buf.push(b',');
                }
                first = false;
                json_write_str(&mut buf, field.name());
                buf.push(b':');
                let col = batch.column(col_idx);
                if col.is_null(row_idx) {
                    buf.extend_from_slice(b"null");
                    continue;
                }
                match col.data_type() {
                    Dt::Boolean => {
                        let v = col
                            .as_any()
                            .downcast_ref::<arrow::array::BooleanArray>()
                            .map(|a| a.value(row_idx));
                        buf.extend_from_slice(if v.unwrap_or(false) {
                            b"true"
                        } else {
                            b"false"
                        });
                    }
                    Dt::Int8
                    | Dt::Int16
                    | Dt::Int32
                    | Dt::Int64
                    | Dt::UInt8
                    | Dt::UInt16
                    | Dt::UInt32
                    | Dt::UInt64 => {
                        if let Ok(c) = arrow::compute::cast(col.as_ref(), &Dt::Int64) {
                            if let Some(a) = c.as_any().downcast_ref::<arrow::array::Int64Array>() {
                                buf.extend_from_slice(a.value(row_idx).to_string().as_bytes());
                                continue;
                            }
                        }
                        buf.extend_from_slice(b"null");
                    }
                    Dt::Float16 | Dt::Float32 | Dt::Float64 => {
                        if let Ok(c) = arrow::compute::cast(col.as_ref(), &Dt::Float64) {
                            if let Some(a) = c.as_any().downcast_ref::<arrow::array::Float64Array>()
                            {
                                let v = a.value(row_idx);
                                if v.is_finite() {
                                    buf.extend_from_slice(v.to_string().as_bytes());
                                } else {
                                    buf.extend_from_slice(b"null");
                                }
                                continue;
                            }
                        }
                        buf.extend_from_slice(b"null");
                    }
                    _ => {
                        if let Ok(c) = arrow::compute::cast(col.as_ref(), &Dt::Utf8) {
                            if let Some(a) = c.as_any().downcast_ref::<arrow::array::StringArray>()
                            {
                                if !a.is_null(row_idx) {
                                    json_write_str(&mut buf, a.value(row_idx));
                                    continue;
                                }
                            }
                        }
                        buf.extend_from_slice(b"null");
                    }
                }
            }
            buf.extend_from_slice(b"}\n");
        }
    }
    buf
}

fn json_write_str(buf: &mut Vec<u8>, s: &str) {
    buf.push(b'"');
    for c in s.chars() {
        match c {
            '"' => buf.extend_from_slice(b"\\\""),
            '\\' => buf.extend_from_slice(b"\\\\"),
            '\n' => buf.extend_from_slice(b"\\n"),
            '\r' => buf.extend_from_slice(b"\\r"),
            '\t' => buf.extend_from_slice(b"\\t"),
            c if (c as u32) < 0x20 => {
                let s = format!("\\u{:04x}", c as u32);
                buf.extend_from_slice(s.as_bytes());
            }
            c => {
                let mut tmp = [0u8; 4];
                buf.extend_from_slice(c.encode_utf8(&mut tmp).as_bytes());
            }
        }
    }
    buf.push(b'"');
}
