// test_protocol_family_admission: the per-entry `protocol` tag gates admission on every surface
// (#246, ADR-021 Decisions 3/4/6). A model is invocable — and, for `oip`, probeable — only under
// its own family's prefix; the other prefix answers the proxy's 404 `model_not_found` before
// resolution can park, wake or forward.

use std::time::{Duration, Instant};

use reqwest::StatusCode;

use crate::common::proxy_builder::TestProxyConfig;
use crate::common::{
    insert_active_model, insert_active_oip_model, insert_sleeping_model, insert_sleeping_oip_model,
    MockControlPlaneBuilder, MockRunner, TestProxy,
};

const PROTOCOL_MESSAGE: &str = "model not found under this protocol family";

/// Every cross-family rejection is the standard error envelope: 404 shape already asserted by the
/// caller, message names the requested model and the protocol family, and never the real family.
fn assert_cross_family_body(body: &serde_json::Value, model: &str) {
    assert_eq!(body["error"]["type"], "model_not_found", "error type must stay model_not_found");
    let message = body["error"]["message"].as_str().expect("error message must be a string");
    assert!(message.contains(PROTOCOL_MESSAGE), "unexpected message: {message}");
    assert!(message.contains(model), "message must name the requested model: {message}");
    assert!(
        !message.contains("oip"),
        "message must not disclose the model's real family: {message}"
    );
    assert!(
        !message.contains("openai"),
        "message must not disclose the model's real family: {message}"
    );
}

#[tokio::test]
async fn cross_family_active_oip_model_on_openai_infer_404() {
    let model = "iris-sklearn";
    let runner = MockRunner::spawn(model).await;
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;
    insert_active_oip_model(&proxy.routing_cache, model, runner.addr).await;

    let resp = reqwest::Client::new()
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .json(&serde_json::json!({"model": model, "messages": []}))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::NOT_FOUND, "an oip model is not invocable under /openai");
    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_cross_family_body(&body, model);
    assert_eq!(runner.request_count(), 0, "a cross-family request must never be forwarded");
}

#[tokio::test]
async fn cross_family_active_openai_model_on_oip_infer_404() {
    let model = "llama-3-1-8b-instruct"; // slash-free: `{model}` is one axum path segment
    let runner = MockRunner::spawn(model).await;
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;
    insert_active_model(&proxy.routing_cache, model, runner.addr).await;

    let resp = reqwest::Client::new()
        .post(format!("{}/oip/v2/models/{model}/infer", proxy.proxy_url()))
        .json(&serde_json::json!({"inputs": []}))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::NOT_FOUND, "an openai model is not invocable under /oip");
    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_cross_family_body(&body, model);
    assert_eq!(runner.request_count(), 0, "a cross-family request must never be forwarded");
}

#[tokio::test]
async fn cross_family_sleeping_oip_model_on_openai_infer_404_no_wake() {
    let model = "sentiment-hf";
    let shared_cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_sleeping_oip_model(&shared_cache, model).await;

    let cp = MockControlPlaneBuilder::new().spawn().await;
    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: format!("http://{}", cp.addr),
            parking_timeout: Duration::from_millis(500),
            ..Default::default()
        },
        shared_cache,
    )
    .await;

    let started = Instant::now();
    let resp = reqwest::Client::new()
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .json(&serde_json::json!({"model": model, "messages": []}))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .expect("request failed");
    let elapsed = started.elapsed();

    assert_eq!(
        resp.status(),
        StatusCode::NOT_FOUND,
        "a cross-family sleeping model must 404, not park until timeout"
    );
    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_cross_family_body(&body, model);
    assert_eq!(
        cp.wake_count_for(model).await,
        0,
        "a cross-family request must never wake the model"
    );
    assert!(
        elapsed < Duration::from_secs(2),
        "rejection must be immediate, not a parking timeout: {elapsed:?}"
    );
}

#[tokio::test]
async fn cross_family_sleeping_openai_model_on_oip_infer_404_no_wake() {
    let model = "gpt2";
    let shared_cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_sleeping_model(&shared_cache, model).await;

    let cp = MockControlPlaneBuilder::new().spawn().await;
    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: format!("http://{}", cp.addr),
            parking_timeout: Duration::from_millis(500),
            ..Default::default()
        },
        shared_cache,
    )
    .await;

    let started = Instant::now();
    let resp = reqwest::Client::new()
        .post(format!("{}/oip/v2/models/{model}/infer", proxy.proxy_url()))
        .json(&serde_json::json!({"inputs": []}))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .expect("request failed");
    let elapsed = started.elapsed();

    assert_eq!(
        resp.status(),
        StatusCode::NOT_FOUND,
        "a cross-family sleeping model must 404, not park until timeout"
    );
    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_cross_family_body(&body, model);
    assert_eq!(
        cp.wake_count_for(model).await,
        0,
        "a cross-family request must never wake the model"
    );
    assert!(
        elapsed < Duration::from_secs(2),
        "rejection must be immediate, not a parking timeout: {elapsed:?}"
    );
}

#[tokio::test]
async fn cross_family_openai_model_on_oip_ready_404() {
    let model = "gpt2"; // openai-tagged
    let runner = MockRunner::spawn(model).await;
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;
    insert_active_model(&proxy.routing_cache, model, runner.addr).await;

    let resp = reqwest::Client::new()
        .get(format!("{}/oip/v2/models/{model}/ready", proxy.proxy_url()))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::NOT_FOUND, "an openai model is not probeable under /oip");
    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_cross_family_body(&body, model);
    // `handle_v2_ready` in the mock runner does NOT increment `request_count`, so there is no
    // counter to assert here — the 404 status/body is the proof the probe was never forwarded
    // (pre-fix this case returns 200 {"ready": true} from the mock runner).
}
