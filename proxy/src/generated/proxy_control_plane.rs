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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_type: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// A single runner endpoint that can serve inference requests.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerEndpoint {
    pub host: String,
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

/// The complete routing map, keyed by model name.
pub type RoutingMap = std::collections::HashMap<String, RoutingEntry>;

/// Type of routing map change published via Redis pub/sub.
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
