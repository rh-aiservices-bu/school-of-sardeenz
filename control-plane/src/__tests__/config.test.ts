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
    'SARDEENZ_COLOCATION_MAX_POOL_HEADROOM_PERCENT',
    'SARDEENZ_POOL_PRESSURE_ENABLED',
    'SARDEENZ_POOL_PRESSURE_THRESHOLD_PERCENT',
    'SARDEENZ_POOL_PRESSURE_RELEASE_TARGET_PERCENT',
    'SARDEENZ_POOL_PRESSURE_DEBOUNCE_TICKS',
    'SARDEENZ_SLEEP_TIMEOUT_SECS',
    'SARDEENZ_SIF_IMPORTER',
    'SARDEENZ_API_TOKEN',
    'SARDEENZ_WORKER_TOKEN',
    'SARDEENZ_ALLOW_UNAUTHENTICATED_API',
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Default fixture: the shape every in-cluster deployment runs — both tokens set, no opt-out.
    process.env['SARDEENZ_API_TOKEN'] = 'test-api-token';
    process.env['SARDEENZ_WORKER_TOKEN'] = 'test-worker-token';
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

  it('uses defaults when no configuration env vars are set', () => {
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

  it('defaults the co-location headroom cap to 50 percent (#276)', () => {
    const config = loadConfig();
    expect(config.colocationMaxPoolHeadroomPercent).toBe(50);
  });

  it.each([
    ['0', 0],
    ['100', 100],
    ['75', 75],
  ])('accepts SARDEENZ_COLOCATION_MAX_POOL_HEADROOM_PERCENT=%s as %d (#276)', (raw, expected) => {
    process.env['SARDEENZ_COLOCATION_MAX_POOL_HEADROOM_PERCENT'] = raw;
    expect(loadConfig().colocationMaxPoolHeadroomPercent).toBe(expected);
  });

  it.each(['101', '500', '-1', '0.5', 'fifty', ''])(
    'rejects SARDEENZ_COLOCATION_MAX_POOL_HEADROOM_PERCENT=%s instead of silently mis-capping (#276)',
    (raw) => {
      process.env['SARDEENZ_COLOCATION_MAX_POOL_HEADROOM_PERCENT'] = raw;
      expect(() => loadConfig()).toThrow(
        'SARDEENZ_COLOCATION_MAX_POOL_HEADROOM_PERCENT must be an integer percent between 0 and 100',
      );
    },
  );

  // Phase 5 (#277) shared-pool pressure knobs: defaults, overrides, and the boot-time
  // validators (the only thing keeping a response wave from being sized against a target it
  // can never reach, or a '0.5' from being truncated into a valid percent).
  it('defaults the pool-pressure knobs to false/90/75/3 (#277)', () => {
    const config = loadConfig();
    expect(config.poolPressureEnabled).toBe(false);
    expect(config.poolPressureThresholdPercent).toBe(90);
    expect(config.poolPressureReleaseTargetPercent).toBe(75);
    expect(config.poolPressureDebounceTicks).toBe(3);
  });

  it('reads the pool-pressure knobs from env (#277)', () => {
    process.env['SARDEENZ_POOL_PRESSURE_ENABLED'] = 'true';
    process.env['SARDEENZ_POOL_PRESSURE_THRESHOLD_PERCENT'] = '80';
    process.env['SARDEENZ_POOL_PRESSURE_RELEASE_TARGET_PERCENT'] = '50';
    process.env['SARDEENZ_POOL_PRESSURE_DEBOUNCE_TICKS'] = '5';
    const config = loadConfig();
    expect(config.poolPressureEnabled).toBe(true);
    expect(config.poolPressureThresholdPercent).toBe(80);
    expect(config.poolPressureReleaseTargetPercent).toBe(50);
    expect(config.poolPressureDebounceTicks).toBe(5);
  });

  it.each(['0', '101', '0.5', 'fifty', ''])(
    'rejects SARDEENZ_POOL_PRESSURE_THRESHOLD_PERCENT=%s instead of silently mis-sizing the trigger (#277)',
    (raw) => {
      process.env['SARDEENZ_POOL_PRESSURE_THRESHOLD_PERCENT'] = raw;
      expect(() => loadConfig()).toThrow(
        'SARDEENZ_POOL_PRESSURE_THRESHOLD_PERCENT must be an integer percent between 1 and 100',
      );
    },
  );

  it('rejects SARDEENZ_POOL_PRESSURE_RELEASE_TARGET_PERCENT at or above THRESHOLD_PERCENT (#277)', () => {
    process.env['SARDEENZ_POOL_PRESSURE_THRESHOLD_PERCENT'] = '60';
    process.env['SARDEENZ_POOL_PRESSURE_RELEASE_TARGET_PERCENT'] = '60';
    expect(() => loadConfig()).toThrow(
      'SARDEENZ_POOL_PRESSURE_RELEASE_TARGET_PERCENT (60) must be below SARDEENZ_POOL_PRESSURE_THRESHOLD_PERCENT (60)',
    );
  });

  it('rejects a release target above the threshold (#277)', () => {
    process.env['SARDEENZ_POOL_PRESSURE_THRESHOLD_PERCENT'] = '60';
    process.env['SARDEENZ_POOL_PRESSURE_RELEASE_TARGET_PERCENT'] = '95';
    expect(() => loadConfig()).toThrow(
      'SARDEENZ_POOL_PRESSURE_RELEASE_TARGET_PERCENT (95) must be below SARDEENZ_POOL_PRESSURE_THRESHOLD_PERCENT (60)',
    );
  });

  it('rejects THRESHOLD below the DEFAULT release target when only THRESHOLD is set (#277 cross-check)', () => {
    // Regression pin for the default-then-validate order: THRESHOLD=60 + unset target (75)
    // must fail at boot, not boot with a wave that can never relieve the band it fires in.
    process.env['SARDEENZ_POOL_PRESSURE_THRESHOLD_PERCENT'] = '60';
    expect(() => loadConfig()).toThrow(
      'SARDEENZ_POOL_PRESSURE_RELEASE_TARGET_PERCENT (75) must be below SARDEENZ_POOL_PRESSURE_THRESHOLD_PERCENT (60)',
    );
  });

  it('rejects an out-of-domain SARDEENZ_POOL_PRESSURE_RELEASE_TARGET_PERCENT (#277)', () => {
    process.env['SARDEENZ_POOL_PRESSURE_RELEASE_TARGET_PERCENT'] = '0';
    expect(() => loadConfig()).toThrow(
      'SARDEENZ_POOL_PRESSURE_RELEASE_TARGET_PERCENT must be an integer percent between 1 and 100',
    );
  });

  it.each(['0', '61', '-1'])(
    'rejects SARDEENZ_POOL_PRESSURE_DEBOUNCE_TICKS=%s (0 acts on a single-tick spike, >60 silently disables) (#277)',
    (raw) => {
      process.env['SARDEENZ_POOL_PRESSURE_DEBOUNCE_TICKS'] = raw;
      expect(() => loadConfig()).toThrow(
        'SARDEENZ_POOL_PRESSURE_DEBOUNCE_TICKS must be an integer between 1 and 60',
      );
    },
  );

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

  it('throws when both tokens are unset and the opt-out is absent', () => {
    delete process.env['SARDEENZ_API_TOKEN'];
    delete process.env['SARDEENZ_WORKER_TOKEN'];
    expect(() => loadConfig()).toThrow(
      'SARDEENZ_API_TOKEN and SARDEENZ_WORKER_TOKEN must be set. ' +
        'Set SARDEENZ_ALLOW_UNAUTHENTICATED_API=true to run without authentication (dev only).',
    );
  });

  it('throws when only SARDEENZ_API_TOKEN is set and the opt-out is absent', () => {
    delete process.env['SARDEENZ_WORKER_TOKEN'];
    expect(() => loadConfig()).toThrow(
      'SARDEENZ_WORKER_TOKEN must be set. ' +
        'Set SARDEENZ_ALLOW_UNAUTHENTICATED_API=true to run without authentication (dev only).',
    );
  });

  it('throws when only SARDEENZ_WORKER_TOKEN is set and the opt-out is absent', () => {
    delete process.env['SARDEENZ_API_TOKEN'];
    expect(() => loadConfig()).toThrow(
      'SARDEENZ_API_TOKEN must be set. ' +
        'Set SARDEENZ_ALLOW_UNAUTHENTICATED_API=true to run without authentication (dev only).',
    );
  });

  it('throws when SARDEENZ_API_TOKEN is set to an empty string', () => {
    process.env['SARDEENZ_API_TOKEN'] = '';
    expect(() => loadConfig()).toThrow('SARDEENZ_API_TOKEN must be set.');
  });

  it('throws when SARDEENZ_WORKER_TOKEN is set to an empty string', () => {
    process.env['SARDEENZ_WORKER_TOKEN'] = '';
    expect(() => loadConfig()).toThrow('SARDEENZ_WORKER_TOKEN must be set.');
  });

  it('throws when SARDEENZ_API_TOKEN is whitespace-only (#268)', () => {
    process.env['SARDEENZ_API_TOKEN'] = ' \t ';
    expect(() => loadConfig()).toThrow('SARDEENZ_API_TOKEN must be set.');
  });

  it('throws when SARDEENZ_WORKER_TOKEN is whitespace-only (#268)', () => {
    process.env['SARDEENZ_WORKER_TOKEN'] = '   ';
    expect(() => loadConfig()).toThrow('SARDEENZ_WORKER_TOKEN must be set.');
  });

  it('starts on a whitespace-only token with the dev opt-out (#268)', () => {
    process.env['SARDEENZ_API_TOKEN'] = '   ';
    process.env['SARDEENZ_WORKER_TOKEN'] = '   ';
    process.env['SARDEENZ_ALLOW_UNAUTHENTICATED_API'] = 'true';
    expect(loadConfig().apiToken).toBe('   ');
  });

  it('keeps a token with surrounding whitespace byte-exact (#268)', () => {
    process.env['SARDEENZ_API_TOKEN'] = ' padded-token ';
    expect(loadConfig().apiToken).toBe(' padded-token ');
  });

  it('starts when both tokens are set without the opt-out', () => {
    const config = loadConfig();
    expect(config.apiToken).toBe('test-api-token');
    expect(config.workerToken).toBe('test-worker-token');
  });

  it('starts with SARDEENZ_ALLOW_UNAUTHENTICATED_API=true and both tokens unset', () => {
    delete process.env['SARDEENZ_API_TOKEN'];
    delete process.env['SARDEENZ_WORKER_TOKEN'];
    process.env['SARDEENZ_ALLOW_UNAUTHENTICATED_API'] = 'true';
    const config = loadConfig();
    expect(config.apiToken).toBe('');
    expect(config.workerToken).toBe('');
  });

  it('starts with SARDEENZ_ALLOW_UNAUTHENTICATED_API=1 and both tokens unset', () => {
    delete process.env['SARDEENZ_API_TOKEN'];
    delete process.env['SARDEENZ_WORKER_TOKEN'];
    process.env['SARDEENZ_ALLOW_UNAUTHENTICATED_API'] = '1';
    expect(loadConfig().workerToken).toBe('');
  });

  it('treats SARDEENZ_ALLOW_UNAUTHENTICATED_API=false like an absent opt-out', () => {
    delete process.env['SARDEENZ_API_TOKEN'];
    delete process.env['SARDEENZ_WORKER_TOKEN'];
    process.env['SARDEENZ_ALLOW_UNAUTHENTICATED_API'] = 'false';
    expect(() => loadConfig()).toThrow(/SARDEENZ_ALLOW_UNAUTHENTICATED_API/);
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
