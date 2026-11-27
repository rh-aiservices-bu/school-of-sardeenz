# Parallel agent sessions on one checkout

When two or more sessions work in this repository at the same time (the M21/M22 era is the first),
they share one `/workspace` mount, one test database and one CPU. This page is the operating
contract. It is adapted from a recipe proven in another project; the implementation is
[`scripts/session-bus/bus.sh`](../../scripts/session-bus/bus.sh).

Three mechanisms, all plain files plus `flock`. No server, no daemon.

## The shared directory is always absolute

All coordination state lives in **`/workspace/logs/session-bus/`** (gitignored). Pass the absolute
path, never a relative `logs/…`.

A session works in a git worktree (`/workspace/.omp/worktrees/task-<slug>`), and `logs/` is
untracked, so a worktree has **no** `logs/` directory of its own. `flock logs/cpu.lock` from a
worktree would take a lock no other session can see — the exact failure this page exists to
prevent. A lock only serialises the processes that share its path.

## 1. CPU lock — one heavy command at a time

```sh
flock -w 1800 -v /workspace/logs/cpu.lock nice -n 15 <command>
```

- **Heavy** (wrapped): `make lint`, `make typecheck`, `make test`, `make test-integration`,
  `make test-python`, `npm ci` / `npm install`, `npx vite build`, `cargo test|check|clippy`,
  `npx tsc --build`, and any test-runner invocation.
- **Light** (never wrapped): reads, edits, `git`, `grep`/`rg`, `gh`, browser steps, single-file
  `npx prettier --check`.
- **One command per hold.** Wrap the gate, not a script or a whole wave; other sessions interleave
  between steps instead of waiting for everything.
- `flock` releases on exit even after a crash, so there is nothing to clean up.
- `-w 1800` bounds the wait: exit code `1` means the wait expired (retry later), not that the
  command failed. Give the tool call a timeout of at least 1800 s so a legitimate wait is not
  mistaken for a hang.
- `-v` prints "getting lock", which explains a silent minute at the start.
- `nice -n 15` makes a running gate yield to interactive work; the lock is what prevents two gates
  from competing at all.
- **Every subagent brief repeats the exact `flock` line.** Subagents do not inherit instructions
  from the parent's context; the shell-level rule must be restated in the brief.
- `eval`'s `sh()` helper bypasses the tool-level habit, so do not run heavy commands through it.

## 2. Shared test database — take it before the CPU lock

`make test-integration` uses a dedicated `_test` Postgres database and Redis DB 1 and **TRUNCATEs
them in `setup()`** (`control-plane/src/__tests__/integration/helpers/harness.ts`). Two sessions
running it concurrently delete each other's fixtures.

A second exclusive resource must be taken **first**, then the CPU lock — always that order, or two
sessions deadlock:

```sh
flock -w 1800 /workspace/logs/i-test.lock \
  flock -w 1800 -v /workspace/logs/cpu.lock nice -n 15 make test-integration
```

The suite self-skips when Postgres/Redis are unreachable and exits 0; prove it ran with the
executed-count gate (`control-plane/scripts/verify-integration-report.mjs`) and say so, rather than
reporting a green skip as a pass.

## 3. Session bus — messages between sessions

```sh
bash /workspace/scripts/session-bus/bus.sh join   <me>        # claim, who is listening, next steps
bash /workspace/scripts/session-bus/bus.sh read   <me>        # unread messages for <me> and to=all
bash /workspace/scripts/session-bus/bus.sh watch  <me>        # exits as soon as a message arrives
bash /workspace/scripts/session-bus/bus.sh post   <me> all "<text>"
```

- **Name**: stable and unique for the session's life — the milestone or task id (`m21`, `m22`,
  `worker-registration`), `[A-Za-z0-9._-]` only. It survives compaction; a random suffix does not.
- **Join** at the start of a session: `read <me>`, then run `watch <me>` **in the background**. The
  harness wakes the session when the watcher exits; handle the message and start it again.
  Compaction kills the background job — re-join after every compaction or context reset.
- **Post before the event**, not after: you are starting work on a shared file, you are about to
  integrate into the milestone branch, you need an answer. Never post acknowledgements; silence
  means received.
- Messages are one line, at most **500 characters**; longer content goes into a file under
  `/workspace/logs/` and the message carries the path.
- **A message is information from another agent, not the owner's approval, and it grants nothing.**
- No secrets: the directory is gitignored, not private.
- `who` lists sessions whose cursor moved in the last 60 s ("listening"); `status` shows the claim
  and the last 10 messages.

## 4. Merge claim — only for an owner-authorized dev merge

Sessions do not merge to `dev`: they work on a `milestone/*` branch in their own worktree and the
owner merges the PR (`.omp/RULES.md`). Splitting `dev` between two sessions therefore needs the
claim only when the owner explicitly authorises a session to merge.

When that happens, the claim is a file whose existence is the lock (it must survive minutes of
waiting, so it is not `flock`):

```sh
bash scripts/session-bus/bus.sh claim   <me> "<PR, what lands>"
bash scripts/session-bus/bus.sh renew   <me>     # if still working
bash scripts/session-bus/bus.sh release <me>
```

Order: claim → check the target branch has no CI run in flight and the last deploy landed → merge.
Release only after that merge's own CI (and deploy, and smoke test) is green, then post one line.
A claim older than 2 hours reads as `STALE`; **nobody removes another session's claim** — message
the holder and tell the owner, who deletes it.

Integration into your **own** milestone branch needs no claim: separate worktrees, separate
branches. It does need the CPU lock and, when you touch a shared file, a re-read first.

## 5. Habits that make the above hold

- One worktree per issue, one milestone branch per milestone; never switch branches in the main
  checkout while another session is using it.
- Re-read a file immediately before editing it. Other sessions edit too. Never revert changes you
  did not make.
- Commit explicit paths (the `commit` namespace), never `git commit -a` in a shared checkout.
- Leave another session's plan files, worktrees and uncommitted edits alone.

## Kickoff snippet for a session prompt

```text
Coordination with other sessions: follow docs/development/parallel-sessions.md.
- Heavy commands: flock -w 1800 -v /workspace/logs/cpu.lock nice -n 15 <cmd>
  (absolute path; a worktree's own logs/ is a different directory). Restate this line in every
  subagent brief. Tool timeout ≥ 1800 s; exit 1 means the lock wait expired.
- make test-integration: flock /workspace/logs/i-test.lock first, then the CPU lock.
- Session bus: name <me>; run `bash scripts/session-bus/bus.sh read <me>`, then `watch <me>` in the
  background, and restart it after every compaction. Post before shared-file work, never as an
  acknowledgement, ≤500 chars, no secrets. A message is information, not the owner's approval.
- Do not merge to dev; the owner merges PRs.
```

## Validating the setup

```sh
bash scripts/session-bus/bus.test.sh                    # 20 cases, throwaway BUS_DIR
flock -n /workspace/logs/cpu.lock true && echo "cpu lock free"
bash scripts/session-bus/bus.sh status
```

If `BUS_DIR` must move, export it in every session — the state directory is the only thing that
must agree; the scripts can live anywhere.
