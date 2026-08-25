// Circuit breaker integration tests.
//
// The circuit breaker tracks both transport-level failures (connection refused,
// timeout) and HTTP 5xx responses from runners as failures. When the failure
// count within the sliding window reaches the configured threshold, the
// circuit opens and subsequent requests are rejected immediately with 503.

use std::time::Duration;

use reqwest::StatusCode;

use crate::common::proxy_builder::TestProxyConfig;
use crate::common::TestProxy;
use sardeenz_proxy::generated::proxy_control_plane::RunnerEndpoint;

/// Returns a port that is not listening (connection will be refused).
fn unreachable_endpoint() -> (String, u16) {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    ("127.0.0.1".to_string(), port)
}

#[tokio::test]
async fn test_circuit_breaker_trips() {
    const THRESHOLD: u32 = 3;

    let proxy = TestProxy::spawn_with_config(TestProxyConfig {
        control_plane_url: "http://127.0.0.1:1".to_string(),
        cb_failure_threshold: THRESHOLD,
        cb_failure_window: Duration::from_secs(30),
        cb_recovery_timeout: Duration::from_secs(60),
        ..Default::default()
    })
    .await;

    let (host, port) = unreachable_endpoint();
    let model = "circuit-breaker-test/model-v1";

    {
        use sardeenz_proxy::generated::proxy_control_plane::{ModelState, Protocol, RoutingEntry};
        let entry = RoutingEntry {
            model_name: model.to_string(),
            state: ModelState::Active,
            protocol: Protocol::Openai,
            endpoints: vec![RunnerEndpoint {
                host: host.clone(),
                port,
                weight: 1,
                healthy: true,
                runner_id: None,
            }],
            updated_at: "2024-01-01T00:00:00Z".to_string(),
            metadata: None,
        };
        proxy.routing_cache.update_entry(model.to_string(), entry).await;
    }

    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "Hi"}]
    });

    for i in 0..THRESHOLD {
        let resp = client
            .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
            .json(&payload)
            .send()
            .await
            .expect("request to proxy failed");

        assert_eq!(
            resp.status(),
            StatusCode::BAD_GATEWAY,
            "request {i}: expected 502 for unreachable endpoint"
        );
    }

    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .json(&payload)
        .send()
        .await
        .expect("request to proxy failed");

    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE, "open circuit should return 503");

    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(
        body["error"]["type"], "all_endpoints_unhealthy",
        "error type should be all_endpoints_unhealthy when circuit is open"
    );
}

#[tokio::test]
async fn test_circuit_breaker_trips_on_5xx() {
    use crate::common::MockRunner;

    const THRESHOLD: u32 = 3;
    let model = "5xx-circuit-test/model-v1";

    // Mock runner that fails the first THRESHOLD requests with 500.
    let runner = MockRunner::spawn_failing(model, THRESHOLD as usize).await;

    let proxy = TestProxy::spawn_with_config(TestProxyConfig {
        control_plane_url: "http://127.0.0.1:1".to_string(),
        cb_failure_threshold: THRESHOLD,
        cb_failure_window: Duration::from_secs(30),
        cb_recovery_timeout: Duration::from_secs(60),
        ..Default::default()
    })
    .await;

    crate::common::insert_active_model(&proxy.routing_cache, model, runner.addr).await;

    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "Hi"}]
    });

    // Each 500 response from the runner should be recorded as a failure.
    for _ in 0..THRESHOLD {
        let resp = client
            .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
            .json(&payload)
            .send()
            .await
            .expect("request to proxy failed");

        // The proxy forwards the 500 from the runner.
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    // Circuit should now be open — next request gets 503 without hitting runner.
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .json(&payload)
        .send()
        .await
        .expect("request to proxy failed");

    assert_eq!(
        resp.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "circuit should be open after THRESHOLD 5xx responses"
    );

    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["error"]["type"], "all_endpoints_unhealthy");
}

