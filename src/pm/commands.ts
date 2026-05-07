import { DatabaseSync } from "node:sqlite";
import { isValidStatus } from "./enums.js";

export function createProject(
  db: DatabaseSync,
  data: {
    name: string;
    code?: string;
    description?: string;
    repo_url?: string;
    repo_local_path?: string;
    status?: string;
  }
) {
  const status = data.status ?? "planned";
  if (!isValidStatus("project", status)) {
    throw new Error(`Invalid project status: ${status}`);
  }

  const stmt = db.prepare(
    `INSERT INTO projects (name, code, description, repo_url, repo_local_path, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    data.name,
    data.code ?? null,
    data.description ?? null,
    data.repo_url ?? null,
    data.repo_local_path ?? null,
    status
  );

  return db.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
}

export function createTask(
  db: DatabaseSync,
  data: {
    project_id: number;
    title: string;
    description?: string;
    status?: string;
    sequence_order?: number;
    coordinator_agent_id?: string;
    orchestrator_agent_id?: string;
    plan_file_path?: string;
    branch_name?: string;
    base_branch?: string;
  }
) {
  const projectExists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(data.project_id);
  if (!projectExists) {
    throw new Error(`Project with id ${data.project_id} does not exist`);
  }

  const status = data.status ?? "draft";
  if (!isValidStatus("task", status)) {
    throw new Error(`Invalid task status: ${status}`);
  }

  const stmt = db.prepare(
    `INSERT INTO tasks (project_id, title, description, status, sequence_order,
                        coordinator_agent_id, orchestrator_agent_id, plan_file_path,
                        branch_name, base_branch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    data.project_id,
    data.title,
    data.description ?? null,
    status,
    data.sequence_order ?? 0,
    data.coordinator_agent_id ?? null,
    data.orchestrator_agent_id ?? null,
    data.plan_file_path ?? null,
    data.branch_name ?? null,
    data.base_branch ?? null
  );

  return db.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
}

export function createSubtask(
  db: DatabaseSync,
  data: {
    task_id: number;
    title: string;
    description?: string;
    status?: string;
    sequence_order?: number;
    priority?: number;
    validation_criteria?: string;
    worker_agent_id?: string;
    qa_agent_id?: string;
    assigned_human?: string;
  }
) {
  const taskExists = db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(data.task_id);
  if (!taskExists) {
    throw new Error(`Task with id ${data.task_id} does not exist`);
  }

  const status = data.status ?? "backlog";
  if (!isValidStatus("subtask", status)) {
    throw new Error(`Invalid subtask status: ${status}`);
  }

  const stmt = db.prepare(
    `INSERT INTO subtasks (task_id, title, description, status, sequence_order,
                           priority, validation_criteria, worker_agent_id, qa_agent_id, assigned_human)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    data.task_id,
    data.title,
    data.description ?? null,
    status,
    data.sequence_order ?? 0,
    data.priority ?? 0,
    data.validation_criteria ?? null,
    data.worker_agent_id ?? null,
    data.qa_agent_id ?? null,
    data.assigned_human ?? null
  );

  return db.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
}

export function listProjects(db: DatabaseSync) {
  return db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all();
}

export function listTasks(db: DatabaseSync, project_id: number) {
  return db
    .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY sequence_order, id")
    .all(project_id);
}

export function listSubtasks(db: DatabaseSync, task_id: number) {
  return db
    .prepare("SELECT * FROM subtasks WHERE task_id = ? ORDER BY priority DESC, sequence_order, id")
    .all(task_id);
}

export function getProject(db: DatabaseSync, id: number) {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  if (!row) throw new Error(`Project ${id} not found`);
  return row;
}

export function getTask(db: DatabaseSync, id: number) {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  if (!row) throw new Error(`Task ${id} not found`);
  return row;
}

export function getSubtask(db: DatabaseSync, id: number) {
  const row = db.prepare("SELECT * FROM subtasks WHERE id = ?").get(id);
  if (!row) throw new Error(`Subtask ${id} not found`);
  return row;
}
