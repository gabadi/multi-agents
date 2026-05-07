import { DatabaseSync } from 'node:sqlite';

export interface TaskAgentAssignment {
  coordinator_agent_id?: string;
  orchestrator_agent_id?: string;
}

export interface SubtaskAgentAssignment {
  worker_agent_id?: string;
  qa_agent_id?: string;
}

export function assignTaskAgents(
  db: DatabaseSync,
  taskId: number,
  assignment: TaskAgentAssignment
) {
  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
  if (!task) throw new Error(`Task with ID ${taskId} not found.`);

  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (assignment.coordinator_agent_id !== undefined) {
    fields.push('coordinator_agent_id = ?');
    values.push(assignment.coordinator_agent_id ?? null);
  }
  if (assignment.orchestrator_agent_id !== undefined) {
    fields.push('orchestrator_agent_id = ?');
    values.push(assignment.orchestrator_agent_id ?? null);
  }

  if (fields.length === 0) {
    throw new Error('No agent fields provided for assignment.');
  }

  values.push(taskId);
  db.prepare(`UPDATE tasks SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values);

  return { taskId, assignment };
}

export function assignSubtaskAgents(
  db: DatabaseSync,
  subtaskId: number,
  assignment: SubtaskAgentAssignment
) {
  const subtask = db.prepare('SELECT id FROM subtasks WHERE id = ?').get(subtaskId);
  if (!subtask) throw new Error(`Subtask with ID ${subtaskId} not found.`);

  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (assignment.worker_agent_id !== undefined) {
    fields.push('worker_agent_id = ?');
    values.push(assignment.worker_agent_id ?? null);
  }
  if (assignment.qa_agent_id !== undefined) {
    fields.push('qa_agent_id = ?');
    values.push(assignment.qa_agent_id ?? null);
  }

  if (fields.length === 0) {
    throw new Error('No agent fields provided for assignment.');
  }

  values.push(subtaskId);
  db.prepare(`UPDATE subtasks SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values);

  return { subtaskId, assignment };
}

export function getTaskAgentIds(db: DatabaseSync, taskId: number): {
  coordinator_agent_id: string | null;
  orchestrator_agent_id: string | null;
} {
  const row = db.prepare(
    'SELECT coordinator_agent_id, orchestrator_agent_id FROM tasks WHERE id = ?'
  ).get(taskId) as { coordinator_agent_id: string | null; orchestrator_agent_id: string | null } | undefined;

  if (!row) throw new Error(`Task with ID ${taskId} not found.`);
  return row;
}

export function getSubtaskAgentIds(db: DatabaseSync, subtaskId: number): {
  worker_agent_id: string | null;
  qa_agent_id: string | null;
} {
  const row = db.prepare(
    'SELECT worker_agent_id, qa_agent_id FROM subtasks WHERE id = ?'
  ).get(subtaskId) as { worker_agent_id: string | null; qa_agent_id: string | null } | undefined;

  if (!row) throw new Error(`Subtask with ID ${subtaskId} not found.`);
  return row;
}
