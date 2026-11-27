// Aggregate buffered-body admission budget tests (#300).
//
// Both inference surfaces buffer the whole request body before routing. The
// per-request cap (#211) bounds one body; SARDEENZ_PROXY_MAX_BUFFERED_BYTES
// bounds the aggregate of every body currently held — through parking and
// forwarding — and a request that would cross it fails fast with 503
// `overloaded`. Admission never waits, the per-request 413 contract is
// unchanged and takes precedence, and the count is frame-based so a lying or
// absent Content-Length cannot bypass the budget.

use std::time::Duration;

use metrics_exporter_prometheus::PrometheusBuilder;
use reqwest::StatusCode;
use sardeenz_proxy::routing::RoutingMapCache;

use crate::common::mock_control_plane::MockControlPlane;
use crate::common::proxy_builder::TestProxyConfig;
use crate::common::{
    insert_active_model, insert_sleeping_model, MockControlPlaneBuilder, MockRunner, RunnerState,
    TestProxy,
};

/// The gauge this item adds; no labels.
const GAUGE: &str = "sardeenz_proxy_buffered_body_bytes";

/// A valid OpenAI chat body padded with trailing whitespace to exactly
/// `total_len` bytes (whitespace is legal JSON framing).
fn padded_chat_payload(model: &str, total_len: usize) -> Vec<u8> {
    let mut body = serde_json::to_vec(&serde_json::json!({"model": model, "messages": []}))
        .expect("serialize payload");
    assert!(body.len() <= total_len, "base payload is {} bytes", body.len());
    let padding = total_len - body.len();
    body.extend(std::iter::repeat_n(b' ', padding));
    body
}

/// Poll a synchronous predicate until it is true or `timeout` elapses.
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

/// The value of [`GAUGE`] in rendered Prometheus text, if present.
fn gauge_value(rendered: &str) -> Option<f64> {
    rendered.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        if fields.next() == Some(GAUGE) {
            fields.next().and_then(|value| value.parse::<f64>().ok())
        } else {
            None
        }
    })
}

/// A gated mock runner for `model`, registered Active in a fresh cache, plus a
/// proxy built from `configure` over the harness defaults.
async fn spawn_gated(
    model: &str,
    configure: impl FnOnce(&mut TestProxyConfig),
) -> (RunnerState, MockRunner, TestProxy) {
    let runner_state = RunnerState::new_gated(model);
    let runner = MockRunner::spawn_with_state(runner_state.clone()).await;

    let cache = RoutingMapCache::new();
    insert_active_model(&cache, model, runner.addr).await;

    let mut config = TestProxyConfig::default();
    configure(&mut config);
    let proxy = TestProxy::spawn_with_shared_cache_and_config(config, cache).await;

    (runner_state, runner, proxy)
}

#[tokio::test]
async fn aggregate_budget_returns_503_overloaded() {
    let model = "budget-agg/v1";
    // Budget of exactly one maximum-size test body, with a per-request cap above it.
    let (runner_state, runner, proxy) = spawn_gated(model, |config| {
        config.max_body_bytes = 8192;
        config.max_buffered_bytes = 1024;
    })
    .await;

    let client = reqwest::Client::new();
    let url = format!("{}/openai/v1/chat/completions", proxy.proxy_url());
    let body = padded_chat_payload(model, 1024);

    // Request 1 fills the budget and is held mid-forward.
    let held = {
        let client = client.clone();
        let url = url.clone();
        let body = body.clone();
        tokio::spawn(async move { client.post(&url).body(body).send().await })
    };
    assert!(
        poll_until(|| runner.request_count() == 1, Duration::from_secs(5)).await,
        "the first request never reached the runner"
    );

    // Request 2 crosses the aggregate budget: a clean 503, never a 413 or a 500.
    let response = client.post(&url).body(body).send().await.expect("request failed");
    assert_eq!(
        response.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "an exhausted buffered-body budget must be a 503"
    );
    let payload: serde_json::Value = response.json().await.expect("response not JSON");
    assert_eq!(payload["error"]["type"], "overloaded");
    let message = payload["error"]["message"].as_str().unwrap_or("");
    assert!(
        message.contains("SARDEENZ_PROXY_MAX_BUFFERED_BYTES"),
        "message should name the knob: {message}"
    );

    // Releasing the held request frees the budget and it completes normally.
    runner_state.gate.add_permits(1);
    let held = held.await.unwrap().expect("held request failed");
    assert_eq!(held.status(), StatusCode::OK);
}

