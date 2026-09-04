import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

interface Port {
  protocol: string;
  port: number;
  endPort?: number;
}

interface IngressRule {
  from: Array<{
    podSelector?: { matchLabels?: Record<string, string> };
    namespaceSelector?: unknown;
    ipBlock?: unknown;
  }>;
  ports: Port[];
}

interface NetworkPolicyManifest {
  spec: {
    podSelector: {
      matchLabels?: Record<string, string>;
      matchExpressions?: unknown[];
    };
    policyTypes: string[];
    ingress: IngressRule[];
  };
}

interface KustomizationManifest {
  resources?: string[];
}

interface DeploymentManifest {
  spec: {
    template: {
      spec: {
        containers: Array<{
          name: string;
          env?: Array<{ name: string; value?: string }>;
          ports?: Array<{ name?: string; containerPort: number; protocol?: string }>;
        }>;
      };
    };
  };
}

const repoRoot = resolve(import.meta.dirname, '../../../..');
const runnerPortStart = 9101;
const maxRunners = 32;
const workerPort = 9100;
const managementPorts = Array.from(
  { length: maxRunners },
  (_, index) => runnerPortStart + index * 4,
);
const enginePorts = managementPorts.map((port) => port + 1);
const auxiliaryPorts = managementPorts.flatMap((port) => [port + 2, port + 3]);

function readManifest<T>(path: string): T {
  return parseYaml(readFileSync(resolve(repoRoot, path), 'utf8')) as T;
}

function ruleForSource(
  rules: IngressRule[],
  labels: Record<string, string>,
): IngressRule | undefined {
  return rules.find((rule) =>
    rule.from.some(
      (source) => JSON.stringify(source.podSelector?.matchLabels) === JSON.stringify(labels),
    ),
  );
}

function loadConfigWithDefaultPortValues() {
  const portEnvKeys = [
    'SARDEENZ_WORKER_PORT',
    'SARDEENZ_RUNNER_PORT_START',
    'SARDEENZ_MAX_RUNNERS',
  ] as const;
  const originalValues = new Map(portEnvKeys.map((key) => [key, process.env[key]]));

  try {
    for (const key of portEnvKeys) delete process.env[key];
    return loadConfig();
  } finally {
    for (const key of portEnvKeys) {
      const originalValue = originalValues.get(key);
      if (originalValue === undefined) delete process.env[key];
      else process.env[key] = originalValue;
    }
  }
}

describe('SIF runner deployment manifests (#181)', () => {
  const policy = readManifest<NetworkPolicyManifest>('deployment/sif-runner/networkpolicy.yaml');
  const deployment = readManifest<DeploymentManifest>(
    'deployment/sif-runner/worker-deployment.yaml',
  );
  const kustomization = readManifest<KustomizationManifest>(
    'deployment/sif-runner/kustomization.yaml',
  );

  it('selects only worker Pods and remains included in the SIF runner kustomization', () => {
    expect(policy.spec.podSelector).toEqual({
      matchLabels: { 'app.kubernetes.io/name': 'sardeenz-worker' },
    });
    expect(kustomization.resources).toContain('networkpolicy.yaml');
  });

  it('permits only same-namespace control-plane management and proxy HTTP engine traffic', () => {
    expect(policy.spec.policyTypes).toEqual(['Ingress']);
    expect(policy.spec.ingress).toHaveLength(2);

    const controlPlaneRule = ruleForSource(policy.spec.ingress, {
      'app.kubernetes.io/name': 'sardeenz-control-plane',
    });
    const proxyRule = ruleForSource(policy.spec.ingress, {
      'app.kubernetes.io/name': 'sardeenz-proxy',
    });
    expect(controlPlaneRule).toBeDefined();
    expect(proxyRule).toBeDefined();
    if (!controlPlaneRule || !proxyRule) throw new Error('Expected source rules were not found');

    expect(controlPlaneRule.ports.map(({ protocol, port }) => ({ protocol, port }))).toEqual([
      { protocol: 'TCP', port: workerPort },
      ...managementPorts.map((port) => ({ protocol: 'TCP', port })),
    ]);
    expect(proxyRule.ports.map(({ protocol, port }) => ({ protocol, port }))).toEqual(
      enginePorts.map((port) => ({ protocol: 'TCP', port })),
    );

    for (const rule of policy.spec.ingress) {
      expect(rule.from).toHaveLength(1);
      expect(rule.from[0]).not.toHaveProperty('namespaceSelector');
      expect(rule.from[0]).not.toHaveProperty('ipBlock');
      expect(rule.ports.every((port) => port.endPort === undefined)).toBe(true);
    }

    const admittedPorts = policy.spec.ingress.flatMap((rule) =>
      rule.ports.map((port) => port.port),
    );
    expect(admittedPorts).not.toContain(9103);
    expect(admittedPorts).not.toContain(9104);
    expect(admittedPorts).not.toContain(9227);
    expect(admittedPorts).not.toContain(9228);
    for (const auxiliaryPort of auxiliaryPorts) {
      expect(admittedPorts).not.toContain(auxiliaryPort);
    }
  });

  it('pins the policy envelope to the worker config defaults without dynamic container ports', () => {
    const config = loadConfigWithDefaultPortValues();
    expect(config.workerPort).toBe(workerPort);
    expect(config.runnerPortStart).toBe(runnerPortStart);
    expect(config.maxRunners).toBe(maxRunners);

    const worker = deployment.spec.template.spec.containers.find(
      (container) => container.name === 'worker',
    );
    expect(worker).toBeDefined();
    const configuredEnv = new Map(worker?.env?.map((entry) => [entry.name, entry.value]));
    expect(configuredEnv.get('SARDEENZ_WORKER_PORT')).toBe(String(workerPort));
    expect(configuredEnv.get('SARDEENZ_RUNNER_PORT_START')).toBe(String(runnerPortStart));
    expect(configuredEnv.get('SARDEENZ_MAX_RUNNERS')).toBe(String(maxRunners));
    expect(worker?.ports).toEqual([
      { name: 'management', containerPort: workerPort, protocol: 'TCP' },
    ]);
  });
});
