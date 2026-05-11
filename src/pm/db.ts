import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  TASK_STATUSES, SUBTASK_STATUSES, PROJECT_STATUSES,
  WORKTREE_STATUSES,
  SUBTASK_DEPENDENCY_TYPES,
  PROJECT_LINK_TYPES, BUG_STATUSES, BUG_SEVERITIES,
  ENTITY_TYPES, ACTOR_TYPES,
  ANALYSIS_TYPES
} from './enums.js';

/**
 * Schema PM — Product Model
 *
 * Principles:
 * - Projects are containers only (no agents)
 * - Tasks end in 1 PR
 * - Subtasks are executable units for humans or agents
 * - Bugs are associated with tasks and may spawn new tasks
 * - Agent references are plain TEXT columns (no FKs, no joins to agent system)
 */

export function initDb(dbPath: string = "data/project_management.db"): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA foreign_keys = ON;`);

  // ─────────────────────────────────────────────────────────────
  // PROJECTS (containers only)
  // ─────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT UNIQUE,
      description TEXT,
      repo_url TEXT,
      repo_local_path TEXT,
      status TEXT NOT NULL DEFAULT 'planned'
        CHECK(status IN (${PROJECT_STATUSES.map(s => `'${s}'`).join(',')})),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
  `);

  // ─────────────────────────────────────────────────────────────
  // TASKS (1 PR per task, 4 states)
  // ─────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,

      -- States: draft, in_progress, completed, failed
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN (${TASK_STATUSES.map(s => `'${s}'`).join(',')})),

      -- Optional agent references (plain TEXT, no FK to agent system)
      coordinator_agent_id TEXT,
      orchestrator_agent_id TEXT,

      -- Plan bridge: path to Markdown file in worktree (not committed, not source of truth)
      plan_file_path TEXT,

      -- Branch and worktree
      branch_name TEXT,
      base_branch TEXT,
      worktree_path TEXT,
      worktree_status TEXT CHECK(worktree_status IN (${WORKTREE_STATUSES.map(s => `'${s}'`).join(',')})),

      -- Tmux session belongs to the task
      tmux_session TEXT,
      tmux_pane TEXT,

      -- PR info belongs to the task
      pr_url TEXT,
      pr_number INTEGER,
      pr_merged_at TEXT,

      -- Display order
      sequence_order INTEGER DEFAULT 0,

      -- Timestamps
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
  `);

  // ─────────────────────────────────────────────────────────────
  // SUBTASKS (Kanban view, executable by human or agent)
  // ─────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS subtasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,

      -- States: backlog, running, validating, done, failed, blocked
      status TEXT NOT NULL DEFAULT 'backlog'
        CHECK(status IN (${SUBTASK_STATUSES.map(s => `'${s}'`).join(',')})),

      -- Execution priority (applied after dependencies)
      priority INTEGER DEFAULT 0,

      -- Free-text validation criteria (Markdown/text)
      validation_criteria TEXT,

      -- Role and machine-readable contract for automatic orchestration
      required_role TEXT DEFAULT 'dev',
      acceptance_criteria_json TEXT,

      -- Retry budget tracked across worker attempts
      attempt_count INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 2,
      last_error TEXT,

      -- Optional agent references (plain TEXT, no FK to agent system)
      worker_agent_id TEXT,
      qa_agent_id TEXT,

      -- Optional human assignment
      assigned_human TEXT,

      -- Result summary filled on completion/failure
      result_summary TEXT,

      -- Display order
      sequence_order INTEGER DEFAULT 0,

      -- Timestamps
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
  `);

  // ─────────────────────────────────────────────────────────────
  // SUBTASK DEPENDENCIES (control execution)
  // ─────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS subtask_dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subtask_id INTEGER NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
      depends_on_subtask_id INTEGER NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
      dependency_type TEXT NOT NULL DEFAULT 'blocking'
        CHECK(dependency_type IN (${SUBTASK_DEPENDENCY_TYPES.map(s => `'${s}'`).join(',')})),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(subtask_id, depends_on_subtask_id),
      CHECK(subtask_id != depends_on_subtask_id)
    );
  `);

  // ─────────────────────────────────────────────────────────────
  // PROJECT LINKS (spec, release plan, repo, slack, etc.)
  // ─────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      link_type TEXT NOT NULL
        CHECK(link_type IN (${PROJECT_LINK_TYPES.map(s => `'${s}'`).join(',')})),
      url TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ─────────────────────────────────────────────────────────────
  // BUGS (associated with tasks, may spawn new tasks later)
  // ─────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS bugs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN (${BUG_STATUSES.map(s => `'${s}'`).join(',')})),
      severity TEXT CHECK(severity IN (${BUG_SEVERITIES.map(s => `'${s}'`).join(',')})),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ─────────────────────────────────────────────────────────────
  // TASK ANALYSES (chronological context per task)
  // ─────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      version TEXT NOT NULL DEFAULT 'v1',
      keywords TEXT DEFAULT '[]',
      human_note TEXT,
      agent_note TEXT NOT NULL DEFAULT '',
      analysis_type TEXT NOT NULL DEFAULT 'general'
        CHECK(analysis_type IN (${ANALYSIS_TYPES.map(s => `'${s}'`).join(',')})),
      confidence_score INTEGER DEFAULT 50
        CHECK(confidence_score >= 0 AND confidence_score <= 100),
      author_id TEXT,
      author_type TEXT CHECK(author_type IN ('agent','user','system')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      invalidated_at TEXT DEFAULT NULL,
      superseded_by_id INTEGER DEFAULT NULL,
      is_active INTEGER DEFAULT 1 CHECK(is_active IN (0,1))
    );
  `);

  // ─────────────────────────────────────────────────────────────
  // SUBTASK ASSIGNMENTS (historical agent-task tracking)
  // ─────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS subtask_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subtask_id INTEGER NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      assignment_type TEXT DEFAULT 'worker'
        CHECK(assignment_type IN ('worker','qa','coordinator','reviewer')),
      assigned_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      result_summary TEXT,
      status TEXT DEFAULT 'active'
        CHECK(status IN ('active','completed','failed','cancelled')),
      UNIQUE(subtask_id, assignment_type)
    );
  `);

  // ─────────────────────────────────────────────────────────────
  // EVENT LOG (immutable audit)
  // ─────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL CHECK(entity_type IN (${ENTITY_TYPES.map(s => `'${s}'`).join(',')})),
      entity_id INTEGER NOT NULL,
      actor_type TEXT NOT NULL CHECK(actor_type IN (${ACTOR_TYPES.map(s => `'${s}'`).join(',')})),
      actor_id TEXT,
      previous_state TEXT,
      new_state TEXT NOT NULL,
      reason TEXT,
      agent_id TEXT,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ─────────────────────────────────────────────────────────────
  // Idempotent migrations: add missing columns to existing tables
  // ─────────────────────────────────────────────────────────────
  function ensureColumns(table: string, columns: Array<{ name: string; def: string }>) {
    try {
      const existing = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const existingNames = new Set(existing.map((c) => c.name));
      for (const col of columns) {
        if (!existingNames.has(col.name)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.def}`);
        }
      }
    } catch {
      // ignore — table may not exist yet (first run)
    }
  }

  ensureColumns("tasks", [
    { name: "coordinator_agent_id", def: "TEXT" },
    { name: "orchestrator_agent_id", def: "TEXT" },
    { name: "plan_file_path", def: "TEXT" },
    { name: "pr_merged_at", def: "TEXT" },
  ]);

  ensureColumns("subtasks", [
    { name: "worker_agent_id", def: "TEXT" },
    { name: "qa_agent_id", def: "TEXT" },
    { name: "assigned_human", def: "TEXT" },
    { name: "result_summary", def: "TEXT" },
    { name: "validation_criteria", def: "TEXT" },
    { name: "required_role", def: "TEXT DEFAULT 'dev'" },
    { name: "acceptance_criteria_json", def: "TEXT" },
    { name: "attempt_count", def: "INTEGER DEFAULT 0" },
    { name: "max_attempts", def: "INTEGER DEFAULT 2" },
    { name: "last_error", def: "TEXT" },
  ]);

  // ─────────────────────────────────────────────────────────────
  // INDEXES
  // ─────────────────────────────────────────────────────────────
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_coordinator ON tasks(coordinator_agent_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_orchestrator ON tasks(orchestrator_agent_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_subtasks_status ON subtasks(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_subtasks_worker ON subtasks(worker_agent_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_subtasks_qa ON subtasks(qa_agent_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_subtasks_required_role ON subtasks(required_role);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_subtask_deps_on ON subtask_dependencies(depends_on_subtask_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_event_entity ON event_log(entity_type, entity_id, created_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_event_created ON event_log(created_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_project_links_project ON project_links(project_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bugs_task ON bugs(task_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bugs_status ON bugs(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_subtask_assignments_subtask ON subtask_assignments(subtask_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_subtask_assignments_agent ON subtask_assignments(agent_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_subtask_assignments_status ON subtask_assignments(status);`);

  // Task Analyses indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_analyses_task_active ON task_analyses(task_id, is_active);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_analyses_type ON task_analyses(analysis_type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_analyses_created ON task_analyses(created_at);`);

  return db;
}
