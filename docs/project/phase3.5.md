# Phase 3.5 — Admin UI Finalization

## Goal

Bring the v2 Admin Dashboard to feature parity with the Sardeenz v1 dashboard header bar. Phase 3 shipped a functional dashboard with a minimal masthead (brand text only). This phase adds the missing chrome: SVG logo with sidebar toggle, dark/light theme switching, a full notification system (backend + frontend), and a user menu with login/logout — all ported and extended from the v1 reference code under `dashboard/reference/v1/`.

## Scope

### In scope

Six feature areas spanning backend and frontend:

1. **Logo and sidebar toggle** — replace the plain "Sardeenz" text with the SVG logo (`sardeenz.svg`) inside a `<Brand>` component, add a hamburger `<MastheadToggle>` button that collapses/expands the sidebar
2. **Dark/light theme toggle** — `ToggleGroup` with Sun/Moon icons, persisted to `localStorage`, applies PatternFly's `pf-v6-theme-dark` class to the document root, respects `prefers-color-scheme` on first visit
3. **Notification backend** — new `NotificationService` in the control plane that publishes structured notifications to Redis, stores history in a Redis list, and exposes a REST API; dashboard BFF proxies these endpoints and pipes notifications through the existing SSE stream
4. **Notification frontend** — `NotificationContext` provider (drawer notifications + toast alerts), `NotificationDrawer` in a PatternFly `<Drawer>` overlay, `NotificationBadgeButton` in the masthead toolbar, `AlertToastGroup` for ephemeral toasts, consuming both SSE push and REST history
5. **User dropdown menu** — `Dropdown` with `UserIcon` showing username and role, logout action (calls `useAuth().logout()`), disabled when `authMode === 'none'`
6. **Sidebar footer** — version display and "Source on GitHub" link with theme-aware GitHub/star/fork icons in the sidebar bottom (matches v1 sidebar footer)

### Out of scope

- GitHub stars/forks API fetch (v1 fetched from `api.github.com` — skip for v2, just link to repo)
- Easter egg key sequence (`useKeySeq('sardine', ...)` / AquaBg)
- `OperationsIndicator` component (v1-specific, no v2 equivalent yet)
- External notification distribution (email, Slack, webhooks) — future phase
- Mobile-first / responsive layout
- Full RBAC for notification management

## Dependencies

| Dependency        | Status    | Notes                                                                      |
| ----------------- | --------- | -------------------------------------------------------------------------- |
| Phase 3 dashboard | Complete  | AppLayout, AuthContext, useEventStream, BFF SSE proxy all exist            |
| v1 reference code | Available | `dashboard/reference/v1/` — read-only extracts                             |
| v1 SVG logo       | Available | `assets/sardeenz.svg` in v1 repo                                           |
| v1 sidebar assets | Available | GitHub/star/fork SVGs in v1 repo                                           |
| PatternFly 6      | Installed | v6.0.0 — Masthead\*, Drawer, NotificationDrawer, ToggleGroup all available |
| Control plane     | Complete  | Redis pub/sub, SSE, model lifecycle events                                 |
| Dashboard BFF     | Complete  | Auth, SSE proxy, Redis reader                                              |

## Architecture

### Notification data flow

