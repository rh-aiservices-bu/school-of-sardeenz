# v1 → v2 Component Mapping

Component inventory from the [Sardeenz v1 codebase](https://github.com/rh-aiservices-bu/sardeenz) for Phase 3 dashboard reuse.

**Source:** `apps/frontend/` in v1 repo
**PatternFly version:** v1 already uses PatternFly 6 — no PF version migration needed
**Chart library:** v1 uses `@nivo/bar` (0.99.0); v2 phase doc recommends PatternFly react-charts (Victory-based)

## Component Inventory

### GPU Memory Visualization

| v1 Component    | v1 Path                         | LOC  | Purpose                                                                                                                                     | Port Verdict           | Notes                                                                                                                                                                                                                            |
| --------------- | ------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GpuMemoryPanel  | `components/GpuMemoryPanel.tsx` | 638  | Stacked VRAM bars per GPU using Nivo, cluster node grouping, refresh interval selector, sleeping model pattern fills, KVCache visualization | **Reuse with changes** | Core visualization — adapt data bindings from `PerGpuMetrics` to v2 `DeviceInfo`/`ClusterMemory`. Keep Nivo for now (phase doc says PF charts, but Nivo is already working). Replace `apiClient` calls with TanStack Query hooks |
| GpuCard (sub)   | `components/GpuMemoryPanel.tsx` | ~100 | Individual GPU card with stacked bar, model legend, KVCache mini-bar                                                                        | **Reuse**              | Embedded in GpuMemoryPanel, extracts cleanly                                                                                                                                                                                     |
| NodeGroup (sub) | `components/GpuMemoryPanel.tsx` | ~80  | Collapsible node/pod header with health label, GPU count, model count, VRAM %                                                               | **Reuse with changes** | Rename "pod" to "worker" for v2 terminology                                                                                                                                                                                      |

### Model Management

| v1 Component     | v1 Path                           | LOC  | Purpose                                                                                                                         | Port Verdict           | Notes                                                                                                                                                                                                                                            |
| ---------------- | --------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ModelStatusBadge | `components/ModelStatusBadge.tsx` | 52   | Color-coded PF6 `Label` mapping model status to colors (green/purple/teal/grey/red) with spinner/moon icons                     | **Reuse with changes** | Map v1 `ModelStatus` (lowercase: running, sleeping, starting, stopping, failed) → v2 `ModelLifecycleState` (SCREAMING_SNAKE: ACTIVE, SLEEPING, STARTING, STOPPING, ERROR, PENDING, DRAINING, STOPPED)                                            |
| ModelTable       | `components/ModelTable.tsx`       | 337  | PF6 Table with sortable columns (name, startTime, memory), unload/sleep/wake actions, logs and memory detail modals             | **Reuse with changes** | Replace `ModelInstanceDTO` with v2 `ModelInfo`. Remove `useAuth` (no RBAC in Phase 3). Adapt column definitions to v2 fields                                                                                                                     |
| ModelCardCompact | `components/ModelCardCompact.tsx` | 609  | Expandable card with drag-and-drop, status badge, memory metrics, sleep/wake/unload actions, log viewer                         | **Rebuild**            | Too coupled to v1's drag-and-drop GPU assignment flow; v2 doesn't support runtime GPU reassignment. Individual patterns (status display, action menus) reused via other components                                                               |
| LoadModelDialog  | `components/LoadModelDialog.tsx`  | 1004 | Modal deploy form with 4-state machine (form → loading → success → failed), SSE log streaming, GPU selection, memory validation | **Reuse with changes** | Adapt to v2 `ModelDeploymentRequest` fields (adds `pinned`, `engineConfig`, removes GPU selection). Convert from modal to full page form. Replace SSE log streaming with v2 event stream. Significant restructuring but core form logic reusable |

### Cluster & Worker

| v1 Component    | v1 Path                          | LOC | Purpose                                                                                                                      | Port Verdict           | Notes                                                                                                                                         |
| --------------- | -------------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| ClusterOverview | `components/ClusterOverview.tsx` | 354 | Cluster health card with summary cards (pod count, model count, GPU count), pod-level VRAM sections with collapsible details | **Reuse with changes** | Replace v1 `ClusterPod` with v2 `WorkerInfo`. Adapt summary cards to v2 `ClusterStatus` schema. Remove pod-level polling (v2 uses SSE events) |

### Notifications & Alerts

| v1 Component        | v1 Path                             | LOC | Purpose                                                                 | Port Verdict | Notes                                               |
| ------------------- | ----------------------------------- | --- | ----------------------------------------------------------------------- | ------------ | --------------------------------------------------- |
| AlertToastGroup     | `components/AlertToastGroup.tsx`    | 49  | PF6 `AlertGroup` for toast notifications                                | **Reuse**    | Minimal adaptation — wire to v2 notification system |
| NotificationDrawer  | `components/NotificationDrawer.tsx` | 176 | Drawer with read/unread tracking, mark-all-read, clear-all              | **Reuse**    | Wire to v2 event stream for model state changes     |
| NotificationContext | (contexts/)                         | 148 | Context provider with toast + drawer notification system, deduplication | **Reuse**    | Drop-in with minor type updates                     |

### Pages

| v1 Page         | v1 Path                     | LOC | Purpose                                                                                              | Port Verdict           | Notes                                                                                                                           |
| --------------- | --------------------------- | --- | ---------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| ModelManagement | `pages/ModelManagement.tsx` | 603 | Main page integrating model list, GPU panel, load/save/unload-all, cluster split-view, drag-and-drop | **Reuse with changes** | Core page layout reusable; remove drag-and-drop, adapt to v2 API hooks. Split into ModelList + ModelDeploy pages per v2 routing |
| GpuInfo         | `pages/GpuInfo.tsx`         | 450 | nvidia-smi display with GPU cards, process table, auto-refresh, cluster pod selector                 | **Rebuild**            | v1-specific (direct nvidia-smi queries). v2 uses control plane's device memory abstraction instead                              |

### Services & Utilities

| v1 File    | v1 Path           | LOC  | Purpose                                                                                          | Port Verdict | Notes                                                                                                                                                |
| ---------- | ----------------- | ---- | ------------------------------------------------------------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| apiClient  | `services/api.ts` | 1347 | Axios-based API client with model CRUD, GPU info, memory usage, cluster ops, SSE streaming, auth | **Rebuild**  | v2 uses a BFF with different endpoints. Patterns (error handling, SSE parsing, AbortController) are reference material but the client is v1-specific |
| chartTheme | `chartTheme.ts`   | 15   | Nivo tooltip theme with dark/light mode detection                                                | **Reuse**    | If keeping Nivo charts; if switching to PF react-charts, rebuild                                                                                     |

### Not Porting (v1-Only Features)

| v1 Component                 | Reason                                                                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Benchmark\* (6 components)   | v2 Phase 3 scope doesn't include benchmarking                                                                                                                                                                                 |
| Inference\* (12 components)  | v2 Phase 3 scope doesn't include inference/chat playground                                                                                                                                                                    |
| AuthContext / ProtectedRoute | v1 auth patterns were reference material only — v2 implements JWT-based auth from scratch with three modes (`none` / `simple` / `oauth`); see `dashboard/server/plugins/auth.ts` and `dashboard/src/contexts/AuthContext.tsx` |
| MoveModelDialog              | v2 doesn't support runtime GPU reassignment                                                                                                                                                                                   |
| SaveConfigurationDialog      | v2 has no equivalent configuration save/load                                                                                                                                                                                  |
| LoadConfigurationDialog      | Same as above                                                                                                                                                                                                                 |
| PodSelector                  | v2 uses workers, not pods; cluster selection not needed                                                                                                                                                                       |

## Data Model Mapping

| v1 Type                                         | v2 Equivalent                                        | Key Differences                                                                              |
| ----------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ModelStatus` (string: running, sleeping, etc.) | `ModelLifecycleState` (enum: ACTIVE, SLEEPING, etc.) | v2 adds PENDING, DRAINING; renames running→ACTIVE, failed→ERROR                              |
| `ModelInstanceDTO`                              | `ModelInfo` / `ModelDetail`                          | v2 splits list vs. detail views; adds `pinned`, `engineConfig`, `progress`, `runnerEndpoint` |
| `PerGpuMetrics`                                 | `DeviceInfo`                                         | v2 uses bytes (not GB), adds `memoryReservedBytes`, drops KVCache fields                     |
| `ClusterPod`                                    | `WorkerInfo` / `WorkerDetail`                        | v2 uses "worker" not "pod"; adds `status` enum, `runnerCapabilities`                         |
| `MultiGpuMemoryUsageResponse`                   | `ClusterMemory`                                      | v2 provides per-worker/per-device breakdown with model assignments                           |
| (no equivalent)                                 | `ClusterStatus`                                      | New in v2 — aggregate counts, memory summary, leader status                                  |
| (no equivalent)                                 | `ClusterEvent`                                       | New in v2 — typed SSE events with model/worker state changes                                 |

## State Color Mapping (v1 → v2)

| v1 Status | v1 Color | v2 State | v2 PF6 Token                                       |
| --------- | -------- | -------- | -------------------------------------------------- |
| running   | green    | ACTIVE   | `--pf-t--global--color--status--success--default`  |
| sleeping  | purple   | SLEEPING | `--pf-t--global--color--status--info--default`     |
| starting  | teal     | STARTING | `--pf-t--global--color--status--custom--default`   |
| stopping  | grey     | STOPPING | `--pf-t--global--color--status--disabled--default` |
| failed    | red      | ERROR    | `--pf-t--global--color--status--danger--default`   |
| —         | —        | PENDING  | `--pf-t--global--color--status--warning--default`  |
| —         | —        | DRAINING | `--pf-t--global--color--status--warning--default`  |
| —         | —        | STOPPED  | `--pf-t--global--color--status--disabled--default` |

## Reference Files

v1 source code is saved as `.v1.tsx` / `.v1.ts` files in the dashboard source tree for reference during porting:

```
dashboard/src/
├── components/
│   ├── GpuMemoryPanel.v1.tsx
│   ├── ModelStatusBadge.v1.tsx
│   ├── ModelTable.v1.tsx
│   ├── ModelCardCompact.v1.tsx
│   ├── ClusterOverview.v1.tsx
│   ├── LoadModelDialog.v1.tsx
│   ├── AlertToastGroup.v1.tsx
│   ├── NotificationDrawer.v1.tsx
│   └── NotificationContext.v1.tsx
├── pages/
│   ├── ModelManagement.v1.tsx
│   └── GpuInfo.v1.tsx
├── services/
│   └── api.v1.ts
├── chartTheme.v1.ts
└── App.v1.tsx
```

These files are read-only references — not included in the build (no `.v1` imports from production code).
