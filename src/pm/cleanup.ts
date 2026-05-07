import { DatabaseSync } from "node:sqlite";

export interface CleanupResult {
  id: number;
  previousState: string;
  newState: string;
  alreadyTerminal?: boolean;
}

export interface CleanupStats {
  cleaned: number;
}

const TASK_TERMINAL_STATUSES = new Set(["completed", "failed"]);
const SUBTASK_TERMINAL_STATUSES = new Set(["done", "failed"]);

export function cleanupTask(
  db: DatabaseSync,
  taskId: number,
  actorType?: string,
  actorId?: string,
  reason?: string
): CleanupResult {
  const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
  if (!task) throw new Error(`Task with id ${taskId} not found`);

  if (!TASK_TERMINAL_STATUSES.has(task.status)) {
    throw new Error(`Cannot cleanup task in non-terminal status: ${task.status}`);
  }

  const previousState = task.status;

  db.prepare(`
    UPDATE tasks SET
      worktree_status = 'deleted',
      worktree_path = NULL,
      branch_name = NULL,
      tmux_session = NULL,
      tmux_pane = NULL,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(taskId);

  db.prepare(`
    INSERT INTO event_log (entity_type, entity_id, actor_type, actor_id, previous_state, new_state, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("task", taskId, actorType ?? "system", actorId ?? null, previousState, "cleaned", reason ?? "cleanup");

  return { id: taskId, previousState, newState: "cleaned" };
}

export function archiveProject(
  db: DatabaseSync,
  projectId: number,
  actorType?: string,
  actorId?: string,
  reason?: string
): CleanupResult {
  const project = db.prepare("SELECT status FROM projects WHERE id = ?").get(projectId) as { status: string } | undefined;
  if (!project) throw new Error(`Project with id ${projectId} not found`);

  const terminal = ['completed', 'cancelled', 'failed', 'archived'];
  if (terminal.includes(project.status)) {
    return { id: projectId, previousState: project.status, newState: "archived", alreadyTerminal: true };
  }

  const previousState = project.status;

  db.prepare(`
    UPDATE projects SET
      status = 'archived',
      updated_at = datetime('now'),
      completed_at = datetime('now')
    WHERE id = ?
  `).run(projectId);

  db.prepare(`
    INSERT INTO event_log (entity_type, entity_id, actor_type, actor_id, previous_state, new_state, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("project", projectId, actorType ?? "system", actorId ?? null, previousState, "archived", reason ?? "cleanup");

  return { id: projectId, previousState, newState: "archived" };
}

export function cleanupSubtask(
  db: DatabaseSync,
  subtaskId: number,
  actorType?: string,
  actorId?: string,
  reason?: string
): CleanupResult {
  const subtask = db.prepare("SELECT status FROM subtasks WHERE id = ?").get(subtaskId) as { status: string } | undefined;
  if (!subtask) throw new Error(`Subtask with id ${subtaskId} not found`);

  if (!SUBTASK_TERMINAL_STATUSES.has(subtask.status)) {
    throw new Error(`Cannot cleanup subtask in non-terminal status: ${subtask.status}`);
  }

  const previousState = subtask.status;

  // Subtask cleanup is mostly a no-op metadata-wise, but we log it
  db.prepare(`
    INSERT INTO event_log (entity_type, entity_id, actor_type, actor_id, previous_state, new_state, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("subtask", subtaskId, actorType ?? "system", actorId ?? null, previousState, "cleaned", reason ?? "cleanup");

  return { id: subtaskId, previousState, newState: "cleaned" };
}

export function cleanupStaleWorktrees(db: DatabaseSync): CleanupStats {
  const tasksToClean = db.prepare(`
    SELECT id FROM tasks
    WHERE status IN ('completed', 'failed')
    AND worktree_status = 'active'
  `).all() as { id: number }[];

  for (const task of tasksToClean) {
    db.prepare(`
      UPDATE tasks SET
        worktree_status = 'deleted',
        worktree_path = NULL,
        branch_name = NULL,
        tmux_session = NULL,
        tmux_pane = NULL,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(task.id);
  }

  return { cleaned: tasksToClean.length };
}
