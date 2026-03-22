use crate::dispatch::{is_cloud_kind, read_full_dispatch};
use crate::error::EngineError;
use crate::reader;
use crate::Engine;
use arrow::array::Array;
use tv_core::{Credentials, SourceFormat, ViewExpr};

impl Engine {
    pub async fn optimize_source(&self, source_id: &str) -> Result<(), EngineError> {
        let meta = self
            .catalog
            .get(source_id)
            .ok_or_else(|| EngineError::SourceNotFound(source_id.to_string()))?;

        if !matches!(meta.format, SourceFormat::Parquet)
            || is_cloud_kind(&meta.kind)
            || meta.files.len() != 1
        {
            return Err(EngineError::Query(
                "optimize only supported for single-file local Parquet sources".into(),
            ));
        }

        let source_path = meta.files[0].clone();
        let source_id_owned = source_id.to_string();
        let _engine = self.clone();

        tokio::task::spawn_blocking(move || -> Result<(), EngineError> {
            let batches = reader::read_parquet_full(&source_path, None)?;
            if batches.is_empty() {
                return Ok(());
            }

            let schema = batches[0].schema();
            let total_bytes: i64 = batches
                .iter()
                .map(|b| b.get_array_memory_size() as i64)
                .sum();
            let total_rows: i64 = batches.iter().map(|b| b.num_rows() as i64).sum();
            let bytes_per_row = if total_rows > 0 {
                (total_bytes / total_rows).max(1)
            } else {
                64
            };
            let target_rg_rows =
                ((512 * 1024 * 1024) / bytes_per_row).clamp(4096, 4_000_000) as usize;

            let props = parquet::file::properties::WriterProperties::builder()
                .set_writer_version(parquet::file::properties::WriterVersion::PARQUET_2_0)
                .set_compression(parquet::basic::Compression::SNAPPY)
                .set_data_page_size_limit(65536)
                .set_max_row_group_size(target_rg_rows)
                .set_statistics_enabled(parquet::file::properties::EnabledStatistics::Chunk)
                .build();

            let tmp_path = format!("{source_path}.optimize_tmp");
            let file = std::fs::File::create(&tmp_path)?;
            let mut writer = parquet::arrow::ArrowWriter::try_new(file, schema, Some(props))?;

            for batch in &batches {
                writer.write(batch)?;
            }
            writer.close()?;
            std::fs::rename(&tmp_path, &source_path)?;
            Ok(())
        })
        .await
        .map_err(|e| EngineError::Internal(e.to_string()))??;

        self.metadata_cache.write().unwrap().remove(&meta.files[0]);

        let uri = meta.uri.clone();
        let name = Some(meta.name.clone());
        self.remove_source(&source_id_owned).await?;
        self.register_source(&uri, name, None, None).await?;
        Ok(())
    }

    pub async fn inspect_uri(
        &self,
        uri: &str,
        profile: Option<String>,
        credentials: Option<Credentials>,
    ) -> Result<serde_json::Value, EngineError> {
        let meta = self
            .register_source(uri, None, profile, credentials)
            .await?;
        let expr = ViewExpr {
            source_id: meta.id.clone(),
            ops: vec![],
        };
        let count = self.query_view_count(&expr).await?;
        let schema = self.query_view_schema(&expr)?;
        let _ = self.remove_source(&meta.id).await;
        Ok(serde_json::json!({
            "uri": uri,
            "n_rows": count,
            "n_cols": schema.len(),
            "columns": schema
        }))
    }

    pub async fn search(
        &self,
        source_id: &str,
        query: &str,
        columns: Option<Vec<String>>,
        limit: usize,
    ) -> Result<Vec<u64>, EngineError> {
        let meta = self
            .catalog
            .get(source_id)
            .ok_or_else(|| EngineError::SourceNotFound(source_id.to_string()))?;

        let target_col_names: Vec<String> = match columns {
            Some(c) if !c.is_empty() => c,
            _ => meta.columns.iter().map(|c| c.name.clone()).collect(),
        };

        let target_col_indices: Vec<usize> = target_col_names
            .iter()
            .filter_map(|name| {
                meta.columns
                    .iter()
                    .find(|c| &c.name == name)
                    .map(|c| c.index)
            })
            .collect();

        let batches = read_full_dispatch(&meta, Some(&target_col_indices)).await?;

        let mut results = Vec::new();
        let mut global_row = 0u64;

        'outer: for batch in &batches {
            let schema = batch.schema();
            let col_indices: Vec<usize> = target_col_names
                .iter()
                .filter_map(|name| schema.index_of(name).ok())
                .collect();

            for row_idx in 0..batch.num_rows() {
                for &col_idx in &col_indices {
                    let col = batch.column(col_idx);
                    if col.is_null(row_idx) {
                        continue;
                    }
                    let cell =
                        match arrow::compute::cast(col.as_ref(), &arrow::datatypes::DataType::Utf8)
                        {
                            Ok(str_col) => {
                                if let Some(s) =
                                    str_col.as_any().downcast_ref::<arrow::array::StringArray>()
                                {
                                    if s.is_null(row_idx) {
                                        continue;
                                    }
                                    s.value(row_idx).to_string()
                                } else {
                                    continue;
                                }
                            }
                            Err(_) => continue,
                        };
                    if cell.contains(query) {
                        results.push(global_row + row_idx as u64);
                        break;
                    }
                }
                if results.len() >= limit {
                    break 'outer;
                }
            }
            global_row += batch.num_rows() as u64;
        }

        Ok(results)
    }
}
