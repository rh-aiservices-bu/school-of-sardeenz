// test_parked_state_transitions: a parked request must fail fast (not wait
// out the full parking timeout) when the model it is waiting on rolls back
// to SLEEPING or transitions to DRAINING while parked. See #98.

use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::StatusCode;

use sardeenz_proxy::generated::proxy_control_plane::ModelState;

use crate::common::proxy_builder::TestProxyConfig;
use crate::common::{insert_model, TestProxy};

/// Poll `proxy.parking.global_parked_count()` until it equals `n` or
/// `timeout` elapses.
async fn poll_parked(proxy: &TestProxy, n: usize, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if proxy.parking.global_parked_count() == n {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn test_parked_request_sleeping_rollback_fails_fast() {
    let model = "rollback/model-v1";
    let addr: std::net::SocketAddr = "127.0.0.1:1".parse().unwrap();
    let cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_model(&cache, model, ModelState::Starting, addr).await;

    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: "http://127.0.0.1:1".to_string(),
            parking_timeout: Duration::from_secs(10),
            ..Default::default()
        },
        cache.clone(),
    )
    .await;

    let client =
        Arc::new(reqwest::Client::builder().timeout(Duration::from_secs(9)).build().unwrap());
    let url = proxy.proxy_url();
    let m = model.to_string();
    let c = client.clone();
    let start = Instant::now();
    let handle = tokio::spawn(async move {
        c.post(format!("{url}/v1/chat/completions"))
            .json(&serde_json::json!({"model": m, "messages":[{"role":"user","content":"hi"}]}))
            .send()
            .await
    });

    assert!(poll_parked(&proxy, 1, Duration::from_secs(5)).await, "request never parked");
    insert_model(&cache, model, ModelState::Sleeping, addr).await;

    let resp = handle.await.unwrap().expect("request failed");
    let elapsed = start.elapsed();
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["error"]["type"], "model_unavailable");
    let message = body["error"]["message"].as_str().unwrap_or("");
    assert!(
        message.contains("sleeping"),
        "expected message to mention sleeping, got: {message}"
    );
    assert!(
        elapsed < Duration::from_secs(1),
        "fast-fail expected; took {elapsed:?} (parking_timeout is 10s — unfixed code would wait it out)"
    );
}

#[tokio::test]
async fn test_parked_request_draining_fails_fast() {
    let model = "rollback/model-v2";
    let addr: std::net::SocketAddr = "127.0.0.1:1".parse().unwrap();
    let cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_model(&cache, model, ModelState::Starting, addr).await;

    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: "http://127.0.0.1:1".to_string(),
            parking_timeout: Duration::from_secs(10),
            ..Default::default()
        },
        cache.clone(),
    )
    .await;

    let client =
        Arc::new(reqwest::Client::builder().timeout(Duration::from_secs(9)).build().unwrap());
    let url = proxy.proxy_url();
    let m = model.to_string();
    let c = client.clone();
    let start = Instant::now();
    let handle = tokio::spawn(async move {
        c.post(format!("{url}/v1/chat/completions"))
            .json(&serde_json::json!({"model": m, "messages":[{"role":"user","content":"hi"}]}))
            .send()
            .await
    });

    assert!(poll_parked(&proxy, 1, Duration::from_secs(5)).await, "request never parked");
    insert_model(&cache, model, ModelState::Draining, addr).await;

    let resp = handle.await.unwrap().expect("request failed");
    let elapsed = start.elapsed();
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["error"]["type"], "model_unavailable");
    let message = body["error"]["message"].as_str().unwrap_or("");
    assert!(
        message.contains("draining"),
        "expected message to mention draining, got: {message}"
    );
    assert!(
        elapsed < Duration::from_secs(1),
        "fast-fail expected; took {elapsed:?} (parking_timeout is 10s — unfixed code would wait it out)"
    );
}
