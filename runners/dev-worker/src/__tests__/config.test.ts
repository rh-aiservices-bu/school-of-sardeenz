import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { loadConfig } from '../config.js';

describe('loadConfig', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    'SARDEENZ_WORKER_TOKEN',
    'SARDEENZ_ALLOW_UNAUTHENTICATED_API',
    'SARDEENZ_RUNNER_ENTRYPOINT',
    'SARDEENZ_RUNNER_CATALOG_URL',
    'SARDEENZ_ALLOW_INSECURE_CATALOG',
  ];

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

  it('throws when SARDEENZ_WORKER_TOKEN is whitespace-only (#268)', () => {
    process.env['SARDEENZ_WORKER_TOKEN'] = ' \t ';
    expect(() => loadConfig()).toThrow('SARDEENZ_WORKER_TOKEN must be set.');
  });

  it('starts on a whitespace-only token with the dev opt-out (#268)', () => {
    process.env['SARDEENZ_WORKER_TOKEN'] = '   ';
    process.env['SARDEENZ_ALLOW_UNAUTHENTICATED_API'] = 'true';
    expect(loadConfig().workerToken).toBe('   ');
  });

  it('keeps a token with surrounding whitespace byte-exact (#268)', () => {
    process.env['SARDEENZ_WORKER_TOKEN'] = ' padded-token ';
    expect(loadConfig().workerToken).toBe(' padded-token ');
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

  it('refuses to start when SARDEENZ_RUNNER_ENTRYPOINT resolves to an empty argv (#238)', () => {
    process.env['SARDEENZ_WORKER_TOKEN'] = 'test-worker-token';
    process.env['SARDEENZ_RUNNER_ENTRYPOINT'] = ',, '; // envList filters every segment out
    expect(() => loadConfig()).toThrow(/SARDEENZ_RUNNER_ENTRYPOINT/);
  });

  it('accepts a non-`-m` SARDEENZ_RUNNER_ENTRYPOINT override as a verbatim-only seed (#238)', () => {
    process.env['SARDEENZ_WORKER_TOKEN'] = 'test-worker-token';
    process.env['SARDEENZ_RUNNER_ENTRYPOINT'] = 'python3,sardeenz_vllm_runner.py';
    expect(loadConfig().apptainer.runnerEntrypoint).toEqual(['python3', 'sardeenz_vllm_runner.py']);
  });

  it('defaults SARDEENZ_RUNNER_CATALOG_URL to the official catalog (#289)', () => {
    process.env['SARDEENZ_WORKER_TOKEN'] = 'test-worker-token';
    expect(loadConfig().catalogUrl).toBe(
      'https://raw.githubusercontent.com/rh-aiservices-bu/school-of-sardeenz/refs/heads/main/runners.yaml',
    );
  });

  it('honours an explicit SARDEENZ_RUNNER_CATALOG_URL', () => {
    process.env['SARDEENZ_WORKER_TOKEN'] = 'test-worker-token';
    process.env['SARDEENZ_RUNNER_CATALOG_URL'] = '/weights/runners.yaml';
    expect(loadConfig().catalogUrl).toBe('/weights/runners.yaml');
  });

  it('defaults SARDEENZ_ALLOW_INSECURE_CATALOG to false', () => {
    process.env['SARDEENZ_WORKER_TOKEN'] = 'test-worker-token';
    expect(loadConfig().allowInsecureCatalog).toBe(false);
  });

  it('parses SARDEENZ_ALLOW_INSECURE_CATALOG=true', () => {
    process.env['SARDEENZ_WORKER_TOKEN'] = 'test-worker-token';
    process.env['SARDEENZ_ALLOW_INSECURE_CATALOG'] = 'true';
    expect(loadConfig().allowInsecureCatalog).toBe(true);
    process.env['SARDEENZ_ALLOW_INSECURE_CATALOG'] = '0';
    expect(loadConfig().allowInsecureCatalog).toBe(false);
  });
});
