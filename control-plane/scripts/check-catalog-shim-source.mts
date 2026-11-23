#!/usr/bin/env node
// Maintainer staleness check for runners.yaml shim provenance. Deliberately NOT CI-enforced:
// published catalog digests lag the dev tree by design (see docs/usage/runner-catalog.md).
//
// Usage (from control-plane/): node --import tsx scripts/check-catalog-shim-source.mts [--strict]
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isContainedIn } from '../src/utils/path-containment.js';
import {
  parseArgs,
  runCheck,
  SHIM_SOURCE_PATTERN,
  type CheckDeps,
  type CheckOptions,
} from '../src/utils/catalog-shim-source.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const USAGE = `Usage: node --import tsx scripts/check-catalog-shim-source.mts [options]

  --catalog <path>    catalog file to read (default: runners.yaml at the repo root)
  --shim-path <path>  repo-relative path whose last commit is the shim source (default: runners/vllm)
  --strict            exit 1 when any entry is stale, invalid or unverified
  -h, --help          show this help`;

function resolveShimPath(shimPath: string): string {
  const absolute = resolve(repoRoot, shimPath);
  if (!isContainedIn(absolute, repoRoot)) {
    throw new Error(`--shim-path must stay inside the repository: ${shimPath}`);
  }
  return relative(repoRoot, absolute);
}

function currentShimSource(shimPath: string): string | undefined {
  let output: string;
  try {
    // `--` before the pathspec keeps a hostile `--shim-path` from being read as a git option.
    output = execFileSync('git', ['-C', repoRoot, 'log', '-1', '--format=%H', '--', shimPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (err) {
    // A missing git binary is a usage error (exit 2), not an unverifiable row.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('git executable not found on PATH');
    }
    return undefined;
  }
  return SHIM_SOURCE_PATTERN.test(output) ? output : undefined;
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.kind === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (parsed.kind === 'error') {
    console.error(`${parsed.message}\n\n${USAGE}`);
    return 2;
  }
  const deps: CheckDeps = {
    readCatalog: (path) => readFile(path, 'utf8'),
    resolveCurrentSource: currentShimSource,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  };
  let options: CheckOptions;
  try {
    options = {
      catalogPath: resolve(repoRoot, parsed.catalogPath ?? 'runners.yaml'),
      shimPath: resolveShimPath(parsed.shimPath ?? 'runners/vllm'),
      strict: parsed.strict,
    };
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  try {
    return await runCheck(options, deps);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
