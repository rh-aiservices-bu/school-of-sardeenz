use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

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

    /// Returns the current state of the circuit for the given endpoint key.
    pub async fn state(&self, key: &str) -> CircuitState {
        let mut circuits = self.circuits.lock().await;
        let circuit = circuits
            .entry(key.to_string())
            .or_insert_with(|| EndpointCircuit {
                state: CircuitState::Closed,
                failures: Vec::new(),
                last_state_change: Instant::now(),
            });

        // Check if an open circuit should transition to half-open
        if circuit.state == CircuitState::Open
            && circuit.last_state_change.elapsed() >= self.config.recovery_timeout
        {
            circuit.state = CircuitState::HalfOpen;
            circuit.last_state_change = Instant::now();
        }

        circuit.state
    }

    pub async fn record_success(&self, key: &str) {
        let mut circuits = self.circuits.lock().await;
        if let Some(circuit) = circuits.get_mut(key) {
            circuit.state = CircuitState::Closed;
            circuit.failures.clear();
            circuit.last_state_change = Instant::now();
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
            });

        let now = Instant::now();
        circuit.failures.push(now);

        // Remove failures outside the window
        let window_start = now - self.config.failure_window;
        circuit.failures.retain(|&t| t >= window_start);

        if circuit.failures.len() >= self.config.failure_threshold as usize {
            circuit.state = CircuitState::Open;
            circuit.last_state_change = now;
        }
    }

    pub async fn is_allowed(&self, key: &str) -> bool {
        matches!(
            self.state(key).await,
            CircuitState::Closed | CircuitState::HalfOpen
        )
    }

    /// Get circuit breaker state as a numeric gauge value for Prometheus.
    #[allow(dead_code)]
    pub async fn state_gauge(&self, key: &str) -> f64 {
        match self.state(key).await {
            CircuitState::Closed => 0.0,
            CircuitState::Open => 1.0,
            CircuitState::HalfOpen => 2.0,
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
        }
    }

    #[tokio::test]
    async fn starts_closed() {
        let cb = CircuitBreaker::new(test_config());
        assert_eq!(cb.state("ep1").await, CircuitState::Closed);
    }

    #[tokio::test]
    async fn trips_after_threshold() {
        let cb = CircuitBreaker::new(test_config());
        for _ in 0..3 {
            cb.record_failure("ep1").await;
        }
        assert_eq!(cb.state("ep1").await, CircuitState::Open);
    }

    #[tokio::test]
    async fn recovers_to_half_open() {
        let cb = CircuitBreaker::new(test_config());
        for _ in 0..3 {
            cb.record_failure("ep1").await;
        }
        assert_eq!(cb.state("ep1").await, CircuitState::Open);

        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(cb.state("ep1").await, CircuitState::HalfOpen);
    }

    #[tokio::test]
    async fn success_resets_to_closed() {
        let cb = CircuitBreaker::new(test_config());
        for _ in 0..3 {
            cb.record_failure("ep1").await;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
        cb.record_success("ep1").await;
        assert_eq!(cb.state("ep1").await, CircuitState::Closed);
    }
}
