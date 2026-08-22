use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::error::ProxyError;

/// Caps the number of *forwarded* (in-flight upstream) requests, globally and
/// per-model. Deliberately scoped to the forwarding step only — a request
/// parked waiting for a sleeping model to wake never holds a permit, so this
/// limiter cannot deadlock against parking (a router/resolution-level limit
/// would: parked requests would hold a permit for the entire wake, starving
/// forwarding for everyone else). Per-tenant rate limiting is the ingress's
/// job, not the proxy's — see docs/architecture/components/proxy.md.
#[derive(Clone)]
pub struct ForwardingLimiter {
    max_global: usize,
    max_per_model: usize,
    global: Arc<AtomicUsize>,
    per_model: Arc<Mutex<HashMap<String, usize>>>,
}

impl ForwardingLimiter {
    /// `0` for either limit disables enforcement on that dimension.
    pub fn new(max_global: usize, max_per_model: usize) -> Self {
        Self {
            max_global,
            max_per_model,
            global: Arc::new(AtomicUsize::new(0)),
            per_model: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Atomically check both limits and reserve a permit for `model_name`.
    /// Returns a guard that releases the permit on drop — including on
    /// cancellation, since the guard is an ordinary local dropped when the
    /// handler future is torn down.
    pub fn try_acquire(&self, model_name: &str) -> Result<ForwardGuard, ProxyError> {
        {
            let mut per_model = self.per_model.lock().unwrap();
            let model_count = per_model.get(model_name).copied().unwrap_or(0);
            if self.max_per_model > 0 && model_count >= self.max_per_model {
                return Err(ProxyError::Overloaded(format!(
                    "forwarding concurrency limit reached for model: {model_name}"
                )));
            }
            *per_model.entry(model_name.to_string()).or_insert(0) += 1;
        }

        let prev_global = self.global.fetch_add(1, Ordering::SeqCst);
        if self.max_global > 0 && prev_global >= self.max_global {
            self.global.fetch_sub(1, Ordering::SeqCst);
            let mut per_model = self.per_model.lock().unwrap();
            if let Some(count) = per_model.get_mut(model_name) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    per_model.remove(model_name);
                }
            }
            return Err(ProxyError::Overloaded(
                "global forwarding concurrency limit reached".to_string(),
            ));
        }

        Ok(ForwardGuard {
            global: self.global.clone(),
            per_model: self.per_model.clone(),
            model_name: model_name.to_string(),
        })
    }
}

/// RAII guard for a reserved forwarding permit. Releases the global and
/// per-model counters on drop.
pub struct ForwardGuard {
    global: Arc<AtomicUsize>,
    per_model: Arc<Mutex<HashMap<String, usize>>>,
    model_name: String,
}

impl Drop for ForwardGuard {
    fn drop(&mut self) {
        self.global.fetch_sub(1, Ordering::SeqCst);
        let mut per_model = self.per_model.lock().unwrap();
        if let Some(count) = per_model.get_mut(&self.model_name) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                per_model.remove(&self.model_name);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unlimited_by_default() {
        let limiter = ForwardingLimiter::new(0, 0);
        let guards: Vec<_> = (0..100).map(|_| limiter.try_acquire("model-a").unwrap()).collect();
        assert_eq!(guards.len(), 100);
    }

    #[test]
    fn global_limit_rejects_when_full() {
        let limiter = ForwardingLimiter::new(1, 0);
        let _g1 = limiter.try_acquire("model-a").unwrap();
        assert!(matches!(limiter.try_acquire("model-b"), Err(ProxyError::Overloaded(_))));
    }

    #[test]
    fn global_limit_admits_after_release() {
        let limiter = ForwardingLimiter::new(1, 0);
        let g1 = limiter.try_acquire("model-a").unwrap();
        assert!(limiter.try_acquire("model-b").is_err());
        drop(g1);
        assert!(limiter.try_acquire("model-b").is_ok());
    }

    #[test]
    fn per_model_limit_is_independent_per_model() {
        let limiter = ForwardingLimiter::new(0, 1);
        let _g1 = limiter.try_acquire("model-a").unwrap();
        // Different model is unaffected by model-a's cap.
        assert!(limiter.try_acquire("model-b").is_ok());
        // Same model is rejected.
        assert!(limiter.try_acquire("model-a").is_err());
    }

    #[test]
    fn dropped_guard_releases_per_model_slot() {
        let limiter = ForwardingLimiter::new(0, 1);
        let g1 = limiter.try_acquire("model-a").unwrap();
        assert!(limiter.try_acquire("model-a").is_err());
        drop(g1);
        assert!(limiter.try_acquire("model-a").is_ok());
    }

    #[test]
    fn rejected_global_acquire_does_not_leak_per_model_count() {
        // model-a already at its per-model cap of 1 via a fresh acquire that
        // then fails on the global cap — the per-model increment must be
        // rolled back so a later, otherwise-valid acquire is not blocked.
        let limiter = ForwardingLimiter::new(1, 5);
        let _g1 = limiter.try_acquire("model-a").unwrap(); // consumes the only global permit
        assert!(limiter.try_acquire("model-a").is_err()); // rejected on global cap
        drop(_g1);
        // Should succeed twice now (per-model cap is 5, global freed).
        let _g2 = limiter.try_acquire("model-a").unwrap();
        let _g3 = limiter.try_acquire("model-a");
        assert!(_g3.is_err()); // global cap is 1, so only one at a time
    }
}
