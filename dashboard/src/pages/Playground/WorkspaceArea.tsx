import { Bullseye, EmptyState, EmptyStateBody } from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import type { ModelInfo } from '../../api/client';
import { ModelChatCard } from './ModelChatCard';

interface WorkspaceAreaProps {
  modelName: string | null;
  model: ModelInfo | undefined;
  onClose: () => void;
}

/** A single pane — either empty (no model assigned) or hosting one model's chat session. */
export function WorkspaceArea({ modelName, model, onClose }: WorkspaceAreaProps) {
  const { t } = useTranslation('playground');

  if (!modelName) {
    return (
      <Bullseye>
        <EmptyState titleText={t('pane.emptyTitle')} headingLevel="h3" variant="xs">
          <EmptyStateBody>{t('pane.emptyBody')}</EmptyStateBody>
        </EmptyState>
      </Bullseye>
    );
  }

  // Keyed by modelName so switching a pane to a different model starts a fresh session.
  return <ModelChatCard key={modelName} modelName={modelName} model={model} onClose={onClose} />;
}
