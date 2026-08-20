import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  ApptainerLauncher,
  DEFAULT_APPTAINER_CONFIG,
  type ApptainerLauncherConfig,
  type ApptainerLauncherDeps,
  type ChildHandle,
} from '../apptainer-launcher.js';
import type { LaunchSpec } from '../launcher.js';

function makeSpec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    runnerId: 'runner-abc',
    modelName: 'llama',
    modelPath: '/weights/llama',
    runnerType: 'vllm',
    runtimeModule: 'vllm-0.21',
    deviceType: 'CUDA',
    requiredMemory: 1024,
    tensorParallel: 1,
    devices: [{ deviceIndex: 2, deviceType: 'CUDA' }],
    port: 9101,
    ...overrides,
  };
}

// A fake child process: an EventEmitter with a spyable kill().
class FakeChild extends EventEmitter implements ChildHandle {
  pid = 4242;
  exitCode: number | null = null;
  kill = vi.fn(() => true);
}

function makeLauncher(
  configOverrides: Partial<ApptainerLauncherConfig> = {},
  deps: ApptainerLauncherDeps = {},
): { launcher: ApptainerLauncher; child: FakeChild; spawn: ReturnType<typeof vi.fn> } {
  const child = new FakeChild();
  const spawn = vi.fn(() => child);
  const launcher = new ApptainerLauncher(
    { ...DEFAULT_APPTAINER_CONFIG, ...configOverrides },
    {
      spawn,
      runOnce: () => Promise.resolve(0),
      healthCheck: () => Promise.resolve({ state: 'READY' }),
      sleep: () => Promise.resolve(),
      now: () => 0,
      ...deps,
    },
  );
  return { launcher, child, spawn };
}

describe('ApptainerLauncher.buildExecPlan', () => {
  it('constructs the apptainer exec command with --nv, binds, cache redirects and entrypoint', () => {
    const { launcher } = makeLauncher();
    const plan = launcher.buildExecPlan(makeSpec());

    expect(plan.command).toBe('apptainer');
    expect(plan.sifPath).toBe('/modules/vllm-0.21.sif');

    const args = plan.args;
    expect(args[0]).toBe('exec');
    expect(args).toContain('--cleanenv');
    expect(args).toContain('--nv');
    expect(args.join(' ')).toContain('--bind /weights');
    expect(args.join(' ')).toContain('--bind /scratch');
    expect(args).toContain('--env');
    expect(args).toContain('XDG_CACHE_HOME=/scratch/cache');
    expect(args).toContain('HF_HOME=/scratch/cache/huggingface');
    expect(args).toContain('FLASHINFER_WORKSPACE_DIR=/scratch/cache/flashinfer');
    expect(args).toContain('ENABLE_KVCACHED=true');
    expect(args).toContain('KVCACHED_AUTOPATCH=1');
    expect(args).toContain('CUDA_VISIBLE_DEVICES=2');

    // SIF path precedes the entrypoint, which precedes the model/port flags.
    const sifIdx = args.indexOf('/modules/vllm-0.21.sif');
    expect(args.slice(sifIdx + 1, sifIdx + 4)).toEqual(['python3', '-m', 'sardeenz_vllm_runner']);
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('/weights/llama');
    expect(args[args.indexOf('--port') + 1]).toBe('9101');
  });

  it('sets HOME as a process env var, never as an --env flag (Apptainer rejects --env HOME)', () => {
    const { launcher } = makeLauncher();
    const plan = launcher.buildExecPlan(makeSpec());

    expect(plan.env.HOME).toBe('/scratch/home');
    expect(plan.args).not.toContain('HOME=/scratch/home');
    expect(plan.args.filter((a) => a.startsWith('HOME='))).toHaveLength(0);
  });

  it('omits --nv and CUDA_VISIBLE_DEVICES for CPU runners', () => {
    const { launcher } = makeLauncher();
    const plan = launcher.buildExecPlan(
      makeSpec({ deviceType: 'CPU', devices: [{ deviceIndex: 0, deviceType: 'CPU' }] }),
    );
    expect(plan.args).not.toContain('--nv');
    expect(plan.args.some((a) => a.startsWith('CUDA_VISIBLE_DEVICES='))).toBe(false);
  });

  it('joins multiple assigned GPU indices into CUDA_VISIBLE_DEVICES', () => {
    const { launcher } = makeLauncher();
    const plan = launcher.buildExecPlan(
      makeSpec({
        devices: [
          { deviceIndex: 0, deviceType: 'CUDA' },
          { deviceIndex: 3, deviceType: 'CUDA' },
        ],
      }),
    );
    expect(plan.args).toContain('CUDA_VISIBLE_DEVICES=0,3');
  });

  it('falls back to <runnerType>-<engineConfig.version> when runtimeModule is absent', () => {
    const { launcher } = makeLauncher();
    const plan = launcher.buildExecPlan(
      makeSpec({ runtimeModule: undefined, engineConfig: { version: '0.22' } }),
    );
    expect(plan.sifPath).toBe('/modules/vllm-0.22.sif');
  });

  it('throws when no module can be resolved', () => {
    const { launcher } = makeLauncher();
    expect(() => launcher.buildExecPlan(makeSpec({ runtimeModule: undefined }))).toThrow(
      /Cannot resolve a runtime module/,
    );
  });

  it('rejects a runtimeModule with path-traversal characters', () => {
    const { launcher } = makeLauncher();
    expect(() => launcher.buildExecPlan(makeSpec({ runtimeModule: '../../etc/evil' }))).toThrow(
      /Invalid runtime module/,
    );
    expect(() => launcher.buildExecPlan(makeSpec({ runtimeModule: 'vllm/0.21' }))).toThrow(
      /Invalid runtime module/,
    );
  });
});

