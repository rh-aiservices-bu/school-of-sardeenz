// @generated — do not edit by hand.
// Source: packages/contracts/specs/engine-runner.yaml

use serde::{Deserialize, Serialize};

/// Current state of the runner process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RunnerState {
    #[serde(rename = "STARTING")]
    Starting,
    #[serde(rename = "READY")]
    Ready,
    #[serde(rename = "BUSY")]
    Busy,
    #[serde(rename = "SLEEPING")]
    Sleeping,
    #[serde(rename = "ERROR")]
    Error,
}

/// Level of memory offload during sleep.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SleepLevel {
    #[serde(rename = "L1_HOST_RAM")]
    L1HostRam,
}

/// Type of compute device used by the runner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DeviceType {
    #[serde(rename = "CUDA")]
    Cuda,
    #[serde(rename = "ROCM")]
    Rocm,
    #[serde(rename = "CPU")]
    Cpu,
    #[serde(rename = "OTHER")]
    Other,
}

/// Category of workload the runner can serve.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ModelType {
    #[serde(rename = "LLM")]
    Llm,
    #[serde(rename = "DIFFUSION")]
    Diffusion,
    #[serde(rename = "PREDICTIVE")]
    Predictive,
    #[serde(rename = "EMBEDDING")]
    Embedding,
    #[serde(rename = "OTHER")]
    Other,
}

/// Current phase of the model loading process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum LoadingPhase {
    #[serde(rename = "INITIALIZING")]
    Initializing,
    #[serde(rename = "LOADING_WEIGHTS")]
    LoadingWeights,
    #[serde(rename = "ALLOCATING_MEMORY")]
    AllocatingMemory,
    #[serde(rename = "CAPTURING_GRAPHS")]
    CapturingGraphs,
    #[serde(rename = "WARMING_UP")]
    WarmingUp,
    #[serde(rename = "READY")]
    Ready,
}

/// Runner health and state information.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthStatus {
    pub state: RunnerState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<LoadingProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_requests: Option<u64>,
}

/// Memory consumption for a single compute device.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceMemoryUsage {
    pub device_index: u32,
    pub device_type: DeviceType,
    pub memory_used_bytes: i64,
    pub memory_total_bytes: i64,
}

/// Optional detailed breakdown of memory usage by category.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryBreakdown {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weights_bytes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kv_cache_bytes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activation_bytes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overhead_bytes: Option<i64>,
}

/// Aggregate memory consumption across all devices.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReport {
    pub devices: Vec<DeviceMemoryUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub breakdown: Option<MemoryBreakdown>,
}

/// Structured loading progress during runner startup.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadingProgress {
    pub phase: LoadingPhase,
    pub percent_complete: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_remaining_seconds: Option<u64>,
}

/// Error response returned by any endpoint on failure.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorResponse {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}
