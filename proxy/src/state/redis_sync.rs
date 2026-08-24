use std::collections::HashMap;

use metrics::counter;
use redis::AsyncCommands;

use crate::generated::proxy_control_plane::{RoutingEntry, RoutingMap};
use crate::state::AppState;

/// Parse a raw Redis HGETALL map into a routing map.
///
/// Used by both the initial-load and refresh paths so parse-failure handling
/// stays identical. For entries that fail to deserialize, a previous entry
/// (if any) is carried forward so a single bad write doesn't drop a
/// previously-routable model; entries with no previous value are dropped.
/// Either way, the failure is counted and logged.
fn parse_routing_map(
    raw: HashMap<String, String>,
    previous: &RoutingMap,
) -> HashMap<String, RoutingEntry> {
    let mut routing_map = HashMap::with_capacity(raw.len());

    for (k, v) in raw {
        match serde_json::from_str::<RoutingEntry>(&v) {
            Ok(entry) => {
                routing_map.insert(k, entry);
            }
            Err(e) => {
                counter!("sardeenz_proxy_routing_parse_errors_total", "model" => k.clone())
                    .increment(1);

                match previous.get(&k) {
                    Some(prev) => {
                        tracing::warn!(
                            model = %k,
                            error = %e,
                            "failed to parse routing entry, carrying forward previous entry"
                        );
                        routing_map.insert(k, prev.clone());
                    }
                    None => {
                        tracing::warn!(
                            model = %k,
                            error = %e,
                            "failed to parse routing entry, dropping from routing map"
                        );
                    }
                }
            }
        }
    }

    routing_map
}

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
    let raw: HashMap<String, String> = conn.hgetall(&routing_map_key).await?;
    let previous = state.routing_cache.get_all().await;
    let routing_map = parse_routing_map(raw, &previous);

    tracing::info!(models = routing_map.len(), "loaded routing map");
    let all_endpoints: std::collections::HashSet<String> = routing_map
        .values()
        .flat_map(|entry| entry.endpoints.iter())
        .map(|ep| format!("{}:{}", ep.host, ep.port))
        .collect();
    state.routing_cache.replace(routing_map).await;
    state.circuit_breaker.prune(&all_endpoints);
    // Deliberately latched: this flag means "process has a usable routing
    // map", not "routing map is fresh". The cache retains the last-known-good
    // map across a Redis outage (see the reconnect loop in main.rs), so once
    // set this is never reset back to false. Whether the map is currently
    // up to date is tracked separately via redis_connected.
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
        let raw: HashMap<String, String> = match conn.hgetall(&routing_map_key).await {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, "failed to refresh routing map");
                continue;
            }
        };

        let previous = state.routing_cache.get_all().await;
        let routing_map = parse_routing_map(raw, &previous);
        let all_endpoints: std::collections::HashSet<String> = routing_map
            .values()
            .flat_map(|entry| entry.endpoints.iter())
            .map(|ep| format!("{}:{}", ep.host, ep.port))
            .collect();
        state.routing_cache.replace(routing_map).await;
        state.circuit_breaker.prune(&all_endpoints);
    }

    tracing::warn!("Redis pub/sub stream ended");
    Ok(())
}

#[cfg(test)]
mod tests {
    use metrics_exporter_prometheus::PrometheusBuilder;

    use super::*;
    use crate::generated::proxy_control_plane::{ModelState, RunnerEndpoint};

    fn sample_entry(model_name: &str) -> RoutingEntry {
        RoutingEntry {
            model_name: model_name.to_string(),
            state: ModelState::Active,
            endpoints: vec![RunnerEndpoint {
                host: "127.0.0.1".to_string(),
                port: 8000,
                weight: 1,
                healthy: true,
                runner_id: None,
            }],
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            metadata: None,
        }
    }

    // NOTE: parse_routing_map is synchronous, so it can be exercised with
    // metrics::with_local_recorder directly — this is deliberately NOT an
    // integration test, because the integration test harness (see
    // tests/integration/common/proxy_builder.rs) never installs a
    // global/local metrics recorder, so counter! calls silently no-op there.

    #[test]
    fn parse_routing_map_keeps_valid_entries() {
        let recorder = PrometheusBuilder::new().build_recorder();

        let mut raw = HashMap::new();
        raw.insert(
            "good-model".to_string(),
            serde_json::to_string(&sample_entry("good-model")).unwrap(),
        );
        let previous = RoutingMap::new();

        let result = metrics::with_local_recorder(&recorder, || parse_routing_map(raw, &previous));

        assert_eq!(result.len(), 1);
        assert!(result.contains_key("good-model"));
    }

    #[test]
    fn parse_routing_map_drops_unparseable_entry_with_no_previous() {
        let recorder = PrometheusBuilder::new().build_recorder();
        let handle = recorder.handle();

        let mut raw = HashMap::new();
        raw.insert("bad-model".to_string(), "not valid json {{{".to_string());
        let previous = RoutingMap::new();

        let result = metrics::with_local_recorder(&recorder, || parse_routing_map(raw, &previous));

        assert!(result.is_empty(), "entry with no previous value should be dropped");

        let rendered = handle.render();
        assert!(
            rendered.contains("sardeenz_proxy_routing_parse_errors_total")
                && rendered.contains("bad-model"),
            "expected parse-error counter for bad-model, got: {rendered}"
        );
    }

    #[test]
    fn parse_routing_map_carries_forward_previous_entry_on_parse_failure() {
        let recorder = PrometheusBuilder::new().build_recorder();
        let handle = recorder.handle();

        let prev = sample_entry("model-a");
        let mut previous = RoutingMap::new();
        previous.insert("model-a".to_string(), prev.clone());

        let mut raw = HashMap::new();
        raw.insert("model-a".to_string(), "not valid json {{{".to_string());

        let result = metrics::with_local_recorder(&recorder, || parse_routing_map(raw, &previous));

        assert_eq!(result.get("model-a").map(|e| &e.model_name), Some(&prev.model_name));

        let rendered = handle.render();
        assert!(
            rendered.contains("sardeenz_proxy_routing_parse_errors_total")
                && rendered.contains("model-a"),
            "expected parse-error counter for model-a, got: {rendered}"
        );
    }
}
