use std::collections::HashMap;
use std::sync::Arc;

use metrics::{counter, gauge, histogram};
use tokio::sync::watch;

use crate::config::ParkingConfig;
use crate::error::ProxyError;
use crate::generated::proxy_control_plane::ModelState;
use crate::parking::WakeTriggerClient;
use crate::routing::RoutingMapCache;

/// State of a pending wake trigger.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WakeState {
    /// Wake trigger HTTP call is currently in flight.
    InFlight,
    /// Wake trigger completed successfully; waiting for model to become Active.
    Triggered,
    /// Wake trigger for this model failed and its `pending_wakes` entry was
    /// removed (#245). Terminal for every request that was parked on the
    /// shared wake signal: they abort instead of waiting out the deadline.
    Failed,
}

/// Manages connection parking for sleeping models.
///
/// Uses a `watch::Receiver` from the routing map cache to detect state
/// transitions. Implements thundering herd prevention by tracking which
/// models have pending wake triggers. Each entry is a `watch::Sender` carrying
/// the trigger outcome, so a failed trigger aborts the whole herd instead of
/// only the first parker (#245).
#[derive(Clone)]
pub struct ParkingManager {
    config: ParkingConfig,
    routing_cache: RoutingMapCache,
    wake_client: WakeTriggerClient,
    pending_wakes: Arc<std::sync::Mutex<HashMap<String, watch::Sender<WakeState>>>>,
    parked_count: Arc<ParkedCount>,
}

struct ParkedCount {
    per_model: std::sync::Mutex<HashMap<String, usize>>,
    global: std::sync::atomic::AtomicUsize,
    parked_bytes: std::sync::atomic::AtomicUsize,
}

/// RAII guard for a reserved parking slot. All release accounting — the
/// global + per-model counters, the parked-connections gauge, the
/// parking-duration histogram, and (as of #94) the thundering-herd
/// `pending_wakes` entry when the last parked request for a model departs —
/// runs in `Drop`, so a slot is reclaimed even when the handler future is
/// cancelled mid-park.
struct ParkingSlotGuard {
    parked_count: Arc<ParkedCount>,
    pending_wakes: Arc<std::sync::Mutex<HashMap<String, watch::Sender<WakeState>>>>,
    model_name: String,
    park_start: std::time::Instant,
    body_len: usize,
}

impl ParkingSlotGuard {
    /// Call ONLY after the slot has been reserved (counters incremented).
    fn new(
        parked_count: Arc<ParkedCount>,
        pending_wakes: Arc<std::sync::Mutex<HashMap<String, watch::Sender<WakeState>>>>,
        model_name: String,
        body_len: usize,
    ) -> Self {
        gauge!("sardeenz_proxy_parked_connections", "model" => model_name.clone()).increment(1);
        Self {
            parked_count,
            pending_wakes,
            model_name,
            park_start: std::time::Instant::now(),
            body_len,
        }
    }
}

impl Drop for ParkingSlotGuard {
    fn drop(&mut self) {
        use std::sync::atomic::Ordering;

        self.parked_count.global.fetch_sub(1, Ordering::SeqCst);
        self.parked_count.parked_bytes.fetch_sub(self.body_len, Ordering::SeqCst);
        let was_last = {
            let mut per_model = self.parked_count.per_model.lock().unwrap();
            match per_model.get_mut(&self.model_name) {
                Some(count) => {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        per_model.remove(&self.model_name);
                        true
                    } else {
                        false
                    }
                }
                None => false,
            }
        };
        // #94: clear the thundering-herd entry only when the LAST parked
        // request for this model departs (timeout OR client-disconnect
        // cancellation — both run this Drop). A timeout/cancel is terminal
        // for ONE request while the rest of the herd may still be waiting
        // productively, so an earlier departure must NOT remove the entry.
        // (Contrast do_park's Active/Error/vanished arms, which are terminal
        // for the WHOLE herd and remove the entry eagerly.) Lock order:
        // per_model is released above before pending_wakes is acquired, and
        // no other path nests these two, so there is no deadlock.
        if was_last {
            self.pending_wakes.lock().unwrap().remove(&self.model_name);
        }
        gauge!("sardeenz_proxy_parked_connections", "model" => self.model_name.clone())
            .decrement(1);
        histogram!("sardeenz_proxy_parking_duration_seconds")
            .record(self.park_start.elapsed().as_secs_f64());
    }
}

