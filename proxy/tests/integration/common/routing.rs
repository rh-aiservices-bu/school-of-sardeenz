// Routing map helpers for tests.
//
// These functions manipulate RoutingMapCache directly, bypassing Redis.

use std::net::SocketAddr;

use sardeenz_proxy::generated::proxy_control_plane::{
    ModelState, RoutingEntry, RoutingEntryMetadata, RunnerEndpoint,
};
use sardeenz_proxy::routing::RoutingMapCache;

/// Insert a model with the given state, pointing at the given runner address.
pub async fn insert_model(
    cache: &RoutingMapCache,
    model_name: &str,
    state: ModelState,
    runner_addr: SocketAddr,
) {
    let entry = RoutingEntry {
        model_name: model_name.to_string(),
        state,
        endpoints: vec![RunnerEndpoint {
            host: runner_addr.ip().to_string(),
            port: runner_addr.port(),
            weight: 1,
            healthy: true,
            runner_id: None,
        }],
        updated_at: "2024-01-01T00:00:00Z".to_string(),
        metadata: None,
    };
    cache.update_entry(model_name.to_string(), entry).await;
}

/// Insert an Active model pointing at the given runner address.
pub async fn insert_active_model(
    cache: &RoutingMapCache,
    model_name: &str,
    runner_addr: SocketAddr,
) {
    insert_model(cache, model_name, ModelState::Active, runner_addr).await;
}

/// Insert an Active model with multiple weighted endpoints.
pub async fn insert_active_model_multi(
    cache: &RoutingMapCache,
    model_name: &str,
    endpoints: Vec<(SocketAddr, u32)>,
) {
    let eps: Vec<RunnerEndpoint> = endpoints
        .into_iter()
        .map(|(addr, weight)| RunnerEndpoint {
            host: addr.ip().to_string(),
            port: addr.port(),
            weight,
            healthy: true,
            runner_id: None,
        })
        .collect();

    let entry = RoutingEntry {
        model_name: model_name.to_string(),
        state: ModelState::Active,
        endpoints: eps,
        updated_at: "2024-01-01T00:00:00Z".to_string(),
        metadata: None,
    };
    cache.update_entry(model_name.to_string(), entry).await;
}

/// Insert a Sleeping model (no active endpoints yet).
pub async fn insert_sleeping_model(cache: &RoutingMapCache, model_name: &str) {
    let entry = RoutingEntry {
        model_name: model_name.to_string(),
        state: ModelState::Sleeping,
        endpoints: vec![],
        updated_at: "2024-01-01T00:00:00Z".to_string(),
        metadata: None,
    };
    cache.update_entry(model_name.to_string(), entry).await;
}

/// Insert a model with metadata for testing the /v1/models endpoint.
pub async fn insert_active_model_with_metadata(
    cache: &RoutingMapCache,
    model_name: &str,
    runner_addr: SocketAddr,
    owned_by: &str,
) {
    let entry = RoutingEntry {
        model_name: model_name.to_string(),
        state: ModelState::Active,
        endpoints: vec![RunnerEndpoint {
            host: runner_addr.ip().to_string(),
            port: runner_addr.port(),
            weight: 1,
            healthy: true,
            runner_id: None,
        }],
        updated_at: "2024-01-01T00:00:00Z".to_string(),
        metadata: Some(RoutingEntryMetadata {
            owned_by: Some(owned_by.to_string()),
            max_model_len: None,
            engine_type: None,
            extra: Default::default(),
        }),
    };
    cache.update_entry(model_name.to_string(), entry).await;
}
