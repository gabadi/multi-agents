#!/usr/bin/env npx tsx
/**
 * validate-schema.ts — Validate current PM database schema against Product Model
 *
 * Usage:
 *   npx tsx src/pm/validate-schema.ts [--db=PATH]
 *
 * Exits 0 if schema is valid, 1 otherwise.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

const FABRIC_DIR = "/tmp/fabric-agents";
const DEFAULT_DB_PATH = join(FABRIC_DIR, "projects.sqlite");

const EXPECTED_TABLES: Record<string, string[]> = {
  projects: [
    "id", "name", "code", "description", "repo_url", "repo_local_path",
    "status", "created_at", "updated_at", "completed_at",
  ],
  tasks: [
    "id", "project_id", "title", "description", "status",
    "coordinator_agent_id", "orchestrator_agent_id", "plan_file_path",
    "branch_name", "base_branch", "worktree_path", "worktree_status",
    "tmux_session", "tmux_pane", "pr_url", "pr_number", "pr_merged_at",
    "sequence_order", "created_at", "updated_at", "completed_at",
  ],
  subtasks: [
    "id", "task_id", "title", "description", "status",
    "priority", "validation_criteria", "required_role", "acceptance_criteria_json",
    "attempt_count", "max_attempts", "last_error", "worker_agent_id", "qa_agent_id",
    "assigned_human", "result_summary", "sequence_order",
    "created_at", "updated_at", "completed_at",
  ],
  subtask_dependencies: [
    "id", "subtask_id", "depends_on_subtask_id", "dependency_type", "created_at",
  ],
  project_links: [
    "id", "project_id", "link_type", "url", "description", "created_at",
  ],
  bugs: [
    "id", "task_id", "title", "description", "status", "severity",
    "created_at", "updated_at",
  ],
  event_log: [
    "id", "entity_type", "entity_id", "actor_type", "actor_id",
    "previous_state", "new_state", "reason", "agent_id", "payload", "created_at",
  ],
};

const FORBIDDEN_TABLES = ["task_dependencies", "agent_associations"];

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function getDbPath(): string {
  const arg = process.argv.find((a) => a.startsWith("--db="));
  return arg ? arg.slice(5) : DEFAULT_DB_PATH;
}

function validate(dbPath: string): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  if (!existsSync(dbPath)) {
    result.errors.push(`Database not found: ${dbPath}`);
    result.valid = false;
    return result;
  }

  const db = new DatabaseSync(dbPath, { readonly: true });

  // Check tables
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all() as Array<{ name: string }>;
  const tableNames = new Set(tables.map((t) => t.name));

  for (const forbidden of FORBIDDEN_TABLES) {
    if (tableNames.has(forbidden)) {
      result.errors.push(`Forbidden table found: ${forbidden} (must be removed)`);
      result.valid = false;
    }
  }

  for (const [table, expectedCols] of Object.entries(EXPECTED_TABLES)) {
    if (!tableNames.has(table)) {
      result.errors.push(`Missing table: ${table}`);
      result.valid = false;
      continue;
    }

    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));

    for (const col of expectedCols) {
      if (!colNames.has(col)) {
        result.errors.push(`Missing column: ${table}.${col}`);
        result.valid = false;
      }
    }

    for (const col of colNames) {
      if (!expectedCols.includes(col)) {
        result.warnings.push(`Extra column: ${table}.${col} (not in product model)`);
      }
    }
  }

  // Validate CHECK constraints on statuses by attempting invalid inserts in a transaction
  // (we can't easily parse CHECK text, so we probe)
  try {
    db.exec("BEGIN");
    db.prepare("INSERT INTO tasks (project_id, title, status) VALUES (0, 'probe', 'invalid_status')").run();
    db.exec("ROLLBACK");
    result.errors.push("tasks.status CHECK constraint missing or allows invalid values");
    result.valid = false;
  } catch {
    db.exec("ROLLBACK");
  }

  try {
    db.exec("BEGIN");
    db.prepare("INSERT INTO subtasks (task_id, title, status) VALUES (0, 'probe', 'invalid_status')").run();
    db.exec("ROLLBACK");
    result.errors.push("subtasks.status CHECK constraint missing or allows invalid values");
    result.valid = false;
  } catch {
    db.exec("ROLLBACK");
  }

  db.close();
  return result;
}

function main() {
  const dbPath = getDbPath();
  console.log(`Validating PM schema: ${dbPath}\n`);

  const result = validate(dbPath);

  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log("✅ Schema is fully aligned with the product model.");
    process.exit(0);
  }

  if (result.errors.length > 0) {
    console.log("❌ Errors:");
    for (const e of result.errors) console.log(`  - ${e}`);
  }

  if (result.warnings.length > 0) {
    console.log("\n⚠️  Warnings:");
    for (const w of result.warnings) console.log(`  - ${w}`);
  }

  process.exit(result.valid ? 0 : 1);
}

main();
