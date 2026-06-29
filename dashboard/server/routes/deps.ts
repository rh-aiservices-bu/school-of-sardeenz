import type { Config } from '../config.js';
import type { ControlPlaneClient } from '../clients/control-plane.js';
import type { RedisReader } from '../clients/redis.js';
import type { PrometheusClient } from '../clients/prometheus.js';

export interface RouteDeps {
  config: Config;
  controlPlane: ControlPlaneClient;
  redis: RedisReader;
  prometheus: PrometheusClient;
}
