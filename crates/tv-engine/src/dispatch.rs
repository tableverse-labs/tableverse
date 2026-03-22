use crate::error::EngineError;
use crate::filter_util::extract_combined_filter;
use crate::reader;
use arrow::datatypes::SchemaRef;
use arrow::record_batch::RecordBatch;
use std::sync::Arc;
use tv_core::{SourceFormat, SourceKind, SourceMeta, ViewOp};

pub(crate) fn is_cloud_kind(kind: &SourceKind) -> bool {
    matches!(
        kind,
        SourceKind::S3 | SourceKind::Gcs | SourceKind::AzureBlob | SourceKind::Http
    )
}

pub(crate) fn slice_batches(
    batches: &[RecordBatch],
    offset: usize,
    limit: usize,
) -> Vec<RecordBatch> {
    let mut result = Vec::new();
    let mut skipped = 0usize;
    let mut collected = 0usize;

    for batch in batches {
        if collected >= limit {
            break;
        }
        let n = batch.num_rows();
        if skipped + n <= offset {
            skipped += n;
            continue;
        }
        let start = offset.saturating_sub(skipped);
        let available = n - start;
        let take = available.min(limit - collected);
        result.push(batch.slice(start, take));
        skipped += n;
        collected += take;
    }
    result
}

pub(crate) async fn read_tile_dispatch(
    meta: &SourceMeta,
    row_offset: usize,
    col_indices: &[usize],
    rows: usize,
    cached_metadata: Option<Arc<parquet::file::metadata::ParquetMetaData>>,
) -> Result<Vec<RecordBatch>, EngineError> {
    if is_cloud_kind(&meta.kind) {
        let uri = meta.files.first().map(|s| s.as_str()).unwrap_or(&meta.uri);
        return reader::read_cloud_parquet_tile(uri, row_offset, col_indices, rows).await;
    }

    let meta_c = meta.clone();
    let col_indices_c = col_indices.to_vec();
    tokio::task::spawn_blocking(move || match &meta_c.format {
        SourceFormat::Parquet => {
            if meta_c.files.len() <= 1 {
                let path = meta_c
                    .files
                    .first()
                    .map(|s| s.as_str())
                    .unwrap_or(&meta_c.uri);
                reader::read_parquet_tile(path, row_offset, &col_indices_c, rows, cached_metadata)
            } else {
                read_multi_file_tile(&meta_c.files, row_offset, &col_indices_c, rows)
            }
        }
        _ => {
            let uri = meta_c
                .files
                .first()
                .map(|s| s.as_str())
                .unwrap_or(&meta_c.uri);
            let all = reader::read_source_full(uri, &meta_c.format, Some(&col_indices_c))?;
            Ok(slice_batches(&all, row_offset, rows))
        }
    })
    .await
    .map_err(|e| EngineError::Query(e.to_string()))?
}

pub(crate) fn read_multi_file_tile(
    files: &[String],
    row_offset: usize,
    col_indices: &[usize],
    rows: usize,
) -> Result<Vec<RecordBatch>, EngineError> {
    let mut global_offset = 0usize;
    let mut collected: Vec<RecordBatch> = Vec::new();
    let mut remaining = rows;

    for path in files {
        if remaining == 0 {
            break;
        }
        let (_, file_rows) = reader::parquet_schema_and_rows(path)?;
        let file_rows = file_rows as usize;

        if global_offset + file_rows <= row_offset {
            global_offset += file_rows;
            continue;
        }

        let local_offset = row_offset.saturating_sub(global_offset);
        let batches = reader::read_parquet_tile(path, local_offset, col_indices, remaining, None)?;
        let got: usize = batches.iter().map(|b| b.num_rows()).sum();
        collected.extend(batches);
        remaining = remaining.saturating_sub(got);
        global_offset += file_rows;
    }

    Ok(collected)
}

pub(crate) async fn read_full_dispatch(
    meta: &SourceMeta,
    col_indices: Option<&[usize]>,
) -> Result<Vec<RecordBatch>, EngineError> {
    if is_cloud_kind(&meta.kind) {
        let uri = meta.files.first().map(|s| s.as_str()).unwrap_or(&meta.uri);
        return reader::read_cloud_parquet_full(uri, col_indices).await;
    }

    if meta.files.len() <= 1 {
        let uri = meta.files.first().map(|s| s.as_str()).unwrap_or(&meta.uri);
        reader::read_source_full(uri, &meta.format, col_indices)
    } else {
        use rayon::prelude::*;
        let all: Vec<RecordBatch> = meta
            .files
            .par_iter()
            .map(|path| reader::read_parquet_full(path, col_indices))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect();
        Ok(all)
    }
}

pub(crate) async fn read_with_pushdown(
    meta: &SourceMeta,
    ops: &[ViewOp],
    schema_hint: Option<SchemaRef>,
) -> Result<Vec<RecordBatch>, EngineError> {
    let filter_pred = extract_combined_filter(ops);

    if let Some(pred) = filter_pred {
        if matches!(meta.format, SourceFormat::Parquet) && !is_cloud_kind(&meta.kind) {
            let schema = if let Some(s) = schema_hint {
                s
            } else {
                let path = meta.files.first().map(|s| s.as_str()).unwrap_or(&meta.uri);
                reader::parquet_schema_and_rows(path).map(|(s, _)| s)?
            };

            if meta.files.len() <= 1 {
                let path = meta.files.first().map(|s| s.as_str()).unwrap_or(&meta.uri);
                return reader::read_parquet_full_with_filter(path, &pred, &schema);
            } else {
                use rayon::prelude::*;
                let all: Vec<RecordBatch> = meta
                    .files
                    .par_iter()
                    .map(|path| reader::read_parquet_full_with_filter(path, &pred, &schema))
                    .collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .flatten()
                    .collect();
                return Ok(all);
            }
        }
    }

    read_full_dispatch(meta, None).await
}
