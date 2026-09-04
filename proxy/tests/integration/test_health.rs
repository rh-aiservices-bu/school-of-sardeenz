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
