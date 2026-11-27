//! Global admission budget over the total bytes of request bodies buffered in
//! memory by the proxy's two inference surfaces (`/openai/*`, `/oip/*`) — #300.
//!
//! `SARDEENZ_PROXY_MAX_BODY_BYTES` bounds one request; nothing bounded the
//! aggregate, so ~32 concurrent maximum-size bodies could reach the container
//! memory limit and OOMKill the replica before any parking or forwarding
//! decision ran. Every data frame read by [`BudgetedBody`] counts against
//! [`BufferedBodyBudget`]; a request that would cross the budget fails fast
//! with `503 overloaded`.
//!
//! **Admission never waits.** The budget is a pair of atomics: a frame is
//! either counted and passed on, or rejected immediately. There is no lock, no
//! semaphore and no notification shared with the parking manager or the
//! forwarding limiter, so no circular wait is possible between them.
//!
//! **Accounting lifetime.** Bytes stay counted from the first data frame until
//! the in-memory buffer is dropped — through parking and through forwarding —
//! released by [`BudgetGuard`]'s `Drop`. That covers every exit path,
//! cancellation included, and bounds inference-path buffered memory at exactly
//! the configured value. A parked body therefore counts against both
//! `SARDEENZ_PARKING_MAX_BYTES` and this budget; that is documented in
//! `deployment/proxy/README.md` and is not a deadlock (parking waits only on
//! the model wake, bounded by `SARDEENZ_PARKING_TIMEOUT_SECS`, while read
//! admission never blocks).

use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::body::Body;
use bytes::Bytes;
use http_body::{Frame, SizeHint};
use metrics::gauge;

/// Prometheus gauge name; no labels.
pub(crate) const BUFFERED_BODY_BYTES_GAUGE: &str = "sardeenz_proxy_buffered_body_bytes";

struct Inner {
    /// `0` = enforcement disabled (explicit opt-out); counting and the gauge
    /// still run so the exposure stays visible.
    max_bytes: usize,
    in_use: AtomicUsize,
}

/// Global budget over total buffered body bytes. Cloning is cheap (shared `Arc`).
#[derive(Clone)]
pub struct BufferedBodyBudget {
    inner: Arc<Inner>,
}

impl BufferedBodyBudget {
    /// `max_bytes == 0` disables enforcement but keeps counting and the gauge.
    pub fn new(max_bytes: usize) -> Self {
        Self { inner: Arc::new(Inner { max_bytes, in_use: AtomicUsize::new(0) }) }
    }

    /// Currently counted bytes across all live bodies.
    pub fn in_use(&self) -> usize {
        self.inner.in_use.load(Ordering::SeqCst)
    }

    /// Advisory pre-read check for a declared `Content-Length`: would
    /// `declared_len` more bytes fit in the remaining headroom? Always true when
    /// enforcement is disabled.
    ///
    /// The check is advisory by design — the frame counting in [`BudgetedBody`]
    /// is authoritative, so a lying (or absent) `Content-Length` gains nothing;
    /// this only avoids buffering up to the budget just to fail.
    pub fn admits(&self, declared_len: u64) -> bool {
        self.inner.max_bytes == 0
            || declared_len <= self.inner.max_bytes.saturating_sub(self.in_use()) as u64
    }

    /// Wrap `body` so its data frames count against the budget. Returns the
    /// wrapped body (for `Body::new` + `to_bytes`) and a guard that keeps the
    /// counted bytes reserved until dropped — buffer lifetime, park and forward
    /// included.
    pub fn wrap(&self, body: Body) -> (BudgetedBody, BudgetGuard) {
        let counted = Arc::new(AtomicUsize::new(0));
        (
            BudgetedBody {
                inner: Box::pin(body),
                budget: self.clone(),
                counted: Arc::clone(&counted),
            },
            BudgetGuard { inner: Arc::clone(&self.inner), counted },
        )
    }
}

/// Counting `http_body::Body` wrapper. Non-data frames (trailers) pass through
/// uncounted; each data frame adds its length to the budget and to the shared
/// counter, mirrors the new total into the gauge, and — when enforcement is on
/// and the total now exceeds the budget — fails with [`BudgetExceededError`].
pub struct BudgetedBody {
    inner: Pin<Box<Body>>,
    budget: BufferedBodyBudget,
    /// Shared with the guard, which is the single owner of the release.
    counted: Arc<AtomicUsize>,
}