```
┌─────────────────────────────────────────────────────────────────────┐
│ Control Plane                                                       │
│                                                                     │
│  Model lifecycle transitions ──► NotificationService                │
│  Worker join/leave events    ──►   │                                │
│  Eviction events             ──►   ├─► Redis List (history, capped) │
│  Stuck model recovery        ──►   └─► Redis Pub/Sub (push)         │
│                                         │                           │
│  REST: GET /api/v1/notifications        │                           │
│        POST /api/v1/notifications/:id/read                          │
│        POST /api/v1/notifications/read-all                          │
│        DELETE /api/v1/notifications/:id                              │
│        DELETE /api/v1/notifications                                  │
└─────────────────────────────────────────────────────────────────────┘
              │ Pub/Sub              │ REST
              ▼                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Dashboard BFF                                                       │
│                                                                     │
│  SSE endpoint ◄── subscribes to {prefix}:notifications channel      │
│       │            (already subscribes to routing-updates,           │
│       │             cluster-events — adds one more channel)          │
│       │                                                             │
│  Proxy routes: /api/notifications/* → control plane /api/v1/*       │
└─────────────────────────────────────────────────────────────────────┘
              │ SSE push             │ fetch
              ▼                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Dashboard Frontend                                                  │
│                                                                     │
│  NotificationContext                                                │
│    ├── On SSE notification event → add to state + toast             │
│    ├── On mount → GET /api/notifications (load history)             │
│    ├── markAsRead → POST /api/notifications/:id/read                │
│    ├── markAllAsRead → POST /api/notifications/read-all             │
│    ├── remove → DELETE /api/notifications/:id                       │
│    └── clearAll → DELETE /api/notifications                         │
│                                                                     │
│  NotificationDrawer ◄── reads from NotificationContext              │
│  AlertToastGroup    ◄── reads from NotificationContext              │
│  NotificationBadgeButton ◄── reads unreadCount                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Notification data model

```typescript
interface Notification {
  id: string; // crypto.randomUUID()
  title: string; // e.g. "Model deployed successfully"
  description?: string; // e.g. "meta-llama/Llama-3.1-8B is now ACTIVE on worker-01"
  variant: 'success' | 'warning' | 'danger' | 'info';
  timestamp: string; // ISO 8601
  isRead: boolean;
  source?: {
    // Links notification to its origin
    type: 'model' | 'worker' | 'system';
    name?: string; // modelName or workerId
  };
}
```

### Redis storage

- **History list:** `{prefix}:notifications` — capped Redis list (LPUSH + LTRIM to 200 entries), each entry is a JSON-serialized `Notification`
- **Pub/Sub channel:** `{prefix}:notifications` — newly created notifications are published here for SSE push to connected dashboards
- **Read state:** Stored as a field within each notification JSON blob (list entries are updated in place via Lua script, or read-state is tracked separately in a Redis set `{prefix}:notifications:read`)

Design choice: use a Redis set `{prefix}:notifications:read` containing notification IDs that have been read, rather than updating list entries in place. This avoids the cost of scanning/replacing list elements and is O(1) per read/unread check.

## Implementation Plan

### Task 1: OpenAPI spec — notification endpoints and schemas

Add notification schemas and endpoints to the control plane OpenAPI spec.

**Files to modify:**

- `packages/contracts/specs/control-plane.yaml`

**Additions:**

- `Notification` schema with fields: `id`, `title`, `description`, `variant`, `timestamp`, `isRead`, `source`
- `NotificationVariant` enum: `success`, `warning`, `danger`, `info`
- `NotificationSource` schema with fields: `type` (`model` | `worker` | `system`), `name`
- `NotificationList` response schema
- Endpoints:
  - `GET /api/v1/notifications` — list notifications (paginated, newest first)
  - `POST /api/v1/notifications/{id}/read` — mark one as read
  - `POST /api/v1/notifications/read-all` — mark all as read
  - `DELETE /api/v1/notifications/{id}` — delete one
  - `DELETE /api/v1/notifications` — clear all
- Add `NOTIFICATION` to `ClusterEventType` enum (for SSE push)

**Then regenerate types:** `npm run codegen -w @sardeenz/types`

### Task 2: Control plane — NotificationService

Create a service that generates, stores, and publishes notifications.

**Files to create:**

- `control-plane/src/services/notification.ts`

**Behavior:**

- `createNotification(params)` — builds notification object, LPUSH to Redis list, LTRIM to cap at 200, PUBLISH to `{prefix}:notifications` channel
- `listNotifications(limit?, offset?)` — LRANGE on the Redis list, check read-state from the `{prefix}:notifications:read` set
- `markAsRead(id)` — SADD id to the read set
- `markAllAsRead()` — scan notification list, SADD all IDs to the read set
- `removeNotification(id)` — LREM from the list, SREM from the read set
- `clearAll()` — DEL both the list key and the read set key
- Constructor takes: Redis client, key prefix, logger

### Task 3: Control plane — notification routes

REST endpoints for notification CRUD.

**Files to create:**

- `control-plane/src/routes/notifications.ts`

**Files to modify:**

- `control-plane/src/routes/deps.ts` — add `notifications: NotificationService`
- `control-plane/src/server.ts` — register notification routes

**Endpoints:**

- `GET /api/v1/notifications` → `notificationService.listNotifications()`
- `POST /api/v1/notifications/:id/read` → `notificationService.markAsRead(id)`
- `POST /api/v1/notifications/read-all` → `notificationService.markAllAsRead()`
- `DELETE /api/v1/notifications/:id` → `notificationService.removeNotification(id)`
- `DELETE /api/v1/notifications` → `notificationService.clearAll()`

### Task 4: Control plane — wire notification publishing to lifecycle events

Integrate the NotificationService into the existing event publishing points.

**Files to modify:**

- `control-plane/src/services/reconciliation.ts` — after publishing cluster events for worker join/leave/dead-worker model errors/stuck model recovery, also call `notificationService.createNotification()`
- `control-plane/src/services/deploy-orchestration.ts` — on successful deploy (ACTIVE transition) and on deploy failure (ERROR transition), publish notifications
- `control-plane/src/routes/models.ts` — on successful sleep/wake initiation and on model deletion, publish notifications
- `control-plane/src/index.ts` — instantiate NotificationService and pass to deps

**Notification triggers:**
| Event | Variant | Title |
|---|---|---|
| Model deployed (→ ACTIVE) | success | "Model deployed" |
| Model deploy failed (→ ERROR) | danger | "Model deployment failed" |
| Model sleep initiated (→ DRAINING) | info | "Model sleep initiated" |
| Model wake initiated (→ STARTING) | info | "Model wake initiated" |
| Model deleted (→ STOPPING) | info | "Model deleted" |
| Model evicted | warning | "Model evicted" |
| Model stuck / timed out (→ ERROR) | danger | "Model timed out" |
| Worker joined | info | "Worker joined" |
| Worker left (dead) | warning | "Worker lost" |
| Worker model → ERROR (dead worker) | danger | "Model failed — worker lost" |

### Task 5: Dashboard BFF — subscribe to notification channel in SSE

**Files to modify:**

- `dashboard/server/routes/events.ts` — subscribe to `{prefix}:notifications` channel in addition to `routing-updates` and `cluster-events`; forward notifications as `data: {"type":"NOTIFICATION",...}`

### Task 6: Dashboard BFF — notification proxy routes

**Files to create:**

- `dashboard/server/routes/notifications.ts`

**Files to modify:**

- `dashboard/server/routes/deps.ts` — no changes needed (already has `controlPlane: ControlPlaneClient`)
- `dashboard/server/clients/control-plane.ts` — add notification methods (list, markRead, markAllRead, remove, clearAll)
- `dashboard/server/server.ts` — register notification routes

**Proxy routes (auth-gated, admin-readonly role):**

- `GET /api/notifications` → control plane `GET /api/v1/notifications`
- `POST /api/notifications/:id/read` → control plane `POST /api/v1/notifications/:id/read`
- `POST /api/notifications/read-all` → control plane `POST /api/v1/notifications/read-all`
- `DELETE /api/notifications/:id` → control plane `DELETE /api/v1/notifications/:id`
- `DELETE /api/notifications` → control plane `DELETE /api/v1/notifications`

### Task 7: Copy logo and sidebar assets from v1

Copy the SVG assets needed for the header and sidebar into the v2 dashboard.

**Files to create:**

- `dashboard/src/assets/sardeenz.svg` — main logo (from v1 repo `assets/sardeenz.svg`)
- `dashboard/src/assets/images/github-mark.svg` — GitHub logo (light)
- `dashboard/src/assets/images/github-mark-white.svg` — GitHub logo (dark)
- `dashboard/src/assets/images/star.svg` — star icon (light)
- `dashboard/src/assets/images/star-white.svg` — star icon (dark)
- `dashboard/src/assets/images/fork.svg` — fork icon (light)
- `dashboard/src/assets/images/fork-white.svg` — fork icon (dark)
- `dashboard/src/assets/index.ts` — re-export barrel file

### Task 8: Dashboard frontend — theme context

Create a `ThemeContext` that manages dark/light theme state.

**Files to create:**

- `dashboard/src/contexts/ThemeContext.tsx`

**Behavior (matching v1's `App.v1.tsx` lines 81–124):**

- Initialize from `localStorage('theme')`, falling back to `prefers-color-scheme: dark`
- Toggle adds/removes `pf-v6-theme-dark` class on `document.documentElement`
- Persist choice to `localStorage`
- Export `useTheme()` hook returning `{ isDarkTheme, toggleTheme, setDarkTheme }`

**Files to modify:**

- `dashboard/src/main.tsx` — wrap `<App>` with `<ThemeProvider>`

### Task 9: Dashboard frontend — notification system

Port and extend the notification context, drawer, and toast components from v1, backed by the real API.

**Files to create:**

- `dashboard/src/contexts/NotificationContext.tsx`
  - `NotificationProvider`, `useNotifications()` hook
  - `Notification` and `ToastNotification` types (matching backend schema)
  - On mount: fetch history from `GET /api/notifications`
  - On SSE `NOTIFICATION` event: add to state + create toast
  - `markAsRead(id)` → `POST /api/notifications/:id/read` + update local state
  - `markAllAsRead()` → `POST /api/notifications/read-all` + update local state
  - `removeNotification(id)` → `DELETE /api/notifications/:id` + update local state
  - `clearAll()` → `DELETE /api/notifications` + update local state
  - `removeToastNotification(id)` — local-only toast dismissal
  - Deduplication logic (500ms window, matching v1)
  - Unread count derived from state
- `dashboard/src/components/NotificationDrawer.tsx` — port from `NotificationDrawer.v1.tsx`
  - PatternFly `NotificationDrawer*` components
  - `NotificationBadgeButton` component
  - Actions dropdown (mark all read, clear all)
  - Empty state when no notifications
- `dashboard/src/components/AlertToastGroup.tsx` — port from `AlertToastGroup.v1.tsx`
  - `AlertGroup` with `isToast isLiveRegion`
  - Auto-dismiss with timeout
  - Close button per toast

**Files to modify:**

- `dashboard/src/main.tsx` — wrap with `<NotificationProvider>`
- `dashboard/src/api/client.ts` — add notification API methods (list, markRead, markAllRead, remove, clearAll)

### Task 10: Dashboard frontend — wire SSE notifications

Connect the notification context to the existing SSE event stream so backend-pushed notifications flow to the UI in real time.

**Files to modify:**

- `dashboard/src/hooks/useEventStream.ts` — detect `NOTIFICATION` event type from SSE, expose notification events alongside cluster events, or provide a callback mechanism for the NotificationContext to subscribe to
- `dashboard/src/contexts/NotificationContext.tsx` — subscribe to EventStreamContext and handle incoming notification events

### Task 11: Overhaul AppLayout masthead and sidebar

Rewrite `AppLayout.tsx` to match the v1 masthead structure.

**Files to modify:**

- `dashboard/src/components/AppLayout.tsx` — major rewrite

**Masthead structure (matching v1 `App.v1.tsx` lines 215–235):**

```
<Masthead>
  <MastheadMain>
    <MastheadToggle>
      <Button variant="plain" onClick={toggleSidebar}>
        <BarsIcon />
      </Button>
    </MastheadToggle>
    <MastheadBrand>
      <MastheadLogo>
        <Brand src={sardeenzLogo} alt="Sardeenz" heights={{ default: '48px' }} />
      </MastheadLogo>
    </MastheadBrand>
  </MastheadMain>
  <MastheadContent>
    <Toolbar isFullHeight isStatic>
      <ToolbarContent>
        <ToolbarGroup variant="action-group-plain" align="alignEnd">
          {/* Theme Toggle (Sun/Moon) */}
          {/* Notification Badge Button */}
          {/* User Dropdown (username, role, logout) */}
        </ToolbarGroup>
      </ToolbarContent>
    </Toolbar>
  </MastheadContent>
