import { mkdirSync } from 'node:fs';
import { loadRootEnv } from './load-env.js';
import { loadConfig } from './config.js';
import { WorkerRegistration } from './registration.js';
import { RunnerManager } from './runner-manager.js';
import { StubLauncher } from './stub-launcher.js';
import { ApptainerLauncher } from './apptainer-launcher.js';
import type { RunnerLauncher } from './launcher.js';
import { resolveDevices, type DeviceReport } from './gpu-detect.js';
import { createServer } from './server.js';
import { Redis } from 'ioredis';

loadRootEnv();
const config = loadConfig();

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
const registration = new WorkerRegistration(redis, config, deviceReport.devices);
const runnerManager = new RunnerManager(config, registration, createLauncher());

const server = createServer(runnerManager);

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
