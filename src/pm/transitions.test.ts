import { test, describe } from "node:test";
import assert from "node:assert";
import { unlinkSync } from "node:fs";
import { initDb } from "./db.js";
import { updateStatus } from "./transitions.js";
import { attachPR, markPRMerged } from "./attachments.js";

describe("transitions product model", () => {
  const dbPath = "/tmp/fabric-agents/test-transitions-product-model.db";

  function setup(): ReturnType<typeof initDb> {
    try { unlinkSync(dbPath); } catch { /* ignore if not exists */ }
    return initDb(dbPath);
  }

  test("task: draft → in_progress → completed requires pr_merged_at", () => {
    const db = setup();

    const projectStmt = db.prepare("INSERT INTO projects (name, code, status) VALUES (?, ?, ?)");
    projectStmt.run("Test Project", "TP-01", "active");
    const project = db.prepare("SELECT id FROM projects WHERE code = ?").get("TP-01") as { id: number };

    const taskStmt = db.prepare("INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)");
    taskStmt.run(project.id, "Test Task", "draft");
    const task = db.prepare("SELECT id FROM tasks WHERE title = ?").get("Test Task") as { id: number };

    // draft → in_progress
    const r1 = updateStatus(db, { entityType: "task", id: task.id, newState: "in_progress", actorType: "user" });
    assert.strictEqual(r1.previousState, "draft");
    assert.strictEqual(r1.newState, "in_progress");

    // in_progress → completed without pr_merged_at should throw
    assert.throws(
      () => updateStatus(db, { entityType: "task", id: task.id, newState: "completed", actorType: "agent", agentId: "orch" }),
      /Task cannot transition to 'completed': pr_merged_at is required/
    );

    // Attach and merge PR
    attachPR(db, task.id, "https://github.com/example/pull/1", 1);
    markPRMerged(db, task.id);

    // Now completed should succeed
    const r2 = updateStatus(db, { entityType: "task", id: task.id, newState: "completed", actorType: "agent", agentId: "orch" });
    assert.strictEqual(r2.newState, "completed");

    const after = db.prepare("SELECT status, completed_at FROM tasks WHERE id = ?").get(task.id) as { status: string; completed_at: string | null };
    assert.strictEqual(after.status, "completed");
    assert.ok(after.completed_at, "completed_at should be set");
  });

  test("task: cannot transition from terminal state", () => {
    const db = setup();

    const projectStmt = db.prepare("INSERT INTO projects (name, code, status) VALUES (?, ?, ?)");
    projectStmt.run("Test Project", "TP-02", "active");
    const project = db.prepare("SELECT id FROM projects WHERE code = ?").get("TP-02") as { id: number };

    const taskStmt = db.prepare("INSERT INTO tasks (project_id, title, status, pr_merged_at) VALUES (?, ?, ?, datetime('now'))");
    taskStmt.run(project.id, "Test Task 2", "completed");
    const task = db.prepare("SELECT id FROM tasks WHERE title = ?").get("Test Task 2") as { id: number };

    assert.throws(
      () => updateStatus(db, { entityType: "task", id: task.id, newState: "failed", actorType: "system" }),
      /Cannot transition from terminal state: completed/
    );
  });

  test("subtask: backlog → running → validating → done", () => {
    const db = setup();

    const projectStmt = db.prepare("INSERT INTO projects (name, code, status) VALUES (?, ?, ?)");
    projectStmt.run("Test Project", "TP-03", "active");
    const project = db.prepare("SELECT id FROM projects WHERE code = ?").get("TP-03") as { id: number };

    const taskStmt = db.prepare("INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)");
    taskStmt.run(project.id, "Parent Task", "in_progress");
    const task = db.prepare("SELECT id FROM tasks WHERE title = ?").get("Parent Task") as { id: number };

    const subStmt = db.prepare("INSERT INTO subtasks (task_id, title, status) VALUES (?, ?, ?)");
    subStmt.run(task.id, "Subtask", "backlog");
    const subtask = db.prepare("SELECT id FROM subtasks WHERE title = ?").get("Subtask") as { id: number };

    const r1 = updateStatus(db, { entityType: "subtask", id: subtask.id, newState: "running", actorType: "agent", agentId: "w1" });
    assert.strictEqual(r1.newState, "running");

    const r2 = updateStatus(db, { entityType: "subtask", id: subtask.id, newState: "validating", actorType: "agent", agentId: "w1" });
    assert.strictEqual(r2.newState, "validating");

    const r3 = updateStatus(db, { entityType: "subtask", id: subtask.id, newState: "done", actorType: "agent", agentId: "qa1" });
    assert.strictEqual(r3.newState, "done");

    const after = db.prepare("SELECT status, completed_at FROM subtasks WHERE id = ?").get(subtask.id) as { status: string; completed_at: string | null };
    assert.strictEqual(after.status, "done");
    assert.ok(after.completed_at, "completed_at should be set");
  });

  test("subtask: cannot transition from terminal state", () => {
    const db = setup();

    const projectStmt = db.prepare("INSERT INTO projects (name, code, status) VALUES (?, ?, ?)");
    projectStmt.run("Test Project", "TP-04", "active");
    const project = db.prepare("SELECT id FROM projects WHERE code = ?").get("TP-04") as { id: number };

    const taskStmt = db.prepare("INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)");
    taskStmt.run(project.id, "Parent Task", "in_progress");
    const task = db.prepare("SELECT id FROM tasks WHERE title = ?").get("Parent Task") as { id: number };

    const subStmt = db.prepare("INSERT INTO subtasks (task_id, title, status, completed_at) VALUES (?, ?, ?, datetime('now'))");
    subStmt.run(task.id, "Subtask", "done");
    const subtask = db.prepare("SELECT id FROM subtasks WHERE title = ?").get("Subtask") as { id: number };

    assert.throws(
      () => updateStatus(db, { entityType: "subtask", id: subtask.id, newState: "failed", actorType: "system" }),
      /Cannot transition from terminal state: done/
    );
  });

  test("project: active → completed", () => {
    const db = setup();

    const projectStmt = db.prepare("INSERT INTO projects (name, code, status) VALUES (?, ?, ?)");
    projectStmt.run("Test Project", "TP-05", "active");
    const project = db.prepare("SELECT id FROM projects WHERE code = ?").get("TP-05") as { id: number };

    const r = updateStatus(db, { entityType: "project", id: project.id, newState: "completed", actorType: "user" });
    assert.strictEqual(r.newState, "completed");
  });
});
