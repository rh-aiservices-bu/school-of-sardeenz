use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{watch, OwnedRwLockReadGuard, RwLock};

use crate::generated::proxy_control_plane::{ModelState, RoutingEntry, RoutingMap};

/// In-memory cache of the routing map, refreshed via Redis pub/sub.
#[derive(Clone)]
pub struct RoutingMapCache {
    inner: Arc<RwLock<HashMap<String, CachedEntry>>>,
    notify: watch::Sender<()>,
    receiver: watch::Receiver<()>,
}

#[derive(Clone)]
struct CachedEntry {
    value: RoutingEntry,
    /// Requests hold a read lease from final endpoint selection through the upstream response.
    /// A destructive map replacement takes the write side before publishing its acknowledgement.
    gate: Arc<RwLock<()>>,
}

/// A routing snapshot whose old-generation requests are visible to propagation barriers.
pub struct RoutingLease {
    pub entry: RoutingEntry,
    _guard: OwnedRwLockReadGuard<()>,
}

impl Default for RoutingMapCache {
    fn default() -> Self {
        Self::new()
    }
}

impl RoutingMapCache {
    pub fn new() -> Self {
        let (notify, receiver) = watch::channel(());
        Self { inner: Arc::new(RwLock::new(HashMap::new())), notify, receiver }
    }

    pub async fn get(&self, model_name: &str) -> Option<RoutingEntry> {
        self.inner.read().await.get(model_name).map(|entry| entry.value.clone())
    }

    pub async fn get_all(&self) -> RoutingMap {
        self.inner
            .read()
            .await
            .iter()
            .map(|(name, entry)| (name.clone(), entry.value.clone()))
            .collect()
    }

    pub async fn replace(&self, map: RoutingMap) {
        // Only changes that can make a previously selectable endpoint unavailable need to wait.
        // Endpoint additions and diagnostic timestamp changes can publish immediately.
        let mut gates = {
            let current = self.inner.read().await;
            current
                .iter()
                .filter(|(name, old)| requires_quiescence(&old.value, map.get(*name)))
                .map(|(name, old)| (name.clone(), old.gate.clone()))
                .collect::<Vec<_>>()
        };
        gates.sort_by(|a, b| a.0.cmp(&b.0));

        // Acquiring the old generation's write side waits for all requests that selected through
        // it to finish. A request that raced us either acquired its read lease first (we wait) or
        // observes the new generation after the swap in get_with_lease.
        let mut quiescence_guards = Vec::with_capacity(gates.len());
        for (_, gate) in gates {
            quiescence_guards.push(gate.write_owned().await);
        }

        let mut current = self.inner.write().await;
        let next = map
            .into_iter()
            .map(|(name, value)| {
                let gate = match current.get(&name) {
                    Some(old) if !requires_quiescence(&old.value, Some(&value)) => old.gate.clone(),
                    _ => Arc::new(RwLock::new(())),
                };
                (name, CachedEntry { value, gate })
            })
            .collect();
        *current = next;
        drop(current);
        let _ = self.notify.send(());
        drop(quiescence_guards);
    }

    /// Acquire a current routing entry and pin its generation until the returned lease is dropped.
    /// The post-acquire identity check closes the race where a destructive writer obtains the gate
    /// between our map lookup and read-lock acquisition.
    pub async fn get_with_lease(&self, model_name: &str) -> Option<RoutingLease> {
        loop {
            let snapshot = self.inner.read().await.get(model_name).cloned()?;
            let guard = snapshot.gate.clone().read_owned().await;
            let still_current = self
                .inner
                .read()
                .await
                .get(model_name)
                .is_some_and(|current| Arc::ptr_eq(&current.gate, &snapshot.gate));
            if still_current {
                return Some(RoutingLease { entry: snapshot.value, _guard: guard });
            }
            drop(guard);
        }
    }

    /// Wait until every request admitted through the current cache generations has finished.
    /// Redis disconnect handling marks the proxy unavailable first, then calls this before
    /// removing its presence key so a control-plane cutover cannot mistake "not admitting" for
    /// "no old request is still using the runner".
    pub async fn quiesce_all(&self) {
        let mut gates = self
            .inner
            .read()
            .await
            .iter()
            .map(|(name, entry)| (name.clone(), entry.gate.clone()))
            .collect::<Vec<_>>();
        gates.sort_by(|a, b| a.0.cmp(&b.0));

        let mut guards = Vec::with_capacity(gates.len());
        for (_, gate) in gates {
            guards.push(gate.write_owned().await);
        }
    }

