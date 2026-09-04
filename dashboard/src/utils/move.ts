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
): MoveProgress {
  if (!instances) return 'unavailable';
  const source = instances.find((instance) => instance.instanceId === sourceInstanceId);
  const replacement = instances.find((instance) => instance.instanceId === replacementInstanceId);
  if (!replacement) return source ? 'failed-before-cutover' : 'unavailable';
  if (replacement.state === ModelLifecycleState.ERROR) return 'failed-before-cutover';
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
