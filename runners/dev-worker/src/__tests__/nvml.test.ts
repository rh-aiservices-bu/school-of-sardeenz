import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInit = vi.fn();
const mockShutdown = vi.fn();
const mockGetAllDevices = vi.fn();

vi.mock('@rh-ai-bu/ts-nvml', () => ({
  Nvml: {
    init: mockInit,
    shutdown: mockShutdown,
    getAllDevices: mockGetAllDevices,
  },
}));

import { createNvmlReader } from '../nvml.js';

function fakeDevice(
  index: number,
  memory: { total: bigint; free: bigint; used: bigint } | null,
  processes: Array<{
    gpuIndex: number;
    pid: number;
    processName: string;
    usedMemoryMiB: number;
  }> | null,
) {
  return {
    index,
    getMemoryInfo: () =>
      memory
        ? { ok: true as const, value: memory }
        : { ok: false as const, error: new Error('nope') },
    getProcesses: () =>
      processes
        ? { ok: true as const, value: processes }
        : { ok: false as const, error: new Error('nope') },
  };
}

describe('createNvmlReader', () => {
  beforeEach(() => {
    mockInit.mockReset();
    mockShutdown.mockReset();
    mockGetAllDevices.mockReset();
  });

  it('returns null when Nvml.init() throws (no driver/library)', async () => {
    mockInit.mockImplementation(() => {
      throw new Error('Could not find libnvidia-ml.so');
    });
    const reader = await createNvmlReader();
    expect(reader).toBeNull();
  });

  it('reads device memory, converting bigint bytes to number', async () => {
    mockInit.mockImplementation(() => undefined);
    mockGetAllDevices.mockReturnValue([
      fakeDevice(
        0,
        { total: 24n * 1024n * 1024n * 1024n, free: 0n, used: 5n * 1024n * 1024n * 1024n },
        [],
      ),
    ]);

    const reader = await createNvmlReader();
    expect(reader).not.toBeNull();

    const devices = reader!.readDeviceMemory();
    expect(devices).toEqual([
      { deviceIndex: 0, totalBytes: 24 * 1024 * 1024 * 1024, usedBytes: 5 * 1024 * 1024 * 1024 },
    ]);
  });

  it('skips a device whose memory query fails but keeps the rest', async () => {
    mockInit.mockImplementation(() => undefined);
    mockGetAllDevices.mockReturnValue([
      fakeDevice(0, null, []),
      fakeDevice(
        1,
        { total: 8n * 1024n * 1024n * 1024n, free: 0n, used: 1024n * 1024n * 1024n },
        [],
      ),
    ]);

    const reader = await createNvmlReader();
    const devices = reader!.readDeviceMemory();
    expect(devices).toEqual([
      { deviceIndex: 1, totalBytes: 8 * 1024 * 1024 * 1024, usedBytes: 1024 * 1024 * 1024 },
    ]);
  });

  it('reads processes and converts MiB to bytes', async () => {
    mockInit.mockImplementation(() => undefined);
    mockGetAllDevices.mockReturnValue([
      fakeDevice(0, { total: 0n, free: 0n, used: 0n }, [
        { gpuIndex: 0, pid: 4242, processName: 'python3', usedMemoryMiB: 100 },
      ]),
    ]);

    const reader = await createNvmlReader();
    const processes = reader!.readProcesses();
    expect(processes).toEqual([{ deviceIndex: 0, pid: 4242, usedBytes: 100 * 1024 * 1024 }]);
  });

  it('skips a device whose process query fails but keeps the rest', async () => {
    mockInit.mockImplementation(() => undefined);
    mockGetAllDevices.mockReturnValue([
      fakeDevice(0, { total: 0n, free: 0n, used: 0n }, null),
      fakeDevice(1, { total: 0n, free: 0n, used: 0n }, [
        { gpuIndex: 1, pid: 555, processName: 'engine', usedMemoryMiB: 10 },
      ]),
    ]);

    const reader = await createNvmlReader();
    const processes = reader!.readProcesses();
    expect(processes).toEqual([{ deviceIndex: 1, pid: 555, usedBytes: 10 * 1024 * 1024 }]);
  });

  it('returns null from all reads after shutdown, and shutdown is idempotent', async () => {
    mockInit.mockImplementation(() => undefined);
    mockGetAllDevices.mockReturnValue([fakeDevice(0, { total: 0n, free: 0n, used: 0n }, [])]);

    const reader = await createNvmlReader();
    reader!.shutdown();
    reader!.shutdown();

    expect(mockShutdown).toHaveBeenCalledTimes(1);
    expect(reader!.readDeviceMemory()).toBeNull();
    expect(reader!.readProcesses()).toBeNull();
  });

  it('does not throw when device enumeration itself fails', async () => {
    mockInit.mockImplementation(() => undefined);
    mockGetAllDevices.mockImplementation(() => {
      throw new Error('nvmlDeviceGetCount failed');
    });

    const reader = await createNvmlReader();
    expect(reader!.readDeviceMemory()).toBeNull();
    expect(reader!.readProcesses()).toBeNull();
  });

  describe('readSample', () => {
    it('combines device memory and processes from a single device enumeration', async () => {
      mockInit.mockImplementation(() => undefined);
      mockGetAllDevices.mockReturnValue([
        fakeDevice(
          0,
          { total: 8n * 1024n * 1024n * 1024n, free: 0n, used: 2n * 1024n * 1024n * 1024n },
          [{ gpuIndex: 0, pid: 111, processName: 'python3', usedMemoryMiB: 50 }],
        ),
        fakeDevice(
          1,
          { total: 8n * 1024n * 1024n * 1024n, free: 0n, used: 1024n * 1024n * 1024n },
          [{ gpuIndex: 1, pid: 222, processName: 'python3', usedMemoryMiB: 20 }],
        ),
      ]);

      const reader = await createNvmlReader();
      mockGetAllDevices.mockClear(); // only count the enumeration readSample() itself triggers

      const sample = reader!.readSample();

      expect(sample).toEqual({
        devices: [
          { deviceIndex: 0, totalBytes: 8 * 1024 * 1024 * 1024, usedBytes: 2 * 1024 * 1024 * 1024 },
          { deviceIndex: 1, totalBytes: 8 * 1024 * 1024 * 1024, usedBytes: 1024 * 1024 * 1024 },
        ],
        processes: [
          { deviceIndex: 0, pid: 111, usedBytes: 50 * 1024 * 1024 },
          { deviceIndex: 1, pid: 222, usedBytes: 20 * 1024 * 1024 },
        ],
      });
      // The whole point of readSample() over calling readDeviceMemory()+readProcesses() is a
      // single enumeration per call.
      expect(mockGetAllDevices).toHaveBeenCalledTimes(1);
    });

    it('tolerates a device whose memory query fails while still returning its processes', async () => {
      mockInit.mockImplementation(() => undefined);
      mockGetAllDevices.mockReturnValue([
        fakeDevice(0, null, [{ gpuIndex: 0, pid: 111, processName: 'python3', usedMemoryMiB: 50 }]),
      ]);

      const reader = await createNvmlReader();
      const sample = reader!.readSample();

      expect(sample).toEqual({
        devices: [],
        processes: [{ deviceIndex: 0, pid: 111, usedBytes: 50 * 1024 * 1024 }],
      });
    });

    it('returns null when device enumeration fails', async () => {
      mockInit.mockImplementation(() => undefined);
      mockGetAllDevices.mockImplementation(() => {
        throw new Error('nvmlDeviceGetCount failed');
      });

      const reader = await createNvmlReader();
      expect(reader!.readSample()).toBeNull();
    });

    it('returns null after shutdown', async () => {
      mockInit.mockImplementation(() => undefined);
      mockGetAllDevices.mockReturnValue([fakeDevice(0, { total: 0n, free: 0n, used: 0n }, [])]);

      const reader = await createNvmlReader();
      reader!.shutdown();

      expect(reader!.readSample()).toBeNull();
    });
  });
});
