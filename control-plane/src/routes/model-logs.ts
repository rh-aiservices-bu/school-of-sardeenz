import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';

import type { RouteDeps } from './deps.js';
import { ControlPlaneError } from '../errors.js';

const POLL_INTERVAL_MS = 500;
const PING_INTERVAL_MS = 30_000;
const DEFAULT_MAX_WAIT_MS = 5 * 60_000;

/**
 * Bound how long we'll wait, polling model state, for the runner to be placed before
 * giving up. Uses the configured deploy timeout when sensible, but never longer than
 * DEFAULT_MAX_WAIT_MS — a runaway/misconfigured deploy timeout shouldn't pin a log
 * connection open indefinitely.
 */
function resolveMaxWaitMs(config: RouteDeps['config']): number {
  const configured = config?.deployTimeoutSecs;
  if (typeof configured === 'number' && configured > 0) {
    return Math.min(configured * 1000, DEFAULT_MAX_WAIT_MS);
  }
  return DEFAULT_MAX_WAIT_MS;
}

export function registerModelLogRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get<{ Params: { modelName: string } }>(
    '/api/v1/models/:modelName/logs',
    async (request, reply) => {
      const { modelName } = request.params;

      // Mirror the GET /:modelName detail route's not-found check — do this BEFORE
      // hijacking, since a 404 after hijack can't be delivered as a normal HTTP error
      // (EventSource treats any post-hijack non-200 as an unrecoverable connection reset).
      const [initialState, record] = await Promise.all([
        deps.lifecycle.getState(modelName),
        deps.modelRepository.findByName(modelName),
      ]);

      if (!initialState && !record) {
        throw ControlPlaneError.modelNotFound(modelName);
      }

      await reply.hijack();

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
      const writeComment = (comment: string): void => {
        reply.raw.write(`: ${comment}\n\n`);
      };

      const abortController = new AbortController();
      const maxWaitMs = resolveMaxWaitMs(deps.config);
      const waitStartedAt = Date.now();

      let ended = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let upstreamStream: Readable | undefined;

      const pingTimer = setInterval(() => {
        write('ping', new Date().toISOString());
      }, PING_INTERVAL_MS);

      const cleanup = (): void => {
        if (ended) return;
        ended = true;
        if (pollTimer) clearInterval(pollTimer);
        clearInterval(pingTimer);
        abortController.abort();
        upstreamStream?.destroy();
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      };

      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);

      // Guards a single in-flight attach attempt so overlapping poll ticks (poll is async and the
      // interval doesn't await it) can't open two upstream connections.
      let attaching = false;

      // Try to attach to the worker's by-model log stream. Returns true once the attach is
      // resolved (piping started, or a terminal error was surfaced) so the poll loop can stop;
      // returns false to signal "retry" — the worker hasn't received the start command yet (404),
      // the worker isn't reachable, or its management URL isn't known yet.
      const tryAttach = async (workerId: string): Promise<boolean> => {
        const worker = deps.workerPool.getWorker(workerId);
        if (!worker || !worker.managementUrl) return false;

        const workerClient = deps.createWorkerClient(worker.managementUrl);

        let upstream: Response;
        try {
          upstream = await workerClient.streamRunnerLogsByModel(modelName, abortController.signal);
        } catch {
          // Worker unreachable (e.g. still coming up) — retry on the next tick.
          return false;
        }

        if (ended) return true;

        if (upstream.status === 404) {
          // Runner not registered on the worker yet — the start command is in flight. Retry.
          return false;
        }

        if (!upstream.ok || !upstream.body) {
          write('end', `worker returned ${upstream.status}`);
          cleanup();
          return true;
        }

        upstreamStream = Readable.fromWeb(
          upstream.body as unknown as NodeWebReadableStream<Uint8Array>,
        );
        upstreamStream.on('error', () => cleanup());
        upstreamStream.on('end', () => {
          if (!ended) write('end', '');
          cleanup();
        });
        upstreamStream.pipe(reply.raw, { end: false });
        return true;
      };

      // Deploy is async: the model reaches STARTING (workerId set) before the worker has actually
      // received the start command, and the runnerId isn't known to the control plane until the
      // worker's blocking start call returns (after the runner is healthy — too late to watch
      // startup). So we attach by *model name* as soon as workerId is known and retry until the
      // worker's by-model endpoint is live, writing keepalive comments meanwhile and bounding the
      // wait by maxWaitMs so a stuck deploy doesn't hold the connection forever.
      const poll = async (): Promise<void> => {
        if (ended || attaching) return;

        let current;
        try {
          current = await deps.lifecycle.getState(modelName);
        } catch {
          return;
        }

        if (ended) return;

        if (!current) {
          write('end', 'model removed');
          cleanup();
          return;
        }

        if (current.workerId) {
          attaching = true;
          try {
            const done = await tryAttach(current.workerId);
            if (done) {
              if (pollTimer) clearInterval(pollTimer);
              return;
            }
          } finally {
            attaching = false;
          }
        }

        if (ended) return;

        if (Date.now() - waitStartedAt >= maxWaitMs) {
          write('end', 'timed out waiting for runner placement');
          cleanup();
          return;
        }

        writeComment('waiting');
      };

      // Check immediately so an already-running runner (the common case, e.g. "View logs" on an
      // ACTIVE model) doesn't pay the first poll interval as latency.
      await poll();
      if (!ended && !upstreamStream) {
        pollTimer = setInterval(() => {
          poll().catch(() => cleanup());
        }, POLL_INTERVAL_MS);
      }
    },
  );
}
