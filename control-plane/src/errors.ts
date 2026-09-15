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
  | 'PROXY_PROTOCOL_UNSUPPORTED'
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

  /**
   * A model-level action is refused because one specific instance is in a transient state, named
   * explicitly (state + id) rather than folded into an aggregate. For a mixed-state model (e.g.
   * ACTIVE + STARTING) the aggregate can be a settled value, which would misleadingly claim the
   * model is deletable; this reports the offending instance the operator can act on (#174).
   */
  static invalidInstanceState(
    modelName: string,
    instanceId: string,
    instanceState: string,
    action: string,
  ): ControlPlaneError {
    return new ControlPlaneError(
      409,
      'INVALID_STATE',
      `Cannot ${action} model ${modelName}: instance ${instanceId} is in ${instanceState} state`,
      { modelName, instanceId, currentState: instanceState, action },
    );
  }

  /**
   * A model-level action is refused because another mutating operation (a delete, a stop, or an
   * instance-scoped op) is already backgrounding for the same model. Distinct from
   * `invalidState`/`invalidInstanceState` (which report a lifecycle state) so a client can tell
   * "wait for the launch to settle" from "an op is already running, do nothing" — same
   * `INVALID_STATE` code, distinct message, and a machine-readable `details.reason` (#173/#174).
   */
  static operationInProgress(
    modelName: string,
    action: string,
    reason: string,
    detail: string,
  ): ControlPlaneError {
    return new ControlPlaneError(
      409,
      'INVALID_STATE',
      `Cannot ${action} model ${modelName}: ${detail}`,
      { modelName, action, reason },
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

  static proxyProtocolUnsupported(protocol: string, supported: string[]): ControlPlaneError {
    return new ControlPlaneError(
      409,
      'PROXY_PROTOCOL_UNSUPPORTED',
      `Runner protocol '${protocol}' is not supported by the running proxy ` +
        `(supports: ${supported.join(', ') || 'none'}). A proxy upgrade is required ` +
        `before importing this runner.`,
      { protocol, supported },
    );
  }

  static unauthorized(): ControlPlaneError {
    return new ControlPlaneError(401, 'UNAUTHORIZED', 'Missing or invalid API token');
  }
}
