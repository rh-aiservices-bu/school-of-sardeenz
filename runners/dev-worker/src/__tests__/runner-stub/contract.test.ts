import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRunnerStub, type RunnerStub } from '../../runner-stub/server.js';

describe('Runner Stub Contract Endpoints', () => {
  let stub: RunnerStub;
  let baseUrl: string;

  beforeAll(async () => {
    // Create runner stub with short delays for faster tests
    stub = createRunnerStub({
      port: 0, // Let OS assign port
      modelName: 'test-model',
      workerId: 'test-worker-1',
      runnerType: 'vllm',
      deviceType: 'cuda',
      requiredMemory: 8_000_000_000, // 8GB
      devices: [
        { deviceIndex: 0, deviceType: 'cuda' },
        { deviceIndex: 1, deviceType: 'cuda' },
      ],
      deviceMemoryTotalBytes: 24_000_000_000, // 24GB per device
      startupDelayMs: 200,
      sleepDelayMs: 100,
      wakeDelayMs: 150,
      inferenceDelayMs: 50,
    });

    // Start the stub
    await stub.start();

    // Get the assigned port from the server
    const addresses = stub.server.addresses();
    const port = (addresses[0] as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Wait for READY state
    await waitForReady(baseUrl);
  });

  afterAll(async () => {
    await stub.stop();
  });

  describe('GET /health', () => {
    it('should return state and activeRequests', async () => {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toHaveProperty('state');
      expect(data).toHaveProperty('activeRequests');
      expect(data.state).toBe('READY');
      expect(typeof data.activeRequests).toBe('number');
    });
  });

  describe('GET /memory-report', () => {
    it('should return devices array with correct shape', async () => {
      const response = await fetch(`${baseUrl}/memory-report`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toHaveProperty('devices');
      expect(Array.isArray(data.devices)).toBe(true);
      expect(data.devices).toHaveLength(2);

      // Check first device structure
      const device = data.devices[0];
      expect(device).toHaveProperty('deviceIndex');
      expect(device).toHaveProperty('deviceType');
      expect(device).toHaveProperty('memoryUsedBytes');
      expect(device).toHaveProperty('memoryTotalBytes');
      expect(device.deviceType).toBe('cuda');
      expect(device.memoryTotalBytes).toBe(24_000_000_000);
      // Should be using memory when READY (not sleeping)
      expect(device.memoryUsedBytes).toBeGreaterThan(0);
    });
  });

  describe('GET /capabilities', () => {
    it('should return correct runnerType, engineName, and capabilities', async () => {
      const response = await fetch(`${baseUrl}/capabilities`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.runnerType).toBe('vllm');
      expect(data.engineName).toBe('Dev Stub (vllm)');
      expect(data.engineVersion).toBe('0.0.1-dev');
      expect(data.supportedModelTypes).toEqual(['LLM']);
      expect(data.supportedDeviceTypes).toEqual(['cuda']);
      expect(data.supportedSleepLevels).toEqual(['L1_HOST_RAM']);
      expect(data.maxTensorParallelism).toBe(1);
      expect(data.features).toEqual({ streamingInference: true });
    });
  });

  describe('GET /progress', () => {
    it('should return phase, percentComplete, and message', async () => {
      const response = await fetch(`${baseUrl}/progress`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toHaveProperty('phase');
      expect(data).toHaveProperty('percentComplete');
      expect(data).toHaveProperty('message');
      expect(data.phase).toBe('READY');
      expect(data.percentComplete).toBe(100);
      expect(typeof data.message).toBe('string');
    });
  });

  describe('Sleep/Wake Cycle', () => {
    it('should start with isSleeping: false', async () => {
      const response = await fetch(`${baseUrl}/sleep-status`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.isSleeping).toBe(false);
    });

    it('should transition to SLEEPING on POST /sleep', async () => {
      const response = await fetch(`${baseUrl}/sleep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: 'L1_HOST_RAM' }),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.state).toBe('SLEEPING');
      expect(data.level).toBe('L1_HOST_RAM');
      expect(data).toHaveProperty('deviceMemoryFreedBytes');
      expect(data.deviceMemoryFreedBytes).toBeGreaterThan(0);
    });

    it('should report isSleeping: true with level after sleep', async () => {
      const response = await fetch(`${baseUrl}/sleep-status`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.isSleeping).toBe(true);
      expect(data.level).toBe('L1_HOST_RAM');
    });

    it('should show memoryUsedBytes: 0 when sleeping', async () => {
      const response = await fetch(`${baseUrl}/memory-report`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.devices[0].memoryUsedBytes).toBe(0);
      expect(data.devices[1].memoryUsedBytes).toBe(0);
    });

    it('should transition back to READY on POST /wake', async () => {
      const response = await fetch(`${baseUrl}/wake`, {
        method: 'POST',
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      // State might be STARTING initially during wake
      expect(['STARTING', 'READY']).toContain(data.state);

      // Wait for READY state
      await waitForReady(baseUrl);

      // Verify it's fully READY
      const healthResponse = await fetch(`${baseUrl}/health`);
      const healthData = await healthResponse.json();
      expect(healthData.state).toBe('READY');
    });

    it('should report isSleeping: false after wake', async () => {
      const response = await fetch(`${baseUrl}/sleep-status`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.isSleeping).toBe(false);
    });

    it('should restore memory usage after wake', async () => {
      const response = await fetch(`${baseUrl}/memory-report`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.devices[0].memoryUsedBytes).toBeGreaterThan(0);
      expect(data.devices[1].memoryUsedBytes).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should return 400 for POST /sleep without level', async () => {
      const response = await fetch(`${baseUrl}/sleep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toBe('Missing sleep level');
      expect(data.code).toBe('BAD_REQUEST');
    });

    it('should return 409 for POST /wake when not sleeping', async () => {
      // Ensure we're in READY state
      const healthResponse = await fetch(`${baseUrl}/health`);
      const healthData = await healthResponse.json();
      expect(healthData.state).toBe('READY');

      // Try to wake when not sleeping
      const response = await fetch(`${baseUrl}/wake`, {
        method: 'POST',
      });

      expect(response.status).toBe(409);

      const data = await response.json();
      expect(data.code).toBe('INVALID_STATE');
      expect(data.details.currentState).toBe('READY');
    });
  });
});

/**
 * Poll /health endpoint until state is READY or timeout
 */
async function waitForReady(baseUrl: string, timeoutMs = 5000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        const data = await response.json();
        if (data.state === 'READY') {
          return;
        }
      }
    } catch {
      // Server might not be ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Runner did not reach READY state within ${timeoutMs}ms`);
}
