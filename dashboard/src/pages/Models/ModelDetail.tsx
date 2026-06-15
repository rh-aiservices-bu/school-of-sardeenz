import { useParams } from 'react-router-dom';
import { Content, PageSection } from '@patternfly/react-core';

export function ModelDetail() {
  const { modelName } = useParams<{ modelName: string }>();
  return (
    <PageSection>
      <Content>
        <h1>Model: {modelName}</h1>
        <p>Coming soon.</p>
      </Content>
    </PageSection>
  );
}
