use dashmap::DashMap;
use serde_json::Value;
use std::sync::Arc;
use std::time::Instant;
use uuid::Uuid;

pub struct ViewportSnapshot {
    pub source_id: String,
    pub ops: Value,
    pub zoom: f64,
    pub scroll_x: f64,
    pub scroll_y: f64,
}

struct Entry {
    snapshot: ViewportSnapshot,
    created_at: Instant,
}

pub struct SnapshotStore {
    entries: DashMap<String, Entry>,
}

impl SnapshotStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            entries: DashMap::new(),
        })
    }

    pub fn insert(&self, snapshot: ViewportSnapshot) -> String {
        let id = Uuid::new_v4().to_string().replace('-', "")[..8].to_string();
        self.entries.insert(
            id.clone(),
            Entry {
                snapshot,
                created_at: Instant::now(),
            },
        );
        id
    }

    pub fn get(&self, id: &str) -> Option<ViewportSnapshot> {
        self.entries.get(id).map(|e| ViewportSnapshot {
            source_id: e.snapshot.source_id.clone(),
            ops: e.snapshot.ops.clone(),
            zoom: e.snapshot.zoom,
            scroll_x: e.snapshot.scroll_x,
            scroll_y: e.snapshot.scroll_y,
        })
    }

    pub fn cleanup_stale(&self, max_age_secs: u64) {
        let now = Instant::now();
        self.entries
            .retain(|_, entry| now.duration_since(entry.created_at).as_secs() < max_age_secs);
    }
}
