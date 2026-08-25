import type { DevWorkerConfig } from './config.js';
import type { NvmlReader } from './nvml.js';

/** A device the worker advertises to the control plane (registration + memory report). */
export interface DetectedDevice {
  deviceIndex: number;
  deviceType: string;
  memoryTotalBytes: number;
}

export interface DeviceReport {
  devices: DetectedDevice[];
  /** `nvml` = real hardware; `config` = fabricated from SARDEENZ_DEVICE_* env. */
  source: 'nvml' | 'config';
}

// Query real NVIDIA GPUs via NVML. Returns null when NVML is unavailable (not a GPU host / CPU
// box, or the reader reports nothing parseable) so callers fall back to the configured fleet.
export function detectNvidiaDevices(reader: NvmlReader): DetectedDevice[] | null {
  const devices = reader.readDeviceMemory();
  if (!devices || devices.length === 0) return null;
  return devices.map((d) => ({
    deviceIndex: d.deviceIndex,
    deviceType: 'CUDA',
    memoryTotalBytes: d.totalBytes,
  }));
}

// Resolve the device fleet the worker advertises. In apptainer mode (real SIFs on real hardware) we
// detect actual GPUs via NVML, falling back to the configured fleet only if NVML is unavailable
// (e.g. a CPU dev box). In stub mode the fleet is always the configured (simulated) one.
//
// Synchronous — NVML reads are in-process (unlike the old nvidia-smi exec), but the signature stays
// callable with `await` so callers don't need to change if that ever stops being true.
export function resolveDevices(config: DevWorkerConfig, reader?: NvmlReader | null): DeviceReport {
  if (config.mode === 'apptainer' && config.deviceType.toUpperCase() === 'CUDA' && reader) {
    const detected = detectNvidiaDevices(reader);
    if (detected && detected.length > 0) {
      return { devices: detected, source: 'nvml' };
    }
  }
  const devices: DetectedDevice[] = Array.from({ length: config.deviceCount }, (_, i) => ({
    deviceIndex: i,
    deviceType: config.deviceType,
    memoryTotalBytes: config.deviceMemoryBytes,
  }));
  return { devices, source: 'config' };
}
