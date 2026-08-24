import { PageSection, Content } from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import { InferenceWorkspace } from './InferenceWorkspace';

export function Playground() {
  const { t } = useTranslation('playground');

  return (
    <PageSection isFilled style={{ display: 'flex', flexDirection: 'column' }}>
      <Content component="h1">{t('page.title')}</Content>
      <Content component="p">{t('page.subtitle')}</Content>
      <div style={{ flex: 1, minHeight: 0 }}>
        <InferenceWorkspace />
      </div>
    </PageSection>
  );
}
