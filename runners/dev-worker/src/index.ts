import { mkdirSync } from 'node:fs';
import { loadConfig } from './config.js';
import { WorkerRegistration } from './registration.js';
import { RunnerManager } from './runner-manager.js';
import { StubLauncher } from './stub-launcher.js';
import { ApptainerLauncher } from './apptainer-launcher.js';
import type { RunnerLauncher } from './launcher.js';
import { createServer } from './server.js';
import { Redis } from 'ioredis';

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

const redis = new Redis(config.redisUrl);
const registration = new WorkerRegistration(redis, config);
const runnerManager = new RunnerManager(config, registration, createLauncher());

const server = createServer(runnerManager);

async function start(): Promise<void> {
  await registration.register();
  registration.startHeartbeat();

  await server.listen({ port: config.workerPort, host: '0.0.0.0' });
  console.log(
    `[worker:${config.mode}] ${config.workerId} listening on :${config.workerPort} ` +
      `(${config.deviceCount}x ${config.deviceType} @ ${Math.round(config.deviceMemoryBytes / (1024 * 1024 * 1024))} GiB)`,
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
