// Parking limit enforcement tests.
//
// Validates that the proxy enforces both per-model and global parking limits,
// returning 503 with error type "parking_limit_reached" when exceeded.

use std::time::Duration;

use reqwest::StatusCode;

use crate::common::proxy_builder::TestProxyConfig;
use crate::common::{insert_sleeping_model, MockControlPlaneBuilder, TestProxy};

#[tokio::test]
async fn test_per_model_parking_limit() {
    let cache = sardeenz_proxy::routing::RoutingMapCache::new();
    let model = "limited-model/v1";
    insert_sleeping_model(&cache, model).await;

    // Control plane that never wakes (no on_wake_activate configured),
    // so requests stay parked until timeout.
    let cp = MockControlPlaneBuilder::new().spawn().await;

    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: format!("http://{}", cp.addr),
            parking_timeout: Duration::from_secs(30),
            parking_max_per_model: 2,
            parking_max_global: 100,
            ..Default::default()
        },
        cache,
    )
    .await;

    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "Hello"}]
    });

    // Park 2 requests (the limit). They block waiting for the model to wake,
    // so we fire them as background tasks.
    let mut handles = Vec::new();
    for _ in 0..2 {
        let c = client.clone();
        let url = format!("{}/openai/v1/chat/completions", proxy.proxy_url());
        let p = payload.clone();
        handles.push(tokio::spawn(async move { c.post(url).json(&p).send().await }));
    }

    // Give the parked requests a moment to register.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // The 3rd request should be rejected immediately.
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .json(&payload)
        .send()
        .await
        .expect("request failed");

    assert_eq!(
        resp.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "exceeding per-model parking limit should return 503"
    );

    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["error"]["type"], "parking_limit_reached");

    // Clean up: abort the parked tasks so the test doesn't hang.
    for h in handles {
        h.abort();
    }
}

#[tokio::test]
async fn test_parking_byte_budget() {
    let cache = sardeenz_proxy::routing::RoutingMapCache::new();
    let model = "byte-budget-model/v1";
    insert_sleeping_model(&cache, model).await;

    let cp = MockControlPlaneBuilder::new().spawn().await;

    let payload = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "x".repeat(32)}]
    });
    let body_len = serde_json::to_vec(&payload).unwrap().len();
    // Room for exactly one parked body, not two.
    let budget = body_len + body_len / 2;

    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: format!("http://{}", cp.addr),
            parking_timeout: Duration::from_secs(30),
            parking_max_per_model: 1000,
            parking_max_global: 1000,
            parking_max_bytes: budget,
            ..Default::default()
        },
        cache,
    )
    .await;

    let client = reqwest::Client::new();

    // Park one request (fits the budget). It blocks waiting for the model to
    // wake, so fire it as a background task.
    let handle = {
        let c = client.clone();
        let url = format!("{}/openai/v1/chat/completions", proxy.proxy_url());
        let p = payload.clone();
        tokio::spawn(async move { c.post(url).json(&p).send().await })
    };

    tokio::time::sleep(Duration::from_millis(200)).await;

    // A second request of the same size pushes the parked total past the
    // budget and should be rejected immediately.
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .json(&payload)
        .send()
        .await
        .expect("request failed");

    assert_eq!(
        resp.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "exceeding the parking byte budget should return 503"
    );

    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["error"]["type"], "parking_limit_reached");

    handle.abort();
}

#[tokio::test]
async fn test_global_parking_limit() {
    let cache = sardeenz_proxy::routing::RoutingMapCache::new();
    let model_a = "global-limit-a/v1";
    let model_b = "global-limit-b/v1";
    insert_sleeping_model(&cache, model_a).await;
    insert_sleeping_model(&cache, model_b).await;

    let cp = MockControlPlaneBuilder::new().spawn().await;

    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: format!("http://{}", cp.addr),
            parking_timeout: Duration::from_secs(30),
            parking_max_per_model: 100,
            parking_max_global: 2,
            ..Default::default()
        },
        cache,
    )
    .await;

    let client = reqwest::Client::new();

    // Park one request per model (2 total = global limit).
    let mut handles = Vec::new();
    for model in [model_a, model_b] {
        let c = client.clone();
        let url = format!("{}/openai/v1/chat/completions", proxy.proxy_url());
        let p = serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "Hi"}]
        });
        handles.push(tokio::spawn(async move { c.post(url).json(&p).send().await }));
    }

    tokio::time::sleep(Duration::from_millis(200)).await;

    // A 3rd request (any model) should be rejected by the global limit.
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .json(&serde_json::json!({
            "model": model_a,
            "messages": [{"role": "user", "content": "Hi"}]
        }))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["error"]["type"], "parking_limit_reached");

    for h in handles {
        h.abort();
    }
}
