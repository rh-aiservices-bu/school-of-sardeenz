import { resolve, sep } from 'node:path';

// Syntactic containment check: `candidate` must be an absolute path that resolves to somewhere
// strictly inside `root` (not `root` itself — callers that allow the root must check that
// separately). Does not touch the filesystem; callers needing symlink-escape protection must
// additionally resolve realpaths.
export function isContainedIn(candidate: string, root: string): boolean {
  if (!candidate.startsWith('/')) return false;
  const resolved = resolve(candidate);
  const resolvedRoot = resolve(root);
  return resolved.startsWith(resolvedRoot + sep);
}
