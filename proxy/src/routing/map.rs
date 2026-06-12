use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{watch, RwLock};

use crate::generated::proxy_control_plane::{ModelState, RoutingEntry, RoutingMap};

/// In-memory cache of the routing map, refreshed via Redis pub/sub.
#[derive(Clone)]
pub struct RoutingMapCache {
    inner: Arc<RwLock<RoutingMap>>,
    notify: watch::Sender<()>,
    receiver: watch::Receiver<()>,
}

impl Default for RoutingMapCache {
    fn default() -> Self {
        Self::new()
    }
}

impl RoutingMapCache {
    pub fn new() -> Self {
        let (notify, receiver) = watch::channel(());
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
            notify,
            receiver,
        }
    }

    pub async fn get(&self, model_name: &str) -> Option<RoutingEntry> {
        self.inner.read().await.get(model_name).cloned()
    }

    pub async fn get_all(&self) -> RoutingMap {
        self.inner.read().await.clone()
    }

    pub async fn replace(&self, map: RoutingMap) {
        *self.inner.write().await = map;
        let _ = self.notify.send(());
    }

    #[allow(dead_code)]
    pub async fn update_entry(&self, model_name: String, entry: RoutingEntry) {
        self.inner.write().await.insert(model_name, entry);
        let _ = self.notify.send(());
    }

    #[allow(dead_code)]
    pub async fn remove_entry(&self, model_name: &str) {
        self.inner.write().await.remove(model_name);
        let _ = self.notify.send(());
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
            .filter(|(_, entry)| entry.state == state)
            .map(|(name, _)| name.clone())
            .collect()
    }
}
