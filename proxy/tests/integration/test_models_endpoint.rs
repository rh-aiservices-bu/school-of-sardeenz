// test_models_endpoint: GET /v1/models returns an aggregated list of models
// in Active or Sleeping state (not Draining/Error/Starting).

use reqwest::StatusCode;

use sardeenz_proxy::generated::proxy_control_plane::ModelState;

use crate::common::{
    insert_active_model, insert_active_model_with_metadata, insert_model, MockRunner, TestProxy,
};

#[tokio::test]
async fn test_models_endpoint_active_and_sleeping() {
    let active_model = "meta-llama/Llama-3.1-8B-Instruct";
    let sleeping_model = "mistralai/Mistral-7B-v0.3";
    let draining_model = "deprecated/old-model";

    let runner = MockRunner::spawn(active_model).await;
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;

    // Active model — should appear in /v1/models.
    insert_active_model(&proxy.routing_cache, active_model, runner.addr).await;

    // Sleeping model — should also appear (still advertised).
    insert_model(
        &proxy.routing_cache,
        sleeping_model,
        ModelState::Sleeping,
        runner.addr, // addr doesn't matter for sleeping
    )
    .await;

    // Draining model — should NOT appear.
    insert_model(&proxy.routing_cache, draining_model, ModelState::Draining, runner.addr).await;

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/v1/models", proxy.proxy_url()))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::OK);

    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["object"], "list");

    let data = body["data"].as_array().expect("data should be array");

    let ids: Vec<&str> = data.iter().map(|m| m["id"].as_str().unwrap_or("")).collect();

    assert!(ids.contains(&active_model), "active model should appear in /v1/models");
    assert!(ids.contains(&sleeping_model), "sleeping model should appear in /v1/models");
    assert!(!ids.contains(&draining_model), "draining model should NOT appear in /v1/models");

    // Standard OpenAI model object fields.
    let active =
        data.iter().find(|m| m["id"] == active_model).expect("active model not in response");
    assert_eq!(active["object"], "model");
}

#[tokio::test]
async fn test_models_endpoint_metadata() {
    // owned_by metadata should propagate to the response.
    let model = "custom-org/my-fine-tuned-model";
    let runner = MockRunner::spawn(model).await;
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;

    insert_active_model_with_metadata(&proxy.routing_cache, model, runner.addr, "my-org").await;

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/v1/models", proxy.proxy_url()))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::OK);
    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    let data = body["data"].as_array().unwrap();
    let entry = data.iter().find(|m| m["id"] == model).expect("model not in response");

    assert_eq!(entry["owned_by"], "my-org", "owned_by from metadata should override the default");
}

#[tokio::test]
async fn test_models_endpoint_empty() {
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;
    // No models registered.

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/v1/models", proxy.proxy_url()))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::OK);
    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["object"], "list");
    assert_eq!(
        body["data"].as_array().unwrap().len(),
        0,
        "empty routing map should return empty data array"
    );
}
