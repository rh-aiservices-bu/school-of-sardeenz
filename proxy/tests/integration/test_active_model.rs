// test_active_model_request: proxy routes request to mock runner and returns
// the response correctly.

use reqwest::StatusCode;

use crate::common::{insert_active_model, MockRunner, TestProxy};

#[tokio::test]
async fn test_active_model_request() {
    let model = "meta-llama/Llama-3.1-8B-Instruct";

    // Spin up a mock runner.
    let runner = MockRunner::spawn(model).await;

    // Spin up the proxy (no control plane needed — model is active).
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;

    // Inject an active routing entry directly into the cache.
    insert_active_model(&proxy.routing_cache, model, runner.addr).await;

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

    assert_eq!(resp.status(), StatusCode::OK, "expected 200 OK from proxy");

    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["object"], "chat.completion");
    assert_eq!(body["model"], model);

    // Verify that the runner received exactly one request.
    assert_eq!(runner.request_count(), 1);
}

#[tokio::test]
async fn test_active_model_completions_endpoint() {
    // Ensure /v1/completions (non-chat) is also proxied correctly.
    let model = "bigcode/starcoder2-15b";

    let runner = MockRunner::spawn(model).await;
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;
    insert_active_model(&proxy.routing_cache, model, runner.addr).await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/v1/completions", proxy.proxy_url()))
        .json(&serde_json::json!({
            "model": model,
            "prompt": "def hello():",
            "max_tokens": 32
        }))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(runner.request_count(), 1);
}
