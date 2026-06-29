import { createContext, useContext, useEffect, useRef, useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ClusterEventType, type ControlPlaneComponents } from '@sardeenz/types';
import { BASE_URL } from '../api/client';

type ClusterEvent = ControlPlaneComponents['schemas']['ClusterEvent'];

/**
 * Connection state machine:
 *
 *   CONNECTED → (SSE error) → RECONNECTING → (5 failures) → DEGRADED
 *       ↑                          ↑                              |
 *       |                          |                              |
 *       +--- (SSE reconnects) -----+--- (SSE reconnects) --------+
 *
 * In DEGRADED state the reconnect backoff increases from 5s to 30s
 * and query hooks switch to faster polling intervals to compensate.
 */
export type ConnectionStatus = 'connected' | 'reconnecting' | 'degraded';

const FAILURE_THRESHOLD = 5;
const RECONNECT_INTERVAL_NORMAL = 5_000;
const RECONNECT_INTERVAL_DEGRADED = 30_000;

export interface EventStreamState {
  status: ConnectionStatus;
  events: ClusterEvent[];
}

export const EventStreamContext = createContext<EventStreamState>({
  status: 'reconnecting',
  events: [],
});

/**
 * Internal hook that manages the SSE connection and query invalidation.
 * Mount exactly once at app scope via `EventStreamProvider`.
 */
const MEMORY_THROTTLE_MS = 1_000;

export function useEventStreamConnection(): EventStreamState {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ConnectionStatus>('reconnecting');
  const [events, setEvents] = useState<ClusterEvent[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const failureCountRef = useRef<number>(0);
  const lastMemoryInvalidationRef = useRef<number>(0);
  const memoryThrottleTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const sseUrl = `${BASE_URL}/events`;
    const es = new EventSource(sseUrl, { withCredentials: true });
    eventSourceRef.current = es;

    es.onopen = () => {
      // Successful connection — reset failure count and go to connected
      failureCountRef.current = 0;
      setStatus('connected');
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as ClusterEvent;
        setEvents((prev) => [data, ...prev].slice(0, 100));

        switch (data.type) {
          case ClusterEventType.MODEL_STATE_CHANGED:
          case ClusterEventType.MODEL_DEPLOYED:
          case ClusterEventType.MODEL_REMOVED:
            void queryClient.invalidateQueries({ queryKey: ['models'] });
            void queryClient.invalidateQueries({ queryKey: ['cluster'] });
            break;
          case ClusterEventType.EVICTION_TRIGGERED:
            void queryClient.invalidateQueries({ queryKey: ['models'] });
            void queryClient.invalidateQueries({ queryKey: ['cluster'] });
            void queryClient.invalidateQueries({ queryKey: ['metrics'] });
            break;
          case ClusterEventType.PLACEMENT_COMPLETED:
            void queryClient.invalidateQueries({ queryKey: ['models'] });
            void queryClient.invalidateQueries({ queryKey: ['workers'] });
            void queryClient.invalidateQueries({ queryKey: ['cluster'] });
            break;
          case ClusterEventType.WORKER_JOINED:
          case ClusterEventType.WORKER_LEFT:
            void queryClient.invalidateQueries({ queryKey: ['workers'] });
            void queryClient.invalidateQueries({ queryKey: ['cluster'] });
            break;
          case ClusterEventType.WORKER_MEMORY_UPDATED: {
            const now = Date.now();
            const elapsed = now - lastMemoryInvalidationRef.current;

            const invalidateMemory = (): void => {
              lastMemoryInvalidationRef.current = Date.now();
              void queryClient.invalidateQueries({ queryKey: ['cluster', 'memory'] });
              void queryClient.invalidateQueries({ queryKey: ['workers'] });
            };

            if (elapsed >= MEMORY_THROTTLE_MS) {
              invalidateMemory();
            } else if (!memoryThrottleTimerRef.current) {
              memoryThrottleTimerRef.current = setTimeout(() => {
                memoryThrottleTimerRef.current = undefined;
                invalidateMemory();
              }, MEMORY_THROTTLE_MS - elapsed);
            }
            break;
          }
          case ClusterEventType.NOTIFICATION:
            // Notification events are handled by NotificationContext
            // Fire a custom event that NotificationContext listens for
            window.dispatchEvent(new CustomEvent('sardeenz:notification', { detail: data.data }));
            break;
        }
      } catch {
        // Ignore parse errors (e.g., ping comments)
      }
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;

      failureCountRef.current += 1;

      if (failureCountRef.current >= FAILURE_THRESHOLD) {
        setStatus('degraded');
        reconnectTimeoutRef.current = setTimeout(connect, RECONNECT_INTERVAL_DEGRADED);
      } else {
        setStatus('reconnecting');
        reconnectTimeoutRef.current = setTimeout(connect, RECONNECT_INTERVAL_NORMAL);
      }
    };
  }, [queryClient]);

  useEffect(() => {
    connect();
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (memoryThrottleTimerRef.current) {
        clearTimeout(memoryThrottleTimerRef.current);
      }
    };
  }, [connect]);

  return { status, events };
}

/**
 * Consumer hook — reads event-stream state from the nearest
 * `EventStreamContext.Provider`.
 */
export function useEventStream(): EventStreamState {
  return useContext(EventStreamContext);
}
