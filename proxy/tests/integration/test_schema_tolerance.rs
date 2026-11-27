// test_schema_tolerance: a routing entry written by a NEWER control plane
// (unknown extra fields) deserialises and routes normally (#331).

use reqwest::StatusCode;

use sardeenz_proxy::generated::proxy_control_plane::RoutingEntry;

use crate::common::{MockRunner, TestProxy};

#[tokio::test]
async fn test_routing_entry_with_unknown_extra_fields_routes() {
    let model = "future-field-model";

    let runner = MockRunner::spawn(model).await;
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;

    // Raw entry as a newer control plane would write it: every required
    // camelCase field plus unknown extras at the top level and inside metadata.
    let raw = serde_json::json!({
        "modelName": model,
        "state": "ACTIVE",
        "protocol": "openai",
        "endpoints": [{
            "host": runner.addr.ip().to_string(),
            "port": runner.addr.port(),
            "weight": 1,
            "healthy": true
        }],
        "updatedAt": "2026-01-01T00:00:00Z",
        "futureField": "unknown-to-this-proxy",
        "metadata": { "ownedBy": "org", "futureMetaField": 7 }
    });

    let entry: RoutingEntry =
        serde_json::from_str(&raw.to_string()).expect("unknown extra fields must deserialize");
    proxy.routing_cache.update_entry(model.to_string(), entry).await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .json(&serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "Hello"}]
        }))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::OK, "expected 200 OK from proxy");
    assert_eq!(runner.request_count(), 1, "runner should have received the request");
}
