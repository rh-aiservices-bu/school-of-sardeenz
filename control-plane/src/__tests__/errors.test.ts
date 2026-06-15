import { describe, it, expect } from 'vitest';

import { ControlPlaneError } from '../errors.js';

describe('ControlPlaneError', () => {
  it('creates a model not found error', () => {
    const err = ControlPlaneError.modelNotFound('test-model');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('MODEL_NOT_FOUND');
    expect(err.message).toContain('test-model');
  });

  it('creates a model already exists error', () => {
    const err = ControlPlaneError.modelAlreadyExists('test-model');
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('MODEL_ALREADY_EXISTS');
  });

  it('creates an invalid state error', () => {
    const err = ControlPlaneError.invalidState('test-model', 'STOPPED', 'wake');
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('INVALID_STATE');
    expect(err.message).toContain('STOPPED');
    expect(err.message).toContain('wake');
  });

  it('serializes to a response object', () => {
    const err = ControlPlaneError.workerNotFound('w1');
    const response = err.toResponse();

    expect(response.error).toContain('w1');
    expect(response.code).toBe('WORKER_NOT_FOUND');
    expect(response.details).toEqual({ workerId: 'w1' });
  });

  it('omits details when not provided', () => {
    const err = ControlPlaneError.notLeader();
    const response = err.toResponse();

    expect(response.details).toBeUndefined();
  });
});
