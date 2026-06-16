import { Label, Spinner } from '@patternfly/react-core';
import { MoonIcon } from '@patternfly/react-icons';
import { useTranslation } from 'react-i18next';
import { ModelLifecycleState } from '@sardeenz/types';
import { getModelStateColor } from '../utils/state-colors';

interface StateLabelProps {
  state: ModelLifecycleState;
  isCompact?: boolean;
}

const STATE_TO_LOCALE_KEY: Record<ModelLifecycleState, string> = {
  [ModelLifecycleState.ACTIVE]: 'status.active',
  [ModelLifecycleState.SLEEPING]: 'status.sleeping',
  [ModelLifecycleState.PENDING]: 'status.pending',
  [ModelLifecycleState.STARTING]: 'status.starting',
  [ModelLifecycleState.STOPPING]: 'status.stopping',
  [ModelLifecycleState.STOPPED]: 'status.stopped',
  [ModelLifecycleState.DRAINING]: 'status.draining',
  [ModelLifecycleState.ERROR]: 'status.error',
};

export function StateLabel({ state, isCompact = false }: StateLabelProps) {
  const { t } = useTranslation('common');
  const color = getModelStateColor(state);
  const isLoading =
    state === ModelLifecycleState.STARTING ||
    state === ModelLifecycleState.STOPPING ||
    state === ModelLifecycleState.DRAINING;
  const isSleeping = state === ModelLifecycleState.SLEEPING;

  const icon = isLoading ? <Spinner size="sm" /> : isSleeping ? <MoonIcon /> : undefined;

  const localeKey = STATE_TO_LOCALE_KEY[state];
  const label = localeKey ? t(localeKey) : state.charAt(0) + state.slice(1).toLowerCase();

  return (
    <Label color={color} isCompact={isCompact} icon={icon}>
      {label}
    </Label>
  );
}