describe('ApptainerLauncher.start', () => {
  it('verifies the SIF, spawns the exec, and resolves once healthy', async () => {
    const runOnce = vi.fn(() => Promise.resolve(0));
    const healthCheck = vi.fn(() => Promise.resolve({ state: 'READY' }));
    const { launcher, spawn, child } = makeLauncher({}, { runOnce, healthCheck });

    const handle = await launcher.start(makeSpec());

    expect(runOnce).toHaveBeenCalledWith('apptainer', ['verify', '/modules/vllm-0.21.sif']);
    expect(spawn).toHaveBeenCalledOnce();
    expect(handle.pid).toBe(child.pid);
    expect(handle.host).toBe('127.0.0.1');
    expect(handle.port).toBe(9101);
  });

  it('refuses to start when SIF verification fails', async () => {
    const runOnce = vi.fn(() => Promise.resolve(1));
    const { launcher, spawn } = makeLauncher({}, { runOnce });

    await expect(launcher.start(makeSpec())).rejects.toThrow(/signature verification failed/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('skips verification when verifySif is false', async () => {
    const runOnce = vi.fn(() => Promise.resolve(0));
    const { launcher } = makeLauncher({ verifySif: false }, { runOnce });
    await launcher.start(makeSpec());
    expect(runOnce).not.toHaveBeenCalled();
  });

  it('fails fast if the exec dies before becoming healthy', async () => {
    let calls = 0;
    const now = vi.fn(() => calls++ * 1000);
    const { launcher, child } = makeLauncher(
      { healthTimeoutMs: 10_000 },
      {
        healthCheck: () => {
          // Simulate the process crashing during the first poll gap.
          child.exitCode = 1;
          child.emit('exit');
          return Promise.resolve(null);
        },
        now,
        sleep: () => Promise.resolve(),
      },
    );

    await expect(launcher.start(makeSpec())).rejects.toThrow(/exited before becoming healthy/);
    // The exec already died — the launcher must not try to signal a dead process.
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('fails fast (and tears down) when the runner reports ERROR before the health timeout', async () => {
    const healthCheck = vi.fn(() =>
      Promise.resolve({ state: 'ERROR', message: 'CUDA out of memory' }),
    );
    // A long timeout + a sleep that would advance time proves we bail on ERROR, not on timeout.
    const { launcher, child } = makeLauncher(
      { healthTimeoutMs: 900_000 },
      { healthCheck, now: () => 0, sleep: () => Promise.resolve() },
    );
    // The runner is still running on ERROR (it didn't crash), so teardown SIGTERMs it; make the
    // fake child exit in response so stopChild() resolves.
    child.kill = vi.fn(() => {
      child.exitCode = 0;
      child.emit('exit');
      return true;
    });

    await expect(launcher.start(makeSpec())).rejects.toThrow(
      /reported ERROR while starting: CUDA out of memory/,
    );
    // The exec is still running (it didn't exit) — the launcher must tear it down.
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    // Only polled once — it did not spin until the timeout.
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });
});

describe('ApptainerLauncher stop / SIGTERM propagation', () => {
  it('sends SIGTERM and resolves when the child exits', async () => {
    const { launcher, child } = makeLauncher();
    const handle = await launcher.start(makeSpec());

    const stopped = handle.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit'); // child terminates in response to SIGTERM
    await expect(stopped).resolves.toBeUndefined();
  });

  it('escalates to SIGKILL if the child does not exit within the grace period', async () => {
    vi.useFakeTimers();
    try {
      const { launcher, child } = makeLauncher({ stopGraceMs: 5_000 });
      const handle = await launcher.start(makeSpec());

      const stopped = handle.stop();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

      vi.advanceTimersByTime(5_000);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');

      child.emit('exit');
      await expect(stopped).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
