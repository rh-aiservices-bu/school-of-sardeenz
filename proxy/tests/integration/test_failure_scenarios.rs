// Failure scenarios (#340), proxy half.
//
// The control-plane half (`failure-scenarios.integration.test.ts`) can observe a Redis loss and a
// stranded wake through its stores; what it cannot observe is what a *caller* sees. These cases
// cover that: a lost routing state fails requests cleanly and recovers, a parked caller learns the
// model errored instead of waiting out the parking timeout, two replicas on one shared cache each
// fire their own trigger and both herds still resolve (the outcome #303's benign-202 CP fix
// restores), and a dropped replica's cache keeps serving through the survivor.
//
// No real Redis: the routing map is an in-process `RoutingMapCache` (the Redis-backed suite stays
// behind the `redis-integration` feature), and D10's "Redis loss" is modelled by flipping the same
// `AppState` flags the production Redis-sync task flips.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::StatusCode;

use sardeenz_proxy::generated::proxy_control_plane::{ModelState, Protocol};

use crate::common::proxy_builder::TestProxyConfig;
use crate::common::{
    insert_active_model, insert_model, insert_sleeping_model, MockControlPlaneBuilder, MockRunner,
    TestProxy,
};

/// Poll `proxy.parking.global_parked_count()` until it equals `n` or `timeout` elapses.
async fn poll_parked(proxy: &TestProxy, n: usize, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if proxy.parking.global_parked_count() == n {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Poll `cond` until it holds, panicking with `what` when `timeout` expires.
async fn wait_until(timeout: Duration, what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn chat_payload(model: &str) -> serde_json::Value {
    serde_json::json!({"model": model, "messages":[{"role":"user","content":"hi"}]})
}

/// Assert the proxy's `model_unavailable` envelope is clean: no 500, no hang.
fn assert_clean_503(body: &serde_json::Value, must_mention: &str) {
    assert_eq!(body["error"]["type"], "model_unavailable", "unexpected error body: {body}");
    let message = body["error"]["message"].as_str().unwrap_or("");
    assert!(
        message.contains(must_mention),
        "expected message to mention {must_mention:?}, got: {message}"
    );
}

/// A Redis loss (real or simulated) must fail inference with the same clean
/// `model_unavailable` 503 — never a hang or a 500 — on both the entry check (routing state not
/// loaded) and the post-lease recheck (`redis_connected` flipped mid-flight), and both recover as
/// soon as the flag is restored.
#[tokio::test]
async fn routing_state_loss_returns_clean_503_and_recovers() {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().unwrap();

    // Arm A — before the routing map is loaded (fresh replica / lost Redis before the first load).
    let model_a = "loss/model-not-loaded";
    let runner_a = MockRunner::spawn(model_a).await;
    let cache_a = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_active_model(&cache_a, model_a, runner_a.addr).await;

    let proxy_a = TestProxy::spawn_with_shared_cache("http://127.0.0.1:1", cache_a.clone()).await;
    proxy_a.set_routing_map_loaded(false);

    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy_a.proxy_url()))
        .json(&chat_payload(model_a))
        .send()
        .await
        .expect("request failed");
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_clean_503(&resp.json().await.unwrap(), "routing state is not connected");
    assert_eq!(runner_a.request_count(), 0, "a not-ready replica must not forward");

    proxy_a.set_routing_map_loaded(true);
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy_a.proxy_url()))
        .json(&chat_payload(model_a))
        .send()
        .await
        .expect("request failed");
    assert_eq!(resp.status(), StatusCode::OK, "a restored routing state must serve again");
    assert_eq!(runner_a.request_count(), 1);

    // Arm B — the connection drops after the entry check but before the routing lease is taken:
    // the race the post-lease recheck (`handlers.rs:374`) closes. A request is parked on a SLEEPING
    // model (so it has already passed the entry admission check), `redis_connected` flips while it
    // is parked, and only then does the model activate in the shared cache. The parked request
    // resumes, takes its routing lease and must be declined by the recheck — not forwarded on the
    // pre-disconnect route. The response shape discriminates the paths: a recheck decline is
    // `model_unavailable` / "routing state is not connected", a parking timeout is
    // `parking_timeout`, and carried-through forwarding would be a 200 from `runner_b`.
    let model_b = "loss/model-redis-gone";
    let runner_b = MockRunner::spawn(model_b).await;
    let cache_b = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_sleeping_model(&cache_b, model_b).await;
    // A control plane that accepts the wake trigger and never activates: the activation below is
    // ours, so it happens strictly after the flag flip. A sentinel URL would fail the trigger and
    // fast-fail the parked request with the wrong message.
    let cp_b = MockControlPlaneBuilder::new().spawn().await;
    let proxy_b = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: format!("http://{}", cp_b.addr),
            parking_timeout: Duration::from_secs(10),
            ..Default::default()
        },
        cache_b.clone(),
    )
    .await;

    let client_b =
        Arc::new(reqwest::Client::builder().timeout(Duration::from_secs(9)).build().unwrap());
    let parked_b = tokio::spawn({
        let client = client_b.clone();
        let url = proxy_b.proxy_url();
        let model = model_b.to_string();
        async move {
            client
                .post(format!("{url}/openai/v1/chat/completions"))
                .json(&chat_payload(&model))
                .send()
                .await
        }
    });
    assert!(
        poll_parked(&proxy_b, 1, Duration::from_secs(5)).await,
        "the request never parked, so the entry check was never passed"
    );

    // Redis is lost while the request waits; it has already been admitted at the entry check.
    proxy_b.set_redis_connected(false);
    let resumed = Instant::now();
    insert_active_model(&cache_b, model_b, runner_b.addr).await;

    let resp = parked_b.await.unwrap().expect("request failed");
    let elapsed = resumed.elapsed();
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_clean_503(&resp.json().await.unwrap(), "routing state is not connected");
    assert_eq!(
        runner_b.request_count(),
        0,
        "a request declined by the post-lease recheck must not forward on the stale route"
    );
    assert!(
        elapsed < Duration::from_secs(1),
        "the 503 must come from the recheck when the wake completes, not from the parking \
         timeout; took {elapsed:?} (parking_timeout is 10s)"
    );

    // The same disconnect also refuses a request that arrives *after* it, at the entry check —
    // the recheck is only reachable for requests admitted before the flip.
    let resp = client_b
        .post(format!("{}/openai/v1/chat/completions", proxy_b.proxy_url()))
        .json(&chat_payload(model_b))
        .send()
        .await
        .expect("request failed");
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_clean_503(&resp.json().await.unwrap(), "routing state is not connected");
    assert_eq!(runner_b.request_count(), 0, "model B must not have served anything");

    proxy_b.set_redis_connected(true);
    let resp = client_b
        .post(format!("{}/openai/v1/chat/completions", proxy_b.proxy_url()))
        .json(&chat_payload(model_b))
        .send()
        .await
        .expect("request failed");
    assert_eq!(resp.status(), StatusCode::OK, "reconnect must restore service");
    assert_eq!(runner_b.request_count(), 1, "exactly the post-reconnect request is forwarded");
}

