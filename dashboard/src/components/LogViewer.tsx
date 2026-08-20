import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Label, Flex, FlexItem, Content } from '@patternfly/react-core';
import type { ControlPlaneComponents } from '@sardeenz/types';

type RunnerLogLine = ControlPlaneComponents['schemas']['RunnerLogLine'];

interface LogViewerProps {
  logs: RunnerLogLine[];
  isConnected: boolean;
}

// How close to the bottom (in px) the pane must be for auto-scroll to keep tracking new lines.
const AUTO_SCROLL_THRESHOLD_PX = 24;

/**
 * A PF6 scrolling log pane for streamed runner output.
 *
 * `@patternfly/react-log-viewer` is not a dependency of this project, so this is a plain
 * `<div>`-based viewer styled with PF6 semantic tokens rather than a new dependency.
 */
export function LogViewer({ logs, isConnected }: LogViewerProps) {
  const { t } = useTranslation('models');
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distanceFromBottom <= AUTO_SCROLL_THRESHOLD_PX;
  };

  // Auto-scroll to the bottom on new lines, unless the user has scrolled up to read history.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !isAtBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div>
      <Flex
        justifyContent={{ default: 'justifyContentSpaceBetween' }}
        alignItems={{ default: 'alignItemsCenter' }}
        style={{ marginBottom: 'var(--pf-t--global--spacer--sm)' }}
      >
        <FlexItem>
          <Content component="small">{t('logs.title')}</Content>
        </FlexItem>
        <FlexItem>
          <Label color={isConnected ? 'green' : 'grey'} isCompact>
            {isConnected ? t('logs.connected') : t('logs.reconnecting')}
          </Label>
        </FlexItem>
      </Flex>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        role="log"
        aria-label={t('logs.title')}
        style={{
          fontFamily: 'var(--pf-t--global--font--family--mono)',
          fontSize: 'var(--pf-t--global--font--size--sm)',
          backgroundColor: 'var(--pf-t--global--background--color--secondary--default)',
          border: '1px solid var(--pf-t--global--border--color--default)',
          borderRadius: 'var(--pf-t--global--border--radius--small)',
          padding: 'var(--pf-t--global--spacer--sm)',
          height: '360px',
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {logs.length === 0 ? (
          <Content component="small" style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
            {t('logs.waiting')}
          </Content>
        ) : (
          logs.map((line, index) => (
            <div
              key={index}
              style={{
                // Compared as a plain string, not the generated `RunnerLogLineStream` enum
                // (see runner-log-buffer.ts for the same decoupling rationale).
                color:
                  (line.stream as string) === 'stderr'
                    ? 'var(--pf-t--global--text--color--status--danger--default)'
                    : 'var(--pf-t--global--text--color--regular)',
              }}
            >
              {line.content}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
