import { describe, expect, it, vi } from 'vitest';

import { StartupLogCaptureService } from '../startup-log-capture.js';

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

describe('StartupLogCaptureService', () => {
  it('persists replayed startup lines by instance and seals the capture', async () => {
    const repository = {
      createSession: vi.fn(() => Promise.resolve()),
      clearLines: vi.fn(() => Promise.resolve()),
      append: vi.fn(
        (instanceId: string, lines: Array<{ ts: string; stream: string; content: string }>) => {
          void instanceId;
          void lines;
          return Promise.resolve();
        },
      ),
      markCaptureComplete: vi.fn(() => Promise.resolve()),
      markOutcome: vi.fn(() => Promise.resolve()),
      listIncomplete: vi.fn(() => Promise.resolve([])),
    };
    const streamRunnerLogsByInstance = vi.fn(() =>
      Promise.resolve(
        sseResponse([
          'event: log\ndata: {"ts":"2026-09-10T00:00:00.000Z","stream":"stdout","content":"loading"}\n\n',
          'event: log\ndata: {"ts":"2026-09-10T00:00:01.000Z","stream":"stderr","content":"CUDA mismatch"}\n\n',
          'event: end\ndata: \n\n',
        ]),
      ),
    );
    const service = new StartupLogCaptureService(
      repository as never,
      { getWorker: vi.fn(() => ({ managementUrl: 'http://worker-1' })) } as never,
      vi.fn(() => ({ streamRunnerLogsByInstance })) as never,
    );

    await service.start('inst-1', 'model-a', 'worker-1');

    await vi.waitFor(() => expect(repository.markCaptureComplete).toHaveBeenCalledWith('inst-1'));
    expect(repository.createSession).toHaveBeenCalledWith('inst-1', 'model-a', 'worker-1');
    expect(repository.clearLines).toHaveBeenCalledWith('inst-1');
    expect(repository.append.mock.calls.flatMap(([, lines]) => lines)).toEqual([
      { ts: '2026-09-10T00:00:00.000Z', stream: 'stdout', content: 'loading' },
      { ts: '2026-09-10T00:00:01.000Z', stream: 'stderr', content: 'CUDA mismatch' },
    ]);
  });

  it('records startup outcome independently from capture completion', async () => {
    const repository = {
      createSession: vi.fn(() => Promise.resolve()),
      clearLines: vi.fn(() => Promise.resolve()),
      append: vi.fn(() => Promise.resolve()),
      markCaptureComplete: vi.fn(() => Promise.resolve()),
      markOutcome: vi.fn(() => Promise.resolve()),
      listIncomplete: vi.fn(() => Promise.resolve([])),
    };
    const service = new StartupLogCaptureService(
      repository as never,
      { getWorker: vi.fn(() => null) } as never,
      vi.fn() as never,
    );

    await service.markSucceeded('inst-ok');
    await service.markFailed('inst-bad', 'wrong CUDA version');

    expect(repository.markOutcome).toHaveBeenCalledWith('inst-ok', 'SUCCEEDED');
    expect(repository.markOutcome).toHaveBeenCalledWith('inst-bad', 'FAILED', 'wrong CUDA version');
  });
});
