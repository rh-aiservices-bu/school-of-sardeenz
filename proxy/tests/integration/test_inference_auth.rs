// Optional static inference API key (#332).
//
// With `SARDEENZ_PROXY_INFERENCE_API_KEY` unset the proxy is unchanged. With
// it set, every request on `/openai/*` and `/oip/*` must carry
// `Authorization: Bearer <key>`; the rejection happens before the body is
// read and before any parking or wake trigger, and the client's
// `Authorization` header is never forwarded to the runner. The admin port is
// unaffected. Metrics are asserted in the `auth` unit test — the integration
// harness's recorder is deliberately not installed (see `proxy_builder.rs`).

use std::time::Duration;

use reqwest::StatusCode;

use crate::common::proxy_builder::TestProxyConfig;
use crate::common::{
    insert_active_model, insert_active_oip_model, insert_sleeping_model, MockControlPlaneBuilder,
    MockRunner, TestProxy,
};

const KEY_A: &str = "test-inference-key-rotation-a";
const KEY_B: &str = "test-inference-key-rotation-b";

fn key_config(keys: &[&str]) -> TestProxyConfig {
    TestProxyConfig {
        inference_api_keys: keys.iter().map(|k| k.to_string()).collect(),
        ..Default::default()
    }
}

fn chat_body(model: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "hello"}]
    })
}

fn oversized_body(model: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "x".repeat(4096)}]
    }))
    .expect("serialize payload")
}

#[tokio::test]
async fn missing_key_returns_401_envelope_on_both_families() {
    let proxy = TestProxy::spawn_with_config(key_config(&[KEY_A])).await;
    let client = reqwest::Client::new();

    for (path, body) in [
        ("/openai/v1/chat/completions", Some(chat_body("some/model"))),
        ("/openai/v1/models", None),
        ("/oip/v2/models/some-model/infer", Some(serde_json::json!({"inputs": []}))),
        ("/oip/v2/models", None),
    ] {
        let mut request = if body.is_some() {
            client.post(format!("{}{path}", proxy.proxy_url()))
        } else {
            client.get(format!("{}{path}", proxy.proxy_url()))
        };
        if let Some(body) = body {
            request = request.json(&body);
        }
        let resp = request.send().await.expect("request failed");

        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "{path} must reject a missing key");
        let payload: serde_json::Value = resp.json().await.expect("response not JSON");
        assert_eq!(
            payload["error"]["type"], "authentication_error",
            "{path} must answer in the proxy's JSON error envelope"
        );
        let message = payload["error"]["message"].as_str().unwrap_or("");
        assert_eq!(message, "missing or invalid inference API key");
        assert!(!message.contains(KEY_A), "message must never echo key material: {message}");
    }
}

#[tokio::test]
async fn wrong_key_returns_401_without_echoing_presented_material() {
    let proxy = TestProxy::spawn_with_config(key_config(&[KEY_A])).await;
    let client = reqwest::Client::new();

    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .header("authorization", "Bearer definitely-not-the-key")
        .json(&chat_body("some/model"))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let raw = resp.text().await.expect("body");
    assert!(
        !raw.contains("definitely-not-the-key"),
        "401 body must not echo the presented header: {raw}"
    );
    let payload: serde_json::Value = serde_json::from_str(&raw).expect("response not JSON");
    assert_eq!(payload["error"]["type"], "authentication_error");
}

#[tokio::test]
async fn auth_precedes_body_limit_401_not_413() {
    let model = "openai/key-order-model";
    let proxy = TestProxy::spawn_with_config(TestProxyConfig {
        max_body_bytes: 1024,
        ..key_config(&[KEY_A])
    })
    .await;
    let client = reqwest::Client::new();

    // No key + an over-limit body: 401 — not 413. The auth layer runs outside
    // the handler that owns the body read, so an unauthenticated caller cannot
    // even buffer a body.
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .header("content-type", "application/json")
        .body(oversized_body(model))
        .send()
        .await
        .expect("request failed");
    assert_eq!(
        resp.status(),
        StatusCode::UNAUTHORIZED,
        "auth rejection must precede the body-limit check"
    );
    let payload: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(payload["error"]["type"], "authentication_error");

    // Same body, valid key: the body limit is armed and now answers 413. Proves
    // the 401 above came from auth, not from a lenient body path.
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {KEY_A}"))
        .body(oversized_body(model))
        .send()
        .await
        .expect("request failed");
    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let payload: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(payload["error"]["type"], "request_too_large");
}

#[tokio::test]
async fn rejected_request_does_not_park_or_wake() {
    let model = "openai/sleeping-protected-model";
    let runner = MockRunner::spawn(model).await;

    let shared_cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_sleeping_model(&shared_cache, model).await;

    // The proxy shares the mock CP's cache, so a wake would be visible in both
    // the CP's counter and the proxy's parking manager.
    let cp = MockControlPlaneBuilder::new()
        .on_wake_activate(model, runner.addr, shared_cache.clone(), Duration::from_millis(50))
        .spawn()
        .await;

    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: format!("http://{}", cp.addr),
            ..key_config(&[KEY_A])
        },
        shared_cache,
    )
    .await;

    let client = reqwest::Client::new();
    for header in [None, Some("Bearer wrong-key")] {
        let mut request = client
            .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
            .json(&chat_body(model));
        if let Some(header) = header {
            request = request.header("authorization", header);
        }
        let resp = request.send().await.expect("request failed");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    assert_eq!(cp.wake_count_for(model).await, 0, "rejected requests must never trigger a wake");
    assert_eq!(proxy.parking.global_parked_count(), 0, "rejected requests must never park");
    assert_eq!(runner.request_count(), 0, "rejected requests must never be forwarded");
}

