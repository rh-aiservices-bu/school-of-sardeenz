import type { DatabasePool } from '../clients/database.js';

export interface InstanceRecord {
  instanceId: string;
  modelName: string;
  workerId: string | null;
  deviceIndices: number[] | null;
  createdAt: Date;
  updatedAt: Date;
}

interface InstanceRow {
  instance_id: string;
  model_name: string;
  worker_id: string | null;
  device_indices: number[] | null;
  created_at: Date;
  updated_at: Date;
}

function rowToRecord(row: InstanceRow): InstanceRecord {
  return {
    instanceId: row.instance_id,
    modelName: row.model_name,
    workerId: row.worker_id,
    deviceIndices: row.device_indices,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Durable identity/placement ledger for model instances (replicas). Written synchronously at
 * instance create/delete — the same low cadence as the `models` row today — not on every
 * runtime state transition; Redis (ModelLifecycleService) stays authoritative for runtime
 * state, and reconciliation heals divergence between the two. See ADR-019.
 */
export class InstanceRepository {
  constructor(private readonly db: DatabasePool) {}

  async create(params: {
    instanceId: string;
    modelName: string;
    workerId?: string | null;
    deviceIndices?: number[] | null;
  }): Promise<InstanceRecord> {
    const result = await this.db.query<InstanceRow>(
      `INSERT INTO instances (instance_id, model_name, worker_id, device_indices)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [params.instanceId, params.modelName, params.workerId ?? null, params.deviceIndices ?? null],
    );
    return rowToRecord(result.rows[0]);
  }

  async findByModel(modelName: string): Promise<InstanceRecord[]> {
    const result = await this.db.query<InstanceRow>(
      'SELECT * FROM instances WHERE model_name = $1 ORDER BY created_at',
      [modelName],
    );
    return result.rows.map(rowToRecord);
  }

  async findAll(): Promise<InstanceRecord[]> {
    const result = await this.db.query<InstanceRow>('SELECT * FROM instances ORDER BY created_at');
    return result.rows.map(rowToRecord);
  }

  async delete(instanceId: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM instances WHERE instance_id = $1', [
      instanceId,
    ]);
    return (result.rowCount ?? 0) > 0;
  }
}
