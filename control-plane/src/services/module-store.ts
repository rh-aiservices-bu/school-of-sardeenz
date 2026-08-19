import { mkdir, readdir, rename, unlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { ClusterEventType, CatalogItemState, type ControlPlaneComponents } from '@sardeenz/types';
import type { CatalogEntry } from './catalog-service.js';
import type { SifImporter } from './sif-importer.js';

type ClusterEvent = ControlPlaneComponents['schemas']['ClusterEvent'];
type CatalogItemStatus = ControlPlaneComponents['schemas']['CatalogItemStatus'];

export interface ModuleStoreLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface ModuleNotifier {
  createNotification(params: {
    title: string;
    description?: string;
    variant: 'success' | 'warning' | 'danger' | 'info';
    source?: { type: 'model' | 'worker' | 'system'; name?: string };
  }): Promise<unknown>;
}

// Manages the shared module store (SARDEENZ_MODULES_DIR): lists imported SIFs for imported-state,
// runs imports via a pluggable SifImporter (async, event-emitting), and uninstalls SIFs.
export class ModuleStoreService {
  // Transient per-id states (IMPORTING / FAILED). IMPORTED / NOT_IMPORTED are derived from the fs.
  private readonly transient = new Map<string, CatalogItemStatus>();

  constructor(
    private readonly modulesDir: string,
    private readonly importer: SifImporter,
    private readonly emit: (event: ClusterEvent) => void,
    private readonly logger: ModuleStoreLogger,
    private readonly notifier?: ModuleNotifier,
  ) {}

  get importerKind(): string {
    return this.importer.kind;
  }

  // SIF filename stems present on the store (e.g. "vllm-0.21"). Missing dir → empty set.
  async listImportedStems(): Promise<Set<string>> {
    try {
      const files = await readdir(this.modulesDir);
      return new Set(
        files.filter((f) => f.endsWith('.sif') && !f.startsWith('.')).map((f) => f.slice(0, -4)),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
      this.logger.error(
        { dir: this.modulesDir, err: err instanceof Error ? err.message : String(err) },
        'Failed to list module store',
      );
      return new Set();
    }
  }

  // Transient status for an id, if an import is in flight or last failed.
  getTransientStatus(id: string): CatalogItemStatus | undefined {
    return this.transient.get(id);
  }

  getAllTransient(): Map<string, CatalogItemStatus> {
    return new Map(this.transient);
  }

  // Start an async import; returns the immediate status. Idempotent while importing.
  startImport(entry: CatalogEntry): CatalogItemStatus {
    const existing = this.transient.get(entry.id);
    if (existing?.state === CatalogItemState.IMPORTING) return existing;

    const status: CatalogItemStatus = {
      id: entry.id,
      state: CatalogItemState.IMPORTING,
      percentComplete: 0,
    };
    this.transient.set(entry.id, status);
    this.publish(
      ClusterEventType.CATALOG_IMPORT_STARTED,
      entry,
      status,
      `Importing ${entry.title}`,
    );
    void this.runImport(entry);
    return status;
  }

  private async runImport(entry: CatalogEntry): Promise<void> {
    await mkdir(this.modulesDir, { recursive: true }).catch(() => {});
    const destPath = join(this.modulesDir, `${entry.sifName}.sif`);
    const tmpPath = join(this.modulesDir, `.${entry.sifName}.sif.tmp.${process.pid}.${Date.now()}`);
    try {
      await this.importer.import(entry, {
        tmpPath,
        onProgress: (percentComplete) => {
          const s: CatalogItemStatus = {
            id: entry.id,
            state: CatalogItemState.IMPORTING,
            percentComplete,
          };
          this.transient.set(entry.id, s);
          this.publish(ClusterEventType.CATALOG_IMPORT_PROGRESS, entry, s);
        },
      });
      // World-readable (workers read under an arbitrary UID), then atomic publish.
      await chmod(tmpPath, 0o644).catch(() => {});
      await rename(tmpPath, destPath);
      this.transient.delete(entry.id); // now IMPORTED (fs-derived)
      this.publish(
        ClusterEventType.CATALOG_IMPORT_COMPLETED,
        entry,
        { id: entry.id, state: CatalogItemState.IMPORTED },
        `${entry.title} imported`,
      );
      this.notifier
        ?.createNotification({
          title: 'Runner imported',
          description: `${entry.title} is ready to use`,
          variant: 'success',
          source: { type: 'system' },
        })
        .catch(() => {});
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      const s: CatalogItemStatus = { id: entry.id, state: CatalogItemState.FAILED, error: message };
      this.transient.set(entry.id, s);
      this.publish(
        ClusterEventType.CATALOG_IMPORT_FAILED,
        entry,
        s,
        `Import of ${entry.title} failed`,
      );
      this.notifier
        ?.createNotification({
          title: 'Runner import failed',
          description: `${entry.title}: ${message}`,
          variant: 'danger',
          source: { type: 'system' },
        })
        .catch(() => {});
      this.logger.error({ id: entry.id, err: message }, 'SIF import failed');
    }
  }

  // Delete an imported SIF. Returns false if it wasn't present. In-use guarding is the caller's job.
  async uninstall(entry: CatalogEntry): Promise<boolean> {
    const destPath = join(this.modulesDir, `${entry.sifName}.sif`);
    try {
      await unlink(destPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
    this.transient.delete(entry.id);
    this.publish(
      ClusterEventType.CATALOG_MODULE_REMOVED,
      entry,
      { id: entry.id, state: CatalogItemState.NOT_IMPORTED },
      `${entry.title} uninstalled`,
    );
    return true;
  }

  private publish(
    type: ClusterEventType,
    entry: CatalogEntry,
    status: CatalogItemStatus,
    message?: string,
  ): void {
    this.emit({
      type,
      timestamp: new Date().toISOString(),
      message,
      data: {
        id: entry.id,
        sifName: entry.sifName,
        state: status.state,
        percentComplete: status.percentComplete,
        error: status.error,
      },
    });
  }
}
