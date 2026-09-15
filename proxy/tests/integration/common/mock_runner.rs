// Mock runner HTTP server.
//
// Implements the subset of the OpenAI API used by the proxy:
//   POST /v1/chat/completions
//   POST /v1/completions
//   GET  /v1/models
//
// Supports both regular JSON responses and SSE streaming.
// Can be configured to fail a fixed number of requests (for circuit-breaker
// tests) or to track how many requests it received (for round-robin tests).

use std::net::SocketAddr;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use std::sync::Mutex;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use tokio::net::TcpListener;
use tokio::sync::Notify;

/// Shared state threaded through the mock runner.
#[derive(Clone)]
pub struct RunnerState {
    /// Model name this runner pretends to serve.
    pub model_name: String,
    /// Increment on every request received.
    pub request_count: Arc<AtomicUsize>,
    /// If > 0, fail this many requests with 500 before succeeding.
    pub fail_count: Arc<AtomicUsize>,
    /// Notify that fires after each request (useful in tests that need to
    /// await the request arriving).
    pub received: Arc<Notify>,
    /// Gate the handler waits on before responding. Defaults to an
    /// effectively-unlimited pool of permits so ordinary tests never block.
    /// Tests that need to hold a request in flight (e.g. forwarding
    /// concurrency limit tests) construct one with zero permits via
    /// `RunnerState::new_gated` and release it with `gate.add_permits(..)`.
    pub gate: Arc<tokio::sync::Semaphore>,
    /// Path (as seen by the runner, post prefix-strip) of the last V2 infer
    /// request received. Lets a test assert the proxy stripped `/oip` before
    /// forwarding (#125).
    pub last_v2_infer_path: Arc<Mutex<Option<String>>>,
}

impl RunnerState {
    pub fn new(model_name: &str) -> Self {
        Self {
            model_name: model_name.to_string(),
            request_count: Arc::new(AtomicUsize::new(0)),
            fail_count: Arc::new(AtomicUsize::new(0)),
            received: Arc::new(Notify::new()),
            gate: Arc::new(tokio::sync::Semaphore::new(tokio::sync::Semaphore::MAX_PERMITS)),
            last_v2_infer_path: Arc::new(Mutex::new(None)),
        }
    }

    #[allow(dead_code)]
    pub fn with_failures(model_name: &str, failures: usize) -> Self {
        let s = Self::new(model_name);
        s.fail_count.store(failures, Ordering::SeqCst);
        s
    }

    /// A runner state whose handler blocks on `gate` (zero permits to start)
    /// until the test calls `gate.add_permits(..)`.
    #[allow(dead_code)]
    pub fn new_gated(model_name: &str) -> Self {
        let mut s = Self::new(model_name);
        s.gate = Arc::new(tokio::sync::Semaphore::new(0));
        s
    }
}

/// A running mock runner server.
pub struct MockRunner {
    pub addr: SocketAddr,
    pub state: RunnerState,
}

impl MockRunner {
    /// Spawn a mock runner and return its address plus shared state.
    pub async fn spawn(model_name: &str) -> Self {
        Self::spawn_with_state(RunnerState::new(model_name)).await
    }

    #[allow(dead_code)]
    pub async fn spawn_failing(model_name: &str, failures: usize) -> Self {
        Self::spawn_with_state(RunnerState::with_failures(model_name, failures)).await
    }

    pub async fn spawn_with_state(state: RunnerState) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let app = Router::new()
            .route("/v1/chat/completions", post(handle_inference))
            .route("/v1/completions", post(handle_inference))
            .route("/v1/models", get(handle_models))
            .route("/v2/models/{model}/infer", post(handle_v2_infer))
            .route("/v2/models/{model}/ready", get(handle_v2_ready))
            .with_state(state.clone());

        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        MockRunner { addr, state }
    }

    /// Number of requests received so far.
    pub fn request_count(&self) -> usize {
        self.state.request_count.load(Ordering::SeqCst)
    }

    /// Path (post prefix-strip) of the last V2 infer request received, if any.
    #[allow(dead_code)]
    pub fn last_v2_infer_path(&self) -> Option<String> {
        self.state.last_v2_infer_path.lock().unwrap().clone()
    }
}

