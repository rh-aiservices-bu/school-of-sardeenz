// test_active_model_streaming: proxy correctly streams SSE responses from
// the runner back to the client.

use futures_util::StreamExt;
use reqwest::StatusCode;

use crate::common::{MockRunner, TestProxy, insert_active_model};

#[tokio::test]
async fn test_active_model_streaming() {
    let model = "mistralai/Mistral-7B-Instruct-v0.3";

    let runner = MockRunner::spawn(model).await;
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;
    insert_active_model(&proxy.routing_cache, model, runner.addr).await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url()))
        .json(&serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "Count to three"}],
            "stream": true
        }))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::OK, "expected 200 OK");

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(
        content_type.contains("text/event-stream"),
        "expected SSE content-type, got: {content_type}"
    );

    // Collect the full streamed body.
    let mut stream = resp.bytes_stream();
    let mut collected = Vec::new();
    while let Some(chunk) = stream.next().await {
        collected.extend_from_slice(&chunk.expect("stream error"));
    }

    let body_str = String::from_utf8(collected).expect("non-UTF8 SSE body");

    // The mock runner sends two data chunks and a [DONE] sentinel.
    assert!(
        body_str.contains("data:"),
        "SSE body should contain data lines"
    );
    assert!(
        body_str.contains("[DONE]"),
        "SSE body should end with [DONE]"
    );
    assert!(
        body_str.contains("Hello"),
        "SSE body should contain first chunk content"
    );

    assert_eq!(runner.request_count(), 1);
}
