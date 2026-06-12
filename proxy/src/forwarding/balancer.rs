use std::sync::atomic::{AtomicUsize, Ordering};

use crate::generated::proxy_control_plane::RunnerEndpoint;

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
        Self {
            counter: AtomicUsize::new(0),
        }
    }

    /// Select the next endpoint from a list using weighted round-robin.
    /// Endpoints with weight 0 or unhealthy are skipped.
    pub fn pick<'a>(&self, endpoints: &'a [RunnerEndpoint]) -> Option<&'a RunnerEndpoint> {
        let healthy: Vec<&RunnerEndpoint> = endpoints
            .iter()
            .filter(|ep| ep.healthy && ep.weight > 0)
            .collect();

        if healthy.is_empty() {
            return None;
        }

        // Build expanded list based on weights
        let expanded: Vec<&RunnerEndpoint> = healthy
            .iter()
            .flat_map(|ep| std::iter::repeat_n(*ep, ep.weight as usize))
            .collect();

        if expanded.is_empty() {
            return None;
        }

        let idx = self.counter.fetch_add(1, Ordering::Relaxed) % expanded.len();
        Some(expanded[idx])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(host: &str, weight: u32, healthy: bool) -> RunnerEndpoint {
        RunnerEndpoint {
            host: host.to_string(),
            port: 8000,
            weight,
            healthy,
            runner_id: None,
        }
    }

    #[test]
    fn picks_healthy_endpoints() {
        let balancer = WeightedRoundRobin::new();
        let endpoints = vec![
            endpoint("a", 1, true),
            endpoint("b", 1, false),
            endpoint("c", 1, true),
        ];

        let picked: Vec<_> = (0..4).map(|_| balancer.pick(&endpoints).unwrap().host.clone()).collect();
        assert!(picked.iter().all(|h| h == "a" || h == "c"));
    }

    #[test]
    fn respects_weights() {
        let balancer = WeightedRoundRobin::new();
        let endpoints = vec![
            endpoint("heavy", 3, true),
            endpoint("light", 1, true),
        ];

        let mut counts = std::collections::HashMap::new();
        for _ in 0..100 {
            let ep = balancer.pick(&endpoints).unwrap();
            *counts.entry(ep.host.clone()).or_insert(0) += 1;
        }

        assert!(counts["heavy"] > counts["light"]);
    }

    #[test]
    fn returns_none_for_empty() {
        let balancer = WeightedRoundRobin::new();
        assert!(balancer.pick(&[]).is_none());
    }
}
