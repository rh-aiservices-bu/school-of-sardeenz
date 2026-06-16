// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, validateAuthConfig } from '../config.js';
import type { Config, AuthConfigLogger } from '../config.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    listenAddr: '0.0.0.0',
    listenPort: 4000,
    logLevel: 'info',
    controlPlaneUrl: 'http://localhost:3000',
    redisUrl: 'redis://localhost:6379',
    redisKeyPrefix: 'sardeenz',
    prometheusUrl: 'http://localhost:9090',
    corsOrigin: 'http://localhost:5173',
    authMode: 'none',
    adminUsername: 'admin',
    adminPassword: '',
    jwtSecret: '',
    jwtExpirationHours: 8,
    oauthClientId: 'sardeenz',
    oauthClientSecret: '',
    oauthIssuerUrl: '',
    k8sApiUrl: '',
    namespace: 'sardeenz',
    ...overrides,
  };
}

function makeLogger(): AuthConfigLogger & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    warn: (msg: string) => calls.push(msg),
  };
}

/* ------------------------------------------------------------------ */
/* validateAuthConfig                                                  */
/* ------------------------------------------------------------------ */

describe('validateAuthConfig', () => {
  const originalEnv = process.env['NODE_ENV'];

  afterEach(() => {
    // Restore NODE_ENV after each test
    if (originalEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = originalEnv;
    }
  });

  // ---- AUTH_MODE=none in production ----

  it('throws when AUTH_MODE=none in production', () => {
    process.env['NODE_ENV'] = 'production';
    const config = makeConfig({ authMode: 'none' });

    expect(() => validateAuthConfig(config)).toThrow(
      'AUTH_MODE=none is not allowed in production',
    );
  });

  it('includes remediation guidance in the production error', () => {
    process.env['NODE_ENV'] = 'production';
    const config = makeConfig({ authMode: 'none' });

    expect(() => validateAuthConfig(config)).toThrow('Set AUTH_MODE to "simple" or "oauth"');
  });

  // ---- AUTH_MODE=none in development ----

  it('does not throw when AUTH_MODE=none in development', () => {
    process.env['NODE_ENV'] = 'development';
    const config = makeConfig({ authMode: 'none' });
    const logger = makeLogger();

    expect(() => validateAuthConfig(config, logger)).not.toThrow();
  });

  it('logs a warning when AUTH_MODE=none in development', () => {
    process.env['NODE_ENV'] = 'development';
    const config = makeConfig({ authMode: 'none' });
    const logger = makeLogger();

    validateAuthConfig(config, logger);

    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toContain('AUTH_MODE=none');
    expect(logger.calls[0]).toContain('unprotected');
  });

  it('logs a warning when AUTH_MODE=none and NODE_ENV is unset', () => {
    delete process.env['NODE_ENV'];
    const config = makeConfig({ authMode: 'none' });
    const logger = makeLogger();

    validateAuthConfig(config, logger);

    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toContain('AUTH_MODE=none');
  });

  // ---- AUTH_MODE=simple with empty password ----

  it('throws when AUTH_MODE=simple and ADMIN_PASSWORD is empty string', () => {
    process.env['NODE_ENV'] = 'development';
    const config = makeConfig({ authMode: 'simple', adminPassword: '' });

    expect(() => validateAuthConfig(config)).toThrow(
      'ADMIN_PASSWORD must be explicitly set and non-empty',
    );
  });

  it('throws when AUTH_MODE=simple and ADMIN_PASSWORD is empty in production', () => {
    process.env['NODE_ENV'] = 'production';
    const config = makeConfig({ authMode: 'simple', adminPassword: '' });

    expect(() => validateAuthConfig(config)).toThrow(
      'ADMIN_PASSWORD must be explicitly set and non-empty',
    );
  });

  // ---- AUTH_MODE=simple with valid password ----

  it('passes when AUTH_MODE=simple and ADMIN_PASSWORD is set', () => {
    process.env['NODE_ENV'] = 'production';
    const config = makeConfig({ authMode: 'simple', adminPassword: 'my-secret' });

    expect(() => validateAuthConfig(config)).not.toThrow();
  });

  it('does not log warnings when AUTH_MODE=simple with valid password', () => {
    process.env['NODE_ENV'] = 'development';
    const config = makeConfig({ authMode: 'simple', adminPassword: 'my-secret' });
    const logger = makeLogger();

    validateAuthConfig(config, logger);

    expect(logger.calls).toHaveLength(0);
  });

  // ---- AUTH_MODE=oauth ----

  it('passes when AUTH_MODE=oauth in production', () => {
    process.env['NODE_ENV'] = 'production';
    const config = makeConfig({ authMode: 'oauth' });

    expect(() => validateAuthConfig(config)).not.toThrow();
  });

  it('does not log warnings when AUTH_MODE=oauth', () => {
    process.env['NODE_ENV'] = 'development';
    const config = makeConfig({ authMode: 'oauth' });
    const logger = makeLogger();

    validateAuthConfig(config, logger);

    expect(logger.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* loadConfig — auth defaults                                          */
/* ------------------------------------------------------------------ */

describe('loadConfig auth defaults', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envVars = ['AUTH_MODE', 'ADMIN_PASSWORD', 'JWT_SECRET'];

  beforeEach(() => {
    for (const key of envVars) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envVars) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('defaults AUTH_MODE to none', () => {
    const config = loadConfig();
    expect(config.authMode).toBe('none');
  });

  it('defaults ADMIN_PASSWORD to empty string', () => {
    const config = loadConfig();
    expect(config.adminPassword).toBe('');
  });

  it('reads AUTH_MODE from environment', () => {
    process.env['AUTH_MODE'] = 'simple';
    const config = loadConfig();
    expect(config.authMode).toBe('simple');
  });

  it('reads ADMIN_PASSWORD from environment', () => {
    process.env['ADMIN_PASSWORD'] = 'hunter2';
    const config = loadConfig();
    expect(config.adminPassword).toBe('hunter2');
  });

  it('rejects invalid AUTH_MODE values', () => {
    process.env['AUTH_MODE'] = 'kerberos';
    expect(() => loadConfig()).toThrow('Invalid AUTH_MODE: kerberos');
  });
});
