use crate::generated::proxy_control_plane::WakeTriggerRequest;

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
        let request = WakeTriggerRequest {
            model_name: model_name.to_string(),
            request_id: None,
        };

        let response = self
            .client
            .post(&url)
            .json(&request)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await?;

        if response.status().is_success() {
            tracing::info!(model_name, "wake trigger accepted");
            Ok(())
        } else {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            Err(anyhow::anyhow!(
                "wake trigger returned {status}: {body}"
            ))
        }
    }
}
