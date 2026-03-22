use crate::error::EngineError;
use crate::Engine;
use crate::{reader, stats};
use tracing::{debug, info};
use tv_core::{ColumnStats, CorrelationMatrix, SourceFormat, SourceKind};

impl Engine {
    pub async fn column_stats(
        &self,
        source_id: &str,
        col_idx: usize,
        n_bins: usize,
    ) -> Result<ColumnStats, EngineError> {
        if n_bins == stats::DEFAULT_HISTOGRAM_BINS {
            let cache = self.stats_cache.read().unwrap();
            if let Some(cached) = cache.get(&(source_id.to_string(), col_idx)) {
                return Ok(cached.clone());
            }
        }
        let meta = self
            .catalog
            .get(source_id)
            .ok_or_else(|| EngineError::SourceNotFound(source_id.to_string()))?;
        debug!(source = %source_id, col = col_idx, "computing column stats");
        let result = stats::compute_column_stats(&meta, col_idx, n_bins)?;
        if n_bins == stats::DEFAULT_HISTOGRAM_BINS {
            self.stats_cache
                .write()
                .unwrap()
                .insert((source_id.to_string(), col_idx), result.clone());
        }
        Ok(result)
    }

    pub async fn column_stats_coarse(
        &self,
        source_id: &str,
        col_idx: usize,
    ) -> Result<ColumnStats, EngineError> {
        let meta = self
            .catalog
            .get(source_id)
            .ok_or_else(|| EngineError::SourceNotFound(source_id.to_string()))?;

        if !matches!(meta.format, SourceFormat::Parquet) || meta.kind != SourceKind::LocalFile {
            return Err(EngineError::Query(
                "coarse stats only supported for local Parquet sources".into(),
            ));
        }

        let path = meta.files.first().map(|s| s.as_str()).unwrap_or(&meta.uri);

        let first_rg_rows = {
            let mc = self.metadata_cache.read().unwrap();
            mc.get(path)
                .map(|m| m.row_group(0).num_rows() as usize)
                .unwrap_or(50000)
        };

        let coarse_meta_arc = self.metadata_cache.read().unwrap().get(path).cloned();
        let batches =
            reader::read_parquet_tile(path, 0, &[col_idx], first_rg_rows, coarse_meta_arc)?;

        let col = meta
            .columns
            .get(col_idx)
            .ok_or_else(|| EngineError::SourceNotFound(format!("column index {col_idx}")))?;

        stats::compute_column_stats_from_batches(col, col_idx, &batches, 10)
    }

    pub async fn row_group_stats(
        &self,
        source_id: &str,
        col_idx: usize,
    ) -> Result<Vec<reader::RowGroupColumnStat>, EngineError> {
        let meta = self
            .catalog
            .get(source_id)
            .ok_or_else(|| EngineError::SourceNotFound(source_id.to_string()))?;

        if !matches!(meta.format, SourceFormat::Parquet) || meta.kind != SourceKind::LocalFile {
            return Ok(vec![]);
        }

        let path = if !meta.files.is_empty() {
            meta.files[0].clone()
        } else {
            meta.uri.clone()
        };

        reader::parquet_row_group_column_stats(&path, col_idx)
    }

    pub async fn correlations(&self, source_id: &str) -> Result<CorrelationMatrix, EngineError> {
        let meta = self
            .catalog
            .get(source_id)
            .ok_or_else(|| EngineError::SourceNotFound(source_id.to_string()))?;
        stats::compute_correlations(&meta)
    }

    pub async fn profile_source(&self, source_id: &str) -> Result<Vec<ColumnStats>, EngineError> {
        let meta = self
            .get_source(source_id)
            .ok_or_else(|| EngineError::SourceNotFound(source_id.to_string()))?;
        info!(source = %source_id, n_cols = meta.n_cols, "profiling source");
        let t0 = std::time::Instant::now();
        use rayon::prelude::*;
        let all_stats: Result<Vec<_>, _> = (0..meta.n_cols)
            .into_par_iter()
            .map(|i| stats::compute_column_stats(&meta, i, stats::DEFAULT_HISTOGRAM_BINS))
            .collect();
        let all_stats = all_stats?;
        {
            let mut cache = self.stats_cache.write().unwrap();
            for (i, s) in all_stats.iter().enumerate() {
                cache.insert((source_id.to_string(), i), s.clone());
            }
        }
        info!(source = %source_id, elapsed_ms = t0.elapsed().as_millis(), "profile complete");
        Ok(all_stats)
    }
}
