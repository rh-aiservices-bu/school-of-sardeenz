use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use metrics::gauge;
use std::sync::Mutex;

use crate::config::CircuitBreakerConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CircuitState {
    Closed,
    Open,
    HalfOpen,
}

struct EndpointCircuit {
    state: CircuitState,
    failures: Vec<Instant>,
    last_state_change: Instant,
    /// `Some(t)` = a HalfOpen probe has been in flight since `t`; `None` = no
    /// probe outstanding. Treated as expired (re-claimable) once
    /// `t.elapsed() >= probe_timeout` (leak-backstop window, NOT
    /// `recovery_timeout` — see `CircuitBreakerConfig::probe_timeout`), so no
    /// single missed outcome can permanently strand the endpoint, while a
    /// still-running legitimate probe is never mistaken for a leaked one.
    probe_claimed_at: Option<Instant>,
}

impl EndpointCircuit {
    fn new() -> Self {
        Self {
            state: CircuitState::Closed,
            failures: Vec::new(),
            last_state_change: Instant::now(),
            probe_claimed_at: None,
        }
    }
}

/// Per-endpoint circuit breaker.
#[derive(Clone)]
pub struct CircuitBreaker {
    config: CircuitBreakerConfig,
    circuits: Arc<Mutex<HashMap<String, EndpointCircuit>>>,
}

impl CircuitBreaker {
    pub fn new(config: CircuitBreakerConfig) -> Self {
        Self { config, circuits: Arc::new(Mutex::new(HashMap::new())) }
    }

    #[allow(dead_code)]
    pub fn current_state(&self, key: &str) -> CircuitState {
        let circuits = self.circuits.lock().unwrap();
        match circuits.get(key) {
            Some(circuit) => {
                if circuit.state == CircuitState::Open
                    && circuit.last_state_change.elapsed() >= self.config.recovery_timeout
                {
                    CircuitState::HalfOpen
                } else {
                    circuit.state
                }
            }
            None => CircuitState::Closed,
        }
    }

    pub fn record_success(&self, key: &str) {
        let mut circuits = self.circuits.lock().unwrap();
        if let Some(circuit) = circuits.get_mut(key) {
            if circuit.state == CircuitState::HalfOpen {
                circuit.state = CircuitState::Closed;
                circuit.failures.clear();
                circuit.last_state_change = Instant::now();
                circuit.probe_claimed_at = None;
                Self::emit_state_gauge(key, CircuitState::Closed);
            }
        }
    }

    pub fn record_failure(&self, key: &str) {
        let mut circuits = self.circuits.lock().unwrap();
        let circuit = circuits.entry(key.to_string()).or_insert_with(EndpointCircuit::new);

        if circuit.state == CircuitState::HalfOpen {
            circuit.state = CircuitState::Open;
            circuit.last_state_change = Instant::now();
            circuit.failures.clear();
            circuit.probe_claimed_at = None;
            Self::emit_state_gauge(key, CircuitState::Open);
            return;
        }

        let now = Instant::now();
        circuit.failures.push(now);

        let window_start = now - self.config.failure_window;
        circuit.failures.retain(|&t| t >= window_start);

        if circuit.failures.len() >= self.config.failure_threshold as usize {
            circuit.state = CircuitState::Open;
            circuit.last_state_change = now;
            Self::emit_state_gauge(key, CircuitState::Open);
        }
    }

    /// Non-mutating: would a request to `key` be admitted right now? Claims
    /// nothing. Used to build the candidate set before load balancing.
    pub fn is_available(&self, key: &str) -> bool {
        let circuits = self.circuits.lock().unwrap();
        match circuits.get(key) {
            None => true,
            Some(c) => match c.state {
                CircuitState::Closed => true,
                CircuitState::Open => c.last_state_change.elapsed() >= self.config.recovery_timeout,
                CircuitState::HalfOpen => c
                    .probe_claimed_at
                    // Leak-backstop expiry, not the Open->HalfOpen recovery_timeout: a
                    // legitimate probe can run as long as upstream_timeout, so it must
                    // not be treated as leaked before then (see probe_timeout doc).
                    .is_none_or(|t| t.elapsed() >= self.config.probe_timeout),
            },
        }
    }

