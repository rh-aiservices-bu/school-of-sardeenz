// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeightsBrowserService } from '../weights-browser.js';
import { ControlPlaneError } from '../../errors.js';

const logger = { error: vi.fn() };

describe('WeightsBrowserService', () => {
  let root: string;
  let svc: WeightsBrowserService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sardeenz-weights-'));
    // Layout:
    //   org-a/model-x/(config.json)       -> model dir
    //   org-a/model-y/(model.safetensors) -> model dir
    //   org-a/scratch/                     -> plain dir
    //   .hidden/                           -> ignored
    await mkdir(join(root, 'org-a', 'model-x'), { recursive: true });
    await writeFile(join(root, 'org-a', 'model-x', 'config.json'), '{}');
    await mkdir(join(root, 'org-a', 'model-y'), { recursive: true });
    await writeFile(join(root, 'org-a', 'model-y', 'model.safetensors'), 'x');
    await mkdir(join(root, 'org-a', 'scratch'), { recursive: true });
    await mkdir(join(root, '.hidden'), { recursive: true });
    svc = new WeightsBrowserService(root, logger);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists top-level subdirectories, skipping hidden ones', async () => {
    const listing = await svc.list();
    expect(listing.relativePath).toBe('');
    expect(listing.entries.map((e) => e.name)).toEqual(['org-a']);
    expect(listing.entries[0]?.isModelDir).toBe(false);
  });

  it('flags directories that contain model files', async () => {
    const listing = await svc.list('org-a');
    const byName = Object.fromEntries(listing.entries.map((e) => [e.name, e]));
    expect(byName['model-x']?.isModelDir).toBe(true); // config.json
    expect(byName['model-y']?.isModelDir).toBe(true); // *.safetensors
    expect(byName['scratch']?.isModelDir).toBe(false);
  });

  it('returns absolute, selectable paths for entries', async () => {
    const listing = await svc.list('org-a');
    const modelX = listing.entries.find((e) => e.name === 'model-x');
    expect(modelX?.path).toBe(join(root, 'org-a', 'model-x'));
  });

  it('rejects paths that escape the weights root', async () => {
    await expect(svc.list('../etc')).rejects.toBeInstanceOf(ControlPlaneError);
    await expect(svc.list('org-a/../../..')).rejects.toBeInstanceOf(ControlPlaneError);
    // An absolute path must not override the root either.
    await expect(svc.list('/etc')).rejects.toBeInstanceOf(ControlPlaneError);
  });

  it('returns an empty listing for a missing directory rather than throwing', async () => {
    const listing = await svc.list('does-not-exist');
    expect(listing.entries).toEqual([]);
  });

  it('returns an empty listing when the weights root does not exist', async () => {
    const missing = new WeightsBrowserService(join(root, 'nope'), logger);
    const listing = await missing.list();
    expect(listing.entries).toEqual([]);
  });
});
