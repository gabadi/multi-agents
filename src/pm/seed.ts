import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { initDb } from "./db.js";

export function seed(dbPath: string = "data/project_management.db"): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  initDb(dbPath);

  const db = new DatabaseSync(dbPath);

  // 1. Project
  db.prepare(`
    INSERT OR IGNORE INTO projects (code, name, repo_url)
    VALUES (?, ?, ?)
  `).run('p01', 'Sistema de Agentes Fabric', 'https://github.com/jescobar/cmd-center-v2');

  const projectId = (db.prepare(`SELECT id FROM projects WHERE code = ?`).get('p01') as { id: number }).id;

  // 2. Tasks
  const tasks = [
    { title: 'Implementar Registry SQLite', status: 'in_progress', seq: 1, branch: 't1-registry', coordinator: 'boss' },
    { title: 'Implementar Mailbox P2P', status: 'draft', seq: 2, branch: 't2-mailbox' },
    { title: 'Dashboard Read-Only', status: 'draft', seq: 3, branch: 't3-dashboard' },
  ];

  const stmtTask = db.prepare(`
    INSERT OR IGNORE INTO tasks (project_id, title, status, sequence_order, branch_name, base_branch, coordinator_agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const taskIds: Record<string, number> = {};
  for (const t of tasks) {
    stmtTask.run(projectId, t.title, t.status, t.seq, t.branch, 'main', t.coordinator ?? null);
    const row = db.prepare(`SELECT id FROM tasks WHERE branch_name = ?`).get(t.branch) as { id: number };
    taskIds[t.branch] = row.id;
  }

  // 3. Subtasks
  const subtasks = [
    { task: 't1-registry', title: 'Crear schema registry', status: 'done', priority: 1, worker: 'legacy-worker-1' },
    { task: 't1-registry', title: 'Crear tabla agents', status: 'done', priority: 2 },
    { task: 't2-mailbox', title: 'Definir formato JSONL mensaje', status: 'running', priority: 1 },
    { task: 't2-mailbox', title: 'Implementar SIGUSR1 handler', status: 'backlog', priority: 2 },
    { task: 't3-dashboard', title: 'Query de arbol proyecto-task-subtask', status: 'backlog', priority: 1 },
    { task: 't3-dashboard', title: 'Renderizar tabla Rich en terminal', status: 'backlog', priority: 2, validation: 'Tests must pass and output is readable in terminal' },
  ];

  const stmtSub = db.prepare(`
    INSERT OR IGNORE INTO subtasks (task_id, title, status, priority, worker_agent_id, validation_criteria)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const subtaskIds: number[] = [];
  for (const s of subtasks) {
    stmtSub.run(taskIds[s.task], s.title, s.status, s.priority, s.worker ?? null, s.validation ?? null);
    const row = db.prepare(`SELECT id FROM subtasks WHERE task_id = ? AND title = ?`).get(taskIds[s.task], s.title) as { id: number };
    subtaskIds.push(row.id);
  }

  // 4. Subtask dependency: t2-mailbox second subtask depends on first
  const t2Subtasks = db.prepare(`SELECT id FROM subtasks WHERE task_id = ? ORDER BY id ASC`).all(taskIds['t2-mailbox']) as { id: number }[];
  if (t2Subtasks.length >= 2) {
    db.prepare(`
      INSERT OR IGNORE INTO subtask_dependencies (subtask_id, depends_on_subtask_id, dependency_type)
      VALUES (?, ?, ?)
    `).run(t2Subtasks[1].id, t2Subtasks[0].id, 'logical');
  }

  // 5. Project link
  db.prepare(`
    INSERT OR IGNORE INTO project_links (project_id, link_type, url, description)
    VALUES (?, ?, ?, ?)
  `).run(projectId, 'github', 'https://github.com/jescobar/cmd-center-v2', 'Main repository');

  // 6. Event logs
  type EntityType = 'project' | 'task' | 'subtask';
  type ActorType = 'user' | 'agent' | 'system';

  const events: [EntityType, number, ActorType, string | null, string, string][] = [
    ['project', projectId, 'system', null, 'planned', 'Seed: project created'],
    ['task', taskIds['t1-registry'], 'system', 'draft', 'in_progress', 'Seed: task started'],
    ['task', taskIds['t2-mailbox'], 'system', null, 'draft', 'Seed: task created'],
  ];

  const stmtEvent = db.prepare(`
    INSERT INTO event_log (entity_type, entity_id, actor_type, previous_state, new_state, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const e of events) {
    stmtEvent.run(e[0], e[1], e[2], e[3], e[4], e[5]);
  }

  console.log(`Seed completado en: ${dbPath}`);
  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.argv[2] || "data/project_management.db";
  seed(dbPath);
}
