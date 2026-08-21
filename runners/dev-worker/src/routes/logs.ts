import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { RunnerManager } from '../runner-manager.js';
import type { RunnerLogLine } from '../runner-log-buffer.js';

// SSE endpoints the control plane proxies to the dashboard so operators can watch a runner's
// launch logs (e.g. vLLM weight loading) in real time. Mirrors the SSE pattern in
// control-plane/src/routes/events.ts: validate before hijacking, write headers + flush, then
// stream frames until the client disconnects or the runner ends.
//
// Two ways to address a runner's logs:
//   - by runnerId   — for a runner the control plane already knows the id of (e.g. "View logs"
//                     on a running model).
//   - by modelName  — for a *cold-starting* runner. The control plane learns the runnerId only
//                     once the worker's blocking start call returns (after the runner is healthy),
//                     which is too late to watch startup. Keying by model lets it attach during
//                     cold-start, since the worker knows the model→runner mapping the instant the
//                     start command arrives.
export function registerLogRoutes(app: FastifyInstance, runnerManager: RunnerManager): void {
  const logBuffer = runnerManager.getLogBuffer();

  // Hijack the socket and stream a runner's buffered-then-live log lines. Assumes the caller has
  // already validated that the runnerId is known (so a 404 can still be sent as normal JSON).
  const stream = (req: FastifyRequest, reply: FastifyReply, runnerId: string): void => {
    reply.hijack();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders();

    const write = (event: string, data: string): void => {
      reply.raw.write(`event: ${event}\ndata: ${data}\n\n`);
    };
    const writeLog = (line: RunnerLogLine): void => {
      write('log', JSON.stringify(line));
    };

    // Replay what's already buffered, then subscribe for live lines.
    for (const line of logBuffer.getBuffer(runnerId)) {
      writeLog(line);
    }

    // If the runner's stream already ended (startup finished, or the runner stopped) before this
    // client connected, the replay above is the whole story — send `end` now so the client stops
    // waiting for live lines that will never come. This is the "View starting logs" reopen path:
    // the sealed startup logs replay, then the stream closes cleanly.
    if (logBuffer.isEnded(runnerId)) {
      write('end', '{}');
    }

    const unsubscribeLog = logBuffer.onLog(runnerId, writeLog);
    const unsubscribeEnd = logBuffer.onEnd(runnerId, () => {
      write('end', '{}');
    });

    const pingInterval = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, 30_000);

    const cleanup = (): void => {
      clearInterval(pingInterval);
      unsubscribeLog();
      unsubscribeEnd();
    };

    // reply.hijack() already told Fastify not to manage this response — the handler can return
    // once listeners are wired; the connection itself stays open until the client disconnects.
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  };

  app.get<{ Params: { runnerId: string } }>('/runners/:runnerId/logs', async (req, reply) => {
    const { runnerId } = req.params;

    // Validate before hijacking — a 404 after hijack can't be expressed as a normal JSON response.
    // Accept a runner that's known OR that already has buffered lines (a cold-starting runner whose
    // record isn't in the `runners` map yet).
    if (!runnerManager.getRunner(runnerId) && !logBuffer.has(runnerId)) {
      return reply.status(404).send({ error: `Runner ${runnerId} not found`, code: 'NOT_FOUND' });
    }

    stream(req, reply, runnerId);
  });

  app.get<{ Params: { modelName: string } }>(
    '/runners/by-model/:modelName/logs',
    async (req, reply) => {
      const { modelName } = req.params;

      // Resolve via the model→runner map, which is set the instant startRunner() begins — so this
      // works during cold-start, before the runner is healthy and before the control plane knows
      // the runnerId. 404 (pre-hijack) until the worker has actually received the start command.
      const runnerId = runnerManager.getRunnerIdForModel(modelName);
      if (!runnerId) {
        return reply
          .status(404)
          .send({ error: `No runner for model ${modelName}`, code: 'NOT_FOUND' });
      }

      stream(req, reply, runnerId);
    },
  );
}
