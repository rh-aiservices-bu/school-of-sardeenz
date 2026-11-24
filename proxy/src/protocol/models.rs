use crate::generated::proxy_control_plane::{ModelState, Protocol};
use crate::routing::RoutingMapCache;

/// Build an OpenAI-compatible `/v1/models` response from the routing map.
/// Lists only `openai`-protocol models — the OIP surface is answered
/// separately by `list_models_v2`.
pub async fn list_models(cache: &RoutingMapCache) -> serde_json::Value {
    let models: Vec<serde_json::Value> = cache
        .project(|name, entry| -> Option<serde_json::Value> {
            if !(matches!(entry.state, ModelState::Active | ModelState::Sleeping)
                && entry.protocol == Protocol::Openai)
            {
                return None;
            }

            let mut model = serde_json::json!({
                "id": name,
                "object": "model",
                "created": 0,
                "owned_by": "sardeenz",
            });

            if let Some(metadata) = &entry.metadata {
                if let Some(owned_by) = &metadata.owned_by {
                    model["owned_by"] = serde_json::Value::String(owned_by.clone());
                }
            }

            Some(model)
        })
        .await
        .into_iter()
        .flatten()
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
    let models: Vec<serde_json::Value> = cache
        .project(|name, entry| -> Option<serde_json::Value> {
            if !(entry.protocol == Protocol::Oip
                && matches!(entry.state, ModelState::Active | ModelState::Sleeping))
            {
                return None;
            }
            Some(serde_json::json!({
                "name": name,
                "ready": entry.state == ModelState::Active,
            }))
        })
        .await
        .into_iter()
        .flatten()
        .collect();

    serde_json::json!({ "models": models })
}
