// Forwarding concurrency limit tests (#19).
//
// SARDEENZ_PROXY_MAX_CONCURRENT_FORWARDS / SARDEENZ_PROXY_MAX_CONCURRENT_PER_MODEL
// cap in-flight *forwarded* requests. The limiter is deliberately scoped to
// the forwarding step only — it must never see a parked request as
// "in flight", or a pile-up of parked connections waiting for a sleeping
// model to wake could exhaust the limit and deadlock every other request.

use std::time::Duration;

use reqwest::StatusCode;

use crate::common::proxy_builder::TestProxyConfig;
use crate::common::{
    insert_active_model, insert_sleeping_model, MockControlPlaneBuilder, MockRunner, RunnerState,
    TestProxy,
};

fn chat_payload(model: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "Hi"}]
    })
}

#[tokio::test]
async fn test_global_forwarding_limit_returns_overloaded() {
    let model = "forward-limit-global/v1";

    // Gated runner: the handler blocks mid-request until the test releases it,
    // letting us hold the only forwarding permit open.
    let runner_state = RunnerState::new_gated(model);
    let runner = MockRunner::spawn_with_state(runner_state.clone()).await;

    let cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_active_model(&cache, model, runner.addr).await;

    let cp = MockControlPlaneBuilder::new().spawn().await;

    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: format!("http://{}", cp.addr),
            max_concurrent_forwards: 1,
            ..Default::default()
        },
        cache,
    )
    .await;

    let client = reqwest::Client::new();
    let url = format!("{}/v1/chat/completions", proxy.proxy_url());

    // First request claims the only forwarding permit and blocks in the runner.
    let held = {
        let c = client.clone();
        let u = url.clone();
        let p = chat_payload(model);
        tokio::spawn(async move { c.post(u).json(&p).send().await })
    };

    // Wait for the runner to actually receive it (permit is held by then).
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(runner.request_count(), 1);

    // A second concurrent request must be rejected immediately with 503 overloaded.
    let resp = client.post(&url).json(&chat_payload(model)).send().await.expect("request failed");
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["error"]["type"], "overloaded");

    // Release the held request; it should complete normally.
    runner_state.gate.add_permits(1);
    let held_resp = held.await.unwrap().expect("held request failed");
    assert_eq!(held_resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_per_model_forwarding_limit_is_independent_per_model() {
    let model_a = "forward-limit-per-model-a/v1";
    let model_b = "forward-limit-per-model-b/v1";

    let runner_state_a = RunnerState::new_gated(model_a);
    let runner_a = MockRunner::spawn_with_state(runner_state_a.clone()).await;
    let runner_b = MockRunner::spawn(model_b).await;

    let cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_active_model(&cache, model_a, runner_a.addr).await;
    insert_active_model(&cache, model_b, runner_b.addr).await;

    let cp = MockControlPlaneBuilder::new().spawn().await;

    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: format!("http://{}", cp.addr),
            max_concurrent_forwards_per_model: 1,
            ..Default::default()
        },
        cache,
    )
    .await;

    let client = reqwest::Client::new();
    let url = format!("{}/v1/chat/completions", proxy.proxy_url());

    // Saturate model_a's per-model forwarding slot.
    let held = {
        let c = client.clone();
        let u = url.clone();
        let p = chat_payload(model_a);
        tokio::spawn(async move { c.post(u).json(&p).send().await })
    };
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(runner_a.request_count(), 1);

    // A second request for model_a is rejected...
    let resp_a =
        client.post(&url).json(&chat_payload(model_a)).send().await.expect("request failed");
    assert_eq!(resp_a.status(), StatusCode::SERVICE_UNAVAILABLE);

    // ...but model_b, an unrelated model, is completely unaffected.
    let resp_b =
        client.post(&url).json(&chat_payload(model_b)).send().await.expect("request failed");
    assert_eq!(resp_b.status(), StatusCode::OK);

    runner_state_a.gate.add_permits(1);
    held.await.unwrap().expect("held request failed");
}

#[tokio::test]
async fn test_forwarding_limit_does_not_block_parked_requests() {
    let active_model = "forward-limit-active/v1";
    let sleeping_model = "forward-limit-sleeping/v1";

    let runner_state = RunnerState::new_gated(active_model);
    let active_runner = MockRunner::spawn_with_state(runner_state.clone()).await;
    let sleeping_runner = MockRunner::spawn(sleeping_model).await;

    let cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_active_model(&cache, active_model, active_runner.addr).await;
    insert_sleeping_model(&cache, sleeping_model).await;

    let cp = MockControlPlaneBuilder::new()
        .on_wake_activate(
            sleeping_model,
            sleeping_runner.addr,
            cache.clone(),
            Duration::from_millis(150),
        )
        .spawn()
        .await;

    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: format!("http://{}", cp.addr),
            parking_timeout: Duration::from_secs(10),
            max_concurrent_forwards: 1,
            ..Default::default()
        },
        cache,
    )
    .await;

    let client = reqwest::Client::new();
    let url = format!("{}/v1/chat/completions", proxy.proxy_url());

    // Saturate the global forwarding limit with the active model.
    let held = {
        let c = client.clone();
        let u = url.clone();
        let p = chat_payload(active_model);
        tokio::spawn(async move { c.post(u).json(&p).send().await })
    };
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(active_runner.request_count(), 1);

    // A request for a SLEEPING model must park (not be rejected as overloaded)
    // even though the forwarding limiter is fully saturated — parking must
    // never contend for a forwarding permit.
    let parked = {
        let c = client.clone();
        let u = url.clone();
        let p = chat_payload(sleeping_model);
        tokio::spawn(async move { c.post(u).json(&p).send().await })
    };

    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !parked.is_finished(),
        "a parked request must not be rejected by the forwarding limiter"
    );

    // Release the held active-model request.
    runner_state.gate.add_permits(1);
    let held_resp = held.await.unwrap().expect("held request failed");
    assert_eq!(held_resp.status(), StatusCode::OK);

    // The parked request wakes (mock CP activates it after 150ms) and, with
    // the forwarding permit now free, completes successfully.
    let parked_resp = parked.await.unwrap().expect("parked request failed");
    assert_eq!(parked_resp.status(), StatusCode::OK);
}
