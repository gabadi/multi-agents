import { describe, test, beforeEach, after } from "node:test";
import assert from "node:assert";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  runMonitorLoop,
  stopMonitorLoop,
  resetMonitorState,
  processCompletedSubtasks,
} from "./subtask-monitor.js";
import { initDb } from "./db.js";
import { assignSubtask, handleLaunchError } from "./subtask-launcher.js";
import {
  findReadySubtasks,
  countActiveAssignmentsByRole,
} from "./subtask-queries.js";

// ─── Helpers ───

function setupRegistryDb(registryPath: string): void {
  mkdirSync(dirname(registryPath), { recursive: true });
  const db = new DatabaseSync(registryPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      pane_id TEXT,
      session TEXT,
      pid INTEGER,
      model TEXT,
      status TEXT DEFAULT 'launching',
      fabric_status TEXT DEFAULT 'idle',
      registered_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.close();
}

function saveEnv(): Record<string, string | undefined> {
  return {
    FABRIC_DIR: process.env.FABRIC_DIR,
    PROJECTS_DB_PATH: process.env.PROJECTS_DB_PATH,
    SUBTASK_MONITOR_LOG_PATH: process.env.SUBTASK_MONITOR_LOG_PATH,
    SUBTASK_MONITOR_INTERVAL_MS: process.env.SUBTASK_MONITOR_INTERVAL_MS,
    SUBTASK_MAX_CONCURRENT_DEV: process.env.SUBTASK_MAX_CONCURRENT_DEV,
  };
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete (process.env as any)[key];
    } else {
      (process.env as any)[key] = value;
    }
  }
}

function cleanupFabricDir(fabricDir: string): void {
  try {
    rmSync(fabricDir, { recursive: true, force: true });
  } catch {
    // ignore missing
  }
}

// ─── Test Suite ───

