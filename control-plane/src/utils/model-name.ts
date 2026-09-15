import { Protocol } from '@sardeenz/types';
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

/**
 * MODEL_NAME_PATTERN deliberately permits `/` — openai models are routed by the request-body
 * `model` field, and HuggingFace-style names (`meta-llama/Llama-3.1-8B-Instruct`) rely on it. But
 * the proxy's oip surface routes `POST /oip/v2/models/{model}/infer` where axum's `{model}`
 * matches a single path segment, so an oip model whose name contains `/` would appear in
 * `GET /oip/v2/models` yet be unroutable (#125 Unit A review L2). Scoped to `oip` only, so it
 * never tightens existing openai/vLLM naming.
 */
export function assertModelNameRoutableForProtocol(modelName: string, protocol: Protocol): void {
  if (protocol === Protocol.oip && modelName.includes('/')) {
    throw ControlPlaneError.invalidRequest(
      "modelName must not contain '/' for an oip-protocol runner: the KServe V2 surface routes " +
        'POST /oip/v2/models/{model}/infer by a single path segment, so a name with a slash would ' +
        'be listed but unroutable',
    );
  }
}