#[tokio::test]
async fn stress_concurrent_max_size_bodies_cannot_exceed_budget() {
    const CONCURRENCY: usize = 8;
    const BODY_LEN: usize = 512;
    // Room for exactly two bodies.
    const BUDGET: usize = 2 * BODY_LEN;

    let model = "budget-stress/v1";
    let (runner_state, runner, proxy) =
        spawn_gated(model, |config| config.max_buffered_bytes = BUDGET).await;

    let client = reqwest::Client::new();
    let url = format!("{}/openai/v1/chat/completions", proxy.proxy_url());
    let body = padded_chat_payload(model, BODY_LEN);

    let mut handles = Vec::new();
    for _ in 0..CONCURRENCY {
        let client = client.clone();
        let url = url.clone();
        let body = body.clone();
        handles.push(tokio::spawn(async move {
            let response = client.post(&url).body(body).send().await.expect("request failed");
            let status = response.status().as_u16();
            let payload: serde_json::Value =
                response.json().await.unwrap_or(serde_json::Value::Null);
            (status, payload["error"]["type"].as_str().unwrap_or("").to_string())
        }));
    }

    // Wait for the admitted requests to be held mid-forward and every other one
    // to have settled while the budget is still occupied.
    let settled = poll_until(
        || {
            let admitted = runner.request_count();
            let finished = handles.iter().filter(|handle| handle.is_finished()).count();
            admitted >= 2 && finished == CONCURRENCY - admitted
        },
        Duration::from_secs(5),
    )
    .await;

    runner_state.gate.add_permits(CONCURRENCY);
    let mut results = Vec::new();
    for handle in handles {
        results.push(handle.await.expect("request task panicked"));
    }

    let admitted = results.iter().filter(|(status, _)| *status == 200).count();
    let rejected: Vec<&(u16, String)> =
        results.iter().filter(|(status, _)| *status == 503).collect();

    assert!(
        settled,
        "requests never settled into the expected partition (admitted={admitted}): {results:?}"
    );
    assert!(
        admitted <= 2,
        "a {BUDGET}-byte budget admitted {admitted} concurrent {BODY_LEN}-byte bodies: {results:?}"
    );
    assert_eq!(
        admitted + rejected.len(),
        CONCURRENCY,
        "every request must settle as 200 or 503 — zero 413/500: {results:?}"
    );
    assert!(
        rejected.iter().all(|(_, error_type)| error_type == "overloaded"),
        "budget rejections must be 503 overloaded: {results:?}"
    );
}