async fn handle_inference(
    State(state): State<RunnerState>,
    req: Request<Body>,
) -> impl IntoResponse {
    state.request_count.fetch_add(1, Ordering::SeqCst);
    state.received.notify_waiters();

    // Held while `gate` has no permits — lets tests keep a "forwarded"
    // request in flight to exercise the forwarding concurrency limiter.
    let _permit = state.gate.acquire().await.unwrap();

    // Fail the first N requests.
    let remaining = state.fail_count.load(Ordering::SeqCst);
    if remaining > 0 {
        state.fail_count.fetch_sub(1, Ordering::SeqCst);
        return (StatusCode::INTERNAL_SERVER_ERROR, Body::from("runner error")).into_response();
    }

    // Peek at request body to decide streaming vs. non-streaming.
    let (_parts, body) = req.into_parts();
    let body_bytes = axum::body::to_bytes(body, 1024 * 1024).await.unwrap_or_default();
    let body_json: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap_or_default();

    let streaming = body_json.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);

    if streaming {
        sse_response(&state.model_name).into_response()
    } else {
        json_response(&state.model_name).into_response()
    }
}

/// V2 (OIP) infer handler: `POST /v2/models/{model}/infer`. Mirrors
/// `handle_inference`'s gate/fail_count/request_count behavior but returns a
/// KServe V2-shaped body, and records the path it was called on so a test can
/// assert the proxy stripped the `/oip` prefix before forwarding (#125).
async fn handle_v2_infer(
    State(state): State<RunnerState>,
    Path(model): Path<String>,
    req: Request<Body>,
) -> impl IntoResponse {
    state.request_count.fetch_add(1, Ordering::SeqCst);
    state.received.notify_waiters();
    *state.last_v2_infer_path.lock().unwrap() =
        Some(req.uri().path_and_query().map(|pq| pq.as_str().to_string()).unwrap_or_default());

    let _permit = state.gate.acquire().await.unwrap();

    let remaining = state.fail_count.load(Ordering::SeqCst);
    if remaining > 0 {
        state.fail_count.fetch_sub(1, Ordering::SeqCst);
        return (StatusCode::INTERNAL_SERVER_ERROR, Body::from("runner error")).into_response();
    }

    let body = serde_json::json!({
        "model_name": model,
        "outputs": [],
    });
    (StatusCode::OK, axum::Json(body)).into_response()
}

/// V2 (OIP) readiness handler: `GET /v2/models/{model}/ready`.
async fn handle_v2_ready(Path(_model): Path<String>) -> impl IntoResponse {
    (StatusCode::OK, axum::Json(serde_json::json!({"ready": true})))
}

async fn handle_models(State(state): State<RunnerState>) -> impl IntoResponse {
    let body = serde_json::json!({
        "object": "list",
        "data": [{
            "id": state.model_name,
            "object": "model",
            "created": 0,
            "owned_by": "sardeenz-test",
        }]
    });
    axum::Json(body)
}

/// A standard non-streaming chat completion response.
fn json_response(model: &str) -> impl IntoResponse {
    let body = serde_json::json!({
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "created": 1718000000u64,
        "model": model,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Hello from mock runner!"
            },
            "finish_reason": "stop"
        }],
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 6,
            "total_tokens": 16
        }
    });
    (StatusCode::OK, axum::Json(body))
}

/// An SSE streaming response (mimics the OpenAI SSE format).
fn sse_response(model: &str) -> impl IntoResponse {
    let chunk1 = format!(
        "data: {}\n\n",
        serde_json::json!({
            "id": "chatcmpl-test",
            "object": "chat.completion.chunk",
            "created": 1718000000u64,
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant", "content": "Hello"},
                "finish_reason": null
            }]
        })
    );
    let chunk2 = format!(
        "data: {}\n\n",
        serde_json::json!({
            "id": "chatcmpl-test",
            "object": "chat.completion.chunk",
            "created": 1718000000u64,
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {"content": " world!"},
                "finish_reason": "stop"
            }]
        })
    );
    let done = "data: [DONE]\n\n".to_string();

    let body_str = format!("{chunk1}{chunk2}{done}");

    (
        StatusCode::OK,
        [("content-type", "text/event-stream"), ("cache-control", "no-cache")],
        body_str,
    )
}
