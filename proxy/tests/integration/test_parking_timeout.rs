// test_parking_timeout_503: if the model does not become Active within the
// parking timeout, the proxy returns 503.

use std::sync::Arc;
use std::time::Duration;

use reqwest::StatusCode;

use crate::common::proxy_builder::TestProxyConfig;
use crate::common::{insert_sleeping_model, MockControlPlaneBuilder, TestProxy};

#[tokio::test]
async fn test_parking_timeout_503() {
    let model = "slow-model/never-wakes";

    let shared_cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_sleeping_model(&shared_cache, model).await;

    // The control plane accepts the wake but never updates the routing map,
    // so the model stays in Sleeping state forever.
    let cp = MockControlPlaneBuilder::new()
        // No on_wake_activate — wake is acknowledged but model stays sleeping.
        .spawn()
        .await;

    let cp_url = format!("http://{}", cp.addr);

    // Use a very short parking timeout so the test completes quickly.
    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: cp_url,
            parking_timeout: Duration::from_millis(200),
            ..Default::default()
        },
        shared_cache,
    )
    .await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url()))
        .json(&serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "Are you there?"}]
        }))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .expect("request failed");

    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE, "parking timeout should return 503");

    let body: serde_json::Value = resp.json().await.expect("response not JSON");
    assert_eq!(body["error"]["type"], "parking_timeout", "error type should be parking_timeout");
}

/// Poll a synchronous predicate until it is true or `timeout` elapses.
/// Returns the last observed value of the predicate.
async fn poll_until<F: Fn() -> bool>(f: F, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if f() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

// test_parking_rewakes_after_concurrent_mass_cancel: when the entire herd of
// parked requests for a model is CANCELLED (client disconnects) while the
// requests are still parked — not timed out — the pending_wakes entry must
// be cleared so a subsequent request re-fires the wake trigger instead of
// deduping against a stale entry.
//
// A deliberately long parking_timeout ensures the timeout branch can never
// fire during this test: the ONLY code path that can clear pending_wakes
// here is ParkingSlotGuard::Drop running on cancellation (#94). Before #94,
// that Drop only ran the RAII slot/gauge release (#92); the herd-dedup entry
// itself was cleared solely on the timeout branch of do_park, so a cancelled
// (never-timed-out) herd left pending_wakes orphaned forever and a fresh
// request would dedup against the stale entry instead of re-firing the wake.
#[tokio::test]
async fn test_parking_rewakes_after_concurrent_mass_cancel() {
    const CONCURRENT_REQUESTS: usize = 3;
    let model = "slow-model/never-wakes";

    let shared_cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_sleeping_model(&shared_cache, model).await;

    // No on_wake_activate — wake is acknowledged but the model stays asleep
    // forever, so parked requests block until they are cancelled.
    let cp = MockControlPlaneBuilder::new().spawn().await;
    let cp_url = format!("http://{}", cp.addr);

    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: cp_url,
            // Long enough that none of the parked requests can time out
            // during this test — the only way pending_wakes can clear here
            // is via ParkingSlotGuard::Drop on cancellation.
            parking_timeout: Duration::from_secs(30),
            ..Default::default()
        },
        shared_cache,
    )
    .await;

    let proxy_url = proxy.proxy_url();
    let client = Arc::new(reqwest::Client::new());

    // Fire N concurrent requests that park and are left to hang (no
    // client-side timeout — they must remain parked, not time out, until
    // they are cancelled below).
    let mut handles = Vec::new();
    for _ in 0..CONCURRENT_REQUESTS {
        let client = client.clone();
        let url = proxy_url.clone();
        let model_name = model.to_string();
        handles.push(tokio::spawn(async move {
            let _ = client
                .post(format!("{url}/v1/chat/completions"))
                .json(&serde_json::json!({
                    "model": model_name,
                    "messages": [{"role": "user", "content": "Are you there?"}]
                }))
                .send()
                .await;
        }));
    }

    // Wait until all N requests are actually parked...
    assert!(
        poll_until(
            || proxy.parking.global_parked_count() == CONCURRENT_REQUESTS,
            Duration::from_secs(5)
        )
        .await,
        "expected {CONCURRENT_REQUESTS} parked connections, got {}",
        proxy.parking.global_parked_count()
    );

    // ...and that the herd has deduped down to exactly one wake trigger,
    // before cancelling anything.
    let mut wake_count = 0;
    for _ in 0..250 {
        wake_count = cp.wake_count_for(model).await;
        if wake_count >= 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(wake_count, 1, "the initial herd should fire exactly one wake trigger");

    // Cancel all N in-flight requests: aborting the JoinHandle drops the
    // reqwest future, which closes the client connection; axum then drops
    // the parked handler future, running ParkingSlotGuard::Drop. This is
    // the cancellation-safety property #92/#94 rely on.
    for handle in handles {
        handle.abort();
    }

    // Wait for all guards to have dropped. global_parked_count() reaching 0
    // is a precise signal here (not a blind sleep): ParkingSlotGuard::Drop
    // decrements the global/per-model counters and clears pending_wakes (if
    // this was the last parked request) synchronously in the same Drop
    // call, so by the time the count reads 0 the last guard's pending_wakes
    // cleanup has already run too.
    assert!(
        poll_until(|| proxy.parking.global_parked_count() == 0, Duration::from_secs(5)).await,
        "parked connections did not reach 0 after cancellation, got {}",
        proxy.parking.global_parked_count()
    );

    // Fire one fresh request for the same model. It will park again (the
    // model still never wakes), so bound it with a short client timeout —
    // we only care whether it re-fires the wake trigger, not that it
    // completes.
    let fresh_client = client.clone();
    let fresh_url = proxy_url.clone();
    let fresh_model = model.to_string();
    tokio::spawn(async move {
        let _ = fresh_client
            .post(format!("{fresh_url}/v1/chat/completions"))
            .json(&serde_json::json!({
                "model": fresh_model,
                "messages": [{"role": "user", "content": "Still there?"}]
            }))
            .timeout(Duration::from_secs(2))
            .send()
            .await;
    });

    let mut final_wake_count = wake_count;
    for _ in 0..250 {
        final_wake_count = cp.wake_count_for(model).await;
        if final_wake_count >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    assert_eq!(
        final_wake_count,
        2,
        "after cancelling the entire parked herd the pending_wakes entry must be cleared so a \
         new request re-fires the wake (got {final_wake_count})"
    );
}
