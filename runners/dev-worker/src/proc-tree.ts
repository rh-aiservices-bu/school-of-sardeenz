// Attributes an NVML-reported GPU process PID to the runner that owns it.
//
// NVML reports the *engine* process (e.g. the vLLM Python process), which is a descendant of the
// PID the launcher recorded (`handle.pid` — the `apptainer exec` process itself: apptainer exec ->
// shim -> engine). There's no direct PID equality to rely on, so we walk the parent chain from the
// NVML-reported PID up to /proc/1 (or until an owner PID matches, or the hop limit is hit) and
// check each ancestor against the set of known runner PIDs.
import { readFileSync } from 'node:fs';

const MAX_HOPS = 32;

// Reads the parent PID of `pid` from /proc/<pid>/stat. The `comm` field (2nd column) is
// wrapped in parens and may itself contain spaces or parens (e.g. "(python3 (worker))"), so the
// ppid is parsed as the field immediately after the LAST ')' in the line, not by naive
// whitespace-splitting from the start.
export function readPpidFromProc(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const lastParen = stat.lastIndexOf(')');
    if (lastParen === -1) return null;
    const rest = stat.slice(lastParen + 1).trim().split(/\s+/);
    // rest[0] = state, rest[1] = ppid
    const ppid = Number.parseInt(rest[1], 10);
    return Number.isNaN(ppid) ? null : ppid;
  } catch {
    return null; // process gone, /proc unavailable (non-Linux), or permission denied
  }
}

// Walks the parent chain starting at `pid` (inclusive) looking for a match in `ownerPids`. Returns
// the matching owner PID, or null if no ancestor matches within MAX_HOPS or the chain can't be
// walked further (readPpid returns null, hits pid 0/1, or loops back on itself).
export function resolveOwner(
  pid: number,
  ownerPids: Set<number>,
  readPpid: (pid: number) => number | null = readPpidFromProc,
): number | null {
  let current = pid;
  const visited = new Set<number>();
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (ownerPids.has(current)) return current;
    if (visited.has(current)) return null; // cycle guard
    visited.add(current);
    const parent = readPpid(current);
    if (parent === null || parent <= 1 || parent === current) return null;
    current = parent;
  }
  return null;
}