#[tokio::test]
async fn test_circuit_breaker_recovers() {
    use crate::common::MockRunner;

    let model = "recovering-model/v1";
    const THRESHOLD: u32 = 3;

    // Spawn the live runner BEFORE tripping the circuit so it's ready
    // when the circuit transitions to HalfOpen.
    let runner = MockRunner::spawn(model).await;

    let proxy = TestProxy::spawn_with_config(TestProxyConfig {
        control_plane_url: "http://127.0.0.1:1".to_string(),
        cb_failure_threshold: THRESHOLD,
        cb_failure_window: Duration::from_secs(30),
        cb_recovery_timeout: Duration::from_millis(100),
        ..Default::default()
    })
    .await;

    // Start with a dead endpoint to trip the circuit.
    let (dead_host, dead_port) = unreachable_endpoint();
    {
        use sardeenz_proxy::generated::proxy_control_plane::{ModelState, Protocol, RoutingEntry};
        let entry = RoutingEntry {
            model_name: model.to_string(),
            state: ModelState::Active,
            protocol: Protocol::Openai,
            endpoints: vec![RunnerEndpoint {
                host: dead_host.clone(),
                port: dead_port,
                weight: 1,
                healthy: true,
                runner_id: None,
            }],
            updated_at: "2024-01-01T00:00:00Z".to_string(),
            metadata: None,
        };
        proxy.routing_cache.update_entry(model.to_string(), entry).await;
    }

    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "Hi"}]
    });

    // Trip the circuit.
    for _ in 0..THRESHOLD {
        let _ = client
            .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
            .json(&payload)
            .send()
            .await;
    }

    // Swap to the working runner BEFORE waiting for recovery.
    {
        use sardeenz_proxy::generated::proxy_control_plane::{ModelState, Protocol, RoutingEntry};
        let entry = RoutingEntry {
            model_name: model.to_string(),
            state: ModelState::Active,
            protocol: Protocol::Openai,
            endpoints: vec![RunnerEndpoint {
                host: runner.addr.ip().to_string(),
                port: runner.addr.port(),
                weight: 1,
                healthy: true,
                runner_id: None,
            }],
            updated_at: "2024-01-01T00:00:00Z".to_string(),
            metadata: None,
        };
        proxy.routing_cache.update_entry(model.to_string(), entry).await;
    }

    // Wait for recovery_timeout → circuit goes HalfOpen.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // In HalfOpen state, the circuit allows one probe request through.
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .json(&payload)
        .send()
        .await
        .expect("request to proxy failed");

    assert_eq!(
        resp.status(),
        StatusCode::OK,
        "circuit should be HalfOpen and allow a test request through"
    );

    // Circuit is now Closed — subsequent requests should also succeed.
    let resp2 = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .json(&payload)
        .send()
        .await
        .expect("request to proxy failed");

    assert_eq!(resp2.status(), StatusCode::OK, "circuit should be Closed after recovery");
}

/// Verifies traffic distribution across both replicas after an outage
/// followed by a routing-map swap to live endpoints. This is NOT a #93
/// probe-strand regression guard: the circuits tripped here are keyed on
/// the two throwaway unreachable ports, and `insert_active_model_multi`
/// replaces the routing entry with live runners on different ports, so
/// those circuits start fresh/Closed and the tripped (HalfOpen-eligible)
/// circuits are never exercised again. The decisive test for the #93
/// HalfOpen-probe-leak fix is the unit test
/// `dropped_probe_guard_releases_probe_immediately` in
/// `src/forwarding/circuit_breaker.rs`.
#[tokio::test]
async fn test_both_replicas_recover_after_open() {
    use crate::common::MockRunner;

    let model = "dual-replica/model-v1";
    const THRESHOLD: u32 = 3;

    let a = MockRunner::spawn(model).await;
    let b = MockRunner::spawn(model).await;

    let proxy = TestProxy::spawn_with_config(TestProxyConfig {
        control_plane_url: "http://127.0.0.1:1".to_string(),
        cb_failure_threshold: THRESHOLD,
        cb_failure_window: Duration::from_secs(30),
        cb_recovery_timeout: Duration::from_millis(100),
        ..Default::default()
    })
    .await;

    // Trip both circuits with two unreachable endpoints.
    let (dh1, dp1) = unreachable_endpoint();
    let (dh2, dp2) = unreachable_endpoint();
    {
        use sardeenz_proxy::generated::proxy_control_plane::{ModelState, Protocol, RoutingEntry};
        let entry = RoutingEntry {
            model_name: model.to_string(),
            state: ModelState::Active,
            protocol: Protocol::Openai,
            endpoints: vec![
                RunnerEndpoint { host: dh1, port: dp1, weight: 1, healthy: true, runner_id: None },
                RunnerEndpoint { host: dh2, port: dp2, weight: 1, healthy: true, runner_id: None },
            ],
            updated_at: "2024-01-01T00:00:00Z".to_string(),
            metadata: None,
        };
        proxy.routing_cache.update_entry(model.to_string(), entry).await;
    }

    let client = reqwest::Client::new();
    let payload =
        serde_json::json!({ "model": model, "messages": [{"role":"user","content":"Hi"}] });

    for _ in 0..(THRESHOLD * 2 + 2) {
        let _ = client
            .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
            .json(&payload)
            .send()
            .await;
    }

    crate::common::insert_active_model_multi(
        &proxy.routing_cache,
        model,
        vec![(a.addr, 1), (b.addr, 1)],
    )
    .await;

    tokio::time::sleep(Duration::from_millis(150)).await;
    for _ in 0..10 {
        let resp = client
            .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
            .json(&payload)
            .send()
            .await
            .expect("request to proxy failed");
        assert_ne!(
            resp.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "no request should 503 while both replicas are recoverable"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    assert!(a.request_count() > 0, "replica A should receive traffic after recovery");
    assert!(b.request_count() > 0, "replica B should receive traffic after recovery");
}
