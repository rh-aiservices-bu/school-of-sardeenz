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
    enginePort: 9102,
    ...overrides,
  };
}

// A fake child process: an EventEmitter with a spyable kill().
class FakeChild extends EventEmitter implements ChildHandle {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
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
      // Default: modelPath resolves to itself (no symlink). Tests exercising symlink escapes
      // override this.
      realpath: (path: string) => Promise.resolve(path),
      ...deps,
    },
  );
  return { launcher, child, spawn };
}

describe('ApptainerLauncher.buildExecPlan', () => {
  it('constructs the apptainer exec command with --nv, binds, cache redirects and entrypoint', async () => {
    const { launcher } = makeLauncher();
    const plan = await launcher.buildExecPlan(makeSpec());

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
    // The engine's OpenAI port is pinned explicitly to the worker-allocated engine port.
    expect(args[args.indexOf('--engine-port') + 1]).toBe('9102');
    // vLLM serves under the logical model name (not the weights path) so client `model` fields match.
    // Forwarded through the shim's `--` passthrough to keep working with already-built SIFs.
    const ddIdx = args.indexOf('--');
    expect(ddIdx).toBeGreaterThan(-1);
    expect(args.slice(ddIdx + 1)).toEqual(['--served-model-name', 'llama']);
  });

  it('sets HOME as a process env var, never as an --env flag (Apptainer rejects --env HOME)', async () => {
    const { launcher } = makeLauncher();
    const plan = await launcher.buildExecPlan(makeSpec());

    expect(plan.env.HOME).toBe('/scratch/home');
    expect(plan.args).not.toContain('HOME=/scratch/home');
    expect(plan.args.filter((a) => a.startsWith('HOME='))).toHaveLength(0);
  });

  it('omits --nv and CUDA_VISIBLE_DEVICES for CPU runners', async () => {
    const { launcher } = makeLauncher();
    const plan = await launcher.buildExecPlan(
      makeSpec({ deviceType: 'CPU', devices: [{ deviceIndex: 0, deviceType: 'CPU' }] }),
    );
    expect(plan.args).not.toContain('--nv');
    expect(plan.args.some((a) => a.startsWith('CUDA_VISIBLE_DEVICES='))).toBe(false);
  });

  it('passes SARDEENZ_DEVICE_INDICES alongside CUDA_VISIBLE_DEVICES for CUDA runners', async () => {
    const { launcher } = makeLauncher();
    const plan = await launcher.buildExecPlan(makeSpec());
    expect(plan.args).toContain('CUDA_VISIBLE_DEVICES=2');
    expect(plan.args).toContain('SARDEENZ_DEVICE_INDICES=2');
  });

  it('omits SARDEENZ_DEVICE_INDICES for CPU runners', async () => {
    const { launcher } = makeLauncher();
    const plan = await launcher.buildExecPlan(
      makeSpec({ deviceType: 'CPU', devices: [{ deviceIndex: 0, deviceType: 'CPU' }] }),
    );
    expect(plan.args.some((a) => a.startsWith('SARDEENZ_DEVICE_INDICES='))).toBe(false);
  });

  it('joins multiple assigned GPU indices into CUDA_VISIBLE_DEVICES', async () => {
    const { launcher } = makeLauncher();
    const plan = await launcher.buildExecPlan(
      makeSpec({
        devices: [
          { deviceIndex: 0, deviceType: 'CUDA' },
          { deviceIndex: 3, deviceType: 'CUDA' },
        ],
      }),
    );
    expect(plan.args).toContain('CUDA_VISIBLE_DEVICES=0,3');
  });

  it('falls back to <runnerType>-<engineConfig.version> when runtimeModule is absent', async () => {
    const { launcher } = makeLauncher();
    const plan = await launcher.buildExecPlan(
      makeSpec({ runtimeModule: undefined, engineConfig: { version: '0.22' } }),
    );
    expect(plan.sifPath).toBe('/modules/vllm-0.22.sif');
  });

  it('throws when no module can be resolved', async () => {
    const { launcher } = makeLauncher();
    await expect(launcher.buildExecPlan(makeSpec({ runtimeModule: undefined }))).rejects.toThrow(
      /Cannot resolve a runtime module/,
    );
  });

  it('strips APPTAINERENV_*/SINGULARITYENV_* from the spawned process env', async () => {
    const originalFoo = process.env.APPTAINERENV_FOO;
    const originalBar = process.env.SINGULARITYENV_BAR;
    process.env.APPTAINERENV_FOO = 'leaked';
    process.env.SINGULARITYENV_BAR = 'leaked';
    try {
      const { launcher } = makeLauncher();
      const plan = await launcher.buildExecPlan(makeSpec());
      expect(plan.env).not.toHaveProperty('APPTAINERENV_FOO');
      expect(plan.env).not.toHaveProperty('SINGULARITYENV_BAR');
    } finally {
      if (originalFoo === undefined) delete process.env.APPTAINERENV_FOO;
      else process.env.APPTAINERENV_FOO = originalFoo;
      if (originalBar === undefined) delete process.env.SINGULARITYENV_BAR;
      else process.env.SINGULARITYENV_BAR = originalBar;
    }
  });

  it('rejects a runtimeModule with path-traversal characters', async () => {
    const { launcher } = makeLauncher();
    await expect(
      launcher.buildExecPlan(makeSpec({ runtimeModule: '../../etc/evil' })),
    ).rejects.toThrow(/Invalid runtime module/);
    await expect(
      launcher.buildExecPlan(makeSpec({ runtimeModule: 'vllm/0.21' })),
    ).rejects.toThrow(/Invalid runtime module/);
  });

  it('appends engineArgs verbatim after --served-model-name, in order (#126)', async () => {
    const { launcher } = makeLauncher();
    const plan = await launcher.buildExecPlan(
      makeSpec({ engineArgs: ['--max-model-len=8192', '--enable-prefix-caching'] }),
    );
    const ddIdx = plan.args.indexOf('--');
    expect(plan.args.slice(ddIdx + 1)).toEqual([
      '--served-model-name',
      'llama',
      '--max-model-len=8192',
      '--enable-prefix-caching',
    ]);
  });

  it('rejects a reserved flag passed as --key value', async () => {
    const { launcher } = makeLauncher();
    await expect(
      launcher.buildExecPlan(makeSpec({ engineArgs: ['--port', '9999'] })),
    ).rejects.toThrow(/reserved/);
    await expect(
      launcher.buildExecPlan(makeSpec({ engineArgs: ['--port', '9999'] })),
    ).rejects.toThrow(/--port/);
  });

  it('rejects a reserved flag passed as --key=value (key normalization)', async () => {
    const { launcher } = makeLauncher();
    await expect(
      launcher.buildExecPlan(makeSpec({ engineArgs: ['--port=9999'] })),
    ).rejects.toThrow(/--port/);
  });

  it('rejects an unambiguous prefix abbreviation of a reserved flag (argparse allow_abbrev, #126 review)', async () => {
    const { launcher } = makeLauncher();
    await expect(
      launcher.buildExecPlan(makeSpec({ engineArgs: ['--hos=0.0.0.0'] })),
    ).rejects.toThrow(/--host/);
    await expect(
      launcher.buildExecPlan(makeSpec({ engineArgs: ['--por', '9999'] })),
    ).rejects.toThrow(/--port/);
    await expect(
      launcher.buildExecPlan(makeSpec({ engineArgs: ['--tensor-parallel'] })),
    ).rejects.toThrow(/--tensor-parallel-size/);
  });

  it('does not reject a flag that merely has a reserved flag as its own prefix (#126 review)', async () => {
    const { launcher } = makeLauncher();
    const plan = await launcher.buildExecPlan(
      makeSpec({ engineArgs: ['--model-impl=vllm'] }),
    );
    const ddIdx = plan.args.indexOf('--');
    expect(plan.args.slice(ddIdx + 1)).toEqual([
      '--served-model-name',
      'llama',
      '--model-impl=vllm',
    ]);
  });

  it('emits --tensor-parallel before the `--` separator when tensorParallel > 1 (#126 fix)', async () => {
    const { launcher } = makeLauncher();
    const plan = await launcher.buildExecPlan(makeSpec({ tensorParallel: 2 }));
    const tpIdx = plan.args.indexOf('--tensor-parallel');
    const ddIdx = plan.args.indexOf('--');
    expect(tpIdx).toBeGreaterThan(-1);
    expect(plan.args[tpIdx + 1]).toBe('2');
    // cli.py (unchanged) reads --tensor-parallel pre-`--` and maps it to vLLM's
    // --tensor-parallel-size when >1.
    expect(tpIdx).toBeLessThan(ddIdx);
  });

  it('byte-identical no-args regression: default spec (tensorParallel:1, no engineArgs) omits --tensor-parallel', async () => {
    const { launcher } = makeLauncher();
    const plan = await launcher.buildExecPlan(makeSpec());
    expect(plan.args).not.toContain('--tensor-parallel');
    const ddIdx = plan.args.indexOf('--');
    expect(plan.args.slice(ddIdx + 1)).toEqual(['--served-model-name', 'llama']);
  });
});

