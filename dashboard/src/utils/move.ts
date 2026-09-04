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

/** Interpret the two observable instance records; moves intentionally have no durable operation. */
export function classifyMoveProgress(
  instances: InstanceDetail[] | undefined,
  sourceInstanceId: string,
  replacementInstanceId: string,
  replacementWasObserved = false,
): MoveProgress {
  if (!instances) return 'unavailable';
  const source = instances.find((instance) => instance.instanceId === sourceInstanceId);
  const replacement = instances.find((instance) => instance.instanceId === replacementInstanceId);
  // A 202 can precede cache/SSE propagation. Missing once is pending, not a failed move; only a
  // disappearance after observation is terminal evidence before cutover.
  if (!replacement) return source && replacementWasObserved ? 'failed-before-cutover' : 'deploying';
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