    #[allow(dead_code)]
    pub async fn update_entry(&self, model_name: String, entry: RoutingEntry) {
        let mut map = self.get_all().await;
        map.insert(model_name, entry);
        self.replace(map).await;
    }

    #[allow(dead_code)]
    pub async fn remove_entry(&self, model_name: &str) {
        let mut map = self.get_all().await;
        map.remove(model_name);
        self.replace(map).await;
    }

    /// Subscribe to routing map changes. Returns a receiver that can be used
    /// to wait for state transitions (used by the parking subsystem).
    pub fn subscribe(&self) -> watch::Receiver<()> {
        self.receiver.clone()
    }

    #[allow(dead_code)]
    pub async fn models_in_state(&self, state: ModelState) -> Vec<String> {
        self.inner
            .read()
            .await
            .iter()
            .filter(|(_, entry)| entry.value.state == state)
            .map(|(name, _)| name.clone())
            .collect()
    }
}

fn requires_quiescence(old: &RoutingEntry, new: Option<&RoutingEntry>) -> bool {
    if old.state == ModelState::Active && new.is_none_or(|entry| entry.state != ModelState::Active)
    {
        return true;
    }

    old.endpoints.iter().any(|old_endpoint| {
        old_endpoint.healthy
            && old_endpoint.weight > 0
            && new.is_none_or(|entry| {
                !entry.endpoints.iter().any(|new_endpoint| {
                    new_endpoint.host == old_endpoint.host
                        && new_endpoint.port == old_endpoint.port
                        && new_endpoint.healthy
                        && new_endpoint.weight > 0
                })
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generated::proxy_control_plane::{Protocol, RunnerEndpoint};

    fn entry(weight: u32) -> RoutingEntry {
        RoutingEntry {
            model_name: "m1".to_string(),
            state: ModelState::Active,
            protocol: Protocol::Openai,
            endpoints: vec![RunnerEndpoint {
                host: "127.0.0.1".to_string(),
                port: 8000,
                weight,
                healthy: true,
                runner_id: Some("runner-old".to_string()),
            }],
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            metadata: None,
        }
    }

    #[tokio::test]
    async fn destructive_replace_waits_for_old_generation_requests() {
        let cache = RoutingMapCache::new();
        cache.replace(HashMap::from([("m1".to_string(), entry(1))])).await;
        let lease = cache.get_with_lease("m1").await.unwrap();

        let replacing = {
            let cache = cache.clone();
            tokio::spawn(async move {
                cache.replace(HashMap::from([("m1".to_string(), entry(0))])).await;
            })
        };
        tokio::task::yield_now().await;
        assert!(!replacing.is_finished());

        drop(lease);
        replacing.await.unwrap();
        assert_eq!(cache.get("m1").await.unwrap().endpoints[0].weight, 0);
    }

    #[tokio::test]
    async fn additive_replace_does_not_wait_for_existing_requests() {
        let cache = RoutingMapCache::new();
        cache.replace(HashMap::from([("m1".to_string(), entry(1))])).await;
        let _lease = cache.get_with_lease("m1").await.unwrap();
        let mut with_replica = entry(1);
        with_replica.endpoints.push(RunnerEndpoint {
            host: "127.0.0.2".to_string(),
            port: 8001,
            weight: 1,
            healthy: true,
            runner_id: Some("runner-new".to_string()),
        });

        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            cache.replace(HashMap::from([("m1".to_string(), with_replica)])),
        )
        .await
        .expect("endpoint additions must not wait for the old generation");
    }

    #[tokio::test]
    async fn disconnect_quiescence_waits_for_current_generation_requests() {
        let cache = RoutingMapCache::new();
        cache.replace(HashMap::from([("m1".to_string(), entry(1))])).await;
        let lease = cache.get_with_lease("m1").await.unwrap();

        let quiescing = {
            let cache = cache.clone();
            tokio::spawn(async move { cache.quiesce_all().await })
        };
        tokio::task::yield_now().await;
        assert!(!quiescing.is_finished());

        drop(lease);
        quiescing.await.unwrap();
    }
}
