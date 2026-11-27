import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ControlPlaneError } from '../errors.js';

/**
 * Structured audit line for every mutating control-plane request (#335).
 *
 * Cluster events already record *what* happened; this records *who* asked for it, in one line
 * per mutating request with a stable field set (`audit: true`, `actor`, `action`, `target`,
 * `params`, `outcome`) so cluster logging can route and retain it. Structured logs only — no
 * audit table, no query surface.
 *
 * The line comes from hooks, never from handlers: `onRequest` opens a per-request context,
 * the auth hook records the asserted actor into it, `onError` captures the failure reason and
 * `onResponse` — the only single-fire point that also sees the final status — emits. Routes are
 * untouched by design, and the closed action table below plus the `onRoute` boot guard make an
 * untabled mutating route fail `buildServer` instead of shipping unaudited.
 */
const ACTION_NAMES: Readonly<Record<string, string>> = {
  'POST /api/v1/models': 'deployModel',
  'PUT /api/v1/models/:modelName': 'updateModel',
  'DELETE /api/v1/models/:modelName': 'deleteModel',
  'POST /api/v1/models/:modelName/sleep': 'sleepModel',
  'POST /api/v1/models/:modelName/wake': 'wakeModel',
  'POST /api/v1/models/:modelName/stop': 'stopModel',
  'POST /api/v1/models/:modelName/start': 'startModel',
  'POST /api/v1/models/:modelName/instances': 'createModelInstance',
  'DELETE /api/v1/models/:modelName/instances/:instanceId': 'deleteModelInstance',
  'POST /api/v1/models/:modelName/instances/:instanceId/move': 'moveModelInstance',
  'POST /api/v1/models/:modelName/instances/:instanceId/sleep': 'sleepModelInstance',
  'POST /api/v1/models/:modelName/instances/:instanceId/wake': 'wakeModelInstance',
  'POST /api/v1/catalog/refresh': 'refreshCatalog',
  'POST /api/v1/catalog/:id/import': 'importRunner',
  'DELETE /api/v1/catalog/:id': 'uninstallRunner',
  'POST /api/v1/notifications/:id/read': 'markNotificationRead',
  'POST /api/v1/notifications/read-all': 'markAllNotificationsRead',
  'DELETE /api/v1/notifications/:id': 'removeNotification',
  'DELETE /api/v1/notifications': 'clearAllNotifications',
  // Proxy-only wake trigger: its callers have no user, so it always logs `actor: "service"`.
  'POST /api/v1/wake': 'triggerWake',
};

interface AuditContext {
  action: string;
  /** 'service' until a trusted capture overwrites it. */
  actor: string;
  actorRoles?: string[];
  reason?: string;
  /** Belt-and-braces: `onResponse` fires once, but a refactor must not double-log. */
  emitted: boolean;
}

/** Keyed per request instead of augmenting `FastifyRequest`. */
const contexts = new WeakMap<FastifyRequest, AuditContext>();

const SERVICE_ACTOR = 'service';
const NON_MUTATING_METHODS: Readonly<Record<string, true>> = {
  GET: true,
  HEAD: true,
  OPTIONS: true,
};
const ACTOR_HEADER = 'x-sardeenz-actor';
const ACTOR_ROLES_HEADER = 'x-sardeenz-actor-roles';
// Every value that reaches the line is attacker-controlled: header values even on an
// authenticated request, body fields on deploy/move, and the forwarded `x-request-id`. The audit
// stream is retained far longer than debug logs and is written on failure paths too — a request
// rejected with 401 emits its line — so any unbounded field is rotation pressure an ordinary
// dashboard login could use to evict genuine audit lines. Cap each string and array; the
// timing-safe token compare is untouched by this.
const MAX_ACTOR_LENGTH = 256;
const MAX_FIELD_LENGTH = 256;
const MAX_TARGET_DEVICE_INDICES = 64;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_ROLES_HEADER_LENGTH = 512;
const MAX_ROLES = 32;
/** Fixed target key set, read from the path (plus the deploy/wake body) only. */
const TARGET_KEYS = ['modelName', 'instanceId', 'id', 'workerId'] as const;
/** Per-action detail allowlist. Never a body or header spread (domain rule 7). */
const PARAM_SOURCE: Readonly<Record<string, 'force' | 'move' | 'deployment'>> = {
  deleteModel: 'force',
  stopModel: 'force',
  moveModelInstance: 'move',
  deployModel: 'deployment',
  updateModel: 'deployment',
};

/**
 * Register the four audit hooks. Must run before the auth hook so a request rejected with 401
 * still has a context and emits its line.
 */
export function registerAuditHooks(app: FastifyInstance): void {
  // Boot guard: `onRoute` runs synchronously at registration, so the throw propagates out of
  // `app.post(...)` and the server fails to build.
  app.addHook('onRoute', (routeOptions) => {
    if (!routeOptions.url.startsWith('/api/v1/')) return;
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const method of methods) {
      if (NON_MUTATING_METHODS[method] === true) continue;
      if (!ACTION_NAMES[`${method} ${routeOptions.url}`]) {
        throw new Error(`audit: no action name for ${method} ${routeOptions.url}`);
      }
    }
  });

  app.addHook('onRequest', (request, _reply, done) => {
    const ctx = createAuditContext(request);
    if (ctx) contexts.set(request, ctx);
    done();
  });

  // `onError` is the only hook that sees the error object. Do not read `reply.statusCode` here:
  // at this point it is still the pre-error value.
  app.addHook('onError', (request, _reply, error, done) => {
    const ctx = contexts.get(request);
    if (ctx) ctx.reason = deriveReason(error);
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    emitAuditLine(app, request, reply);
    done();
  });
}

