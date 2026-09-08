// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { LeaderElectionService, toKubernetesMicroTime } from '../leader-election.js';
import type { LeaderElectionOptions } from '../leader-election.js';

type LoggerFn = (obj: Record<string, unknown>, msg: string) => void;

interface MockLogger {
  info: ReturnType<typeof vi.fn<LoggerFn>>;
  warn: ReturnType<typeof vi.fn<LoggerFn>>;
  error: ReturnType<typeof vi.fn<LoggerFn>>;
  debug: ReturnType<typeof vi.fn<LoggerFn>>;
}

function makeLogger(): MockLogger {
  return {
    info: vi.fn<LoggerFn>(),
    warn: vi.fn<LoggerFn>(),
    error: vi.fn<LoggerFn>(),
    debug: vi.fn<LoggerFn>(),
  };
}

function makeOptions(logger: MockLogger): LeaderElectionOptions {
  return {
    leaseName: 'sardeenz-control-plane',
    leaseNamespace: 'sardeenz',
    renewIntervalMs: 10_000,
    leaseDurationMs: 30_000,
    logger,
  };
}

const originalKubeHost = process.env['KUBERNETES_SERVICE_HOST'];
const originalSingleInstance = process.env['SARDEENZ_SINGLE_INSTANCE'];
const originalFetch = global.fetch;

beforeEach(() => {
  delete process.env['KUBERNETES_SERVICE_HOST'];
  delete process.env['SARDEENZ_SINGLE_INSTANCE'];
});

