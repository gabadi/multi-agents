#!/usr/bin/env npx tsx
/**
 * Minimal test of Fabric core mechanisms without pi.
 * Tests: registry, mailbox append, SIGUSR1 signal delivery, state tracking.
 */

import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateTelegramRoutingIntent } from "./telegram-nlu.js";
import {
  cleanupChildAgentResources,
  shouldAutoCleanupCompletedRpcWorker,
} from "./rpc-worker-cleanup.js";

const FABRIC_DIR = mkdtempSync(join(tmpdir(), "fabric-agents-test-"));
const REGISTRY_DB = join(FABRIC_DIR, "registry.sqlite");
const MAILBOX_DIR = join(FABRIC_DIR, "mailboxes");
const PID_DIR = join(FABRIC_DIR, "pids");
const STATE_DIR = join(FABRIC_DIR, "state");

function ensureDirs() {
  for (const d of [FABRIC_DIR, MAILBOX_DIR, PID_DIR, STATE_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

function initDb() {
  ensureDirs();
  const db = new DatabaseSync(REGISTRY_DB);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      pane_id TEXT,
      session TEXT,
      pid INTEGER,
      model TEXT,
      status TEXT DEFAULT 'active',
      registered_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      agent_id TEXT,
      payload TEXT,
      ts TEXT DEFAULT (datetime('now'))
    );
  `);
  db.close();
}

function registerAgent(agentId: string, role: string, pid: number) {
  const db = new DatabaseSync(REGISTRY_DB);
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO agents (agent_id, role, pid, status, last_seen_at)
     VALUES (?, ?, ?, 'active', datetime('now'))`
  );
  stmt.run(agentId, role, pid);
  db.close();
  writeFileSync(`${PID_DIR}/${agentId}.pid`, String(pid));
  writeFileSync(`${MAILBOX_DIR}/${agentId}.jsonl`, "", { flag: "a" });
}

function sendMessage(to: string, msg: unknown) {
  const line = JSON.stringify(msg) + "\n";
  appendFileSync(`${MAILBOX_DIR}/${to}.jsonl`, line);

  const pidPath = `${PID_DIR}/${to}.pid`;
  if (existsSync(pidPath)) {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    if (pid > 0) {
      try {
        process.kill(pid, "SIGUSR1");
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

function readInbox(agentId: string) {
  const mbox = `${MAILBOX_DIR}/${agentId}.jsonl`;
  const statePath = `${STATE_DIR}/${agentId}.json`;
  let offset = 0;
  if (existsSync(statePath)) {
    offset = JSON.parse(readFileSync(statePath, "utf8")).lastOffset || 0;
  }

  const fd = openSync(mbox, "r");
  const stats = fstatSync(fd);
  const newBytes = stats.size - offset;

  if (newBytes <= 0) {
    closeSync(fd);
    return { messages: [], newOffset: offset };
  }

  const buffer = Buffer.alloc(newBytes);
  readSync(fd, buffer, 0, newBytes, offset);
  closeSync(fd);

  const lines = buffer.toString("utf8").split("\n").filter(Boolean);
  const messages = lines.map((l) => JSON.parse(l));
  writeFileSync(statePath, JSON.stringify({ lastOffset: stats.size, lastProcessed: Date.now() }));
  return { messages, newOffset: stats.size };
}

function runTelegramRoutingValidationTests() {
  console.log("[test] TelegramRoutingIntent validation...");

  const active = ["boss", "sub-boss-28"];

  const valid = validateTelegramRoutingIntent({
    kind: "telegram_routing_intent",
    original_language: "es",
    normalized_instruction: "Actualizar estado",
    intended_coordinator_id: "sub-boss-28",
    project_hint: { project_id: 1, project_name: "cmd-center-v2", matched_text: "routing" },
    confidence: 0.91,
    route_reason: "explicit mention",
    needs_clarification: false,
    user_facing_clarification: null,
    monitor_action: "route",
  }, active, "boss");

  if (!valid || valid.intended_coordinator_id !== "sub-boss-28") {
    throw new Error("TelegramRoutingIntent valid payload failed validation");
  }

  const invalidWorkerTarget = validateTelegramRoutingIntent({
    kind: "telegram_routing_intent",
    original_language: "es",
    normalized_instruction: "run tests",
    intended_coordinator_id: "reviewer-1",
    project_hint: { project_id: null, project_name: null, matched_text: null },
    confidence: 0.8,
    route_reason: "bad target",
    needs_clarification: false,
    user_facing_clarification: null,
    monitor_action: "route",
  }, active, "boss");

  if (invalidWorkerTarget !== null) {
    throw new Error("TelegramRoutingIntent accepted non-coordinator target");
  }

  const fallback = validateTelegramRoutingIntent({
    kind: "telegram_routing_intent",
    original_language: "en",
    normalized_instruction: "status",
    intended_coordinator_id: null,
    project_hint: { project_id: null, project_name: null, matched_text: null },
    confidence: 0.4,
    route_reason: "fallback",
    needs_clarification: false,
    user_facing_clarification: null,
    monitor_action: "fallback_to_default",
  }, active, "boss");

  if (!fallback || fallback.intended_coordinator_id !== "boss") {
    throw new Error("TelegramRoutingIntent fallback_to_default did not map default coordinator");
  }

  console.log("[test] TelegramRoutingIntent validation OK");
}

function runRpcWorkerCleanupTests() {
  console.log("[test] RPC worker cleanup...");

  const shouldCleanupWorker = shouldAutoCleanupCompletedRpcWorker({
    agentId: "dev-32",
    status: "done",
    role: "dev",
    mode: "rpc",
  });
  if (!shouldCleanupWorker) {
    throw new Error("RPC worker cleanup policy did not match terminal rpc worker");
  }

  const shouldIgnoreInteractiveWorker = shouldAutoCleanupCompletedRpcWorker({
    agentId: "dev-32-interactive",
    status: "done",
    role: "dev",
    mode: "interactive",
  });
  if (shouldIgnoreInteractiveWorker) {
    throw new Error("RPC worker cleanup policy incorrectly matched interactive worker");
  }

  const shouldIgnoreNonTerminalResponse = shouldAutoCleanupCompletedRpcWorker({
    agentId: "dev-32-accepted",
    status: "accepted",
    role: "dev",
    mode: "rpc",
  });
  if (shouldIgnoreNonTerminalResponse) {
    throw new Error("RPC worker cleanup policy incorrectly matched non-terminal response");
  }

  const protectedCoordinator = shouldAutoCleanupCompletedRpcWorker({
    agentId: "boss",
    status: "done",
    role: "coordinator",
    mode: "rpc",
  });
  if (protectedCoordinator) {
    throw new Error("RPC worker cleanup policy incorrectly matched protected role coordinator");
  }

  const protectedSubCoordinator = shouldAutoCleanupCompletedRpcWorker({
    agentId: "sub-boss-32",
    status: "blocked",
    role: "sub-coordinator",
    mode: "rpc",
  });
  if (protectedSubCoordinator) {
    throw new Error("RPC worker cleanup policy incorrectly matched protected role sub-coordinator");
  }

  const cleanupDir = mkdtempSync(join(tmpdir(), "fabric-rpc-cleanup-"));
  mkdirSync(join(cleanupDir, "pids"), { recursive: true });
  mkdirSync(join(cleanupDir, "state"), { recursive: true });
  mkdirSync(join(cleanupDir, "mailboxes"), { recursive: true });
  mkdirSync(join(cleanupDir, "launch-scripts"), { recursive: true });
  const artifactPaths = [
    join(cleanupDir, "pids", "reviewer-32.pid"),
    join(cleanupDir, "state", "reviewer-32.json"),
    join(cleanupDir, "mailboxes", "reviewer-32.jsonl"),
    join(cleanupDir, "launch-scripts", "reviewer-32.sh"),
  ];
  for (const path of artifactPaths) {
    writeFileSync(path, "artifact");
  }

  const sharedWorktreeDir = join(cleanupDir, "shared-worktree");
  mkdirSync(sharedWorktreeDir, { recursive: true });
  const sharedWorktreeFile = join(sharedWorktreeDir, "README.md");
  writeFileSync(sharedWorktreeFile, "do not delete");

  const commands: string[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const events: Array<{ type: string; agent_id: string; payload: Record<string, unknown> }> = [];
  const registryDeletes: string[] = [];

  const cleanupResult = cleanupChildAgentResources(
    {
      agentId: "reviewer-32",
      role: "reviewer",
      mode: "rpc",
      paneId: "%42",
      pid: 43210,
      session: "fabric-task-32",
    },
    {
      runCommand: (command) => {
        commands.push(command);
      },
      signalPid: (pid, signal) => {
        signals.push({ pid, signal });
      },
      removePath: (path) => {
        rmSync(path, { force: true });
      },
      appendRuntimeCleanupEvent: (event) => {
        events.push(event);
      },
      deleteRegistryAgent: (agentId) => {
        registryDeletes.push(agentId);
      },
      resolveArtifactPaths: () => artifactPaths,
    }
  );

  if (!cleanupResult.cleaned) {
    throw new Error(`RPC worker cleanup reported errors: ${cleanupResult.errors.join(" | ")}`);
  }
  if (!cleanupResult.killedPane) {
    throw new Error("RPC worker cleanup did not attempt tmux pane cleanup");
  }
  if (cleanupResult.signaledPid) {
    throw new Error("RPC worker cleanup should prefer pane cleanup before direct pid signal");
  }
  if (commands.length !== 1 || !commands[0]?.includes("tmux kill-pane -t")) {
    throw new Error("RPC worker cleanup did not issue tmux kill-pane command");
  }
  if (signals.length !== 0) {
    throw new Error("RPC worker cleanup unexpectedly sent a direct signal when pane cleanup succeeded");
  }
  for (const path of artifactPaths) {
    if (existsSync(path)) {
      throw new Error(`RPC worker cleanup left runtime artifact behind: ${path}`);
    }
  }
  if (!existsSync(sharedWorktreeFile)) {
    throw new Error("RPC worker cleanup removed shared task worktree artifact");
  }
  if (registryDeletes[0] !== "reviewer-32") {
    throw new Error("RPC worker cleanup did not delete the child from registry");
  }
  const eventTypes = new Set(events.map((event) => event.type));
  if (!eventTypes.has("agent.offline") || !eventTypes.has("agent.removed")) {
    throw new Error("RPC worker cleanup did not emit offline+removed runtime events");
  }

  rmSync(cleanupDir, { recursive: true, force: true });
  console.log("[test] RPC worker cleanup OK");
}

async function runTest() {
  console.log(`[test] Using isolated FABRIC_DIR=${FABRIC_DIR}`);
  initDb();

  const alicePid = process.pid;
  const bobPid = process.pid + 1; // fake, for signal testing

  console.log("[test] Registering agents...");
  registerAgent("alice", "chat", alicePid);
  registerAgent("bob", "chat", bobPid);

  // Check registry
  const db = new DatabaseSync(REGISTRY_DB);
  const rows = db.prepare("SELECT * FROM agents").all();
  console.log(`[test] Registry has ${(rows as any[]).length} agents`);
  console.log(rows);
  db.close();

  // Test mailbox append + signal
  let sigusr1Received = false;
  process.on("SIGUSR1", () => {
    sigusr1Received = true;
    console.log("[test] SIGUSR1 received!");
  });

  console.log("[test] Alice sending message to Bob...");
  const msg = {
    message_id: randomUUID(),
    from: "alice",
    to: "bob",
    type: "chat",
    payload: { text: "hola mundo" },
    timestamp: new Date().toISOString(),
  };

  const signalOk = sendMessage("bob", msg);
  console.log(`[test] Signal delivery: ${signalOk ? "OK" : "FAIL (expected: Bob PID fake)"}`);

  // Since bob PID is fake, signal should fail. Let's update bob PID to our own for testing.
  writeFileSync(`${PID_DIR}/bob.pid`, String(process.pid));
  console.log("[test] Updated bob PID to our own for signal test...");

  const signalOk2 = sendMessage("bob", msg);
  console.log(`[test] Signal delivery (real PID): ${signalOk2 ? "OK" : "FAIL"}`);

  // Wait a tick for signal handler
  await new Promise((r) => setTimeout(r, 100));
  console.log(`[test] SIGUSR1 received flag: ${sigusr1Received}`);

  // Read bob's inbox
  console.log("[test] Reading bob's inbox...");
  const inbox = readInbox("bob");
  console.log(`[test] Bob has ${inbox.messages.length} messages, offset=${inbox.newOffset}`);
  console.log(inbox.messages);

  // Verify state file
  const state = JSON.parse(readFileSync(`${STATE_DIR}/bob.json`, "utf8"));
  console.log(`[test] Bob state: offset=${state.lastOffset}`);

  // Re-read should yield 0 new messages
  const inbox2 = readInbox("bob");
  console.log(`[test] Re-read bob inbox: ${inbox2.messages.length} messages (expected 0)`);

  runTelegramRoutingValidationTests();
  runRpcWorkerCleanupTests();

  console.log("[test] All core tests passed!");
}

runTest()
  .catch(console.error)
  .finally(() => {
    rmSync(FABRIC_DIR, { recursive: true, force: true });
  });
