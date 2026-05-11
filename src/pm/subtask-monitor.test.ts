import { describe, test, beforeEach, after } from "node:test";
import assert from "node:assert";
import {
  readFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  runMonitorLoop,
  stopMonitorLoop,
  getMonitorState,
  resetMonitorState,
  processCompletedSubtasks,
} from "./subtask-monitor.js";
import { initDb } from "./db.js";
import type { ReadySubtask, RoleCount } from "./subtask-queries.js";

// ─── Test config ───
const testLogPath = "/tmp/fabric-agents/test-subtask-monitor.log";
const testDbPath = "/tmp/fabric-agents/test-subtask-monitor-projects.db";
const testMailboxPath = "/tmp/fabric-agents/mailboxes/boss.jsonl";
const testOffsetPath = "/tmp/fabric-agents/state/monitor-boss-offset.json";

process.env.SUBTASK_MONITOR_INTERVAL_MS = "100000"; // long interval so ticks don't overlap
process.env.SUBTASK_MONITOR_LOG_PATH = testLogPath;
process.env.PROJECTS_DB_PATH = testDbPath;

function cleanup(): void {
  for (const p of [testLogPath, testDbPath, testMailboxPath, testOffsetPath]) {
    try {
      unlinkSync(p);
    } catch {
      /* ignore missing */
    }
  }
}

function readLogs(): string {
  if (!existsSync(testLogPath)) return "";
  return readFileSync(testLogPath, "utf8");
}

