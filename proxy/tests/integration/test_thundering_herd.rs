// test_thundering_herd: N concurrent requests to a sleeping model should
// result in exactly ONE wake trigger being sent to the control plane, not N.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use reqwest::StatusCode;

use crate::common::{insert_sleeping_model, MockControlPlaneBuilder, MockRunner, TestProxy};

#[tokio::test]
async fn test_thundering_herd() {
    const CONCURRENT_REQUESTS: usize = 20;
    let model = "meta-llama/Llama-3.1-70B-Instruct";

    let runner = MockRunner::spawn(model).await;
    let shared_cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_sleeping_model(&shared_cache, model).await;

    // The control plane waits a bit before activating the model — long enough
    // that all concurrent requests will be parked before the wake completes.
    let cp = MockControlPlaneBuilder::new()
        .on_wake_activate(model, runner.addr, shared_cache.clone(), Duration::from_millis(200))
        .spawn()
        .await;

    let cp_url = format!("http://{}", cp.addr);
    let proxy = TestProxy::spawn_with_shared_cache(&cp_url, shared_cache).await;

    let proxy_url = proxy.proxy_url();
    let client = Arc::new(reqwest::Client::new());

    // Fire all requests concurrently.
    let success_count = Arc::new(AtomicUsize::new(0));
    let mut handles = Vec::new();

    for _ in 0..CONCURRENT_REQUESTS {
        let client = client.clone();
        let url = proxy_url.clone();
        let model_name = model.to_string();
        let count = success_count.clone();

        handles.push(tokio::spawn(async move {
            let resp = client
                .post(format!("{url}/openai/v1/chat/completions"))
                .json(&serde_json::json!({
                    "model": model_name,
                    "messages": [{"role": "user", "content": "Hi"}]
                }))
                .timeout(Duration::from_secs(10))
                .send()
                .await
                .expect("request failed");

            if resp.status() == StatusCode::OK {
                count.fetch_add(1, Ordering::Relaxed);
            }
        }));
    }

    for handle in handles {
        handle.await.unwrap();
    }

    // All requests should have succeeded.
    assert_eq!(
        success_count.load(Ordering::Relaxed),
        CONCURRENT_REQUESTS,
        "all concurrent requests should succeed"
    );

    // Exactly ONE wake trigger must have been sent — the thundering-herd
    // deduplication in ParkingManager ensures this.
    assert_eq!(
        cp.wake_count_for(model).await,
        1,
        "thundering herd: expected exactly one wake trigger for {CONCURRENT_REQUESTS} concurrent requests"
    );

    // The runner should have received all requests.
    assert_eq!(runner.request_count(), CONCURRENT_REQUESTS);
}