impl http_body::Body for BudgetedBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        match self.inner.as_mut().poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    let len = data.len();
                    self.counted.fetch_add(len, Ordering::SeqCst);
                    let total = self.budget.inner.in_use.fetch_add(len, Ordering::SeqCst) + len;
                    set_gauge(total);
                    if self.budget.inner.max_bytes > 0 && total > self.budget.inner.max_bytes {
                        // The offending frame is dropped, but its bytes stay counted
                        // until the guard drops: accounting is conservative (never
                        // under-counts) and released on every exit path.
                        return Poll::Ready(Some(Err(axum::Error::new(BudgetExceededError))));
                    }
                }
                Poll::Ready(Some(Ok(frame)))
            }
            other => other,
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// RAII release of this body's counted bytes.
///
/// Only the guard ever subtracts (single owner of the release), so cancellation
/// and error paths cannot double-release, and `counted` only ever grew for
/// frames actually produced, so the budget never goes negative. Same discipline
/// as `ParkingSlotGuard` and `ActiveConnectionGuard`.
#[must_use]
pub struct BudgetGuard {
    inner: Arc<Inner>,
    counted: Arc<AtomicUsize>,
}

impl Drop for BudgetGuard {
    fn drop(&mut self) {
        let released = self.counted.swap(0, Ordering::SeqCst);
        if released > 0 {
            let total = self.inner.in_use.fetch_sub(released, Ordering::SeqCst) - released;
            set_gauge(total);
        }
    }
}

fn set_gauge(in_use: usize) {
    gauge!(BUFFERED_BODY_BYTES_GAUGE).set(in_use as f64);
}

/// Marker error for a body that would cross the aggregate budget. It reaches
/// `body_read_error` deep in the source chain of the `axum::Error` returned by
/// `to_bytes` (our wrapper's error is re-boxed by `Body::new` and again by
/// `to_bytes`), which is why classification walks the chain instead of looking
/// at one `source()` hop like the `LengthLimitError` 413 check does.
#[derive(Debug, thiserror::Error)]
#[error("proxy buffered-body budget exceeded")]
pub struct BudgetExceededError;

