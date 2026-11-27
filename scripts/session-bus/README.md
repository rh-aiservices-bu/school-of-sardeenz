# session-bus

Coordination between parallel agent sessions on this checkout: a message bus, a dev-merge claim,
and a join banner. Plain files plus `flock`, no server.

- Rules and rationale: [`docs/development/parallel-sessions.md`](../../docs/development/parallel-sessions.md).
- State directory: `/workspace/logs/session-bus/` (gitignored), overridable with `BUS_DIR`.
  **Always the main checkout's `logs/`** — a worktree has its own untracked `logs/`, and a lock or
  bus log there is invisible to the other sessions.
- `bash bus.sh` with no arguments prints the command list.
- Self-check: `bash bus.test.sh` (throwaway `BUS_DIR`, no state left behind).

Typical session start:

```sh
bash /workspace/scripts/session-bus/bus.sh join m21
bash /workspace/scripts/session-bus/bus.sh read m21
# then, as a background job that the harness wakes you from when it exits:
bash /workspace/scripts/session-bus/bus.sh watch m21
```
