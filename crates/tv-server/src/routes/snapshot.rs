use crate::snapshot::ViewportSnapshot;
use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
pub struct CreateSnapshotBody {
    source_id: String,
    ops: Value,
    zoom: f64,
    scroll_x: f64,
    scroll_y: f64,
}

#[derive(Serialize)]
struct CreateSnapshotResponse {
    id: String,
    share_path: String,
}

#[derive(Serialize)]
struct GetSnapshotResponse {
    source_id: String,
    ops: Value,
    zoom: f64,
    scroll_x: f64,
    scroll_y: f64,
}

pub async fn create_snapshot(
    State(app): State<AppState>,
    Json(body): Json<CreateSnapshotBody>,
) -> impl IntoResponse {
    let id = app.snapshot_store.insert(ViewportSnapshot {
        source_id: body.source_id,
        ops: body.ops,
        zoom: body.zoom,
        scroll_x: body.scroll_x,
        scroll_y: body.scroll_y,
    });
    let share_path = format!("/share/{}", id);
    Json(CreateSnapshotResponse { id, share_path })
}

pub async fn get_snapshot(
    State(app): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match app.snapshot_store.get(&id) {
        Some(snap) => Ok(Json(GetSnapshotResponse {
            source_id: snap.source_id,
            ops: snap.ops,
            zoom: snap.zoom,
            scroll_x: snap.scroll_x,
            scroll_y: snap.scroll_y,
        })),
        None => Err(StatusCode::NOT_FOUND),
    }
}
