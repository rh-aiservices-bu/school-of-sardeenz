// Mock control plane HTTP server.
//
// Implements the wake trigger endpoint:
//   POST /api/v1/wake
//
// The mock tracks wake counts and can optionally update a `RoutingMapCache`
// after a configurable delay to simulate the model coming alive.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::post;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use sardeenz_proxy::generated::proxy_control_plane::{
    ModelState, RoutingEntry, RunnerEndpoint, WakeTriggerRequest, WakeTriggerResponse,
};
use sardeenz_proxy::routing::RoutingMapCache;

// ---------------------------------------------------------------------------
// Shared mock-CP state (accessible after spawn)
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct MockCpShared {
    /// Per-model wake count.
    pub wake_counts: Arc<Mutex<HashMap<String, usize>>>,
    /// Total wake calls across all models.
    pub total_wakes: Arc<AtomicUsize>,
}

impl MockCpShared {
    pub async fn wake_count_for(&self, model: &str) -> usize {
        self.wake_counts
            .lock()
            .await
            .get(model)
            .copied()
            .unwrap_or(0)
    }

    #[allow(dead_code)]
    pub fn total_wakes(&self) -> usize {
        self.total_wakes.load(Ordering::SeqCst)
    }
}

// ---------------------------------------------------------------------------
// Handler state — wired at spawn time
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct HandlerState {
    shared: MockCpShared,
    /// On wake, after `delay`, write an Active entry for (model, addr) into
    /// `cache`.
    wake_actions: Arc<Vec<WakeAction>>,
    fail_wakes: bool,
}

struct WakeAction {
    model_name: String,
    runner_addr: SocketAddr,
    cache: RoutingMapCache,
    delay: Duration,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

pub struct MockControlPlane {
    pub addr: SocketAddr,
    pub shared: MockCpShared,
}

impl MockControlPlane {
    /// Convenience: check how many times `model` was woken.
    pub async fn wake_count_for(&self, model: &str) -> usize {
        self.shared.wake_count_for(model).await
    }

    #[allow(dead_code)]
    pub fn total_wakes(&self) -> usize {
        self.shared.total_wakes()
    }
}

pub struct MockControlPlaneBuilder {
    fail_wakes: bool,
    wake_actions: Vec<WakeAction>,
}

impl MockControlPlaneBuilder {
    pub fn new() -> Self {
        Self {
            fail_wakes: false,
            wake_actions: Vec::new(),
        }
    }

    /// When a wake for `model_name` arrives, update `cache` to Active (after
    /// `delay`) pointing the runner at `runner_addr`.
    pub fn on_wake_activate(
        mut self,
        model_name: &str,
        runner_addr: SocketAddr,
        cache: RoutingMapCache,
        delay: Duration,
    ) -> Self {
        self.wake_actions.push(WakeAction {
            model_name: model_name.to_string(),
            runner_addr,
            cache,
            delay,
        });
        self
    }

    /// Fail all wake requests with HTTP 500.
    #[allow(dead_code)]
    pub fn fail_wakes(mut self) -> Self {
        self.fail_wakes = true;
        self
    }

    pub async fn spawn(self) -> MockControlPlane {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let shared = MockCpShared {
            wake_counts: Arc::new(Mutex::new(HashMap::new())),
            total_wakes: Arc::new(AtomicUsize::new(0)),
        };

        let state = HandlerState {
            shared: shared.clone(),
            wake_actions: Arc::new(self.wake_actions),
            fail_wakes: self.fail_wakes,
        };

        let app = Router::new()
            .route("/api/v1/wake", post(handle_wake))
            .with_state(state);

        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        MockControlPlane { addr, shared }
    }
}

async fn handle_wake(
    State(state): State<HandlerState>,
    axum::Json(req): axum::Json<WakeTriggerRequest>,
) -> impl IntoResponse {
    state.shared.total_wakes.fetch_add(1, Ordering::SeqCst);

    {
        let mut counts = state.shared.wake_counts.lock().await;
        *counts.entry(req.model_name.clone()).or_insert(0) += 1;
    }

    if state.fail_wakes {
        let resp = WakeTriggerResponse {
            accepted: false,
            model_name: req.model_name,
            current_state: None,
            message: Some("mock failure".to_string()),
        };
        return (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(resp)).into_response();
    }

    // Fire any matching wake actions asynchronously.
    for action in state.wake_actions.iter() {
        if action.model_name == req.model_name {
            let cache = action.cache.clone();
            let model = action.model_name.clone();
            let runner_addr = action.runner_addr;
            let delay = action.delay;

            tokio::spawn(async move {
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                let entry = build_active_entry(&model, runner_addr);
                cache.update_entry(model, entry).await;
            });
        }
    }

    let resp = WakeTriggerResponse {
        accepted: true,
        model_name: req.model_name,
        current_state: Some(ModelState::Starting),
        message: None,
    };
    (StatusCode::OK, axum::Json(resp)).into_response()
}

/// Build an Active RoutingEntry pointing at a runner.
pub fn build_active_entry(model_name: &str, runner_addr: SocketAddr) -> RoutingEntry {
    RoutingEntry {
        model_name: model_name.to_string(),
        state: ModelState::Active,
        endpoints: vec![RunnerEndpoint {
            host: runner_addr.ip().to_string(),
            port: runner_addr.port(),
            weight: 1,
            healthy: true,
            runner_id: None,
        }],
        updated_at: "2024-01-01T00:00:00Z".to_string(),
        metadata: None,
    }
}