describe("e2e-subtask-monitor", () => {
  beforeEach(() => {
    stopMonitorLoop();
    resetMonitorState();
  });

  after(() => {
    stopMonitorLoop();
    resetMonitorState();
  });

  // ───────────────────────────────────────────────────────────
  // 1. Full E2E flow: deps → launch → completion → second launch
  // ───────────────────────────────────────────────────────────
  test("E2E flujo completo: deps, launch, completion, second tick launches blocked subtask", async () => {
    const saved = saveEnv();
    const fabricDir = `/tmp/fabric-agents/e2e-test-1-${Date.now()}`;
    const dbPath = join(fabricDir, "projects.sqlite");
    const registryPath = join(fabricDir, "registry.sqlite");

    process.env.FABRIC_DIR = fabricDir;
    process.env.PROJECTS_DB_PATH = dbPath;
    process.env.SUBTASK_MONITOR_LOG_PATH = join(fabricDir, "monitor.log");
    process.env.SUBTASK_MONITOR_INTERVAL_MS = "100000";

    mkdirSync(fabricDir, { recursive: true });
    mkdirSync(join(fabricDir, "mailboxes"), { recursive: true });

    const db = initDb(dbPath);
    setupRegistryDb(registryPath);

    // Seed project + task
    const project = db
      .prepare(`INSERT INTO projects (name, status) VALUES (?, ?)`)
      .run("E2E Project", "active");
    const projectId = Number(project.lastInsertRowid);
    const task = db
      .prepare(
        `INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)`
      )
      .run(projectId, "E2E Task", "in_progress");
    const taskId = Number(task.lastInsertRowid);

    // Subtasks A, B, C
    const aRow = db
      .prepare(
        `INSERT INTO subtasks (task_id, title, status) VALUES (?, ?, ?)`
      )
      .run(taskId, "Subtask A", "backlog");
    const aId = Number(aRow.lastInsertRowid);
    const bRow = db
      .prepare(
        `INSERT INTO subtasks (task_id, title, status) VALUES (?, ?, ?)`
      )
      .run(taskId, "Subtask B", "backlog");
    const bId = Number(bRow.lastInsertRowid);
    const cRow = db
      .prepare(
        `INSERT INTO subtasks (task_id, title, status) VALUES (?, ?, ?)`
      )
      .run(taskId, "Subtask C", "backlog");
    const cId = Number(cRow.lastInsertRowid);

    // B depends on A (blocking)
    db.prepare(
      `INSERT INTO subtask_dependencies (subtask_id, depends_on_subtask_id, dependency_type) VALUES (?, ?, ?)`
    ).run(bId, aId, "blocking");

    db.close();

    // Mock launchWorker: register fake agent in registry and return agentId
    const mockLaunchWorker = async (subtask: any, _coordinatorId: string) => {
      const agentId = `agent-subtask-${subtask.id}`;
      const rdb = new DatabaseSync(registryPath);
      rdb
        .prepare(
          `INSERT OR REPLACE INTO agents (agent_id, role, fabric_status) VALUES (?, ?, ?)`
        )
        .run(agentId, "dev", "idle");
      rdb.close();
      return agentId;
    };

    const deps = {
      findReadySubtasks: (db: DatabaseSync) => findReadySubtasks(db),
      countActiveAssignmentsByRole: (db: DatabaseSync) =>
        countActiveAssignmentsByRole(db),
      launchWorker: mockLaunchWorker,
      assignSubtask: (
        db: DatabaseSync,
        subtaskId: number,
        agentId: string,
        role: string
      ) => assignSubtask(db, subtaskId, agentId, role),
      handleLaunchError: (
        db: DatabaseSync,
        subtaskId: number,
        error: string
      ) => handleLaunchError(db, subtaskId, error),
    };

    resetMonitorState();

    // ── First tick ──
    runMonitorLoop("boss-test", deps);
    await new Promise((r) => setTimeout(r, 150));
    stopMonitorLoop();

    // Assert A and C are running with assignments
    const dbCheck1 = new DatabaseSync(dbPath);
    const aStatus = dbCheck1
      .prepare(`SELECT status, worker_agent_id FROM subtasks WHERE id = ?`)
      .get(aId) as { status: string; worker_agent_id: string };
    const cStatus = dbCheck1
      .prepare(`SELECT status, worker_agent_id FROM subtasks WHERE id = ?`)
      .get(cId) as { status: string; worker_agent_id: string };

    assert.strictEqual(aStatus.status, "running");
    assert.strictEqual(aStatus.worker_agent_id, `agent-subtask-${aId}`);
    assert.strictEqual(cStatus.status, "running");
    assert.strictEqual(cStatus.worker_agent_id, `agent-subtask-${cId}`);

    const aAssign = dbCheck1
      .prepare(
        `SELECT agent_id, status FROM subtask_assignments WHERE subtask_id = ?`
      )
      .get(aId) as { agent_id: string; status: string };
    const cAssign = dbCheck1
      .prepare(
        `SELECT agent_id, status FROM subtask_assignments WHERE subtask_id = ?`
      )
      .get(cId) as { agent_id: string; status: string };
    assert.strictEqual(aAssign.status, "active");
    assert.strictEqual(aAssign.agent_id, `agent-subtask-${aId}`);
    assert.strictEqual(cAssign.status, "active");
    assert.strictEqual(cAssign.agent_id, `agent-subtask-${cId}`);

    // Assert B remains blocked (backlog)
    const bStatus = dbCheck1
      .prepare(`SELECT status FROM subtasks WHERE id = ?`)
      .get(bId) as { status: string };
    assert.strictEqual(bStatus.status, "backlog");

    // Simulate A completion via mailbox
    const mailboxPath = join(fabricDir, "mailboxes", "boss-test.jsonl");
    const completionLine =
      JSON.stringify({
        type: "completion",
        payload: { subtask_id: aId, agent_id: `agent-subtask-${aId}` },
      }) + "\n";
    writeFileSync(mailboxPath, completionLine);

    // Process completion
    processCompletedSubtasks(dbCheck1, "boss-test");

    // Assert A is done and assignment completed
    const aDone = dbCheck1
      .prepare(`SELECT status, completed_at FROM subtasks WHERE id = ?`)
      .get(aId) as { status: string; completed_at: string | null };
    assert.strictEqual(aDone.status, "done");
    assert.ok(aDone.completed_at);

    const aAssignDone = dbCheck1
      .prepare(
        `SELECT status, completed_at FROM subtask_assignments WHERE subtask_id = ?`
      )
      .get(aId) as { status: string; completed_at: string | null };
    assert.strictEqual(aAssignDone.status, "completed");
    assert.ok(aAssignDone.completed_at);

    dbCheck1.close();

    // ── Second tick ──
    runMonitorLoop("boss-test", deps);
    await new Promise((r) => setTimeout(r, 150));
    stopMonitorLoop();

    // Assert B is now running
    const dbCheck2 = new DatabaseSync(dbPath);
    const bRunning = dbCheck2
      .prepare(`SELECT status, worker_agent_id FROM subtasks WHERE id = ?`)
      .get(bId) as { status: string; worker_agent_id: string };
    assert.strictEqual(bRunning.status, "running");
    assert.strictEqual(bRunning.worker_agent_id, `agent-subtask-${bId}`);

    dbCheck2.close();

    // Cleanup
    cleanupFabricDir(fabricDir);
    restoreEnv(saved);
  });

  // ───────────────────────────────────────────────────────────
  // 2. Capacity per role: max 2 dev concurrent
  // ───────────────────────────────────────────────────────────
  test("capacidad por rol: max 2 dev concurrentes, 4 ready subtasks", async () => {
    const saved = saveEnv();
    const fabricDir = `/tmp/fabric-agents/e2e-test-2-${Date.now()}`;
    const dbPath = join(fabricDir, "projects.sqlite");
    const registryPath = join(fabricDir, "registry.sqlite");

    process.env.FABRIC_DIR = fabricDir;
    process.env.PROJECTS_DB_PATH = dbPath;
    process.env.SUBTASK_MONITOR_LOG_PATH = join(fabricDir, "monitor.log");
    process.env.SUBTASK_MONITOR_INTERVAL_MS = "100000";
    process.env.SUBTASK_MAX_CONCURRENT_DEV = "2";

    mkdirSync(fabricDir, { recursive: true });
    mkdirSync(join(fabricDir, "mailboxes"), { recursive: true });

    const db = initDb(dbPath);
    setupRegistryDb(registryPath);

    const project = db
      .prepare(`INSERT INTO projects (name, status) VALUES (?, ?)`)
      .run("Cap Project", "active");
    const projectId = Number(project.lastInsertRowid);
    const task = db
      .prepare(
        `INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)`
      )
      .run(projectId, "Cap Task", "in_progress");
    const taskId = Number(task.lastInsertRowid);

    const subtaskIds: number[] = [];
    for (let i = 0; i < 4; i++) {
      const st = db
        .prepare(
          `INSERT INTO subtasks (task_id, title, status) VALUES (?, ?, ?)`
        )
        .run(taskId, `Sub ${i}`, "backlog");
      subtaskIds.push(Number(st.lastInsertRowid));
    }

    db.close();

    const mockLaunchWorker = async (subtask: any, _coordinatorId: string) => {
      const agentId = `agent-${subtask.id}`;
      const rdb = new DatabaseSync(registryPath);
      rdb
        .prepare(
          `INSERT OR REPLACE INTO agents (agent_id, role, fabric_status) VALUES (?, ?, ?)`
        )
        .run(agentId, "dev", "idle");
      rdb.close();
      return agentId;
    };

    const deps = {
      findReadySubtasks: (db: DatabaseSync) => findReadySubtasks(db),
      countActiveAssignmentsByRole: (db: DatabaseSync) =>
        countActiveAssignmentsByRole(db),
      launchWorker: mockLaunchWorker,
      assignSubtask,
      handleLaunchError,
    };

    resetMonitorState();

    runMonitorLoop("boss-test", deps);
    await new Promise((r) => setTimeout(r, 150));
    stopMonitorLoop();

    const dbCheck = new DatabaseSync(dbPath);

    // Assert only 2 subtasks launched
    let runningCount = 0;
    let readyCount = 0;
    for (const id of subtaskIds) {
      const row = dbCheck
        .prepare(`SELECT status FROM subtasks WHERE id = ?`)
        .get(id) as { status: string };
      if (row.status === "running") runningCount++;
      if (row.status === "backlog" || row.status === "ready") readyCount++;
    }
    assert.strictEqual(runningCount, 2);
    assert.strictEqual(readyCount, 2);

    // Verify countActiveAssignmentsByRole returns dev=2
    const counts = countActiveAssignmentsByRole(dbCheck);
    const devCount = counts.find((c) => c.role === "dev");
    assert.ok(devCount);
    assert.strictEqual(devCount.count, 2);

    dbCheck.close();
    cleanupFabricDir(fabricDir);
    restoreEnv(saved);
  });

  // ───────────────────────────────────────────────────────────
  // 3. Dependencies + rollback: A fails, B stays blocked
  // ───────────────────────────────────────────────────────────
  test("dependencias + rollback: A fails launch, B stays backlog", async () => {
    const saved = saveEnv();
    const fabricDir = `/tmp/fabric-agents/e2e-test-3-${Date.now()}`;
    const dbPath = join(fabricDir, "projects.sqlite");
    const registryPath = join(fabricDir, "registry.sqlite");

    process.env.FABRIC_DIR = fabricDir;
    process.env.PROJECTS_DB_PATH = dbPath;
    process.env.SUBTASK_MONITOR_LOG_PATH = join(fabricDir, "monitor.log");
    process.env.SUBTASK_MONITOR_INTERVAL_MS = "100000";

    mkdirSync(fabricDir, { recursive: true });
    mkdirSync(join(fabricDir, "mailboxes"), { recursive: true });

    const db = initDb(dbPath);
    setupRegistryDb(registryPath);

    const project = db
      .prepare(`INSERT INTO projects (name, status) VALUES (?, ?)`)
      .run("Rollback Project", "active");
    const projectId = Number(project.lastInsertRowid);
    const task = db
      .prepare(
        `INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)`
      )
      .run(projectId, "Rollback Task", "in_progress");
    const taskId = Number(task.lastInsertRowid);

    const aRow = db
      .prepare(
        `INSERT INTO subtasks (task_id, title, status) VALUES (?, ?, ?)`
      )
      .run(taskId, "Subtask A", "backlog");
    const aId = Number(aRow.lastInsertRowid);
    const bRow = db
      .prepare(
        `INSERT INTO subtasks (task_id, title, status) VALUES (?, ?, ?)`
      )
      .run(taskId, "Subtask B", "backlog");
    const bId = Number(bRow.lastInsertRowid);

    db.prepare(
      `INSERT INTO subtask_dependencies (subtask_id, depends_on_subtask_id, dependency_type) VALUES (?, ?, ?)`
    ).run(bId, aId, "blocking");

    db.close();

    const mockLaunchWorker = async (subtask: any, _coordinatorId: string) => {
      if (subtask.id === aId) {
        throw new Error("spawn EACCES");
      }
      const agentId = `agent-${subtask.id}`;
      const rdb = new DatabaseSync(registryPath);
      rdb
        .prepare(
          `INSERT OR REPLACE INTO agents (agent_id, role, fabric_status) VALUES (?, ?, ?)`
        )
        .run(agentId, "dev", "idle");
      rdb.close();
      return agentId;
    };

    const deps = {
      findReadySubtasks: (db: DatabaseSync) => findReadySubtasks(db),
      countActiveAssignmentsByRole: (db: DatabaseSync) =>
        countActiveAssignmentsByRole(db),
      launchWorker: mockLaunchWorker,
      assignSubtask,
      handleLaunchError,
    };

    resetMonitorState();

    runMonitorLoop("boss-test", deps);
    await new Promise((r) => setTimeout(r, 150));
    stopMonitorLoop();

    const dbCheck = new DatabaseSync(dbPath);

    // A should be failed
    const aStatus = dbCheck
      .prepare(`SELECT status, result_summary FROM subtasks WHERE id = ?`)
      .get(aId) as { status: string; result_summary: string };
    assert.strictEqual(aStatus.status, "failed");
    assert.ok(aStatus.result_summary.includes("spawn EACCES"));

    // B should remain backlog because A is not done
    const bStatus = dbCheck
      .prepare(`SELECT status FROM subtasks WHERE id = ?`)
      .get(bId) as { status: string };
    assert.strictEqual(bStatus.status, "backlog");

    dbCheck.close();
    cleanupFabricDir(fabricDir);
    restoreEnv(saved);
  });
});
