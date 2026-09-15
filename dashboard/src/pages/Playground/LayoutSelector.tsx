import { ToggleGroup, ToggleGroupItem, Tooltip } from '@patternfly/react-core';
import { ColumnsIcon, ThLargeIcon, WindowMaximizeIcon } from '@patternfly/react-icons';
import { useTranslation } from 'react-i18next';
import type { LayoutMode } from './workspace-types';

interface LayoutSelectorProps {
  layout: LayoutMode;
  onLayoutChange: (layout: LayoutMode) => void;
  /** Layouts that don't fit the viewport (see WorkspaceArea breakpoints). */
  disabledLayouts?: LayoutMode[];
}

/** Toggle group for the workspace layout: single, split (2), grid (4). */
export function LayoutSelector({
  layout,
  onLayoutChange,
  disabledLayouts = [],
}: LayoutSelectorProps) {
  const { t } = useTranslation('playground');

  const items: { mode: LayoutMode; icon: React.ReactNode; label: string; id: string }[] = [
    {
      mode: 'single',
      icon: <WindowMaximizeIcon />,
      label: t('layout.single'),
      id: 'layout-single',
    },
    { mode: 'split-2', icon: <ColumnsIcon />, label: t('layout.split'), id: 'layout-split' },
    { mode: 'grid-4', icon: <ThLargeIcon />, label: t('layout.grid'), id: 'layout-grid' },
  ];

  return (
    <ToggleGroup aria-label={t('layout.ariaLabel')}>
      {items.map(({ mode, icon, label, id }) => (
        <Tooltip key={mode} content={label}>
          <ToggleGroupItem
            icon={icon}
            aria-label={label}
            buttonId={id}
            isSelected={layout === mode}
            onChange={(_event, isSelected) => {
              if (isSelected) onLayoutChange(mode);
            }}
            isDisabled={disabledLayouts.includes(mode)}
          />
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}
