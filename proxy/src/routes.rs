use axum::routing::{get, post};
use axum::Router;

use crate::handlers;
use crate::state::AppState;

/// The proxy inference surface. Nesting under `/openai` and `/oip` strips the
/// prefix from the URI inner handlers see, so forwarded paths are canonical
/// (`/v1/...`, `/v2/...`). Single source of truth shared by main.rs and the
/// integration test harness (`tests/integration/common/proxy_builder.rs`),
/// so prod and tests exercise the same nested/stripped routes (#125).
pub fn build_proxy_router(state: AppState) -> Router {
    let openai = Router::new()
        .route("/v1/chat/completions", post(handlers::handle_inference))
        .route("/v1/completions", post(handlers::handle_inference))
        .route("/v1/models", get(handlers::handle_models));
    let oip = Router::new()
        .route("/v2/models/{model}/infer", post(handlers::handle_oip_infer))
        .route("/v2/models/{model}/ready", get(handlers::handle_oip_ready))
        .route("/v2/models", get(handlers::handle_oip_models));
    Router::new().nest("/openai", openai).nest("/oip", oip).with_state(state)
}
