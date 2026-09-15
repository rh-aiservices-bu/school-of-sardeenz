import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

// GitHub star/fork counts for the sidebar footer, proxied through the BFF. Cached server-side for
// an hour, so match that here: no refetch on window focus, and no retry (a disconnected cluster
// should not hammer the BFF, which itself returns nulls without retrying GitHub).
export function useRepoStats() {
  return useQuery({
    queryKey: ['repo-stats'],
    queryFn: ({ signal }) => api.repoStats.get(signal),
    staleTime: 60 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
