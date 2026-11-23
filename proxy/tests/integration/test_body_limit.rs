// Buffered request-body cap tests (#211).
//
// Both infer surfaces buffer the whole body before routing, capped by
// SARDEENZ_PROXY_MAX_BODY_BYTES. An over-limit body is rejected with the
// proxy's own 413 `request_too_large` envelope (naming the configured limit
// and the variable), whether the client declared a Content-Length or framed
// the body chunked; a body exactly at the limit is read and reaches model
// resolution.

use reqwest::StatusCode;

use crate::common::proxy_builder::TestProxyConfig;
use crate::common::{insert_active_model, MockRunner, TestProxy};

/// A ~2 KiB OpenAI chat body for an unregistered model.
fn oversized_openai_body() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "model": "ghost",
        "messages": [{"role": "user", "content": "x".repeat(2048)}]
    }))
    .expect("serialize payload")
}

#[tokio::test]
async fn openai_over_limit_returns_413() {
    let proxy = TestProxy::spawn_with_config(TestProxyConfig {
        max_body_bytes: 1024,
        ..Default::default()
    })
    .await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .header("content-type", "application/json")
        .body(oversized_openai_body())
        .send()
        .await
        .expect("request failed");

    // 413 — not 404 model_not_found: the rejection precedes resolve.
    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["error"]["type"], "request_too_large");
    let message = body["error"]["message"].as_str().unwrap_or("");
    assert!(message.contains("1024-byte"), "message should name the configured limit: {message}");
    assert!(
        message.contains("SARDEENZ_PROXY_MAX_BODY_BYTES"),
        "message should name the env var: {message}"
    );
}

#[tokio::test]
async fn oip_over_limit_returns_413_with_model_named() {
    let proxy = TestProxy::spawn_with_config(TestProxyConfig {
        max_body_bytes: 1024,
        ..Default::default()
    })
    .await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/oip/v2/models/ghost/infer", proxy.proxy_url()))
        .header("content-type", "application/json")
        .body(vec![b'x'; 2048])
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["error"]["type"], "request_too_large");
    let message = body["error"]["message"].as_str().unwrap_or("");
    assert!(message.contains("1024-byte"), "message should name the configured limit: {message}");
    assert!(
        message.contains("SARDEENZ_PROXY_MAX_BODY_BYTES"),
        "message should name the env var: {message}"
    );
}

#[tokio::test]
async fn declared_content_length_and_chunked_bodies_return_identical_413() {
    let proxy = TestProxy::spawn_with_config(TestProxyConfig {
        max_body_bytes: 1024,
        ..Default::default()
    })
    .await;
    let url = format!("{}/openai/v1/chat/completions", proxy.proxy_url());
    let client = reqwest::Client::new();
    let bytes = oversized_openai_body();

    // Declared Content-Length: reqwest sets it from a sized body → the handler's
    // Content-Length fast-fail rejects before reading.
    let declared = client
        .post(&url)
        .header("content-type", "application/json")
        .body(bytes.clone())
        .send()
        .await
        .expect("request failed");
    assert_eq!(declared.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let declared_body: serde_json::Value = declared.json().await.expect("response not JSON");

    // No Content-Length: reqwest frames a streamed body as `Transfer-Encoding:
    // chunked`, so the overflow can only be detected inside the handler's
    // Limited read.
    let stream = futures_util::stream::once(async move { Ok::<_, std::io::Error>(bytes) });
    let chunked = client
        .post(&url)
        .header("content-type", "application/json")
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await
        .expect("request failed");
    assert_eq!(chunked.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let chunked_body: serde_json::Value = chunked.json().await.expect("response not JSON");

    assert_eq!(declared_body["error"]["type"], "request_too_large");
    assert_eq!(declared_body, chunked_body, "both framing paths must yield the identical error");
}

#[tokio::test]
async fn body_exactly_at_limit_passes_the_read() {
    let proxy = TestProxy::spawn_with_config(TestProxyConfig {
        max_body_bytes: 1024,
        ..Default::default()
    })
    .await;

    // Valid JSON padded with trailing whitespace to exactly the limit.
    let base = r#"{"model":"ghost","messages":[]}"#;
    let body = format!("{base}{}", " ".repeat(1024 - base.len()));
    assert_eq!(body.len(), 1024);

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .expect("request failed");

    // The read and JSON parse succeeded; only resolution failed.
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["error"]["type"], "model_not_found");
}

#[tokio::test]
async fn raised_cap_accepts_larger_than_one_mib_body() {
    let model = "body-limit-large/v1";
    let runner = MockRunner::spawn(model).await;
    let proxy = TestProxy::spawn_with_config(TestProxyConfig {
        max_body_bytes: 4 * 1024 * 1024,
        ..Default::default()
    })
    .await;
    insert_active_model(&proxy.routing_cache, model, runner.addr).await;

    // ~2 MiB: above the old 1 MiB default, below the raised cap.
    let payload = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "x".repeat(2 * 1024 * 1024)}]
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .json(&payload)
        .send()
        .await
        .expect("request failed");

    assert_ne!(
        resp.status(),
        StatusCode::PAYLOAD_TOO_LARGE,
        "raised cap should accept a 2 MiB body"
    );
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(runner.request_count(), 1, "the buffered body should be forwarded exactly once");
}
