import { describe, test, before, mock } from "node:test";
import assert from "node:assert";
import {
  unlinkSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initDb } from "./db.js";
import {
  launchWorker,
  waitForWorkerAck,
  assignSubtask,
  handleLaunchError,
  sendTaskContract,
  type SubtaskLaunchInput,
} from "./subtask-launcher.js";

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const testFabricDir = "/tmp/fabric-agents/test-subtask-launcher";
const testDbPath = join(testFabricDir, "projects.sqlite");
const testRegistryPath = join(testFabricDir, "registry.sqlite");

function setupPmDb(): DatabaseSync {
  try { unlinkSync(testDbPath); } catch { /* ignore */ }
  mkdirSync(testFabricDir, { recursive: true });
  return initDb(testDbPath);
}

function setupRegistryDb(): void {
  mkdirSync(testFabricDir, { recursive: true });
  try { unlinkSync(testRegistryPath); } catch { /* ignore */ }
  const db = new DatabaseSync(testRegistryPath);
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

function cleanup(): void {
  try { rmSync(testFabricDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Redirect Fabric dir to our test sandbox before importing the module under
// test.  Because subtask-launcher reads FABRIC_DIR lazily via getRegistryDbPath(),
// setting the env var here is sufficient.
process.env.FABRIC_DIR = testFabricDir;

// ─────────────────────────────────────────────────────────────
// Tests: waitForWorkerAck
// ─────────────────────────────────────────────────────────────

describe("waitForWorkerAck", () => {
  const coordinatorMailbox = join(testFabricDir, "mailboxes", "boss.jsonl");

  before(() => {
    cleanup();
    mkdirSync(join(testFabricDir, "mailboxes"), { recursive: true });
    writeFileSync(coordinatorMailbox, "", { flag: "a" });
  });

  test("returns agentId when coordinator mailbox receives alive healthcheck", async () => {
    const agentId = "agent-idle-1";
    writeFileSync(coordinatorMailbox, "", { flag: "w" });

    const promise = waitForWorkerAck(agentId, "boss", 3_000);
    setTimeout(() => {
      appendFileSync(coordinatorMailbox, JSON.stringify({
        from: agentId,
        to: "boss",
        type: "healthcheck",
        payload: { status: "alive" },
        timestamp: new Date().toISOString(),
      }) + "\n");
    }, 50);

    const result = await promise;
    assert.strictEqual(result, agentId);
  });

  test("returns null when no matching ACK arrives within timeout", async () => {
    writeFileSync(coordinatorMailbox, "", { flag: "w" });
    const result = await waitForWorkerAck("agent-missing-1", "boss", 500);
    assert.strictEqual(result, null);
  });

  test("ignores ACKs from other agents or wrong message type", async () => {
    writeFileSync(coordinatorMailbox, "", { flag: "w" });
    appendFileSync(coordinatorMailbox, JSON.stringify({
      from: "other-agent",
      to: "boss",
      type: "healthcheck",
      payload: { status: "alive" },
      timestamp: new Date().toISOString(),
    }) + "\n");
    appendFileSync(coordinatorMailbox, JSON.stringify({
      from: "agent-launching-1",
      to: "boss",
      type: "message",
      payload: { status: "alive" },
      timestamp: new Date().toISOString(),
    }) + "\n");

    const result = await waitForWorkerAck("agent-launching-1", "boss", 500);
    assert.strictEqual(result, null);
  });

  test("waits and eventually finds ACK appended later", async () => {
    const agentId = "agent-late-1";
    writeFileSync(coordinatorMailbox, "", { flag: "w" });

    const promise = waitForWorkerAck(agentId, "boss", 3_000);

    setTimeout(() => {
      appendFileSync(coordinatorMailbox, JSON.stringify({
        from: agentId,
        to: "boss",
        type: "healthcheck",
        payload: { status: "alive" },
        timestamp: new Date().toISOString(),
      }) + "\n");
    }, 300);

    const result = await promise;
    assert.strictEqual(result, agentId);
  });
});

// ─────────────────────────────────────────────────────────────
// Tests: assignSubtask
// ─────────────────────────────────────────────────────────────

describe("assignSubtask", () => {
  before(() => {
    cleanup();
  });

  test("updates subtask status and inserts assignment record", () => {
    const db = setupPmDb();

    // Seed project + task + subtask
    db.prepare(
      `INSERT INTO projects (name, code, status) VALUES (?, ?, ?)`
    ).run("Test", "TST", "active");
    const project = db
      .prepare(`SELECT id FROM projects WHERE code = ?`)
      .get("TST") as { id: number };

    db.prepare(
      `INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)`
    ).run(project.id, "Task", "in_progress");
    const task = db
      .prepare(`SELECT id FROM tasks WHERE title = ?`)
      .get("Task") as { id: number };

    db.prepare(
      `INSERT INTO subtasks (task_id, title, status) VALUES (?, ?, ?)`
    ).run(task.id, "Sub A", "backlog");
    const subtask = db
      .prepare(`SELECT id FROM subtasks WHERE title = ?`)
      .get("Sub A") as { id: number };

    assignSubtask(db, subtask.id, "worker-42", "dev");

    const row = db
      .prepare(`SELECT status, worker_agent_id FROM subtasks WHERE id = ?`)
      .get(subtask.id) as { status: string; worker_agent_id: string };
    assert.strictEqual(row.status, "running");
    assert.strictEqual(row.worker_agent_id, "worker-42");

    const assign = db
      .prepare(
        `SELECT agent_id, assignment_type, status FROM subtask_assignments WHERE subtask_id = ?`
      )
      .get(subtask.id) as {
      agent_id: string;
      assignment_type: string;
      status: string;
    };
    assert.strictEqual(assign.agent_id, "worker-42");
    assert.strictEqual(assign.assignment_type, "worker");
    assert.strictEqual(assign.status, "active");

    db.close();
    cleanup();
  });
});

// ─────────────────────────────────────────────────────────────
// Tests: handleLaunchError
// ─────────────────────────────────────────────────────────────

describe("handleLaunchError", () => {
  before(() => {
    cleanup();
  });

  test("updates subtask to failed with error summary", () => {
    const db = setupPmDb();

    db.prepare(
      `INSERT INTO projects (name, code, status) VALUES (?, ?, ?)`
    ).run("Test", "TST2", "active");
    const project = db
      .prepare(`SELECT id FROM projects WHERE code = ?`)
      .get("TST2") as { id: number };

    db.prepare(
      `INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)`
    ).run(project.id, "Task", "in_progress");
    const task = db
      .prepare(`SELECT id FROM tasks WHERE title = ?`)
      .get("Task") as { id: number };

    db.prepare(
      `INSERT INTO subtasks (task_id, title, status) VALUES (?, ?, ?)`
    ).run(task.id, "Sub B", "ready");
    const subtask = db
      .prepare(`SELECT id FROM subtasks WHERE title = ?`)
      .get("Sub B") as { id: number };

    handleLaunchError(db, subtask.id, "spawn EACCES");

    const row = db
      .prepare(`SELECT status, result_summary FROM subtasks WHERE id = ?`)
      .get(subtask.id) as { status: string; result_summary: string };
    assert.strictEqual(row.status, "failed");
    assert.strictEqual(row.result_summary, "spawn EACCES");

    db.close();
    cleanup();
  });
});

// ─────────────────────────────────────────────────────────────
// Tests: sendTaskContract
// ─────────────────────────────────────────────────────────────

describe("sendTaskContract", () => {
  const testMailboxPath = join(testFabricDir, "mailboxes", "worker-1.jsonl");
  const testPidPath = join(testFabricDir, "pids", "worker-1.pid");

  before(() => {
    cleanup();
    mkdirSync(join(testFabricDir, "mailboxes"), { recursive: true });
    mkdirSync(join(testFabricDir, "pids"), { recursive: true });
    // Pre-clean mailbox so we start fresh
    try { unlinkSync(testMailboxPath); } catch { /* ignore */ }
  });

  test("appends a valid contract JSONL line to the mailbox", () => {
    const subtask: SubtaskLaunchInput = {
      id: 42,
      title: "Fix the thing",
      description: "Detailed description here",
    };

    sendTaskContract(testMailboxPath, subtask, "boss", "worker-1");

    const lines = readFileSync(testMailboxPath, "utf8")
      .trim()
      .split("\n");
    assert.strictEqual(lines.length, 1);

    const msg = JSON.parse(lines[0]);
    assert.strictEqual(msg.from, "boss");
    assert.strictEqual(msg.to, "worker-1");
    assert.strictEqual(msg.type, "contract");
    assert.ok(msg.message_id.startsWith("msg-"));
    assert.ok(msg.timestamp);
    assert.strictEqual(msg.payload.task_id, "subtask-42");
    assert.strictEqual(msg.payload.report_to, "boss");
    assert.strictEqual(msg.payload.report_to_when_done, "boss");
    assert.strictEqual(
      msg.payload.description,
      "Fix the thing\n\nDetailed description here"
    );
    assert.deepStrictEqual(msg.payload.files, []);
    assert.strictEqual(msg.payload.acceptance_criteria.length, 1);
    assert.strictEqual(msg.payload.acceptance_criteria[0].type, "manual");
    assert.strictEqual(msg.payload.acceptance_criteria[0].required, true);
  });

  test("preserves explicit acceptance criteria when provided", () => {
    const subtask: SubtaskLaunchInput = {
      id: 99,
      title: "Explicit criteria",
      acceptance_criteria: [
        {
          id: "c1",
          description: "README exists",
          type: "file_exists",
          params: { path: "README.md" },
          required: true,
        },
      ],
    };

    sendTaskContract(testMailboxPath, subtask, "boss", "worker-1");

    const lines = readFileSync(testMailboxPath, "utf8")
      .trim()
      .split("\n");
    const msg = JSON.parse(lines[1]);
    assert.deepStrictEqual(msg.payload.acceptance_criteria, subtask.acceptance_criteria);
  });

  test("uses title-only description when subtask.description is absent", () => {
    const subtask: SubtaskLaunchInput = { id: 7, title: "No details" };

    sendTaskContract(testMailboxPath, subtask, "coordinator-2", "worker-2");

    const lines = readFileSync(testMailboxPath, "utf8")
      .trim()
      .split("\n");
    assert.strictEqual(lines.length, 3); // appended to existing file

    const msg = JSON.parse(lines[2]);
    assert.strictEqual(msg.payload.description, "No details");
    assert.strictEqual(msg.payload.task_id, "subtask-7");
    assert.strictEqual(msg.from, "coordinator-2");
    assert.strictEqual(msg.to, "worker-2");
  });

  test("sends SIGUSR1 to the worker PID when pid file exists", () => {
    const killCalls: Array<{ pid: number; signal: string | number | undefined }> = [];
    const originalKill = process.kill;
    (process as any).kill = (pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal });
      return true;
    };

    try {
      writeFileSync(testPidPath, String(process.pid), "utf8");

      const subtask: SubtaskLaunchInput = { id: 99, title: "Signal test" };
      sendTaskContract(testMailboxPath, subtask, "boss", "worker-1");

      assert.strictEqual(killCalls.length, 1);
      assert.strictEqual(killCalls[0].pid, process.pid);
      assert.strictEqual(killCalls[0].signal, "SIGUSR1");
    } finally {
      (process as any).kill = originalKill;
    }
  });

  test("does not throw when pid file is missing", () => {
    const missingPidPath = join(testFabricDir, "pids", "ghost.pid");
    try { unlinkSync(missingPidPath); } catch { /* ignore */ }

    const mailboxForGhost = join(testFabricDir, "mailboxes", "ghost.jsonl");
    const subtask: SubtaskLaunchInput = { id: 123, title: "Ghost worker" };

    assert.doesNotThrow(() => {
      sendTaskContract(mailboxForGhost, subtask, "boss", "ghost");
    });
  });
});

// ─────────────────────────────────────────────────────────────
// Tests: launchWorker (sequential — manipulates PATH)
// ─────────────────────────────────────────────────────────────

function installFakeNpx(scriptBody: string): string {
  const binDir = join(testFabricDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const npxPath = join(binDir, "npx");
  writeFileSync(npxPath, scriptBody, { mode: 0o755 });
  return binDir;
}

describe("launchWorker", { concurrency: false }, () => {
  before(() => {
    cleanup();
    setupRegistryDb();
  });

  test("spawns launcher with correct args and resolves agentId on ACK", async () => {
    const npxArgsLog = join(testFabricDir, "npx-args.json");
    const originalPath = process.env.PATH || "";

    const fakeNpx = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
fs.writeFileSync("${npxArgsLog}", JSON.stringify(args));
const agentIdIndex = args.indexOf("--agent-id");
const agentId = agentIdIndex !== -1 ? args[agentIdIndex + 1] : "unknown";
const reportToIndex = args.indexOf("--report-to");
const reportTo = reportToIndex !== -1 ? args[reportToIndex + 1] : "boss";
const mailbox = path.join("${testFabricDir}", "mailboxes", reportTo + ".jsonl");
fs.mkdirSync(path.dirname(mailbox), { recursive: true });
fs.appendFileSync(mailbox, JSON.stringify({ from: agentId, to: reportTo, type: "healthcheck", payload: { status: "alive" }, timestamp: new Date().toISOString() }) + "\\n");
`;
    const binDir = installFakeNpx(fakeNpx);

    try {
      process.env.PATH = `${binDir}:${originalPath}`;

      const agentId = await launchWorker(
        { id: 1, title: "Fix bug", required_role: "dev" },
        "boss",
        "fern/gpt-5.3-codex"
      );

      const loggedArgs = JSON.parse(
        readFileSync(npxArgsLog, "utf8")
      ) as string[];

      const agentIdIndex = loggedArgs.indexOf("--agent-id");
      assert.strictEqual(agentIdIndex !== -1, true);
      assert.strictEqual(loggedArgs[agentIdIndex + 1], agentId);

      assert.deepStrictEqual(loggedArgs, [
        "tsx",
        "src/core/launcher.ts",
        "--role",
        "dev",
        "--agent-id",
        agentId,
        "--mode",
        "rpc",
        "--report-to",
        "boss",
        "--model",
        "fern/gpt-5.3-codex",
      ]);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("rejects when worker never ACKs (timeout)", async () => {
    const previousTimeout = process.env.SUBTASK_LAUNCH_TIMEOUT_MS;
    const originalPath = process.env.PATH || "";

    // Fake npx that does NOT send a mailbox ACK → wait will time out
    const fakeNpx = `#!/usr/bin/env node\n// no-op\n`;
    const binDir = installFakeNpx(fakeNpx);

    try {
      process.env.SUBTASK_LAUNCH_TIMEOUT_MS = "500";
      process.env.PATH = `${binDir}:${originalPath}`;

      const promise = launchWorker(
        { id: 2, title: "Crash test" },
        "boss"
      );
      await assert.rejects(promise, /did not send alive ACK within 500ms/);
    } finally {
      process.env.PATH = originalPath;
      process.env.SUBTASK_LAUNCH_TIMEOUT_MS = previousTimeout;
    }
  });

  test("defaults role to 'dev' when required_role is missing", async () => {
    const npxArgsLog = join(testFabricDir, "npx-args-2.json");
    const originalPath = process.env.PATH || "";

    const fakeNpx = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
fs.writeFileSync("${npxArgsLog}", JSON.stringify(args));
const agentIdIndex = args.indexOf("--agent-id");
const agentId = agentIdIndex !== -1 ? args[agentIdIndex + 1] : "unknown";
const reportToIndex = args.indexOf("--report-to");
const reportTo = reportToIndex !== -1 ? args[reportToIndex + 1] : "coordinator-1";
const mailbox = path.join("${testFabricDir}", "mailboxes", reportTo + ".jsonl");
fs.mkdirSync(path.dirname(mailbox), { recursive: true });
fs.appendFileSync(mailbox, JSON.stringify({ from: agentId, to: reportTo, type: "healthcheck", payload: { status: "alive" }, timestamp: new Date().toISOString() }) + "\\n");
`;
    const binDir = installFakeNpx(fakeNpx);

    try {
      process.env.PATH = `${binDir}:${originalPath}`;

      await launchWorker({ id: 3, title: "No role" }, "coordinator-1");

      const loggedArgs = JSON.parse(
        readFileSync(npxArgsLog, "utf8")
      ) as string[];
      const roleIndex = loggedArgs.indexOf("--role");
      assert.strictEqual(roleIndex !== -1, true);
      assert.strictEqual(loggedArgs[roleIndex + 1], "dev");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
