use crate::error::ProxyError;
use crate::generated::proxy_control_plane::{ModelState, Protocol, RoutingEntry};
use crate::routing::RoutingMapCache;

/// Resolves a model name to a routing entry and determines the request flow.
pub struct ModelResolver {
    cache: RoutingMapCache,
}

#[allow(dead_code)]
pub enum Resolution {
    /// Model is active — forward to one of the endpoints.
    Active(RoutingEntry),
    /// Model is sleeping — enter the parking flow.
    Sleeping(RoutingEntry),
    /// Model is starting (wake already in progress) — park without wake trigger.
    Starting(RoutingEntry),
}

impl ModelResolver {
    pub fn new(cache: RoutingMapCache) -> Self {
        Self { cache }
    }

    /// Resolves `model_name` on a surface of the `expected` family, admitting the
    /// entry only if it carries that family's tag (404 before the state match).
    ///
    /// `expected` is the protocol family of the surface the request arrived on
    /// (`Protocol::Openai` for `/openai/*`, `Protocol::Oip` for `/oip/*`). An
    /// entry tagged with the other family answers `ModelNotFoundUnderProtocol`
    /// (404) *before* the state match, so:
    /// - a cross-family request never parks, wakes or forwards, and
    /// - a cross-family `DRAINING`/`ERROR` entry is "not here" (404), never 503.
    pub async fn resolve(
        &self,
        model_name: &str,
        expected: Protocol,
    ) -> Result<Resolution, ProxyError> {
        let entry = self
            .cache
            .get(model_name)
            .await
            .ok_or_else(|| ProxyError::ModelNotFound(model_name.to_string()))?;

        if entry.protocol != expected {
            return Err(ProxyError::ModelNotFoundUnderProtocol(model_name.to_string()));
        }

        match entry.state {
            ModelState::Active => Ok(Resolution::Active(entry)),
            ModelState::Sleeping => Ok(Resolution::Sleeping(entry)),
            ModelState::Starting => Ok(Resolution::Starting(entry)),
            ModelState::Draining => {
                Err(ProxyError::ModelUnavailable(format!("{model_name} is draining")))
            }
            ModelState::Error => {
                Err(ProxyError::ModelUnavailable(format!("{model_name} is in error state")))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generated::proxy_control_plane::{Protocol, RunnerEndpoint};

    fn entry(state: ModelState, protocol: Protocol) -> RoutingEntry {
        RoutingEntry {
            model_name: "m1".to_string(),
            state,
            protocol,
            endpoints: vec![RunnerEndpoint {
                host: "127.0.0.1".to_string(),
                port: 8000,
                weight: 1,
                healthy: true,
                runner_id: None,
            }],
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            metadata: None,
        }
    }

    async fn resolver_for(state: ModelState, protocol: Protocol) -> ModelResolver {
        let cache = RoutingMapCache::new();
        cache.update_entry("m1".to_string(), entry(state, protocol)).await;
        ModelResolver::new(cache)
    }

    fn is_cross_family(err: &ProxyError) -> bool {
        matches!(err, ProxyError::ModelNotFoundUnderProtocol(name) if name == "m1")
    }

    /// `Resolution` derives no `Debug`, so `Result::expect_err` is unavailable — unwrap manually.
    async fn expect_error(resolver: &ModelResolver, expected: Protocol) -> ProxyError {
        match resolver.resolve("m1", expected).await {
            Err(err) => err,
            Ok(_) => panic!("expected resolve() to fail"),
        }
    }

    #[tokio::test]
    async fn resolve_rejects_cross_family_active() {
        let resolver = resolver_for(ModelState::Active, Protocol::Oip).await;
        let err = expect_error(&resolver, Protocol::Openai).await;
        assert!(is_cross_family(&err), "expected ModelNotFoundUnderProtocol, got {err:?}");
    }

    #[tokio::test]
    async fn resolve_rejects_cross_family_sleeping() {
        let resolver = resolver_for(ModelState::Sleeping, Protocol::Oip).await;
        let err = expect_error(&resolver, Protocol::Openai).await;
        assert!(is_cross_family(&err), "expected ModelNotFoundUnderProtocol, got {err:?}");
    }

    /// The 404 must outrank the 503 states: a cross-family DRAINING entry is "not here", not
    /// "draining".
    #[tokio::test]
    async fn resolve_rejects_cross_family_draining() {
        let resolver = resolver_for(ModelState::Draining, Protocol::Oip).await;
        let err = expect_error(&resolver, Protocol::Openai).await;
        assert!(is_cross_family(&err), "expected ModelNotFoundUnderProtocol, got {err:?}");
    }

    /// Same family: unchanged behaviour for every state (Active/Sleeping/Starting resolve,
    /// Draining/Error remain ModelUnavailable — never the protocol variant).
    #[tokio::test]
    async fn resolve_accepts_same_family() {
        use Resolution::*;

        let active = resolver_for(ModelState::Active, Protocol::Openai).await;
        assert!(matches!(active.resolve("m1", Protocol::Openai).await, Ok(Active(_))));

        let sleeping = resolver_for(ModelState::Sleeping, Protocol::Openai).await;
        assert!(matches!(sleeping.resolve("m1", Protocol::Openai).await, Ok(Sleeping(_))));

        let starting = resolver_for(ModelState::Starting, Protocol::Openai).await;
        assert!(matches!(starting.resolve("m1", Protocol::Openai).await, Ok(Starting(_))));

        for state in [ModelState::Draining, ModelState::Error] {
            let resolver = resolver_for(state, Protocol::Openai).await;
            let err = expect_error(&resolver, Protocol::Openai).await;
            assert!(
                matches!(&err, ProxyError::ModelUnavailable(_)),
                "{state:?} same-family must stay ModelUnavailable, got {err:?}"
            );
        }

        // And the reverse direction accepts an oip entry on the oip surface.
        let oip = resolver_for(ModelState::Active, Protocol::Oip).await;
        assert!(matches!(oip.resolve("m1", Protocol::Oip).await, Ok(Resolution::Active(_))));
    }
}
