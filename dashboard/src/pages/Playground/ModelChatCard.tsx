import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Bullseye,
  Button,
  Card,
  CardBody,
  Checkbox,
  Flex,
  FlexItem,
} from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import Chatbot, { ChatbotDisplayMode } from '@patternfly/chatbot/dist/dynamic/Chatbot';
import ChatbotContent from '@patternfly/chatbot/dist/dynamic/ChatbotContent';
import ChatbotFooter from '@patternfly/chatbot/dist/dynamic/ChatbotFooter';
import ChatbotHeader, {
  ChatbotHeaderActions,
  ChatbotHeaderMain,
  ChatbotHeaderTitle,
} from '@patternfly/chatbot/dist/dynamic/ChatbotHeader';
import ChatbotWelcomePrompt from '@patternfly/chatbot/dist/dynamic/ChatbotWelcomePrompt';
import Message from '@patternfly/chatbot/dist/dynamic/Message';
import MessageBar from '@patternfly/chatbot/dist/dynamic/MessageBar';
import MessageBox, { type MessageBoxHandle } from '@patternfly/chatbot/dist/dynamic/MessageBox';
import { ModelLifecycleState } from '@sardeenz/types';
import type { ModelInfo } from '../../api/client';
import botAvatar from '../../assets/avatars/bot-avatar.svg';
import userAvatar from '../../assets/avatars/user-avatar.svg';
import { modelLabel } from './modelLabel';
import type { PlaygroundMessage } from './types';
import { useChatScroll } from './useChatScroll';
import { useChatSession } from './useChatSession';
import type { SessionStatus } from './workspace-types';

interface ModelChatCardProps {
  model: ModelInfo;
  onStatusChange?: (status: SessionStatus) => void;
}

/** One chat pane: PatternFly Chatbot header, message list, and message bar (v1 parity). */
export function ModelChatCard({ model, onStatusChange }: ModelChatCardProps) {
  const { t } = useTranslation('playground');
  const {
    messages,
    isGenerating,
    useStreaming,
    sendMessage,
    stopGeneration,
    setUseStreaming,
    clearHistory,
  } = useChatSession(model);

  const messageBoxRef = useRef<MessageBoxHandle>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const { onScroll } = useChatScroll(messageBoxRef, spacerRef, messages, isGenerating);

  const [inputValue, setInputValue] = useState(() => t('chat.defaultPrompt'));

  // Ref-stabilised so an inline `onStatusChange` from the parent doesn't retrigger the effect.
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  useEffect(() => {
    onStatusChangeRef.current?.(isGenerating ? 'generating' : 'idle');
  }, [isGenerating]);

  const name = modelLabel(model);
  const isSleeping = model.state === ModelLifecycleState.SLEEPING;

  return (
    <Card style={{ height: '100%' }} className="sz-playground-card">
      <CardBody style={{ padding: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Chatbot displayMode={ChatbotDisplayMode.embedded}>
            <ChatbotHeader className="sz-chat-header">
              <ChatbotHeaderMain>
                <ChatbotHeaderTitle className="sz-chat-header-title">
                  <Bullseye>
                    <Flex
                      justifyContent={{ default: 'justifyContentSpaceBetween' }}
                      alignItems={{ default: 'alignItemsCenter' }}
                      flexWrap={{ default: 'nowrap' }}
                    >
                      <FlexItem>
                        <strong>{name}</strong>
                        {isSleeping && (
                          <span className="sz-chat-header-hint sz-chat-header-hint--warning">
                            {t('chat.sleepingHint')}
                          </span>
                        )}
                      </FlexItem>
                      <FlexItem>
                        <span className="sz-chat-header-hint">
                          {t('chat.runnerHint', { runner: model.runnerType })}
                        </span>
                      </FlexItem>
                    </Flex>
                  </Bullseye>
                </ChatbotHeaderTitle>
              </ChatbotHeaderMain>
              <ChatbotHeaderActions>
                <Flex gap={{ default: 'gapSm' }} alignItems={{ default: 'alignItemsCenter' }}>
                  <FlexItem>
                    <Checkbox
                      id={`streaming-${model.modelName}`}
                      label={t('chat.streaming')}
                      isChecked={useStreaming}
                      isDisabled={isGenerating}
                      onChange={(_event, checked) => setUseStreaming(checked)}
                      className="sz-chat-header-check"
                    />
                  </FlexItem>
                  <FlexItem>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={clearHistory}
                      isDisabled={messages.length === 0 || isGenerating}
                    >
                      {t('chat.clear')}
                    </Button>
                  </FlexItem>
                </Flex>
              </ChatbotHeaderActions>
            </ChatbotHeader>
            <ChatbotContent>
              {messages.length === 0 ? (
                <ChatbotWelcomePrompt
                  title={t('chat.welcomeTitle', { modelName: name })}
                  description={t('chat.welcomeDescription')}
                  className="sz-chat-welcome"
                />
              ) : (
                <MessageBox ref={messageBoxRef} onScroll={onScroll}>
                  {messages.map((message) => (
                    <PlaygroundMessageItem key={message.id} message={message} modelName={name} />
                  ))}
                  {/* Sized by useChatScroll so the newest turn can scroll to the top of the box. */}
                  <div ref={spacerRef} aria-hidden="true" style={{ flexShrink: 0 }} />
                </MessageBox>
              )}
            </ChatbotContent>
            <ChatbotFooter>
              <MessageBar
                value={inputValue}
                onChange={(_event, value) => setInputValue(String(value))}
                onSendMessage={(message) => {
                  sendMessage(String(message));
                  setInputValue('');
                }}
                placeholder={t('chat.inputPlaceholder')}
                isSendButtonDisabled={isGenerating}
                hasStopButton={isGenerating}
                handleStopButton={stopGeneration}
                hasAttachButton={false}
                isCompact
              />
            </ChatbotFooter>
          </Chatbot>
        </div>
      </CardBody>
    </Card>
  );
}

function PlaygroundMessageItem({
  message,
  modelName,
}: {
  message: PlaygroundMessage;
  modelName: string;
}) {
  const { t } = useTranslation('playground');
  const isUser = message.role === 'user';

  const timestampParts = [new Date(message.timestamp).toLocaleTimeString()];
  if (!isUser && message.metrics && !message.isLoading) {
    const { latencyMs, ttftMs, tokensPerSecond } = message.metrics;
    timestampParts.push(t('chat.metrics.latency', { ms: latencyMs }));
    if (ttftMs !== undefined) timestampParts.push(t('chat.metrics.ttft', { ms: ttftMs }));
    if (tokensPerSecond !== undefined) {
      timestampParts.push(t('chat.metrics.tokensPerSecond', { tps: tokensPerSecond }));
    }
  }

  return (
    <div data-message-id={message.id}>
      <Message
        role={isUser ? 'user' : 'bot'}
        content={message.content || (message.isLoading ? '' : t('chat.noResponse'))}
        name={isUser ? t('chat.you') : modelName}
        avatar={isUser ? userAvatar : botAvatar}
        timestamp={timestampParts.join(' | ')}
        isLoading={message.isLoading}
      />
      {message.error && (
        <Alert
          variant="danger"
          isInline
          isPlain
          title={
            message.error.statusCode
              ? t('chat.errorWithStatus', { status: message.error.statusCode })
              : t('chat.errorTitle')
          }
          className="sz-chat-error"
        >
          {message.error.message}
        </Alert>
      )}
    </div>
  );
}
