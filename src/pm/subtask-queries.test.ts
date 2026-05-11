import { describe, test, before } from "node:test";
import assert from "node:assert";
import { unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initDb } from "./db.js";
import { findReadySubtasks, countActiveAssignmentsByRole } from "./subtask-queries.js";

describe("subtask-queries", () => {
  const dbPath = "/tmp/fabric-agents/test-subtask-queries.db";
  const fabricDir = "/tmp/fabric-agents/test-subtask-queries-fabric";
  const registryPath = join(fabricDir, "registry.sqlite");

  function setup(): DatabaseSync {
    try { unlinkSync(dbPath); } catch { /* ignore if missing */ }
    try { rmSync(fabricDir, { recursive: true, force: true }); } catch { /* ignore */ }
    mkdirSync(fabricDir, { recursive: true });

    // Redirect subtask-queries to our temporary fabric directory
    process.env.FABRIC_DIR = fabricDir;

    return initDb(dbPath);
  }

  // ─────────────────────────────────────────────────────────────
  // findReadySubtasks
  // ─────────────────────────────────────────────────────────────

  test("findReadySubtasks returns backlog/ready subtasks with no unmet blocking dependencies", () => {
    const db = setup();

    db.prepare("INSERT INTO projects (name, code, status) VALUES (?, ?, ?)").run("Test", "TST", "active");
    const project = db.prepare("SELECT id FROM projects WHERE code = ?").get("TST") as { id: number };

    db.prepare("INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)").run(project.id, "Task", "in_progress");
    const task = db.prepare("SELECT id FROM tasks WHERE title = ?").get("Task") as { id: number };

    const subStmt = db.prepare("INSERT INTO subtasks (task_id, title, status) VALUES (?, ?, ?)");
    subStmt.run(task.id, "Sub1 backlog no deps", "backlog"); // id ~1
    subStmt.run(task.id, "Sub2 backlog with done dep", "backlog"); // id ~2
    subStmt.run(task.id, "Sub3 backlog with undone dep", "backlog"); // id ~3
    subStmt.run(task.id, "Sub4 done", "done"); // id ~4
    subStmt.run(task.id, "Sub5 running", "running"); // id ~5
    subStmt.run(task.id, "Sub6 logical dep not done", "backlog"); // id ~6

    // Sub2 depends on Sub4 (done) -> blocking met -> ready
    // Sub3 depends on Sub5 (running) -> blocking unmet -> not ready
    // Sub6 depends on Sub5 (running) -> logical (not blocking) -> ready
    const depStmt = db.prepare("INSERT INTO subtask_dependencies (subtask_id, depends_on_subtask_id, dependency_type) VALUES (?, ?, ?)");
    depStmt.run(2, 4, "blocking");
    depStmt.run(3, 5, "blocking");
    depStmt.run(6, 5, "logical");

    const ready = findReadySubtasks(db);
    const titles = ready.map((r) => r.title).sort();

    assert.deepStrictEqual(titles, [
      "Sub1 backlog no deps",
      "Sub2 backlog with done dep",
      "Sub6 logical dep not done",
    ]);

    // Verify row shape
    const first = ready[0];
    assert.strictEqual(typeof first.id, "number");
    assert.strictEqual(typeof first.task_id, "number");
    assert.strictEqual(typeof first.priority, "number");
    assert.strictEqual(typeof first.sequence_order, "number");
  });

  test("findReadySubtasks excludes subtasks with status not backlog/ready", () => {
    const db = setup();

    db.prepare("INSERT INTO projects (name, code, status) VALUES (?, ?, ?)").run("Test", "TST3", "active");
    const project = db.prepare("SELECT id FROM projects WHERE code = ?").get("TST3") as { id: number };

    db.prepare("INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)").run(project.id, "Task", "in_progress");
    const task = db.prepare("SELECT id FROM tasks WHERE title = ?").get("Task") as { id: number };

    const subStmt = db.prepare("INSERT INTO subtasks (task_id, title, status) VALUES (?, ?, ?)");
    subStmt.run(task.id, "Running sub", "running");
    subStmt.run(task.id, "Failed sub", "failed");
    subStmt.run(task.id, "Blocked sub", "blocked");
    subStmt.run(task.id, "Done sub", "done");

    const ready = findReadySubtasks(db);
    assert.strictEqual(ready.length, 0);
  });

  test("findReadySubtasks returns subtasks with status ready", () => {
    const db = setup();

    db.prepare("INSERT INTO projects (name, code, status) VALUES (?, ?, ?)").run("Test", "TST4", "active");
    const project = db.prepare("SELECT id FROM projects WHERE code = ?").get("TST4") as { id: number };

    db.prepare("INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)").run(project.id, "Task", "in_progress");
    const task = db.prepare("SELECT id FROM tasks WHERE title = ?").get("Task") as { id: number };

    const subStmt = db.prepare("INSERT INTO subtasks (task_id, title, status) VALUES (?, ?, ?)");
    subStmt.run(task.id, "Ready no deps", "backlog");

    // Manually update to 'ready' to simulate a future/planned status
    db.prepare("UPDATE subtasks SET status = 'ready' WHERE title = ?").run("Ready no deps");

    const ready = findReadySubtasks(db);
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].title, "Ready no deps");
  });

  test("findReadySubtasks exposes orchestration metadata and skips exhausted retries", () => {
    const db = setup();

    db.prepare("INSERT INTO projects (name, code, status) VALUES (?, ?, ?)").run("Test", "TST6", "active");
    const project = db.prepare("SELECT id FROM projects WHERE code = ?").get("TST6") as { id: number };

    db.prepare("INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)").run(project.id, "Task", "in_progress");
    const task = db.prepare("SELECT id FROM tasks WHERE title = ?").get("Task") as { id: number };

    const criteria = JSON.stringify([
      {
        id: "c1",
        description: "Run reviewer checks",
        type: "manual",
        params: { instructions: "Inspect retry behavior" },
        required: true,
      },
    ]);

    db.prepare(
      `INSERT INTO subtasks (task_id, title, description, status, required_role, acceptance_criteria_json, attempt_count, max_attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(task.id, "Reviewer lane", "Needs reviewer", "ready", "reviewer", criteria, 0, 3);

    db.prepare(
      `INSERT INTO subtasks (task_id, title, status, attempt_count, max_attempts)
       VALUES (?, ?, ?, ?, ?)`
    ).run(task.id, "Exhausted lane", "ready", 2, 2);

    const ready = findReadySubtasks(db);
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].title, "Reviewer lane");
    assert.strictEqual(ready[0].description, "Needs reviewer");
    assert.strictEqual(ready[0].required_role, "reviewer");
    assert.strictEqual(ready[0].attempt_count, 0);
    assert.strictEqual(ready[0].max_attempts, 3);
    assert.deepStrictEqual(ready[0].acceptance_criteria, JSON.parse(criteria));
  });

  // ─────────────────────────────────────────────────────────────
  // countActiveAssignmentsByRole
  // ─────────────────────────────────────────────────────────────

  test("countActiveAssignmentsByRole joins with registry agents", () => {
    const db = setup();

    db.prepare("INSERT INTO projects (name, code, status) VALUES (?, ?, ?)").run("Test", "TST2", "active");
    const project = db.prepare("SELECT id FROM projects WHERE code = ?").get("TST2") as { id: number };

    db.prepare("INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)").run(project.id, "Task2", "in_progress");
    const task = db.prepare("SELECT id FROM tasks WHERE title = ?").get("Task2") as { id: number };

    const subStmt = db.prepare("INSERT INTO subtasks (task_id, title, status) VALUES (?, ?, ?)");
    subStmt.run(task.id, "Sub A", "backlog");
    subStmt.run(task.id, "Sub B", "backlog");
    const subA = db.prepare("SELECT id FROM subtasks WHERE title = ?").get("Sub A") as { id: number };
    const subB = db.prepare("SELECT id FROM subtasks WHERE title = ?").get("Sub B") as { id: number };

    const assignStmt = db.prepare(
      "INSERT INTO subtask_assignments (subtask_id, agent_id, status, assignment_type) VALUES (?, ?, ?, ?)"
    );
    assignStmt.run(subA.id, "agent-dev-1", "active", "worker");
    assignStmt.run(subB.id, "agent-dev-1", "active", "worker");
    assignStmt.run(subA.id, "agent-rev-1", "active", "reviewer");
    assignStmt.run(subA.id, "agent-dev-2", "completed", "coordinator"); // not active, should not count
    assignStmt.run(subA.id, "agent-dev-2", "active", "qa");

    // Create registry DB
    const registryDb = new DatabaseSync(registryPath);
    registryDb.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        registered_at TEXT DEFAULT (datetime('now')),
        last_seen_at TEXT DEFAULT (datetime('now'))
      );
    `);
    const regStmt = registryDb.prepare("INSERT INTO agents (agent_id, role) VALUES (?, ?)");
    regStmt.run("agent-dev-1", "dev");
    regStmt.run("agent-rev-1", "reviewer");
    regStmt.run("agent-dev-2", "dev");
    registryDb.close();

    const counts = countActiveAssignmentsByRole(db);

    // dev: agent-dev-1 (2) + agent-dev-2 (1) = 3
    // reviewer: agent-rev-1 (1) = 1
    assert.strictEqual(counts.length, 2);
    assert.strictEqual(counts[0].role, "dev");
    assert.strictEqual(counts[0].count, 3);
    assert.strictEqual(counts[1].role, "reviewer");
    assert.strictEqual(counts[1].count, 1);
  });

  test("countActiveAssignmentsByRole returns empty when no active assignments", () => {
    const db = setup();

    const registryDb = new DatabaseSync(registryPath);
    registryDb.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        role TEXT NOT NULL
      );
    `);
    registryDb.close();

    const counts = countActiveAssignmentsByRole(db);
    assert.deepStrictEqual(counts, []);
  });

  test("countActiveAssignmentsByRole ignores assignments with no matching agent in registry", () => {
    const db = setup();

    db.prepare("INSERT INTO projects (name, code, status) VALUES (?, ?, ?)").run("Test", "TST5", "active");
    const project = db.prepare("SELECT id FROM projects WHERE code = ?").get("TST5") as { id: number };

    db.prepare("INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)").run(project.id, "Task", "in_progress");
    const task = db.prepare("SELECT id FROM tasks WHERE title = ?").get("Task") as { id: number };

    const subStmt = db.prepare("INSERT INTO subtasks (task_id, title, status) VALUES (?, ?, ?)");
    subStmt.run(task.id, "Sub C", "backlog");
    const subC = db.prepare("SELECT id FROM subtasks WHERE title = ?").get("Sub C") as { id: number };

    db.prepare("INSERT INTO subtask_assignments (subtask_id, agent_id, status) VALUES (?, ?, ?)")
      .run(subC.id, "orphan-agent", "active");

    // Registry with only other agents
    const registryDb = new DatabaseSync(registryPath);
    registryDb.exec(`CREATE TABLE IF NOT EXISTS agents (agent_id TEXT PRIMARY KEY, role TEXT NOT NULL);`);
    registryDb.prepare("INSERT INTO agents (agent_id, role) VALUES (?, ?)").run("other-agent", "dev");
    registryDb.close();

    const counts = countActiveAssignmentsByRole(db);
    assert.deepStrictEqual(counts, []);
  });
});
