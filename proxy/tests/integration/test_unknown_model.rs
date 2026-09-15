// test_unknown_model_404: requests for a model not present in the routing
// map should return a 404 with a structured JSON error body.

use reqwest::StatusCode;

use crate::common::TestProxy;

#[tokio::test]
async fn test_unknown_model_404() {
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;
    // Routing map is empty — no models registered.

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .json(&serde_json::json!({
            "model": "does-not-exist/unknown-7B",
            "messages": [{"role": "user", "content": "Hello"}]
        }))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::NOT_FOUND, "unknown model should return 404");

    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["error"]["type"], "model_not_found", "error type should be model_not_found");
    assert!(
        body["error"]["message"].as_str().unwrap_or("").contains("does-not-exist/unknown-7B"),
        "error message should contain the model name"
    );
}

#[tokio::test]
async fn test_missing_model_field_400() {
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .json(&serde_json::json!({
            "messages": [{"role": "user", "content": "Hello"}]
        }))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "missing model field should return 400");

    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(
        body["error"]["type"], "invalid_request_error",
        "error type should be invalid_request_error"
    );
}

#[tokio::test]
async fn test_invalid_json_body_400() {
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .header("content-type", "application/json")
        .body("not valid json{{{")
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "invalid JSON should return 400");

    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(
        body["error"]["type"], "invalid_request_error",
        "error type should be invalid_request_error"
    );
}
