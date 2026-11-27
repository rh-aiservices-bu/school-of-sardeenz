import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

export interface WeightsPolicyLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

// Suffixes whose weight files deserialize with pickle and can execute arbitrary code on a
// worker. MUST stay set-equal to REFUSED_SUFFIXES in both runner shims
// (runners/mlserver/sardeenz_mlserver_runner/weights.py,
// runners/vllm/sardeenz_vllm_runner/weights.py) — pinned by the drift test in
// services/__tests__/weights-policy.test.ts. .bst (XGBoost binary) is deliberately NOT here.
export const REFUSED_WEIGHT_SUFFIXES: readonly string[] = [
  '.bin',
  '.pt',
  '.pth',
  '.ckpt',
  '.pkl',
  '.pickle',
  '.joblib',
];

// Early-refusal scan of the model directory, mirroring the runner shims' weights policy
// (runners/*/sardeenz_*_runner/weights.py). ADVISORY ONLY — the shim inside the SIF is the
// enforcement point; the control plane's view of SARDEENZ_WEIGHTS_DIR may differ from the
// worker's mount (see docs/usage/deployment-security.md, "Model weights trust boundary").
// Fail-open on an unreadable/missing directory (return [], log at warn): this is the same rule
// the shim adopts, so the engine's own startup error is not masked. Do NOT "fix" this to throw.
export class WeightsPolicyService {
  constructor(private readonly logger: WeightsPolicyLogger) {}

  // Relative paths (sorted, posix separators) of refused weight files under modelPath,
  // recursively over EVERY entry — dot-directories and caches such as __pycache__ included,
  // because a model-settings.json parameters.uri can point at any contained subdirectory.
  // Metadata-only walk (readdir), no file reads; symlinked directories are not followed
  // (Dirent.isDirectory() is false for a link), and a link leaving the model directory is
  // refused by the parameters.uri containment check.
  async findRefusedWeightFiles(modelPath: string): Promise<string[]> {
    const target = resolve(modelPath);
    const refused: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        this.logger.warn(
          { dir, err: err instanceof Error ? err.message : String(err) },
          'Weights policy scan skipped: directory unreadable (fail-open, shim enforces)',
        );
        return;
      }
      for (const d of dirents) {
        const abs = join(dir, d.name);
        if (d.isDirectory()) {
          await walk(abs);
        } else if (REFUSED_WEIGHT_SUFFIXES.some((s) => d.name.toLowerCase().endsWith(s))) {
          // A directory symlink whose own name ends in a refused suffix lands here (isDirectory()
          // is false for a link) and is refused, while the shims never match it (os.walk puts
          // directory symlinks in dirnames). Intentional safe-direction divergence: a directory
          // symlink is not a loadable pickle, so the advisory copy being stricter hides nothing.
          refused.push(relative(target, abs));
        }
      }
    };
    await walk(target);
    return refused.sort();
  }
}
