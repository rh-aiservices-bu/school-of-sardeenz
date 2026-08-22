use axum::body::Body;
use axum::http::{HeaderMap, Method, Response};
use bytes::Bytes;

use crate::generated::proxy_control_plane::RunnerEndpoint;

const HOP_BY_HOP_HEADERS: &[&str] = &[
    "connection",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// HTTP client for forwarding requests to runner endpoints.
#[derive(Clone)]
pub struct ForwardingClient {
    client: reqwest::Client,
    timeout: std::time::Duration,
}

impl Default for ForwardingClient {
    fn default() -> Self {
        Self::new(std::time::Duration::from_secs(300))
    }
}

impl ForwardingClient {
    pub fn new(timeout: std::time::Duration) -> Self {
        Self {
            client: reqwest::Client::builder()
                .pool_max_idle_per_host(64)
                .pool_idle_timeout(std::time::Duration::from_secs(120))
                .tcp_nodelay(true)
                .build()
                .expect("failed to build HTTP client"),
            timeout,
        }
    }

    /// Forward an inference request to the given runner endpoint.
    ///
    /// Accepts pre-buffered body bytes to avoid redundant re-buffering.
    pub async fn forward(
        &self,
        endpoint: &RunnerEndpoint,
        path: &str,
        method: Method,
        headers: &HeaderMap,
        body: Bytes,
    ) -> Result<Response<Body>, anyhow::Error> {
        let url = format!("http://{}:{}{}", endpoint.host, endpoint.port, path);

        let mut req_builder = self.client.request(method, &url).timeout(self.timeout).body(body);

        for (key, value) in headers {
            if key == "host" {
                continue;
            }
            if HOP_BY_HOP_HEADERS.iter().any(|h| key.as_str().eq_ignore_ascii_case(h)) {
                continue;
            }
            req_builder = req_builder.header(key, value);
        }

        let response = req_builder.send().await?;

        let status = response.status();
        let resp_headers = response.headers().clone();
        let stream = response.bytes_stream();

        let mut builder = Response::builder().status(status);
        for (key, value) in &resp_headers {
            if HOP_BY_HOP_HEADERS.iter().any(|h| key.as_str().eq_ignore_ascii_case(h)) {
                continue;
            }
            builder = builder.header(key, value);
        }

        let body = Body::from_stream(stream);
        Ok(builder.body(body)?)
    }
}
