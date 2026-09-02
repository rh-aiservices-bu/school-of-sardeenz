/**
 * Delete-affordance gating (#172).
 *
 * After #140 the control plane rejects `DELETE /api/v1/models/{modelName}` and
 * `DELETE .../instances/{instanceId}` with `409 INVALID_STATE` while an instance is in a
 * transient state (`PENDING`, `STARTING`, `DRAINING`, `STOPPING`). These pure predicates
 * drive whether the dashboard renders each Delete affordance, so the UI matches the API and
 * the logic is unit-testable without rendering PatternFly (PF/React version conflicts in this
 * worktree — see role-visibility.test.tsx).
 */
import { ModelLifecycleState } from '@sardeenz/types';

/** States for which the control plane 409s a DELETE (#140). */
export const TRANSIENT_STATES: readonly ModelLifecycleState[] = [
  ModelLifecycleState.PENDING,
  ModelLifecycleState.STARTING,
  ModelLifecycleState.DRAINING,
  ModelLifecycleState.STOPPING,
];

/** True when `state` is one the control plane rejects DELETE for. */
export function isTransientState(state: ModelLifecycleState): boolean {
  return TRANSIENT_STATES.includes(state);
}

/**
 * List-view (ModelInfo) row Delete gate. ModelInfo exposes only the aggregate `state`, not
 * per-instance states, so the row gates on the aggregate — a model whose aggregate is transient
 * would 409.
 */
export function canDeleteModelRow(state: ModelLifecycleState): boolean {
  return !isTransientState(state);
}

/**
 * Detail-view model Delete gate. ModelDetail exposes `instances`, so gate on "any instance
 * transient": the API rejects a mixed `ACTIVE`+`STARTING` model even though its aggregate is
 * `ACTIVE`.
 */
export function canDeleteModelDetail(
  instances: ReadonlyArray<{ state: ModelLifecycleState }>,
): boolean {
  return !instances.some((i) => isTransientState(i.state));
}

/** Per-instance Delete gate — gate on the instance's own state. */
export function canDeleteInstanceRow(state: ModelLifecycleState): boolean {
  return !isTransientState(state);
}
