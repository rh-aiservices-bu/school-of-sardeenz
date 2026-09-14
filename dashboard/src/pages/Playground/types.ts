/**
 * Minimal local OpenAI-ish chat types for the playground.
 *
 * No generated types exist for these — `@sardeenz/types` only carries the control-plane OpenAPI
 * schemas, and the OpenAI-compatible chat completion shape is not part of that contract (the
 * proxy speaks it directly; see issue #122's implementation guidance). Defining these locally is
 * expected and is NOT an OpenAPI change.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionBody {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** Non-streaming `POST /chat/completions` response (the fields the playground reads). */
export interface ChatCompletionResponse {
  choices: {
    message?: { role?: string; content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: ChatUsage;
}

/** Latency/throughput figures attached to a bot message once a turn finishes. */
export interface PlaygroundMessageMetrics {
  latencyMs: number;
  ttftMs?: number;
  tokensPerSecond?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface PlaygroundMessageError {
  message: string;
  statusCode?: number;
}

/** One rendered bubble in a chat pane (user prompt or model reply). */
export interface PlaygroundMessage {
  id: string;
  role: 'user' | 'bot';
  content: string;
  timestamp: string;
  isLoading?: boolean;
  metrics?: PlaygroundMessageMetrics;
  error?: PlaygroundMessageError;
}
