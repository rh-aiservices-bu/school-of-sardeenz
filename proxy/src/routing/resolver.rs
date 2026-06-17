use crate::error::ProxyError;
use crate::generated::proxy_control_plane::{ModelState, RoutingEntry};
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

    pub async fn resolve(&self, model_name: &str) -> Result<Resolution, ProxyError> {
        let entry = self
            .cache
            .get(model_name)
            .await
            .ok_or_else(|| ProxyError::ModelNotFound(model_name.to_string()))?;

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
