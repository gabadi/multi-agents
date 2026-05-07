import { isValidStatus, ENTITY_TYPES, ACTOR_TYPES } from './enums.js';
import type { DatabaseSync } from 'node:sqlite';

export interface UpdateStatusOptions {
  entityType: 'project' | 'task' | 'subtask';
  id: number;
  newState: string;
  actorType: 'user' | 'agent' | 'system';
  actorId?: string;
  reason?: string;
  agentId?: string;
}

function getTerminalStates(entityType: 'project' | 'task' | 'subtask'): string[] {
  switch (entityType) {
    case 'project':
      return ['completed', 'cancelled', 'failed', 'archived'];
    case 'task':
      return ['completed', 'failed'];
    case 'subtask':
      return ['done', 'failed'];
    default:
      return [];
  }
}

export function isTransitionTerminal(entityType: 'project' | 'task' | 'subtask', status: string): boolean {
  return getTerminalStates(entityType).includes(status);
}

export function isCompletedTerminal(entityType: 'project' | 'task' | 'subtask', status: string): boolean {
  return getTerminalStates(entityType).includes(status);
}

export function updateStatus(db: DatabaseSync, options: UpdateStatusOptions) {
  const { entityType, id, newState, actorType, actorId, reason, agentId } = options;

  if (!ENTITY_TYPES.includes(entityType as any)) {
    throw new Error(`Invalid entity type: ${entityType}`);
  }
  if (!ACTOR_TYPES.includes(actorType as any)) {
    throw new Error(`Invalid actor type: ${actorType}`);
  }
  if (!isValidStatus(entityType as any, newState)) {
    throw new Error(`Invalid status: ${newState} for entity ${entityType}`);
  }

  const tableName = `${entityType}s`;
  const selectCols = entityType === 'task'
    ? 'status, pr_merged_at'
    : 'status';
  const entity = db.prepare(`SELECT ${selectCols} FROM ${tableName} WHERE id = ?`).get(id) as any;

  if (!entity) {
    throw new Error(`Entity ${entityType} with id ${id} not found`);
  }

  const previousState = entity.status;

  if (isTransitionTerminal(entityType, previousState)) {
    throw new Error(`Cannot transition from terminal state: ${previousState}`);
  }

  // Task completion rule: PR must be merged and orchestrator must mark it
  if (entityType === 'task' && newState === 'completed') {
    if (!entity.pr_merged_at) {
      throw new Error(`Task cannot transition to 'completed': pr_merged_at is required`);
    }
  }

  const isTerminal = isCompletedTerminal(entityType, newState);

  const updateStmt = isTerminal
    ? db.prepare(`UPDATE ${tableName} SET status = ?, updated_at = datetime('now'), completed_at = datetime('now') WHERE id = ?`)
    : db.prepare(`UPDATE ${tableName} SET status = ?, updated_at = datetime('now') WHERE id = ?`);

  const eventStmt = db.prepare(`
    INSERT INTO event_log (entity_type, entity_id, actor_type, actor_id, previous_state, new_state, reason, agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    db.exec("BEGIN");
    updateStmt.run(newState, id);
    eventStmt.run(entityType, id, actorType, actorId ?? null, previousState, newState, reason ?? null, agentId ?? null);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { id, previousState, newState };
}
