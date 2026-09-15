import type { Config } from '../config.js';
import type { ControlPlaneClient } from '../clients/control-plane.js';
import type { RedisReader } from '../clients/redis.js';
import type { PrometheusClient } from '../clients/prometheus.js';
import type { InferenceClient } from '../clients/inference.js';
import type { GithubRepoStatsClient } from '../clients/github.js';

export interface RouteDeps {
  config: Config;
  controlPlane: ControlPlaneClient;
  redis: RedisReader;
  prometheus: PrometheusClient;
  inference: InferenceClient;
  githubRepoStats: GithubRepoStatsClient;
}
