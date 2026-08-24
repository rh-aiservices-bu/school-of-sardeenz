import { Content, Title } from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import type { ModelInfo } from '../../api/client';
import { ModelSidebarItem } from './ModelSidebarItem';

interface ModelSidebarProps {
  models: ModelInfo[];
  openModelNames: Set<string>;
  onSelectModel: (modelName: string) => void;
}

/** Lists ACTIVE + SLEEPING models; clicking one opens (or focuses) a chat session for it. */
export function ModelSidebar({ models, openModelNames, onSelectModel }: ModelSidebarProps) {
  const { t } = useTranslation('playground');

  return (
    <nav aria-label={t('sidebar.ariaLabel')} className="pf-v6-u-p-md">
      <Title headingLevel="h2" size="md" className="pf-v6-u-mb-sm">
        {t('sidebar.title')}
      </Title>
      {models.length === 0 ? (
        <Content component="small">{t('sidebar.empty')}</Content>
      ) : (
        <div>
          {models.map((model) => (
            <ModelSidebarItem
              key={model.modelName}
              model={model}
              isOpen={openModelNames.has(model.modelName)}
              onClick={onSelectModel}
            />
          ))}
        </div>
      )}
    </nav>
  );
}
