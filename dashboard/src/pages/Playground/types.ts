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
