import type { DatabasePool } from '../clients/database.js';

export interface ModelRecord {
  id: string;
  name: string;
  runnerType: string;
  modelPath: string;
  requiredMemory: number | null;
  deviceType: string | null;
  tensorParallel: number;
  engineConfig: Record<string, unknown> | null;
  engineArgs: string[] | null;
  runtimeModule: string | null;
  servedModelName: string | null;
  displayName: string | null;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface ModelRow {
  id: string;
  name: string;
  runner_type: string;
  model_path: string;
  required_memory: string | null;
  device_type: string | null;
  tensor_parallel: number;
  engine_config: Record<string, unknown> | null;
  engine_args: string[] | null;
  runtime_module: string | null;
  served_model_name: string | null;
  display_name: string | null;
  pinned: boolean;
  created_at: Date;
  updated_at: Date;
}

function rowToRecord(row: ModelRow): ModelRecord {
  return {
    id: row.id,
    name: row.name,
    runnerType: row.runner_type,
    modelPath: row.model_path,
    requiredMemory: row.required_memory ? parseInt(row.required_memory, 10) : null,
    deviceType: row.device_type,
    tensorParallel: row.tensor_parallel,
    engineConfig: row.engine_config,
    engineArgs: row.engine_args,
    runtimeModule: row.runtime_module,
    servedModelName: row.served_model_name,
    displayName: row.display_name,
    pinned: row.pinned,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ModelRepository {
  constructor(private readonly db: DatabasePool) {}

  async create(params: {
    name: string;
    runnerType: string;
    modelPath: string;
    requiredMemory?: number;
    deviceType?: string;
    tensorParallel?: number;
    engineConfig?: Record<string, unknown>;
    engineArgs?: string[];
    runtimeModule?: string;
    servedModelName?: string;
    displayName?: string;
    pinned?: boolean;
  }): Promise<ModelRecord> {
    const result = await this.db.query<ModelRow>(
      `INSERT INTO models (name, runner_type, model_path, required_memory, device_type, tensor_parallel, engine_config, runtime_module, pinned, engine_args, served_model_name, display_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        params.name,
        params.runnerType,
        params.modelPath,
        params.requiredMemory ?? null,
        params.deviceType ?? null,
        params.tensorParallel ?? 1,
        params.engineConfig ? JSON.stringify(params.engineConfig) : null,
        params.runtimeModule ?? null,
        params.pinned ?? false,
        params.engineArgs ?? null,
        params.servedModelName ?? null,
        params.displayName ?? null,
      ],
    );
    return rowToRecord(result.rows[0]);
  }

  async findByName(name: string): Promise<ModelRecord | null> {
    const result = await this.db.query<ModelRow>('SELECT * FROM models WHERE name = $1', [name]);
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async findAll(): Promise<ModelRecord[]> {
    const result = await this.db.query<ModelRow>('SELECT * FROM models ORDER BY created_at');
    return result.rows.map(rowToRecord);
  }

  async update(
    name: string,
    params: {
      runnerType: string;
      modelPath: string;
      requiredMemory: number;
      deviceType?: string;
      tensorParallel: number;
      engineConfig?: Record<string, unknown>;
      engineArgs?: string[];
      runtimeModule?: string;
      servedModelName?: string;
      displayName?: string;
      pinned: boolean;
    },
  ): Promise<ModelRecord | null> {
    const result = await this.db.query<ModelRow>(
      `UPDATE models
       SET runner_type = $2, model_path = $3, required_memory = $4, device_type = $5,
           tensor_parallel = $6, engine_config = $7, runtime_module = $8, pinned = $9,
           engine_args = $10, served_model_name = $11, display_name = $12, updated_at = now()
       WHERE name = $1
       RETURNING *`,
      [
        name,
        params.runnerType,
        params.modelPath,
        params.requiredMemory,
        params.deviceType ?? null,
        params.tensorParallel,
        params.engineConfig ? JSON.stringify(params.engineConfig) : null,
        params.runtimeModule ?? null,
        params.pinned,
        params.engineArgs ?? null,
        params.servedModelName ?? null,
        params.displayName ?? null,
      ],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async delete(name: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM models WHERE name = $1', [name]);
    return (result.rowCount ?? 0) > 0;
  }
}
