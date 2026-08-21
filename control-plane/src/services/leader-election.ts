import { readFileSync } from 'node:fs';

import { leaderIsLeader, leaderLeaseFailuresTotal } from '../health/metrics.js';

export interface LeaderElectionLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export type LeadershipMode = 'kubernetes-lease' | 'single-instance';

export interface LeaderElectionOptions {
  leaseName: string;
  leaseNamespace: string;
  renewIntervalMs: number;
  leaseDurationMs: number;
  logger: LeaderElectionLogger;
}

export class LeaderElectionService {
  private _isLeader = false;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private readonly kubeAvailable: boolean;
  private _consecutiveLeaseFailures = 0;
  private _leadershipMode: LeadershipMode;
  private readonly logger: LeaderElectionLogger;
  private static readonly FAILURE_LOG_INTERVAL = 10;

  constructor(private readonly options: LeaderElectionOptions) {
    this.kubeAvailable = this.detectKubernetes();
    this.logger = options.logger;
    this._leadershipMode = this.kubeAvailable ? 'kubernetes-lease' : 'single-instance';
  }

  get isLeader(): boolean {
    return this._isLeader;
  }

  get consecutiveLeaseFailures(): number {
    return this._consecutiveLeaseFailures;
  }

  get leadershipMode(): LeadershipMode {
    return this._leadershipMode;
  }

  async start(): Promise<void> {
    if (!this.kubeAvailable) {
      const singleInstance = process.env['SARDEENZ_SINGLE_INSTANCE'];
      if (singleInstance !== 'true' && singleInstance !== '1') {
        throw new Error(
          'Not running on Kubernetes and SARDEENZ_SINGLE_INSTANCE is not set. ' +
            'Set SARDEENZ_SINGLE_INSTANCE=true to run as a single instance without leader election.',
        );
      }
      this.logger.warn(
        {},
        'Running in single-instance mode — self-electing as leader without Kubernetes lease',
      );
      this._isLeader = true;
      leaderIsLeader.set(1);
      return;
    }

    await this.tryAcquire();
    this.renewTimer = setInterval(() => {
      void this.tryRenew();
    }, this.options.renewIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    if (this._isLeader && this.kubeAvailable) {
      await this.releaseLease();
    }
    this._isLeader = false;
    this._consecutiveLeaseFailures = 0;
    leaderIsLeader.set(0);
  }

  private detectKubernetes(): boolean {
    return (
      process.env['KUBERNETES_SERVICE_HOST'] !== undefined &&
      process.env['KUBERNETES_SERVICE_HOST'] !== ''
    );
  }

  private async tryAcquire(): Promise<void> {
    if (!this.kubeAvailable) return;

    try {
      const lease = await this.getLease();
      if (!lease || this.isLeaseExpired(lease)) {
        await this.acquireLease(lease);
        this._isLeader = true;
        leaderIsLeader.set(1);
      }
      this._consecutiveLeaseFailures = 0;
    } catch (err) {
      this._isLeader = false;
      leaderIsLeader.set(0);
      this.recordLeaseFailure(err, 'acquire');
    }
  }

  private async tryRenew(): Promise<void> {
    if (!this._isLeader) {
      await this.tryAcquire();
      return;
    }

    try {
      await this.renewLease();
      this._consecutiveLeaseFailures = 0;
    } catch (err) {
      this._isLeader = false;
      leaderIsLeader.set(0);
      this.recordLeaseFailure(err, 'renew');
    }
  }

  private recordLeaseFailure(err: unknown, operation: 'acquire' | 'renew'): void {
    this._consecutiveLeaseFailures += 1;
    const isConflict = this.isConflictError(err);
    const reason = isConflict ? 'conflict' : operation;
    leaderLeaseFailuresTotal.labels(reason).inc();

    const message = err instanceof Error ? err.message : String(err);
    const logObj = {
      operation,
      consecutiveFailures: this._consecutiveLeaseFailures,
      error: message,
    };

    // 409s are normal contention between replicas racing for the same lease — expected, not
    // actionable, so they're logged at debug rather than warn to avoid alert fatigue.
    if (isConflict) {
      this.logger.debug(logObj, 'Leader lease conflict — another instance holds the lease');
      return;
    }

    // Throttle to the first failure plus every Nth after that, so a sustained outage doesn't
    // spam the log at one line per renew interval while still surfacing the ongoing problem.
    if (
      this._consecutiveLeaseFailures === 1 ||
      this._consecutiveLeaseFailures % LeaderElectionService.FAILURE_LOG_INTERVAL === 0
    ) {
      this.logger.warn(logObj, 'Leader lease operation failed');
    }
  }

  private isConflictError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return err.message.includes('409') || err.message.toLowerCase().includes('conflict');
  }

