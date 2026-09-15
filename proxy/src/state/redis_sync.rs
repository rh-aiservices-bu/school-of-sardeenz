use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use metrics::counter;
use redis::AsyncCommands;

use crate::generated::proxy_control_plane::{RoutingEntry, RoutingMap, RoutingPropagationBarrier};
use crate::state::AppState;

/// Protocol families this proxy build supports, advertised at
/// `{prefix}:proxy:protocols` for the control plane's catalog-import
/// forward-compat guard (#125). Keep in sync with `Protocol`'s variants.
const SUPPORTED_PROTOCOLS: [&str; 2] = ["openai", "oip"];
const PROXY_PRESENCE_TTL_SECS: u64 = 15;
const PROXY_PRESENCE_REFRESH_SECS: u64 = 5;

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

    tracing::info!("connected to Redis");

    // Advertise supported protocol families for the control plane's catalog
    // import-time forward-compat guard (#125). Idempotent; rewritten on every
    // reconnect. Best-effort — a failure is logged, not fatal.
    let protocols_key = format!("{}:proxy:protocols", state.config.redis_key_prefix);
    let protocols_json = serde_json::to_string(&SUPPORTED_PROTOCOLS).unwrap();
    if let Err(e) = conn.set::<_, _, ()>(&protocols_key, &protocols_json).await {
        tracing::warn!(key = %protocols_key, error = %e, "failed to publish proxy protocols");
    }

    let routing_map_key = format!("{}:routing-map", state.config.redis_key_prefix);
    let routing_updates_channel = format!("{}:routing-updates", state.config.redis_key_prefix);
    let routing_barriers_channel = format!("{}:routing-barriers", state.config.redis_key_prefix);

    // Subscribe to routing map updates BEFORE loading the initial map
    // to avoid missing updates published during the HGETALL round-trip.
    let mut pubsub_conn = client.get_async_pubsub().await?;
    pubsub_conn.subscribe(&routing_updates_channel).await?;
    pubsub_conn.subscribe(&routing_barriers_channel).await?;

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

    // Declare this process as traffic-serving only after subscription and initial cache load.
    // Cutover snapshots these TTL'd keys so a proxy that disconnects just before the barrier is
    // still waited on until it acknowledges or its lease expires.
    let presence_key = format!("{}:proxies:{}", state.config.redis_key_prefix, state.proxy_id());
    let connected_at_ms =
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().to_string();
    conn.set_ex::<_, _, ()>(&presence_key, &connected_at_ms, PROXY_PRESENCE_TTL_SECS).await?;
    state.set_redis_connected(true);

    // Process pub/sub updates
    let mut pubsub_stream = pubsub_conn.into_on_message();
    let mut presence_refresh =
        tokio::time::interval(Duration::from_secs(PROXY_PRESENCE_REFRESH_SECS));
    // Consume interval's immediate first tick; the presence write above is the first heartbeat.
    presence_refresh.tick().await;
    let sync_result: anyhow::Result<()> = async {
        loop {
        let msg = tokio::select! {
            _ = presence_refresh.tick() => {
                conn.set_ex::<_, _, ()>(
                    &presence_key,
                    &connected_at_ms,
                    PROXY_PRESENCE_TTL_SECS,
                ).await?;
                continue;
            }
            message = futures_util::StreamExt::next(&mut pubsub_stream) => {
                match message {
                    Some(message) => message,
                    None => break,
                }
            }
        };
        let payload: String = match msg.get_payload() {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(error = %e, "failed to read pub/sub message");
                continue;
            }
        };

        tracing::debug!(payload = %payload, "routing map update");
        let barrier = if msg.get_channel_name() == routing_barriers_channel {
            match serde_json::from_str::<RoutingPropagationBarrier>(&payload) {
                Ok(barrier) => Some(barrier),
                Err(e) => {
                    tracing::warn!(error = %e, "failed to parse routing propagation barrier");
                    continue;
                }
            }
        } else {
            None
        };

        // Re-fetch the full routing map on any update.
        // This is simpler than applying deltas and handles out-of-order
        // messages correctly. The map is small enough that this is fine.
        // Keep the traffic-serving presence lease alive across the Redis read as well as the
        // quiescence wait below. A slow HGETALL must not let this proxy disappear from a cutover
        // snapshot while handlers are still admitting requests through the previous map.
        let mut refresh_conn = conn.clone();
        let refresh = refresh_conn.hgetall::<_, HashMap<String, String>>(&routing_map_key);
        tokio::pin!(refresh);
        let raw = loop {
            tokio::select! {
                result = &mut refresh => {
                    match result {
                        Ok(map) => break map,
                        Err(e) => {
                            tracing::warn!(error = %e, "failed to refresh routing map");
                            return Err(e.into());
                        }
                    }
                }
                _ = presence_refresh.tick() => {
                    conn.set_ex::<_, _, ()>(
                        &presence_key,
                        &connected_at_ms,
                        PROXY_PRESENCE_TTL_SECS,
                    ).await?;
                }
            }
        };

        let previous = state.routing_cache.get_all().await;
        let routing_map = parse_routing_map(raw, &previous);
        let all_endpoints: std::collections::HashSet<String> = routing_map
            .values()
            .flat_map(|entry| entry.endpoints.iter())
            .map(|ep| format!("{}:{}", ep.host, ep.port))
            .collect();
        let replacement = state.routing_cache.replace(routing_map);
        tokio::pin!(replacement);
        loop {
            tokio::select! {
                () = &mut replacement => break,
                _ = presence_refresh.tick() => {
                    conn.set_ex::<_, _, ()>(
                        &presence_key,
                        &connected_at_ms,
                        PROXY_PRESENCE_TTL_SECS,
                    ).await?;
                }
            }
        }
        state.circuit_breaker.prune(&all_endpoints);

        if let Some(barrier) = barrier {
            // replace() returns only after requests admitted through a destructively changed old
            // entry have completed. The acknowledgement therefore means both "cache applied"
            // and "old route quiescent", not merely "pub/sub message received".
            let ack_key = format!(
                "{}:routing-barrier-acks:{}",
                state.config.redis_key_prefix, barrier.barrier_id
            );
            let added: redis::RedisResult<usize> = conn.sadd(&ack_key, state.proxy_id()).await;
            match added {
                Ok(_) => {
                    if let Err(e) = conn.pexpire::<_, ()>(&ack_key, 60_000).await {
                        tracing::warn!(barrier_id = %barrier.barrier_id, error = %e, "failed to expire routing barrier acknowledgement");
                    }
                }
                Err(e) => {
                    tracing::warn!(barrier_id = %barrier.barrier_id, error = %e, "failed to acknowledge routing propagation barrier");
                    return Err(e.into());
                }
            }
        }
        }
        Ok(())
    }
    .await;

    // Stop admission first. Requests that already passed their initial readiness check either
    // hold a generation lease (and are waited on here) or acquire one after this point and fail
    // the handler's post-acquire readiness recheck. Only then may presence disappear.
    state.set_redis_connected(false);
    state.routing_cache.quiesce_all().await;
    let _: redis::RedisResult<usize> = conn.del(&presence_key).await;
    tracing::warn!("Redis pub/sub stream ended");
    sync_result
}

#[cfg(test)]
mod tests {
    use metrics_exporter_prometheus::PrometheusBuilder;

    use super::*;
    use crate::generated::proxy_control_plane::{ModelState, Protocol, RunnerEndpoint};

    fn sample_entry(model_name: &str) -> RoutingEntry {
        RoutingEntry {
            model_name: model_name.to_string(),
            state: ModelState::Active,
            protocol: Protocol::Openai,
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