</Masthead>
```

**Sidebar changes:**

- Add `isSidebarOpen` state, pass to `<PageSidebar isSidebarOpen={...}>`
- Add footer section at bottom with GitHub link and theme-aware icon

**Page wrapper:**

- Wrap page content in `<Drawer>` for the notification drawer panel
- Mount `<AlertToastGroup>` above the `<Page>`

### Task 12: Add i18n keys

**Files to modify:**

- `dashboard/src/locales/en/common.json` — add keys for:
  - Header elements (theme toggle labels, notification labels, user menu)
  - Notification drawer (header, actions, empty state)
  - Sidebar footer (GitHub link, app by)

### Task 13: Unit tests — backend

**Files to create:**

- `control-plane/src/services/__tests__/notification.test.ts`
  - Create / list / markAsRead / markAllAsRead / remove / clearAll
  - Redis list capping (max 200)
  - Pub/sub publishing on create
  - Read-state tracking via set
- `control-plane/src/routes/__tests__/notifications.test.ts`
  - REST endpoint responses (200, 404, etc.)
- `dashboard/server/__tests__/routes/notifications.test.ts`
  - BFF proxy routes forward correctly

### Task 14: Unit tests — frontend

**Files to create:**

- `dashboard/src/__tests__/contexts/ThemeContext.test.tsx`
  - Theme initialization from localStorage / media query
  - Toggle applies/removes `pf-v6-theme-dark` class
  - Persists to localStorage
- `dashboard/src/__tests__/contexts/NotificationContext.test.tsx`
  - Loads history on mount (mock fetch)
  - Handles SSE notification events
  - Mark read / mark all read / remove / clear triggers API calls
  - Deduplication within 500ms
  - Unread count tracking
- `dashboard/src/__tests__/components/NotificationDrawer.test.tsx`
  - Renders notifications list
  - Empty state when no notifications
  - Mark all read / clear all actions
- `dashboard/src/__tests__/components/AlertToastGroup.test.tsx`
  - Renders toast alerts
  - Close button removes toast
- `dashboard/src/__tests__/components/AppLayout.test.tsx`
  - Masthead renders logo, theme toggle, notification badge, user menu
  - Sidebar toggle collapses/expands sidebar
  - User dropdown shows username and role
  - Logout button calls auth logout

### Task 15: Update documentation and changelog

**Files to modify:**

- `CHANGELOG.md` — add Phase 3.5 entries under `[Unreleased]`
- `docs/project/overall-plan.md` — add Phase 3.5 summary
- `CLAUDE.md` — update project status to reflect Phase 3.5

## Task Summary

| #         | Task                           | Layer         | New files | Modified files | Est. LOC   |
| --------- | ------------------------------ | ------------- | --------- | -------------- | ---------- |
| 1         | OpenAPI spec + type generation | Contracts     | 0         | 1              | ~80        |
| 2         | NotificationService            | Control plane | 1         | 0              | ~150       |
| 3         | Notification routes            | Control plane | 1         | 2              | ~100       |
| 4         | Wire lifecycle → notifications | Control plane | 0         | 4              | ~120       |
| 5         | BFF SSE notification channel   | Dashboard BFF | 0         | 1              | ~20        |
| 6         | BFF notification proxy routes  | Dashboard BFF | 1         | 2              | ~80        |
| 7         | Copy logo/sidebar assets       | Dashboard     | 8         | 0              | ~50        |
| 8         | Theme context                  | Dashboard     | 1         | 1              | ~60        |
| 9         | Notification frontend          | Dashboard     | 3         | 2              | ~400       |
| 10        | Wire SSE → notifications       | Dashboard     | 0         | 2              | ~60        |
| 11        | Overhaul AppLayout             | Dashboard     | 0         | 1              | ~200       |
| 12        | i18n keys                      | Dashboard     | 0         | 1              | ~30        |
| 13        | Backend unit tests             | Tests         | 3         | 0              | ~350       |
| 14        | Frontend unit tests            | Tests         | 5         | 0              | ~400       |
| 15        | Docs and changelog             | Docs          | 0         | 3              | ~50        |
| **Total** |                                |               | **23**    | **20**         | **~2,150** |

## Component Architecture

### Backend (Control Plane)

```
control-plane/src/
├── services/
│   └── notification.ts           ← NEW
├── routes/
│   ├── notifications.ts          ← NEW
│   └── deps.ts                   ← MODIFIED (add NotificationService)
├── server.ts                     ← MODIFIED (register notification routes)
└── index.ts                      ← MODIFIED (instantiate NotificationService)
```

### Backend (Dashboard BFF)

```
dashboard/server/
├── routes/
│   ├── notifications.ts          ← NEW
│   └── events.ts                 ← MODIFIED (subscribe to notifications channel)
├── clients/
│   └── control-plane.ts          ← MODIFIED (add notification methods)
└── server.ts                     ← MODIFIED (register notification routes)
```

### Frontend (Dashboard SPA)

```
main.tsx
├── ThemeProvider                  ← NEW (Task 8)
├── NotificationProvider           ← NEW (Task 9)
├── AuthProvider                   (existing)
└── App
    └── ProtectedRoute
        └── DegradedProvider
            └── EventStreamProvider
                └── AppLayout          ← MODIFIED (Task 11)
                    ├── AlertToastGroup  ← NEW (Task 9)
                    ├── Masthead
                    │   ├── MastheadToggle (BarsIcon)
                    │   ├── MastheadBrand (SVG logo)
                    │   └── MastheadContent (Toolbar)
                    │       ├── ThemeToggle (Sun/Moon)
                    │       ├── NotificationBadgeButton
                    │       └── UserDropdown (logout)
                    ├── Sidebar
                    │   ├── Nav (existing)
                    │   └── Footer (GitHub link)
                    └── Drawer
                        ├── NotificationDrawer  ← NEW (Task 9)
                        └── Page content (existing routes)
