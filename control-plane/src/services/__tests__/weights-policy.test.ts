import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  REFUSED_WEIGHT_SUFFIXES,
  WeightsPolicyService,
  type WeightsPolicyLogger,
} from '../weights-policy.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SHIM_POLICY_PATHS = [
  'runners/mlserver/sardeenz_mlserver_runner/weights.py',
  'runners/vllm/sardeenz_vllm_runner/weights.py',
];

// Every module-level `REFUSED_SUFFIXES … = ( … )` binding in a shim, as its list of suffix
// strings. All assignments are returned (not just the first) so a later redefinition cannot
// silently leave the drift test reading the original tuple.
function refusedSuffixAssignments(source: string): string[][] {
  return [...source.matchAll(/^REFUSED_SUFFIXES\b[^\n]*?=/gm)].map((assignment) => {
    const open = source.indexOf('(', assignment.index + assignment[0].length);
    const close = source.indexOf(')', open);
    if (open === -1 || close === -1) return [];
    return [...source.slice(open, close).matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  });
}

function makeLogger(): WeightsPolicyLogger {
  return { warn: vi.fn() };
}

async function makeWeightsDir(files: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'weights-policy-test-'));
  for (const file of files) {
    const abs = join(root, file);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, 'not-really-weights');
  }
  return root;
}

describe('WeightsPolicyService.findRefusedWeightFiles', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function dir(files: string[]): Promise<string> {
    const created = await makeWeightsDir(files);
    dirs.push(created);
    return created;
  }

  it('lists pickle-based weights as sorted relative paths, recursively', async () => {
    const modelPath = await dir(['config.json', 'pytorch_model.bin', 'sub/model.pt']);
    const service = new WeightsPolicyService(makeLogger());

    await expect(service.findRefusedWeightFiles(modelPath)).resolves.toEqual([
      'pytorch_model.bin',
      'sub/model.pt',
    ]);
  });

  it('allows safetensors, ONNX, xgboost .bst and shard index json', async () => {
    const modelPath = await dir([
      'model.safetensors',
      'model.onnx',
      'model.bst',
      'pytorch_model.bin.index.json',
    ]);
    const service = new WeightsPolicyService(makeLogger());

    await expect(service.findRefusedWeightFiles(modelPath)).resolves.toEqual([]);
  });

  it('lists pickles under dot-directories and __pycache__ (never pruned)', async () => {
    // A model-settings.json parameters.uri can point at any contained directory, so pruning
    // dot-entries or caches would leave a reachable load path unscanned.
    const modelPath = await dir([
      '.cache/pytorch_model.bin',
      '.w/pytorch_model.bin',
      '__pycache__/model.pt',
      'model.safetensors',
    ]);
    const service = new WeightsPolicyService(makeLogger());

    await expect(service.findRefusedWeightFiles(modelPath)).resolves.toEqual([
      '.cache/pytorch_model.bin',
      '.w/pytorch_model.bin',
      '__pycache__/model.pt',
    ]);
  });

  it('allows a safetensors file inside a dot-directory', async () => {
    const modelPath = await dir(['.cache/model.safetensors', 'config.json']);
    const service = new WeightsPolicyService(makeLogger());

    await expect(service.findRefusedWeightFiles(modelPath)).resolves.toEqual([]);
  });

  it('lists the pickle out of a mixed safetensors + pickle directory', async () => {
    const modelPath = await dir(['model.safetensors', 'pytorch_model.bin']);
    const service = new WeightsPolicyService(makeLogger());

    await expect(service.findRefusedWeightFiles(modelPath)).resolves.toEqual(['pytorch_model.bin']);
  });

  it('fails open ([] + a warn) on a missing or unreadable directory', async () => {
    const warn = vi.fn();
    const service = new WeightsPolicyService({ warn });

    await expect(service.findRefusedWeightFiles('/definitely/not/there')).resolves.toEqual([]);
    // Fail-open is deliberate (the shim is the enforcement point and applies the same rule), so
    // the skip must be observable rather than silent.
    expect(warn).toHaveBeenCalled();
  });
});

describe('REFUSED_WEIGHT_SUFFIXES drift (#336)', () => {
  // The control plane holds a third copy of the suffix list (the shims hold one each; the shims
  // are pinned shim-to-shim by runners/conformance/test_weights_policy.py). This is the only
  // CP↔shim pin — a "temporarily divergent" tuple is a bug, not a variant.
  it.each(SHIM_POLICY_PATHS)('matches the REFUSED_SUFFIXES tuple in %s', async (relPath) => {
    const source = await readFile(resolve(REPO_ROOT, relPath), 'utf8');
    const assignments = refusedSuffixAssignments(source);
    // Exactly one binding: a later redefinition must fail here, never keep the test green on
    // the stale first tuple.
    expect(assignments, `expected exactly one REFUSED_SUFFIXES binding in ${relPath}`).toHaveLength(
      1,
    );
    const shimSuffixes = assignments[0];
    expect(shimSuffixes.length).toBeGreaterThan(0);
    expect(new Set(shimSuffixes)).toEqual(new Set(REFUSED_WEIGHT_SUFFIXES));
  });

  it('extractor counts every module-level binding (negative control)', () => {
    const source = 'REFUSED_SUFFIXES: tuple[str, ...] = (".bin",)\nREFUSED_SUFFIXES = (".pt",)\n';
    expect(refusedSuffixAssignments(source)).toHaveLength(2);
  });
});
