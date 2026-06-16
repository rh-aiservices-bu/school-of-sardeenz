import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import type { Config } from '../config.js';

export interface JwtPayload {
  username: string;
  roles: string[];
  authMode: 'simple' | 'oauth';
}

/** Routes that never require authentication. */
const PUBLIC_PATHS = ['/api/health', '/api/auth/config', '/api/auth/login', '/api/auth/callback', '/api/auth/logout', '/healthz', '/readyz'];

function isPublicRoute(url: string): boolean {
  // Strip query string before matching
  const path = url.split('?')[0] ?? url;
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + '/'));
}

/**
 * Augment Fastify with `authenticate` and `requireRole` decorators.
 *
 * Behaviour depends on `AUTH_MODE`:
 *   - `none`  — decorators are no-ops; every request passes.
 *   - `simple` / `oauth` — JWT is required on protected routes.
 *     SSE routes that cannot send headers accept `?token=…` as fallback.
 */
async function authPluginImpl(app: FastifyInstance, opts: { config: Config }): Promise<void> {
  const { config } = opts;
  const authEnabled = config.authMode !== 'none';

  if (authEnabled) {
    if (!config.jwtSecret) {
      throw new Error('JWT_SECRET is required when AUTH_MODE is not "none"');
    }

    await app.register(fastifyJwt, {
      secret: config.jwtSecret,
      verify: {
        extractToken(request: FastifyRequest): string | void {
          // 1. Standard Authorization header
          const authHeader = request.headers.authorization;
          if (authHeader?.startsWith('Bearer ')) {
            return authHeader.slice(7);
          }
          // 2. HttpOnly cookie (SSE / EventSource — browser sends automatically)
          const cookieToken = (request.cookies as Record<string, string> | undefined)?.['sardeenz_sse'];
          if (cookieToken) {
            return cookieToken;
          }
          // 3. Query-parameter fallback (deprecated — tokens leak into logs/history)
          const query = request.query as Record<string, string>;
          if (query['token']) {
            app.log.warn(
              { url: request.url },
              'Query-parameter token auth is deprecated — migrate to cookie-based SSE auth',
            );
            return query['token'];
          }
          return undefined;
        },
      },
    });
  }

  // ----- authenticate decorator -----
  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!authEnabled) return; // no-op in "none" mode
    if (isPublicRoute(request.url)) return;

    try {
      await request.jwtVerify<JwtPayload>();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
  };

  // ----- requireRole factory -----
  const requireRole = (role: string) => {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!authEnabled) return; // no-op in "none" mode

      // `authenticate` should already have been called, but guard just in case
      const user = request.user as JwtPayload | undefined;
      if (!user) {
        return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }

      // `admin` role implies `admin-readonly`
      const hasRole = user.roles.includes(role) || (role === 'admin-readonly' && user.roles.includes('admin'));

      if (!hasRole) {
        return reply.code(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
      }
    };
  };

  app.decorate('authenticate', authenticate);
  app.decorate('requireRole', requireRole);
}

/** Wrapped with fastify-plugin to expose decorators to the parent scope. */
export const authPlugin = fp(authPluginImpl, { name: 'sardeenz-auth' });

/* ------------------------------------------------------------------ */
/* Fastify type augmentation                                          */
/* ------------------------------------------------------------------ */
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (role: string) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