function buildDeps(
  overrides: Partial<{
    findReadySubtasks: () => ReadySubtask[];
    countActiveAssignmentsByRole: () => RoleCount[];
    launchWorker: (
      subtask: any,
      coordinatorId: string
    ) => Promise<string>;
    assignSubtask: (
      db: any,
      subtaskId: number,
      agentId: string,
      role: string
    ) => void;
    handleLaunchError: (db: any, subtaskId: number, error: string) => void;
  }>
) {
  return {
    findReadySubtasks: () => [] as ReadySubtask[],
    countActiveAssignmentsByRole: () => [] as RoleCount[],
    launchWorker: async (_subtask: any, _coordinatorId: string) => "agent-1",
    assignSubtask: (_db: any, _subtaskId: number, _agentId: string, _role: string) => {
      /* no-op */
    },
    handleLaunchError: (_db: any, _subtaskId: number, _error: string) => {
      /* no-op */
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe("subtask-monitor", () => {
  beforeEach(() => {
    cleanup();
    resetMonitorState();
    // Ensure DB schema exists (event_log, subtasks, etc.) so tick() can insert
    const db = initDb(testDbPath);
    db.close();
  });

  after(() => {
    stopMonitorLoop();
    cleanup();
  });

  // ─────────────────────────────────────────────────────────
  test("throws if loop is already running", () => {
    const deps = buildDeps({});
    runMonitorLoop("boss", deps);
    assert.throws(() => runMonitorLoop("boss", deps), /already running/);
    stopMonitorLoop();
  });

  // ─────────────────────────────────────────────────────────
  test("iterates, launches workers, and assigns subtasks", async () => {
    cleanup();
    let launched = false;
    let assigned = false;

    const deps = buildDeps({
      findReadySubtasks: () => [
        {
          id: 1,
          title: "Sub A",
          task_id: 10,
          priority: 1,
          sequence_order: 1,
        },
      ],
      countActiveAssignmentsByRole: () => [{ role: "dev", count: 0 }],
      launchWorker: async (_subtask, _coordinatorId) => {
        launched = true;
        return "agent-1";
      },
      assignSubtask: (_db, subtaskId, agentId, role) => {
        assigned = true;
        assert.strictEqual(subtaskId, 1);
        assert.strictEqual(agentId, "agent-1");
        assert.strictEqual(role, "dev");
      },
      handleLaunchError: () => {
        assert.fail("should not call handleLaunchError on success");
      },
    });

    runMonitorLoop("boss", deps);
    // give async tick time to finish
    await new Promise((r) => setTimeout(r, 100));
    stopMonitorLoop();

    assert.strictEqual(launched, true);
    assert.strictEqual(assigned, true);

    const logs = readLogs();
    assert.ok(logs.includes("[MONITOR] iteration 1"));
    assert.ok(logs.includes("[LAUNCH] subtask 1 -> agent agent-1 (dev)"));
  });

  // ─────────────────────────────────────────────────────────
  test("calls sendTaskContract after launchWorker and before assignSubtask", async () => {
    cleanup();
    const workerMailbox = "/tmp/fabric-agents/mailboxes/worker-test-1.jsonl";
    try { unlinkSync(workerMailbox); } catch { /* ignore */ }
    mkdirSync("/tmp/fabric-agents/mailboxes", { recursive: true });

    let assignCalled = false;

    const deps = buildDeps({
      findReadySubtasks: () => [
        {
          id: 1,
          title: "Sub A",
          description: "Desc A",
          task_id: 10,
          priority: 1,
          sequence_order: 1,
        },
      ],
      countActiveAssignmentsByRole: () => [{ role: "dev", count: 0 }],
      launchWorker: async () => "worker-test-1",
      assignSubtask: (_db, subtaskId, agentId, role) => {
        assignCalled = true;
        // By the time assignSubtask runs, sendTaskContract must have
        // already written the contract to the worker mailbox.
        assert.ok(
          existsSync(workerMailbox),
          "worker mailbox should exist before assignSubtask"
        );
        const lines = readFileSync(workerMailbox, "utf8")
          .trim()
          .split("\n");
        assert.strictEqual(lines.length, 1);
        const msg = JSON.parse(lines[0]);
        assert.strictEqual(msg.type, "contract");
        assert.strictEqual(msg.to, "worker-test-1");
        assert.strictEqual(msg.from, "boss");
        assert.strictEqual(msg.payload.task_id, "subtask-1");
        assert.ok(msg.payload.description.includes("Sub A"));
        assert.strictEqual(msg.payload.report_to_when_done, "boss");
        assert.deepStrictEqual(msg.payload.files, []);
        assert.strictEqual(subtaskId, 1);
        assert.strictEqual(agentId, "worker-test-1");
        assert.strictEqual(role, "dev");
      },
      handleLaunchError: () => {
        assert.fail("should not call handleLaunchError on success");
      },
    });

    runMonitorLoop("boss", deps);
    await new Promise((r) => setTimeout(r, 100));
    stopMonitorLoop();

    assert.strictEqual(assignCalled, true);
  });

  // ─────────────────────────────────────────────────────────
  test("uses subtask required_role and explicit acceptance criteria in dispatched contract", async () => {
    cleanup();
    const workerMailbox = "/tmp/fabric-agents/mailboxes/reviewer-worker.jsonl";
    try { unlinkSync(workerMailbox); } catch { /* ignore */ }
    mkdirSync("/tmp/fabric-agents/mailboxes", { recursive: true });

    const deps = buildDeps({
      findReadySubtasks: () => [
        {
          id: 8,
          title: "Review Sub",
          description: "Validate merge safety",
          task_id: 99,
          priority: 3,
          sequence_order: 1,
          required_role: "reviewer",
          acceptance_criteria: [
            {
              id: "criterion-1",
              description: "Review checklist is applied",
              type: "manual",
              params: { instructions: "Inspect the patch" },
              required: true,
            },
          ],
          attempt_count: 0,
          max_attempts: 2,
        },
      ],
      countActiveAssignmentsByRole: () => [{ role: "reviewer", count: 0 }],
      launchWorker: async () => "reviewer-worker",
      assignSubtask: (_db, _subtaskId, _agentId, role) => {
        const lines = readFileSync(workerMailbox, "utf8").trim().split("\n");
        const msg = JSON.parse(lines[0]);
        assert.strictEqual(role, "reviewer");
        assert.strictEqual(msg.payload.acceptance_criteria[0].id, "criterion-1");
      },
    });

    runMonitorLoop("boss", deps);
    await new Promise((r) => setTimeout(r, 100));
    stopMonitorLoop();

    const logs = readLogs();
    assert.ok(logs.includes("[LAUNCH] subtask 8 -> agent reviewer-worker (reviewer)"));
  });

  // ─────────────────────────────────────────────────────────
  test("respects capacity limits and skips launch", async () => {
    cleanup();
    let launched = false;

    const deps = buildDeps({
      findReadySubtasks: () => [
        {
          id: 2,
          title: "Sub B",
          task_id: 10,
          priority: 1,
          sequence_order: 1,
        },
      ],
      countActiveAssignmentsByRole: () => [{ role: "dev", count: 3 }],
      launchWorker: async () => {
        launched = true;
        return "agent-x";
      },
    });

    runMonitorLoop("boss", deps);
    await new Promise((r) => setTimeout(r, 100));
    stopMonitorLoop();

    assert.strictEqual(launched, false);

    const logs = readLogs();
    assert.ok(logs.includes("[CAPACITY] role dev full (3/3)"));
  });

  // ─────────────────────────────────────────────────────────
  test("handles launchWorker failure and records error", async () => {
    cleanup();
    let errorHandled = false;

    const deps = buildDeps({
      findReadySubtasks: () => [
        {
          id: 3,
          title: "Sub C",
          task_id: 10,
          priority: 1,
          sequence_order: 1,
        },
      ],
      countActiveAssignmentsByRole: () => [{ role: "dev", count: 0 }],
      launchWorker: async () => {
        throw new Error("spawn EACCES");
      },
      assignSubtask: () => {
        assert.fail("should not assign on failure");
      },
      handleLaunchError: (_db, subtaskId, error) => {
        errorHandled = true;
        assert.strictEqual(subtaskId, 3);
        assert.ok(error.includes("spawn EACCES"));
      },
    });

    runMonitorLoop("boss", deps);
    await new Promise((r) => setTimeout(r, 100));
    stopMonitorLoop();

    assert.strictEqual(errorHandled, true);

    const logs = readLogs();
    assert.ok(
      logs.includes(
        "[ERROR] launchWorker failed for subtask 3: spawn EACCES"
      )
    );
  });

  // ─────────────────────────────────────────────────────────
  test("processes multiple ready subtasks respecting capacity", async () => {
    cleanup();
    const launched: Array<{ subtaskId: number; agentId: string }> = [];

    const deps = buildDeps({
      findReadySubtasks: () => [
        {
          id: 10,
          title: "Sub 10",
          task_id: 1,
          priority: 2,
          sequence_order: 1,
        },
        {
          id: 11,
          title: "Sub 11",
          task_id: 1,
          priority: 1,
          sequence_order: 2,
        },
        {
          id: 12,
          title: "Sub 12",
          task_id: 1,
          priority: 1,
          sequence_order: 3,
        },
      ],
      countActiveAssignmentsByRole: () => [{ role: "dev", count: 2 }], // 1 slot left
      launchWorker: async (subtask) => {
        launched.push({ subtaskId: subtask.id, agentId: `agent-${subtask.id}` });
        return `agent-${subtask.id}`;
      },
    });

    runMonitorLoop("boss", deps);
    await new Promise((r) => setTimeout(r, 100));
    stopMonitorLoop();

    // Only the first ready subtask should launch because capacity is 1 left
    assert.strictEqual(launched.length, 1);
    assert.strictEqual(launched[0].subtaskId, 10);

    const logs = readLogs();
    assert.ok(logs.includes("[LAUNCH] subtask 10 -> agent agent-10 (dev)"));
    assert.ok(logs.includes("[CAPACITY] role dev full (3/3)"));
  });

  // ─────────────────────────────────────────────────────────
  test("graceful shutdown via stopMonitorLoop", async () => {
    cleanup();
    const deps = buildDeps({
      findReadySubtasks: () => [],
    });

    runMonitorLoop("boss", deps);
    await new Promise((r) => setTimeout(r, 50));
    stopMonitorLoop();

    const state = getMonitorState();
    assert.strictEqual(state.running, false);
    assert.strictEqual(state.timer, null);
    assert.strictEqual(state.isTickRunning, false);
    assert.strictEqual(state.iteration, 1);
  });

  // ─────────────────────────────────────────────────────────
  test("handles findReadySubtasks exception gracefully", async () => {
    cleanup();

    const deps = buildDeps({
      findReadySubtasks: () => {
        throw new Error("DB locked");
      },
    });

    runMonitorLoop("boss", deps);
    await new Promise((r) => setTimeout(r, 100));
    stopMonitorLoop();

    const logs = readLogs();
    assert.ok(logs.includes("[ERROR] DB locked"));
    assert.ok(logs.includes("[MONITOR] iteration 1"));
  });

  // ─────────────────────────────────────────────────────────
  test("writes event_log and notifies coordinator mailbox on successful assignment", async () => {
    const deps = buildDeps({
      findReadySubtasks: () => [
        {
          id: 1,
          title: "Sub A",
          task_id: 10,
          priority: 1,
          sequence_order: 1,
        },
      ],
      countActiveAssignmentsByRole: () => [{ role: "dev", count: 0 }],
      launchWorker: async () => "agent-1",
      assignSubtask: () => {
        /* no-op */
      },
    });

    runMonitorLoop("boss", deps);
    await new Promise((r) => setTimeout(r, 100));
    stopMonitorLoop();

    // Verify event_log row
    const db = new DatabaseSync(testDbPath);
    const rows = db
      .prepare(
        `SELECT entity_type, entity_id, actor_type, actor_id, new_state, reason FROM event_log WHERE entity_type = 'subtask'`
      )
      .all() as Array<Record<string, any>>;
    db.close();

    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].entity_type, "subtask");
    assert.strictEqual(rows[0].entity_id, 1);
    assert.strictEqual(rows[0].actor_type, "system");
    assert.strictEqual(rows[0].actor_id, "subtask-monitor");
    assert.strictEqual(rows[0].new_state, "running");
    assert.ok(rows[0].reason.includes("Auto-assigned by subtask-monitor"));

    // Verify mailbox notification
    assert.ok(existsSync(testMailboxPath));
    const mailboxLines = readFileSync(testMailboxPath, "utf8")
      .trim()
      .split("\n");
    assert.strictEqual(mailboxLines.length, 1);
    const notification = JSON.parse(mailboxLines[0]);
    assert.strictEqual(notification.type, "notification");
    assert.strictEqual(notification.payload.event, "subtask.assigned");
    assert.strictEqual(notification.payload.subtask_id, 1);
    assert.strictEqual(notification.payload.agent_id, "agent-1");
    assert.strictEqual(notification.payload.role, "dev");
  });

  // ─────────────────────────────────────────────────────────
  test("processCompletedSubtasks marks subtasks done from mailbox responses", () => {
    const db = new DatabaseSync(testDbPath);

    // Seed minimal data
    const project = db
      .prepare(`INSERT INTO projects (name, status) VALUES (?, ?)`)
      .run("Test Project", "planned");
    const projectId = Number(project.lastInsertRowid);
    const task = db
      .prepare(
        `INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)`
      )
      .run(projectId, "Test Task", "in_progress");
    const taskId = Number(task.lastInsertRowid);
    const subtask = db
      .prepare(
        `INSERT INTO subtasks (task_id, title, status) VALUES (?, ?, ?)`
      )
      .run(taskId, "Test Subtask", "running");
    const subtaskId = Number(subtask.lastInsertRowid);
    db.prepare(
      `INSERT INTO subtask_assignments (subtask_id, agent_id, status) VALUES (?, ?, ?)`
    ).run(subtaskId, "agent-99", "active");

    // Write a completion message to the coordinator mailbox
    mkdirSync("/tmp/fabric-agents/mailboxes", { recursive: true });
    const completionLine =
      JSON.stringify({
        type: "completion",
        payload: { subtask_id: subtaskId, agent_id: "agent-99" },
      }) + "\n";
    writeFileSync(testMailboxPath, completionLine);

    processCompletedSubtasks(db, "boss");

    const st = db
      .prepare(`SELECT status, completed_at FROM subtasks WHERE id = ?`)
      .get(subtaskId) as Record<string, any>;
    assert.strictEqual(st.status, "done");
    assert.ok(st.completed_at);

    const sa = db
      .prepare(
        `SELECT status, completed_at FROM subtask_assignments WHERE subtask_id = ?`
      )
      .get(subtaskId) as Record<string, any>;
    assert.strictEqual(sa.status, "completed");
    assert.ok(sa.completed_at);

    // Verify offset was advanced
    const offsetRaw = readFileSync(testOffsetPath, "utf8");
    const offsetState = JSON.parse(offsetRaw);
    assert.strictEqual(offsetState.offset, completionLine.length);

    db.close();
  });

  // ─────────────────────────────────────────────────────────
  test("processCompletedSubtasks handles fabric_report_completion payloads via task_id and reporter_agent_id", () => {
    const db = new DatabaseSync(testDbPath);

    const project = db
      .prepare(`INSERT INTO projects (name, status) VALUES (?, ?)`)
      .run("Test Project 2", "planned");
    const projectId = Number(project.lastInsertRowid);
    const task = db
      .prepare(
        `INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)`
      )
      .run(projectId, "Test Task 2", "in_progress");
    const taskId = Number(task.lastInsertRowid);
    const subtask = db
      .prepare(
        `INSERT INTO subtasks (task_id, title, status) VALUES (?, ?, ?)`
      )
      .run(taskId, "Test Subtask 2", "running");
    const subtaskId = Number(subtask.lastInsertRowid);
    db.prepare(
      `INSERT INTO subtask_assignments (subtask_id, agent_id, status) VALUES (?, ?, ?)`
    ).run(subtaskId, "agent-42", "active");

    mkdirSync("/tmp/fabric-agents/mailboxes", { recursive: true });
    const responseLine =
      JSON.stringify({
        type: "response",
        payload: {
          task_id: `subtask-${subtaskId}`,
          reporter_agent_id: "agent-42",
          status: "done",
          summary: "completed from report tool",
          verification_results: [],
        },
      }) + "\n";
    writeFileSync(testMailboxPath, responseLine);

    processCompletedSubtasks(db, "boss");

    const st = db
      .prepare(`SELECT status, result_summary FROM subtasks WHERE id = ?`)
      .get(subtaskId) as Record<string, any>;
    assert.strictEqual(st.status, "done");
    assert.strictEqual(st.result_summary, "completed from report tool");

    const sa = db
      .prepare(
        `SELECT status, result_summary FROM subtask_assignments WHERE subtask_id = ?`
      )
      .get(subtaskId) as Record<string, any>;
    assert.strictEqual(sa.status, "completed");
    assert.strictEqual(sa.result_summary, "completed from report tool");

    db.close();
  });

  // ─────────────────────────────────────────────────────────
  test("processCompletedSubtasks requeues failed subtasks when retry budget remains", () => {
    const db = new DatabaseSync(testDbPath);

    const project = db
      .prepare(`INSERT INTO projects (name, status) VALUES (?, ?)`)
      .run("Test Project Retry", "planned");
    const projectId = Number(project.lastInsertRowid);
    const task = db
      .prepare(`INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)`)
      .run(projectId, "Retry Task", "in_progress");
    const taskId = Number(task.lastInsertRowid);
    const subtask = db
      .prepare(`INSERT INTO subtasks (task_id, title, status, attempt_count, max_attempts, worker_agent_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(taskId, "Retry Subtask", "running", 1, 2, "agent-43");
    const subtaskId = Number(subtask.lastInsertRowid);
    db.prepare(`INSERT INTO subtask_assignments (subtask_id, agent_id, status) VALUES (?, ?, ?)`)
      .run(subtaskId, "agent-43", "active");

    mkdirSync("/tmp/fabric-agents/mailboxes", { recursive: true });
    const failureLine =
      JSON.stringify({
        type: "response",
        payload: {
          task_id: `subtask-${subtaskId}`,
          reporter_agent_id: "agent-43",
          status: "failed",
          summary: "tests failed",
          verification_results: [{ criterion_id: "c1", passed: false, actual: "boom", expected: "ok", required: true }],
        },
      }) + "\n";
    writeFileSync(testMailboxPath, failureLine);

    processCompletedSubtasks(db, "boss");

    const st = db
      .prepare(`SELECT status, worker_agent_id, result_summary, last_error, completed_at FROM subtasks WHERE id = ?`)
      .get(subtaskId) as Record<string, any>;
    assert.strictEqual(st.status, "ready");
    assert.strictEqual(st.worker_agent_id, null);
    assert.strictEqual(st.result_summary, "tests failed");
    assert.strictEqual(st.last_error, "tests failed");
    assert.strictEqual(st.completed_at, null);

    const sa = db
      .prepare(`SELECT status, completed_at, result_summary FROM subtask_assignments WHERE subtask_id = ?`)
      .get(subtaskId) as Record<string, any>;
    assert.strictEqual(sa.status, "failed");
    assert.ok(sa.completed_at);
    assert.strictEqual(sa.result_summary, "tests failed");

    const event = db
      .prepare(`SELECT new_state, reason, payload FROM event_log WHERE entity_type = 'subtask' AND entity_id = ? ORDER BY id DESC LIMIT 1`)
      .get(subtaskId) as Record<string, any>;
    assert.strictEqual(event.new_state, "ready");
    assert.ok((event.reason || "").includes("tests failed"));
    assert.ok((event.payload || "").includes("retry_queued"));

    db.close();
  });

  // ─────────────────────────────────────────────────────────
  test("processCompletedSubtasks marks failed after retry budget is exhausted", () => {
    const db = new DatabaseSync(testDbPath);

    const project = db
      .prepare(`INSERT INTO projects (name, status) VALUES (?, ?)`)
      .run("Test Project Exhausted", "planned");
    const projectId = Number(project.lastInsertRowid);
    const task = db
      .prepare(`INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)`)
      .run(projectId, "Exhausted Task", "in_progress");
    const taskId = Number(task.lastInsertRowid);
    const subtask = db
      .prepare(`INSERT INTO subtasks (task_id, title, status, attempt_count, max_attempts, worker_agent_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(taskId, "Exhausted Subtask", "running", 2, 2, "agent-44");
    const subtaskId = Number(subtask.lastInsertRowid);
    db.prepare(`INSERT INTO subtask_assignments (subtask_id, agent_id, status) VALUES (?, ?, ?)`)
      .run(subtaskId, "agent-44", "active");

    mkdirSync("/tmp/fabric-agents/mailboxes", { recursive: true });
    const failureLine =
      JSON.stringify({
        type: "response",
        payload: {
          task_id: `subtask-${subtaskId}`,
          reporter_agent_id: "agent-44",
          status: "failed",
          summary: "retry budget exhausted",
          verification_results: [],
        },
      }) + "\n";
    writeFileSync(testMailboxPath, failureLine);

    processCompletedSubtasks(db, "boss");

    const st = db
      .prepare(`SELECT status, result_summary, last_error, completed_at FROM subtasks WHERE id = ?`)
      .get(subtaskId) as Record<string, any>;
    assert.strictEqual(st.status, "failed");
    assert.strictEqual(st.result_summary, "retry budget exhausted");
    assert.strictEqual(st.last_error, "retry budget exhausted");
    assert.ok(st.completed_at);

    const sa = db
      .prepare(`SELECT status, result_summary FROM subtask_assignments WHERE subtask_id = ?`)
      .get(subtaskId) as Record<string, any>;
    assert.strictEqual(sa.status, "failed");
    assert.strictEqual(sa.result_summary, "retry budget exhausted");

    db.close();
  });

  // ─────────────────────────────────────────────────────────
  test("processCompletedSubtasks skips malformed lines and advances offset", () => {
    const db = new DatabaseSync(testDbPath);

    const project = db
      .prepare(`INSERT INTO projects (name, status) VALUES (?, ?)`)
      .run("Test Project 3", "planned");
    const projectId = Number(project.lastInsertRowid);
    const task = db
      .prepare(
        `INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)`
      )
      .run(projectId, "Test Task 3", "in_progress");
    const taskId = Number(task.lastInsertRowid);
    const subtask = db
      .prepare(
        `INSERT INTO subtasks (task_id, title, status) VALUES (?, ?, ?)`
      )
      .run(taskId, "Test Subtask 3", "running");
    const subtaskId = Number(subtask.lastInsertRowid);
    db.prepare(
      `INSERT INTO subtask_assignments (subtask_id, agent_id, status) VALUES (?, ?, ?)`
    ).run(subtaskId, "agent-77", "active");

    mkdirSync("/tmp/fabric-agents/mailboxes", { recursive: true });
    const malformedLine = "this-is-not-json\n";
    const goodLine =
      JSON.stringify({
        type: "completion",
        payload: { subtask_id: subtaskId, agent_id: "agent-77" },
      }) + "\n";
    writeFileSync(testMailboxPath, malformedLine + goodLine);

    processCompletedSubtasks(db, "boss");

    const st = db
      .prepare(`SELECT status FROM subtasks WHERE id = ?`)
      .get(subtaskId) as Record<string, any>;
    assert.strictEqual(st.status, "done");

    const sa = db
      .prepare(
        `SELECT status FROM subtask_assignments WHERE subtask_id = ?`
      )
      .get(subtaskId) as Record<string, any>;
    assert.strictEqual(sa.status, "completed");

    const totalRaw = readFileSync(testMailboxPath, "utf8");
    const offsetRaw = readFileSync(testOffsetPath, "utf8");
    const offsetState = JSON.parse(offsetRaw);
    assert.strictEqual(offsetState.offset, totalRaw.length);

    db.close();
  });

  // ─────────────────────────────────────────────────────────
  test("processCompletedSubtasks does nothing when mailbox is missing", () => {
    cleanup();
    const db = new DatabaseSync(testDbPath);
    // No mailbox written
    processCompletedSubtasks(db, "boss");
    assert.ok(!existsSync(testOffsetPath));
    db.close();
  });

  // ─────────────────────────────────────────────────────────
  test("processCompletedSubtasks does nothing when offset already at end", () => {
    cleanup();
    const db = new DatabaseSync(testDbPath);

    mkdirSync("/tmp/fabric-agents/mailboxes", { recursive: true });
    writeFileSync(testMailboxPath, "some-line\n");

    // Pre-seed offset equal to file length
    mkdirSync("/tmp/fabric-agents/state", { recursive: true });
    writeFileSync(
      testOffsetPath,
      JSON.stringify({ offset: readFileSync(testMailboxPath, "utf8").length })
    );

    processCompletedSubtasks(db, "boss");
    // Should not throw
    db.close();
  });
});
