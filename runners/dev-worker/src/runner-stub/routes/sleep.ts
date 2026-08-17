import type { FastifyInstance } from 'fastify';
import type { RunnerStateMachine } from '../state.js';

export interface SleepRouteConfig {
  sleepDelayMs: number;
  wakeDelayMs: number;
  requiredMemory: number;
}

export function registerSleepRoutes(
  app: FastifyInstance,
  stateMachine: RunnerStateMachine,
  config: SleepRouteConfig,
): void {
  const SUPPORTED_SLEEP_LEVELS = ['L1_HOST_RAM'];

  app.post<{ Body: { level?: string } }>('/sleep', async (req, reply) => {
    const level = req.body?.level;
    if (!level) {
      return reply.status(400).send({ error: 'Missing sleep level', code: 'BAD_REQUEST' });
    }
    if (!SUPPORTED_SLEEP_LEVELS.includes(level)) {
      return reply.status(400).send({
        error: `Unsupported sleep level: ${level}`,
        code: 'BAD_REQUEST',
        details: { supportedLevels: SUPPORTED_SLEEP_LEVELS },
      });
    }

    try {
      const freed = await stateMachine.sleep(level, config.sleepDelayMs);
      return reply.status(200).send({
        state: stateMachine.state,
        level,
        deviceMemoryFreedBytes: config.requiredMemory + freed,
      });
    } catch (err) {
      return reply.status(409).send({
        error: (err as Error).message,
        code: 'INVALID_STATE',
        details: { currentState: stateMachine.state },
      });
    }
  });

  app.post('/wake', async (_req, reply) => {
    try {
      await stateMachine.wake(config.wakeDelayMs);
      return reply.status(200).send({ state: stateMachine.state });
    } catch (err) {
      return reply.status(409).send({
        error: (err as Error).message,
        code: 'INVALID_STATE',
        details: { currentState: stateMachine.state },
      });
    }
  });

  app.get('/sleep-status', async (_req, reply) => {
    const isSleeping = stateMachine.state === 'SLEEPING';
    const response: Record<string, unknown> = { isSleeping };
    if (isSleeping && stateMachine.sleepLevel) {
      response.level = stateMachine.sleepLevel;
    }
    return reply.status(200).send(response);
  });
}
