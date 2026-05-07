import { DatabaseSync } from "node:sqlite";

export interface ReadySubtask {
  id: number;
  title: string;
  task_id: number;
  priority: number;
  sequence_order: number;
}

export interface RoleCount {
  role: string;
  count: number;
}

/**
 * Returns all subtasks with status='backlog' or 'ready' that have NO blocking
 * unmet dependencies. A blocking dependency is a row in subtask_dependencies
 * with dependency_type='blocking' where the depended-on subtask status is NOT 'done'.
 */
export function findReadySubtasks(db: DatabaseSync): ReadySubtask[] {
  const sql = `
    SELECT
      s.id,
      s.title,
      s.task_id,
      s.priority,
      s.sequence_order
    FROM subtasks s
    WHERE s.status IN ('backlog', 'ready')
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
  return db.prepare(sql).all() as ReadySubtask[];
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