    /// Mutating: reserve the half-open probe for the endpoint the balancer
    /// chose. Returns `None` when a live (non-expired) probe is already in
    /// flight (lost race) or the Open circuit is not yet due for recovery —
    /// caller must treat `None` as "endpoint unavailable", NOT as a 503.
    /// `Some(guard)` grants use; the guard releases the probe on drop unless
    /// disarmed.
    pub fn try_acquire_probe(&self, key: &str) -> Option<ProbeGuard> {
        let mut circuits = self.circuits.lock().unwrap();
        let circuit = circuits.entry(key.to_string()).or_insert_with(EndpointCircuit::new);
        match circuit.state {
            CircuitState::Closed => Some(ProbeGuard::noop(self.circuits.clone(), key.to_string())),
            CircuitState::Open => {
                if circuit.last_state_change.elapsed() >= self.config.recovery_timeout {
                    let now = Instant::now();
                    circuit.state = CircuitState::HalfOpen;
                    circuit.last_state_change = now;
                    circuit.probe_claimed_at = Some(now);
                    Self::emit_state_gauge(key, CircuitState::HalfOpen);
                    Some(ProbeGuard::armed(self.circuits.clone(), key.to_string(), now))
                } else {
                    None
                }
            }
            // Leak-backstop expiry, not recovery_timeout — see probe_timeout doc.
            CircuitState::HalfOpen => match circuit.probe_claimed_at {
                Some(t) if t.elapsed() < self.config.probe_timeout => None,
                _ => {
                    let now = Instant::now();
                    circuit.probe_claimed_at = Some(now);
                    Some(ProbeGuard::armed(self.circuits.clone(), key.to_string(), now))
                }
            },
        }
    }

    /// Test-facing probe claim that leaves the probe claimed (mirrors the old
    /// `is_allowed`: claim and keep). Not on any production path — the
    /// handler uses `is_available` + `try_acquire_probe`. Retained for unit
    /// tests.
    #[cfg(test)]
    pub fn is_allowed(&self, key: &str) -> bool {
        match self.try_acquire_probe(key) {
            Some(guard) => {
                guard.disarm(); // keep the probe claimed; do not release on drop
                true
            }
            None => false,
        }
    }

    /// Remove circuits for endpoints no longer present in the routing map,
    /// zeroing their gauge so stale endpoints don't linger in `/metrics`.
    pub fn prune(&self, active_endpoints: &std::collections::HashSet<String>) {
        let mut circuits = self.circuits.lock().unwrap();
        circuits.retain(|key, _| {
            if active_endpoints.contains(key) {
                true
            } else {
                gauge!("sardeenz_proxy_circuit_breaker_state", "endpoint" => key.clone()).set(0.0);
                false
            }
        });
    }

    fn emit_state_gauge(key: &str, state: CircuitState) {
        let value = match state {
            CircuitState::Closed => 0.0,
            CircuitState::Open => 1.0,
            CircuitState::HalfOpen => 2.0,
        };
        gauge!("sardeenz_proxy_circuit_breaker_state", "endpoint" => key.to_string()).set(value);
    }
}

/// RAII guard for a claimed half-open probe. On drop it releases the probe
/// (clears `probe_claimed_at`) UNLESS disarmed — so a request cancelled before
/// it records an outcome cannot strand the probe (#93 cancellation variant),
/// while a request that DID record an outcome disarms the guard so its drop
/// cannot clear a probe a *different* task has since claimed.
///
/// Same pattern/rationale as `ParkingSlotGuard` (#92): `circuits` is a
/// `std::sync::Mutex`, so `Drop` can lock it without awaiting.
pub struct ProbeGuard {
    circuits: Arc<Mutex<HashMap<String, EndpointCircuit>>>,
    key: String,
    /// Instant this guard claimed the probe; `None` = no probe to release
    /// (closed circuit) or the guard has been disarmed.
    claimed_at: Option<Instant>,
}

impl ProbeGuard {
    fn armed(
        circuits: Arc<Mutex<HashMap<String, EndpointCircuit>>>,
        key: String,
        claimed_at: Instant,
    ) -> Self {
        Self { circuits, key, claimed_at: Some(claimed_at) }
    }

    fn noop(circuits: Arc<Mutex<HashMap<String, EndpointCircuit>>>, key: String) -> Self {
        Self { circuits, key, claimed_at: None }
    }

    /// Consume WITHOUT releasing the probe. Call after an outcome was
    /// recorded (record_success/failure already cleared it) or to keep the
    /// probe claimed.
    pub fn disarm(mut self) {
        self.claimed_at = None; // Drop below then sees None and no-ops
    }
}

