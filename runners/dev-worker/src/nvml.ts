// Thin wrapper around @rh-ai-bu/ts-nvml that never lets a missing GPU/driver crash the worker.
//
// koffi (the native FFI layer ts-nvml is built on) loads at *import* time, and NVML's
// libnvidia-ml.so.1 is dlopen'd lazily inside Nvml.init() (see getLibrary() in
// node_modules/@rh-ai-bu/ts-nvml/dist/bindings/library.js). Either can fail on a CPU dev box or a
// host without the NVIDIA driver, so the whole module is loaded via a dynamic import inside a
// try/catch, and every read degrades to `null` instead of throwing.
import type { Device } from '@rh-ai-bu/ts-nvml';

export interface NvmlDeviceMemory {
  deviceIndex: number;
  totalBytes: number;
  usedBytes: number;
}

export interface NvmlProcessMemory {
  deviceIndex: number;
  pid: number;
  usedBytes: number;
}

export interface NvmlReader {
  /** One entry per NVML-visible device, or null if no device could be queried at all. */
  readDeviceMemory: () => NvmlDeviceMemory[] | null;
  /** One entry per GPU process across all devices, or null if no device could be queried at all. */
  readProcesses: () => NvmlProcessMemory[] | null;
  shutdown: () => void;
}

const MIB = 1024 * 1024;

// Creates an NvmlReader backed by a real NVML session, or null when NVML is unavailable (no
// libnvidia-ml, no driver, or init otherwise fails). Never throws.
export async function createNvmlReader(): Promise<NvmlReader | null> {
  let nvmlModule: typeof import('@rh-ai-bu/ts-nvml');
  try {
    nvmlModule = await import('@rh-ai-bu/ts-nvml');
  } catch (err) {
    console.log(`[worker] NVML unavailable (module load failed): ${(err as Error).message}`);
    return null;
  }

  const { Nvml } = nvmlModule;
  try {
    Nvml.init();
  } catch (err) {
    console.log(`[worker] NVML unavailable (init failed): ${(err as Error).message}`);
    return null;
  }
  console.log('[worker] NVML initialized — measured GPU telemetry enabled');

  let shutDown = false;
  return {
    readDeviceMemory(): NvmlDeviceMemory[] | null {
      if (shutDown) return null;
      let devices: Device[];
      try {
        devices = Nvml.getAllDevices();
      } catch (err) {
        console.log(`[worker] NVML device enumeration failed: ${(err as Error).message}`);
        return null;
      }
      const out: NvmlDeviceMemory[] = [];
      for (const device of devices) {
        const result = device.getMemoryInfo();
        if (!result.ok) continue; // this device's query failed — skip it, keep the rest
        out.push({
          deviceIndex: device.index,
          totalBytes: Number(result.value.total),
          usedBytes: Number(result.value.used),
        });
      }
      return out;
    },

    readProcesses(): NvmlProcessMemory[] | null {
      if (shutDown) return null;
      let devices: Device[];
      try {
        devices = Nvml.getAllDevices();
      } catch (err) {
        console.log(`[worker] NVML device enumeration failed: ${(err as Error).message}`);
        return null;
      }
      const out: NvmlProcessMemory[] = [];
      for (const device of devices) {
        const result = device.getProcesses();
        if (!result.ok) continue; // this device's query failed — skip it, keep the rest
        for (const proc of result.value) {
          out.push({
            deviceIndex: device.index,
            pid: proc.pid,
            usedBytes: proc.usedMemoryMiB * MIB,
          });
        }
      }
      return out;
    },

    shutdown(): void {
      if (shutDown) return;
      shutDown = true;
      try {
        Nvml.shutdown();
      } catch (err) {
        console.log(`[worker] NVML shutdown failed: ${(err as Error).message}`);
      }
    },
  };
}
