import type { FastifyReply } from 'fastify';

/** Error used as the abort reason when the browser client disconnects before the upstream
 *  call completes. Not user-facing; lets error mapping distinguish disconnect from timeout. */
export class ClientDisconnectedError extends Error {
  constructor() {
    super('Client disconnected before upstream call completed');
    this.name = 'ClientDisconnectedError';
  }
}

export interface UpstreamSignal {
  /** Signal to pass to fetch — aborts on upstream timeout OR client disconnect. */
  readonly signal: AbortSignal;
  /** Call in a finally block to remove the reply listeners regardless of outcome. */
  readonly done: () => void;
}

/**
 * Composes the configured upstream timeout with the browser request's disconnect signal for a
 * buffered (non-streaming) upstream call. The disconnect half hangs off `reply.raw`
 * ('close'/'error'), NOT `request.raw` — on a body-carrying request the IncomingMessage 'close'
 * fires when the body finishes being consumed (before the handler's fetch), which would abort
 * every JSON POST. See routes/inference.ts for the streaming-route shape this mirrors.
 */
export function composeUpstreamSignal(timeoutMs: number, reply: FastifyReply): UpstreamSignal {
  const controller = new AbortController();
  const onDisconnect = (): void => {
    if (!reply.raw.writableEnded) controller.abort(new ClientDisconnectedError());
  };
  reply.raw.on('close', onDisconnect);
  reply.raw.on('error', onDisconnect);
  return {
    // Timeout first so its TimeoutError reason wins when both abort at once.
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), controller.signal]),
    done: () => {
      reply.raw.removeListener('close', onDisconnect);
      reply.raw.removeListener('error', onDisconnect);
    },
  };
}
