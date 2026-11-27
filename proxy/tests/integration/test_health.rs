// test_health_endpoints: /healthz returns 200 always; /readyz requires both
// Redis connected AND routing map loaded.

use reqwest::StatusCode;
use sardeenz_proxy::routing::RoutingMapCache;

use crate::common::TestProxy;

#[tokio::test]
async fn test_healthz_always_200() {
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;

    let client = reqwest::Client::new();
    let resp =
        client.get(format!("{}/healthz", proxy.admin_url())).send().await.expect("request failed");

    assert_eq!(resp.status(), StatusCode::OK, "/healthz should return 200");

    let body = resp.text().await.unwrap();
    assert_eq!(body, "ok", "/healthz body should be 'ok'");
}

#[tokio::test]
async fn test_readyz_when_fully_ready() {
    // Shared cache simulates a loaded routing map; redis_connected defaults to true.
    let cache = RoutingMapCache::default();
    let proxy = TestProxy::spawn_with_shared_cache("http://127.0.0.1:1", cache).await;

    let client = reqwest::Client::new();
    let resp =
        client.get(format!("{}/readyz", proxy.admin_url())).send().await.expect("request failed");

    assert_eq!(
        resp.status(),
        StatusCode::OK,
        "/readyz should return 200 when Redis is connected and routing map is loaded"
    );

    let body = resp.text().await.unwrap();
    assert_eq!(body, "ready");
}

#[tokio::test]
async fn test_readyz_when_redis_disconnected() {
    let proxy = TestProxy::spawn_with_redis_disconnected("http://127.0.0.1:1").await;

    let client = reqwest::Client::new();
    let resp =
        client.get(format!("{}/readyz", proxy.admin_url())).send().await.expect("request failed");

    assert_eq!(
        resp.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "/readyz should return 503 when Redis is not connected"
    );
}

/// Inference declined while routing state is genuinely unavailable names that
/// cause — not a shutdown (#330 review: the two 503 causes are distinguishable).
#[tokio::test]
async fn test_inference_refusal_names_disconnected_routing_state() {
    let proxy = TestProxy::spawn_with_redis_disconnected("http://127.0.0.1:1").await;

    let resp = reqwest::Client::new()
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .json(&serde_json::json!({"model": "disconnected/v1", "messages": []}))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body: serde_json::Value = resp.json().await.expect("error envelope");
    assert_eq!(body["error"]["type"], "model_unavailable");
    let message = body["error"]["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("routing state is not connected"),
        "a not-connected routing state must keep its own wording, got: {message}"
    );
    assert!(
        !message.contains("shutting down"),
        "the message must not name a shutdown while the process is not draining, got: {message}"
    );
}

#[tokio::test]
async fn test_readyz_before_routing_map_loaded() {
    // Redis connected but no cache injected — routing map not yet loaded.
    let proxy = TestProxy::spawn_before_routing_map_loaded("http://127.0.0.1:1").await;

    let client = reqwest::Client::new();
    let resp =
        client.get(format!("{}/readyz", proxy.admin_url())).send().await.expect("request failed");

    assert_eq!(
        resp.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "/readyz should return 503 before routing map is loaded"
    );
}

#[tokio::test]
async fn test_metrics_endpoint_reachable() {
    // /metrics should return valid Prometheus text format.
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;

    let client = reqwest::Client::new();
    let resp =
        client.get(format!("{}/metrics", proxy.admin_url())).send().await.expect("request failed");

    assert_eq!(resp.status(), StatusCode::OK);

    let content_type =
        resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("");

    assert!(
        content_type.contains("text/plain"),
        "metrics endpoint should return text/plain, got: {content_type}"
    );
}
