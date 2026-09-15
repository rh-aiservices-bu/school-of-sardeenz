// test_sleeping_model_wakes: when a model is sleeping, the proxy parks the
// request, fires a wake trigger to the control plane, then forwards once the
// model transitions to Active.

use std::time::Duration;

use reqwest::StatusCode;

use crate::common::{insert_sleeping_model, MockControlPlaneBuilder, MockRunner, TestProxy};

#[tokio::test]
async fn test_sleeping_model_wakes() {
    let model = "openai/gpt2";

    // Runner is ready to serve immediately once woken.
    let runner = MockRunner::spawn(model).await;

    // Build the proxy first so we have a routing cache reference.
    // Use a temporary control-plane URL — we'll create the real CP after.
    // Actually: we need the CP URL before building the proxy (so the proxy's
    // WakeTriggerClient points at the right place).
    //
    // Strategy: bind the CP listener first to get its port, then build the
    // proxy pointing at that port, then spawn the CP handler.
    //
    // Simpler: spawn the CP with a placeholder cache, then give the proxy the
    // same cache the CP uses — but the CP gets its cache at spawn time.
    //
    // Cleanest: spawn a throw-away listener to reserve the port, build the
    // proxy, then spawn the CP on that reserved port.
    //
    // We use the two-step approach: create a shared RoutingMapCache, build the
    // CP referencing it, then build the proxy sharing that same cache via the
    // RoutingMapCache's Clone impl (they share the inner Arc<RwLock>).

    // Step 1: create the shared routing cache.
    let shared_cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_sleeping_model(&shared_cache, model).await;

    // Step 2: spawn the control plane, giving it the shared cache so it can
    // transition the model to Active when the wake fires.
    let cp = MockControlPlaneBuilder::new()
        .on_wake_activate(
            model,
            runner.addr,
            shared_cache.clone(),
            Duration::from_millis(50), // slight delay to simulate startup
        )
        .spawn()
        .await;

    let cp_url = format!("http://{}", cp.addr);

    // Step 3: spawn the proxy using the same shared cache.
    let proxy = TestProxy::spawn_with_shared_cache(&cp_url, shared_cache).await;

    // Send a request. The proxy should park, detect the model is sleeping,
    // fire a wake trigger, wait for the routing map to become Active, then
    // forward.
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .json(&serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "Wake up!"}]
        }))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::OK, "proxy should park, wait for wake, then forward");

    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["object"], "chat.completion");

    // The control plane must have received exactly one wake trigger.
    assert_eq!(cp.wake_count_for(model).await, 1, "expected exactly one wake trigger");

    // The runner must have served exactly one request.
    assert_eq!(runner.request_count(), 1);
}
