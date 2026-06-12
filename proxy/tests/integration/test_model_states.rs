// Tests for non-routable model states (Draining, Error).
//
// Models in Draining or Error state should immediately return 503 with
// error type "model_unavailable".

use reqwest::StatusCode;

use sardeenz_proxy::generated::proxy_control_plane::ModelState;

use crate::common::{TestProxy, insert_model};

#[tokio::test]
async fn test_draining_model_returns_503() {
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;
    let model = "draining-model/v1";

    let dead_addr = "127.0.0.1:1".parse().unwrap();
    insert_model(&proxy.routing_cache, model, ModelState::Draining, dead_addr).await;

    let client = reqwest::Client::new();
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
        "draining model should return 503"
    );

    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(
        body["error"]["type"], "model_unavailable",
        "error type should be model_unavailable"
    );
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("draining"),
        "error message should mention draining"
    );
}

#[tokio::test]
async fn test_error_model_returns_503() {
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;
    let model = "errored-model/v1";

    let dead_addr = "127.0.0.1:1".parse().unwrap();
    insert_model(&proxy.routing_cache, model, ModelState::Error, dead_addr).await;

    let client = reqwest::Client::new();
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
        "error model should return 503"
    );

    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(
        body["error"]["type"], "model_unavailable",
        "error type should be model_unavailable"
    );
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("error state"),
        "error message should mention error state"
    );
}
