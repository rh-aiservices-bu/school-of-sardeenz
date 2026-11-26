import { ClientDisconnectedError } from './clients/upstream-signal.js';

export type BffErrorCode =
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'REDIS_ERROR'
  | 'PROMETHEUS_ERROR'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

export interface ErrorDetail {
  readonly error: string;
  readonly code: BffErrorCode;
  readonly details?: Record<string, unknown>;
}

export class BffError extends Error {
  readonly code: BffErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: BffErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BffError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toResponse(): ErrorDetail {
    return {
      error: this.message,
      code: this.code,
      ...(this.details ? { details: this.details } : {}),
    };
  }

  static upstreamError(message: string, details?: Record<string, unknown>): BffError {
    return new BffError(502, 'UPSTREAM_ERROR', message, details);
  }

  static upstreamTimeout(service: string): BffError {
    return new BffError(504, 'UPSTREAM_TIMEOUT', `Upstream service timed out: ${service}`, {
      service,
    });
  }

  static notFound(resource: string): BffError {
    return new BffError(404, 'NOT_FOUND', `Not found: ${resource}`);
  }

  static invalidRequest(message: string): BffError {
    return new BffError(400, 'INVALID_REQUEST', message);
  }
}

/** True when an error (or abort rejection cause) is the browser client disconnecting —
 *  not an upstream fault. The global error handler logs it at info level instead of as an
 *  unhandled error, and the clients never map it to a 5xx. */
export function isClientDisconnect(error: unknown): boolean {
  return error instanceof ClientDisconnectedError;
}

/**
 * Classifies a rejection from a buffered upstream call — the `fetch` itself or the response
 * body read, both covered by the composed signal. Rethrows the disconnect unchanged (it must
 * never surface as a 5xx) and maps an abort timeout to 504 `UPSTREAM_TIMEOUT`. Returns
 * normally for anything else so the caller can apply its own fault mapping.
 */
export function rethrowUpstreamAbort(error: unknown, service: string): void {
  if (isClientDisconnect(error)) throw error;
  if (error instanceof Error && error.name === 'TimeoutError') {
    throw BffError.upstreamTimeout(service);
  }
}
