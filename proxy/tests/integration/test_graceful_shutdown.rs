// Graceful-shutdown tests (#330).
//
// These drive the production drain sequence through `spawn_drainable` /
// `ShutdownHandle::begin`, which is the same `shutdown::drain_with_deadline`
// the binary runs: readiness flips to 503, the serve tasks stop accepting, and
// in-flight work is bounded by `Config::shutdown_deadline()` (parking timeout +
// drain margin). D6's promise — parked requests always resolve first — is what
// `parked_request_completes_within_deadline` pins.

use std::time::Duration;

use reqwest::StatusCode;

use crate::common::proxy_builder::TestProxyConfig;
use crate::common::{
    insert_active_model, insert_sleeping_model, spawn_drainable, MockControlPlaneBuilder,
    MockRunner, RunnerState, ShutdownHandle, TestProxy,
};

const MODEL: &str = "graceful-model/v1";

fn payload(stream: bool) -> serde_json::Value {
    serde_json::json!({
        "model": MODEL,
        "messages": [{"role": "user", "content": "Hi"}],
        "stream": stream,
    })
}

/// Poll `cond` until it holds, failing the test after `timeout`.
async fn wait_until(timeout: Duration, what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + timeout;
    while !cond() {
        assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// A request already in flight (held at the runner) completes within the
/// deadline: the drain waits for live connections instead of cutting them.
#[tokio::test]
async fn in_flight_request_completes_within_deadline() {
    let runner_state = RunnerState::new_gated(MODEL);
    let runner = MockRunner::spawn_with_state(runner_state.clone()).await;
    let cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_active_model(&cache, MODEL, runner.addr).await;

    // Deadline = 10 s parking timeout + 1 s drain margin.
    let (proxy, mut handle): (TestProxy, ShutdownHandle) = spawn_drainable(
        TestProxyConfig {
            parking_timeout: Duration::from_secs(10),
            shutdown_drain_secs: 1,
            ..Default::default()
        },
        Some(cache),
    )
    .await;

    let client = reqwest::Client::new();
    let url = format!("{}/openai/v1/chat/completions", proxy.proxy_url());
    let request = tokio::spawn(async move {
        client
            .post(url)
            .json(&payload(false))
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .expect("request failed")
            .status()
    });

    // Hold the request in flight at the runner, then start the drain.
    wait_until(Duration::from_secs(5), "the request to reach the runner", || {
        runner.request_count() > 0
    })
    .await;

    // Release the runner 300 ms after the drain begins — well inside the
    // deadline.
    let gate = runner_state.gate.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        gate.add_permits(1);
    });

    let drain_started = tokio::time::Instant::now();
    handle.begin().await;
    let drain_elapsed = drain_started.elapsed();

    assert_eq!(
        request.await.unwrap(),
        StatusCode::OK,
        "an in-flight request must complete during the drain, not be cut"
    );
    assert!(
        drain_elapsed < Duration::from_secs(5),
        "the drain must finish once the in-flight request completes, took {drain_elapsed:?}"
    );
}

/// A stream that outlives the deadline cannot hold the drain: it resolves at
/// `shutdown_deadline()` and the accept loop stops, rather than waiting for the
/// upstream forever.
///
/// The client-side reset is delivered by the process exiting immediately after
/// `drain_with_deadline` returns (axum 0.8 spawns one task per connection, so
/// aborting the accept loop cannot by itself cancel a response body that is
/// still streaming). Locally the test therefore pins the two in-process facts:
/// the drain is bounded, and the listener is closed.
#[tokio::test]
async fn endless_stream_does_not_hold_the_drain_past_the_deadline() {
    let runner_state = RunnerState::new_gated(MODEL);
    let runner = MockRunner::spawn_with_state(runner_state.clone()).await;
    let cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_active_model(&cache, MODEL, runner.addr).await;

    // Deadline = 1 s parking timeout + 0 s drain margin.
    let (proxy, mut handle) = spawn_drainable(
        TestProxyConfig {
            parking_timeout: Duration::from_secs(1),
            shutdown_drain_secs: 0,
            ..Default::default()
        },
        Some(cache),
    )
    .await;

    let client = reqwest::Client::new();
    let url = format!("{}/openai/v1/chat/completions", proxy.proxy_url());
    let request = tokio::spawn(async move {
        client
            .post(url)
            .json(&payload(true))
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map(|resp| resp.status())
    });

    // The stream is open (request forwarded, runner gated forever).
    wait_until(Duration::from_secs(5), "the stream to reach the runner", || {
        runner.request_count() > 0
    })
    .await;

    let drain_started = tokio::time::Instant::now();
    handle.begin().await;
    let drain_elapsed = drain_started.elapsed();

    assert!(
        drain_elapsed >= Duration::from_secs(1) && drain_elapsed < Duration::from_secs(5),
        "the drain must expire at the 1 s deadline instead of waiting for the stream, took {drain_elapsed:?}"
    );

    // The accept loop ended: no new connection is accepted on the proxy port.
    assert!(
        tokio::net::TcpStream::connect(proxy.proxy_addr).await.is_err(),
        "the proxy must stop accepting connections once the drain deadline expires"
    );

    // The stream never produced a response — it was neither completed nor
    // silently truncated into a partial body by the drain.
    assert!(!request.is_finished(), "a stream past the deadline must not have been completed");
    request.abort();
}