#[tokio::test]
async fn lying_and_chunked_framing_still_bounded() {
    let client = reqwest::Client::new();

    // (i) No Content-Length at all: the actual buffered bytes must trigger the
    // budget, so the absent header cannot bypass it.
    let chunked_proxy = TestProxy::spawn_with_config(TestProxyConfig {
        max_body_bytes: 8192,
        max_buffered_bytes: 1024,
        ..Default::default()
    })
    .await;
    let chunked_url = format!("{}/openai/v1/chat/completions", chunked_proxy.proxy_url());
    let stream =
        futures_util::stream::once(async move { Ok::<_, std::io::Error>(vec![b'x'; 2048]) });
    let chunked = client
        .post(&chunked_url)
        .header("content-type", "application/json")
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await
        .expect("request failed");
    assert_eq!(chunked.status(), StatusCode::SERVICE_UNAVAILABLE);
    let chunked_body: serde_json::Value = chunked.json().await.expect("response not JSON");
    assert_eq!(chunked_body["error"]["type"], "overloaded");

    // (ii) A declared Content-Length larger than the remaining headroom is
    // rejected before the read, with the identical envelope and message.
    let model = "budget-declared/v1";
    let (runner_state, runner, proxy) =
        spawn_gated(model, |config| config.max_buffered_bytes = 2048).await;
    let url = format!("{}/openai/v1/chat/completions", proxy.proxy_url());
    let held_body = padded_chat_payload(model, 1024);

    let held = {
        let client = client.clone();
        let url = url.clone();
        tokio::spawn(async move { client.post(&url).body(held_body).send().await })
    };
    assert!(
        poll_until(|| runner.request_count() == 1, Duration::from_secs(5)).await,
        "the held request never reached the runner"
    );

    // 1024 of 2048 in use → 2048 declared cannot fit → pre-read 503.
    let over_headroom = client
        .post(&url)
        .header("content-type", "application/json")
        .body(padded_chat_payload(model, 2048))
        .send()
        .await
        .expect("request failed");
    assert_eq!(over_headroom.status(), StatusCode::SERVICE_UNAVAILABLE);
    let over_headroom: serde_json::Value = over_headroom.json().await.expect("response not JSON");
    assert_eq!(over_headroom["error"]["type"], "overloaded");
    assert_eq!(
        over_headroom["error"]["message"], chunked_body["error"]["message"],
        "pre-read and mid-read rejections must return the identical envelope"
    );

    runner_state.gate.add_permits(1);
    let held = held.await.unwrap().expect("held request failed");
    assert_eq!(held.status(), StatusCode::OK);
}

