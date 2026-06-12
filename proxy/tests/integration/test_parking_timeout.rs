// test_parking_timeout_503: if the model does not become Active within the
// parking timeout, the proxy returns 503.

use std::time::Duration;

use reqwest::StatusCode;

use crate::common::{MockControlPlaneBuilder, TestProxy, insert_sleeping_model};
use crate::common::proxy_builder::TestProxyConfig;

#[tokio::test]
async fn test_parking_timeout_503() {
    let model = "slow-model/never-wakes";

    let shared_cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_sleeping_model(&shared_cache, model).await;

    // The control plane accepts the wake but never updates the routing map,
    // so the model stays in Sleeping state forever.
    let cp = MockControlPlaneBuilder::new()
        // No on_wake_activate — wake is acknowledged but model stays sleeping.
        .spawn()
        .await;

    let cp_url = format!("http://{}", cp.addr);

    // Use a very short parking timeout so the test completes quickly.
    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: cp_url,
            parking_timeout: Duration::from_millis(200),
            ..Default::default()
        },
        shared_cache,
    )
    .await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url()))
        .json(&serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "Are you there?"}]
        }))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .expect("request failed");

    assert_eq!(
        resp.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "parking timeout should return 503"
    );

    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(
        body["error"]["type"], "parking_timeout",
        "error type should be parking_timeout"
    );
}
