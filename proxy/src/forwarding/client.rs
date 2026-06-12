use axum::body::Body;
use axum::http::{Request, Response};

use crate::generated::proxy_control_plane::RunnerEndpoint;

/// HTTP client for forwarding requests to runner endpoints.
#[derive(Clone)]
pub struct ForwardingClient {
    client: reqwest::Client,
}

impl Default for ForwardingClient {
    fn default() -> Self {
        Self::new()
    }
}

impl ForwardingClient {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .pool_max_idle_per_host(64)
                .pool_idle_timeout(std::time::Duration::from_secs(120))
                .tcp_nodelay(true)
                .build()
                .expect("failed to build HTTP client"),
        }
    }

    /// Forward an inference request to the given runner endpoint.
    pub async fn forward(
        &self,
        endpoint: &RunnerEndpoint,
        path: &str,
        request: Request<Body>,
    ) -> Result<Response<Body>, anyhow::Error> {
        let url = format!("http://{}:{}{}", endpoint.host, endpoint.port, path);

        let (parts, body) = request.into_parts();
        let body_bytes = axum::body::to_bytes(body, 10 * 1024 * 1024).await?;

        let mut req_builder = self
            .client
            .request(parts.method, &url)
            .body(body_bytes.clone());

        for (key, value) in &parts.headers {
            if key == "host" {
                continue;
            }
            req_builder = req_builder.header(key, value);
        }

        let response = req_builder.send().await?;

        let status = response.status();
        let headers = response.headers().clone();
        let stream = response.bytes_stream();

        let mut builder = Response::builder().status(status);
        for (key, value) in &headers {
            builder = builder.header(key, value);
        }

        let body = Body::from_stream(stream);
        Ok(builder.body(body)?)
    }
}
