import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

// Lists one level of the shared model-weights directory for the deploy-form folder picker.
// `path` is relative to the weights root (empty string = root). Disabled until `enabled` is set
// so the query only fires while the browser modal is open.
export function useWeights(path: string, enabled: boolean) {
  return useQuery({
    queryKey: ['weights', path],
    queryFn: ({ signal }) => api.weights.list(path, signal),
    enabled,
    staleTime: 30_000,
  });
}
