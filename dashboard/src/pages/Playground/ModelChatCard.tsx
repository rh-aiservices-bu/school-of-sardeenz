import { useState } from 'react';
import {
  Alert,
  AlertVariant,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardTitle,
  Content,
  Flex,
  FlexItem,
  Spinner,
  TextArea,
} from '@patternfly/react-core';
import { TimesIcon } from '@patternfly/react-icons';
import { useTranslation } from 'react-i18next';
import { ModelLifecycleState } from '@sardeenz/types';
import type { ModelInfo } from '../../api/client';
import { useChatSession } from './useChatSession';

interface ModelChatCardProps {
  modelName: string;
  model: ModelInfo | undefined;
  onClose: () => void;
}

/** Chat surface for one session: message list, input, send/stop, and a waking indicator. */
export function ModelChatCard({ modelName, model, onClose }: ModelChatCardProps) {
  const { t } = useTranslation('playground');
  const { messages, streaming, error, send, stop } = useChatSession(modelName);
  const [draft, setDraft] = useState('');

  const isTargetWaking =
    streaming &&
    (model?.state === ModelLifecycleState.SLEEPING ||
      model?.state === ModelLifecycleState.STARTING) &&
    !(messages[messages.length - 1]?.content ?? '');

  const handleSend = () => {
    const text = draft.trim();
    if (!text || streaming) return;
    send(text);
    setDraft('');
  };

  return (
    <Card isFullHeight>
      <CardHeader
        actions={{
          actions: (
            <Button
              variant="plain"
              icon={<TimesIcon />}
              aria-label={t('pane.closeAriaLabel')}
              onClick={onClose}
            />
          ),
        }}
      >
        <CardTitle>{modelName}</CardTitle>
      </CardHeader>
      <CardBody style={{ overflowY: 'auto', flex: 1 }}>
        {messages.length === 0 ? (
          <Content component="small">{t('chat.emptyConversation')}</Content>
        ) : (
          <Flex direction={{ default: 'column' }} gap={{ default: 'gapSm' }}>
            {messages.map((message, index) => (
              <FlexItem
                key={index}
                alignSelf={{
                  default: message.role === 'user' ? 'alignSelfFlexEnd' : 'alignSelfFlexStart',
                }}
                style={{ maxWidth: '85%' }}
              >
                <Card isCompact isPlain={message.role === 'assistant'}>
                  <CardBody>
                    <Content component="small">
                      <strong>
                        {message.role === 'user' ? t('chat.roles.user') : t('chat.roles.assistant')}
                      </strong>
                    </Content>
                    <Content component="p" style={{ whiteSpace: 'pre-wrap' }}>
                      {message.content}
                    </Content>
                  </CardBody>
                </Card>
              </FlexItem>
            ))}
          </Flex>
        )}
        {isTargetWaking && (
          <Flex
            alignItems={{ default: 'alignItemsCenter' }}
            gap={{ default: 'gapSm' }}
            className="pf-v6-u-mt-sm"
          >
            <FlexItem>
              <Spinner size="sm" />
            </FlexItem>
            <FlexItem>
              <Content component="small">{t('chat.waking')}</Content>
            </FlexItem>
          </Flex>
        )}
        {error && (
          <Alert
            variant={AlertVariant.danger}
            isInline
            title={t('chat.error.title')}
            className="pf-v6-u-mt-sm"
          >
            {error || t('chat.error.generic')}
          </Alert>
        )}
      </CardBody>
      <CardFooter>
        <Flex gap={{ default: 'gapSm' }} alignItems={{ default: 'alignItemsFlexEnd' }}>
          <FlexItem grow={{ default: 'grow' }}>
            <TextArea
              value={draft}
              onChange={(_event, value) => setDraft(value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  handleSend();
                }
              }}
              placeholder={t('chat.inputPlaceholder')}
              aria-label={t('chat.inputAriaLabel')}
              rows={2}
              isDisabled={streaming}
            />
          </FlexItem>
          <FlexItem>
            {streaming ? (
              <Button variant="danger" onClick={stop} aria-label={t('chat.stopAriaLabel')}>
                {t('chat.stop')}
              </Button>
            ) : (
              <Button variant="primary" onClick={handleSend} isDisabled={!draft.trim()}>
                {t('chat.send')}
              </Button>
            )}
          </FlexItem>
        </Flex>
      </CardFooter>
    </Card>
  );
}
