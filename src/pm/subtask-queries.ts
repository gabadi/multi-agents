import { DatabaseSync } from "node:sqlite";

interface ReadySubtaskRow {
  id: number;
  title: string;
  description: string | null;
  task_id: number;
  priority: number;
  sequence_order: number;
  required_role: string | null;
  acceptance_criteria_json: string | null;
  attempt_count: number | null;
  max_attempts: number | null;
}

export interface ReadySubtask {
  id: number;
  title: string;
  description?: string;
  task_id: number;
  priority: number;
  sequence_order: number;
  required_role?: string;
  acceptance_criteria?: Array<{
    id: string;
    description: string;
    type: string;
    params: Record<string, unknown>;
    required: boolean;
  }>;
  attempt_count: number;
  max_attempts: number;
}

export interface RoleCount {
  role: string;
  count: number;
}

function parseAcceptanceCriteria(raw: string | null): ReadySubtask["acceptance_criteria"] {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns all subtasks with status='backlog' or 'ready' that have NO blocking
 * unmet dependencies and still have attempts remaining.
 */
export function findReadySubtasks(db: DatabaseSync): ReadySubtask[] {
  const sql = `
    SELECT
      s.id,
      s.title,
      s.description,
      s.task_id,
      s.priority,
      s.sequence_order,
      s.required_role,
      s.acceptance_criteria_json,
      s.attempt_count,
      s.max_attempts
    FROM subtasks s
    WHERE s.status IN ('backlog', 'ready')
      AND COALESCE(s.attempt_count, 0) < COALESCE(s.max_attempts, 2)
      AND NOT EXISTS (
        SELECT 1
        FROM subtask_dependencies d
        JOIN subtasks dep ON dep.id = d.depends_on_subtask_id
        WHERE d.subtask_id = s.id
          AND d.dependency_type = 'blocking'
          AND dep.status != 'done'
      )
    ORDER BY s.priority DESC, s.sequence_order ASC
  `;

  const rows = db.prepare(sql).all() as ReadySubtaskRow[];
  return rows.map((row) => {
    const acceptanceCriteria = parseAcceptanceCriteria(row.acceptance_criteria_json);
    return {
      id: row.id,
      title: row.title,
      ...(row.description ? { description: row.description } : {}),
      task_id: row.task_id,
      priority: row.priority,
      sequence_order: row.sequence_order,
      ...(row.required_role ? { required_role: row.required_role } : {}),
      ...(acceptanceCriteria ? { acceptance_criteria: acceptanceCriteria } : {}),
      attempt_count: row.attempt_count ?? 0,
      max_attempts: row.max_attempts ?? 2,
    };
  });
}

/**
 * Counts rows in subtask_assignments with status='active', joins with the
 * Fabric registry agents table on agent_id to get role, and returns
 * {role, count} ordered by count DESC.
 */
export function countActiveAssignmentsByRole(db: DatabaseSync): RoleCount[] {
  const registryPath = process.env.FABRIC_DIR
    ? `${process.env.FABRIC_DIR}/registry.sqlite`
    : "/tmp/fabric-agents/registry.sqlite";

  try {
    db.exec(`ATTACH DATABASE '${registryPath}' AS registry`);
  } catch (e: any) {
    // If already attached from a previous call, continue
    if (!e?.message?.includes("already in use")) {
      throw e;
    }
  }

  try {
    const sql = `
      SELECT a.role, COUNT(*) as count
      FROM subtask_assignments sa
      JOIN registry.agents a ON a.agent_id = sa.agent_id
      WHERE sa.status = 'active'
      GROUP BY a.role
      ORDER BY count DESC
    `;
    return db.prepare(sql).all() as RoleCount[];
  } finally {
    try {
      db.exec(`DETACH DATABASE registry`);
    } catch {
      // ignore detach errors
    }
  }
}
