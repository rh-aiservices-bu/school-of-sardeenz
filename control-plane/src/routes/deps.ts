import type { Config } from '../config.js';
import type { ModelRepository } from '../services/model-repository.js';
import type { ModelLifecycleService } from '../services/model-lifecycle.js';
import type { MemoryBudgetService } from '../services/memory-budget.js';
import type { WorkerPoolService } from '../services/worker-pool.js';
import type { RoutingMapService } from '../services/routing-map.js';
import type { PlacementPipeline } from '../services/placement.js';
import type { EvictionEngine } from '../services/eviction.js';
import type { SleepWakeService } from '../services/sleep-wake.js';
import type { LeaderElectionService } from '../services/leader-election.js';
import type { RunnerClient } from '../clients/runner.js';

export interface RouteDeps {
  config: Config;
  modelRepository: ModelRepository;
  lifecycle: ModelLifecycleService;
  memoryBudget: MemoryBudgetService;
  workerPool: WorkerPoolService;
  routingMap: RoutingMapService;
  placement: PlacementPipeline;
  eviction: EvictionEngine;
  sleepWake: SleepWakeService;
  leaderElection: LeaderElectionService;
  createRunnerClient: (host: string, port: number) => RunnerClient;
}
