import { ModelLifecycleState, type ControlPlaneComponents } from '@sardeenz/types';

type InstanceDetail = ControlPlaneComponents['schemas']['InstanceDetail'];

export type MoveProgress =
  | 'deploying'
  | 'cutting-over'
  | 'draining-source'
  | 'complete'
  | 'failed-before-cutover'
  | 'failed-after-cutover'
  | 'unavailable';

// A 202 may arrive before Redis/SSE propagates the replacement.  Do not leave the dialog in an
// unbounded spinner if the pre-cutover replacement was immediately removed.
export const MOVE_REPLACEMENT_OBSERVATION_TIMEOUT_MS = 30_000;

/** Interpret the two observable instance records; moves intentionally have no durable operation. */
export function classifyMoveProgress(
  instances: InstanceDetail[] | undefined,
  sourceInstanceId: string,
  replacementInstanceId: string,
  replacementWasObserved = false,
  acceptedAt?: number,
  now = Date.now(),
): MoveProgress {
  if (!instances) return 'unavailable';
  const source = instances.find((instance) => instance.instanceId === sourceInstanceId);
  const replacement = instances.find((instance) => instance.instanceId === replacementInstanceId);
  // A 202 can precede cache/SSE propagation. Missing once is pending, not a failed move; only a
  // disappearance after observation is terminal evidence before cutover.
  if (!replacement) {
    const observationTimedOut =
      acceptedAt !== undefined && now - acceptedAt >= MOVE_REPLACEMENT_OBSERVATION_TIMEOUT_MS;
    return source && (replacementWasObserved || observationTimedOut)
      ? 'failed-before-cutover'
      : 'deploying';
  }
  if (
    replacement.state === ModelLifecycleState.ERROR ||
    replacement.state === ModelLifecycleState.STOPPED
  )
    return 'failed-before-cutover';
  if (!source) return replacement.state === ModelLifecycleState.ACTIVE ? 'complete' : 'unavailable';
  if (
    replacement.state === ModelLifecycleState.ACTIVE &&
    (source.state === ModelLifecycleState.ERROR || source.state === ModelLifecycleState.STOPPED)
  )
    return 'failed-after-cutover';
  if (
    replacement.state === ModelLifecycleState.ACTIVE &&
    source.state === ModelLifecycleState.DRAINING
  )
    return 'draining-source';
  if (
    replacement.state === ModelLifecycleState.ACTIVE &&
    source.state === ModelLifecycleState.ACTIVE
  )
    return 'cutting-over';
  return 'deploying';
}
