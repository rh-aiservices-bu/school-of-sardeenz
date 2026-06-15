import { Alert } from '@patternfly/react-core';
import { useDegraded } from '../contexts/DegradedContext';
import { useEventStream } from '../hooks/useEventStream';

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
  const isSseDegraded = sseStatus === 'degraded';

  if (!isRedisFallback && !isSseDegraded) return null;

  const title = isRedisFallback
    ? 'Control plane unreachable — showing cached data'
    : 'Real-time updates unavailable — polling for changes';

  return (
    <Alert
      variant="warning"
      isInline
      title={title}
    />
  );
}
