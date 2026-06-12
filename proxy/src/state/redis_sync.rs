use std::collections::HashMap;

use redis::AsyncCommands;

use crate::generated::proxy_control_plane::RoutingEntry;
use crate::state::AppState;

/// Start the Redis synchronization loop. Subscribes to pub/sub first, then
/// loads the initial routing map, ensuring no updates are missed during
/// the initial load.
pub async fn start_redis_sync(state: AppState) -> anyhow::Result<()> {
    let client = redis::Client::open(state.config.redis_url.as_str())?;
    let mut conn = client.get_multiplexed_async_connection().await?;

    state.set_redis_connected(true);
    tracing::info!("connected to Redis");

    let routing_map_key = format!("{}:routing-map", state.config.redis_key_prefix);
    let routing_updates_channel = format!("{}:routing-updates", state.config.redis_key_prefix);

    // Subscribe to routing map updates BEFORE loading the initial map
    // to avoid missing updates published during the HGETALL round-trip.
    let mut pubsub_conn = client.get_async_pubsub().await?;
    pubsub_conn.subscribe(&routing_updates_channel).await?;

    // Load the initial routing map
    let map: HashMap<String, String> = conn.hgetall(&routing_map_key).await?;
    let routing_map: HashMap<String, RoutingEntry> = map
        .into_iter()
        .filter_map(|(k, v)| {
            serde_json::from_str(&v)
                .map(|entry| (k, entry))
                .map_err(|e| tracing::warn!(error = %e, "failed to parse routing entry"))
                .ok()
        })
        .collect();

    tracing::info!(models = routing_map.len(), "loaded routing map");
    state.routing_cache.replace(routing_map).await;
    state.set_routing_map_loaded(true);

    // Process pub/sub updates
    let mut pubsub_stream = pubsub_conn.into_on_message();
    while let Some(msg) = futures_util::StreamExt::next(&mut pubsub_stream).await {
        let payload: String = match msg.get_payload() {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(error = %e, "failed to read pub/sub message");
                continue;
            }
        };

        tracing::debug!(payload = %payload, "routing map update");

        // Re-fetch the full routing map on any update.
        // This is simpler than applying deltas and handles out-of-order
        // messages correctly. The map is small enough that this is fine.
        let map: HashMap<String, String> = match conn.hgetall(&routing_map_key).await {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, "failed to refresh routing map");
                continue;
            }
        };

        let routing_map: HashMap<String, RoutingEntry> = map
            .into_iter()
            .filter_map(|(k, v)| serde_json::from_str(&v).ok().map(|entry| (k, entry)))
            .collect();

        state.routing_cache.replace(routing_map).await;
    }

    state.set_redis_connected(false);
    tracing::warn!("Redis pub/sub stream ended");
    Ok(())
}
