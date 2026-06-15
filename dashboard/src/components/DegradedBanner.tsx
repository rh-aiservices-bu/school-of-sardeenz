import { Alert } from '@patternfly/react-core';
import { useDegraded } from '../contexts/DegradedContext';

/**
 * Renders a sticky warning banner when any active query is serving
 * Redis fallback data (i.e. the control plane is unreachable).
 * Auto-dismisses as soon as all queries return fresh data.
 */
export function DegradedBanner() {
  const { isDegraded } = useDegraded();

  if (!isDegraded) return null;

  return (
    <Alert
      variant="warning"
      isInline
      title="Control plane unreachable — showing cached data"
    />
  );
}
