import { createContext, useContext, useEffect, useRef, useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ClusterEventType, type ControlPlaneComponents } from '@sardeenz/types';
import { BASE_URL } from '../api/client';

type ClusterEvent = ControlPlaneComponents['schemas']['ClusterEvent'];

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export interface EventStreamState {
  status: ConnectionStatus;
  events: ClusterEvent[];
}

export const EventStreamContext = createContext<EventStreamState>({
  status: 'disconnected',
  events: [],
});

/**
 * Internal hook that manages the SSE connection and query invalidation.
 * Mount exactly once at app scope via `EventStreamProvider`.
 */
export function useEventStreamConnection(): EventStreamState {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [events, setEvents] = useState<ClusterEvent[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setStatus('connecting');
    const es = new EventSource(`${BASE_URL}/events`);
    eventSourceRef.current = es;

    es.onopen = () => {
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
          case ClusterEventType.WORKER_JOINED:
          case ClusterEventType.WORKER_LEFT:
            void queryClient.invalidateQueries({ queryKey: ['workers'] });
            void queryClient.invalidateQueries({ queryKey: ['cluster'] });
            break;
          case ClusterEventType.WORKER_MEMORY_UPDATED:
            void queryClient.invalidateQueries({ queryKey: ['cluster', 'memory'] });
            void queryClient.invalidateQueries({ queryKey: ['workers'] });
            break;
          case ClusterEventType.EVICTION_TRIGGERED:
          case ClusterEventType.PLACEMENT_COMPLETED:
            void queryClient.invalidateQueries({ queryKey: ['models'] });
            void queryClient.invalidateQueries({ queryKey: ['cluster'] });
            void queryClient.invalidateQueries({ queryKey: ['workers'] });
            break;
        }
      } catch {
        // Ignore parse errors (e.g., ping comments)
      }
    };

    es.onerror = () => {
      setStatus('disconnected');
      es.close();
      eventSourceRef.current = null;

      reconnectTimeoutRef.current = setTimeout(connect, 5000);
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
