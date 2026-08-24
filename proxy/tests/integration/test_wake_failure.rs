// Wake failure test.
//
// When the control plane rejects a wake trigger, the parked request should
// eventually time out and the client should receive a 503.

use std::time::Duration;

use reqwest::StatusCode;

use crate::common::proxy_builder::TestProxyConfig;
use crate::common::{insert_sleeping_model, MockControlPlaneBuilder, TestProxy};

#[tokio::test]
async fn test_wake_trigger_failure_returns_503() {
    let cache = sardeenz_proxy::routing::RoutingMapCache::new();
    let model = "failing-wake/model-v1";
    insert_sleeping_model(&cache, model).await;

    let cp = MockControlPlaneBuilder::new().fail_wakes().spawn().await;

    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: format!("http://{}", cp.addr),
            parking_timeout: Duration::from_millis(500),
            ..Default::default()
        },
        cache,
    )
    .await;

    let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().unwrap();

    let resp = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url()))
        .json(&serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "Hello"}]
        }))
        .send()
        .await
        .expect("request failed");

    assert_eq!(
        resp.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "failed wake should eventually lead to parking timeout → 503"
    );

    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    let error_type = body["error"]["type"].as_str().unwrap_or("");
    assert!(
        error_type == "parking_timeout" || error_type == "model_unavailable",
        "expected parking_timeout or model_unavailable, got: {error_type}"
    );

    // The control plane should have received a wake call.
    assert!(
        cp.wake_count_for(model).await >= 1,
        "control plane should have received at least one wake call"
    );

    // #97: the client-facing error must NOT leak the control plane's
    // response body/message — only the generic wording. This is decisive:
    // if wake.rs's non-2xx branch reverted to interpolating `{status}:
    // {body}` into the error, the mock's "mock failure" message (embedded
    // in the JSON body) would leak through and this assertion would fail.
    let message = body["error"]["message"].as_str().unwrap_or("");
    assert!(
        !message.contains("mock failure"),
        "client-facing error must not leak the control plane's response body: {message}"
    );
    assert!(
        message.contains("rejected by control plane"),
        "expected the generic non-2xx error wording, got: {message}"
    );
}

// #97: when the wake trigger fails at the transport level (connection
// refused, no control plane listening at all), the underlying reqwest error
// (which embeds the control-plane URL, e.g. "error sending request for url
// (http://127.0.0.1:1/api/v1/wake)") must never reach the client. Only a
// generic message may be returned; the raw error is logged server-side via
// tracing::warn! instead.
#[tokio::test]
async fn test_wake_transport_error_no_url_leak() {
    let cache = sardeenz_proxy::routing::RoutingMapCache::new();
    let model = "unreachable-cp/model-v1";
    insert_sleeping_model(&cache, model).await;

    // Port 1 is a closed/unreachable port on 127.0.0.1: nothing listens
    // there, so reqwest will fail with a connection-refused transport error
    // rather than an HTTP-level rejection.
    let closed_cp_url = "http://127.0.0.1:1";

    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: closed_cp_url.to_string(),
            parking_timeout: Duration::from_millis(500),
            ..Default::default()
        },
        cache,
    )
    .await;

    let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().unwrap();

    let resp = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url()))
        .json(&serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "Hello"}]
        }))
        .send()
        .await
        .expect("request failed");

    assert_eq!(
        resp.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "wake transport failure should surface as 503"
    );

    let body_text = resp.text().await.expect("response body not readable");
    let body: serde_json::Value =
        serde_json::from_str(&body_text).expect("response not valid JSON");

    let error_type = body["error"]["type"].as_str().unwrap_or("");
    assert_eq!(error_type, "model_unavailable", "expected model_unavailable, got: {error_type}");

    assert!(
        !body_text.contains(closed_cp_url),
        "client-facing error must not leak the control plane URL: {body_text}"
    );
    assert!(
        !body_text.contains("127.0.0.1"),
        "client-facing error must not leak the control plane host: {body_text}"
    );
    assert!(
        !body_text.contains("error sending request"),
        "client-facing error must not leak the raw reqwest transport error: {body_text}"
    );
    assert!(
        body_text.contains("wake trigger"),
        "expected the generic wake-trigger error wording, got: {body_text}"
    );
}
