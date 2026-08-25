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

/** One combined read: device totals and the raw process list, from a single device enumeration. */
export interface NvmlSample {
  devices: NvmlDeviceMemory[];
  processes: NvmlProcessMemory[];
}

export interface NvmlReader {
  /** One entry per NVML-visible device, or null if no device could be queried at all. */
  readDeviceMemory: () => NvmlDeviceMemory[] | null;
  /** One entry per GPU process across all devices, or null if no device could be queried at all. */
  readProcesses: () => NvmlProcessMemory[] | null;
  /**
   * Both readDeviceMemory() and readProcesses() in one device enumeration — use this on a hot
   * path (e.g. once per heartbeat tick) instead of calling both individually, which would
   * enumerate Nvml.getAllDevices() twice for no benefit.
   */
  readSample: () => NvmlSample | null;
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

  // Shared by all three read methods: enumerates devices once, or returns null (and logs) if
  // enumeration itself fails.
  function enumerateDevices(): Device[] | null {
    if (shutDown) return null;
    try {
      return Nvml.getAllDevices();
    } catch (err) {
      console.log(`[worker] NVML device enumeration failed: ${(err as Error).message}`);
      return null;
    }
  }

  function deviceMemoryOf(device: Device): NvmlDeviceMemory | null {
    const result = device.getMemoryInfo();
    if (!result.ok) return null; // this device's query failed — skip it, keep the rest
    return {
      deviceIndex: device.index,
      totalBytes: Number(result.value.total),
      usedBytes: Number(result.value.used),
    };
  }

  function processesOf(device: Device): NvmlProcessMemory[] {
    const result = device.getProcesses();
    if (!result.ok) return []; // this device's query failed — skip it, keep the rest
    return result.value.map((proc) => ({
      deviceIndex: device.index,
      pid: proc.pid,
      usedBytes: proc.usedMemoryMiB * MIB,
    }));
  }

  return {
    readDeviceMemory(): NvmlDeviceMemory[] | null {
      const devices = enumerateDevices();
      if (!devices) return null;
      return devices.map(deviceMemoryOf).filter((d): d is NvmlDeviceMemory => d !== null);
    },

    readProcesses(): NvmlProcessMemory[] | null {
      const devices = enumerateDevices();
      if (!devices) return null;
      return devices.flatMap(processesOf);
    },

    readSample(): NvmlSample | null {
      const devices = enumerateDevices();
      if (!devices) return null;
      return {
        devices: devices.map(deviceMemoryOf).filter((d): d is NvmlDeviceMemory => d !== null),
        processes: devices.flatMap(processesOf),
      };
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
