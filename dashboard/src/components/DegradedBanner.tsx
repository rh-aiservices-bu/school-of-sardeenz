import { Alert } from '@patternfly/react-core';
import { useDegraded } from '../contexts/DegradedContext';
import { useEventStream } from '../hooks/useEventStream';
import { useTranslation } from 'react-i18next';

/**
 * Renders a sticky warning banner when:
 * - Any active query is serving Redis fallback data (control plane unreachable), OR
 * - The SSE connection has degraded to slow-polling mode after 5 consecutive failures.
 *
 * Redis fallback takes precedence as the more severe condition.
 * Auto-dismisses as soon as all conditions clear.
 */
export function DegradedBanner() {
  const { isDegraded: isRedisFallback } = useDegraded();
  const { status: sseStatus } = useEventStream();
  const { t } = useTranslation('common');
  const isSseDegraded = sseStatus === 'degraded';

  if (!isRedisFallback && !isSseDegraded) return null;

  const title = isRedisFallback
    ? t('degraded.controlPlaneUnreachable', 'Control plane unreachable — showing cached data')
    : t('degraded.sseUnavailable', 'Real-time updates unavailable — polling for changes');

  return <Alert variant="warning" isInline title={title} />;
}
