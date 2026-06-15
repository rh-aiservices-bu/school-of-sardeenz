import { useParams } from 'react-router-dom';
import { Content, PageSection } from '@patternfly/react-core';

export function WorkerDetail() {
  const { workerId } = useParams<{ workerId: string }>();
  return (
    <PageSection>
      <Content>
        <h1>Worker: {workerId}</h1>
        <p>Coming soon.</p>
      </Content>
    </PageSection>
  );
}
