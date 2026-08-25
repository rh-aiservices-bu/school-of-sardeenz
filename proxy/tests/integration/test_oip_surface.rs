// test_oip_surface: the KServe V2 Open Inference Protocol surface added by
// #125 — `/oip/v2/models/{model}/infer`, `/oip/v2/models/{model}/ready`, and
// `/oip/v2/models`. Resolution/parking/wake/forwarding are protocol-agnostic
// (D8); only the two listing endpoints filter by protocol tag.

use std::time::Duration;

use reqwest::StatusCode;

use crate::common::{
    insert_active_model, insert_active_oip_model, insert_sleeping_oip_model,
    MockControlPlaneBuilder, MockRunner, TestProxy,
};

#[tokio::test]
async fn oip_infer_active_forwards() {
    let model = "iris-sklearn";
    let runner = MockRunner::spawn(model).await;
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;
    insert_active_oip_model(&proxy.routing_cache, model, runner.addr).await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/oip/v2/models/{model}/infer", proxy.proxy_url()))
        .json(&serde_json::json!({"inputs": []}))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::OK, "active oip model should forward and return 200");
    assert_eq!(runner.request_count(), 1);

    // Verifies prefix stripping (D5): the runner must see the canonical V2
    // path with `/oip` stripped, not the proxy-facing path.
    assert_eq!(
        runner.last_v2_infer_path(),
        Some(format!("/v2/models/{model}/infer")),
        "proxy must strip the /oip prefix before forwarding"
    );
}

#[tokio::test]
async fn oip_infer_sleeping_parks_and_wakes() {
    let model = "sentiment-hf";
    let runner = MockRunner::spawn(model).await;

    let shared_cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_sleeping_oip_model(&shared_cache, model).await;

    let cp = MockControlPlaneBuilder::new()
        .on_wake_activate(model, runner.addr, shared_cache.clone(), Duration::from_millis(50))
        .spawn()
        .await;
    let cp_url = format!("http://{}", cp.addr);

    let proxy = TestProxy::spawn_with_shared_cache(&cp_url, shared_cache).await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/oip/v2/models/{model}/infer", proxy.proxy_url()))
        .json(&serde_json::json!({"inputs": []}))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::OK, "proxy should park, wait for wake, then forward");
    assert_eq!(cp.wake_count_for(model).await, 1, "expected exactly one wake trigger");
    assert_eq!(runner.request_count(), 1);
}

#[tokio::test]
async fn oip_infer_unknown_404() {
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;
    // Routing map is empty — no models registered.

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/oip/v2/models/ghost/infer", proxy.proxy_url()))
        .json(&serde_json::json!({"inputs": []}))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["error"]["type"], "model_not_found");
}

#[tokio::test]
async fn oip_ready_active_forwards() {
    let model = "iris-sklearn";
    let runner = MockRunner::spawn(model).await;
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;
    insert_active_oip_model(&proxy.routing_cache, model, runner.addr).await;

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/oip/v2/models/{model}/ready", proxy.proxy_url()))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::OK, "active oip model's readiness probe should forward");
    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["ready"], true, "runner's ready route should have been hit");
}

#[tokio::test]
async fn oip_ready_sleeping_503_no_wake() {
    let model = "sentiment-hf";
    let runner = MockRunner::spawn(model).await;

    let shared_cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_sleeping_oip_model(&shared_cache, model).await;

    let cp = MockControlPlaneBuilder::new().spawn().await;
    let cp_url = format!("http://{}", cp.addr);
    let proxy = TestProxy::spawn_with_shared_cache(&cp_url, shared_cache).await;

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/oip/v2/models/{model}/ready", proxy.proxy_url()))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE, "sleeping model's ready must be 503");
    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["ready"], false);

    assert_eq!(cp.wake_count_for(model).await, 0, "readiness probe must NOT trigger a wake");
    assert_eq!(runner.request_count(), 0, "readiness probe on a sleeping model must not forward");
}

#[tokio::test]
async fn oip_ready_unknown_404() {
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/oip/v2/models/ghost/ready", proxy.proxy_url()))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn oip_models_lists_only_oip() {
    let active_oip = "iris-sklearn";
    let sleeping_oip = "sentiment-hf";
    let active_openai = "meta-llama/Llama-3.1-8B-Instruct";

    let runner = MockRunner::spawn(active_oip).await;
    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;

    insert_active_oip_model(&proxy.routing_cache, active_oip, runner.addr).await;
    insert_sleeping_oip_model(&proxy.routing_cache, sleeping_oip).await;
    insert_active_model(&proxy.routing_cache, active_openai, runner.addr).await;

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/oip/v2/models", proxy.proxy_url()))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::OK);
    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    let models = body["models"].as_array().expect("models should be array");

    let by_name = |name: &str| models.iter().find(|m| m["name"] == name);

    let active_entry = by_name(active_oip).expect("active oip model missing from /oip/v2/models");
    assert_eq!(active_entry["ready"], true);

    let sleeping_entry = by_name(sleeping_oip).expect("sleeping oip model missing from /oip/v2/models");
    assert_eq!(sleeping_entry["ready"], false);

    assert!(by_name(active_openai).is_none(), "openai-protocol model must NOT appear under /oip");
}
