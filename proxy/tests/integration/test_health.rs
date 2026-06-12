// test_health_endpoints: /healthz returns 200 always; /readyz returns 200
// when Redis is connected, 503 when not.
//
// In tests, the proxy builder sets redis_connected=true by default, so
// /readyz should return 200. We also verify /healthz independently.

use reqwest::StatusCode;

use crate::common::TestProxy;

#[tokio::test]
async fn test_healthz_always_200() {
    // /healthz is a liveness probe — it should return 200 regardless of state.
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/healthz", proxy.admin_url()))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::OK, "/healthz should return 200");

    let body = resp.text().await.unwrap();
    assert_eq!(body, "ok", "/healthz body should be 'ok'");
}

#[tokio::test]
async fn test_readyz_when_redis_connected() {
    // Default TestProxy sets redis_connected=true.
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/readyz", proxy.admin_url()))
        .send()
        .await
        .expect("request failed");

    assert_eq!(
        resp.status(),
        StatusCode::OK,
        "/readyz should return 200 when Redis is connected"
    );

    let body = resp.text().await.unwrap();
    assert_eq!(body, "ready");
}

#[tokio::test]
async fn test_readyz_when_redis_disconnected() {
    // Spawn a proxy that reports Redis as disconnected.
    let proxy = TestProxy::spawn_with_redis_disconnected("http://127.0.0.1:1").await;

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/readyz", proxy.admin_url()))
        .send()
        .await
        .expect("request failed");

    assert_eq!(
        resp.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "/readyz should return 503 when Redis is not connected"
    );
}

#[tokio::test]
async fn test_metrics_endpoint_reachable() {
    // /metrics should return valid Prometheus text format.
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/metrics", proxy.admin_url()))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::OK);

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    assert!(
        content_type.contains("text/plain"),
        "metrics endpoint should return text/plain, got: {content_type}"
    );
}
