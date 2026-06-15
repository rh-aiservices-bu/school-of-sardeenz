use std::time::Duration;

use axum::routing::{get, post};
use axum::Router;
use metrics_exporter_prometheus::PrometheusBuilder;
use redis::AsyncCommands;
use reqwest::StatusCode;
use tokio::net::TcpListener;

use sardeenz_proxy::config::{CircuitBreakerConfig, Config, ParkingConfig};
use sardeenz_proxy::generated::proxy_control_plane::{ModelState, RoutingEntry, RunnerEndpoint};
use sardeenz_proxy::handlers;
use sardeenz_proxy::health;
use sardeenz_proxy::state::{start_redis_sync, AppState};

use crate::common::MockRunner;

fn redis_url() -> String {
    std::env::var("REDIS_TEST_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string())
}

struct RedisTestHarness {
    conn: redis::aio::MultiplexedConnection,
    prefix: String,
}

impl RedisTestHarness {
    async fn new() -> Self {
        let url = redis_url();
        let client = redis::Client::open(url.as_str())
            .unwrap_or_else(|e| panic!("failed to create Redis client at {url}: {e}"));
        let conn = client
            .get_multiplexed_async_connection()
            .await
            .unwrap_or_else(|e| panic!("failed to connect to Redis at {url}: {e}"));
        let prefix = format!("sardeenz-test-{}", uuid::Uuid::new_v4());
        Self { conn, prefix }
    }

    fn routing_map_key(&self) -> String {
        format!("{}:routing-map", self.prefix)
    }

    fn routing_updates_channel(&self) -> String {
        format!("{}:routing-updates", self.prefix)
    }

    async fn set_routing_entry(&mut self, model_name: &str, entry: &RoutingEntry) {
        let json = serde_json::to_string(entry).unwrap();
        let _: () = self
            .conn
            .hset(self.routing_map_key(), model_name, json)
            .await
            .unwrap();
    }

    async fn publish_update(&mut self, payload: &str) {
        let _: () = self
            .conn
            .publish(self.routing_updates_channel(), payload)
            .await
            .unwrap();
    }

    async fn cleanup(&mut self) {
        let _: () = self.conn.del(self.routing_map_key()).await.unwrap_or(());
    }

    fn build_config(&self) -> Config {
        Config {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            admin_addr: "127.0.0.1:0".parse().unwrap(),
            redis_url: redis_url(),
            control_plane_url: "http://127.0.0.1:1".to_string(),
            log_level: "warn".to_string(),
            upstream_timeout: Duration::from_secs(30),
            redis_key_prefix: self.prefix.clone(),
            parking: ParkingConfig {
                timeout: Duration::from_secs(10),
                max_per_model: 1000,
                max_global: 10000,
            },
            circuit_breaker: CircuitBreakerConfig {
                failure_threshold: 5,
                failure_window: Duration::from_secs(30),
                recovery_timeout: Duration::from_secs(15),
            },
        }
    }

    async fn spawn_proxy(&self) -> RunningProxy {
        let config = self.build_config();

        let recorder = PrometheusBuilder::new().build_recorder();
        let metrics_handle = recorder.handle();
        drop(recorder);

        let state = AppState::new(config, metrics_handle);

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let admin_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let admin_addr = admin_listener.local_addr().unwrap();

        let redis_state = state.clone();
        let redis_handle = tokio::spawn(async move {
            let _ = start_redis_sync(redis_state).await;
        });

        let proxy_app = Router::new()
            .route("/v1/chat/completions", post(handlers::handle_inference))
            .route("/v1/completions", post(handlers::handle_inference))
            .route("/v1/models", get(handlers::handle_models))
            .with_state(state.clone());

        let admin_app = Router::new()
            .route("/healthz", get(health::healthz))
            .route("/readyz", get(health::readyz))
            .route("/metrics", get(handlers::handle_metrics))
            .with_state(state.clone());

        tokio::spawn(async move {
            axum::serve(proxy_listener, proxy_app).await.unwrap();
        });
        tokio::spawn(async move {
            axum::serve(admin_listener, admin_app).await.unwrap();
        });

        RunningProxy {
            proxy_url: format!("http://127.0.0.1:{}", proxy_addr.port()),
            admin_url: format!("http://127.0.0.1:{}", admin_addr.port()),
            state,
            _redis_handle: redis_handle,
        }
    }
}

struct RunningProxy {
    proxy_url: String,
    admin_url: String,
    state: AppState,
    _redis_handle: tokio::task::JoinHandle<()>,
}

impl RunningProxy {
    async fn wait_ready(&self, timeout: Duration) {
        let client = reqwest::Client::new();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Ok(resp) = client
                .get(format!("{}/readyz", self.admin_url))
                .send()
                .await
            {
                if resp.status() == StatusCode::OK {
                    return;
                }
            }
            if tokio::time::Instant::now() > deadline {
                panic!("proxy did not become ready within {timeout:?}");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

fn make_active_entry(model_name: &str, host: &str, port: u16) -> RoutingEntry {
    RoutingEntry {
        model_name: model_name.to_string(),
        state: ModelState::Active,
        endpoints: vec![RunnerEndpoint {
            host: host.to_string(),
            port,
            weight: 1,
            healthy: true,
            runner_id: None,
        }],
        updated_at: "2026-01-01T00:00:00Z".to_string(),
        metadata: None,
    }
}

#[tokio::test]
async fn test_redis_bootstrap() {
    let mut harness = RedisTestHarness::new().await;
    let model = "test/bootstrap-model";
    let runner = MockRunner::spawn(model).await;

    let entry = make_active_entry(
        model,
        &runner.addr.ip().to_string(),
        runner.addr.port(),
    );
    harness.set_routing_entry(model, &entry).await;

    let proxy = harness.spawn_proxy().await;
    proxy.wait_ready(Duration::from_secs(5)).await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url))
        .json(&serde_json::json!({"model": model, "messages": []}))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(runner.request_count(), 1);

    harness.cleanup().await;
}

#[tokio::test]
async fn test_redis_pubsub_refresh() {
    let mut harness = RedisTestHarness::new().await;
    let model = "test/pubsub-model";
    let runner = MockRunner::spawn(model).await;

    let proxy = harness.spawn_proxy().await;
    proxy.wait_ready(Duration::from_secs(5)).await;

    // Model doesn't exist yet — should get 404
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url))
        .json(&serde_json::json!({"model": model, "messages": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);

    // Add the model to Redis and publish an update
    let entry = make_active_entry(
        model,
        &runner.addr.ip().to_string(),
        runner.addr.port(),
    );
    harness.set_routing_entry(model, &entry).await;
    harness.publish_update("refresh").await;

    // Wait for the proxy to pick up the change
    tokio::time::sleep(Duration::from_millis(500)).await;

    let resp = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url))
        .json(&serde_json::json!({"model": model, "messages": []}))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(runner.request_count(), 1);

    harness.cleanup().await;
}

