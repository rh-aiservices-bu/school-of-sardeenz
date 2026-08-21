// test_wake_response: the proxy must inspect the WakeTriggerResponse body on
// a 2xx wake trigger reply rather than treating status alone as success.
//
// - A soft-rejected wake (`accepted: false` on a 2xx) must fail fast — not
//   fall through to the parking timeout — and must not leak the control
//   plane's internal state (currentState/message) to the client (#97).
// - A malformed (non-deserializable) 2xx body must NOT break waking; the
//   proxy falls back to treating the 2xx as success. See #98.

use std::time::{Duration, Instant};

use reqwest::StatusCode;

use crate::common::proxy_builder::TestProxyConfig;
use crate::common::{insert_sleeping_model, MockControlPlaneBuilder, MockRunner, TestProxy};

#[tokio::test]
async fn test_soft_rejected_wake_fails_fast_without_leak() {
    let model = "soft-reject/model-v1";
    let cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_sleeping_model(&cache, model).await;

    let cp = MockControlPlaneBuilder::new().soft_reject_wakes().spawn().await;

    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: format!("http://{}", cp.addr),
            parking_timeout: Duration::from_secs(10),
            ..Default::default()
        },
        cache,
    )
    .await;

    let client = reqwest::Client::builder().timeout(Duration::from_secs(9)).build().unwrap();

    let start = Instant::now();
    let resp = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url()))
        .json(&serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "Wake up!"}]
        }))
        .send()
        .await
        .expect("request failed");
    let elapsed = start.elapsed();

    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["error"]["type"], "model_unavailable");

    assert!(
        elapsed < Duration::from_secs(1),
        "fast-fail expected; took {elapsed:?} (parking_timeout is 10s — unfixed code would wait it out)"
    );

    assert!(cp.wake_count_for(model).await >= 1, "control plane should have received a wake call");

    let message = body["error"]["message"].as_str().unwrap_or("");
    assert!(!message.contains("VRAM"), "client-facing error must not leak control-plane detail: {message}");
    assert!(!message.contains("ERROR"), "client-facing error must not leak control-plane state: {message}");
}

#[tokio::test]
async fn test_malformed_wake_response_still_wakes() {
    let model = "malformed-wake/model-v1";
    let runner = MockRunner::spawn(model).await;

    let cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_sleeping_model(&cache, model).await;

    let cp = MockControlPlaneBuilder::new()
        .malformed_wake_body()
        .on_wake_activate(model, runner.addr, cache.clone(), Duration::from_millis(50))
        .spawn()
        .await;

    let proxy = TestProxy::spawn_with_shared_cache(&format!("http://{}", cp.addr), cache).await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url()))
        .json(&serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "Wake up!"}]
        }))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::OK, "malformed-but-2xx wake body must not break waking");

    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["object"], "chat.completion");

    assert_eq!(cp.wake_count_for(model).await, 1, "expected exactly one wake trigger");
    assert_eq!(runner.request_count(), 1);
}
