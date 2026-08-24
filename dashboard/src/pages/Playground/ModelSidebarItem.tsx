import { Button } from '@patternfly/react-core';
import { MoonIcon } from '@patternfly/react-icons';
import { useTranslation } from 'react-i18next';
import { ModelLifecycleState } from '@sardeenz/types';
import type { ModelInfo } from '../../api/client';

interface ModelSidebarItemProps {
  model: ModelInfo;
  isOpen: boolean;
  onClick: (modelName: string) => void;
}

/** One model row in the playground sidebar. Sleeping models are marked — chatting wakes them. */
export function ModelSidebarItem({ model, isOpen, onClick }: ModelSidebarItemProps) {
  const { t } = useTranslation('playground');
  const isSleeping = model.state === ModelLifecycleState.SLEEPING;

  return (
    <Button
      variant={isOpen ? 'secondary' : 'tertiary'}
      isBlock
      icon={isSleeping ? <MoonIcon aria-hidden="true" /> : undefined}
      onClick={() => onClick(model.modelName)}
      aria-label={t('sidebar.selectModel', { modelName: model.modelName })}
      className="pf-v6-u-mb-xs"
    >
      {model.modelName}
      {isSleeping ? ` (${t('sidebar.sleepingMarker')})` : ''}
    </Button>
  );
}
