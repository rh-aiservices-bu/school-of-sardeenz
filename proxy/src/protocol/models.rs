use crate::generated::proxy_control_plane::{ModelState, Protocol};
use crate::routing::RoutingMapCache;

/// Build an OpenAI-compatible `/v1/models` response from the routing map.
/// Lists only `openai`-protocol models — the OIP surface is answered
/// separately by `list_models_v2`.
pub async fn list_models(cache: &RoutingMapCache) -> serde_json::Value {
    let map = cache.get_all().await;

    let models: Vec<serde_json::Value> = map
        .iter()
        .filter(|(_, entry)| {
            matches!(entry.state, ModelState::Active | ModelState::Sleeping)
                && entry.protocol == Protocol::Openai
        })
        .map(|(name, entry)| {
            let mut model = serde_json::json!({
                "id": name,
                "object": "model",
                "created": 0,
                "owned_by": "sardeenz",
            });

            if let Some(ref metadata) = entry.metadata {
                if let Some(ref owned_by) = metadata.owned_by {
                    model["owned_by"] = serde_json::Value::String(owned_by.clone());
                }
            }

            model
        })
        .collect();

    serde_json::json!({
        "object": "list",
        "data": models,
    })
}

/// Build the `/oip/v2/models` response (OipModelList) from the routing map.
/// Lists only `oip`-protocol models. ready = ACTIVE; SLEEPING → ready:false
/// (still listed — same inclusion rule as list_models).
pub async fn list_models_v2(cache: &RoutingMapCache) -> serde_json::Value {
    let map = cache.get_all().await;

    let models: Vec<serde_json::Value> = map
        .iter()
        .filter(|(_, entry)| {
            entry.protocol == Protocol::Oip
                && matches!(entry.state, ModelState::Active | ModelState::Sleeping)
        })
        .map(|(name, entry)| {
            serde_json::json!({
                "name": name,
                "ready": entry.state == ModelState::Active,
            })
        })
        .collect();

    serde_json::json!({ "models": models })
}
