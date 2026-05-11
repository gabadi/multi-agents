import { DatabaseSync } from "node:sqlite";

export interface ProjectRow {
  id: number;
  name: string;
  code: string | null;
  description: string | null;
  repo_url: string | null;
  repo_local_path: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskRow {
  id: number;
  project_id: number;
  title: string;
  description: string | null;
  status: string;
  sequence_order: number;
  coordinator_agent_id: string | null;
  orchestrator_agent_id: string | null;
  plan_file_path: string | null;
  branch_name: string | null;
  base_branch: string | null;
  worktree_path: string | null;
  worktree_status: string | null;
  tmux_session: string | null;
  tmux_pane: string | null;
  pr_url: string | null;
  pr_number: number | null;
  pr_merged_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface SubtaskRow {
  id: number;
  task_id: number;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  validation_criteria: string | null;
  required_role: string | null;
  acceptance_criteria_json: string | null;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  worker_agent_id: string | null;
  qa_agent_id: string | null;
  assigned_human: string | null;
  result_summary: string | null;
  sequence_order: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface SubtaskDependencyRow {
  id: number;
  subtask_id: number;
  depends_on_subtask_id: number;
  dependency_type: string;
  created_at: string;
}

export interface EventRow {
  id: number;
  entity_type: string;
  entity_id: number;
  actor_type: string;
  new_state: string;
  reason: string | null;
  created_at: string;
}

export interface TaskDetails {
  id: number;
  title: string;
  status: string;
  subtasks: SubtaskRow[];
  blocked_by: SubtaskDependencyRow[];
  events: EventRow[];
}

export interface ProjectTree {
  project: ProjectRow;
  tasks: (TaskRow & { subtasks: SubtaskRow[] })[];
}

export interface DashboardRow extends ProjectRow {
  task_count: number;
  tasks_completed: number;
}

export function getProjectTree(db: DatabaseSync, projectId: number): ProjectTree {
  const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as ProjectRow | undefined;
  if (!project) throw new Error(`Project ${projectId} not found`);

  const tasks = db.prepare(`SELECT * FROM tasks WHERE project_id = ? ORDER BY sequence_order ASC`).all(projectId) as TaskRow[];

  const stmtSub = db.prepare(`SELECT * FROM subtasks WHERE task_id = ? ORDER BY priority DESC, sequence_order ASC`);

  return {
    project,
    tasks: tasks.map(t => ({
      ...t,
      subtasks: stmtSub.all(t.id) as SubtaskRow[],
    })),
  };
}

export function getTaskWithDetails(db: DatabaseSync, taskId: number): TaskDetails {
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as TaskRow | undefined;
  if (!task) throw new Error(`Task ${taskId} not found`);

  const subtasks = db.prepare(`SELECT * FROM subtasks WHERE task_id = ? ORDER BY priority DESC, sequence_order ASC`).all(taskId) as SubtaskRow[];

  const blocked_by = db.prepare(`
    SELECT d.id, d.subtask_id, d.depends_on_subtask_id, d.dependency_type, d.created_at
    FROM subtask_dependencies d
    JOIN subtasks s ON s.id = d.subtask_id
    WHERE s.task_id = ?
  `).all(taskId) as SubtaskDependencyRow[];

  const events = db.prepare(`
    SELECT id, entity_type, entity_id, actor_type, new_state, reason, created_at
    FROM event_log
    WHERE entity_type = 'task' AND entity_id = ?
    ORDER BY created_at DESC
    LIMIT 5
  `).all(taskId) as EventRow[];

  return { id: task.id, title: task.title, status: task.status, subtasks, blocked_by, events };
}

export function getDashboard(db: DatabaseSync): DashboardRow[] {
  const sql = `
    SELECT
      p.*,
      COUNT(t.id) as task_count,
      SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) as tasks_completed
    FROM projects p
    LEFT JOIN tasks t ON p.id = t.project_id
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `;
  return db.prepare(sql).all() as DashboardRow[];
}

export function getTasks(db: DatabaseSync, filters?: { project_id?: number; status?: string; agent_id?: string }): TaskRow[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters?.project_id != null) {
    conditions.push("project_id = ?");
    params.push(filters.project_id);
  }
  if (filters?.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters?.agent_id) {
    conditions.push("(coordinator_agent_id = ? OR orchestrator_agent_id = ?)");
    params.push(filters.agent_id, filters.agent_id);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM tasks ${where} ORDER BY sequence_order ASC`).all(...params) as TaskRow[];
}

export function getTaskById(db: DatabaseSync, taskId: number): TaskRow | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
}

export function getSubtasksByTaskId(db: DatabaseSync, taskId: number): SubtaskRow[] {
  return db.prepare(`SELECT * FROM subtasks WHERE task_id = ? ORDER BY priority DESC, sequence_order ASC`).all(taskId) as SubtaskRow[];
}

export function getAgentIdsForProject(db: DatabaseSync, projectId: number): string[] {
  const tree = getProjectTree(db, projectId);
  const ids = new Set<string>();
  for (const task of tree.tasks) {
    if (task.coordinator_agent_id) ids.add(task.coordinator_agent_id);
    if (task.orchestrator_agent_id) ids.add(task.orchestrator_agent_id);
    for (const sub of task.subtasks) {
      if (sub.worker_agent_id) ids.add(sub.worker_agent_id);
      if (sub.qa_agent_id) ids.add(sub.qa_agent_id);
    }
  }
  return Array.from(ids);
}
