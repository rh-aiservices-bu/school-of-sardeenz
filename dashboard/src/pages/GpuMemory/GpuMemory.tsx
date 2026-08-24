import { Content, PageSection, Title } from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import { MemoryVisualization } from '../../components/MemoryVisualization';

export function GpuMemory() {
  const { t } = useTranslation('cluster');

  return (
    <PageSection>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--pf-t--global--spacer--lg)',
        }}
      >
        <Content>
          <Title headingLevel="h1" size="2xl">
            {t('overview.vramAllocation.page.title')}
          </Title>
        </Content>

        <MemoryVisualization />
      </div>
    </PageSection>
  );
}