/// A request parked when the drain begins is served once its wake resolves:
/// the deadline is `parking timeout + margin`, so parking always concludes
/// first (D6).
#[tokio::test]
async fn parked_request_completes_within_deadline() {
    let runner = MockRunner::spawn(MODEL).await;
    let cache = sardeenz_proxy::routing::RoutingMapCache::new();
    insert_sleeping_model(&cache, MODEL).await;

    // The wake completes 200 ms after the trigger.
    let cp = MockControlPlaneBuilder::new()
        .on_wake_activate(MODEL, runner.addr, cache.clone(), Duration::from_millis(200))
        .spawn()
        .await;

    // Deadline = 2 s parking timeout + 1 s drain margin.
    let (proxy, mut handle) = spawn_drainable(
        TestProxyConfig {
            control_plane_url: format!("http://{}", cp.addr),
            parking_timeout: Duration::from_secs(2),
            shutdown_drain_secs: 1,
            ..Default::default()
        },
        Some(cache),
    )
    .await;

    let client = reqwest::Client::new();
    let url = format!("{}/openai/v1/chat/completions", proxy.proxy_url());
    let request = tokio::spawn(async move {
        client
            .post(url)
            .json(&payload(false))
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .expect("request failed")
            .status()
    });

    // Start the drain only once the request is genuinely parked.
    let parking = proxy.parking.clone();
    wait_until(Duration::from_secs(5), "the request to park", || {
        parking.global_parked_count() == 1
    })
    .await;

    handle.begin().await;

    assert_eq!(
        request.await.unwrap(),
        StatusCode::OK,
        "a request parked before the drain began must be served, not refused (D6)"
    );
}

/// `/readyz` flips to 503 the moment shutdown begins, so the pod leaves the
/// Service's ready endpoints while it drains.
#[tokio::test]
async fn readyz_flips_503_once_shutdown_begins() {
    let (proxy, mut handle) = spawn_drainable(TestProxyConfig::default(), None).await;
    let client = reqwest::Client::new();
    let readyz = format!("{}/readyz", proxy.admin_url());

    let before = client.get(&readyz).send().await.expect("readyz request failed");
    assert_eq!(before.status(), StatusCode::OK, "a serving proxy must report ready");

    // Production ordering (main.rs): the flag is set on SIGTERM, before the
    // serve tasks stop accepting.
    handle.state().set_shutting_down(true);

    let during = client.get(&readyz).send().await.expect("readyz request failed");
    assert_eq!(
        during.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "a draining proxy must report not-ready"
    );
    assert!(!handle.state().is_ready().await);

    handle.begin().await;
}

/// A request declined because the process is draining says so: the 503 keeps
/// the `model_unavailable` type and envelope, but its message must not blame a
/// disconnected routing state while Redis is connected (#330 review).
#[tokio::test]
async fn drain_refusal_names_the_shutdown_not_redis() {
    let (proxy, mut handle) = spawn_drainable(TestProxyConfig::default(), None).await;
    let client = reqwest::Client::new();
    let url = format!("{}/openai/v1/chat/completions", proxy.proxy_url());

    // Healthy process, draining: the shutdown flag is the only reason to
    // decline, exactly as after SIGTERM with Redis still connected.
    handle.state().set_shutting_down(true);

    let resp = client.post(&url).json(&payload(false)).send().await.expect("request failed");
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body: serde_json::Value = resp.json().await.expect("error envelope");
    assert_eq!(body["error"]["type"], "model_unavailable", "type must stay model_unavailable");
    let message = body["error"]["message"].as_str().unwrap_or_default();
    assert!(message.contains("shutting down"), "the message must name the drain, got: {message}");
    assert!(
        !message.contains("routing state"),
        "the message must not blame a disconnected routing state while Redis is connected, got: \
         {message}"
    );

    handle.begin().await;
}