  private async getLease(): Promise<KubeLease | null> {
    const response = await fetch(
      `https://kubernetes.default.svc/apis/coordination.k8s.io/v1/namespaces/${this.options.leaseNamespace}/leases/${this.options.leaseName}`,
      {
        headers: this.kubeHeaders(),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Lease GET failed: ${response.status}`);
    return (await response.json()) as KubeLease;
  }

  private async acquireLease(existing: KubeLease | null): Promise<void> {
    const now = new Date().toISOString();
    const hostname = process.env['HOSTNAME'] ?? 'unknown';
    const body: KubeLeaseSpec = {
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: {
        name: this.options.leaseName,
        namespace: this.options.leaseNamespace,
        ...(existing?.metadata?.resourceVersion
          ? { resourceVersion: existing.metadata.resourceVersion }
          : {}),
      },
      spec: {
        holderIdentity: hostname,
        leaseDurationSeconds: Math.floor(this.options.leaseDurationMs / 1000),
        acquireTime: now,
        renewTime: now,
      },
    };

    const method = existing ? 'PUT' : 'POST';
    const url = existing
      ? `https://kubernetes.default.svc/apis/coordination.k8s.io/v1/namespaces/${this.options.leaseNamespace}/leases/${this.options.leaseName}`
      : `https://kubernetes.default.svc/apis/coordination.k8s.io/v1/namespaces/${this.options.leaseNamespace}/leases`;

    const response = await fetch(url, {
      method,
      headers: { ...this.kubeHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) throw new Error(`Lease acquire failed: ${response.status}`);
  }

  private async renewLease(): Promise<void> {
    const lease = await this.getLease();
    if (!lease) throw new Error('Lease disappeared');

    const hostname = process.env['HOSTNAME'] ?? 'unknown';
    if (lease.spec?.holderIdentity !== hostname) {
      throw new Error('Lease held by another instance');
    }

    if (lease.spec) {
      lease.spec.renewTime = new Date().toISOString();
    }

    const response = await fetch(
      `https://kubernetes.default.svc/apis/coordination.k8s.io/v1/namespaces/${this.options.leaseNamespace}/leases/${this.options.leaseName}`,
      {
        method: 'PUT',
        headers: { ...this.kubeHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(lease),
        signal: AbortSignal.timeout(5000),
      },
    );

    if (response.status === 409) throw new Error('Lease conflict — another instance took over');
    if (!response.ok) throw new Error(`Lease renew failed: ${response.status}`);
  }

  private async releaseLease(): Promise<void> {
    try {
      await fetch(
        `https://kubernetes.default.svc/apis/coordination.k8s.io/v1/namespaces/${this.options.leaseNamespace}/leases/${this.options.leaseName}`,
        {
          method: 'DELETE',
          headers: this.kubeHeaders(),
          signal: AbortSignal.timeout(5000),
        },
      );
    } catch {
      // Best-effort release
    }
  }

  private isLeaseExpired(lease: KubeLease): boolean {
    if (!lease.spec?.renewTime || !lease.spec.leaseDurationSeconds) return true;
    // Compares the lease's renewTime against this process's own clock rather than the API
    // server's, so meaningful clock skew between nodes can cause a lease to be judged expired
    // (or valid) earlier/later than the true bound — the leaseDurationSeconds margin is the
    // tolerance for that skew, not just for missed renew intervals.
    const renewTime = new Date(lease.spec.renewTime).getTime();
    const expiresAt = renewTime + lease.spec.leaseDurationSeconds * 1000;
    return Date.now() > expiresAt;
  }

  private cachedToken: string | null = null;
  private tokenReadAt = 0;
  private static readonly TOKEN_CACHE_MS = 60_000;

  private kubeHeaders(): Record<string, string> {
    const now = Date.now();
    if (this.cachedToken && now - this.tokenReadAt < LeaderElectionService.TOKEN_CACHE_MS) {
      return { Authorization: `Bearer ${this.cachedToken}` };
    }
    try {
      this.cachedToken = readFileSync(
        '/var/run/secrets/kubernetes.io/serviceaccount/token',
        'utf-8',
      );
      this.tokenReadAt = now;
      return { Authorization: `Bearer ${this.cachedToken}` };
    } catch {
      return {};
    }
  }
}

interface KubeLeaseSpec {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace: string; resourceVersion?: string };
  spec: {
    holderIdentity: string;
    leaseDurationSeconds: number;
    acquireTime: string;
    renewTime: string;
  };
}

interface KubeLease {
  metadata?: {
    resourceVersion?: string;
  };
  spec?: {
    holderIdentity?: string;
    leaseDurationSeconds?: number;
    acquireTime?: string;
    renewTime?: string;
  };
}
