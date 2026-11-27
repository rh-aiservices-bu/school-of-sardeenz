//! Optional static API-key guard for the inference port (#332).

use axum::extract::{Request, State};
use axum::http::header::{HeaderMap, AUTHORIZATION};
use axum::middleware::Next;
use axum::response::Response;
use metrics::counter;
use subtle::ConstantTimeEq;

use crate::error::ProxyError;
use crate::state::AppState;

/// Middleware guard for `/openai/*` and `/oip/*`. With no configured keys it
/// is a pure pass-through. With keys configured, every request must carry
/// `Authorization: Bearer <key>`; the check runs before the request body is
/// read and before any parking or wake trigger (the handlers own both). On
/// success the client's `Authorization` header is stripped so it is never
/// forwarded to the runner; on failure a 401 in the shared JSON envelope is
/// returned. The key never appears in logs, metrics labels or the response.
pub async fn inference_key_guard(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Result<Response, ProxyError> {
    let keys = &state.config.inference_api_keys;
    if keys.is_empty() {
        return Ok(next.run(request).await);
    }

    if !is_authorized(keys, request.headers()) {
        record_rejection();
        return Err(ProxyError::Unauthorized);
    }

    // The client's Authorization is not forwarded to the runner when the key
    // is enabled. handlers.rs passes `parts.headers` straight into
    // `ForwardingClient::forward` and `authorization` is not a hop-by-hop
    // header, so stripping it here is the single enforcement point. Key
    // disabled → the header is still forwarded (today's behaviour).
    request.headers_mut().remove(AUTHORIZATION);
    Ok(next.run(request).await)
}

/// Exact `Bearer ` scheme, matching the control plane's hook
/// (`control-plane/src/server.ts`) and what OpenAI SDKs send.
fn presented_bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
}

/// Compare the presented bytes against every configured key, folding the
/// results with `|` — no early exit, so timing does not reveal which rotation
/// slot matched. Length check first, then constant-time compare (the same
/// shape as the control plane's `timingSafeEqual` guard; the length leak is
/// accepted there and here).
fn is_authorized(keys: &[String], headers: &HeaderMap) -> bool {
    presented_bearer(headers).is_some_and(|presented| {
        let presented = presented.as_bytes();
        keys.iter().fold(false, |acc, key| {
            let expected = key.as_bytes();
            acc | (presented.len() == expected.len() && bool::from(presented.ct_eq(expected)))
        })
    })
}

/// Increment the rejection counter. No labels — the key must never be a label
/// value, and the presented material is never recorded anywhere.
fn record_rejection() {
    counter!("sardeenz_proxy_inference_auth_rejections_total").increment(1);
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use crate::health::metrics::prometheus_builder;

    use super::*;

    fn keys(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    fn headers_with_authorization(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_str(value).unwrap());
        headers
    }

    #[test]
    fn bearer_scheme_and_key_rotation_matrix() {
        let configured = keys(&["key-old", "key-new"]);

        assert!(is_authorized(&configured, &headers_with_authorization("Bearer key-old")));
        assert!(is_authorized(&configured, &headers_with_authorization("Bearer key-new")));

        // No header, a wrong key, a different scheme and a bare key all fail.
        assert!(!is_authorized(&configured, &HeaderMap::new()));
        assert!(!is_authorized(&configured, &headers_with_authorization("Bearer wrong")));
        assert!(!is_authorized(&configured, &headers_with_authorization("Basic key-old")));
        assert!(!is_authorized(&configured, &headers_with_authorization("key-old")));
        assert!(!is_authorized(&configured, &headers_with_authorization("Bearer ")));
        // A prefix of a configured key is not a key.
        assert!(!is_authorized(&configured, &headers_with_authorization("Bearer key-ol")));
    }

    /// The integration harness's metrics macros no-op by design, so the
    /// counter is proven here: one rejection renders as a single unlabelled
    /// series that carries no key material.
    #[test]
    fn rejection_counter_is_unlabelled_and_leaks_no_key_material() {
        let recorder = prometheus_builder().build_recorder();
        let handle = recorder.handle();

        metrics::with_local_recorder(&recorder, record_rejection);

        let rendered = handle.render();
        let line = rendered
            .lines()
            .find(|line| line.starts_with("sardeenz_proxy_inference_auth_rejections_total"))
            .unwrap_or_else(|| panic!("rejection counter missing from render:\n{rendered}"));
        assert_eq!(
            line, "sardeenz_proxy_inference_auth_rejections_total 1",
            "counter must be unlabelled (the key is never a label value)"
        );
    }
}
