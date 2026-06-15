use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use redis::AsyncCommands;
use tokio::sync::Mutex;

const DEBOUNCE_INTERVAL: Duration = Duration::from_secs(5);

/// Writes per-model inference timestamps to Redis for LRU eviction scoring.
///
/// Applies a local in-memory debounce (~5s per model) so that under high
/// throughput the proxy issues at most one Redis write per model per interval.
/// The Redis write is fire-and-forget — it never blocks the inference request.
#[derive(Clone)]
pub struct InferenceTracker {
    last_write: Arc<Mutex<HashMap<String, Instant>>>,
    conn: Arc<tokio::sync::OnceCell<redis::aio::ConnectionManager>>,
    redis_url: String,
    key_prefix: String,
}

impl InferenceTracker {
    pub fn new(redis_url: String, key_prefix: String) -> Self {
        Self {
            last_write: Arc::new(Mutex::new(HashMap::new())),
            conn: Arc::new(tokio::sync::OnceCell::new()),
            redis_url,
            key_prefix,
        }
    }

    /// Record that a model served an inference request. Checks the debounce
    /// cache synchronously; if a write is needed, spawns a background task.
    pub async fn record(&self, model_name: &str) {
        let now = Instant::now();
        {
            let mut cache = self.last_write.lock().await;
            if let Some(last) = cache.get(model_name) {
                if now.duration_since(*last) < DEBOUNCE_INTERVAL {
                    return;
                }
            }
            cache.insert(model_name.to_string(), now);
        }

        let tracker = self.clone();
        let model_name = model_name.to_string();
        tokio::spawn(async move {
            tracker.write_timestamp(&model_name).await;
        });
    }

    async fn get_conn(&self) -> Option<redis::aio::ConnectionManager> {
        let result = self
            .conn
            .get_or_try_init(|| async {
                let client = redis::Client::open(self.redis_url.as_str())?;
                redis::aio::ConnectionManager::new(client).await
            })
            .await;

        match result {
            Ok(conn) => Some(conn.clone()),
            Err(e) => {
                tracing::warn!(error = %e, "inference tracker: failed to connect to Redis");
                None
            }
        }
    }

    async fn write_timestamp(&self, model_name: &str) {
        let Some(mut conn) = self.get_conn().await else {
            return;
        };

        let key = format!("{}:inference:last:{}", self.key_prefix, model_name);
        let timestamp =
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        if let Err(e) = conn.set::<_, _, ()>(&key, &timestamp).await {
            tracing::warn!(key = %key, error = %e, "failed to write inference timestamp");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn debounce_skips_rapid_writes() {
        let tracker = InferenceTracker::new(
            "redis://not-connected:0".to_string(),
            "test".to_string(),
        );

        // First call should update the cache
        {
            let cache = tracker.last_write.lock().await;
            assert!(cache.get("model-a").is_none());
        }

        tracker.record("model-a").await;

        // Cache should now have an entry (the spawned Redis task will fail
        // silently since we're not connected)
        {
            let cache = tracker.last_write.lock().await;
            assert!(cache.get("model-a").is_some());
        }

        // Record the time, then call again — should be debounced
        let first_write = {
            let cache = tracker.last_write.lock().await;
            *cache.get("model-a").unwrap()
        };

        tracker.record("model-a").await;

        let second_check = {
            let cache = tracker.last_write.lock().await;
            *cache.get("model-a").unwrap()
        };

        // The timestamp should not have changed (debounced)
        assert_eq!(first_write, second_check);
    }

    #[tokio::test]
    async fn different_models_tracked_independently() {
        let tracker = InferenceTracker::new(
            "redis://not-connected:0".to_string(),
            "test".to_string(),
        );

        tracker.record("model-a").await;
        tracker.record("model-b").await;

        let cache = tracker.last_write.lock().await;
        assert!(cache.get("model-a").is_some());
        assert!(cache.get("model-b").is_some());
    }
}
