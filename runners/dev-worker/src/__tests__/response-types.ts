/**
 * Shared response body shapes for dev-worker tests.
 *
 * These types describe only the fields the tests actually assert on; they are
 * not meant to be exhaustive contracts for the runner-stub/worker HTTP APIs.
 */

// --- Worker registration (Redis-backed WorkerInfo / memory report) ---

export interface WorkerInfoCapability {
  runnerType: string;
  engineName: string;
  supportedModelTypes: string[];
  supportedDeviceTypes: string[];
  supportedSleepLevels: string[];
}

export interface WorkerInfoDevice {
  deviceIndex: number;
  deviceType: string;
  memoryTotalBytes: number;
}

export interface WorkerInfo {
  capabilities: WorkerInfoCapability[];
  devices: WorkerInfoDevice[];
  managementUrl: string;
}

export interface WorkerMemoryReportDevice {
  deviceIndex: number;
  deviceType: string;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
}

export interface WorkerMemoryReport {
  devices: WorkerMemoryReportDevice[];
}

// --- Runner stub: health / memory-report / capabilities / progress / sleep ---

export interface HealthResponse {
  state: string;
  activeRequests: number;
}

export interface MemoryReportDevice {
  deviceIndex: number;
  deviceType: string;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
}

export interface MemoryReportResponse {
  devices: MemoryReportDevice[];
}

export interface CapabilitiesResponse {
  runnerType: string;
  engineName: string;
  engineVersion: string;
  supportedModelTypes: string[];
  supportedDeviceTypes: string[];
  supportedSleepLevels: string[];
  maxTensorParallelism: number;
  features: { streamingInference: boolean };
}

export interface ProgressResponse {
  phase: string;
  percentComplete: number;
  message: string;
}

export interface SleepStatusResponse {
  isSleeping: boolean;
  level?: string;
}

export interface SleepResponse {
  state: string;
  level: string;
  deviceMemoryFreedBytes: number;
}

export interface WakeResponse {
  state: string;
}

export interface ErrorResponse {
  error?: string;
  code: string;
  details?: {
    currentState?: string;
    supportedLevels?: string[];
  };
}

// --- Runner stub: OpenAI-compatible chat completions ---

export interface ChatCompletionMessage {
  role: string;
  content: string;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  finish_reason: string;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
}

export interface ChatCompletionErrorResponse {
  error: {
    message: string;
    type: string;
    code: string;
  };
}

export interface ModelInfo {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface ModelsListResponse {
  object: string;
  data: ModelInfo[];
}

export interface ChatCompletionChunkDelta {
  content?: string;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: string | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
}
