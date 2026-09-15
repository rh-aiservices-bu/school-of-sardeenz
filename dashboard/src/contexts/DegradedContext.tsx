import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface DegradedContextValue {
  isDegraded: boolean;
  reportFallback: (key: string, isFallback: boolean) => void;
}

const DegradedContext = createContext<DegradedContextValue>({
  isDegraded: false,
  reportFallback: () => undefined,
});

/**
 * Tracks whether any active React Query response contains `source: 'redis-fallback'`.
 * Components call `reportFallback(key, true)` when they receive stale data and
 * `reportFallback(key, false)` when fresh data resumes.
 */
export function DegradedProvider({ children }: { children: ReactNode }) {
  // Map of query-key → whether that query is currently serving fallback data.
  const [fallbackSources, setFallbackSources] = useState<Map<string, boolean>>(new Map());

  const reportFallback = useCallback((key: string, isFallback: boolean) => {
    setFallbackSources((prev) => {
      const next = new Map(prev);
      if (isFallback) {
        next.set(key, true);
      } else {
        next.delete(key);
      }
      return next;
    });
  }, []);

  const isDegraded = Array.from(fallbackSources.values()).some(Boolean);

  return (
    <DegradedContext.Provider value={{ isDegraded, reportFallback }}>
      {children}
    </DegradedContext.Provider>
  );
}

export function useDegraded(): DegradedContextValue {
  return useContext(DegradedContext);
}