/// Client-facing error for a piggybacked parker whose shared wake trigger
/// failed. Generic wording only — the underlying `anyhow::Error` is visible
/// to the first parker alone, so no control-plane detail or URL can leak
/// here (#97). Counts one aborted piggybacker per call.
fn piggyback_wake_failure(model_name: &str) -> ProxyError {
    counter!("sardeenz_proxy_wake_herd_fastfail_total", "model" => model_name.to_string())
        .increment(1);
    ProxyError::ModelUnavailable(format!("wake trigger failed for {model_name}"))
}

/// Resolve only when the shared wake signal reaches `WakeState::Failed`.
///
/// `None` (a `Resolution::Starting` request that found no local entry, see
/// `do_park`) never resolves — the routing-cache arms and the parking
/// deadline own that request's outcome. A dropped sender (another waiter
/// removed the entry on a routing terminal arm) is not a wake-failure signal
/// either: it parks here forever and those same arms decide.
async fn wait_for_wake_failure(rx: &mut Option<watch::Receiver<WakeState>>) {
    let Some(rx) = rx else {
        std::future::pending::<()>().await;
        return;
    };
    loop {
        if rx.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
        // Scope the `Ref` to the comparison: holding a borrow across
        // `changed().await` would deadlock the watch channel.
        if *rx.borrow() == WakeState::Failed {
            return;
        }
    }
}

impl ParkingManager {
    pub fn new(
        config: ParkingConfig,
        routing_cache: RoutingMapCache,
        wake_client: WakeTriggerClient,
    ) -> Self {
        Self {
            config,
            routing_cache,
            wake_client,
            pending_wakes: Arc::new(std::sync::Mutex::new(HashMap::new())),
            parked_count: Arc::new(ParkedCount {
                global: std::sync::atomic::AtomicUsize::new(0),
                per_model: std::sync::Mutex::new(HashMap::new()),
                parked_bytes: std::sync::atomic::AtomicUsize::new(0),
            }),
        }
    }

    /// Park a request for a sleeping model. Fires a wake trigger if this is
    /// the first request, then waits for the model to become active.
    ///
    /// Returns Ok(()) when the model is active and the caller can forward.
    pub async fn park(
        &self,
        model_name: &str,
        fire_wake: bool,
        body_len: usize,
    ) -> Result<(), ProxyError> {
        let _guard = self.reserve_slot(model_name, body_len)?;
        self.do_park(model_name, fire_wake).await
    }

