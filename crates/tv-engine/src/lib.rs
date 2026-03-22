pub mod batch_stream;
pub mod bitmap_index;
pub mod bloom_index;
pub mod catalog;
pub mod compiler;
pub mod error;
pub mod executor;
pub mod export;
pub mod extensions;
pub mod external_sort;
pub mod index_catalog;
pub mod job_registry;
pub mod mark_index;
pub mod materializer;
pub mod profiles;
pub mod quantile_sketch;
pub mod query;
pub mod reader;
pub mod roaring_index;
pub mod sort_index;
pub mod sparse_sort_index;
pub mod spill;
pub mod spill_pipeline;
pub mod stats;
pub mod streaming_agg;
pub mod temp;
pub mod top_k;

mod admin_ops;
mod dispatch;
mod export_ops;
mod filter_util;
mod query_ops;
mod source_ops;
mod stats_ops;
mod tile_ops;

pub use export_ops::{CodegenTarget, DownloadFormat};

#[cfg(test)]
pub mod test_helpers;

use arrow::datatypes::SchemaRef;
use catalog::Catalog;
use index_catalog::IndexCatalog;
use job_registry::JobRegistry;
use materializer::ViewMaterializer;
use std::collections::HashMap;
use std::sync::Arc;
use temp::TempRoot;
use tv_core::ColumnStats;

type FilterRgIndex = Arc<std::sync::RwLock<HashMap<(String, String), Arc<Vec<u64>>>>>;
type BloomCache = Arc<std::sync::RwLock<HashMap<String, Arc<bloom_index::BloomIndex>>>>;
type QuantileCache =
    Arc<std::sync::RwLock<HashMap<String, Arc<HashMap<String, tv_core::types::QuantileSketch>>>>>;
type SortAccessCounter = Arc<std::sync::Mutex<HashMap<String, u64>>>;
type MetadataCache =
    Arc<std::sync::RwLock<HashMap<String, Arc<parquet::file::metadata::ParquetMetaData>>>>;
type RoaringCache =
    Arc<std::sync::RwLock<HashMap<(String, usize), Arc<roaring_index::RoaringIndex>>>>;
type MarkCache = mark_index::MarkCache;

#[derive(Clone)]
pub struct Engine {
    catalog: Arc<Catalog>,
    materializer: Arc<ViewMaterializer>,
    stats_cache: Arc<std::sync::RwLock<HashMap<(String, usize), ColumnStats>>>,
    schema_cache: Arc<std::sync::RwLock<HashMap<String, SchemaRef>>>,
    metadata_cache: MetadataCache,
    filter_rg_index: FilterRgIndex,
    bloom_cache: BloomCache,
    quantile_cache: QuantileCache,
    sort_access_counter: SortAccessCounter,
    temp_root: Arc<TempRoot>,
    index_catalog: Arc<IndexCatalog>,
    roaring_cache: RoaringCache,
    mark_cache: MarkCache,
    job_registry: Arc<JobRegistry>,
}

impl Engine {
    pub fn new() -> Result<Self, error::EngineError> {
        Ok(Self {
            catalog: Arc::new(Catalog::new()),
            materializer: Arc::new(ViewMaterializer::new()),
            stats_cache: Arc::new(std::sync::RwLock::new(HashMap::new())),
            schema_cache: Arc::new(std::sync::RwLock::new(HashMap::new())),
            metadata_cache: Arc::new(std::sync::RwLock::new(HashMap::new())),
            filter_rg_index: Arc::new(std::sync::RwLock::new(HashMap::new())),
            bloom_cache: Arc::new(std::sync::RwLock::new(HashMap::new())),
            quantile_cache: Arc::new(std::sync::RwLock::new(HashMap::new())),
            sort_access_counter: Arc::new(std::sync::Mutex::new(HashMap::new())),
            temp_root: TempRoot::new()?,
            index_catalog: Arc::new(IndexCatalog::new()),
            roaring_cache: Arc::new(std::sync::RwLock::new(HashMap::new())),
            mark_cache: mark_index::new_mark_cache(),
            job_registry: Arc::new(JobRegistry::new()),
        })
    }

    pub fn job_registry(&self) -> Arc<JobRegistry> {
        Arc::clone(&self.job_registry)
    }
}
