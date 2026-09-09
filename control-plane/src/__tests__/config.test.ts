import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { loadConfig, redactUrl } from '../config.js';

describe('loadConfig', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    'SARDEENZ_CONTROL_PLANE_LISTEN_ADDR',
    'SARDEENZ_LISTEN_ADDR',
    'SARDEENZ_LOG_LEVEL',
    'SARDEENZ_REDIS_URL',
    'SARDEENZ_DATABASE_URL',
    'SARDEENZ_REDIS_KEY_PREFIX',
    'SARDEENZ_EVICTION_MAX_PER_CYCLE',
    'SARDEENZ_SLEEP_TIMEOUT_SECS',
    'SARDEENZ_SIF_IMPORTER',
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

  it('uses defaults when no env vars set', () => {
    const config = loadConfig();
    expect(config.listenAddr).toBe('0.0.0.0');
    expect(config.listenPort).toBe(3000);
    expect(config.logLevel).toBe('info');
    expect(config.redisKeyPrefix).toBe('sardeenz');
    expect(config.evictionMaxPerCycle).toBe(3);
    expect(config.sifImporter).toBe('oras');
  });

  it('reads SARDEENZ_CONTROL_PLANE_LISTEN_ADDR from env', () => {
    process.env['SARDEENZ_CONTROL_PLANE_LISTEN_ADDR'] = '127.0.0.1:3100';
    const config = loadConfig();
    expect(config.listenAddr).toBe('127.0.0.1');
    expect(config.listenPort).toBe(3100);
  });

  it('falls back to the legacy SARDEENZ_LISTEN_ADDR', () => {
    process.env['SARDEENZ_LISTEN_ADDR'] = '127.0.0.1:3200';
    const config = loadConfig();
    expect(config.listenPort).toBe(3200);
  });

  it('prefers SARDEENZ_CONTROL_PLANE_LISTEN_ADDR over the legacy name', () => {
    process.env['SARDEENZ_CONTROL_PLANE_LISTEN_ADDR'] = '127.0.0.1:3100';
    process.env['SARDEENZ_LISTEN_ADDR'] = '127.0.0.1:3200';
    const config = loadConfig();
    expect(config.listenPort).toBe(3100);
  });

  it('reads SARDEENZ_LOG_LEVEL from env', () => {
    process.env['SARDEENZ_LOG_LEVEL'] = 'debug';
    const config = loadConfig();
    expect(config.logLevel).toBe('debug');
  });

  it('reads integer env vars', () => {
    process.env['SARDEENZ_EVICTION_MAX_PER_CYCLE'] = '10';
    const config = loadConfig();
    expect(config.evictionMaxPerCycle).toBe(10);
  });

  it('allows the placeholder importer only when explicitly requested', () => {
    process.env['SARDEENZ_SIF_IMPORTER'] = 'stub';
    expect(loadConfig().sifImporter).toBe('stub');
  });

  it('rejects an invalid importer instead of silently selecting the placeholder', () => {
    process.env['SARDEENZ_SIF_IMPORTER'] = 'oraz';
    expect(() => loadConfig()).toThrow(
      'Environment variable SARDEENZ_SIF_IMPORTER must be "oras" or "stub", got: oraz',
    );
  });
});

describe('redactUrl', () => {
  it('masks password in URL', () => {
    const result = redactUrl('redis://user:secret@localhost:6379/0');
    expect(result).toContain('***');
    expect(result).not.toContain('secret');
  });

  it('passes through URLs without password', () => {
    const result = redactUrl('redis://localhost:6379');
    expect(result).not.toContain('***');
  });

  it('returns (invalid URL) for non-URLs', () => {
    const result = redactUrl('not-a-url');
    expect(result).toBe('(invalid URL)');
  });
});
