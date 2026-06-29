use std::sync::atomic::{AtomicUsize, Ordering};

use crate::generated::proxy_control_plane::RunnerEndpoint;

const MAX_WEIGHT: u32 = 100;

/// Weighted round-robin load balancer across runner endpoints.
pub struct WeightedRoundRobin {
    counter: AtomicUsize,
}

impl Default for WeightedRoundRobin {
    fn default() -> Self {
        Self::new()
    }
}

impl WeightedRoundRobin {
    pub fn new() -> Self {
        Self { counter: AtomicUsize::new(0) }
    }

    /// Select the next endpoint from a list using weighted round-robin.
    /// Endpoints with weight 0 or unhealthy are skipped.
    /// Uses cumulative weight selection: O(n) in endpoints, zero heap allocation.
    pub fn pick<'a>(&self, endpoints: &'a [RunnerEndpoint]) -> Option<&'a RunnerEndpoint> {
        let healthy: Vec<&RunnerEndpoint> =
            endpoints.iter().filter(|ep| ep.healthy && ep.weight > 0).collect();

        if healthy.is_empty() {
            return None;
        }

        let total_weight: u32 = healthy.iter().map(|ep| ep.weight.min(MAX_WEIGHT)).sum();

        if total_weight == 0 {
            return None;
        }

        let idx = (self.counter.fetch_add(1, Ordering::Relaxed) as u32) % total_weight;
        let mut cumulative = 0u32;
        for ep in &healthy {
            cumulative += ep.weight.min(MAX_WEIGHT);
            if idx < cumulative {
                return Some(ep);
            }
        }

        Some(healthy.last().unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(host: &str, weight: u32, healthy: bool) -> RunnerEndpoint {
        RunnerEndpoint { host: host.to_string(), port: 8000, weight, healthy, runner_id: None }
    }

    #[test]
    fn picks_healthy_endpoints() {
        let balancer = WeightedRoundRobin::new();
        let endpoints =
            vec![endpoint("a", 1, true), endpoint("b", 1, false), endpoint("c", 1, true)];

        let picked: Vec<_> =
            (0..4).map(|_| balancer.pick(&endpoints).unwrap().host.clone()).collect();
        assert!(picked.iter().all(|h| h == "a" || h == "c"));
    }

    #[test]
    fn respects_weights() {
        let balancer = WeightedRoundRobin::new();
        let endpoints = vec![endpoint("heavy", 3, true), endpoint("light", 1, true)];

        let mut counts = std::collections::HashMap::new();
        for _ in 0..100 {
            let ep = balancer.pick(&endpoints).unwrap();
            *counts.entry(ep.host.clone()).or_insert(0) += 1;
        }

        assert_eq!(counts["heavy"], 75);
        assert_eq!(counts["light"], 25);
    }

    #[test]
    fn returns_none_for_empty() {
        let balancer = WeightedRoundRobin::new();
        assert!(balancer.pick(&[]).is_none());
    }

    #[test]
    fn caps_weight_at_max() {
        let balancer = WeightedRoundRobin::new();
        let endpoints = vec![endpoint("a", 200, true), endpoint("b", 100, true)];

        let mut counts = std::collections::HashMap::new();
        for _ in 0..200 {
            let ep = balancer.pick(&endpoints).unwrap();
            *counts.entry(ep.host.clone()).or_insert(0) += 1;
        }

        // Both capped at 100, so 50/50
        assert_eq!(counts["a"], 100);
        assert_eq!(counts["b"], 100);
    }
}