impl Drop for ProbeGuard {
    fn drop(&mut self) {
        if let Some(claimed) = self.claimed_at {
            let mut circuits = self.circuits.lock().unwrap();
            if let Some(c) = circuits.get_mut(&self.key) {
                // Release ONLY if our probe is still the live one — a newer
                // task may have re-claimed after ours expired.
                if c.probe_claimed_at == Some(claimed) {
                    c.probe_claimed_at = None;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn test_config() -> CircuitBreakerConfig {
        CircuitBreakerConfig {
            failure_threshold: 3,
            failure_window: Duration::from_secs(30),
            recovery_timeout: Duration::from_millis(100),
            probe_timeout: Duration::from_millis(100),
        }
    }

    #[tokio::test]
    async fn starts_closed() {
        let cb = CircuitBreaker::new(test_config());
        assert_eq!(cb.current_state("ep1"), CircuitState::Closed);
    }

    #[tokio::test]
    async fn trips_after_threshold() {
        let cb = CircuitBreaker::new(test_config());
        for _ in 0..3 {
            cb.record_failure("ep1");
        }
        assert_eq!(cb.current_state("ep1"), CircuitState::Open);
    }

    #[tokio::test]
    async fn recovers_to_half_open() {
        let cb = CircuitBreaker::new(test_config());
        for _ in 0..3 {
            cb.record_failure("ep1");
        }
        assert_eq!(cb.current_state("ep1"), CircuitState::Open);

        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(cb.current_state("ep1"), CircuitState::HalfOpen);
    }

    #[tokio::test]
    async fn success_resets_to_closed() {
        let cb = CircuitBreaker::new(test_config());
        for _ in 0..3 {
            cb.record_failure("ep1");
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
        // Transition to HalfOpen by allowing a probe
        assert!(cb.is_allowed("ep1"));
        cb.record_success("ep1");
        assert_eq!(cb.current_state("ep1"), CircuitState::Closed);
    }

    #[tokio::test]
    async fn half_open_allows_single_probe() {
        let cb = CircuitBreaker::new(test_config());
        for _ in 0..3 {
            cb.record_failure("ep1");
        }
        tokio::time::sleep(Duration::from_millis(150)).await;

        // First caller gets through (probe)
        assert!(cb.is_allowed("ep1"));
        // Second caller blocked while probe is in flight
        assert!(!cb.is_allowed("ep1"));
    }

    #[tokio::test]
    async fn half_open_failure_reopens() {
        let cb = CircuitBreaker::new(test_config());
        for _ in 0..3 {
            cb.record_failure("ep1");
        }
        tokio::time::sleep(Duration::from_millis(150)).await;

        assert!(cb.is_allowed("ep1"));
        cb.record_failure("ep1");
        assert_eq!(cb.current_state("ep1"), CircuitState::Open);
    }

    /// Decisive test for the PRIMARY #93 fix: `ProbeGuard::drop` must release
    /// the probe IMMEDIATELY on cancellation, without waiting for
    /// `probe_timeout` to elapse. Unlike `half_open_probe_expires_and_readmits`
    /// (which drives the leak-backstop via `is_allowed`/`disarm`), this test
    /// drops an armed guard directly and re-acquires with no sleep in
    /// between — only the RAII drop-release can make that succeed.
    #[tokio::test]
    async fn dropped_probe_guard_releases_probe_immediately() {
        let cb = CircuitBreaker::new(test_config());
        for _ in 0..3 {
            cb.record_failure("ep1");
        }
        tokio::time::sleep(Duration::from_millis(150)).await;

        let guard = cb.try_acquire_probe("ep1").expect("circuit past recovery_timeout");
        assert!(
            cb.try_acquire_probe("ep1").is_none(),
            "a second probe must not be admitted while the first is in flight"
        );

        // Cancellation path: drop WITHOUT disarming. No sleep — if this
        // relied on probe_timeout expiry (the backstop) rather than the RAII
        // release, the immediately-following acquire would fail.
        drop(guard);

        assert!(
            cb.try_acquire_probe("ep1").is_some(),
            "dropping an armed guard must release the probe immediately, not strand it"
        );
    }

    #[tokio::test]
    async fn prune_removes_inactive_endpoints_and_keeps_active() {
        let cb = CircuitBreaker::new(test_config());
        for _ in 0..3 {
            cb.record_failure("ep-stale");
            cb.record_failure("ep-active");
        }
        assert_eq!(cb.current_state("ep-stale"), CircuitState::Open);
        assert_eq!(cb.current_state("ep-active"), CircuitState::Open);

        let active: std::collections::HashSet<String> = ["ep-active".to_string()].into();
        cb.prune(&active);

        // Pruned circuit was removed entirely, so it reads back as a fresh
        // (never-seen) endpoint: default Closed state.
        assert_eq!(cb.current_state("ep-stale"), CircuitState::Closed);
        // Endpoint still in the active set is untouched.
        assert_eq!(cb.current_state("ep-active"), CircuitState::Open);
    }

    #[tokio::test]
    async fn half_open_probe_expires_and_readmits() {
        let cb = CircuitBreaker::new(test_config());
        for _ in 0..3 {
            cb.record_failure("ep1");
        }
        tokio::time::sleep(Duration::from_millis(150)).await;

        assert!(cb.is_allowed("ep1")); // first caller claims the probe
        assert!(!cb.is_allowed("ep1")); // back-to-back: in flight → blocked

        // No outcome ever recorded → stranded probe expires after probe_timeout.
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(cb.is_allowed("ep1"));
    }
}
