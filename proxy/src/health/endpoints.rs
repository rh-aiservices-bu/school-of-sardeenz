use axum::http::StatusCode;
use axum::response::IntoResponse;

use crate::state::AppState;

pub async fn healthz() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

pub async fn readyz(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> impl IntoResponse {
    if state.is_ready().await {
        (StatusCode::OK, "ready")
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, "not ready")
    }
}