    async fn do_park(&self, model_name: &str, fire_wake: bool) -> Result<(), ProxyError> {
        // Thundering herd prevention: the pending_wakes entry is inserted
        // under the lock BEFORE the wake trigger HTTP call, and the lock is
        // dropped BEFORE the await — so concurrent arrivals see the entry
        // immediately and skip the trigger. Subscriber acquisition happens in
        // the SAME critical section as the membership test: a request that
        // observes an entry also obtains that entry's wake receiver, so it
        // cannot miss a `Failed` published right after the lock is released.
        //
        // Known narrow race, documented not fixed: a `fire_wake: false`
        // (Resolution::Starting) request that acquires this lock after the
        // failing first parker's `remove` finds no entry, subscribes to
        // nothing, and still waits out the parking deadline. The window is
        // the span between that `remove` and this lock; closing it would need
        // per-model state kept alive indefinitely.
        let (is_first, mut wake_rx) = {
            let mut pending = self.pending_wakes.lock().unwrap();
            match pending.get(model_name) {
                Some(sender) => (false, Some(sender.subscribe())),
                None if fire_wake => {
                    let (sender, receiver) = watch::channel(WakeState::InFlight);
                    pending.insert(model_name.to_string(), sender);
                    (true, Some(receiver))
                }
                None => (false, None),
            }
        };
        if is_first {
            match self.wake_client.trigger_wake(model_name).await {
                Ok(()) => {
                    counter!("sardeenz_proxy_wake_triggers_total", "result" => "accepted")
                        .increment(1);
                    if let Some(sender) = self.pending_wakes.lock().unwrap().get(model_name) {
                        sender.send_replace(WakeState::Triggered);
                    }
                }
                Err(e) => {
                    counter!("sardeenz_proxy_wake_triggers_total", "result" => "failed")
                        .increment(1);
                    // #245: fan the failure out to the herd. The entry is
                    // still removed (the next arrival retries, exactly as
                    // before), but the removed sender publishes `Failed` so
                    // every piggybacked parker aborts immediately instead of
                    // waiting out `SARDEENZ_PARKING_TIMEOUT_SECS`.
                    if let Some(sender) = self.pending_wakes.lock().unwrap().remove(model_name) {
                        sender.send_replace(WakeState::Failed);
                    }
                    return Err(ProxyError::ModelUnavailable(format!("wake trigger failed: {e}")));
                }
            }
        }

        // Wait for the model to become active
        let mut receiver = self.routing_cache.subscribe();
        let deadline = tokio::time::Instant::now() + self.config.timeout;
        // A return to SLEEPING counts as a rollback only once we have observed
        // the model leave SLEEPING (STARTING/Active). On the ordinary wake path
        // the cache still reads SLEEPING for the first iterations after the
        // trigger fires — that is the wake in progress, not a rollback.
        // Best-effort: the watch channel retains only the latest value, so a
        // very fast SLEEPING→STARTING→SLEEPING rollback whose intervening
        // STARTING is never observed falls through to the parking-timeout
        // path instead of fast-failing — still correct (503 either way),
        // just not instantaneous in that rare case.
        let mut left_sleeping = false;

        // A Failed published between our lock release and the first select
        // (the trigger failed while we were subscribing) is caught here:
        // `changed()` would not re-deliver a value the receiver already saw.
        if wake_rx.as_ref().is_some_and(|rx| *rx.borrow() == WakeState::Failed) {
            return Err(piggyback_wake_failure(model_name));
        }

        loop {
            match self.routing_cache.get(model_name).await {
                Some(entry) if entry.state == ModelState::Active => {
                    self.pending_wakes.lock().unwrap().remove(model_name);
                    return Ok(());
                }
                Some(entry) if entry.state == ModelState::Error => {
                    self.pending_wakes.lock().unwrap().remove(model_name);
                    return Err(ProxyError::ModelUnavailable(format!(
                        "{model_name} entered error state during wake"
                    )));
                }
                None => {
                    self.pending_wakes.lock().unwrap().remove(model_name);
                    return Err(ProxyError::ModelNotFound(model_name.to_string()));
                }
                Some(entry) if entry.state == ModelState::Draining => {
                    self.pending_wakes.lock().unwrap().remove(model_name);
                    return Err(ProxyError::ModelUnavailable(format!("{model_name} is draining")));
                }
                Some(entry) if entry.state == ModelState::Sleeping && left_sleeping => {
                    self.pending_wakes.lock().unwrap().remove(model_name);
                    return Err(ProxyError::ModelUnavailable(format!(
                        "{model_name} rolled back to sleeping during wake"
                    )));
                }
                Some(entry) => {
                    // STARTING (wake in progress) or still-SLEEPING-pending:
                    // keep waiting. Record once the model has left SLEEPING so a
                    // later return to SLEEPING is recognised as a rollback.
                    if entry.state != ModelState::Sleeping {
                        left_sleeping = true;
                    }
                }
            }

            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => {
                    // The guard's Drop clears the pending_wakes entry once
                    // this is the last parked request for the model, so
                    // future requests can retry the wake trigger.
                    return Err(ProxyError::ParkingTimeout(model_name.to_string()));
                }
                result = receiver.changed() => {
                    if result.is_err() {
                        return Err(ProxyError::Internal(
                            anyhow::anyhow!("routing map channel closed")
                        ));
                    }
                }
                () = wait_for_wake_failure(&mut wake_rx) => {
                    return Err(piggyback_wake_failure(model_name));
                }
            }
        }
    }

    /// Atomically check limits and reserve a slot. Returns Err if either
    /// limit is exceeded. On success, returns a guard that releases the slot
    /// (counters + gauge + histogram) on drop — including on cancellation.
    fn reserve_slot(
        &self,
        model_name: &str,
        body_len: usize,
    ) -> Result<ParkingSlotGuard, ProxyError> {
        use std::sync::atomic::Ordering;

        let mut per_model = self.parked_count.per_model.lock().unwrap();

        // Check per-model limit
        let model_count = per_model.get(model_name).copied().unwrap_or(0);
        if model_count >= self.config.max_per_model {
            return Err(ProxyError::ParkingLimitReached(model_name.to_string()));
        }

        // Atomically increment the byte budget and check
        let prev_bytes = self.parked_count.parked_bytes.fetch_add(body_len, Ordering::SeqCst);
        if prev_bytes + body_len > self.config.max_bytes {
            // Roll back
            self.parked_count.parked_bytes.fetch_sub(body_len, Ordering::SeqCst);
            return Err(ProxyError::ParkingLimitReached(
                "parking byte budget exceeded".to_string(),
            ));
        }

        // Atomically increment global and check
        let prev_global = self.parked_count.global.fetch_add(1, Ordering::SeqCst);
        if prev_global >= self.config.max_global {
            // Roll back both counters
            self.parked_count.global.fetch_sub(1, Ordering::SeqCst);
            self.parked_count.parked_bytes.fetch_sub(body_len, Ordering::SeqCst);
            return Err(ProxyError::ParkingLimitReached(
                "global parking limit reached".to_string(),
            ));
        }

        // Increment per-model (under the same lock as the check)
        *per_model.entry(model_name.to_string()).or_insert(0) += 1;
        drop(per_model);

        Ok(ParkingSlotGuard::new(
            self.parked_count.clone(),
            self.pending_wakes.clone(),
            model_name.to_string(),
            body_len,
        ))
    }

    // NOTE: kept #[allow(dead_code)] despite blueprint A7 — main.rs
    // duplicates this module tree as a separate `bin` crate compilation
    // (it doesn't depend on the `sardeenz_proxy` lib crate), so this method
    // is genuinely unreachable from that target even though the lib crate's
    // unit test and the integration test suite both call it. See PR report.
    #[allow(dead_code)]
    pub fn global_parked_count(&self) -> usize {
        use std::sync::atomic::Ordering;
        self.parked_count.global.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_manager() -> ParkingManager {
        ParkingManager::new(
            ParkingConfig {
                timeout: std::time::Duration::from_secs(30),
                max_per_model: 10,
                max_global: 100,
                max_bytes: 1_048_576,
            },
            RoutingMapCache::new(),
            WakeTriggerClient::new("http://127.0.0.1:1", None),
        )
    }

    #[test]
    fn park_slot_guard_releases_on_drop() {
        let manager = test_manager();

        let guard = manager.reserve_slot("model-a", 0).expect("slot reserved");
        assert_eq!(manager.global_parked_count(), 1);
        drop(guard);
        assert_eq!(manager.global_parked_count(), 0);

        let guard_a = manager.reserve_slot("model-a", 0).expect("slot reserved");
        let guard_b = manager.reserve_slot("model-a", 0).expect("slot reserved");
        assert_eq!(manager.global_parked_count(), 2);
        drop(guard_a);
        assert_eq!(manager.global_parked_count(), 1);
        drop(guard_b);
        assert_eq!(manager.global_parked_count(), 0);
    }

    // #245: a piggybacked parker must abort as soon as the shared wake
    // trigger publishes `Failed`, instead of waiting out the parking
    // deadline. The cache entry is STARTING (wake in progress) so the
    // routing arms keep the loop waiting — the real piggyback situation.
    #[tokio::test]
    async fn parked_request_fails_fast_when_shared_wake_fails() {
        use crate::generated::proxy_control_plane::{Protocol, RoutingEntry};

        let manager = test_manager();
        manager
            .routing_cache
            .update_entry(
                "model-f".to_string(),
                RoutingEntry {
                    model_name: "model-f".to_string(),
                    state: ModelState::Starting,
                    protocol: Protocol::Openai,
                    endpoints: vec![],
                    updated_at: "2024-01-01T00:00:00Z".to_string(),
                    metadata: None,
                },
            )
            .await;

        let (sender, _rx) = watch::channel(WakeState::InFlight);
        manager.pending_wakes.lock().unwrap().insert("model-f".to_string(), sender.clone());

        let manager_for_park = manager.clone();
        let park = tokio::spawn(async move { manager_for_park.park("model-f", false, 0).await });

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        sender.send_replace(WakeState::Failed);

        let result = tokio::time::timeout(std::time::Duration::from_secs(1), park)
            .await
            .expect("park did not fast-fail")
            .expect("park task panicked");
        assert!(
            matches!(&result, Err(ProxyError::ModelUnavailable(m)) if m.contains("wake trigger")),
            "unexpected: {result:?}"
        );
        assert!(!manager.pending_wakes.lock().unwrap().contains_key("model-f"));
    }
}