/// Scenario 2/3's caller-visible half: when the model the caller parked on reaches the error
/// state, the parked request gets a defined 503 immediately — it must not sit out the parking
/// timeout, and it must not be answered with a different failure shape.
#[tokio::test]
async fn parked_request_fast_fails_when_model_errors() {
    let model = "loss/model-errors";
    let addr: SocketAddr = "127.0.0.1:1".parse().unwrap();
    let cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_sleeping_model(&cache, model).await;

    // A control plane that accepts the wake trigger and never activates: the request stays parked
    // until the error state arrives (a sentinel URL would fail the trigger and fast-fail with the
    // wrong message).
    let cp = MockControlPlaneBuilder::new().spawn().await;
    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: format!("http://{}", cp.addr),
            parking_timeout: Duration::from_secs(10),
            ..Default::default()
        },
        cache.clone(),
    )
    .await;

    let client =
        Arc::new(reqwest::Client::builder().timeout(Duration::from_secs(9)).build().unwrap());
    let url = proxy.proxy_url();
    let m = model.to_string();
    let c = client.clone();
    let handle = tokio::spawn(async move {
        c.post(format!("{url}/openai/v1/chat/completions")).json(&chat_payload(&m)).send().await
    });

    assert!(poll_parked(&proxy, 1, Duration::from_secs(5)).await, "request never parked");

    let start = Instant::now();
    insert_model(&cache, model, ModelState::Error, Protocol::Openai, addr).await;

    let resp = handle.await.unwrap().expect("request failed");
    let elapsed = start.elapsed();
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_clean_503(&resp.json().await.unwrap(), "error state");
    assert!(
        elapsed < Duration::from_secs(1),
        "fast-fail expected; took {elapsed:?} (parking_timeout is 10s — unfixed code would wait it out)"
    );
}

