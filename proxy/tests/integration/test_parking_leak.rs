// Parking slot + gauge leak regression tests (#92).
//
// ParkingManager::park() used to increment global/per-model counters and the
// parked-connections gauge, then rely on code running *after* an `.await`
// to release them. When the client disconnects mid-park, axum drops the
// handler future and that release code never runs, leaking the slot and
// gauge for the process lifetime. The fix moves release accounting into the
// `Drop` impl of `ParkingSlotGuard` so a slot is reclaimed even when the
// handler future is cancelled.

use std::time::Duration;

use reqwest::StatusCode;

use crate::common::proxy_builder::TestProxyConfig;
use crate::common::{insert_sleeping_model, MockControlPlaneBuilder, MockRunner, TestProxy};

/// Poll `f` until it returns `true` or `timeout` elapses, returning the last
/// observed value.
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

#[tokio::test]
async fn test_disconnect_reclaims_parking_slot() {
    let cache = sardeenz_proxy::routing::RoutingMapCache::new();
    let model = "leak-test-model/v1";
    insert_sleeping_model(&cache, model).await;

    // No on_wake_activate configured: the model stays Sleeping forever, so
    // parked requests block until aborted or until parking_timeout fires.
    let cp = MockControlPlaneBuilder::new().spawn().await;

    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: format!("http://{}", cp.addr),
            parking_timeout: Duration::from_secs(30),
            parking_max_per_model: 3,
            parking_max_global: 100,
            ..Default::default()
        },
        cache,
    )
    .await;

    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "Hello"}]
    });

    // Fire 3 background requests that park and never complete.
    let mut handles = Vec::new();
    for _ in 0..3 {
        let c = client.clone();
        let url = format!("{}/v1/chat/completions", proxy.proxy_url());
        let p = payload.clone();
        handles.push(tokio::spawn(async move { c.post(url).json(&p).send().await }));
    }

    // Wait for all 3 slots to register.
    assert!(
        poll_until(|| proxy.parking.global_parked_count() == 3, Duration::from_secs(5)).await,
        "expected 3 parked connections, got {}",
        proxy.parking.global_parked_count()
    );

    // Simulate client disconnect by aborting the in-flight request futures.
    for h in handles {
        h.abort();
    }

    // The slots must be reclaimed even though the handler futures were
    // cancelled mid-park (never reached their tail release code).
    assert!(
        poll_until(|| proxy.parking.global_parked_count() == 0, Duration::from_secs(5)).await,
        "parking slots leaked after disconnect: global_parked_count = {}",
        proxy.parking.global_parked_count()
    );

    // A fresh request should be able to park again — it must NOT be
    // rejected with parking_limit_reached, which would indicate the slots
    // were never actually reclaimed. Use a short client-side timeout since
    // the model never wakes: parking_limit_reached is a synchronous, fast
    // rejection, whereas actually parking will hang past this timeout and
    // the client will time out first (which itself proves the slot was
    // available). A parking_timeout 503 (if it were to happen to land in
    // time) is also acceptable — the assertion is on error TYPE only.
    let result = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url()))
        .json(&payload)
        .timeout(Duration::from_millis(500))
        .send()
        .await;

    match result {
        Err(_) => {
            // Client-side timeout: the proxy did not immediately reject the
            // request, i.e. it was not at the parking limit.
        }
        Ok(resp) => {
            let status = resp.status();
            let body: serde_json::Value = resp.json().await.expect("response not JSON");
            assert_ne!(
                body["error"]["type"], "parking_limit_reached",
                "fresh request was rejected as parking_limit_reached (status {status}); slots were not reclaimed"
            );
        }
    }
}

#[tokio::test]
async fn test_global_counter_no_underflow_after_cycles() {
    let cache = sardeenz_proxy::routing::RoutingMapCache::new();

    // Small global limit: if the counter leaked (over- or under-counted)
    // across cycles, a later cycle would spuriously hit the limit.
    const CYCLES: usize = 5;
    const MAX_GLOBAL: usize = 2;

    let mut runners = Vec::new();
    let mut cp_builder = MockControlPlaneBuilder::new();
    let models: Vec<String> = (0..CYCLES).map(|i| format!("cycle-model-{i}/v1")).collect();

    for model in &models {
        insert_sleeping_model(&cache, model).await;
        let runner = MockRunner::spawn(model).await;
        cp_builder = cp_builder.on_wake_activate(
            model,
            runner.addr,
            cache.clone(),
            Duration::from_millis(20),
        );
        runners.push(runner);
    }

    let cp = cp_builder.spawn().await;

    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: format!("http://{}", cp.addr),
            parking_timeout: Duration::from_secs(10),
            parking_max_per_model: MAX_GLOBAL,
            parking_max_global: MAX_GLOBAL,
            ..Default::default()
        },
        cache,
    )
    .await;

    let client = reqwest::Client::new();

    // Run park cycles sequentially to completion (not concurrently), so
    // each cycle fully increments then decrements the global counter.
    for model in &models {
        let resp = client
            .post(format!("{}/v1/chat/completions", proxy.proxy_url()))
            .json(&serde_json::json!({
                "model": model,
                "messages": [{"role": "user", "content": "Hi"}]
            }))
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .expect("request failed");

        assert_eq!(resp.status(), StatusCode::OK, "cycle for {model} did not complete");
    }

    assert_eq!(
        proxy.parking.global_parked_count(),
        0,
        "global parked count did not return to 0 after sequential cycles (underflow/leak)"
    );

    // A fresh park attempt must not be immediately rejected as
    // parking_limit_reached — the counter must have unwound correctly.
    let extra_model = "cycle-model-extra/v1";
    insert_sleeping_model(&proxy.routing_cache, extra_model).await;

    let resp = client
        .post(format!("{}/v1/chat/completions", proxy.proxy_url()))
        .json(&serde_json::json!({
            "model": extra_model,
            "messages": [{"role": "user", "content": "Hi"}]
        }))
        .timeout(Duration::from_millis(500))
        .send()
        .await;

    // No wake action registered for extra_model, so this will time out
    // waiting for activation — the important assertion is that it is NOT
    // rejected as parking_limit_reached.
    if let Ok(resp) = resp {
        let body: serde_json::Value = resp.json().await.expect("response not JSON");
        assert_ne!(body["error"]["type"], "parking_limit_reached");
    }
}
