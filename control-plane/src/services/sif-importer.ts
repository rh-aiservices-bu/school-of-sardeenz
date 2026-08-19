import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import type { CatalogEntry } from './catalog-service.js';

// A SifImporter leaves a valid SIF at `tmpPath` (the caller renames it atomically onto the module
// store). Pluggable so the control plane stays runtime-agnostic: OrasImporter for real deployments
// (K8s or Podman/VM), StubImporter for local dev/CI where apptainer isn't installed.
export interface ImportOptions {
  tmpPath: string;
  onProgress: (percentComplete: number) => void;
}

export interface SifImporter {
  readonly kind: 'stub' | 'oras';
  import(entry: CatalogEntry, opts: ImportOptions): Promise<void>;
}

// --- dev/CI stub: writes a placeholder file so imported-state is observable without apptainer ----
export class StubImporter implements SifImporter {
  readonly kind = 'stub';

  constructor(
    private readonly delayMs = 200,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  async import(entry: CatalogEntry, opts: ImportOptions): Promise<void> {
    opts.onProgress(10);
    await this.sleep(this.delayMs);
    opts.onProgress(70);
    await writeFile(
      opts.tmpPath,
      `SARDEENZ-DEV-STUB-SIF\nimage=${entry.image}\nsif=${entry.sifName}\n`,
    );
    opts.onProgress(100);
  }
}

// --- production: `apptainer pull oras://…` (+ verify). Pull of an ORAS-stored SIF is a download of
// a finished squashfs file (no hardlink-heavy OCI unpack), so it can write straight to the module
// store's temp path — unlike the librarian build path, no node-local scratch is required. ---------
export type RunResult = { code: number; stderr: string };
export type RunFn = (command: string, args: string[]) => Promise<RunResult>;

const defaultRun: RunFn = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    child.once('error', (err) => resolve({ code: -1, stderr: err.message }));
    child.once('exit', (code) => resolve({ code: code ?? -1, stderr }));
  });

export class OrasImporter implements SifImporter {
  readonly kind = 'oras';

  constructor(
    private readonly config: { apptainerBin: string; verifySif: boolean },
    private readonly run: RunFn = defaultRun,
  ) {}

  async import(entry: CatalogEntry, opts: ImportOptions): Promise<void> {
    if (!entry.image.startsWith('oras://')) {
      throw new Error(`Catalog image is not an ORAS reference: ${entry.image}`);
    }
    opts.onProgress(5);
    const pull = await this.run(this.config.apptainerBin, [
      'pull',
      '--force',
      opts.tmpPath,
      entry.image,
    ]);
    if (pull.code !== 0) {
      throw new Error(`apptainer pull failed (exit ${pull.code}): ${pull.stderr.trim()}`);
    }
    opts.onProgress(80);

    if (this.config.verifySif) {
      const verify = await this.run(this.config.apptainerBin, ['verify', opts.tmpPath]);
      if (verify.code !== 0) {
        throw new Error(
          `SIF signature verification failed (exit ${verify.code}): ${verify.stderr.trim()}`,
        );
      }
    }
    opts.onProgress(100);
  }
}
