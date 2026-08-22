use crate::generated::proxy_control_plane::{WakeTriggerRequest, WakeTriggerResponse};

/// HTTP client for sending wake triggers to the control plane.
#[derive(Clone)]
pub struct WakeTriggerClient {
    client: reqwest::Client,
    base_url: String,
}

impl WakeTriggerClient {
    pub fn new(control_plane_url: &str) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url: control_plane_url.trim_end_matches('/').to_string(),
        }
    }

    pub async fn trigger_wake(&self, model_name: &str) -> anyhow::Result<()> {
        let url = format!("{}/api/v1/wake", self.base_url);
        let request = WakeTriggerRequest { model_name: model_name.to_string(), request_id: None };

        let response = self
            .client
            .post(&url)
            .json(&request)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| {
                tracing::warn!(model_name, error = %e, "wake trigger transport error");
                anyhow::anyhow!("wake trigger transport error")
            })?;

        let status = response.status();
        if status.is_success() {
            // 2xx: inspect the WakeTriggerResponse. Be lenient — a body that
            // fails to deserialize must NOT break waking (a control-plane
            // serialization slip is not an outage), so fall back to the old
            // status-only success. See #98.
            let body = response.text().await.unwrap_or_default();
            match serde_json::from_str::<WakeTriggerResponse>(&body) {
                Ok(parsed) if !parsed.accepted => {
                    // Log control-plane detail server-side ONLY; the
                    // client-facing error must not disclose internal state.
                    tracing::warn!(
                        model_name,
                        current_state = ?parsed.current_state,
                        message = ?parsed.message,
                        "wake trigger soft-rejected by control plane"
                    );
                    Err(anyhow::anyhow!("control plane did not accept wake"))
                }
                Ok(_) => {
                    tracing::info!(model_name, "wake trigger accepted");
                    Ok(())
                }
                Err(e) => {
                    tracing::warn!(
                        model_name,
                        error = %e,
                        "wake response body did not deserialize; treating 2xx as success"
                    );
                    Ok(())
                }
            }
        } else {
            // Non-2xx: log status + body server-side, return a GENERIC error so
            // the control plane's response body never reaches the client. This
            // folds in #97's leak fix (project-lead decision 2026-08-21), using
            // the same generic-error-+-tracing::warn pattern #93 established.
            let body = response.text().await.unwrap_or_default();
            tracing::warn!(
                model_name,
                %status,
                body = ?body,
                "wake trigger returned non-success status"
            );
            Err(anyhow::anyhow!("wake trigger rejected by control plane"))
        }
    }
}
