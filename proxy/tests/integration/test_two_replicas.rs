// Two proxy replicas against one control plane (#330).
//
// Parking and thundering-herd suppression are per replica (ADR-007: the proxy
// stays stateless, no cross-replica coordination), so two replicas each fire one
// wake trigger for the same sleeping model. The control plane must dedupe those
// two triggers — proven CP-side in
// `control-plane/src/__tests__/integration/sleep-wake.integration.test.ts`
// ("two concurrent internal wake triggers dedupe to one wake"). #303 made the
// loser of the concurrent CAS a benign 202, so neither replica's parked herd
// fast-fails; these cases prove the proxy half of that outcome.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use reqwest::StatusCode;

use crate::common::proxy_builder::TestProxyConfig;
use crate::common::{insert_sleeping_model, MockControlPlaneBuilder, MockRunner, TestProxy};

/// Fire `count` concurrent requests for `model` at `proxy_url` and count the
/// 200s.
fn fire_requests(
    client: Arc<reqwest::Client>,
    proxy_url: String,
    model: &'static str,
    count: usize,
    success_count: Arc<AtomicUsize>,
) -> Vec<tokio::task::JoinHandle<()>> {
    (0..count)
        .map(|_| {
            let client = client.clone();
            let url = proxy_url.clone();
            let count = success_count.clone();
            tokio::spawn(async move {
                let resp = client
                    .post(format!("{url}/openai/v1/chat/completions"))
                    .json(&serde_json::json!({
                        "model": model,
                        "messages": [{"role": "user", "content": "Hi"}]
                    }))
                    .timeout(Duration::from_secs(10))
                    .send()
                    .await
                    .expect("request failed");

                if resp.status() == StatusCode::OK {
                    count.fetch_add(1, Ordering::Relaxed);
                }
            })
        })
        .collect()
}

/// Every parked request on both replicas is served, and each replica fires
/// exactly one wake trigger for the same sleeping model: per-replica herd
/// suppression holds (the count is 2, not 2 + N + M), and the control plane
/// dedupes the two triggers into one wake.
#[tokio::test]
async fn two_replicas_each_fire_one_wake_and_all_parked_served() {
    const PER_REPLICA: usize = 5;
    let model = "meta-llama/Llama-3.1-70B-Instruct";

    let runner = MockRunner::spawn(model).await;
    let shared_cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_sleeping_model(&shared_cache, model).await;

    // The control plane activates the model after 200 ms — long enough that
    // every concurrent request is parked and each replica has fired its
    // trigger before the model becomes routable.
    let cp = MockControlPlaneBuilder::new()
        .on_wake_activate(model, runner.addr, shared_cache.clone(), Duration::from_millis(200))
        .spawn()
        .await;
    let cp_url = format!("http://{}", cp.addr);

    let proxy_a = TestProxy::spawn_with_shared_cache(&cp_url, shared_cache.clone()).await;
    let proxy_b = TestProxy::spawn_with_shared_cache(&cp_url, shared_cache.clone()).await;

    let client = Arc::new(reqwest::Client::new());
    let success_count = Arc::new(AtomicUsize::new(0));

    let mut handles = fire_requests(
        client.clone(),
        proxy_a.proxy_url(),
        model,
        PER_REPLICA,
        success_count.clone(),
    );
    handles.extend(fire_requests(
        client,
        proxy_b.proxy_url(),
        model,
        PER_REPLICA,
        success_count.clone(),
    ));
    for handle in handles {
        handle.await.unwrap();
    }

    assert_eq!(
        success_count.load(Ordering::Relaxed),
        PER_REPLICA * 2,
        "every parked request on both replicas must be served"
    );

    // Exactly one trigger per replica: the herd is suppressed within a process
    // and nowhere else — deduplicating the two triggers is the control plane's
    // job (#303's benign-202 path is why both herds survive it).
    assert_eq!(
        cp.wake_count_for(model).await,
        2,
        "expected exactly one wake trigger per replica, not one per request and not one in total"
    );

    assert_eq!(
        runner.request_count(),
        PER_REPLICA * 2,
        "every request must reach the runner after the wake"
    );
}

/// Parking limits are per replica: one parked request on each replica is
/// admitted under `parking_max_per_model: 1`, and the second request to the
/// same replica is rejected — accounting neither shares nor double-counts.
#[tokio::test]
async fn parking_limits_are_per_replica() {
    let model = "limited-model/v1";
    let cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_sleeping_model(&cache, model).await;

    // A control plane that never wakes (no `on_wake_activate`), so both parked
    // requests stay parked until their parking timeout.
    let cp = MockControlPlaneBuilder::new().spawn().await;
    let cp_url = format!("http://{}", cp.addr);

    let cfg = || TestProxyConfig {
        control_plane_url: cp_url.clone(),
        parking_max_per_model: 1,
        parking_timeout: Duration::from_secs(30),
        ..Default::default()
    };

    let proxy_a = TestProxy::spawn_with_shared_cache_and_config(cfg(), cache.clone()).await;
    let proxy_b = TestProxy::spawn_with_shared_cache_and_config(cfg(), cache.clone()).await;

    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "Hi"}]
    });

    // One parked request per replica — both must be admitted: each replica
    // counts only its own single parked request.
    let mut parked = Vec::new();
    for proxy_url in [proxy_a.proxy_url(), proxy_b.proxy_url()] {
        let client = client.clone();
        let payload = payload.clone();
        parked.push(tokio::spawn(async move {
            let _ = client
                .post(format!("{proxy_url}/openai/v1/chat/completions"))
                .json(&payload)
                .timeout(Duration::from_secs(35))
                .send()
                .await;
        }));
    }

    // Give the parked requests a moment to register.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // A second request to the same replica exceeds that replica's limit.
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy_a.proxy_url()))
        .json(&payload)
        .send()
        .await
        .expect("request failed");
    assert_eq!(
        resp.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "the second parked request on one replica must be rejected"
    );
    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["error"]["type"], "parking_limit_reached");

    // The other replica's single parked request is unaffected.
    assert!(
        !parked[1].is_finished(),
        "proxy B's parked request must still be waiting; limits are per replica"
    );

    // Clean up: abort the parked tasks so the test doesn't hang.
    for handle in parked {
        handle.abort();
    }
}
