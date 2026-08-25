// Hand-maintained Rust types mirroring packages/contracts/specs/proxy-control-plane.yaml.
// When the spec changes, update these types to match.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Routing-level state of a model as seen by the proxy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ModelState {
    #[serde(rename = "ACTIVE")]
    Active,
    #[serde(rename = "SLEEPING")]
    Sleeping,
    #[serde(rename = "STARTING")]
    Starting,
    #[serde(rename = "DRAINING")]
    Draining,
    #[serde(rename = "ERROR")]
    Error,
}

/// Protocol family a model speaks / proxy path prefix it is invoked under.
/// Mirrors the `Protocol` schema. Closed by design (a new protocol is a
/// coordinated spec + mirror + proxy-release change — see issue #125 item 6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Protocol {
    #[serde(rename = "openai")]
    Openai,
    #[serde(rename = "oip")]
    Oip,
}

/// Request to wake a sleeping model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeTriggerRequest {
    pub model_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// Acknowledgement that the wake trigger has been received.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeTriggerResponse {
    pub accepted: bool,
    pub model_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_state: Option<ModelState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Routing information for a single model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingEntry {
    pub model_name: String,
    pub state: ModelState,
    pub protocol: Protocol,
    pub endpoints: Vec<RunnerEndpoint>,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<RoutingEntryMetadata>,
}

/// Optional metadata about a model in the routing map.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingEntryMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owned_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_model_len: Option<u64>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// A single runner endpoint that can serve inference requests.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerEndpoint {
    #[serde(deserialize_with = "validate_host")]
    pub host: String,
    #[serde(deserialize_with = "validate_port")]
    pub port: u16,
    #[serde(default = "default_weight")]
    pub weight: u32,
    pub healthy: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runner_id: Option<String>,
}

fn default_weight() -> u32 {
    1
}

fn validate_host<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let host = String::deserialize(deserializer)?;
    if host.is_empty() {
        return Err(serde::de::Error::custom("host must not be empty"));
    }
    if host.chars().any(|c| matches!(c, '/' | '@' | '?' | '#') || c.is_whitespace()) {
        return Err(serde::de::Error::custom(
            "host must not contain '/', '@', '?', '#', or whitespace",
        ));
    }
    Ok(host)
}

fn validate_port<'de, D>(deserializer: D) -> Result<u16, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let port = u16::deserialize(deserializer)?;
    if port == 0 {
        return Err(serde::de::Error::custom("port must not be 0"));
    }
    Ok(port)
}

/// The complete routing map, keyed by model name.
pub type RoutingMap = std::collections::HashMap<String, RoutingEntry>;

/// Type of routing map change published via Redis pub/sub.
// Not yet consumed by the proxy — the redis_sync loop currently re-fetches
// the full routing map on any pub/sub message rather than applying deltas.
// See #99.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RoutingMapUpdateType {
    #[serde(rename = "MODEL_STATE_CHANGED")]
    ModelStateChanged,
    #[serde(rename = "ENDPOINT_ADDED")]
    EndpointAdded,
    #[serde(rename = "ENDPOINT_REMOVED")]
    EndpointRemoved,
    #[serde(rename = "ENDPOINT_UPDATED")]
    EndpointUpdated,
    #[serde(rename = "MODEL_ADDED")]
    ModelAdded,
    #[serde(rename = "MODEL_REMOVED")]
    ModelRemoved,
}

/// Published to the `sardeenz:routing-updates` Redis pub/sub channel.
// Not yet consumed by the proxy — see #99.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingMapUpdate {
    #[serde(rename = "type")]
    pub update_type: RoutingMapUpdateType,
    pub model_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<ModelState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<RunnerEndpoint>,
    pub timestamp: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint_json(host: &str, port: i64) -> String {
        format!(r#"{{"host":"{host}","port":{port},"healthy":true}}"#)
    }

    #[test]
    fn rejects_host_with_slash() {
        let result: Result<RunnerEndpoint, _> =
            serde_json::from_str(&endpoint_json("evil/host", 8000));
        assert!(result.is_err());
    }

    #[test]
    fn rejects_host_with_at() {
        let result: Result<RunnerEndpoint, _> =
            serde_json::from_str(&endpoint_json("user@host", 8000));
        assert!(result.is_err());
    }

    #[test]
    fn rejects_host_with_whitespace() {
        let result: Result<RunnerEndpoint, _> =
            serde_json::from_str(&endpoint_json("host name", 8000));
        assert!(result.is_err());
    }

    #[test]
    fn rejects_empty_host() {
        let result: Result<RunnerEndpoint, _> = serde_json::from_str(&endpoint_json("", 8000));
        assert!(result.is_err());
    }

    #[test]
    fn rejects_port_zero() {
        let result: Result<RunnerEndpoint, _> =
            serde_json::from_str(&endpoint_json("10.244.1.5", 0));
        assert!(result.is_err());
    }

    #[test]
    fn accepts_valid_endpoint() {
        let result: Result<RunnerEndpoint, _> =
            serde_json::from_str(&endpoint_json("10.244.1.5", 8000));
        let endpoint = result.expect("valid endpoint should deserialize");
        assert_eq!(endpoint.host, "10.244.1.5");
        assert_eq!(endpoint.port, 8000);
    }

    #[test]
    fn weight_defaults_to_one() {
        let result: Result<RunnerEndpoint, _> =
            serde_json::from_str(&endpoint_json("10.244.1.5", 8000));
        let endpoint = result.expect("valid endpoint should deserialize");
        assert_eq!(endpoint.weight, 1);
    }
}
