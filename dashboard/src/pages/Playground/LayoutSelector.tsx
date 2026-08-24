import { ToggleGroup, ToggleGroupItem } from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';

export type PlaygroundLayout = 'single' | 'split';

interface LayoutSelectorProps {
  layout: PlaygroundLayout;
  onChange: (layout: PlaygroundLayout) => void;
}

/** Toggles between a single pane and a 2-pane side-by-side layout. */
export function LayoutSelector({ layout, onChange }: LayoutSelectorProps) {
  const { t } = useTranslation('playground');

  return (
    <ToggleGroup aria-label={t('layout.ariaLabel')}>
      <ToggleGroupItem
        text={t('layout.single')}
        isSelected={layout === 'single'}
        onChange={() => onChange('single')}
      />
      <ToggleGroupItem
        text={t('layout.split')}
        isSelected={layout === 'split'}
        onChange={() => onChange('split')}
      />
    </ToggleGroup>
  );
}