afterEach(() => {
  if (originalKubeHost === undefined) delete process.env['KUBERNETES_SERVICE_HOST'];
  else process.env['KUBERNETES_SERVICE_HOST'] = originalKubeHost;
  if (originalSingleInstance === undefined) delete process.env['SARDEENZ_SINGLE_INSTANCE'];
  else process.env['SARDEENZ_SINGLE_INSTANCE'] = originalSingleInstance;
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('LeaderElectionService — single-instance mode', () => {
  it('throws on start() outside Kubernetes without SARDEENZ_SINGLE_INSTANCE', async () => {
    const logger = makeLogger();
    const svc = new LeaderElectionService(makeOptions(logger));

    await expect(svc.start()).rejects.toThrow(/SARDEENZ_SINGLE_INSTANCE/);
    expect(svc.isLeader).toBe(false);
  });

  it('self-elects as leader when SARDEENZ_SINGLE_INSTANCE=true', async () => {
    process.env['SARDEENZ_SINGLE_INSTANCE'] = 'true';
    const logger = makeLogger();
    const svc = new LeaderElectionService(makeOptions(logger));

    await svc.start();

    expect(svc.isLeader).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith({}, expect.stringContaining('single-instance mode'));
  });

  it('self-elects as leader when SARDEENZ_SINGLE_INSTANCE=1', async () => {
    process.env['SARDEENZ_SINGLE_INSTANCE'] = '1';
    const svc = new LeaderElectionService(makeOptions(makeLogger()));

    await svc.start();

    expect(svc.isLeader).toBe(true);
  });
});

describe('LeaderElectionService — leadershipMode', () => {
  it('reports single-instance when Kubernetes is not detected', () => {
    const svc = new LeaderElectionService(makeOptions(makeLogger()));
    expect(svc.leadershipMode).toBe('single-instance');
  });

  it('reports kubernetes-lease when running on Kubernetes', () => {
    process.env['KUBERNETES_SERVICE_HOST'] = '10.0.0.1';
    const svc = new LeaderElectionService(makeOptions(makeLogger()));
    expect(svc.leadershipMode).toBe('kubernetes-lease');
  });
});

describe('toKubernetesMicroTime', () => {
  it('formats JavaScript milliseconds as Kubernetes six-digit MicroTime precision', () => {
    expect(toKubernetesMicroTime(new Date('2026-09-08T12:34:56.789Z'))).toBe(
      '2026-09-08T12:34:56.789000Z',
    );
  });
});

describe('LeaderElectionService — lease failure logging', () => {
  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    } as Response;
  }

  it('sends Kubernetes MicroTime values when creating a Lease', async () => {
    process.env['KUBERNETES_SERVICE_HOST'] = '10.0.0.1';
    const svc = new LeaderElectionService(makeOptions(makeLogger()));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(201, {}));
    global.fetch = fetchMock;

    const svcInternal = svc as unknown as { tryAcquire: () => Promise<void> };
    await svcInternal.tryAcquire();

    const createInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(typeof createInit.body).toBe('string');
    if (typeof createInit.body !== 'string') throw new Error('expected a serialized Lease body');
    expect(createInit.body).toMatch(/"acquireTime":"[^"]+\.\d{6}Z"/);
    expect(createInit.body).toMatch(/"renewTime":"[^"]+\.\d{6}Z"/);
  });

  it('includes the Kubernetes API response body in lease failure logs', async () => {
    process.env['KUBERNETES_SERVICE_HOST'] = '10.0.0.1';
    const logger = makeLogger();
    const svc = new LeaderElectionService(makeOptions(logger));
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(400, 'invalid MicroTime value'));

    const svcInternal = svc as unknown as { tryAcquire: () => Promise<void> };
    await svcInternal.tryAcquire();

    const loggedError = logger.warn.mock.calls[0]?.[0]['error'];
    expect(loggedError).toContain('invalid MicroTime value');
  });

  it('logs the first failure and every FAILURE_LOG_INTERVAL-th failure after that', async () => {
    process.env['KUBERNETES_SERVICE_HOST'] = '10.0.0.1';
    const logger = makeLogger();
    const svc = new LeaderElectionService(makeOptions(logger));
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(500, {}));

    const svcInternal = svc as unknown as { tryAcquire: () => Promise<void> };
    for (let i = 0; i < 10; i++) {
      await svcInternal.tryAcquire();
    }

    expect(svc.consecutiveLeaseFailures).toBe(10);
    // Called on failure #1 and failure #10 — not on #2-9.
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('logs conflicting (409) lease operations at debug, not warn', async () => {
    process.env['KUBERNETES_SERVICE_HOST'] = '10.0.0.1';
    const hostname = process.env['HOSTNAME'] ?? 'unknown';
    const logger = makeLogger();
    const svc = new LeaderElectionService(makeOptions(logger));
    (svc as unknown as { _isLeader: boolean })._isLeader = true;

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          spec: {
            holderIdentity: hostname,
            leaseDurationSeconds: 30,
            renewTime: new Date().toISOString(),
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(409, {}));

    const svcInternal = svc as unknown as { tryRenew: () => Promise<void> };
    await svcInternal.tryRenew();

    expect(svc.consecutiveLeaseFailures).toBe(1);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('resets the failure counter on a successful acquire', async () => {
    process.env['KUBERNETES_SERVICE_HOST'] = '10.0.0.1';
    const logger = makeLogger();
    const svc = new LeaderElectionService(makeOptions(logger));
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(500, {}));

    const svcInternal = svc as unknown as { tryAcquire: () => Promise<void> };
    await svcInternal.tryAcquire();
    await svcInternal.tryAcquire();
    expect(svc.consecutiveLeaseFailures).toBe(2);

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, {})) // GET: no existing lease
      .mockResolvedValueOnce(jsonResponse(201, {})); // POST: acquire succeeds
    await svcInternal.tryAcquire();
    expect(svc.consecutiveLeaseFailures).toBe(0);
  });
});

describe('LeaderElectionService — stop()', () => {
  it('resets leader status and the failure counter', async () => {
    const svc = new LeaderElectionService(makeOptions(makeLogger()));
    (svc as unknown as { _isLeader: boolean })._isLeader = true;
    (svc as unknown as { _consecutiveLeaseFailures: number })._consecutiveLeaseFailures = 5;

    await svc.stop();

    expect(svc.isLeader).toBe(false);
    expect(svc.consecutiveLeaseFailures).toBe(0);
  });
});
