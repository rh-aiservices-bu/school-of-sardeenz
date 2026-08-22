import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { ControlPlaneComponents } from '@sardeenz/types';
import { ControlPlaneError } from '../errors.js';
import { isContainedIn } from '../utils/path-containment.js';

type WeightsListing = ControlPlaneComponents['schemas']['WeightsListing'];

export interface WeightsBrowserLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

// Filenames / extensions that mark a directory as holding model weights. Presence of any one of
// these makes a folder directly selectable as a model path in the dashboard picker.
const MODEL_FILE_NAMES = new Set(['config.json', 'tokenizer.json', 'tokenizer.model']);
const MODEL_FILE_EXTS = ['.safetensors', '.gguf', '.bin', '.pt', '.pth', '.onnx'];

// Browses the shared model-weights directory (SARDEENZ_WEIGHTS_DIR) one level at a time so the
// dashboard can offer a folder picker for the model path. Read-only; never writes.
export class WeightsBrowserService {
  private readonly root: string;

  constructor(
    weightsDir: string,
    private readonly logger: WeightsBrowserLogger,
  ) {
    this.root = resolve(weightsDir);
  }

  // List the immediate subdirectories of `relativePath` (relative to the weights root). Throws
  // INVALID_REQUEST if the path escapes the root; a missing directory yields an empty listing.
  async list(relativePath = ''): Promise<WeightsListing> {
    const target = resolve(this.root, relativePath);
    if (target !== this.root && !isContainedIn(target, this.root)) {
      throw ControlPlaneError.invalidRequest(`Path escapes the weights root: ${relativePath}`);
    }

    let dirents;
    try {
      dirents = await readdir(target, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { root: this.root, path: target, relativePath: relative(this.root, target), entries: [] };
      }
      this.logger.error(
        { dir: target, err: err instanceof Error ? err.message : String(err) },
        'Failed to list weights directory',
      );
      throw ControlPlaneError.invalidRequest(`Cannot read directory: ${relativePath || '.'}`);
    }

    const subdirs = dirents.filter((d) => d.isDirectory() && !d.name.startsWith('.'));
    const entries = await Promise.all(
      subdirs.map(async (d) => {
        const abs = join(target, d.name);
        return { name: d.name, path: abs, isModelDir: await this.looksLikeModelDir(abs) };
      }),
    );
    entries.sort((a, b) => a.name.localeCompare(b.name));

    return { root: this.root, path: target, relativePath: relative(this.root, target), entries };
  }

  // A directory "looks like a model" if it directly contains a known weights/config file.
  private async looksLikeModelDir(dir: string): Promise<boolean> {
    try {
      const files = await readdir(dir);
      return files.some(
        (f) => MODEL_FILE_NAMES.has(f) || MODEL_FILE_EXTS.some((ext) => f.endsWith(ext)),
      );
    } catch {
      return false;
    }
  }
}