describe('ApptainerLauncher.buildExecPlan modelPath containment', () => {
  it('accepts a modelPath that is a direct child of the weights root', async () => {
    const { launcher } = makeLauncher();
    const plan = await launcher.buildExecPlan(makeSpec({ modelPath: '/weights/llama' }));
    expect(plan.args[plan.args.indexOf('--model') + 1]).toBe('/weights/llama');
  });

  it('rejects a relative modelPath', async () => {
    const { launcher } = makeLauncher();
    await expect(
      launcher.buildExecPlan(makeSpec({ modelPath: 'weights/llama' })),
    ).rejects.toThrow(/absolute path/);
  });

  it('rejects a modelPath that traverses out of the weights root', async () => {
    const { launcher } = makeLauncher();
    await expect(
      launcher.buildExecPlan(makeSpec({ modelPath: '/weights/../etc/passwd' })),
    ).rejects.toThrow(/escapes the weights root/);
  });

  it('rejects a modelPath equal to the weights root itself', async () => {
    const { launcher } = makeLauncher();
    await expect(launcher.buildExecPlan(makeSpec({ modelPath: '/weights' }))).rejects.toThrow(
      /escapes the weights root/,
    );
  });

  it('rejects a modelPath with a trailing separator equal to the root', async () => {
    const { launcher } = makeLauncher();
    await expect(launcher.buildExecPlan(makeSpec({ modelPath: '/weights/' }))).rejects.toThrow(
      /escapes the weights root/,
    );
  });

  it('rejects a sibling directory that merely shares the root as a string prefix', async () => {
    const { launcher } = makeLauncher();
    await expect(
      launcher.buildExecPlan(makeSpec({ modelPath: '/weights-evil/llama' })),
    ).rejects.toThrow(/escapes the weights root/);
  });

  it('rejects a modelPath resolved via a symlink that escapes the weights root', async () => {
    const { launcher } = makeLauncher(
      {},
      { realpath: () => Promise.resolve('/etc/passwd') },
    );
    await expect(
      launcher.buildExecPlan(makeSpec({ modelPath: '/weights/llama' })),
    ).rejects.toThrow(/symlink/);
  });

  it('rejects a modelPath that does not exist on disk', async () => {
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    const { launcher } = makeLauncher({}, { realpath: () => Promise.reject(err) });
    await expect(
      launcher.buildExecPlan(makeSpec({ modelPath: '/weights/llama' })),
    ).rejects.toThrow(/does not exist/);
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
    expect(handle.host).toBe(DEFAULT_APPTAINER_CONFIG.advertiseHost);
    expect(handle.port).toBe(9101);
    expect(handle.enginePort).toBe(9102);
  });

  it('uses advertiseHost from config for the launch handle host', async () => {
    const { launcher } = makeLauncher({ advertiseHost: '10.244.1.5' });

    const handle = await launcher.start(makeSpec());

    expect(handle.host).toBe('10.244.1.5');
  });

  it('still probes the health endpoint on 127.0.0.1 regardless of advertiseHost', async () => {
    const healthCheck = vi.fn(() => Promise.resolve({ state: 'READY' }));
    const { launcher } = makeLauncher({ advertiseHost: '10.244.1.5' }, { healthCheck });

    await launcher.start(makeSpec());

    expect(healthCheck).toHaveBeenCalledWith('http://127.0.0.1:9101/health');
  });

  it('calls onStartupComplete once the runner is healthy', async () => {
    const { launcher } = makeLauncher(
      {},
      { runOnce: () => Promise.resolve(0), healthCheck: () => Promise.resolve({ state: 'READY' }) },
    );
    const onStartupComplete = vi.fn();

    await launcher.start(makeSpec(), undefined, onStartupComplete);

    expect(onStartupComplete).toHaveBeenCalledOnce();
  });

  it('does not call onStartupComplete when the runner exits before becoming healthy', async () => {
    let calls = 0;
    const now = vi.fn(() => calls++ * 1000);
    // Crash the child from inside the first health poll (the launcher attaches its exit listener
    // only after the verify await + spawn, so emitting earlier would be missed).
    const { launcher, child } = makeLauncher(
      { healthTimeoutMs: 10_000 },
      {
        healthCheck: () => {
          child.exitCode = 1;
          child.emit('exit');
          return Promise.resolve(null);
        },
        now,
        sleep: () => Promise.resolve(),
      },
    );
    const onStartupComplete = vi.fn();

    await expect(launcher.start(makeSpec(), undefined, onStartupComplete)).rejects.toThrow(
      /exited before becoming healthy/,
    );
    expect(onStartupComplete).not.toHaveBeenCalled();
  });

  it('calls onExit after post-startup exit', async () => {
    const { launcher, child } = makeLauncher();
    const onExit = vi.fn();

    await launcher.start(makeSpec(), undefined, undefined, onExit);
    expect(onExit).not.toHaveBeenCalled();

    // The runner exits on its own well after start() resolved (e.g. a crash during inference).
    child.exitCode = 0;
    child.emit('exit');
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('does not call onExit during startup failure', async () => {
    let calls = 0;
    const now = vi.fn(() => calls++ * 1000);
    // Same crash-during-health-check setup as the onStartupComplete equivalent above — the exit
    // listener that drives onExit is only attached once start() resolves, so a startup-time exit
    // must not reach it.
    const { launcher, child } = makeLauncher(
      { healthTimeoutMs: 10_000 },
      {
        healthCheck: () => {
          child.exitCode = 1;
          child.emit('exit');
          return Promise.resolve(null);
        },
        now,
        sleep: () => Promise.resolve(),
      },
    );
    const onExit = vi.fn();

    await expect(launcher.start(makeSpec(), undefined, undefined, onExit)).rejects.toThrow(
      /exited before becoming healthy/,
    );
    expect(onExit).not.toHaveBeenCalled();
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

  it('resolves for a child whose exitCode is null and signalCode is SIGKILL', async () => {
    const { launcher, child } = makeLauncher();
    const handle = await launcher.start(makeSpec());

    // The process was killed by a signal (e.g. the OOM-killer) rather than exiting normally —
    // exitCode stays null, but the child has already emitted 'exit'.
    child.exitCode = null;
    child.signalCode = 'SIGKILL';
    child.emit('exit');

    await expect(handle.stop()).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalledWith('SIGTERM');
  });

  it('resolves within a bounded time even when the child never emits exit (backstop)', async () => {
    vi.useFakeTimers();
    try {
      const { launcher, child } = makeLauncher({ stopGraceMs: 5_000 });
      const handle = await launcher.start(makeSpec());

      const stopped = handle.stop();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      vi.advanceTimersByTime(5_000);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');

      // The child never emits 'exit' — only the backstop timer (stopGraceMs + 5000) resolves stop().
      vi.advanceTimersByTime(5_000);
      await expect(stopped).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
