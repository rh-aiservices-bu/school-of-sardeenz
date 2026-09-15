import type { FastifyInstance, FastifyReply } from 'fastify';
import type { RunnerStateMachine } from '../state.js';
import { randomUUID } from 'node:crypto';

export interface InferenceConfig {
  modelName: string;
  workerId: string;
  inferenceDelayMs: number;
}

const STREAMING_TOKENS = [
  'This',
  ' is',
  ' a',
  ' simulated',
  ' response',
  ' from',
  ' the',
  ' dev',
  ' worker',
  ' stub.',
  ' The',
  ' model',
  ' is',
  ' running',
  ' on',
  ' a',
  ' simulated',
  ' device.',
];

export function registerInferenceRoutes(
  app: FastifyInstance,
  stateMachine: RunnerStateMachine,
  config: InferenceConfig,
): void {
  app.post<{ Body: { stream?: boolean; model?: string; messages?: unknown[] } }>(
    '/v1/chat/completions',
    async (req, reply) => {
      if (stateMachine.state !== 'READY' && stateMachine.state !== 'BUSY') {
        return reply.status(503).send({
          error: {
            message: `Model is not ready (current state: ${stateMachine.state})`,
            type: 'server_error',
            code: 'model_not_ready',
          },
        });
      }

      stateMachine.incrementRequests();

      try {
        const isStream = req.body?.stream === true;

        if (isStream) {
          return await handleStreaming(reply, config);
        }

        await delay(config.inferenceDelayMs);

        const responseText = `This is a simulated response from ${config.modelName} on worker ${config.workerId}.`;
        return reply.status(200).send({
          id: `chatcmpl-${randomUUID()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: config.modelName,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: responseText },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 15,
            total_tokens: 25,
          },
        });
      } finally {
        stateMachine.decrementRequests();
      }
    },
  );

  app.get('/v1/models', async (_req, reply) => {
    return reply.status(200).send({
      object: 'list',
      data: [
        {
          id: config.modelName,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'sardeenz-dev',
        },
      ],
    });
  });
}

async function handleStreaming(reply: FastifyReply, config: InferenceConfig): Promise<void> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  reply.raw.flushHeaders();

  const tokenDelay = Math.max(10, Math.floor(config.inferenceDelayMs / STREAMING_TOKENS.length));

  for (const token of STREAMING_TOKENS) {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: config.modelName,
      choices: [
        {
          index: 0,
          delta: { content: token },
          finish_reason: null,
        },
      ],
    };
    reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    await delay(tokenDelay);
  }

  const doneChunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model: config.modelName,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: 'stop',
      },
    ],
  };
  reply.raw.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
  reply.raw.write('data: [DONE]\n\n');
  reply.raw.end();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
