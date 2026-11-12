import { ControlPlaneError } from '../errors.js';

// Mirrors the inst-<12hex> mint format (routes/models.ts:86-88) but deliberately looser: legacy
// and manually created ids must keep working (#120 hardened modelName, not instanceId). Excludes
// `:` (extra redisKey segments — instanceId flows into Redis keys built by plain string join at
// clients/redis.ts:27-29 via ModelLifecycleService.instanceStateKey), the glob metacharacters
// `* ? [ ]`, `/` and whitespace. Exact-key GET/SET/DEL only; never a SCAN MATCH pattern (#236
// review, security perspective).
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Reject any instanceId path param that doesn't match INSTANCE_ID_PATTERN, before it reaches any
 * Redis key or Postgres query. Every route that takes instanceId from the URL path must call this
 * first — the mint path already produces conforming ids (routes/models.ts:86-88); this closes the
 * gap on every read/action route.
 */
export function assertValidInstanceId(instanceId: string): void {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw ControlPlaneError.invalidRequest(`instanceId must match ${INSTANCE_ID_PATTERN.source}`);
  }
}
