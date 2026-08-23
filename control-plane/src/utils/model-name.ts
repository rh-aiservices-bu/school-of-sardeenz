import { ControlPlaneError } from '../errors.js';

// Mirrors ModelDeploymentRequest.modelName in packages/contracts/specs/control-plane.yaml.
// Deliberately excludes glob metacharacters (`* ? [ ]`) and `:` — modelName flows into Redis SCAN
// MATCH patterns built by plain string join (ModelLifecycleService.getInstancesForModel /
// getAllInstances), so an unvalidated glob lets one request fan out across every model's Redis
// keys (#120 review, security M1: `DELETE /api/v1/models/*` wiping the whole instances ledger).
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * Reject any modelName path/body param that doesn't match MODEL_NAME_PATTERN, before it reaches
 * any Redis SCAN or Postgres query. Every route that takes modelName from the URL path or a
 * request body must call this first — the create path already validated its body; this closes
 * the gap on every read/action route.
 */
export function assertValidModelName(modelName: string): void {
  if (!MODEL_NAME_PATTERN.test(modelName)) {
    throw ControlPlaneError.invalidRequest('modelName must match ^[A-Za-z0-9._/-]{1,200}$');
  }
}
