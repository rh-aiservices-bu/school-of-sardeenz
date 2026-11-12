import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { loadConfig } from '../config.js';

describe('loadConfig', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ['SARDEENZ_WORKER_TOKEN', 'SARDEENZ_ALLOW_UNAUTHENTICATED_API'];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('throws when SARDEENZ_WORKER_TOKEN is unset and the opt-out is absent', () => {
    expect(() => loadConfig()).toThrow(
      'SARDEENZ_WORKER_TOKEN must be set. ' +
        'Set SARDEENZ_ALLOW_UNAUTHENTICATED_API=true to run without authentication (dev only).',
    );
  });

  it('throws when SARDEENZ_WORKER_TOKEN is set to an empty string', () => {
    process.env['SARDEENZ_WORKER_TOKEN'] = '';
    expect(() => loadConfig()).toThrow('SARDEENZ_WORKER_TOKEN must be set.');
  });

  it('starts with SARDEENZ_ALLOW_UNAUTHENTICATED_API=true and no token', () => {
    process.env['SARDEENZ_ALLOW_UNAUTHENTICATED_API'] = 'true';
    expect(loadConfig().workerToken).toBe('');
  });

  it('starts with SARDEENZ_ALLOW_UNAUTHENTICATED_API=1 and no token', () => {
    process.env['SARDEENZ_ALLOW_UNAUTHENTICATED_API'] = '1';
    expect(loadConfig().workerToken).toBe('');
  });

  it('treats SARDEENZ_ALLOW_UNAUTHENTICATED_API=false like an absent opt-out', () => {
    process.env['SARDEENZ_ALLOW_UNAUTHENTICATED_API'] = 'false';
    expect(() => loadConfig()).toThrow(/SARDEENZ_ALLOW_UNAUTHENTICATED_API/);
  });

  it('starts when SARDEENZ_WORKER_TOKEN is set without the opt-out', () => {
    process.env['SARDEENZ_WORKER_TOKEN'] = 'test-worker-token';
    expect(loadConfig().workerToken).toBe('test-worker-token');
  });
});
