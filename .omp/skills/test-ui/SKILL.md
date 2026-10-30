---
name: test-ui
description: Run interactive e2e scenarios using the Eval browser facade (Chromium tabs) against the running Sardeenz dashboard. Validates dashboard auth (JWT none/simple/oauth), the model list, configuration pages and theme toggle. Use when a change needs browser verification; it runs in a subagent and returns a sanitized pass/fail report, so the orchestrating session never drives the browser itself. Dispatch as a `task` spawn (not by the orchestrator) with the scenario argument in the task text.
---

# Test UI — Interactive E2E Scenarios

Execute browser test scenarios against the running Sardeenz dashboard.
Scenarios are structured markdown files under `dashboard/e2e/` (Playwright
specs — read them as the source of truth for selectors and flows; there is
no separate scenario directory — if nothing matches the requested
scenario, abort and report that).

> **You run as a spawned subagent, by design.** Your report is the only
> thing that returns to the orchestrating session, so **report sanitized
> results only**: per-scenario pass/fail, screenshot paths, log evidence —
> never verbatim page content, terminal output or log dumps. You have no
> conversation history; the task text naming the scenario is your whole
> brief.

## Arguments

The task text names one of:

- A scenario ID or partial match (e.g., `auth`, `catalog`, `cluster-overview`)
- `all` — run every scenario in numeric order
- Empty — same as `all`

Match by: exact ID, partial ID match, name substring, or tag match (from
Playwright `test.describe` titles).

## Environment Setup (run before any scenario)

### 1. Check dev servers

```bash
curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 http://localhost:5173
```

Must return `200`. If not, abort with: "Dev server not reachable at
localhost:5173. Is `npm run dev` running? (root: proxy + control-plane +
dashboard + BFF via concurrently)"

The BFF may run on its own port from `SARDEENZ_DASHBOARD_PORT`/config —
check `dashboard/server/config.ts` and the dev logs (`logs/dashboard.log`,
`logs/dashboard-server.log`) for the actual port when a scenario needs the
API directly.

### 2. Clear existing session

Navigate to `http://localhost:5173` and observe the page. If a previous
session is still active, log out first using the LOGOUT procedure before
proceeding. Each scenario starts from a clean unauthenticated state.

### 3. Load scenarios

```bash
ls /workspace/dashboard/e2e/*.spec.ts
```

Read each spec's `test.describe` titles to match against the requested
scenario. If `all`, load all `*.spec.ts` files, sorted by filename.

## Browser driving

Open one tab with the Eval `browser` facade and drive it with direct tab
helpers:

- `browser.open({ name: "e2e", url: "http://localhost:5173" })` — open/reuse the tab
- `tab.observe()` / `tab.ariaSnapshot()` — inspect the page; act on returned element ids with `tab.id(n).click()` / `.fill()` / `.type()`
- `tab.waitForText(text)` / `tab.waitForUrl(pattern)` — wait for expected state
- `tab.screenshot()` — capture; it returns a saved path; report the path, never the image
- `tab.close()` — release the tab between scenarios

All browser calls happen inside Eval cells. Re-observe after navigation:
element ids are invalidated by re-rendering.

## Execution Loop

For each matched scenario:

1. Read the full scenario spec
2. Add a row for the scenario to your running results table (id, name, status `in_progress`)
3. Execute each step sequentially using the procedures below
4. After each step: observe the page and verify the **Expected** conditions
5. If a step has a **Log Check**: run the bash command and verify output
6. If a step fails: take a screenshot (save under `/workspace/logs/e2e-<scenario-id>-step<N>.png`), log the failure, and continue to the next step (don't abort the scenario)
7. After all steps: set the row's status to `passed` or `failed (steps N, M)`
8. Close the browser page (`tab.close()`) before starting the next scenario

## Reusable Procedures

### LOGIN()

The dashboard authenticates via JWT (BFF issues the session; ADR-013).
`AUTH_MODE` decides the flow — `none` skips auth entirely, `simple` uses a
local login form, `oauth` leaves for the IdP and returns via
`/api/auth/callback`. The spec file names the exact selectors; the shape
is:

```text
1. browser.open / tab.goto http://localhost:5173
2. tab.observe() — find the login control (absent under AUTH_MODE=none)
3. tab.click the login control
4. Complete the IdP form if redirected (fields per spec file)
5. tab.waitForUrl returning to the dashboard with an authenticated layout
6. tab.observe() — verify the authenticated layout (masthead with the user menu)
```

### LOGOUT()

```text
1. tab.observe() — find the user/session menu
2. tab.click the session menu
3. tab.click the sign-out item
4. tab.waitForText the landing page or the login form
```

### POLL(description, max_seconds, interval_seconds)

Used after triggering async operations (model wake, config save):

```text
1. Set attempts = max_seconds / interval_seconds
2. Loop up to attempts times:
   a. tab.observe() the current page
   b. Look for the status label named in the scenario (Running, Sleeping, Error)
   c. If terminal status found: break, return the status
   d. If still in progress: sleep interval_seconds, re-observe
3. If loop exhausted: return "TIMED_OUT"
```

### LOG_CHECK(service, description)

```text
1. Run: tail -30 /workspace/logs/<service>.log   (logs: dashboard.log, control-plane.log, proxy.log)
2. Check output for expected patterns relevant to the operation and
   unexpected ERROR lines in the test timeframe
3. PASS if expected patterns found and no related errors; WARN if expected
   patterns not found; FAIL if related ERROR lines found
```

## Result Reporting

After all scenarios complete, write the summary to the report path the
brief names:

```markdown
## E2E Test Results — <date>

| # | Scenario | Status | Duration | Notes |
|---|----------|--------|----------|-------|
| 01 | Auth flow | PASS | 25s | |
| 02 | Catalog page | PASS | 60s | |
| ... | ... | ... | ... | ... |

### Failures (if any)
- **<scenario> Step N:** <what failed>
  Screenshot: /workspace/logs/e2e-<id>-step<N>.png

### Log Anomalies (if any)
- <service>.log: <error description>
```

## Important Interaction Notes

- **Themes**: scenarios that verify UI changes run twice, light and dark
  (toggle in the masthead), and record a screenshot path for each.
- **OAuth redirect**: the login flow may leave localhost; wait for the
  return URL, never assert mid-redirect.
- **Between scenarios**: close the browser tab to ensure clean state.
- **Console errors**: flag unexpected console errors (`tab.errors`).
- **BFF ports**: each Playwright fixture spins up its own BFF; when
  driving the dev stack manually, use the shared dev BFF, not a fixture.
