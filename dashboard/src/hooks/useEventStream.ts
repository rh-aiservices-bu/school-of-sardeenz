import { useEffect, useRef, useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ClusterEventType, type ControlPlaneComponents } from '@sardeenz/types';

type ClusterEvent = ControlPlaneComponents['schemas']['ClusterEvent'];

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export function useEventStream() {
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
    const baseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';
    const es = new EventSource(`${baseUrl}/events`);
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
