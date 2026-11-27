// Graceful-shutdown helpers (#330).
//
// The process shutdown contract has three parts, matching the Deployment:
//
// 1. A `preStop` httpGet on the admin port holds the kubelet for
//    [`PRESTOP_DELAY`], covering router/endpoint-propagation lag before
//    SIGTERM. The image is distroless (`proxy/Dockerfile`), so there is no
//    shell and no `sleep` binary — the delay has to be served over HTTP.
// 2. SIGTERM flips `/readyz` to 503 (`AppState::set_shutting_down`) and drops
//    the shutdown channel, so axum stops accepting and disables keep-alive on
//    live connections; in-flight requests continue.
// 3. [`drain_with_deadline`] bounds that continuation by the derived
//    `Config::shutdown_deadline()` (parking timeout + drain margin), so raising
//    `SARDEENZ_PARKING_TIMEOUT_SECS` cannot silently invalidate the
//    Deployment's `terminationGracePeriodSeconds`.

use std::time::Duration;

use tokio::task::JoinHandle;

use crate::state::AppState;

/// Endpoint-propagation delay served by the preStop httpGet — the kubelet
/// blocks on the response before it sends SIGTERM.
pub const PRESTOP_DELAY: Duration = Duration::from_secs(5);

/// preStop handler body: hold the connection for `delay`, then answer
/// `200 "drained"`. Bounded overall by the pod grace period, so a stuck kubelet
/// cannot exceed `terminationGracePeriodSeconds`.
pub async fn prestop_drain(delay: Duration) -> &'static str {
    tokio::time::sleep(delay).await;
    "drained"
}

/// Drain the serve/sync tasks with a hard deadline (D6, #330).
///
/// Within the deadline, parked and streaming requests complete normally: axum's
/// `with_graceful_shutdown` has already stopped accepting and disabled
/// keep-alive on live connections, and every in-flight request is allowed to
/// finish. On expiry, warn with the current parked count from `state`, then
/// `abort()` the three tasks.
///
/// Past the deadline the remaining connections are **cut** (the client sees a
/// reset, not a JSON error) when the process exits right after this returns —
/// axum 0.8 spawns each connection as its own task, so aborting the accept loop
/// cannot by itself cancel a response body that is still streaming.
///
/// Because the deadline is derived as `parking timeout + drain margin`, parked
/// requests always resolve first (served, or their normal parking 503); only
/// streams/forwards longer than the deadline are cut.
pub async fn drain_with_deadline(
    proxy_handle: JoinHandle<std::io::Result<()>>,
    admin_handle: JoinHandle<std::io::Result<()>>,
    redis_handle: JoinHandle<()>,
    state: &AppState,
    deadline: Duration,
) {
    // `JoinHandle` is not `Clone`, and `join!` consumes the handles — capture
    // abort handles first so the deadline branch can still cancel the tasks.
    let proxy_abort = proxy_handle.abort_handle();
    let admin_abort = admin_handle.abort_handle();
    let redis_abort = redis_handle.abort_handle();

    let drain = async {
        let (proxy_result, admin_result) = tokio::join!(proxy_handle, admin_handle);
        if let Err(e) = proxy_result {
            tracing::error!(error = %e, "proxy server task failed");
        }
        if let Err(e) = admin_result {
            tracing::error!(error = %e, "admin server task failed");
        }
        // Wait for Redis sync to stop.
        let _ = redis_handle.await;
    };

    if tokio::time::timeout(deadline, drain).await.is_err() {
        tracing::warn!(
            parked = state.parking.global_parked_count(),
            deadline_secs = deadline.as_secs(),
            "shutdown deadline expired; aborting remaining connections (cut, not drained)"
        );
        proxy_abort.abort();
        admin_abort.abort();
        redis_abort.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn prestop_drain_returns_after_delay() {
        let delay = Duration::from_millis(50);
        let started = tokio::time::Instant::now();
        let body = prestop_drain(delay).await;
        assert!(
            started.elapsed() >= delay,
            "preStop must hold for the propagation delay, held {:?}",
            started.elapsed()
        );
        assert_eq!(body, "drained");
    }
}
