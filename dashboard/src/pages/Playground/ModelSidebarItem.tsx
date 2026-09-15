import { Button, Flex, FlexItem, Label, Truncate } from '@patternfly/react-core';
import { CheckIcon, MoonIcon } from '@patternfly/react-icons';
import { useTranslation } from 'react-i18next';
import { ModelLifecycleState } from '@sardeenz/types';
import type { ModelInfo } from '../../api/client';
import { modelLabel } from './modelLabel';

interface ModelSidebarItemProps {
  model: ModelInfo;
  isOpen: boolean;
  isActive: boolean;
  onSelect: (model: ModelInfo) => void;
}

/** Compact sidebar row: model name, "Open" badge when a session exists, sleeping marker. */
export function ModelSidebarItem({ model, isOpen, isActive, onSelect }: ModelSidebarItemProps) {
  const { t } = useTranslation('playground');
  const name = modelLabel(model);
  const isSleeping = model.state === ModelLifecycleState.SLEEPING;

  return (
    <Button
      variant="plain"
      isBlock
      onClick={() => onSelect(model)}
      className={`sz-sidebar-item${isActive ? ' sz-sidebar-item--active' : ''}`}
      aria-pressed={isActive}
      aria-label={t('sidebar.selectModel', { modelName: name })}
    >
      <Flex
        alignItems={{ default: 'alignItemsCenter' }}
        justifyContent={{ default: 'justifyContentSpaceBetween' }}
        gap={{ default: 'gapSm' }}
        flexWrap={{ default: 'nowrap' }}
      >
        <FlexItem style={{ minWidth: 0, flex: 1 }}>
          <Truncate content={name} />
        </FlexItem>
        <FlexItem>
          <Flex gap={{ default: 'gapXs' }} alignItems={{ default: 'alignItemsCenter' }}>
            {isSleeping && (
              <FlexItem>
                <Label isCompact color="grey" icon={<MoonIcon />}>
                  {t('sidebar.sleeping')}
                </Label>
              </FlexItem>
            )}
            {isOpen && (
              <FlexItem>
                <Label isCompact color="blue" icon={<CheckIcon />}>
                  {t('sidebar.open')}
                </Label>
              </FlexItem>
            )}
          </Flex>
        </FlexItem>
      </Flex>
    </Button>
  );
}
