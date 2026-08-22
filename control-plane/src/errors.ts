export type ErrorCode =
  | 'MODEL_NOT_FOUND'
  | 'MODEL_ALREADY_EXISTS'
  | 'INVALID_STATE'
  | 'WORKER_NOT_FOUND'
  | 'PLACEMENT_FAILED'
  | 'EVICTION_FAILED'
  | 'RUNNER_UNAVAILABLE'
  | 'RUNNER_TIMEOUT'
  | 'NOT_LEADER'
  | 'REDIS_ERROR'
  | 'DATABASE_ERROR'
  | 'INVALID_REQUEST'
  | 'CATALOG_NOT_FOUND'
  | 'CATALOG_FETCH_FAILED'
  | 'MODULE_IN_USE'
  | 'UNAUTHORIZED'
  | 'INTERNAL_ERROR';

export interface ErrorDetail {
  readonly error: string;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
}

export class ControlPlaneError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
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

  static modelNotFound(modelName: string): ControlPlaneError {
    return new ControlPlaneError(404, 'MODEL_NOT_FOUND', `Model not found: ${modelName}`, {
      modelName,
    });
  }

  static modelAlreadyExists(modelName: string): ControlPlaneError {
    return new ControlPlaneError(
      409,
      'MODEL_ALREADY_EXISTS',
      `Model already exists: ${modelName}`,
      {
        modelName,
      },
    );
  }

  static invalidState(modelName: string, currentState: string, action: string): ControlPlaneError {
    return new ControlPlaneError(
      409,
      'INVALID_STATE',
      `Cannot ${action} model ${modelName}: current state is ${currentState}`,
      { modelName, currentState, action },
    );
  }

  static workerNotFound(workerId: string): ControlPlaneError {
    return new ControlPlaneError(404, 'WORKER_NOT_FOUND', `Worker not found: ${workerId}`, {
      workerId,
    });
  }

  static placementFailed(modelName: string, reason: string): ControlPlaneError {
    return new ControlPlaneError(
      503,
      'PLACEMENT_FAILED',
      `Placement failed for ${modelName}: ${reason}`,
      {
        modelName,
        reason,
      },
    );
  }

  static notLeader(): ControlPlaneError {
    return new ControlPlaneError(503, 'NOT_LEADER', 'This instance is not the active leader');
  }

  static invalidRequest(message: string): ControlPlaneError {
    return new ControlPlaneError(400, 'INVALID_REQUEST', message);
  }

  static catalogEntryNotFound(id: string): ControlPlaneError {
    return new ControlPlaneError(404, 'CATALOG_NOT_FOUND', `Catalog entry not found: ${id}`, {
      id,
    });
  }

  static catalogFetchFailed(message: string): ControlPlaneError {
    return new ControlPlaneError(
      502,
      'CATALOG_FETCH_FAILED',
      `Failed to fetch catalog: ${message}`,
    );
  }

  static moduleInUse(id: string): ControlPlaneError {
    return new ControlPlaneError(
      409,
      'MODULE_IN_USE',
      `Module for ${id} is in use by a running runner; stop dependent models first`,
      { id },
    );
  }

  static unauthorized(): ControlPlaneError {
    return new ControlPlaneError(401, 'UNAUTHORIZED', 'Missing or invalid API token');
  }
}
