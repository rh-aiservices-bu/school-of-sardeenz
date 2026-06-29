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
}