```

## Acceptance Criteria

### Header / Chrome

- [ ] Masthead shows the sardine SVG logo (not plain text)
- [ ] Hamburger button toggles sidebar open/closed
- [ ] Sun/Moon toggle switches between light and dark themes
- [ ] Theme persists across page reloads via localStorage
- [ ] First visit respects `prefers-color-scheme` media query
- [ ] User dropdown shows username and role (admin/admin-readonly)
- [ ] Logout action in user dropdown works (redirects to login)
- [ ] User dropdown is disabled when `authMode === 'none'`
- [ ] Sidebar footer shows GitHub link with theme-aware icon

### Notifications — Backend

- [ ] NotificationService stores notifications in a capped Redis list (max 200)
- [ ] Notifications are published to Redis pub/sub on creation
- [ ] REST endpoints for list, mark-read, mark-all-read, remove, clear-all
- [ ] Model deploy success/failure generates notifications
- [ ] Worker join/leave generates notifications
- [ ] Model eviction generates notifications
- [ ] Stuck model recovery generates notifications
- [ ] Sleep/wake/delete actions generate notifications

### Notifications — Frontend

- [ ] Notification bell badge shows unread count
- [ ] Clicking bell opens notification drawer with list of notifications
- [ ] Notification history loaded from API on mount
- [ ] SSE-pushed notifications appear in real time without page refresh
- [ ] Toast alerts appear for new notifications and auto-dismiss
- [ ] Mark as read / mark all as read updates both UI and backend
- [ ] Remove / clear all updates both UI and backend
- [ ] Deduplication prevents identical notifications within 500ms

### Quality

- [ ] All new strings use i18n keys
- [ ] All unit tests pass
- [ ] `npm run lint` and `npm run typecheck` pass across all workspaces
- [ ] OpenAPI spec is valid and types regenerate cleanly
