use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    #[error("model not found: {0}")]
    ModelNotFound(String),

    #[error("model unavailable: {0}")]
    ModelUnavailable(String),

    #[error("parking timeout for model: {0}")]
    ParkingTimeout(String),

    #[error("parking limit reached for model: {0}")]
    ParkingLimitReached(String),

    #[error("all endpoints unhealthy for model: {0}")]
    AllEndpointsUnhealthy(String),

    #[error("bad request: {0}")]
    BadRequest(String),

    #[error("upstream error: {0}")]
    Upstream(String),

    #[error("redis error: {0}")]
    Redis(#[from] redis::RedisError),

    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl ProxyError {
    pub fn status_code(&self) -> StatusCode {
        match self {
            ProxyError::ModelNotFound(_) => StatusCode::NOT_FOUND,
            ProxyError::ModelUnavailable(_)
            | ProxyError::ParkingTimeout(_)
            | ProxyError::ParkingLimitReached(_)
            | ProxyError::AllEndpointsUnhealthy(_) => StatusCode::SERVICE_UNAVAILABLE,
            ProxyError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ProxyError::Upstream(_) => StatusCode::BAD_GATEWAY,
            ProxyError::Redis(_) | ProxyError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for ProxyError {
    fn into_response(self) -> Response {
        let status = self.status_code();
        let message = match &self {
            ProxyError::Redis(_) | ProxyError::Internal(_) => "internal error".to_string(),
            _ => self.to_string(),
        };

        let body = serde_json::json!({
            "error": {
                "message": message,
                "type": error_type(&self),
            }
        });

        (status, axum::Json(body)).into_response()
    }
}

fn error_type(err: &ProxyError) -> &'static str {
    match err {
        ProxyError::ModelNotFound(_) => "model_not_found",
        ProxyError::ModelUnavailable(_) => "model_unavailable",
        ProxyError::ParkingTimeout(_) => "parking_timeout",
        ProxyError::ParkingLimitReached(_) => "parking_limit_reached",
        ProxyError::AllEndpointsUnhealthy(_) => "all_endpoints_unhealthy",
        ProxyError::BadRequest(_) => "invalid_request_error",
        ProxyError::Upstream(_) => "upstream_error",
        ProxyError::Redis(_) => "internal_error",
        ProxyError::Internal(_) => "internal_error",
    }
}