/// Two replicas, one shared cache, one wake-able model: each replica fires its own trigger (herd
/// suppression is per process by design — ADR-007, no cross-replica state) and **both** herds
/// resolve 200 once the model activates. The aborted-herd failure mode is what #303's benign-202
/// control-plane fix removes. "Exactly one wake executes" is the control plane's claim and is
/// asserted in the CP half (scenario 4a), not here.
#[tokio::test]
async fn two_proxies_one_cache_each_fires_own_trigger_both_herds_resolve() {
    let model = "loss/two-replicas";
    let runner = MockRunner::spawn(model).await;
    let shared_cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_sleeping_model(&shared_cache, model).await;

    // Activates after 200 ms — long enough that both replicas have parked and fired.
    let cp = MockControlPlaneBuilder::new()
        .on_wake_activate(model, runner.addr, shared_cache.clone(), Duration::from_millis(200))
        .spawn()
        .await;
    let cp_url = format!("http://{}", cp.addr);

    let proxy_a = TestProxy::spawn_with_shared_cache(&cp_url, shared_cache.clone()).await;
    let proxy_b = TestProxy::spawn_with_shared_cache(&cp_url, shared_cache.clone()).await;

    let client =
        Arc::new(reqwest::Client::builder().timeout(Duration::from_secs(10)).build().unwrap());
    let spawn_request = |url: String| {
        let client = client.clone();
        let model = model.to_string();
        tokio::spawn(async move {
            client
                .post(format!("{url}/openai/v1/chat/completions"))
                .json(&chat_payload(&model))
                .send()
                .await
        })
    };

    let handle_a = spawn_request(proxy_a.proxy_url());
    let handle_b = spawn_request(proxy_b.proxy_url());

    assert!(poll_parked(&proxy_a, 1, Duration::from_secs(5)).await, "replica A never parked");
    assert!(poll_parked(&proxy_b, 1, Duration::from_secs(5)).await, "replica B never parked");

    let resp_a = handle_a.await.unwrap().expect("replica A request failed");
    let resp_b = handle_b.await.unwrap().expect("replica B request failed");
    assert_eq!(resp_a.status(), StatusCode::OK, "replica A's herd must resolve, not abort");
    assert_eq!(resp_b.status(), StatusCode::OK, "replica B's herd must resolve, not abort");

    // One trigger per replica — two total. Not one: deduplicating them is the control plane's job.
    assert_eq!(cp.total_wakes(), 2, "each replica must send its own wake trigger");
    assert!(runner.request_count() >= 1, "the activated model must serve the parked request");
}

/// A killed replica must not take the shared cache (or the survivor) down with it: after
/// `shutdown()` aborts the accept loop, a fresh request through the surviving replica is served.
///
/// A real pod death or node loss is cluster-only (deferred with #330's cluster-only list); this
/// models the kill in-process. The dropped replica's own in-flight request is deliberately not
/// asserted — axum's per-connection tasks are not aborted, so its outcome is the client's
/// timeout, not the platform's behaviour.
#[tokio::test]
async fn survivor_serves_after_replica_drop() {
    let model = "loss/survivor";
    let runner = MockRunner::spawn(model).await;
    let shared_cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_sleeping_model(&shared_cache, model).await;

    let cp = MockControlPlaneBuilder::new()
        .on_wake_activate(model, runner.addr, shared_cache.clone(), Duration::from_millis(300))
        .spawn()
        .await;
    let cp_url = format!("http://{}", cp.addr);

    let mut proxy_1 = TestProxy::spawn_with_shared_cache(&cp_url, shared_cache.clone()).await;
    let proxy_2 = TestProxy::spawn_with_shared_cache(&cp_url, shared_cache.clone()).await;

    let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().unwrap();
    let dropped_request = tokio::spawn({
        let client = client.clone();
        let url = proxy_1.proxy_url();
        let model = model.to_string();
        async move {
            client
                .post(format!("{url}/openai/v1/chat/completions"))
                .json(&chat_payload(&model))
                .send()
                .await
        }
    });

    assert!(poll_parked(&proxy_1, 1, Duration::from_secs(5)).await, "request never parked");

    // Kill replica 1 while its request waits for the wake its own trigger started.
    proxy_1.shutdown().await;

    // The wake it triggered still activates the model in the cache everyone shares.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let active = shared_cache
            .get(model)
            .await
            .map(|entry| entry.state == ModelState::Active)
            .unwrap_or(false);
        if active {
            break;
        }
        assert!(Instant::now() < deadline, "the shared cache never saw the model activate");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // The survivor serves a new request from the same cache.
    let resp = client
        .post(format!("{}/openai/v1/chat/completions", proxy_2.proxy_url()))
        .json(&chat_payload(model))
        .send()
        .await
        .expect("request to the surviving replica failed");
    assert_eq!(resp.status(), StatusCode::OK);
    wait_until(Duration::from_secs(2), "the survivor to forward the request", || {
        runner.request_count() >= 1
    })
    .await;

    dropped_request.abort();
}
