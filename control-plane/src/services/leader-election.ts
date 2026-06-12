import { leaderIsLeader } from '../health/metrics.js';

export interface LeaderElectionOptions {
  leaseName: string;
  leaseNamespace: string;
  renewIntervalMs: number;
  leaseDurationMs: number;
}

export class LeaderElectionService {
  private _isLeader = false;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private readonly kubeAvailable: boolean;

  constructor(private readonly options: LeaderElectionOptions) {
    this.kubeAvailable = this.detectKubernetes();
  }

  get isLeader(): boolean {
    return this._isLeader;
  }

  async start(): Promise<void> {
    if (!this.kubeAvailable) {
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
        await this.acquireLease();
        this._isLeader = true;
        leaderIsLeader.set(1);
      }
    } catch {
      this._isLeader = false;
      leaderIsLeader.set(0);
    }
  }

  private async tryRenew(): Promise<void> {
    if (!this._isLeader) {
      await this.tryAcquire();
      return;
    }

    try {
      await this.renewLease();
    } catch {
      this._isLeader = false;
      leaderIsLeader.set(0);
    }
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

  private async acquireLease(): Promise<void> {
    const now = new Date().toISOString();
    const hostname = process.env['HOSTNAME'] ?? 'unknown';
    const body: KubeLeaseSpec = {
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: {
        name: this.options.leaseName,
        namespace: this.options.leaseNamespace,
      },
      spec: {
        holderIdentity: hostname,
        leaseDurationSeconds: Math.floor(this.options.leaseDurationMs / 1000),
        acquireTime: now,
        renewTime: now,
      },
    };

    const existing = await this.getLease();
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

    lease.spec.renewTime = new Date().toISOString();

    const response = await fetch(
      `https://kubernetes.default.svc/apis/coordination.k8s.io/v1/namespaces/${this.options.leaseNamespace}/leases/${this.options.leaseName}`,
      {
        method: 'PUT',
        headers: { ...this.kubeHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(lease),
        signal: AbortSignal.timeout(5000),
      },
    );

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
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs') as { readFileSync: (path: string, encoding: string) => string };
      this.cachedToken = fs.readFileSync(
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
  metadata: { name: string; namespace: string };
  spec: {
    holderIdentity: string;
    leaseDurationSeconds: number;
    acquireTime: string;
    renewTime: string;
  };
}

interface KubeLease {
  spec?: {
    holderIdentity?: string;
    leaseDurationSeconds?: number;
    acquireTime?: string;
    renewTime?: string;
  };
}
