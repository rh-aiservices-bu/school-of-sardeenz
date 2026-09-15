import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { loadRootEnv } from './load-env.js';
import { loadConfig } from './config.js';
import {
  WorkerRegistration,
  type CatalogCapabilityOverrides,
  type MeasuredMemorySample,
  type MeasuredInstanceSample,
} from './registration.js';
import { RunnerManager, probePortAvailable, type KVCacheDeviceStats } from './runner-manager.js';
import { StubLauncher } from './stub-launcher.js';
import { ApptainerLauncher } from './apptainer-launcher.js';
import type { RunnerLauncher } from './launcher.js';
import { resolveDevices, type DeviceReport } from './gpu-detect.js';
import { createNvmlReader } from './nvml.js';
import { buildMeasuredSample } from './measured-sample.js';
import { createServer } from './server.js';
import { Redis } from 'ioredis';

loadRootEnv();
const config = loadConfig();

// Reads the runner catalog (local file path or file:// URL — remote http(s) catalogs are the
// control plane's concern) and extracts capability fields for every runner family this generic
// worker advertises.
async function loadCatalogCapabilities(
  catalogUrl: string,
  runnerTypes: string[],
): Promise<Map<string, CatalogCapabilityOverrides>> {
  const result = new Map<string, CatalogCapabilityOverrides>();
  if (!catalogUrl) return result;
  try {
    const path = catalogUrl.startsWith('file://') ? new URL(catalogUrl).pathname : catalogUrl;
    const raw = await readFile(path, 'utf8');
    const doc = parseYaml(raw) as { runners?: Array<Record<string, unknown>> };
    for (const runnerType of runnerTypes) {
      const entry = doc.runners?.find((r) => r.runnerType === runnerType);
      if (!entry) continue;
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
      result.set(runnerType, overrides);
    }
    return result;
  } catch (err) {
    console.warn(
      `[dev-worker] Failed to load runner catalog from ${catalogUrl}: ${(err as Error).message}`,
    );
    return result;
  }
}

const catalogCapabilities = await loadCatalogCapabilities(
  config.catalogUrl,
  config.runnerTypes ?? [config.runnerType],
);

function createLauncher(): RunnerLauncher {
  if (config.mode === 'apptainer') {
    // Ensure a writable HOME on node-local scratch exists before the first exec (spike finding:
    // the module PVC is read-only, so Apptainer's config/keys dir must live on /scratch).
    mkdirSync(config.apptainer.home, { recursive: true });
    return new ApptainerLauncher(config.apptainer);
  }
  return new StubLauncher(config);
}

// NVML session for this worker's lifetime, created once at startup and shut down on exit. Returns
// null on a CPU dev box or any host without the NVIDIA driver — every consumer below tolerates that
// and falls back to unmeasured behavior.
const nvmlReader = await createNvmlReader();

// Holds the RunnerManager once constructed below. registration must exist before runnerManager
// (RunnerManager's constructor takes it), but measuredProvider's closure needs
// runnerManager.getRunnerProcesses() — a mutable ref sidesteps the circular construction order
// without a `let` variable that's only ever assigned once (measuredProvider isn't actually called
// until start(), well after runnerManagerRef.current is set below).
const runnerManagerRef: { current?: RunnerManager } = {};

// Binds the NvmlReader + RunnerManager into WorkerRegistration's MeasuredMemoryProvider. The
// actual device/process -> instance attribution logic lives in buildMeasuredSample()
// (measured-sample.ts), which is pure and unit-tested on its own; this is just the wiring.
function measuredProvider(): Promise<MeasuredMemorySample | null> {
  if (!nvmlReader) return Promise.resolve(null);
  const sample = nvmlReader.readSample();
  if (!sample) return Promise.resolve(null);

  const owners = runnerManagerRef.current?.getRunnerProcesses() ?? [];
  return Promise.resolve(buildMeasuredSample(sample.devices, sample.processes, owners));
}

// Doctrine fallback for stub mode / CPU-only hosts (no NVML): simulates instances[] from the
// worker's own runner ledger via RunnerManager.getLedgerInstanceShares(), which already correctly
// reports nothing for a sleeping runner (see that method's doc comment).
function ledgerInstancesProvider(): Promise<MeasuredInstanceSample[]> {
  if (!runnerManagerRef.current) return Promise.resolve([]);
  return runnerManagerRef.current.getLedgerInstanceShares().then((shares) =>
    shares.map((s) => ({
      instanceId: s.instanceId,
      modelName: s.modelName,
      deviceIndex: s.deviceIndex,
      memoryUsedBytes: s.bytes,
    })),
  );
}

// kvcached pool telemetry (#165): relayed verbatim from the runners' own /memory-report
// kvCache blocks in every mode (NVML and no-NVML alike — NVML has no pool-level figures).
function kvCacheDeviceProvider(): Promise<Map<number, KVCacheDeviceStats> | null> {
  if (!runnerManagerRef.current) return Promise.resolve(null);
  return runnerManagerRef.current.getKvCacheDeviceStats();
}

// Resolve the advertised fleet once at startup: real GPUs via NVML in apptainer mode, else the
// configured (simulated) fleet. Done before registration so the control plane budgets real VRAM.
const deviceReport = resolveDevices(config, nvmlReader);

const redis = new Redis(config.redisUrl);
const registration = new WorkerRegistration(
  redis,
  config,
  deviceReport.devices,
  undefined,
  catalogCapabilities,
  measuredProvider,
  ledgerInstancesProvider,
  kvCacheDeviceProvider,
);
const runnerManager = new RunnerManager(
  config,
  registration,
  createLauncher(),
  undefined,
  probePortAvailable,
);
runnerManagerRef.current = runnerManager;

const server = createServer(runnerManager, config.workerToken);

// Human-readable one-liner for the fleet, e.g. "1x CUDA @ 8 GiB" (or a per-device list if mixed).
function summarizeFleet(report: DeviceReport): string {
  const { devices } = report;
  if (devices.length === 0) return 'no devices';
  const gib = (bytes: number): number => Math.round(bytes / (1024 * 1024 * 1024));
  const uniform = devices.every(
    (d) =>
      d.deviceType === devices[0].deviceType && d.memoryTotalBytes === devices[0].memoryTotalBytes,
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
    console.warn(
      '[dev-worker] SARDEENZ_WORKER_TOKEN is not set — worker API authentication is disabled',
    );
  }
  // Be explicit about where the fleet came from so fabricated numbers aren't read as real hardware:
  //   detected   — real GPUs from NVML (apptainer mode)
  //   simulating — fabricated from SARDEENZ_DEVICE_* (stub mode)
  //   configured — apptainer mode but no NVML, so falling back to SARDEENZ_DEVICE_*
  const origin =
    deviceReport.source === 'nvml'
      ? 'detected'
      : config.mode === 'stub'
        ? 'simulating'
        : 'configured (no NVML; set SARDEENZ_DEVICE_COUNT / SARDEENZ_DEVICE_MEMORY_GB)';
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
  nvmlReader?.shutdown();
  console.log(`[dev-worker] ${config.workerId} stopped.`);
}

process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));

start().catch((err) => {
  console.error('[dev-worker] Failed to start:', err);
  process.exit(1);
});
