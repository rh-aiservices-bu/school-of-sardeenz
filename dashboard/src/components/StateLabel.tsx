import { Label, Spinner } from '@patternfly/react-core';
import { MoonIcon } from '@patternfly/react-icons';
import { ModelLifecycleState } from '@sardeenz/types';
import { getModelStateColor } from '../utils/state-colors';

interface StateLabelProps {
  state: ModelLifecycleState;
  isCompact?: boolean;
}

export function StateLabel({ state, isCompact = false }: StateLabelProps) {
  const color = getModelStateColor(state);
  const isLoading =
    state === ModelLifecycleState.STARTING ||
    state === ModelLifecycleState.STOPPING ||
    state === ModelLifecycleState.DRAINING;
  const isSleeping = state === ModelLifecycleState.SLEEPING;

  const icon = isLoading ? <Spinner size="sm" /> : isSleeping ? <MoonIcon /> : undefined;

  const label = state.charAt(0) + state.slice(1).toLowerCase();

  return (
    <Label color={color} isCompact={isCompact} icon={icon}>
      {label}
    </Label>
  );
}