#[tokio::test]
async fn each_rotation_key_serves_openai_non_streaming_and_streaming() {
    let model = "openai/rotation-model";
    let runner = MockRunner::spawn(model).await;
    let proxy = TestProxy::spawn_with_config(key_config(&[KEY_A, KEY_B])).await;
    insert_active_model(&proxy.routing_cache, model, runner.addr).await;

    let client = reqwest::Client::new();
    for key in [KEY_A, KEY_B] {
        let resp = client
            .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
            .header("authorization", format!("Bearer {key}"))
            .json(&chat_body(model))
            .send()
            .await
            .expect("request failed");
        assert_eq!(resp.status(), StatusCode::OK, "non-streaming must be served for {key}");
        let body: serde_json::Value = resp.json().await.expect("response not JSON");
        assert_eq!(body["object"], "chat.completion");

        let resp = client
            .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
            .header("authorization", format!("Bearer {key}"))
            .json(&serde_json::json!({
                "model": model,
                "messages": [{"role": "user", "content": "stream"}],
                "stream": true
            }))
            .send()
            .await
            .expect("request failed");
        assert_eq!(resp.status(), StatusCode::OK, "streaming must be served for {key}");
        let content_type =
            resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("");
        assert!(
            content_type.contains("text/event-stream"),
            "expected SSE content-type for {key}, got: {content_type}"
        );

        let resp = client
            .get(format!("{}/openai/v1/models", proxy.proxy_url()))
            .header("authorization", format!("Bearer {key}"))
            .send()
            .await
            .expect("request failed");
        assert_eq!(resp.status(), StatusCode::OK, "model listing must be served for {key}");
    }

    assert_eq!(runner.request_count(), 4, "two keys × (non-streaming + streaming)");
}

#[tokio::test]
async fn each_rotation_key_serves_oip() {
    let model = "iris-rotation";
    let runner = MockRunner::spawn(model).await;
    let proxy = TestProxy::spawn_with_config(key_config(&[KEY_A, KEY_B])).await;
    insert_active_oip_model(&proxy.routing_cache, model, runner.addr).await;

    let client = reqwest::Client::new();
    for key in [KEY_A, KEY_B] {
        let resp = client
            .post(format!("{}/oip/v2/models/{model}/infer", proxy.proxy_url()))
            .header("authorization", format!("Bearer {key}"))
            .json(&serde_json::json!({"inputs": []}))
            .send()
            .await
            .expect("request failed");
        assert_eq!(resp.status(), StatusCode::OK, "OIP infer must be served for {key}");
        // The auth layer does not disturb the `/oip` prefix strip (#125).
        assert_eq!(runner.last_v2_infer_path(), Some(format!("/v2/models/{model}/infer")));

        let resp = client
            .get(format!("{}/oip/v2/models", proxy.proxy_url()))
            .header("authorization", format!("Bearer {key}"))
            .send()
            .await
            .expect("request failed");
        assert_eq!(resp.status(), StatusCode::OK, "OIP listing must be served for {key}");
    }
}

#[tokio::test]
async fn key_disabled_behaviour_unchanged() {
    let model = "openai/no-key-model";
    let runner = MockRunner::spawn(model).await;
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;
    insert_active_model(&proxy.routing_cache, model, runner.addr).await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .json(&chat_body(model))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::OK, "with no key configured the proxy stays open");
    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["object"], "chat.completion");
}

#[tokio::test]
async fn client_authorization_not_forwarded_when_key_enabled() {
    let model = "openai/strip-header-model";
    let runner = MockRunner::spawn(model).await;
    let proxy = TestProxy::spawn_with_config(key_config(&[KEY_A])).await;
    insert_active_model(&proxy.routing_cache, model, runner.addr).await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .header("authorization", format!("Bearer {KEY_A}"))
        .json(&chat_body(model))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        runner.last_authorization_header(),
        None,
        "the client's Authorization must never reach the runner while the key is enabled"
    );
}

#[tokio::test]
async fn key_disabled_forwards_authorization_unchanged() {
    let model = "openai/passthrough-header-model";
    let runner = MockRunner::spawn(model).await;
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;
    insert_active_model(&proxy.routing_cache, model, runner.addr).await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .header("authorization", "Bearer whatever")
        .json(&chat_body(model))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        runner.last_authorization_header().as_deref(),
        Some("Bearer whatever"),
        "with the key disabled forwarding behaviour is unchanged (today's behaviour)"
    );
}

#[tokio::test]
async fn admin_port_unaffected_by_the_key() {
    let proxy = TestProxy::spawn_with_config(key_config(&[KEY_A])).await;
    let client = reqwest::Client::new();

    for path in ["/healthz", "/readyz", "/metrics"] {
        let resp = client
            .get(format!("{}{path}", proxy.admin_url()))
            .send()
            .await
            .expect("request failed");
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "admin {path} must stay reachable without the key (probes and Prometheus scraping)"
        );
    }
}