/// Depth-agnostic source-chain walk: is a [`BudgetExceededError`] anywhere in
/// `error`'s chain? Checks every level, including the outermost error.
pub(crate) fn is_budget_exceeded(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(err) = current {
        if err.downcast_ref::<BudgetExceededError>().is_some() {
            return true;
        }
        current = err.source();
    }
    false
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;
    use std::time::Duration;

    use http_body_util::{Full, StreamBody};
    use metrics_exporter_prometheus::PrometheusBuilder;

    use super::*;

    /// Frames of `len` bytes each, as one streaming body.
    fn framed_body(frames: &[usize]) -> Body {
        let stream = futures_util::stream::iter(
            frames
                .iter()
                .map(|len| Ok::<_, Infallible>(Frame::data(Bytes::from(vec![b'x'; *len]))))
                .collect::<Vec<_>>(),
        );
        Body::new(StreamBody::new(stream))
    }

    /// Yields one 100-byte data frame, then stays pending forever — a body that
    /// can only be released by cancelling the read.
    struct StalledBody {
        sent: bool,
    }

    impl http_body::Body for StalledBody {
        type Data = Bytes;
        type Error = Infallible;

        fn poll_frame(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
            if self.sent {
                Poll::Pending
            } else {
                self.sent = true;
                Poll::Ready(Some(Ok(Frame::data(Bytes::from(vec![0u8; 100])))))
            }
        }
    }

    /// Walk the source chain and return the downcast hit at each level, plus the
    /// depth at which `BudgetExceededError` sits (`None` if absent).
    fn budget_error_depth(error: &axum::Error) -> (Vec<bool>, Option<usize>) {
        let mut matches = Vec::new();
        let mut depth = None;
        let mut current: Option<&dyn std::error::Error> = Some(error);
        let mut level = 0;
        while let Some(err) = current {
            let hit = err.downcast_ref::<BudgetExceededError>().is_some();
            matches.push(hit);
            if hit && depth.is_none() {
                depth = Some(level);
            }
            current = err.source();
            level += 1;
        }
        (matches, depth)
    }

    #[tokio::test]
    async fn over_budget_mid_stream_errors() {
        let budget = BufferedBodyBudget::new(8);
        let (wrapped, _guard) = budget.wrap(framed_body(&[4, 4, 4]));

        let error = axum::body::to_bytes(Body::new(wrapped), usize::MAX)
            .await
            .expect_err("the third frame crosses the budget");

        assert!(is_budget_exceeded(&error));
        assert_eq!(budget.in_use(), 12, "counted frames stay reserved until the guard drops");
    }

    #[tokio::test]
    async fn budget_error_downcasts_through_axum_error() {
        let budget = BufferedBodyBudget::new(8);
        let (wrapped, _guard) = budget.wrap(framed_body(&[4, 4, 4]));

        let error = axum::body::to_bytes(Body::new(wrapped), usize::MAX)
            .await
            .expect_err("the third frame crosses the budget");

        // Pins the real depth: `Body::new` re-boxes our `axum::Error` through
        // `map_err(Error::new)` and `to_bytes` wraps the collect error once more, so
        // the marker sits at level 3 — one `source()` hop (the 413 check's shape)
        // cannot see it.
        let (matches, depth) = budget_error_depth(&error);
        assert_eq!(depth, Some(3), "source levels downcast hits: {matches:?}");
        assert!(!matches[1], "the level-1 error is axum's own wrapper, not the marker");
        assert!(is_budget_exceeded(&error));
    }

    #[test]
    fn guard_drop_releases_counted_bytes() {
        let recorder = PrometheusBuilder::new().build_recorder();
        let handle = recorder.handle();

        // A thread-local recorder is only visible to the thread that installed it,
        // so the runtime must be current-thread: every proxy task and gauge write
        // then happens on this thread.
        metrics::with_local_recorder(&recorder, || {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(
                async {
                    let budget = BufferedBodyBudget::new(1024);
                    let (wrapped, guard) =
                        budget.wrap(Body::new(Full::new(Bytes::from(vec![b'x'; 64]))));

                    let bytes = axum::body::to_bytes(Body::new(wrapped), usize::MAX)
                        .await
                        .expect("64 bytes fit in a 1024-byte budget");
                    assert_eq!(bytes.len(), 64);
                    assert_eq!(budget.in_use(), 64);
                    assert!(
                        handle.render().contains("sardeenz_proxy_buffered_body_bytes 64"),
                        "gauge should show the held bytes: {}",
                        handle.render()
                    );

                    drop(guard);
                    assert_eq!(budget.in_use(), 0);
                    assert!(
                        handle.render().contains("sardeenz_proxy_buffered_body_bytes 0"),
                        "gauge should be back to zero: {}",
                        handle.render()
                    );
                },
            );
        });
    }

    #[tokio::test]
    async fn cancelled_read_releases_accounting() {
        let budget = BufferedBodyBudget::new(1024);
        let task_budget = budget.clone();

        let task = tokio::spawn(async move {
            let (wrapped, _guard) = task_budget.wrap(Body::new(StalledBody { sent: false }));
            let _ = axum::body::to_bytes(Body::new(wrapped), usize::MAX).await;
        });

        // Wait for the first frame to be counted, then cancel mid-stream.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while budget.in_use() != 100 {
            assert!(tokio::time::Instant::now() < deadline, "first frame was never counted");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        task.abort();
        let _ = task.await;

        assert_eq!(budget.in_use(), 0, "cancelling the read must release the reservation");
    }

    #[test]
    fn zero_budget_counts_but_never_enforces() {
        let recorder = PrometheusBuilder::new().build_recorder();
        let handle = recorder.handle();

        metrics::with_local_recorder(&recorder, || {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(
                async {
                    let budget = BufferedBodyBudget::new(0);
                    assert!(
                        budget.admits(u64::MAX),
                        "an explicit opt-out admits any declared size"
                    );

                    let (wrapped, guard) = budget.wrap(framed_body(&[32, 32, 32]));
                    let bytes = axum::body::to_bytes(Body::new(wrapped), usize::MAX)
                        .await
                        .expect("enforcement is disabled");
                    assert_eq!(bytes.len(), 96);
                    assert_eq!(budget.in_use(), 96, "counting continues with enforcement off");
                    assert!(
                        handle.render().contains("sardeenz_proxy_buffered_body_bytes 96"),
                        "gauge should show the counted bytes: {}",
                        handle.render()
                    );

                    drop(guard);
                    assert_eq!(budget.in_use(), 0);
                },
            );
        });
    }
}
