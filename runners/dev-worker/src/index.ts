import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { loadRootEnv } from './load-env.js';
import { loadConfig } from './config.js';
import { WorkerRegistration, type CatalogCapabilityOverrides } from './registration.js';
import { RunnerManager, probePortAvailable } from './runner-manager.js';
import { StubLauncher } from './stub-launcher.js';
import { ApptainerLauncher } from './apptainer-launcher.js';
import type { RunnerLauncher } from './launcher.js';
import { resolveDevices, type DeviceReport } from './gpu-detect.js';
import { createServer } from './server.js';
import { Redis } from 'ioredis';

loadRootEnv();
const config = loadConfig();

// Reads the runner catalog (local file path or file:// URL — remote http(s) catalogs are the
// control plane's concern) and extracts capability fields for this worker's configured
// runnerType, so a dev-worker registers with the same capabilities the catalog advertises rather
// than a hardcoded guess.
async function loadCatalogCapabilities(
  catalogUrl: string,
  runnerType: string,
): Promise<CatalogCapabilityOverrides | undefined> {
  if (!catalogUrl) return undefined;
  try {
    const path = catalogUrl.startsWith('file://') ? new URL(catalogUrl).pathname : catalogUrl;
    const raw = await readFile(path, 'utf8');
    const doc = parseYaml(raw) as { runners?: Array<Record<string, unknown>> };
    const entry = doc.runners?.find((r) => r.runnerType === runnerType);
    if (!entry) return undefined;
    const overrides: CatalogCapabilityOverrides = {};
    if (Array.isArray(entry.supportedModelTypes)) {
      overrides.supportedModelTypes = entry.supportedModelTypes.filter(
        (v): v is string => typeof v === 'string',
      );
    }
    if (Array.isArray(entry.supportedDeviceTypes)) {
      overrides.supportedDeviceTypes = entry.supportedDeviceTypes.filter(
        (v): v is string => typeof v === 'string',
      );
    }
    if (Array.isArray(entry.supportedSleepLevels)) {
      overrides.supportedSleepLevels = entry.supportedSleepLevels.filter(
        (v): v is string => typeof v === 'string',
      );
    }
    if (typeof entry.version === 'string') overrides.engineVersion = entry.version;
    if (typeof entry.maxTensorParallelism === 'number') {
      overrides.maxTensorParallelism = entry.maxTensorParallelism;
    }
    if (typeof entry.kvCacheElasticSharing === 'boolean') {
      overrides.kvCacheElasticSharing = entry.kvCacheElasticSharing;
    }
    if (entry.features && typeof entry.features === 'object' && !Array.isArray(entry.features)) {
      overrides.features = entry.features as Record<string, unknown>;
    }
    return overrides;
  } catch (err) {
    console.warn(
      `[dev-worker] Failed to load runner catalog from ${catalogUrl}: ${(err as Error).message}`,
    );
    return undefined;
  }
}

const catalogCapabilities = await loadCatalogCapabilities(config.catalogUrl, config.runnerType);

function createLauncher(): RunnerLauncher {
  if (config.mode === 'apptainer') {
    // Ensure a writable HOME on node-local scratch exists before the first exec (spike finding:
    // the module PVC is read-only, so Apptainer's config/keys dir must live on /scratch).
    mkdirSync(config.apptainer.home, { recursive: true });
    return new ApptainerLauncher(config.apptainer);
  }
  return new StubLauncher(config);
}

// Resolve the advertised fleet once at startup: real GPUs via nvidia-smi in apptainer mode, else the
// configured (simulated) fleet. Done before registration so the control plane budgets real VRAM.
const deviceReport = await resolveDevices(config);

const redis = new Redis(config.redisUrl);
const registration = new WorkerRegistration(
  redis,
  config,
  deviceReport.devices,
  undefined,
  catalogCapabilities,
);
const runnerManager = new RunnerManager(
  config,
  registration,
  createLauncher(),
  undefined,
  probePortAvailable,
);

const server = createServer(runnerManager, config.workerToken);

// Human-readable one-liner for the fleet, e.g. "1x CUDA @ 8 GiB" (or a per-device list if mixed).
function summarizeFleet(report: DeviceReport): string {
  const { devices } = report;
  if (devices.length === 0) return 'no devices';
  const gib = (bytes: number): number => Math.round(bytes / (1024 * 1024 * 1024));
  const uniform = devices.every(
    (d) => d.deviceType === devices[0].deviceType && d.memoryTotalBytes === devices[0].memoryTotalBytes,
  );
  return uniform
    ? `${devices.length}x ${devices[0].deviceType} @ ${gib(devices[0].memoryTotalBytes)} GiB`
    : devices.map((d) => `${d.deviceType} @ ${gib(d.memoryTotalBytes)} GiB`).join(', ');
}

async function start(): Promise<void> {
  await registration.register();
  registration.startHeartbeat();

  await server.listen({ port: config.workerPort, host: '0.0.0.0' });
  if (!config.workerToken) {
    console.warn('[dev-worker] SARDEENZ_WORKER_TOKEN is not set — worker API authentication is disabled');
  }
  // Be explicit about where the fleet came from so fabricated numbers aren't read as real hardware:
  //   detected   — real GPUs from nvidia-smi (apptainer mode)
  //   simulating — fabricated from SARDEENZ_DEVICE_* (stub mode)
  //   configured — apptainer mode but no nvidia-smi, so falling back to SARDEENZ_DEVICE_*
  const origin =
    deviceReport.source === 'nvidia-smi'
      ? 'detected'
      : config.mode === 'stub'
        ? 'simulating'
        : 'configured (no nvidia-smi; set SARDEENZ_DEVICE_COUNT / SARDEENZ_DEVICE_MEMORY_GB)';
  console.log(
    `[worker:${config.mode}] ${config.workerId} listening on :${config.workerPort} ` +
      `(${origin} ${summarizeFleet(deviceReport)})`,
  );
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[dev-worker] ${config.workerId} shutting down...`);
  await runnerManager.stopAll();
  registration.stopHeartbeat();
  await registration.deregister();
  await server.close();
  redis.disconnect();
  console.log(`[dev-worker] ${config.workerId} stopped.`);
}

process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));

start().catch((err) => {
  console.error('[dev-worker] Failed to start:', err);
  process.exit(1);
});
