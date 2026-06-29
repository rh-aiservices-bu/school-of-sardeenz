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
