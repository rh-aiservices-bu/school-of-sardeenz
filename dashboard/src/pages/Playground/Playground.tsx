import { Content, Flex, FlexItem, PageSection } from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import '@patternfly/chatbot/dist/css/main.css';
import './playground.css';
import { InferenceWorkspace } from './InferenceWorkspace';

/** Chatbot Playground page: compact header bar over the full-height inference workspace. */
export function Playground() {
  const { t } = useTranslation('playground');

  return (
    <PageSection isFilled className="sz-playground" padding={{ default: 'noPadding' }}>
      <Flex
        justifyContent={{ default: 'justifyContentSpaceBetween' }}
        alignItems={{ default: 'alignItemsCenter' }}
        className="sz-playground-header"
      >
        <FlexItem>
          <Content component="h1" style={{ margin: 0 }}>
            {t('page.title')}
          </Content>
        </FlexItem>
      </Flex>
      <div className="sz-playground-body">
        <InferenceWorkspace />
      </div>
    </PageSection>
  );
}
