import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "./db.js";
import { setTaskPr } from "./task-admin.js";
import { updateStatus } from "./transitions.js";
import { cleanupTask } from "./cleanup.js";

test("setTaskPr updates task PR metadata and records an audit event", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "cmd-center-task-admin-")), "projects.sqlite");
  const db = initDb(dbPath);

  try {
    const project = db.prepare("INSERT INTO projects (name, status) VALUES (?, ?)").run("Test Project", "active");
    const projectId = Number(project.lastInsertRowid);
    const taskInsert = db.prepare(
      `INSERT INTO tasks (project_id, title, status, sequence_order)
       VALUES (?, ?, ?, ?)`
    ).run(projectId, "Test Task", "in_progress", 1);
    const taskId = Number(taskInsert.lastInsertRowid);

    const result = setTaskPr(db, {
      taskId,
      prUrl: "https://github.com/example/repo/pull/123",
      prNumber: 123,
      prMergedAt: "2026-05-08T12:00:00.000Z",
      actorType: "agent",
      actorId: "boss",
      agentId: "boss",
      reason: "closeout ready",
    });

    assert.equal(result.before.pr_url, null);
    assert.equal(result.after.pr_number, 123);
    assert.equal(result.after.pr_merged_at, "2026-05-08T12:00:00.000Z");

    const event = db.prepare(
      `SELECT entity_type, entity_id, actor_type, actor_id, previous_state, new_state, reason, agent_id, payload
       FROM event_log WHERE entity_type = 'task' AND entity_id = ? ORDER BY id DESC LIMIT 1`
    ).get(taskId) as Record<string, unknown>;

    assert.equal(event.actor_type, "agent");
    assert.equal(event.actor_id, "boss");
    assert.equal(event.reason, "closeout ready");
    assert.equal(event.agent_id, "boss");
    assert.match(String(event.payload), /pr_merged_at/);
  } finally {
    db.close();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

test("task closeout becomes deterministic after setting PR info then completing then cleanup", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "cmd-center-task-admin-")), "projects.sqlite");
  const db = initDb(dbPath);

  try {
    const project = db.prepare("INSERT INTO projects (name, status) VALUES (?, ?)").run("Test Project", "active");
    const projectId = Number(project.lastInsertRowid);
    const taskInsert = db.prepare(
      `INSERT INTO tasks (project_id, title, status, sequence_order, worktree_status, worktree_path, branch_name, tmux_session, tmux_pane)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(projectId, "Closeout Task", "in_progress", 1, "active", "/tmp/worktree", "branch-1", "session-1", "%1");
    const taskId = Number(taskInsert.lastInsertRowid);

    assert.throws(() => {
      updateStatus(db, {
        entityType: "task",
        id: taskId,
        newState: "completed",
        actorType: "agent",
        actorId: "boss",
        agentId: "boss",
        reason: "should fail before PR merge",
      });
    }, /pr_merged_at is required/);

    setTaskPr(db, {
      taskId,
      prUrl: "https://github.com/example/repo/pull/124",
      prNumber: 124,
      prMergedAt: "2026-05-08T12:05:00.000Z",
      actorType: "agent",
      actorId: "boss",
      agentId: "boss",
      reason: "ready for completion",
    });

    const completion = updateStatus(db, {
      entityType: "task",
      id: taskId,
      newState: "completed",
      actorType: "agent",
      actorId: "boss",
      agentId: "boss",
      reason: "merged and completed",
    });
    assert.equal(completion.newState, "completed");

    const cleanup = cleanupTask(db, taskId, "agent", "boss", "cleanup terminal task");
    assert.equal(cleanup.newState, "cleaned");

    const task = db.prepare(
      `SELECT status, worktree_status, worktree_path, branch_name, tmux_session, tmux_pane
       FROM tasks WHERE id = ?`
    ).get(taskId) as Record<string, unknown>;
    assert.equal(task.status, "completed");
    assert.equal(task.worktree_status, "deleted");
    assert.equal(task.worktree_path, null);
    assert.equal(task.branch_name, null);
    assert.equal(task.tmux_session, null);
    assert.equal(task.tmux_pane, null);
  } finally {
    db.close();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});
