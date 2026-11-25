import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConflictReason } from '@sardeenz/types';
import { describe, expect, it } from 'vitest';

/**
 * Two-way drift guard between the contract's `ConflictReason` enum (#248) and the
 * `details.reason` values the control plane actually emits on 409 `INVALID_STATE`
 * operation-in-progress conflicts.
 *
 * The compile-time half of the guard is the seam itself: `ControlPlaneError.operationInProgress`
 * takes the derived literal union of the generated enum. This suite covers what the type checker
 * cannot see — a reason widened back to `string` at the seam, and a spec value nothing emits.
 *
 * Test sources are excluded from the walk: fixtures such as `runner-lost` / `inst-lost` are
 * reason-shaped identifiers, not conflict reasons, and the emission sites all live in production
 * modules.
 */
const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A conflict reason ends in `-in-progress`, `-lost` or `-cancelled`; no production module uses that shape for another meaning. */
const REASON_LITERAL = /['"`]([a-z][a-z-]*-(?:in-progress|lost|cancelled))['"`]/g;

interface ReasonLiteral {
  readonly value: string;
  readonly where: string;
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') {
        files.push(...listSourceFiles(full));
      }
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

function collectReasonLiterals(): ReasonLiteral[] {
  const found: ReasonLiteral[] = [];
  for (const file of listSourceFiles(SRC_ROOT)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(REASON_LITERAL)) {
        found.push({
          value: match[1] ?? '',
          where: `${relative(SRC_ROOT, file)}:${index + 1}`,
        });
      }
    }
  }
  return found;
}

const enumValues: string[] = Object.values(ConflictReason);
const literals = collectReasonLiterals();
const emitted = new Set(literals.map((entry) => entry.value));

describe('ConflictReason drift', () => {
  it('finds the reason literals it is meant to police', () => {
    expect(literals.length).toBeGreaterThan(0);
  });

  it('emits no conflict reason outside the contract enum', () => {
    const strays = literals
      .filter((entry) => !enumValues.includes(entry.value))
      .map((entry) => `${entry.where} — ${entry.value}`);

    expect(strays).toEqual([]);
  });

  it('leaves no enum member without an emission site', () => {
    const unemitted = enumValues.filter((value) => !emitted.has(value));

    expect(unemitted).toEqual([]);
  });
});
