import type { FastifyInstance } from 'fastify';
import type { RunnerStateMachine } from '../state.js';

export interface V2InferenceConfig {
  modelName: string;
  workerId: string;
  inferenceDelayMs: number;
}

// KServe V2 Open Inference Protocol stub routes, selected for `runnerType: 'mlserver'` (see
// server.ts's isOipRunnerType). The proxy strips the `/oip` prefix before forwarding, so these
// serve the canonical `/v2/...` paths — mirrors registerInferenceRoutes' OpenAI surface, but unary
// only (no SSE streaming; V2 infer has no streaming equivalent in this stub).
export function registerV2InferenceRoutes(
  app: FastifyInstance,
  stateMachine: RunnerStateMachine,
  config: V2InferenceConfig,
): void {
  app.post<{ Params: { model: string } }>('/v2/models/:model/infer', async (req, reply) => {
    if (stateMachine.state !== 'READY' && stateMachine.state !== 'BUSY') {
      return reply.status(503).send({
        error: `Model is not ready (current state: ${stateMachine.state})`,
      });
    }

    stateMachine.incrementRequests();

    try {
      await delay(config.inferenceDelayMs);

      return reply.status(200).send({
        model_name: req.params.model,
        model_version: 'v1',
        outputs: [
          {
            name: 'predict',
            datatype: 'FP32',
            shape: [1],
            data: [0],
          },
        ],
      });
    } finally {
      stateMachine.decrementRequests();
    }
  });

  app.get<{ Params: { model: string } }>('/v2/models/:model/ready', async (req, reply) => {
    if (stateMachine.state !== 'READY') {
      return reply.status(503).send({ name: req.params.model, ready: false });
    }
    return reply.status(200).send({ name: req.params.model, ready: true });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