/** The context for a mutating `/api/v1` request, or undefined when this request is not audited. */
function createAuditContext(request: FastifyRequest): AuditContext | undefined {
  if (NON_MUTATING_METHODS[request.method] === true) return undefined;
  if (!request.url.startsWith('/api/v1/')) return undefined;
  const routeUrl = request.routeOptions?.url;
  if (!routeUrl) return undefined;
  const action = ACTION_NAMES[`${request.method} ${routeUrl}`];
  if (!action) return undefined;
  return {
    action,
    actor: SERVICE_ACTOR,
    actorRoles: undefined,
    reason: undefined,
    emitted: false,
  };
}

/** Emit the single line for this request. The `emitted` flag guards against a double emit. */
function emitAuditLine(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): void {
  const ctx = contexts.get(request);
  if (!ctx || ctx.emitted) return;
  ctx.emitted = true;
  app.log.info(buildLine(request, reply, ctx), 'audit');
}

/**
 * Record the identity asserted by the caller. Reachable only from inside the `apiToken` auth
 * block, so with no token configured the header is never read at all — the absence of the hook
 * is the guard, not a conditional here.
 */
export function captureAssertedActor(request: FastifyRequest): void {
  const ctx = contexts.get(request);
  if (!ctx) return;
  const actor = capString(headerValue(request.headers[ACTOR_HEADER]) ?? '', MAX_ACTOR_LENGTH);
  if (!actor) return;
  ctx.actor = actor;

  const rolesHeader = headerValue(request.headers[ACTOR_ROLES_HEADER])?.slice(
    0,
    MAX_ROLES_HEADER_LENGTH,
  );
  if (!rolesHeader) return;
  const roles = rolesHeader
    .split(',')
    .map((role) => role.trim())
    .filter((role) => role.length > 0)
    .slice(0, MAX_ROLES);
  if (roles.length > 0) ctx.actorRoles = roles;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Truncate an untrusted string to the log-field cap. Shared by the actor capture and the
 *  body-derived builders so one policy governs every string in the line. */
function capString(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function deriveReason(error: unknown): string {
  if (error instanceof ControlPlaneError) {
    return typeof error.details?.['reason'] === 'string' ? error.details['reason'] : error.code;
  }
  return 'INTERNAL_ERROR';
}

function buildLine(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: AuditContext,
): Record<string, unknown> {
  const status = reply.statusCode;
  const outcome: Record<string, unknown> = { status };
  if (status >= 400 && ctx.reason !== undefined) outcome['reason'] = ctx.reason;

  const line: Record<string, unknown> = {
    audit: true,
    // `x-request-id` is a caller header (~16 KB cap at the socket), so it is capped like the rest.
    requestId: capString(request.id, MAX_REQUEST_ID_LENGTH),
    actor: ctx.actor,
  };
  if (ctx.actorRoles) line['actorRoles'] = ctx.actorRoles;
  line['action'] = ctx.action;
  line['target'] = buildTarget(request);
  line['params'] = buildParams(ctx.action, request);
  line['outcome'] = outcome;
  return line;
}

/** Fixed key set from the path; actions with no path target (`deployModel`, `triggerWake`)
 *  take `modelName` from the body, the only body field that names a target. Values are capped:
 *  path segments and body strings are caller-supplied. */
function buildTarget(request: FastifyRequest): Record<string, string> {
  const target: Record<string, string> = {};
  const params = (request.params ?? {}) as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = params[key];
    if (typeof value === 'string' && value.length > 0) {
      target[key] = capString(value, MAX_FIELD_LENGTH);
    }
  }
  if (target['modelName'] === undefined) {
    const modelName = (request.body as { modelName?: unknown } | undefined)?.modelName;
    if (typeof modelName === 'string' && modelName.length > 0) {
      target['modelName'] = capString(modelName, MAX_FIELD_LENGTH);
    }
  }
  return target;
}

function buildParams(action: string, request: FastifyRequest): Record<string, unknown> {
  const source = PARAM_SOURCE[action];
  if (source === 'force') {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return { force: query['force'] === true || query['force'] === 'true' };
  }
  if (source === 'move') {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const params: Record<string, unknown> = {};
    if (typeof body['targetWorkerId'] === 'string') {
      params['targetWorkerId'] = capString(body['targetWorkerId'], MAX_FIELD_LENGTH);
    }
    const indices = body['targetDeviceIndices'];
    const isDeviceIndex = (value: unknown): value is number =>
      typeof value === 'number' && Number.isInteger(value);
    if (Array.isArray(indices) && indices.every(isDeviceIndex)) {
      params['targetDeviceIndices'] = indices.slice(0, MAX_TARGET_DEVICE_INDICES);
    }
    return params;
  }
  if (source === 'deployment') {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const params: Record<string, unknown> = {};
    if (typeof body['runnerType'] === 'string') {
      params['runnerType'] = capString(body['runnerType'], MAX_FIELD_LENGTH);
    }
    if (typeof body['requiredMemory'] === 'number') {
      params['requiredMemory'] = body['requiredMemory'];
    }
    return params;
  }
  return {};
}
