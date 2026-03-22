use crate::dispatch::is_cloud_kind;
use crate::error::EngineError;
use crate::reader;
use crate::Engine;
use std::sync::Arc;
use tracing::info;
use tv_core::{ColumnInfo, Credentials, QuickColumnStats, SourceFormat, SourceKind, SourceMeta};

impl Engine {
    pub async fn register_source(
        &self,
        uri: &str,
        name: Option<String>,
        _profile: Option<String>,
        credentials: Option<Credentials>,
    ) -> Result<SourceMeta, EngineError> {
        use crate::catalog::{detect_format, detect_kind, infer_name};

        let name = name.unwrap_or_else(|| infer_name(uri));
        let kind = detect_kind(uri);
        let id = uuid::Uuid::new_v4().to_string();

        let (files, format) = if matches!(
            kind,
            SourceKind::Delta | SourceKind::Iceberg | SourceKind::HuggingFace
        ) {
            let resolved = tv_integrations::resolve(uri, credentials.as_ref())
                .await
                .map_err(|e| EngineError::Query(e.to_string()))?;
            (resolved.parquet_uris, SourceFormat::Parquet)
        } else {
            let f = detect_format(uri, &kind);
            let expanded = expand_source_files(uri, &kind).await?;
            (expanded, f)
        };

        let primary = files.first().map(|s| s.as_str()).unwrap_or(uri);

        let (schema, n_rows) = inspect_source(primary, &format, &files, &kind).await?;

        if files.len() > 1 && matches!(format, SourceFormat::Parquet) && !is_cloud_kind(&kind) {
            for path in &files[1..] {
                let (file_schema, _) = reader::parquet_schema_and_rows(path)?;
                if file_schema.fields() != schema.fields() {
                    return Err(EngineError::Query(format!(
                        "schema mismatch: {path} schema differs from primary file"
                    )));
                }
            }
        }

        let columns: Vec<ColumnInfo> = schema
            .fields()
            .iter()
            .enumerate()
            .map(|(i, f)| ColumnInfo {
                index: i,
                name: f.name().clone(),
                data_type: format_data_type(f.data_type()),
                nullable: f.is_nullable(),
            })
            .collect();

        let n_cols = columns.len();
        let quick_stats = build_quick_stats(primary, n_rows, n_cols, &format, &kind);

        let (tile_rows, file_size_bytes, file_mtime_secs, recommendations) = if matches!(
            format,
            SourceFormat::Parquet
        ) && !is_cloud_kind(
            &kind,
        ) && files.len()
            == 1
        {
            let path = files.first().map(|s| s.as_str()).unwrap_or(uri);
            let fs_meta = std::fs::metadata(path);
            let (fsize, fmtime) = if let Ok(ref m) = fs_meta {
                let size = m.len();
                let mtime = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                (size, mtime)
            } else {
                (0u64, 0u64)
            };

            let (tr, recs) = if let Ok((_, _, pq_meta)) =
                reader::parquet_schema_rows_and_metadata(path)
            {
                let n_rgs = pq_meta.num_row_groups();
                let first_rg_rows = if n_rgs > 0 {
                    pq_meta.row_group(0).num_rows() as u64
                } else {
                    0
                };
                let tile_r = if first_rg_rows > 0 {
                    tv_core::optimal_tile_rows(first_rg_rows)
                } else {
                    256
                };

                let mut advice: Vec<tv_core::SourceRecommendation> = Vec::new();
                if n_rgs > 0 && fsize > 0 {
                    let avg_rg_bytes = fsize / n_rgs as u64;
                    if avg_rg_bytes < 64 * 1024 * 1024 {
                        advice.push(tv_core::SourceRecommendation {
                                kind: "small_row_groups".to_string(),
                                message: "Row groups are small (<64MB); rewrite with 512MB row groups for faster tile access".to_string(),
                            });
                    }
                }
                let mut missing_stats = false;
                'rg_loop: for rg_i in 0..n_rgs {
                    let rg = pq_meta.row_group(rg_i);
                    for col_i in 0..rg.num_columns() {
                        if rg.column(col_i).statistics().is_none() {
                            missing_stats = true;
                            break 'rg_loop;
                        }
                    }
                }
                if missing_stats {
                    advice.push(tv_core::SourceRecommendation {
                            kind: "missing_statistics".to_string(),
                            message: "Some columns lack min/max statistics; rewrite with statistics enabled for better row group pruning".to_string(),
                        });
                }
                let bloom_loaded = self.index_catalog.lookup_bloom_index(path).is_some();
                if n_cols > 0 && !bloom_loaded {
                    advice.push(tv_core::SourceRecommendation {
                            kind: "no_bloom_filters".to_string(),
                            message: "No bloom filter index found; build one for faster equality filter on string columns".to_string(),
                        });
                }
                (tile_r, advice)
            } else {
                (256u32, Vec::new())
            };
            (tr, fsize, fmtime, recs)
        } else {
            (256u32, 0u64, 0u64, Vec::new())
        };

