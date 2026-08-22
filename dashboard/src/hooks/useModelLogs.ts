import { useCallback, useEffect, useRef, useState } from 'react';
import type { ControlPlaneComponents } from '@sardeenz/types';
import { BASE_URL } from '../api/client';

type RunnerLogLine = ControlPlaneComponents['schemas']['RunnerLogLine'];

const RECONNECT_INTERVAL_NORMAL = 5_000;
const FAILURE_THRESHOLD = 5;
const MAX_LOG_LINES = 1_000;

export interface UseModelLogsResult {
  logs: RunnerLogLine[];
  isConnected: boolean;
  ended: boolean;
  failed: boolean;
  reconnect: () => void;
  clear: () => void;
}

/**
 * Opens a transient, per-model SSE connection to `GET /api/models/:name/logs`.
 *
 * This is deliberately NOT merged into the app-scope `useEventStream` singleton — every
 * consumer (deploy modal, "View logs" action) mounts its own connection scoped to a single
 * model, and the connection is torn down whenever `enabled` goes false, the component
 * unmounts, or `modelName` changes.
 */
export function useModelLogs(modelName: string | null, enabled: boolean): UseModelLogsResult {
  const [logs, setLogs] = useState<RunnerLogLine[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const [failed, setFailed] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const failureCountRef = useRef(0);
  const endedRef = useRef(false);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = undefined;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsConnected(false);
  }, []);

  const connect = useCallback(() => {
    if (!modelName) return;

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const url = `${BASE_URL}/models/${encodeURIComponent(modelName)}/logs`;
    const es = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = es;

    es.onopen = () => {
      failureCountRef.current = 0;
      setIsConnected(true);
    };

    es.addEventListener('log', (event: MessageEvent) => {
      try {
        const line = JSON.parse(event.data as string) as RunnerLogLine;
        setLogs((prev) => {
          const next = [...prev, line];
          return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
        });
      } catch {
        // Ignore malformed frames
      }
    });

    es.addEventListener('end', () => {
      endedRef.current = true;
      setEnded(true);
      disconnect();
    });

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
      setIsConnected(false);

      // The runner already finished — don't reconnect after a clean `end` frame.
      if (endedRef.current) return;

      failureCountRef.current += 1;
      if (failureCountRef.current >= FAILURE_THRESHOLD) {
        setFailed(true);
        return;
      }
      reconnectTimeoutRef.current = setTimeout(connect, RECONNECT_INTERVAL_NORMAL);
    };
  }, [modelName, disconnect]);

  const clear = useCallback(() => {
    setLogs([]);
  }, []);

  const reconnect = useCallback(() => {
    failureCountRef.current = 0;
    endedRef.current = false;
    setEnded(false);
    setFailed(false);
    connect();
  }, [connect]);

  useEffect(() => {
    if (!enabled || !modelName) {
      disconnect();
      return;
    }

    failureCountRef.current = 0;
    endedRef.current = false;
    setEnded(false);
    setFailed(false);
    setLogs([]);
    connect();

    return () => {
      disconnect();
    };
  }, [enabled, modelName, connect, disconnect]);

  return { logs, isConnected, ended, failed, reconnect, clear };
}