#[tokio::test]
async fn per_request_413_unchanged_under_budget() {
    let client = reqwest::Client::new();

    // Generous aggregate budget: the per-request cap alone decides.
    let proxy = TestProxy::spawn_with_config(TestProxyConfig {
        max_body_bytes: 1024,
        ..Default::default()
    })
    .await;

    let openai = client
        .post(format!("{}/openai/v1/chat/completions", proxy.proxy_url()))
        .header("content-type", "application/json")
        .body(vec![b'x'; 2048])
        .send()
        .await
        .expect("request failed");
    assert_eq!(openai.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let openai: serde_json::Value = openai.json().await.expect("response not JSON");
    assert_eq!(openai["error"]["type"], "request_too_large");
    let message = openai["error"]["message"].as_str().unwrap_or("");
    assert!(message.contains("1024-byte"), "message should name the limit: {message}");
    assert!(
        message.contains("SARDEENZ_PROXY_MAX_BODY_BYTES"),
        "message should name the env var: {message}"
    );

    let oip = client
        .post(format!("{}/oip/v2/models/ghost/infer", proxy.proxy_url()))
        .header("content-type", "application/json")
        .body(vec![b'x'; 2048])
        .send()
        .await
        .expect("request failed");
    assert_eq!(oip.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let oip: serde_json::Value = oip.json().await.expect("response not JSON");
    assert_eq!(oip["error"]["type"], "request_too_large");

    // Precedence: with a tiny aggregate budget and an over-limit body, the 413
    // still wins — the per-request check runs before the budget check.
    let tight = TestProxy::spawn_with_config(TestProxyConfig {
        max_body_bytes: 1024,
        max_buffered_bytes: 512,
        ..Default::default()
    })
    .await;
    let precedence = client
        .post(format!("{}/openai/v1/chat/completions", tight.proxy_url()))
        .header("content-type", "application/json")
        .body(vec![b'x'; 2048])
        .send()
        .await
        .expect("request failed");
    assert_eq!(
        precedence.status(),
        StatusCode::PAYLOAD_TOO_LARGE,
        "the 413 contract takes precedence over the 503 budget rejection"
    );
    let precedence: serde_json::Value = precedence.json().await.expect("response not JSON");
    assert_eq!(precedence["error"]["type"], "request_too_large");
}

#[tokio::test]
async fn budget_released_after_completion() {
    const BODY_LEN: usize = 512;
    let model = "budget-release/v1";
    let (runner_state, runner, proxy) =
        spawn_gated(model, |config| config.max_buffered_bytes = BODY_LEN).await;

    let client = reqwest::Client::new();
    let url = format!("{}/openai/v1/chat/completions", proxy.proxy_url());
    let body = padded_chat_payload(model, BODY_LEN);

    let held = {
        let client = client.clone();
        let url = url.clone();
        let body = body.clone();
        tokio::spawn(async move { client.post(&url).body(body).send().await })
    };
    assert!(
        poll_until(|| runner.request_count() == 1, Duration::from_secs(5)).await,
        "the first request never reached the runner"
    );

    let rejected = client.post(&url).body(body.clone()).send().await.expect("request failed");
    assert_eq!(rejected.status(), StatusCode::SERVICE_UNAVAILABLE);
    let rejected: serde_json::Value = rejected.json().await.expect("response not JSON");
    assert_eq!(rejected["error"]["type"], "overloaded");

    // Release the held request: it completes and its buffered bytes are freed.
    runner_state.gate.add_permits(8);
    let held = held.await.unwrap().expect("held request failed");
    assert_eq!(held.status(), StatusCode::OK);

    // The previously rejected request now succeeds.
    let mut last_status = None;
    for _ in 0..100 {
        let retry = client.post(&url).body(body.clone()).send().await.expect("request failed");
        let status = retry.status();
        if status == StatusCode::OK {
            last_status = Some(status);
            break;
        }
        last_status = Some(status);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        last_status,
        Some(StatusCode::OK),
        "a request rejected while the budget was full must succeed once it is released"
    );
}

#[tokio::test]
async fn parked_reading_and_forwarding_do_not_deadlock() {
    const BODY_LEN: usize = 512;
    // Room for four bodies: three parked + one held mid-forward fills it exactly.
    const BUDGET: usize = 4 * BODY_LEN;

    let sleeping_model = "budget-sleep/A";
    let active_model = "budget-sleep/B";

    let cache = RoutingMapCache::new();
    insert_sleeping_model(&cache, sleeping_model).await;

    let runner_state = RunnerState::new_gated(active_model);
    let runner = MockRunner::spawn_with_state(runner_state.clone()).await;
    insert_active_model(&cache, active_model, runner.addr).await;

    // No `on_wake_activate`: the sleeping model never wakes, so its parked
    // requests hold budget bytes until the parking timeout fires.
    let cp: MockControlPlane = MockControlPlaneBuilder::new().spawn().await;

    let proxy = TestProxy::spawn_with_shared_cache_and_config(
        TestProxyConfig {
            control_plane_url: format!("http://{}", cp.addr),
            parking_timeout: Duration::from_secs(3),
            max_concurrent_forwards: 1,
            max_buffered_bytes: BUDGET,
            ..Default::default()
        },
        cache,
    )
    .await;

    let client = reqwest::Client::new();
    let url = format!("{}/openai/v1/chat/completions", proxy.proxy_url());
    let sleeping_body = padded_chat_payload(sleeping_model, BODY_LEN);
    let active_body = padded_chat_payload(active_model, BODY_LEN);

    // Three parked requests hold 3/4 of the budget.
    let mut parked = Vec::new();
    for _ in 0..3 {
        let client = client.clone();
        let url = url.clone();
        let body = sleeping_body.clone();
        parked.push(tokio::spawn(async move { client.post(&url).body(body).send().await }));
    }
    assert!(
        poll_until(|| proxy.parking.global_parked_count() == 3, Duration::from_secs(5)).await,
        "the parked requests never registered"
    );

    // One forwarding request takes the single permit and fills the budget.
    let holder = {
        let client = client.clone();
        let url = url.clone();
        let body = active_body.clone();
        tokio::spawn(async move { client.post(&url).body(body).send().await })
    };
    assert!(
        poll_until(|| runner.request_count() == 1, Duration::from_secs(5)).await,
        "the forwarding request never reached the runner"
    );

    // A second forward (permit taken) and another read (budget full) both fail
    // fast — neither may wait on the parking or forwarding state. Both are
    // deadline-bounded for exactly that reason: a regression that made admission
    // *wait* must fail here with a diagnostic, not hang the test until the job
    // timeout.
    let (blocked_forward_status, blocked_forward) =
        tokio::time::timeout(Duration::from_secs(10), async {
            let response =
                client.post(&url).body(active_body).send().await.expect("request failed");
            let status = response.status();
            let payload: serde_json::Value = response.json().await.expect("response not JSON");
            (status, payload)
        })
        .await
        .expect("a second forward hung — forwarding admission waited instead of failing fast");

    let (blocked_read_status, blocked_read) =
        tokio::time::timeout(Duration::from_secs(10), async {
            let response =
                client.post(&url).body(sleeping_body).send().await.expect("request failed");
            let status = response.status();
            let payload: serde_json::Value = response.json().await.expect("response not JSON");
            (status, payload)
        })
        .await
        .expect("a read against a full budget hung — read admission deadlocked");

    assert_eq!(blocked_forward_status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(blocked_forward["error"]["type"], "overloaded");
    assert_eq!(blocked_read_status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(
        ["overloaded", "parking_timeout"]
            .contains(&blocked_read["error"]["type"].as_str().unwrap()),
        "expected a clean admission rejection, got: {blocked_read}"
    );

    // Every parked request settles with the parking timeout — it waits only on the
    // model wake, never on the budget.
    for handle in parked {
        let response = tokio::time::timeout(Duration::from_secs(10), handle)
            .await
            .expect("a parked request hung — read admission deadlocked against parking")
            .expect("parked request task panicked")
            .expect("parked request failed");
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let payload: serde_json::Value = response.json().await.expect("response not JSON");
        assert_eq!(payload["error"]["type"], "parking_timeout");
    }

    // Releasing the gate lets the held forward complete.
    runner_state.gate.add_permits(1);
    let holder = tokio::time::timeout(Duration::from_secs(10), holder)
        .await
        .expect("the held forwarding request hung — read admission deadlocked against forwarding")
        .expect("held request task panicked")
        .expect("held request failed");
    assert_eq!(holder.status(), StatusCode::OK);
}

#[test]
fn buffered_bytes_gauge_exposed_and_balanced() {
    let recorder = PrometheusBuilder::new().build_recorder();
    let handle = recorder.handle();

    // The integration harness installs no recorder (every metric macro silently
    // no-ops there), so this case runs a *current-thread* runtime inside a
    // thread-local recorder: all proxy tasks and gauge writes then happen on this
    // thread and land in `handle`, whose render is the same Prometheus text the
    // admin `/metrics` endpoint serves.
    metrics::with_local_recorder(&recorder, || {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(
            async {
                let model = "budget-gauge/v1";
                let (runner_state, runner, proxy) =
                    spawn_gated(model, |config| config.max_buffered_bytes = 4096).await;

                let client = reqwest::Client::new();
                let url = format!("{}/openai/v1/chat/completions", proxy.proxy_url());

                let held = {
                    let client = client.clone();
                    let url = url.clone();
                    tokio::spawn(async move {
                        client.post(&url).body(padded_chat_payload(model, 512)).send().await
                    })
                };
                assert!(
                    poll_until(|| runner.request_count() == 1, Duration::from_secs(5)).await,
                    "the held request never reached the runner"
                );

                let rendered = handle.render();
                assert!(rendered.contains(GAUGE), "the gauge should be exported: {rendered}");
                assert_eq!(
                    gauge_value(&rendered),
                    Some(512.0),
                    "the gauge should show the bytes held mid-forward: {rendered}"
                );

                // Sanity: the admin endpoint still serves Prometheus text.
                let metrics_response = client
                    .get(format!("{}/metrics", proxy.admin_url()))
                    .send()
                    .await
                    .expect("metrics request failed");
                assert_eq!(metrics_response.status(), StatusCode::OK);

                runner_state.gate.add_permits(1);
                let held = held.await.unwrap().expect("held request failed");
                assert_eq!(held.status(), StatusCode::OK);

                assert!(
                    poll_until(
                        || gauge_value(&handle.render()) == Some(0.0),
                        Duration::from_secs(5)
                    )
                    .await,
                    "the gauge must return to zero once the body is released: {}",
                    handle.render()
                );
            },
        );
    });
}
