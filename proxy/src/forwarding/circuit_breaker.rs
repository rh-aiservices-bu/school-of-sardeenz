use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use metrics::gauge;
use tokio::sync::Mutex;

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
    /// When true, a probe request is already in flight during HalfOpen.
    half_open_probe_in_flight: bool,
}

/// Per-endpoint circuit breaker.
#[derive(Clone)]
pub struct CircuitBreaker {
    config: CircuitBreakerConfig,
    circuits: Arc<Mutex<HashMap<String, EndpointCircuit>>>,
}

impl CircuitBreaker {
    pub fn new(config: CircuitBreakerConfig) -> Self {
        Self {
            config,
            circuits: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[allow(dead_code)]
    pub async fn current_state(&self, key: &str) -> CircuitState {
        let circuits = self.circuits.lock().await;
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

    pub async fn record_success(&self, key: &str) {
        let mut circuits = self.circuits.lock().await;
        if let Some(circuit) = circuits.get_mut(key) {
            if circuit.state == CircuitState::HalfOpen {
                circuit.state = CircuitState::Closed;
                circuit.failures.clear();
                circuit.last_state_change = Instant::now();
                circuit.half_open_probe_in_flight = false;
                Self::emit_state_gauge(key, CircuitState::Closed);
            }
        }
    }

    pub async fn record_failure(&self, key: &str) {
        let mut circuits = self.circuits.lock().await;
        let circuit = circuits
            .entry(key.to_string())
            .or_insert_with(|| EndpointCircuit {
                state: CircuitState::Closed,
                failures: Vec::new(),
                last_state_change: Instant::now(),
                half_open_probe_in_flight: false,
            });

        if circuit.state == CircuitState::HalfOpen {
            circuit.state = CircuitState::Open;
            circuit.last_state_change = Instant::now();
            circuit.failures.clear();
            circuit.half_open_probe_in_flight = false;
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

    pub async fn is_allowed(&self, key: &str) -> bool {
        let mut circuits = self.circuits.lock().await;
        let circuit = circuits
            .entry(key.to_string())
            .or_insert_with(|| EndpointCircuit {
                state: CircuitState::Closed,
                failures: Vec::new(),
                last_state_change: Instant::now(),
                half_open_probe_in_flight: false,
            });

        match circuit.state {
            CircuitState::Closed => true,
            CircuitState::Open => {
                if circuit.last_state_change.elapsed() >= self.config.recovery_timeout {
                    circuit.state = CircuitState::HalfOpen;
                    circuit.last_state_change = Instant::now();
                    circuit.half_open_probe_in_flight = true;
                    Self::emit_state_gauge(key, CircuitState::HalfOpen);
                    true
                } else {
                    false
                }
            }
            CircuitState::HalfOpen => {
                if circuit.half_open_probe_in_flight {
                    false
                } else {
                    circuit.half_open_probe_in_flight = true;
                    true
                }
            }
        }
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn test_config() -> CircuitBreakerConfig {
        CircuitBreakerConfig {
            failure_threshold: 3,
            failure_window: Duration::from_secs(30),
            recovery_timeout: Duration::from_millis(100),
        }
    }

    #[tokio::test]
    async fn starts_closed() {
        let cb = CircuitBreaker::new(test_config());
        assert_eq!(cb.current_state("ep1").await, CircuitState::Closed);
    }

    #[tokio::test]
    async fn trips_after_threshold() {
        let cb = CircuitBreaker::new(test_config());
        for _ in 0..3 {
            cb.record_failure("ep1").await;
        }
        assert_eq!(cb.current_state("ep1").await, CircuitState::Open);
    }

    #[tokio::test]
    async fn recovers_to_half_open() {
        let cb = CircuitBreaker::new(test_config());
        for _ in 0..3 {
            cb.record_failure("ep1").await;
        }
        assert_eq!(cb.current_state("ep1").await, CircuitState::Open);

        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(cb.current_state("ep1").await, CircuitState::HalfOpen);
    }

    #[tokio::test]
    async fn success_resets_to_closed() {
        let cb = CircuitBreaker::new(test_config());
        for _ in 0..3 {
            cb.record_failure("ep1").await;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
        // Transition to HalfOpen by allowing a probe
        assert!(cb.is_allowed("ep1").await);
        cb.record_success("ep1").await;
        assert_eq!(cb.current_state("ep1").await, CircuitState::Closed);
    }

    #[tokio::test]
    async fn half_open_allows_single_probe() {
        let cb = CircuitBreaker::new(test_config());
        for _ in 0..3 {
            cb.record_failure("ep1").await;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;

        // First caller gets through (probe)
        assert!(cb.is_allowed("ep1").await);
        // Second caller blocked while probe is in flight
        assert!(!cb.is_allowed("ep1").await);
    }

    #[tokio::test]
    async fn half_open_failure_reopens() {
        let cb = CircuitBreaker::new(test_config());
        for _ in 0..3 {
            cb.record_failure("ep1").await;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;

        assert!(cb.is_allowed("ep1").await);
        cb.record_failure("ep1").await;
        assert_eq!(cb.current_state("ep1").await, CircuitState::Open);
    }
}