#[tokio::test]
async fn test_redis_malformed_entry() {
    let mut harness = RedisTestHarness::new().await;
    let good_model = "test/good-model";
    let runner = MockRunner::spawn(good_model).await;

    // Seed one valid and one malformed entry
    let entry = make_active_entry(
        good_model,
        &runner.addr.ip().to_string(),
        runner.addr.port(),
    );
    harness.set_routing_entry(good_model, &entry).await;

    // Write malformed JSON directly
    let _: () = harness
        .conn
        .hset(
            harness.routing_map_key(),
            "test/bad-model",
            "not valid json {{{",
        )
        .await
        .unwrap();

    let proxy = harness.spawn_proxy().await;
    proxy.wait_ready(Duration::from_secs(5)).await;

    // Good model should work
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url))
        .json(&serde_json::json!({"model": good_model, "messages": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Bad model should be 404 (skipped during parse)
    let resp = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url))
        .json(&serde_json::json!({"model": "test/bad-model", "messages": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);

    harness.cleanup().await;
}

#[tokio::test]
async fn test_inference_timestamp_written_to_redis() {
    let mut harness = RedisTestHarness::new().await;
    let model = "test/timestamp-model";
    let runner = MockRunner::spawn(model).await;

    let entry = make_active_entry(model, &runner.addr.ip().to_string(), runner.addr.port());
    harness.set_routing_entry(model, &entry).await;

    let proxy = harness.spawn_proxy().await;
    proxy.wait_ready(Duration::from_secs(5)).await;

    // Send an inference request
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url))
        .json(&serde_json::json!({"model": model, "messages": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Wait for the fire-and-forget write to land
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Verify the inference timestamp key exists in Redis
    let ts_key = format!("{}:inference:last:{}", harness.prefix, model);
    let value: Option<String> = harness.conn.get(&ts_key).await.unwrap();
    assert!(
        value.is_some(),
        "expected inference timestamp key '{ts_key}' to exist"
    );

    // Verify the value is a valid ISO-8601 timestamp
    let ts = value.unwrap();
    assert!(
        chrono::DateTime::parse_from_rfc3339(&ts).is_ok(),
        "expected valid ISO-8601 timestamp, got: {ts}"
    );

    // Clean up the inference key too
    let _: () = harness.conn.del(&ts_key).await.unwrap_or(());
    harness.cleanup().await;
}

#[tokio::test]
async fn test_inference_timestamp_debounce() {
    let mut harness = RedisTestHarness::new().await;
    let model = "test/debounce-model";
    let runner = MockRunner::spawn(model).await;

    let entry = make_active_entry(model, &runner.addr.ip().to_string(), runner.addr.port());
    harness.set_routing_entry(model, &entry).await;

    let proxy = harness.spawn_proxy().await;
    proxy.wait_ready(Duration::from_secs(5)).await;

    let client = reqwest::Client::new();

    // Send first request
    let resp = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url))
        .json(&serde_json::json!({"model": model, "messages": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Wait for write
    tokio::time::sleep(Duration::from_millis(500)).await;

    let ts_key = format!("{}:inference:last:{}", harness.prefix, model);
    let first_ts: String = harness.conn.get(&ts_key).await.unwrap();

    // Send second request immediately (within debounce window)
    let resp = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url))
        .json(&serde_json::json!({"model": model, "messages": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    tokio::time::sleep(Duration::from_millis(500)).await;

    // Timestamp should be unchanged (debounced)
    let second_ts: String = harness.conn.get(&ts_key).await.unwrap();
    assert_eq!(
        first_ts, second_ts,
        "timestamp should not change within debounce window"
    );

    let _: () = harness.conn.del(&ts_key).await.unwrap_or(());
    harness.cleanup().await;
}

#[tokio::test]
async fn test_inference_timestamp_written_on_5xx() {
    let mut harness = RedisTestHarness::new().await;
    let model = "test/5xx-timestamp-model";
    // Runner that always returns 500
    let runner = MockRunner::spawn_failing(model, 1000).await;

    let entry = make_active_entry(model, &runner.addr.ip().to_string(), runner.addr.port());
    harness.set_routing_entry(model, &entry).await;

    let proxy = harness.spawn_proxy().await;
    proxy.wait_ready(Duration::from_secs(5)).await;

    // Send a request that will get a 500 from the runner
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url))
        .json(&serde_json::json!({"model": model, "messages": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(runner.request_count(), 1);

    // Wait for the fire-and-forget write
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Timestamp should still be written — model is actively receiving traffic
    let ts_key = format!("{}:inference:last:{}", harness.prefix, model);
    let value: Option<String> = harness.conn.get(&ts_key).await.unwrap();
    assert!(
        value.is_some(),
        "expected inference timestamp even on 5xx response"
    );

    let _: () = harness.conn.del(&ts_key).await.unwrap_or(());
    harness.cleanup().await;
}

#[tokio::test]
async fn test_redis_readiness_lifecycle() {
    let mut harness = RedisTestHarness::new().await;
    let client = reqwest::Client::new();

    // Spawn a proxy — it should transition to ready once connected + loaded
    let proxy = harness.spawn_proxy().await;

    // Initially not ready (redis_connected and routing_map_loaded both start false)
    assert!(!proxy.state.is_ready().await);

    // Wait for it to become ready (Redis connect + HGETALL completes)
    proxy.wait_ready(Duration::from_secs(5)).await;

    let resp = client
        .get(format!("{}/readyz", proxy.admin_url))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    harness.cleanup().await;
}
