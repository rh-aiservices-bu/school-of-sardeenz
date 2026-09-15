import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';
import type { RepoStats } from '../clients/github.js';

// GitHub star/fork counts for the sidebar footer. Proxied through the BFF (rather than fetched
// from the browser) because the CSP's connectSrc is `'self'` only; see docs/architecture/
// components/dashboard.md. Never throws: a fetch failure (including a disconnected cluster)
// yields nulls, cached by GithubRepoStatsClient so it is not retried on every page load.
export function registerRepoStatsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get(
    '/api/repo-stats',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (_request, reply) => {
      const stats: RepoStats = await deps.githubRepoStats.getStats();
      return reply.code(200).send(stats);
    },
  );
}
