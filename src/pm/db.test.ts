import { DatabaseSync } from "node:sqlite";
import { initDb } from "./db.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKeyInfo {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface IndexListEntry {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

export function runDbSchemaTest(dbPath: string = ":memory:"): { passed: boolean; steps: string[]; error?: string } {
  const steps: string[] = [];
  try {
    const db = initDb(dbPath);
    steps.push("Database initialized");

    // ── Verify all expected tables exist ──
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    [
      "projects",
      "tasks",
      "subtasks",
      "subtask_dependencies",
      "subtask_assignments",
      "project_links",
      "bugs",
      "event_log",
    ].forEach((name) => {
      assert(tableNames.includes(name), `Missing table: ${name}`);
    });
    steps.push("All expected tables exist");

    // ── Verify subtasks has worker_agent_id and qa_agent_id ──
    const subtaskCols = db.prepare("PRAGMA table_info(subtasks)").all() as ColumnInfo[];
    const subtaskColNames = subtaskCols.map((c) => c.name);
    assert(subtaskColNames.includes("worker_agent_id"), "subtasks missing worker_agent_id");
    assert(subtaskColNames.includes("qa_agent_id"), "subtasks missing qa_agent_id");
    steps.push("subtasks has worker_agent_id and qa_agent_id columns");

    // ── Verify subtask_assignments schema ──
    const cols = db.prepare("PRAGMA table_info(subtask_assignments)").all() as ColumnInfo[];
    const colMap = new Map(cols.map((c) => [c.name, c]));

    const expectedColumns = [
      { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
      { name: "subtask_id", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "agent_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "assignment_type", type: "TEXT", notnull: 0, pk: 0 },
      { name: "assigned_at", type: "TEXT", notnull: 0, pk: 0 },
      { name: "completed_at", type: "TEXT", notnull: 0, pk: 0 },
      { name: "result_summary", type: "TEXT", notnull: 0, pk: 0 },
      { name: "status", type: "TEXT", notnull: 0, pk: 0 },
    ];

    for (const exp of expectedColumns) {
      const col = colMap.get(exp.name);
      assert(col !== undefined, `subtask_assignments missing column: ${exp.name}`);
      assert(col!.type === exp.type, `${exp.name} type mismatch: ${col!.type} !== ${exp.type}`);
      assert(col!.notnull === exp.notnull, `${exp.name} notnull mismatch: ${col!.notnull} !== ${exp.notnull}`);
      assert(col!.pk === exp.pk, `${exp.name} pk mismatch: ${col!.pk} !== ${exp.pk}`);
    }
    steps.push("subtask_assignments columns verified");

    // ── Verify defaults via SQLite pragma ──
    const assignmentTypeCol = colMap.get("assignment_type")!;
    assert(
      assignmentTypeCol.dflt_value === "'worker'",
      `assignment_type default mismatch: ${assignmentTypeCol.dflt_value}`
    );

    const statusCol = colMap.get("status")!;
    assert(
      statusCol.dflt_value === "'active'",
      `status default mismatch: ${statusCol.dflt_value}`
    );
    steps.push("subtask_assignments defaults verified");

    // ── Verify FK constraint ──
    const fks = db.prepare("PRAGMA foreign_key_list(subtask_assignments)").all() as ForeignKeyInfo[];
    assert(fks.length === 1, `Expected 1 FK, got ${fks.length}`);
    assert(fks[0].table === "subtasks", `FK table mismatch: ${fks[0].table}`);
    assert(fks[0].from === "subtask_id", `FK from mismatch: ${fks[0].from}`);
    assert(fks[0].to === "id", `FK to mismatch: ${fks[0].to}`);
    assert(fks[0].on_delete === "CASCADE", `FK on_delete mismatch: ${fks[0].on_delete}`);
    steps.push("subtask_assignments foreign key verified");

    // ── Verify unique index on (subtask_id, assignment_type) ──
    const indexes = db.prepare("PRAGMA index_list(subtask_assignments)").all() as IndexListEntry[];
    const uniqueIndex = indexes.find((i) => i.unique === 1);
    assert(uniqueIndex !== undefined, "Missing unique index on subtask_assignments");
    const idxInfo = db.prepare(`PRAGMA index_info(${uniqueIndex!.name})`).all() as Array<{ name: string }>;
    const idxCols = idxInfo.map((i) => i.name).sort();
    assert(
      idxCols.length === 2 && idxCols[0] === "assignment_type" && idxCols[1] === "subtask_id",
      `Unique index columns mismatch: [${idxCols.join(", ")}]`
    );
    steps.push("subtask_assignments unique constraint verified");

    // ── Test CHECK constraints ──
    // Need a valid subtask first to test inserts
    db.exec(`
      INSERT INTO projects (name, status) VALUES ('test-project', 'planned');
    `);
    const projectId = (db.prepare("SELECT last_insert_rowid() as id").get() as any).id;

    db.exec(`
      INSERT INTO tasks (project_id, title, status) VALUES (${projectId}, 'test-task', 'draft');
    `);
    const taskId = (db.prepare("SELECT last_insert_rowid() as id").get() as any).id;

    db.exec(`
      INSERT INTO subtasks (task_id, title, status) VALUES (${taskId}, 'test-subtask', 'backlog');
    `);
    const subtaskId = (db.prepare("SELECT last_insert_rowid() as id").get() as any).id;

    // Valid insert should succeed
    db.exec(`
      INSERT INTO subtask_assignments (subtask_id, agent_id, assignment_type, status)
      VALUES (${subtaskId}, 'agent-1', 'worker', 'active');
    `);
    steps.push("Valid subtask_assignments insert succeeded");

    // Duplicate (subtask_id, assignment_type) should fail
    let dupFailed = false;
    try {
      db.exec(`
        INSERT INTO subtask_assignments (subtask_id, agent_id, assignment_type, status)
        VALUES (${subtaskId}, 'agent-2', 'worker', 'active');
      `);
    } catch {
      dupFailed = true;
    }
    assert(dupFailed, "Duplicate subtask_id + assignment_type should have failed");
    steps.push("Unique constraint enforced");

    // Invalid assignment_type should fail
    let badTypeFailed = false;
    try {
      db.exec(`
        INSERT INTO subtask_assignments (subtask_id, agent_id, assignment_type, status)
        VALUES (${subtaskId}, 'agent-3', 'invalid_type', 'active');
      `);
    } catch {
      badTypeFailed = true;
    }
    assert(badTypeFailed, "Invalid assignment_type should have failed CHECK");
    steps.push("assignment_type CHECK enforced");

    // Invalid status should fail
    let badStatusFailed = false;
    try {
      db.exec(`
        INSERT INTO subtask_assignments (subtask_id, agent_id, assignment_type, status)
        VALUES (${subtaskId}, 'agent-4', 'qa', 'bad_status');
      `);
    } catch {
      badStatusFailed = true;
    }
    assert(badStatusFailed, "Invalid status should have failed CHECK");
    steps.push("status CHECK enforced");

    // Valid distinct assignment_type for same subtask should succeed
    db.exec(`
      INSERT INTO subtask_assignments (subtask_id, agent_id, assignment_type, status)
      VALUES (${subtaskId}, 'agent-5', 'reviewer', 'active');
    `);
    steps.push("Distinct assignment_type for same subtask succeeded");

    // ON DELETE CASCADE: deleting subtask should delete assignments
    db.exec(`DELETE FROM subtasks WHERE id = ${subtaskId}`);
    const remaining = db.prepare("SELECT COUNT(*) as c FROM subtask_assignments WHERE subtask_id = ?").get(subtaskId) as any;
    assert(remaining.c === 0, "Assignments should be deleted on subtask deletion");
    steps.push("ON DELETE CASCADE verified");

    // ── Verify helper indexes exist ──
    const allIndexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='subtask_assignments'"
    ).all() as Array<{ name: string }>;
    const idxNames = allIndexes.map((i) => i.name);
    assert(
      idxNames.some((n) => n.includes("subtask")),
      "Missing index on subtask_assignments(subtask_id)"
    );
    assert(
      idxNames.some((n) => n.includes("agent")),
      "Missing index on subtask_assignments(agent_id)"
    );
    assert(
      idxNames.some((n) => n.includes("status")),
      "Missing index on subtask_assignments(status)"
    );
    steps.push("subtask_assignments indexes verified");

    db.close();
    return { passed: true, steps };
  } catch (e: any) {
    return { passed: false, steps, error: e.message };
  }
}

// CLI runner
if (import.meta.url.endsWith(process.argv[1].replace(/^.*[\\\/]/, ""))) {
  const result = runDbSchemaTest();
  if (result.passed) {
    console.log(`✅ db.test.ts PASSED (${result.steps.length} steps)`);
    result.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    process.exit(0);
  } else {
    console.error(`❌ db.test.ts FAILED at step ${result.steps.length + 1}`);
    result.steps.forEach((s, i) => console.error(`  ${i + 1}. ${s}`));
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
}
