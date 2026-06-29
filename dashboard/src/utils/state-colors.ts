import { ModelLifecycleState, WorkerStatus } from '@sardeenz/types';

export function getModelStateColor(
  state: ModelLifecycleState,
): 'green' | 'blue' | 'teal' | 'orange' | 'red' | 'grey' | 'yellow' {
  switch (state) {
    case ModelLifecycleState.ACTIVE:
      return 'green';
    case ModelLifecycleState.SLEEPING:
      return 'blue';
    case ModelLifecycleState.STARTING:
      return 'teal';
    case ModelLifecycleState.DRAINING:
      return 'orange';
    case ModelLifecycleState.ERROR:
      return 'red';
    case ModelLifecycleState.STOPPING:
    case ModelLifecycleState.STOPPED:
      return 'grey';
    case ModelLifecycleState.PENDING:
      return 'yellow';
    default:
      return 'grey';
  }
}

export function getWorkerStatusColor(status: WorkerStatus): 'green' | 'orange' | 'red' {
  switch (status) {
    case WorkerStatus.ONLINE:
      return 'green';
    case WorkerStatus.DEGRADED:
      return 'orange';
    case WorkerStatus.OFFLINE:
      return 'red';
    default:
      return 'red';
  }
}
