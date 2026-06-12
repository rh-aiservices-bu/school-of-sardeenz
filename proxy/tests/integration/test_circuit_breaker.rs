// test_circuit_breaker_trips: after enough connection failures (unreachable
// endpoint), the circuit breaker opens and subsequent requests return 503
// without hitting the endpoint.
//
// Note: the circuit breaker tracks transport-level failures (connection
// refused, timeout), not HTTP 5xx responses from the runner. A runner
// returning 500 is still a successful forwarding from the proxy's perspective.

use std::time::Duration;

use reqwest::StatusCode;

use crate::common::TestProxy;
use crate::common::proxy_builder::TestProxyConfig;
use sardeenz_proxy::generated::proxy_control_plane::RunnerEndpoint;

/// Returns a `RunnerEndpoint` pointing at a port that is not listening (so
/// the TCP connection will be refused immediately).
fn unreachable_endpoint() -> (String, u16) {
    // Use a port in the ephemeral range that is known not to be listening.
    // Bind a listener momentarily to get a free port, then drop it so the
    // port becomes unavailable again.
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l); // port is now closed
    ("127.0.0.1".to_string(), port)
}

#[tokio::test]
async fn test_circuit_breaker_trips() {
    // Use a low failure threshold to trip quickly.
    const THRESHOLD: u32 = 3;

    let proxy = TestProxy::spawn_with_config(TestProxyConfig {
        control_plane_url: "http://127.0.0.1:1".to_string(),
        cb_failure_threshold: THRESHOLD,
        cb_failure_window: Duration::from_secs(30),
        cb_recovery_timeout: Duration::from_secs(60), // long — won't recover during test
        ..Default::default()
    })
    .await;

    // Register the model pointing at an endpoint that refuses connections.
    let (host, port) = unreachable_endpoint();
    let model = "circuit-breaker-test/model-v1";

    // Directly insert a routing entry with the dead endpoint.
    {
        use sardeenz_proxy::generated::proxy_control_plane::{ModelState, RoutingEntry};
        let entry = RoutingEntry {
            model_name: model.to_string(),
            state: ModelState::Active,
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

    // Each request should fail with 502 (upstream error — connection refused).
    // After THRESHOLD failures the circuit opens.
    for i in 0..THRESHOLD {
        let resp = client
            .post(format!("{}/v1/chat/completions", proxy.proxy_url()))
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

    // Circuit is now open. The next request should get 503 without touching
    // the (dead) endpoint at all.
    let resp = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url()))
        .json(&payload)
        .send()
        .await
        .expect("request to proxy failed");

    assert_eq!(
        resp.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "open circuit should return 503"
    );

    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(
        body["error"]["type"], "all_endpoints_unhealthy",
        "error type should be all_endpoints_unhealthy when circuit is open"
    );
}

#[tokio::test]
async fn test_circuit_breaker_recovers() {
    // The circuit goes Open after threshold failures, then HalfOpen after
    // recovery_timeout. A successful request in HalfOpen closes the circuit.
    use crate::common::MockRunner;

    let model = "recovering-model/v1";
    const THRESHOLD: u32 = 3;

    let proxy = TestProxy::spawn_with_config(TestProxyConfig {
        control_plane_url: "http://127.0.0.1:1".to_string(),
        cb_failure_threshold: THRESHOLD,
        cb_failure_window: Duration::from_secs(30),
        cb_recovery_timeout: Duration::from_millis(100), // very short for testing
        ..Default::default()
    })
    .await;

    // Start with a dead endpoint.
    let (dead_host, dead_port) = unreachable_endpoint();
    {
        use sardeenz_proxy::generated::proxy_control_plane::{ModelState, RoutingEntry};
        let entry = RoutingEntry {
            model_name: model.to_string(),
            state: ModelState::Active,
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
            .post(format!("{}/v1/chat/completions", proxy.proxy_url()))
            .json(&payload)
            .send()
            .await;
    }

    // Wait for recovery_timeout → circuit goes HalfOpen.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Swap to a working runner before the next request.
    let runner = MockRunner::spawn(model).await;
    {
        use sardeenz_proxy::generated::proxy_control_plane::{ModelState, RoutingEntry};
        let entry = RoutingEntry {
            model_name: model.to_string(),
            state: ModelState::Active,
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

    // In HalfOpen state, the circuit allows one request through. If it
    // succeeds, the circuit closes.
    let resp = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url()))
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
        .post(format!("{}/v1/chat/completions", proxy.proxy_url()))
        .json(&payload)
        .send()
        .await
        .expect("request to proxy failed");

    assert_eq!(
        resp2.status(),
        StatusCode::OK,
        "circuit should be Closed after recovery"
    );
}
