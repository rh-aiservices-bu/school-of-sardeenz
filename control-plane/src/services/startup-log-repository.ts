import type { DatabasePool } from '../clients/database.js';

export type StartupLogOutcome = 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

export interface StartupLogSession {
  instanceId: string;
  modelName: string;
  workerId: string;
  outcome: StartupLogOutcome;
  captureComplete: boolean;
  errorMessage: string | null;
  startedAt: Date;
  completedAt: Date | null;
  lineCount: number;
}

export interface StartupLogLine {
  id: number;
  ts: string;
  stream: 'stdout' | 'stderr';
  content: string;
}

interface SessionRow {
  instance_id: string;
  model_name: string;
  worker_id: string;
  outcome: StartupLogOutcome;
  capture_complete: boolean;
  error_message: string | null;
  started_at: Date;
  completed_at: Date | null;
  line_count: string;
}

function toSession(row: SessionRow): StartupLogSession {
  return {
    instanceId: row.instance_id,
    modelName: row.model_name,
    workerId: row.worker_id,
    outcome: row.outcome,
    captureComplete: row.capture_complete,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    lineCount: Number(row.line_count),
  };
}

export class StartupLogRepository {
  constructor(private readonly db: DatabasePool) {}

  async createSession(instanceId: string, modelName: string, workerId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO startup_log_sessions (instance_id, model_name, worker_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (instance_id) DO NOTHING`,
      [instanceId, modelName, workerId],
    );
  }

  async append(instanceId: string, lines: Omit<StartupLogLine, 'id'>[]): Promise<void> {
    if (lines.length === 0) return;
    const values: unknown[] = [];
    const tuples = lines.map((line, index) => {
      const offset = index * 4;
      values.push(instanceId, line.ts, line.stream, line.content);
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
    });
    await this.db.query(
      `INSERT INTO startup_log_lines (instance_id, logged_at, stream, content)
       VALUES ${tuples.join(', ')}`,
      values,
    );
  }

  async markCaptureComplete(instanceId: string): Promise<void> {
    await this.db.query(
      'UPDATE startup_log_sessions SET capture_complete = true WHERE instance_id = $1',
      [instanceId],
    );
  }

  async clearLines(instanceId: string): Promise<void> {
    await this.db.query('DELETE FROM startup_log_lines WHERE instance_id = $1', [instanceId]);
  }

  async markOutcome(
    instanceId: string,
    outcome: Exclude<StartupLogOutcome, 'IN_PROGRESS'>,
    errorMessage?: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE startup_log_sessions
       SET outcome = $2, error_message = $3, completed_at = now()
       WHERE instance_id = $1`,
      [instanceId, outcome, errorMessage ?? null],
    );
  }

  async listByModel(modelName: string): Promise<StartupLogSession[]> {
    const result = await this.db.query<SessionRow>(
      `SELECT s.*, count(l.id)::text AS line_count
       FROM startup_log_sessions s
       LEFT JOIN startup_log_lines l ON l.instance_id = s.instance_id
       WHERE s.model_name = $1
       GROUP BY s.instance_id
       ORDER BY s.started_at DESC`,
      [modelName],
    );
    return result.rows.map(toSession);
  }

  async find(instanceId: string): Promise<StartupLogSession | null> {
    const result = await this.db.query<SessionRow>(
      `SELECT s.*, count(l.id)::text AS line_count
       FROM startup_log_sessions s
       LEFT JOIN startup_log_lines l ON l.instance_id = s.instance_id
       WHERE s.instance_id = $1
       GROUP BY s.instance_id`,
      [instanceId],
    );
    return result.rows[0] ? toSession(result.rows[0]) : null;
  }

  async listIncomplete(): Promise<StartupLogSession[]> {
    const result = await this.db.query<SessionRow>(
      `SELECT s.*, count(l.id)::text AS line_count
       FROM startup_log_sessions s
       LEFT JOIN startup_log_lines l ON l.instance_id = s.instance_id
       WHERE NOT s.capture_complete
       GROUP BY s.instance_id
       ORDER BY s.started_at`,
    );
    return result.rows.map(toSession);
  }

  async linesAfter(instanceId: string, afterId = 0): Promise<StartupLogLine[]> {
    const result = await this.db.query<{
      id: string;
      logged_at: Date;
      stream: 'stdout' | 'stderr';
      content: string;
    }>(
      `SELECT id, logged_at, stream, content FROM startup_log_lines
       WHERE instance_id = $1 AND id > $2 ORDER BY id`,
      [instanceId, afterId],
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      ts: row.logged_at.toISOString(),
      stream: row.stream,
      content: row.content,
    }));
  }
}
