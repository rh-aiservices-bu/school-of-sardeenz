import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DevWorkerConfig } from './config.js';

const execFileAsync = promisify(execFile);

/** A device the worker advertises to the control plane (registration + memory report). */
export interface DetectedDevice {
  deviceIndex: number;
  deviceType: string;
  memoryTotalBytes: number;
}

export interface DeviceReport {
  devices: DetectedDevice[];
  /** `nvidia-smi` = real hardware; `config` = fabricated from SARDEENZ_DEVICE_* env. */
  source: 'nvidia-smi' | 'config';
}

// Injectable so the parser can be unit-tested without a GPU (and so a missing nvidia-smi is easy to
// simulate). Returns stdout only — that's all the parser needs.
export type ExecFn = (command: string, args: string[]) => Promise<{ stdout: string }>;

const MIB = 1024 * 1024;

const defaultExec: ExecFn = (command, args) => execFileAsync(command, args, { timeout: 5000 });

// Query real NVIDIA GPUs via nvidia-smi. Returns null when nvidia-smi is unavailable (not a GPU
// host / CPU box) or reports nothing parseable, so callers fall back to the configured fleet.
// `memory.total` is emitted in MiB with `--format=csv,noheader,nounits`.
export async function detectNvidiaDevices(
  exec: ExecFn = defaultExec,
): Promise<DetectedDevice[] | null> {
  let stdout: string;
  try {
    ({ stdout } = await exec('nvidia-smi', [
      '--query-gpu=memory.total',
      '--format=csv,noheader,nounits',
    ]));
  } catch {
    return null; // nvidia-smi missing or errored — not a GPU host
  }

  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  const devices: DetectedDevice[] = [];
  for (let i = 0; i < lines.length; i++) {
    const mib = Number.parseInt(lines[i], 10);
    if (Number.isNaN(mib)) return null; // unexpected output — don't advertise a bogus fleet
    devices.push({ deviceIndex: i, deviceType: 'CUDA', memoryTotalBytes: mib * MIB });
  }
  return devices;
}

// Resolve the device fleet the worker advertises. In apptainer mode (real SIFs on real hardware) we
// detect actual GPUs, falling back to the configured fleet only if nvidia-smi is absent (e.g. a CPU
// dev box). In stub mode the fleet is always the configured (simulated) one.
export async function resolveDevices(
  config: DevWorkerConfig,
  exec: ExecFn = defaultExec,
): Promise<DeviceReport> {
  if (config.mode === 'apptainer' && config.deviceType.toUpperCase() === 'CUDA') {
    const detected = await detectNvidiaDevices(exec);
    if (detected && detected.length > 0) {
      return { devices: detected, source: 'nvidia-smi' };
    }
  }
  const devices: DetectedDevice[] = Array.from({ length: config.deviceCount }, (_, i) => ({
    deviceIndex: i,
    deviceType: config.deviceType,
    memoryTotalBytes: config.deviceMemoryBytes,
  }));
  return { devices, source: 'config' };
}