        let meta_files_for_presort = files.clone();
        let format_for_presort = format.clone();
        let kind_for_presort = kind.clone();
        let schema_for_presort = schema.clone();
        let pre_sorted_by = detect_pre_sorted_by(
            &meta_files_for_presort,
            &format_for_presort,
            &kind_for_presort,
            &schema_for_presort,
        );
        let meta = SourceMeta {
            id,
            name,
            uri: uri.to_string(),
            files,
            format,
            kind,
            n_rows,
            n_cols,
            columns,
            quick_stats,
            tile_rows,
            file_size_bytes,
            file_mtime_secs,
            recommendations,
            pre_sorted_by,
        };
        info!(
            id = %meta.id,
            name = %meta.name,
            n_rows = meta.n_rows,
            n_cols = meta.n_cols,
            format = ?meta.format,
            "source registered"
        );
        self.schema_cache
            .write()
            .unwrap()
            .insert(meta.id.clone(), schema);
        self.catalog.insert(meta.clone());
        if matches!(&meta.format, SourceFormat::Parquet) && !is_cloud_kind(&meta.kind) {
            let source_path = meta.files.first().map(|s| s.as_str()).unwrap_or(&meta.uri);
            if meta.files.len() == 1 {
                if let Ok((_, _, pq_meta)) = reader::parquet_schema_rows_and_metadata(source_path) {
                    self.metadata_cache
                        .write()
                        .unwrap()
                        .insert(source_path.to_string(), pq_meta);
                }
            }
            self.index_catalog.scan_for_source(source_path);
            if let Some(bloom_path) = self.index_catalog.lookup_bloom_index(source_path) {
                if let Ok(bloom) = crate::bloom_index::load(&bloom_path) {
                    self.bloom_cache
                        .write()
                        .unwrap()
                        .insert(source_path.to_string(), Arc::new(bloom));
                }
            }
            if let Some(q_path) = self.index_catalog.lookup_quantile_index(source_path) {
                if let Ok(q_index) = crate::quantile_sketch::load_quantile_index(&q_path) {
                    let schema_ref = self.schema_cache.read().unwrap().get(&meta.id).cloned();
                    if let Some(schema_ref) = schema_ref {
                        let sketches = crate::quantile_sketch::tdigest_to_global_sketches(
                            &q_index,
                            &schema_ref,
                        );
                        self.quantile_cache
                            .write()
                            .unwrap()
                            .insert(source_path.to_string(), Arc::new(sketches));
                    }
                }
            }
            let schema_for_roaring = self.schema_cache.read().unwrap().get(&meta.id).cloned();
            if let Some(schema_ref) = schema_for_roaring {
                for col in schema_ref.fields().iter().enumerate().filter_map(|(i, f)| {
                    if matches!(
                        f.data_type(),
                        arrow::datatypes::DataType::Utf8 | arrow::datatypes::DataType::LargeUtf8
                    ) {
                        Some(i)
                    } else {
                        None
                    }
                }) {
                    if let Some(r_path) = self.index_catalog.lookup_roaring_index(source_path, col)
                    {
                        if let Ok(ri) = crate::roaring_index::load(&r_path.to_string_lossy()) {
                            self.roaring_cache
                                .write()
                                .unwrap()
                                .insert((source_path.to_string(), col), Arc::new(ri));
                        }
                    }
                }
            }
            let schema_for_mark = self.schema_cache.read().unwrap().get(&meta.id).cloned();
            if let Some(schema_ref) = schema_for_mark {
                for col in schema_ref.fields().iter().enumerate().filter_map(|(i, f)| {
                    if matches!(
                        f.data_type(),
                        arrow::datatypes::DataType::Int8
                            | arrow::datatypes::DataType::Int16
                            | arrow::datatypes::DataType::Int32
                            | arrow::datatypes::DataType::Int64
                            | arrow::datatypes::DataType::Float32
                            | arrow::datatypes::DataType::Float64
                            | arrow::datatypes::DataType::Date32
                            | arrow::datatypes::DataType::Date64
                    ) {
                        Some(i)
                    } else {
                        None
                    }
                }) {
                    if let Some(m_path) = self.index_catalog.lookup_mark_index(source_path, col) {
                        if let Ok(mi) =
                            crate::mark_index::MarkIndex::load(&m_path.to_string_lossy())
                        {
                            self.mark_cache
                                .write()
                                .unwrap()
                                .insert((source_path.to_string(), col), Arc::new(mi));
                        }
                    }
                }
            }
        }
        Ok(meta)
    }

    pub async fn register_upload(
        &self,
        bytes: bytes::Bytes,
        name: Option<String>,
        is_parquet: bool,
    ) -> Result<SourceMeta, EngineError> {
        let upload_id = uuid::Uuid::new_v4().to_string();
        let extension = if is_parquet { "parquet" } else { "arrow" };
        let path = self.temp_root.upload_path(&upload_id, extension)?;
        std::fs::write(&path, &bytes)?;
        let uri = path.to_string_lossy().to_string();
        self.register_source(&uri, name, None, None).await
    }

    pub fn list_sources(&self) -> Vec<SourceMeta> {
        self.catalog.list()
    }

    pub fn get_source(&self, id: &str) -> Option<SourceMeta> {
        self.catalog.get(id)
    }

    pub async fn remove_source(&self, id: &str) -> Result<(), EngineError> {
        let source_path = self
            .catalog
            .get(id)
            .map(|m| m.files.first().cloned().unwrap_or(m.uri.clone()));
        if !self.catalog.remove(id) {
            return Err(EngineError::SourceNotFound(id.to_string()));
        }
        info!(id = %id, "source removed");
        self.materializer.invalidate_source(id).await;
        {
            let mut cache = self.stats_cache.write().unwrap();
            cache.retain(|(sid, _), _| sid != id);
        }
        self.schema_cache.write().unwrap().remove(id);
        {
            let mut idx = self.filter_rg_index.write().unwrap();
            idx.retain(|(sid, _), _| sid != id);
        }
        if let Some(ref path) = source_path {
            self.bloom_cache.write().unwrap().remove(path);
            self.quantile_cache.write().unwrap().remove(path);
            self.metadata_cache.write().unwrap().remove(path);
            let mut rc = self.roaring_cache.write().unwrap();
            rc.retain(|(p, _), _| p != path);
            let mut mc = self.mark_cache.write().unwrap();
            mc.retain(|(p, _), _| p != path);
        }
        {
            let mut counter = self.sort_access_counter.lock().unwrap();
            counter.retain(|k, _| !k.starts_with(id));
        }
        self.temp_root.cleanup_source(id);
        if let Some(ref path) = source_path {
            if let Ok(uploads_dir) = self.temp_root.uploads_dir() {
                if std::path::Path::new(path).starts_with(&uploads_dir) {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
        if let Some(path) = source_path {
            self.index_catalog.remove_source(&path);
        }
        self.job_registry.remove_for_source(id).await;
        Ok(())
    }

    pub fn check_source_stale(&self, id: &str) -> Option<bool> {
        let meta = self.catalog.get(id)?;
        if meta.kind != SourceKind::LocalFile || meta.files.len() != 1 {
            return None;
        }
        if meta.file_size_bytes == 0 && meta.file_mtime_secs == 0 {
            return None;
        }
        let path = meta.files.first().map(|s| s.as_str()).unwrap_or(&meta.uri);
        let fs_meta = std::fs::metadata(path).ok()?;
        let current_size = fs_meta.len();
        let current_mtime = fs_meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Some(current_size != meta.file_size_bytes || current_mtime != meta.file_mtime_secs)
    }
}

fn detect_pre_sorted_by(
    files: &[String],
    format: &SourceFormat,
    kind: &SourceKind,
    schema: &arrow::datatypes::SchemaRef,
) -> Option<Vec<tv_core::SortKey>> {
    if !matches!(format, SourceFormat::Parquet) || is_cloud_kind(kind) || files.len() != 1 {
        return None;
    }
    let path = files.first()?.as_str();
    let (_, _, pq_meta) = reader::parquet_schema_rows_and_metadata(path).ok()?;
    if pq_meta.num_row_groups() == 0 {
        return None;
    }
    let first_sorting = pq_meta.row_group(0).sorting_columns()?;
    if first_sorting.is_empty() {
        return None;
    }
    let consistent = (0..pq_meta.num_row_groups())
        .all(|i| pq_meta.row_group(i).sorting_columns() == Some(first_sorting));
    if !consistent {
        return None;
    }
    let sort_keys: Vec<tv_core::SortKey> = first_sorting
        .iter()
        .filter_map(|sc| {
            let col_idx = sc.column_idx as usize;
            schema.fields().get(col_idx).map(|f| tv_core::SortKey {
                column: f.name().clone(),
                descending: sc.descending,
                nulls_last: !sc.nulls_first,
            })
        })
        .collect();
    if sort_keys.is_empty() {
        None
    } else {
        Some(sort_keys)
    }
}

async fn expand_source_files(uri: &str, kind: &SourceKind) -> Result<Vec<String>, EngineError> {
    match kind {
        SourceKind::LocalFile => {
            if uri.contains('*') || uri.contains('?') || uri.contains('[') {
                let files = reader::expand_local_glob(uri)?;
                if files.is_empty() {
                    return Err(EngineError::Query(format!(
                        "glob pattern matched no files: {uri}"
                    )));
                }
                Ok(files)
            } else {
                Ok(vec![uri.to_string()])
            }
        }
        SourceKind::S3 | SourceKind::Gcs | SourceKind::AzureBlob => {
            let parsed = url::Url::parse(uri).map_err(|e| EngineError::Query(e.to_string()))?;
            if parsed.path().ends_with('/') || parsed.path().is_empty() {
                reader::list_cloud_parquet_files(uri).await
            } else {
                Ok(vec![uri.to_string()])
            }
        }
        _ => Ok(vec![uri.to_string()]),
    }
}

async fn inspect_source(
    primary_uri: &str,
    format: &SourceFormat,
    files: &[String],
    kind: &SourceKind,
) -> Result<(Arc<arrow::datatypes::Schema>, u64), EngineError> {
    match format {
        SourceFormat::Parquet => {
            if is_cloud_kind(kind) {
                let (schema, first_rows) =
                    reader::parquet_schema_and_rows_cloud(primary_uri).await?;
                let n_rows = if files.len() <= 1 {
                    first_rows
                } else {
                    let mut total = first_rows;
                    for uri in files.iter().skip(1) {
                        let (_, r) = reader::parquet_schema_and_rows_cloud(uri).await?;
                        total += r;
                    }
                    total
                };
                Ok((schema, n_rows))
            } else {
                let (schema, first_rows) = reader::parquet_schema_and_rows(primary_uri)?;
                let n_rows = if files.len() <= 1 {
                    first_rows
                } else {
                    use rayon::prelude::*;
                    let extra: u64 = files[1..]
                        .par_iter()
                        .map(|path| reader::parquet_schema_and_rows(path).map(|(_, r)| r))
                        .collect::<Result<Vec<_>, _>>()?
                        .into_iter()
                        .sum();
                    first_rows + extra
                };
                Ok((schema, n_rows))
            }
        }
        SourceFormat::Csv => {
            let (schema, batches) = reader::csv_schema_and_data(primary_uri)?;
            let n_rows: u64 = batches.iter().map(|b| b.num_rows() as u64).sum();
            Ok((schema, n_rows))
        }
        SourceFormat::Json => {
            let (schema, batches) = reader::json_schema_and_data(primary_uri)?;
            let n_rows: u64 = batches.iter().map(|b| b.num_rows() as u64).sum();
            Ok((schema, n_rows))
        }
        SourceFormat::Arrow => {
            let (schema, batches) = reader::arrow_ipc_schema_and_data(primary_uri)?;
            let n_rows: u64 = batches.iter().map(|b| b.num_rows() as u64).sum();
            Ok((schema, n_rows))
        }
        other => Err(EngineError::UnsupportedFormat(format!("{other:?}"))),
    }
}

fn build_quick_stats(
    path: &str,
    n_rows: u64,
    n_cols: usize,
    format: &SourceFormat,
    kind: &SourceKind,
) -> Vec<QuickColumnStats> {
    if !matches!(format, SourceFormat::Parquet) || is_cloud_kind(kind) {
        return vec![];
    }
    match reader::parquet_all_quick_stats(path) {
        Ok(raw) => raw
            .into_iter()
            .take(n_cols)
            .enumerate()
            .map(|(i, (min_f, max_f, null_count))| QuickColumnStats {
                index: i,
                null_count,
                null_rate: if n_rows > 0 {
                    null_count as f64 / n_rows as f64
                } else {
                    0.0
                },
                min: min_f
                    .and_then(|f| serde_json::Number::from_f64(f).map(serde_json::Value::Number)),
                max: max_f
                    .and_then(|f| serde_json::Number::from_f64(f).map(serde_json::Value::Number)),
            })
            .collect(),
        Err(_) => vec![],
    }
}

fn format_data_type(dt: &arrow::datatypes::DataType) -> String {
    use arrow::datatypes::DataType;
    match dt {
        DataType::Boolean => "Boolean".to_string(),
        DataType::Int8 => "Int8".to_string(),
        DataType::Int16 => "Int16".to_string(),
        DataType::Int32 => "Int32".to_string(),
        DataType::Int64 => "Int64".to_string(),
        DataType::UInt8 => "UInt8".to_string(),
        DataType::UInt16 => "UInt16".to_string(),
        DataType::UInt32 => "UInt32".to_string(),
        DataType::UInt64 => "UInt64".to_string(),
        DataType::Float16 => "Float16".to_string(),
        DataType::Float32 => "Float32".to_string(),
        DataType::Float64 => "Float64".to_string(),
        DataType::Utf8 => "Utf8".to_string(),
        DataType::LargeUtf8 => "LargeUtf8".to_string(),
        DataType::Date32 => "Date32".to_string(),
        DataType::Date64 => "Date64".to_string(),
        DataType::Timestamp(unit, _) => format!("Timestamp({unit:?})"),
        DataType::Binary => "Binary".to_string(),
        DataType::LargeBinary => "LargeBinary".to_string(),
        DataType::List(_) => "List".to_string(),
        DataType::Struct(_) => "Struct".to_string(),
        other => format!("{other}"),
    }
}
