#!/usr/bin/env npx tsx
/**
 * Fabric Monitor — Real-Time Agent Dashboard Server
 * HTTP + SSE + fs.watch + watchdog + metrics
 * Zero dependencies outside Node.js builtins.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, watch, existsSync, statSync, openSync, closeSync, readSync, fstatSync, appendFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { basename, extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { initDb } from "../pm/db.js";
import { seed } from "../pm/seed.js";
import {
  getDashboard,
  getProjectTree,
  getTaskWithDetails,
  getTasks as getTasksFromDb,
  getTaskById as getTaskByIdFromDb,
  getSubtasksByTaskId as getSubtasksByTaskIdFromDb,
  getAgentIdsForProject,
  type ProjectTree,
  type TaskRow,
  type SubtaskRow,
  type DashboardRow,
} from "../pm/queries.js";
import {
  resolveAgentStates,
  type AgentRuntimeState,
} from "../pm/agent-state-reader.js";
import {
  readConfig as readTelegramConfig,
  tgGetUpdates,
  tgSendMessage,
  getChatSession,
  processTelegramMessage,
  getPendingRequest,
  finalizePendingRequest,
  auditTelegramDelivery,
  type TelegramConfig,
} from "./telegram-bridge.js";
import {
  openFabricDb,
  ensureRegistrySchema,
  execWithSqliteRetry,
  prepareAllWithRetry,
  prepareGetWithRetry,
  prepareRunWithRetry,
  isRegistryDegradedError,
} from "./sqlite-utils.js";
import { readRuntimeEventsSince, type RuntimeEvent, appendRuntimeEvent } from "./runtime-events.js";

// ──────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const PORT = Number(args.find((a) => a.startsWith("--port="))?.split("=")[1]) || 7474;
const HOST = "127.0.0.1";
const FABRIC_DIR = "/tmp/fabric-agents";
const REGISTRY_DB = `${FABRIC_DIR}/registry.sqlite`;
const EVENTS_LOG = `${FABRIC_DIR}/agents.jsonl`;
const STATE_DIR = `${FABRIC_DIR}/state`;
const PID_DIR = `${FABRIC_DIR}/pids`;
const MAILBOX_DIR = `${FABRIC_DIR}/mailboxes`;
const OUTPUTS_DIR = process.env.FABRIC_OUTPUTS_DIR || `${FABRIC_DIR}/outputs`;
const PROJECTS_EVENTS_LOG = `${FABRIC_DIR}/projects.jsonl`;
const RUNTIME_EVENTS_LOG = `${FABRIC_DIR}/runtime-events.jsonl`;
let eventsLogOffset = 0;
let lastEventLogSize = 0;
let projectsEventsOffset = 0;
let lastProjectsEventLogSize = 0;
let runtimeEventsOffset = 0;

const WATCHDOG_INTERVAL_MS = 5000;
const OFFLINE_CONFIRM_CYCLES = 2;
const BLOCKED_TIMEOUT_WAITING_RESPONSE = 60000; // 60s
const BLOCKED_TIMEOUT_WAITING_LLM = 120000;    // 120s
const PM_DB_PATH = `${FABRIC_DIR}/projects.sqlite`;
const MONITOR_LOG = `${FABRIC_DIR}/monitor.log`;

let _pmDb: DatabaseSync | null = null;
function getPmDb(): DatabaseSync {
  if (!_pmDb) {
    _pmDb = initDb(PM_DB_PATH);
  }
  return _pmDb;
}

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface MonitoredAgent {
  agent_id: string;
  role: string;
  pid: number | null;
  pane_id: string;
  session: string;
  model: string;
  fabric_status: string;
  current_task: string | null;
  pending_correlations: string[];
  is_streaming: boolean;
  is_thinking: boolean;
  active_tool: string | null;
  queue_length: number;
  last_seen_at: string;
  last_error: string | null;
  process_alive: boolean;
  mailbox_pending: number;
  offline_cycles: number;
  blocked_at?: string;
  last_pid_verified_at?: number;
}

interface SSEClient {
  id: string;
  res: ServerResponse;
  alive: boolean;
}

interface MetricEvent {
  metric: string;
  value: number;
  context: Record<string, unknown>;
  ts: number;
}

interface AgentOutputMessage {
  agent_id: string;
  timestamp: string;
  content: string;
  model?: string;
  stopReason?: string;
  isError?: boolean;
}

// ──────────────────────────────────────────────────────────────
// Globals
// ──────────────────────────────────────────────────────────────

const clients = new Map<string, SSEClient>();
const agents = new Map<string, MonitoredAgent>();
const metrics = new Map<string, MetricEvent[]>(); // metric name -> events
const outputOffsets = new Map<string, number>(); // agent_id -> byte offset in outputs/{id}.jsonl
let registryDegradedError: string | null = null;

// ── Telegram bridge state ──
interface TelegramBridgeState {
  connected: boolean;
  info: string;
  lastError: string;
  reconnectAttempt: number;
}
let telegramBridgeState: TelegramBridgeState = {
  connected: false,
  info: "not configured",
  lastError: "",
  reconnectAttempt: 0,
};
let telegramRunning = true;
let telegramAbortController: AbortController | null = null;

function updateTelegramState(connected: boolean, info: string, lastError?: string) {
  const changed =
    telegramBridgeState.connected !== connected ||
    telegramBridgeState.info !== info;
  telegramBridgeState = {
    connected,
    info,
    lastError: lastError || telegramBridgeState.lastError,
    reconnectAttempt: connected ? 0 : telegramBridgeState.reconnectAttempt,
  };
  if (changed) {
    broadcastSSE("telegram-status", {
      connected,
      info,
      last_error: telegramBridgeState.lastError,
      timestamp: new Date().toISOString(),
    });
    if (connected) {
      log(`[telegram] Bridge connected ${info}`);
    } else {
      log(`[telegram] Bridge offline ${info}`);
    }
  }
}

// ── Monitor mailbox processing ──
// The monitor has its own mailbox so agents can send responses back
// using the same mailbox+SIGUSR1 pattern as inter-agent communication.

const MONITOR_AGENT_ID = "monitor";
const MONITOR_MBOX = `${MAILBOX_DIR}/${MONITOR_AGENT_ID}.jsonl`;
const MONITOR_PID_FILE = `${PID_DIR}/${MONITOR_AGENT_ID}.pid`;
const MONITOR_INSTANCE_LOCK = `${FABRIC_DIR}/monitor-instance.lock`;
const MONITOR_BRIDGE_LOCK = `${FABRIC_DIR}/monitor-bridge.lock`;
let monitorMailboxOffset = 0;
let ownsMonitorInstance = false;
let ownsMonitorBridge = false;

function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readMonitorLockOwner(lockPath: string): { pid: number | null; port: number | null } {
  try {
    if (!existsSync(lockPath)) {
      return { pid: null, port: null };
    }
    const raw = readFileSync(lockPath, "utf8").trim();
    const parsed = raw ? JSON.parse(raw) as { pid?: number; port?: number } : {};
    const pid = Number(parsed.pid ?? 0);
    const port = Number(parsed.port ?? 0);
    return {
      pid: Number.isFinite(pid) && pid > 0 ? pid : null,
      port: Number.isFinite(port) && port > 0 ? port : null,
    };
  } catch {
    return { pid: null, port: null };
  }
}

function readMonitorInstanceOwner() {
  return readMonitorLockOwner(MONITOR_INSTANCE_LOCK);
}

function readMonitorBridgeOwner() {
  return readMonitorLockOwner(MONITOR_BRIDGE_LOCK);
}

function releaseMonitorInstance() {
  if (!ownsMonitorInstance) return;

  try {
    if (existsSync(MONITOR_INSTANCE_LOCK)) {
      const owner = readMonitorInstanceOwner();
      if (owner.pid === process.pid) {
        unlinkSync(MONITOR_INSTANCE_LOCK);
      }
    }
  } catch {}

  ownsMonitorInstance = false;
}

function tryAcquireMonitorInstance(): boolean {
  if (ownsMonitorInstance) return true;

  try {
    if (existsSync(MONITOR_PID_FILE)) {
      const pidFromFile = Number(readFileSync(MONITOR_PID_FILE, "utf8").trim());
      if (isPidAlive(pidFromFile) && pidFromFile !== process.pid) {
        log(`[monitor] Another monitor instance is already active via PID file (pid=${pidFromFile}). Exiting.`);
        monitorLog("warn", "monitor.instance_blocked_by_pid_file", {
          pid: process.pid,
          port: PORT,
          owner_pid: pidFromFile,
        });
        return false;
      }
    }
  } catch {
    // ignore malformed/stale pid file
  }

  const liveBridgeOwner = readMonitorBridgeOwner();
  if (isPidAlive(liveBridgeOwner.pid) && liveBridgeOwner.pid !== process.pid) {
    log(`[monitor] Another monitor instance is already active via bridge lock (pid=${liveBridgeOwner.pid ?? "?"} port=${liveBridgeOwner.port ?? "?"}). Exiting.`);
    monitorLog("warn", "monitor.instance_blocked_by_bridge_lock", {
      pid: process.pid,
      port: PORT,
      owner_pid: liveBridgeOwner.pid,
      owner_port: liveBridgeOwner.port,
    });
    return false;
  }

  if (!existsSync(FABRIC_DIR)) mkdirSync(FABRIC_DIR, { recursive: true });

  const lockPayload = JSON.stringify({
    pid: process.pid,
    port: PORT,
    acquired_at: new Date().toISOString(),
  });

  try {
    writeFileSync(MONITOR_INSTANCE_LOCK, lockPayload, { flag: "wx" });
    ownsMonitorInstance = true;
    log(`[monitor] Single-instance lock acquired (pid=${process.pid}, port=${PORT})`);
    return true;
  } catch {
    const owner = readMonitorInstanceOwner();
    if (!isPidAlive(owner.pid)) {
      try { unlinkSync(MONITOR_INSTANCE_LOCK); } catch {}
      return tryAcquireMonitorInstance();
    }

    log(`[monitor] Another monitor instance is already running (pid=${owner.pid ?? "?"} port=${owner.port ?? "?"}). Exiting.`);
    monitorLog("warn", "monitor.instance_already_running", {
      pid: process.pid,
      port: PORT,
      owner_pid: owner.pid,
      owner_port: owner.port,
    });
    return false;
  }
}

function ensureMonitorBridgeOwnership(reason: string): boolean {
  if (!ownsMonitorBridge) return false;

  const owner = readMonitorBridgeOwner();
  if (owner.pid === process.pid) return true;

  const details = owner.pid
    ? `pid=${owner.pid} port=${owner.port ?? "?"}`
    : "lock missing or unreadable";

  log(`[monitor] Bridge ownership lost (${reason}) — ${details}. Switching to standby.`);
  monitorLog("warn", "bridge.ownership_lost", {
    pid: process.pid,
    port: PORT,
    reason,
    owner_pid: owner.pid,
    owner_port: owner.port,
  });

  if (telegramAbortController) {
    try {
      telegramAbortController.abort();
    } catch {
      // ignore
    }
    telegramAbortController = null;
  }

  releaseMonitorBridge();
  updateTelegramState(false, owner.pid ? `(standby — bridge owned by pid=${owner.pid})` : "(standby — bridge ownership lost)");
  return false;
}

function tryAcquireMonitorBridge(): boolean {
  if (ownsMonitorBridge) return ensureMonitorBridgeOwnership("acquire-shortcut");

  if (!existsSync(FABRIC_DIR)) mkdirSync(FABRIC_DIR, { recursive: true });

  const lockPayload = JSON.stringify({
    pid: process.pid,
    port: PORT,
    acquired_at: new Date().toISOString(),
  });

  try {
    writeFileSync(MONITOR_BRIDGE_LOCK, lockPayload, { flag: "wx" });
    ownsMonitorBridge = true;
    log(`[monitor] Bridge ownership acquired (pid=${process.pid}, port=${PORT})`);
    return true;
  } catch {
    try {
      const owner = readMonitorBridgeOwner();
      if (!isPidAlive(owner.pid)) {
        try { unlinkSync(MONITOR_BRIDGE_LOCK); } catch {}
        return tryAcquireMonitorBridge();
      }
      log(`[monitor] Standby mode: bridge owned by pid=${owner.pid ?? "?"} port=${owner.port ?? "?"}`);
    } catch {
      try { unlinkSync(MONITOR_BRIDGE_LOCK); } catch {}
      return tryAcquireMonitorBridge();
    }
    return false;
  }
}

function releaseMonitorBridge() {
  if (!ownsMonitorBridge) return;

  try {
    if (existsSync(MONITOR_PID_FILE)) {
      const ownerPid = Number(readFileSync(MONITOR_PID_FILE, "utf8").trim());
      if (ownerPid === process.pid) {
        unlinkSync(MONITOR_PID_FILE);
      }
    }
  } catch {}

  try {
    if (existsSync(MONITOR_BRIDGE_LOCK)) {
      const raw = readFileSync(MONITOR_BRIDGE_LOCK, "utf8").trim();
      const parsed = raw ? JSON.parse(raw) as { pid?: number } : {};
      if (Number(parsed.pid ?? 0) === process.pid) {
        unlinkSync(MONITOR_BRIDGE_LOCK);
      }
    }
  } catch {}

  ownsMonitorBridge = false;
}

function initMonitorMailbox() {
  if (!ensureMonitorBridgeOwnership("init-mailbox")) {
    log("[monitor] Mailbox bridge disabled in standby monitor");
    return;
  }
  if (!existsSync(MAILBOX_DIR)) mkdirSync(MAILBOX_DIR, { recursive: true });
  if (!existsSync(PID_DIR)) mkdirSync(PID_DIR, { recursive: true });
  if (!existsSync(MONITOR_MBOX)) {
    try { appendFileSync(MONITOR_MBOX, "", { flag: "a" }); } catch {}
  }
  const stats = statSync(MONITOR_MBOX);
  monitorMailboxOffset = stats.size;
  writeFileSync(MONITOR_PID_FILE, String(process.pid));
  log(`[monitor] Mailbox ready at ${MONITOR_MBOX}`);
}

interface TelegramResponsePayload {
  text?: string;
  request_id?: string;
  chat_id?: number | string;
  reply_to?: number | string;
  status?: "ack" | "progress" | "final" | "blocked" | "error" | "router_queued" | string;
  sender?: {
    agent_id?: string;
    role?: string;
    display_name?: string;
  };
  telegram_message?: {
    text?: string;
    format?: "telegram_markdown" | "plain";
    include_sender_header?: boolean;
  };
}

type TelegramLifecycleEvent = "agent_ack" | "agent_final" | "agent_update" | "router_queued";

function lifecycleFromStatus(status: string | undefined): TelegramLifecycleEvent {
  if (status === "ack") return "agent_ack";
  if (status === "final") return "agent_final";
  if (status === "router_queued") return "router_queued";
  return "agent_update";
}

function coerceFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function normalizeTelegramOutboundPayload(payload: TelegramResponsePayload, fallbackFrom?: string): {
  text: string;
  parseMode?: string;
  requestId?: string;
  chatId?: number;
  replyTo?: number;
  status: string;
  lifecycle_event: TelegramLifecycleEvent;
} {
  const senderAgentId = String(payload.sender?.agent_id || fallbackFrom || "agent");
  const senderRole = payload.sender?.role ? String(payload.sender.role) : undefined;
  const senderDisplay = String(payload.sender?.display_name || senderAgentId);

  const telegramMessageText = payload.telegram_message?.text;
  const legacyText = payload.text;
  const rawText = String((telegramMessageText ?? legacyText ?? "")).trim();

  const format = payload.telegram_message?.format === "telegram_markdown" ? "telegram_markdown" : "plain";
  const includeSenderHeader = payload.telegram_message?.include_sender_header ?? true;

  const senderHeader = includeSenderHeader
    ? (format === "telegram_markdown"
      ? `*${senderDisplay}*${senderRole ? ` · ${senderRole}` : ""}\n\n`
      : `${senderDisplay}${senderRole ? ` · ${senderRole}` : ""}\n\n`)
    : "";

  const status = typeof payload.status === "string" ? payload.status : "final";
  return {
    text: `${senderHeader}${rawText}`.trim(),
    parseMode: format === "telegram_markdown" ? "Markdown" : undefined,
    requestId: typeof payload.request_id === "string" ? payload.request_id : undefined,
    chatId: coerceFiniteNumber(payload.chat_id),
    replyTo: coerceFiniteNumber(payload.reply_to),
    status,
    lifecycle_event: lifecycleFromStatus(status),
  };
}

async function processMonitorMailbox() {
  if (!ensureMonitorBridgeOwnership("process-mailbox")) return;

  try {
    const fd = openSync(MONITOR_MBOX, "r");
    const stats = fstatSync(fd);
    const newBytes = stats.size - monitorMailboxOffset;

    if (newBytes <= 0) {
      closeSync(fd);
      return;
    }

    const buffer = Buffer.alloc(newBytes);
    readSync(fd, buffer, 0, newBytes, monitorMailboxOffset);
    closeSync(fd);
    monitorMailboxOffset = stats.size;

    const lines = buffer.toString("utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as {
          type: string;
          payload: TelegramResponsePayload;
          from?: string;
        };
        if ((msg.type === "telegram_response" || msg.type === "telegram_agent_response") && msg.payload) {
          const normalized = normalizeTelegramOutboundPayload(msg.payload, msg.from);
          if (normalized.lifecycle_event === "router_queued") {
            log(`[monitor] Telegram response dropped: router_queued is monitor-owned (from=${msg.from ?? "unknown"})`);
            auditTelegramDelivery({
              request_id: normalized.requestId,
              status: "dropped",
              via: "monitor_mailbox",
              from_agent: msg.from,
              error: "router_queued_reserved_monitor_only",
              details: { lifecycle_event: "router_queued", status: normalized.status },
            });
            continue;
          }
          if (!normalized.text) {
            log(`[monitor] Telegram response dropped: missing telegram_message.text or payload.text`);
            continue;
          }

          // Keep pending request until successful send or terminal failure.
          let replyTo = normalized.replyTo;
          let chatId = normalized.chatId;
          const pending = normalized.requestId ? getPendingRequest(normalized.requestId) : undefined;
          if (pending) {
            replyTo ??= pending.messageId;
            chatId ??= pending.chatId;
          }

          if (!chatId) {
            log(`[monitor] Telegram response dropped: missing chat_id (req=${normalized.requestId ?? "none"})`);
            auditTelegramDelivery({
              request_id: normalized.requestId,
              status: "dropped",
              via: "monitor_mailbox",
              error: "missing_chat_id",
            });
            continue;
          }

          const config = readTelegramConfig();
          if (config.botToken) {
            try {
              auditTelegramDelivery({
                request_id: normalized.requestId,
                status: "attempt",
                via: "monitor_mailbox",
                chat_id: chatId,
                reply_to: replyTo,
                from_agent: msg.from,
                target_coordinator: pending?.agentId,
                details: { lifecycle_event: normalized.lifecycle_event, status: normalized.status },
              });

              const sent = await tgSendMessage(config.botToken, chatId, normalized.text, {
                replyTo,
                parseMode: normalized.parseMode,
              });

              const shouldFinalize = normalized.lifecycle_event === "agent_final";
              if (shouldFinalize && normalized.requestId) finalizePendingRequest(normalized.requestId);
              auditTelegramDelivery({
                request_id: normalized.requestId,
                status: "sent",
                via: "monitor_mailbox",
                chat_id: sent.chatId ?? chatId,
                reply_to: replyTo,
                telegram_message_id: sent.messageId,
                from_agent: msg.from,
                target_coordinator: pending?.agentId,
                details: {
                  lifecycle_event: normalized.lifecycle_event,
                  status: normalized.status,
                  ...(sent.raw && typeof sent.raw === "object" ? (sent.raw as Record<string, unknown>) : {}),
                },
              });
              log(`[monitor] Telegram ${normalized.lifecycle_event} delivered (req=${normalized.requestId ?? "none"}, chat=${chatId}, tg_msg_id=${sent.messageId ?? "n/a"})`);
            } catch (sendErr) {
              const errorText = String(sendErr);
              const terminal = isTerminalTelegramDeliveryError(sendErr);
              const shouldFinalizeOnTerminal = terminal && normalized.lifecycle_event === "agent_final";
              if (shouldFinalizeOnTerminal && normalized.requestId) finalizePendingRequest(normalized.requestId);
              auditTelegramDelivery({
                request_id: normalized.requestId,
                status: terminal ? "failed_terminal" : "failed",
                via: "monitor_mailbox",
                chat_id: chatId,
                reply_to: replyTo,
                from_agent: msg.from,
                target_coordinator: pending?.agentId,
                error: errorText,
                details: { lifecycle_event: normalized.lifecycle_event, status: normalized.status },
              });
              log(`[monitor] Telegram response delivery failed (req=${normalized.requestId ?? "none"}, terminal=${terminal}): ${errorText}`);
            }
          } else {
            log(`[monitor] Telegram not configured — response logged: ${normalized.text.slice(0, 100)}`);
            auditTelegramDelivery({
              request_id: normalized.requestId,
              status: "failed",
              via: "monitor_mailbox",
              chat_id: chatId,
              reply_to: replyTo,
              from_agent: msg.from,
              target_coordinator: pending?.agentId,
              error: "telegram_not_configured",
            });
          }
        }
      } catch (parseErr) {
        log("[monitor] Bad mailbox line:", (parseErr as Error).message);
      }
    }
  } catch (err) {
    log("[monitor] Mailbox processing error:", (err as Error).message);
  }
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function log(...args: unknown[]) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}]`, ...args);
}

function monitorLog(level: "info" | "warn" | "error" | "debug", event: string, payload: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    source: "monitor",
    event,
    ...payload,
  }) + "\n";
  try {
    appendFileSync(MONITOR_LOG, line);
  } catch {
    // ignore — console is our fallback
  }
}

function isTerminalTelegramDeliveryError(err: unknown): boolean {
  const text = String(err ?? "");
  return /HTTP\s+(400|401|403|404)\b/.test(text);
}

function setRegistryDegraded(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  registryDegradedError = message;
  monitorLog("error", "registry.degraded_mode", {
    error: message,
    registry_db: REGISTRY_DB,
    recovery_command: "npx tsx src/core/rebuild-registry.ts --fabric-dir=/tmp/fabric-agents",
  });
  log("[monitor] Registry degraded mode:", message);
  log("[monitor] Recovery path: stop all writers and run npx tsx src/core/rebuild-registry.ts --fabric-dir=/tmp/fabric-agents");
}

function clearRegistryDegraded(): void {
  registryDegradedError = null;
}

function waitForSigusr1OrTimeout(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (done) return;
      done = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      process.removeListener("SIGUSR1", wakeup);
      resolve();
    };

    const wakeup = () => finish();

    timer = setTimeout(finish, timeoutMs);
    process.once("SIGUSR1", wakeup);
  });
}

const REGISTRY_AGENT_UPSERT_EVENT_TYPES = new Set([
  "agent.launching",
  "agent.launch_failed",
  "agent.registered",
  "agent.status_runtime",
  "agent.heartbeat",
  "agent.offline",
  "agent.pid_recovered",
  "agent.reconciled",
  "agent.model_runtime",
]);

function persistRuntimeEvent(db: DatabaseSync, event: RuntimeEvent): void {
  const rawPayload = event.payload ?? {};
  const eventType = event.type === "registry.event"
    ? String(rawPayload.event_type ?? "registry.event")
    : event.type;
  const eventPayload = event.type === "registry.event"
    ? ((rawPayload.payload as Record<string, unknown> | undefined) ?? {})
    : rawPayload;

  const stmt = db.prepare(
    `INSERT INTO events (event_id, type, agent_id, payload, ts)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO NOTHING`
  );
  prepareRunWithRetry(stmt, [
    event.event_id,
    eventType,
    event.agent_id,
    JSON.stringify(eventPayload),
    event.ts,
  ]);
}

function registryRowFromPayload(agentId: string, payload: Record<string, unknown>) {
  return {
    agent_id: agentId,
    role: String(payload.role ?? "unknown"),
    pane_id: String(payload.pane_id ?? ""),
    session: String(payload.session ?? ""),
    pid: typeof payload.pid === "number" ? payload.pid : null,
    model: String(payload.model ?? "unknown"),
    status: String(payload.status ?? "active"),
    fabric_status: String(payload.fabric_status ?? payload.status ?? "idle"),
    current_task: payload.current_task == null ? null : String(payload.current_task),
    pending_correlations: JSON.stringify(Array.isArray(payload.pending_correlations) ? payload.pending_correlations : []),
    last_error: payload.last_error == null ? null : String(payload.last_error),
    is_streaming: payload.is_streaming ? 1 : 0,
    is_thinking: payload.is_thinking ? 1 : 0,
    active_tool: payload.active_tool == null ? null : String(payload.active_tool),
    queue_length: typeof payload.queue_length === "number" ? payload.queue_length : 0,
  };
}

function applyRuntimeEventToRegistry(event: RuntimeEvent): void {
  const db = getDb();
  try {
    persistRuntimeEvent(db, event);

    if (event.type === "agent.removed") {
      prepareRunWithRetry(db.prepare("DELETE FROM agents WHERE agent_id = ?"), [event.agent_id]);
      return;
    }

    if (!REGISTRY_AGENT_UPSERT_EVENT_TYPES.has(event.type)) {
      return;
    }

    const payload = event.payload ?? {};
    const row = registryRowFromPayload(event.agent_id, payload);
    const stmt = db.prepare(`
      INSERT INTO agents (
        agent_id, role, pane_id, session, pid, model, status, registered_at, last_seen_at,
        fabric_status, current_task, pending_correlations, last_error,
        is_streaming, is_thinking, active_tool, queue_length
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT registered_at FROM agents WHERE agent_id = ?), datetime('now')), datetime('now'),
        ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(agent_id) DO UPDATE SET
        role = excluded.role,
        pane_id = excluded.pane_id,
        session = excluded.session,
        pid = excluded.pid,
        model = excluded.model,
        status = excluded.status,
        last_seen_at = excluded.last_seen_at,
        fabric_status = excluded.fabric_status,
        current_task = excluded.current_task,
        pending_correlations = excluded.pending_correlations,
        last_error = excluded.last_error,
        is_streaming = excluded.is_streaming,
        is_thinking = excluded.is_thinking,
        active_tool = excluded.active_tool,
        queue_length = excluded.queue_length
    `);
    prepareRunWithRetry(stmt, [
      row.agent_id,
      row.role,
      row.pane_id,
      row.session,
      row.pid,
      row.model,
      row.status,
      row.agent_id,
      row.fabric_status,
      row.current_task,
      row.pending_correlations,
      row.last_error,
      row.is_streaming,
      row.is_thinking,
      row.active_tool,
      row.queue_length,
    ]);
  } finally {
    db.close();
  }
}

function drainRuntimeEvents(): void {
  try {
    const { events, nextOffset } = readRuntimeEventsSince(RUNTIME_EVENTS_LOG, runtimeEventsOffset);
    runtimeEventsOffset = nextOffset;
    for (const event of events) {
      applyRuntimeEventToRegistry(event);
    }
  } catch (err) {
    if (isRegistryDegradedError(err)) {
      setRegistryDegraded(err);
      return;
    }
    monitorLog("warn", "runtime_events.drain_failed", { error: String(err) });
  }
}

function getDb(): DatabaseSync {
  if (!existsSync(FABRIC_DIR)) {
    mkdirSync(FABRIC_DIR, { recursive: true });
  }
  const db = openFabricDb(REGISTRY_DB);
  ensureRegistrySchema(db);
  return db;
}

function loadAgentsFromDb(): MonitoredAgent[] {
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    const db = getDb();
    try {
      const stmt = db.prepare(`
        SELECT agent_id, role, pid, pane_id, session, model,
               fabric_status, current_task, pending_correlations,
               is_streaming, is_thinking, active_tool, queue_length,
               last_seen_at, last_error, status
        FROM agents
        ORDER BY registered_at
      `);
      const rows = prepareAllWithRetry(stmt, []) as Array<{
        agent_id: string;
        role: string;
        pid: number | null;
        pane_id: string;
        session: string;
        model: string;
        fabric_status: string | null;
        current_task: string | null;
        pending_correlations: string | null;
        is_streaming: number;
        is_thinking: number;
        active_tool: string | null;
        queue_length: number;
        last_seen_at: string;
        last_error: string | null;
        status: string;
      }>;
      return rows.map((r) => ({
        agent_id: r.agent_id,
        role: r.role,
        pid: r.pid,
        pane_id: r.pane_id ?? "",
        session: r.session ?? "",
        model: r.model ?? "unknown",
        fabric_status: (r.status === 'offline' && !checkPid(r.pid)) ? 'offline' : (r.fabric_status ?? r.status ?? "unknown"),
        current_task: r.current_task,
        pending_correlations: safeJsonParse<string[]>(r.pending_correlations, []),
        is_streaming: !!r.is_streaming,
        is_thinking: !!r.is_thinking,
        active_tool: r.active_tool,
        queue_length: r.queue_length ?? 0,
        last_seen_at: r.last_seen_at ?? new Date(0).toISOString(),
        last_error: r.last_error,
        process_alive: checkPid(r.pid),
        mailbox_pending: computeMailboxPending(r.agent_id, r.pid),
        offline_cycles: 0,
        last_pid_verified_at: 0,
      }));
    } catch (err: any) {
      lastErr = err;
      if (err?.code === "ERR_SQLITE_ERROR" && err?.errcode === 5) {
        const delay = 20 * Math.pow(2, attempt);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        continue;
      }
      if (isRegistryDegradedError(err)) {
        setRegistryDegraded(err);
        return [];
      }
      throw err;
    } finally {
      db.close();
    }
  }
  throw lastErr;
}

function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback;
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

function checkPid(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function computeMailboxPending(agentId: string, _pid: number | null): number {
  const mbox = `${MAILBOX_DIR}/${agentId}.jsonl`;
  const statePath = `${STATE_DIR}/${agentId}.json`;
  if (!existsSync(mbox)) return 0;

  const mboxSize = statSync(mbox).size;
  let lastOffset = 0;
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      lastOffset = state.lastOffset ?? 0;
    } catch {
      // ignore
    }
  }
  return Math.max(0, mboxSize - lastOffset);
}

function wakeAgentIfPending(agentId: string, pid: number | null): void {
  if (!pid || !checkPid(pid)) return;
  const pending = computeMailboxPending(agentId, pid);
  if (pending > 0) {
    try {
      process.kill(pid, "SIGUSR1");
      monitorLog("info", "agent.wake_after_pid_fix", { agent_id: agentId, pid, pending_bytes: pending });
    } catch {
      // ignore if process vanished between check and signal
    }
  }
}

function readNewEvents(): Record<string, unknown>[] {
  if (!existsSync(EVENTS_LOG)) return [];

  const stats = statSync(EVENTS_LOG);
  if (stats.size <= lastEventLogSize) {
    lastEventLogSize = stats.size;
    return [];
  }

  const fd = openSync(EVENTS_LOG, "r");
  const newBytes = stats.size - eventsLogOffset;
  const buffer = Buffer.alloc(newBytes);
  readSync(fd, buffer, 0, newBytes, eventsLogOffset);
  closeSync(fd);

  eventsLogOffset = stats.size;
  lastEventLogSize = stats.size;

  const lines = buffer.toString("utf8").split("\n").filter(Boolean);
  const events: Record<string, unknown>[] = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line)); } catch { /* skip corrupt */ }
  }
  return events;
}

function readNewProjectEvents(): Record<string, unknown>[] {
  if (!existsSync(PROJECTS_EVENTS_LOG)) return [];

  const stats = statSync(PROJECTS_EVENTS_LOG);
  if (stats.size <= lastProjectsEventLogSize) {
    lastProjectsEventLogSize = stats.size;
    return [];
  }

  const fd = openSync(PROJECTS_EVENTS_LOG, "r");
  const newBytes = stats.size - projectsEventsOffset;
  const buffer = Buffer.alloc(newBytes);
  readSync(fd, buffer, 0, newBytes, projectsEventsOffset);
  closeSync(fd);

  projectsEventsOffset = stats.size;
  lastProjectsEventLogSize = stats.size;

  const lines = buffer.toString("utf8").split("\n").filter(Boolean);
  const events: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip corrupt
    }
  }
  return events;
}

function applyEvent(event: Record<string, unknown>) {
  const type = event.type as string;
  const agentId = (event.agent_id as string) || "";

  if (type === "agent.registered" && agentId) {
    if (!agents.has(agentId) && !registryDegradedError) {
      refreshAgentsFromDb();
    }
    broadcastSSE("agent-registered", event);
  } else if (type === "agent.status_change" && agentId) {
    const payload = (event.payload as Record<string, unknown>) || {};
    const to = payload.to as string;
    if (to) {
      const agent = agents.get(agentId);
      if (agent) {
        agent.fabric_status = to;
        agent.current_task = (payload.task as string) ?? agent.current_task;
        agent.last_seen_at = (event.ts as string) ?? new Date().toISOString();
        agent.process_alive = checkPid(agent.pid);
        if (agent.process_alive) agent.offline_cycles = 0;

        const details = (payload.details as Record<string, unknown>) || {};
        if (details.queue_length !== undefined) agent.queue_length = details.queue_length as number;
        if (details.active_tool !== undefined) agent.active_tool = details.active_tool as string | null;
        if (details.is_streaming !== undefined) agent.is_streaming = !!details.is_streaming;
        if (details.is_thinking !== undefined) agent.is_thinking = !!details.is_thinking;
        agent.mailbox_pending = computeMailboxPending(agentId, agent.pid);
      } else if (!registryDegradedError) {
        refreshAgentsFromDb();
      }
      broadcastSSE("agent-update", agentFromMemory(agentId));
    }
  } else if (type === "agent.model_changed" && agentId) {
    const agent = agents.get(agentId);
    if (agent) {
      const payload = (event.payload as Record<string, unknown>) || {};
      agent.model = (payload.to as string) ?? agent.model;
    }
    broadcastSSE("agent-update", agentFromMemory(agentId));
  } else if (type === "agent.metric" && agentId) {
    const payload = (event.payload as Record<string, unknown>) || {};
    const metricName = payload.metric as string;
    const value = payload.value as number;
    if (metricName && typeof value === "number") {
      if (!metrics.has(metricName)) metrics.set(metricName, []);
      metrics.get(metricName)!.push({
        metric: metricName,
        value,
        context: (payload.context as Record<string, unknown>) || {},
        ts: Date.now(),
      });
    }
  } else if (type === "agent.output" && agentId) {
    const payload = (event.payload as Record<string, unknown>) || {};
    broadcastSSE("agent-output", {
      agent_id: agentId,
      timestamp: payload.timestamp ?? event.ts ?? new Date().toISOString(),
      preview: payload.preview ?? "",
      isError: !!payload.isError,
      model: payload.model ?? null,
      stopReason: payload.stopReason ?? null,
    });
  } else {
    broadcastSSE("log-event", event);
  }
}

function agentFromMemory(agentId: string): Record<string, unknown> | null {
  const a = agents.get(agentId);
  if (!a) return null;
  return { ...a };
}

function applyProjectEvent(event: Record<string, unknown>) {
  const type = event.type as string;
  const eventName = type.includes(".") ? type.replace(".", "-") : type;
  broadcastSSE(eventName, event);
}

function serveApiProjectsEvents(res: ServerResponse, url: URL) {
  const since = Number(url.searchParams.get("since")) || 0;
  if (!existsSync(PROJECTS_EVENTS_LOG)) {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ events: [], total: 0 }));
    return;
  }

  const data = readFileSync(PROJECTS_EVENTS_LOG, "utf8");
  const lines = data.split("\n").filter(Boolean);
  const events = lines.slice(since).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);

  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify({ events, total: lines.length }, null, 2));
}

function broadcastSSE(event: string, data: unknown) {
  if (!data) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients.values()) {
    if (!client.alive) continue;
    try {
      client.res.write(payload);
    } catch {
      client.alive = false;
    }
  }
  // Clean up dead clients
  for (const [id, client] of clients.entries()) {
    if (!client.alive) clients.delete(id);
  }
}

function safeAgentFileName(agentId: string) {
  return agentId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body, null, 2));
}

function readJsonBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function outputFileForAgent(agentId: string) {
  return `${OUTPUTS_DIR}/${safeAgentFileName(agentId)}.jsonl`;
}

function parseOutputLine(line: string): AgentOutputMessage | null {
  try {
    const msg = JSON.parse(line) as AgentOutputMessage;
    if (!msg || typeof msg.content !== "string") return null;
    return {
      ...msg,
      timestamp: msg.timestamp || new Date().toISOString(),
      agent_id: msg.agent_id || "unknown",
      isError: !!msg.isError,
    };
  } catch {
    return null;
  }
}

function readAgentOutputs(agentId: string, limit = 50): AgentOutputMessage[] {
  const file = outputFileForAgent(agentId);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const messages = lines
    .map(parseOutputLine)
    .filter(Boolean) as AgentOutputMessage[];
  messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return messages.slice(-limit);
}

function broadcastAgentOutput(message: AgentOutputMessage) {
  broadcastSSE("agent-output", {
    agent_id: message.agent_id,
    timestamp: message.timestamp,
    preview: message.content.slice(0, 200),
    isError: !!message.isError,
    model: message.model ?? null,
    stopReason: message.stopReason ?? null,
  });
}

function scanOutputFile(agentId: string, initialize = false) {
  const file = outputFileForAgent(agentId);
  if (!existsSync(file)) return;

  const stats = statSync(file);
  const prevOffset = outputOffsets.get(agentId) ?? 0;
  if (initialize) {
    outputOffsets.set(agentId, stats.size);
    return;
  }

  const startOffset = stats.size < prevOffset ? 0 : prevOffset;
  if (stats.size <= startOffset) return;

  const fd = openSync(file, "r");
  const buffer = Buffer.alloc(stats.size - startOffset);
  readSync(fd, buffer, 0, buffer.length, startOffset);
  closeSync(fd);
  outputOffsets.set(agentId, stats.size);

  const lines = buffer.toString("utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    const msg = parseOutputLine(line);
    if (msg) broadcastAgentOutput(msg);
  }
}

function scanOutputsDirectory(initialize = false) {
  if (!existsSync(OUTPUTS_DIR)) return;
  for (const entry of readdirSync(OUTPUTS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    scanOutputFile(basename(entry.name, ".jsonl"), initialize);
  }
}

function getPanePid(paneId: string): number | null {
  if (!paneId) return null;
  try {
    const out = execSync(
      `tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null | grep '^${paneId} ' | awk '{print $2}'`,
      { encoding: "utf8", timeout: 2000 }
    ).trim();
    const pid = Number(out);
    if (!isNaN(pid) && pid > 0) return pid;
  } catch {
    // pane may not exist
  }
  return null;
}

function updateAgentPid(agentId: string, newPid: number) {
  try {
    appendRuntimeEvent(RUNTIME_EVENTS_LOG, {
      type: "agent.pid_recovered",
      agent_id: agentId,
      payload: { pid: newPid },
    });
  } catch {}
}

function updateAgentStatus(agentId: string, status: string, fabricStatus?: string) {
  try {
    appendRuntimeEvent(RUNTIME_EVENTS_LOG, {
      type: "agent.status_runtime",
      agent_id: agentId,
      payload: { status, fabric_status: fabricStatus ?? status },
    });
  } catch {}
}

function refreshAgentsFromDb() {
  const fromDb = loadAgentsFromDb();
  for (const agent of fromDb) {
    const existing = agents.get(agent.agent_id);

    // PID recovery from tmux pane: if DB PID is dead but we have a recovered PID in memory, prefer memory
    let dbPidAlive = agent.process_alive;
    let effectivePid = agent.pid;
    let effectiveAlive = agent.process_alive;

    // Resolve canonical PID: prefer tmux pane, cross-check memory against it
    const panePid = agent.pane_id ? getPanePid(agent.pane_id) : null;
    const panePidAlive = panePid ? checkPid(panePid) : false;

    if (existing) {
      const memoryPidAlive = existing.pid ? checkPid(existing.pid) : false;
      if (memoryPidAlive && existing.pid === panePid) {
        // Memory PID matches tmux pane — trust it
        effectivePid = existing.pid;
        effectiveAlive = true;
      } else if (panePidAlive) {
        // Pane PID is alive and either memory is stale or mismatched — prefer pane
        effectivePid = panePid;
        effectiveAlive = true;
        agent.offline_cycles = 0;
        updateAgentPid(agent.agent_id, panePid);
        wakeAgentIfPending(agent.agent_id, panePid);
      } else if (memoryPidAlive) {
        // Memory PID is alive but does NOT match pane; pane is missing/dead.
        // Keep memory PID as a fallback, but log a warning so we notice drift.
        monitorLog("warn", "refresh.pid_drift_detected", {
          agent_id: agent.agent_id,
          memory_pid: existing.pid,
          pane_pid: panePid,
          db_pid: agent.pid,
          pane_id: agent.pane_id,
        });
        effectivePid = existing.pid;
        effectiveAlive = true;
      } else if (!dbPidAlive && agent.pane_id) {
        // All PIDs dead — try recovering from tmux pane one more time
        if (panePid && checkPid(panePid)) {
          effectivePid = panePid;
          effectiveAlive = true;
          agent.offline_cycles = 0;
          updateAgentPid(agent.agent_id, panePid);
          wakeAgentIfPending(agent.agent_id, panePid);
        }
      }
    } else {
      // Brand new agent from DB — try pane recovery if DB PID is dead
      if (!dbPidAlive && agent.pane_id) {
        if (panePid && checkPid(panePid)) {
          effectivePid = panePid;
          effectiveAlive = true;
          agent.offline_cycles = 0;
          updateAgentPid(agent.agent_id, panePid);
          wakeAgentIfPending(agent.agent_id, panePid);
        }
      }
    }

    if (existing) {
      existing.role = agent.role;
      // Only overwrite PID if we have a confirmed alive one, or DB has a different one
      if (effectivePid && effectiveAlive) {
        existing.pid = effectivePid;
      } else if (agent.pid && agent.process_alive) {
        existing.pid = agent.pid;
      } else if (agent.pid) {
        existing.pid = agent.pid; // at least keep the DB value if nothing else
      }
      existing.pane_id = agent.pane_id;
      existing.session = agent.session;
      existing.model = agent.model;
      existing.fabric_status = agent.fabric_status;
      existing.current_task = agent.current_task;
      existing.pending_correlations = agent.pending_correlations;
      existing.is_streaming = agent.is_streaming;
      existing.is_thinking = agent.is_thinking;
      existing.active_tool = agent.active_tool;
      existing.queue_length = agent.queue_length;
      existing.last_seen_at = agent.last_seen_at;
      existing.last_error = agent.last_error;
      existing.process_alive = checkPid(existing.pid);
      existing.mailbox_pending = agent.mailbox_pending;
      // Do NOT reset offline_cycles on refresh — let watchdog handle that
    } else {
      agent.pid = effectivePid ?? agent.pid;
      agent.process_alive = effectiveAlive;
      agents.set(agent.agent_id, agent);
    }
  }
  // Remove agents no longer in DB — BUT only if they were also not recently alive in memory
  const dbIds = new Set(fromDb.map((a) => a.agent_id));
  for (const id of agents.keys()) {
    if (!dbIds.has(id)) {
      const mem = agents.get(id);
      if (mem && mem.process_alive) {
        // Agent alive in memory but missing from DB: re-insert it
        try {
          appendRuntimeEvent(RUNTIME_EVENTS_LOG, {
            type: "agent.reconciled",
            agent_id: id,
            payload: {
              role: mem.role ?? "unknown",
              pane_id: mem.pane_id ?? "",
              session: mem.session ?? "",
              pid: mem.pid ?? null,
              model: mem.model ?? "unknown",
              status: "active",
              fabric_status: mem.fabric_status ?? "idle",
            },
          });
        } catch {}
        continue;
      }
      agents.delete(id);
      broadcastSSE("agent-offline", { agent_id: id, reason: "removed_from_registry" });
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Watchdog
// ──────────────────────────────────────────────────────────────

function runWatchdog() {
  for (const agent of agents.values()) {
    // 1. PID check — if stored PID is dead, try recovering from tmux pane.
    // Also cross-check alive PIDs against tmux pane every 60s to catch drift
    // (e.g. a stray pi process that outlived the real agent).
    let alive = checkPid(agent.pid);
    const now = Date.now();
    const shouldVerify = !agent.last_pid_verified_at || (now - agent.last_pid_verified_at > 60000);

    if (!alive && agent.pane_id) {
      const panePid = getPanePid(agent.pane_id);
      if (panePid && checkPid(panePid)) {
        monitorLog("info", "watchdog.pid_recovered", { agent_id: agent.agent_id, old_pid: agent.pid, new_pid: panePid, pane_id: agent.pane_id });
        agent.pid = panePid;
        agent.process_alive = true;
        agent.offline_cycles = 0;
        delete (agent as any).offline_at;
        updateAgentPid(agent.agent_id, panePid);
        wakeAgentIfPending(agent.agent_id, panePid);
        alive = true;
        agent.last_pid_verified_at = now;
      }
    } else if (alive && shouldVerify && agent.pane_id) {
      const panePid = getPanePid(agent.pane_id);
      if (panePid && panePid !== agent.pid && checkPid(panePid)) {
        monitorLog("warn", "watchdog.pid_drift_corrected", { agent_id: agent.agent_id, old_pid: agent.pid, new_pid: panePid, pane_id: agent.pane_id });
        agent.pid = panePid;
        agent.process_alive = true;
        agent.offline_cycles = 0;
        delete (agent as any).offline_at;
        updateAgentPid(agent.agent_id, panePid);
        wakeAgentIfPending(agent.agent_id, panePid);
      }
      agent.last_pid_verified_at = now;
    }

    if (!alive) {
      agent.offline_cycles++;
      const confirmCycles = (agent.role === "coordinator" || agent.role === "sub-coordinator") ? 4 : OFFLINE_CONFIRM_CYCLES;
      if (agent.offline_cycles >= confirmCycles && agent.fabric_status !== "offline") {
        monitorLog("warn", "watchdog.marked_offline", { agent_id: agent.agent_id, pid: agent.pid, pane_id: agent.pane_id, offline_cycles: agent.offline_cycles, fabric_status: agent.fabric_status });
        agent.fabric_status = "offline";
        agent.process_alive = false;
        (agent as any).offline_at = Date.now();
        updateAgentStatus(agent.agent_id, "offline", "offline");
        broadcastSSE("agent-offline", {
          agent_id: agent.agent_id,
          pid: agent.pid,
          reason: "kill_0_failed",
        });
        appendGlobalEvent({
          type: "agent.offline_detected",
          agent_id: agent.agent_id,
          payload: { pid: agent.pid, reason: "kill_0_failed" },
        });
      }
    } else {
      if (agent.offline_cycles > 0) {
        monitorLog("info", "watchdog.back_online", { agent_id: agent.agent_id, pid: agent.pid, pane_id: agent.pane_id });
        agent.offline_cycles = 0;
        agent.process_alive = true;
        delete (agent as any).offline_at;
        broadcastSSE("agent-back", {
          agent_id: agent.agent_id,
          pid: agent.pid,
        });
      }
    }

    // 1b. Remove stale offline agents after 60s (only if pane also gone AND pid is dead)
    if (agent.fabric_status === "offline" && (agent as any).offline_at) {
      const offlineMs = Date.now() - ((agent as any).offline_at as number);
      if (offlineMs > 60000) {
        const panePid = agent.pane_id ? getPanePid(agent.pane_id) : null;
        const paneStillExists = !!panePid && checkPid(panePid);
        const pidAlive = checkPid(agent.pid);

        // Do NOT auto-purge coordinators — they are critical infrastructure
        if (agent.role === "coordinator" || agent.role === "sub-coordinator") {
          continue;
        }

        // DOUBLE CHECK: before removing, verify both PID and tmux pane indicate death
        if (!paneStillExists && !pidAlive) {
          monitorLog("error", "watchdog.purged_agent", { agent_id: agent.agent_id, pid: agent.pid, pane_id: agent.pane_id, pane_pid: panePid, offline_ms: offlineMs, reason: "both_pid_and_pane_dead" });
          agents.delete(agent.agent_id);
          try {
            const db = getDb();
            db.prepare("DELETE FROM agents WHERE agent_id = ?").run(agent.agent_id);
            db.close();
          } catch {}
          try {
            const pidPath = `${PID_DIR}/${agent.agent_id}.pid`;
            if (existsSync(pidPath)) unlinkSync(pidPath);
          } catch {}
          broadcastSSE("agent-removed", { agent_id: agent.agent_id, reason: "offline_stale_confirmed" });
          continue;
        }

        // If pane or PID came back to life, bring agent back from offline
        if (paneStillExists || pidAlive) {
          monitorLog("info", "watchdog.resurrected_before_removal", { agent_id: agent.agent_id, pid: agent.pid, pane_pid: panePid, pid_alive: pidAlive, pane_alive: paneStillExists });
          agent.fabric_status = agent.fabric_status === "offline" ? "idle" : agent.fabric_status;
          agent.process_alive = true;
          agent.offline_cycles = 0;
          delete (agent as any).offline_at;
          if (panePid && panePid !== agent.pid) {
            agent.pid = panePid;
            updateAgentPid(agent.agent_id, panePid);
          }
          broadcastSSE("agent-back", { agent_id: agent.agent_id, pid: agent.pid, reason: "resurrected_before_removal" });
        }
      }
    }

    // 2. Blocked detection
    const lastSeen = new Date(agent.last_seen_at).getTime();
    const elapsed = Date.now() - lastSeen;

    if (
      agent.fabric_status === "waiting_response" &&
      elapsed > BLOCKED_TIMEOUT_WAITING_RESPONSE
    ) {
      broadcastSSE("agent-blocked", {
        agent_id: agent.agent_id,
        from: "waiting_response",
        to: "blocked",
        reason: "timeout",
        elapsed_ms: elapsed,
      });
    }
    if (
      agent.fabric_status === "waiting_llm" &&
      elapsed > BLOCKED_TIMEOUT_WAITING_LLM
    ) {
      broadcastSSE("agent-blocked", {
        agent_id: agent.agent_id,
        from: "waiting_llm",
        to: "blocked",
        reason: "llm_timeout",
        elapsed_ms: elapsed,
      });
    }

    // 3. Mailbox pending update
    agent.mailbox_pending = computeMailboxPending(agent.agent_id, agent.pid);
  }
}

function appendGlobalEvent(event: Record<string, unknown>) {
  const line = JSON.stringify({ ...event, ts: new Date().toISOString() }) + "\n";
  try {
    appendFileSync(EVENTS_LOG, line);
  } catch {
    // ignore
  }
}

// ──────────────────────────────────────────────────────────────
// Metrics
// ──────────────────────────────────────────────────────────────

function computeMetrics(): Record<string, unknown> {
  const result: Record<string, Record<string, unknown>> = {};

  for (const [name, events] of metrics.entries()) {
    if (events.length === 0) continue;
    const values = events.map((e) => e.value);
    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    result[name] = {
      count: events.length,
      avg: Math.round(avg * 100) / 100,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p50,
      p95,
    };
  }

  // Agent counts
  const all = Array.from(agents.values());
  const alive = all.filter((a) => a.process_alive);
  const dead = all.filter((a) => !a.process_alive);

  const activeCount = alive.filter((a) => a.fabric_status !== "offline" && a.fabric_status !== "shutting_down").length;
  const offlineCount = dead.length + alive.filter((a) => a.fabric_status === "offline" || a.fabric_status === "shutting_down").length;
  const processingCount = alive.filter((a) =>
    ["processing", "turn_active", "waiting_llm", "streaming", "thinking", "tool_running"].includes(a.fabric_status)
  ).length;

  const coordinators = alive.filter((a) => a.role === "coordinator");
  const workers = alive.filter((a) => a.role !== "coordinator");

  result._summary = {
    total_agents: all.length,
    alive: alive.length,
    active: activeCount,
    offline: offlineCount,
    processing: processingCount,
    coordinators_alive: coordinators.length,
    coordinators_active: coordinators.filter((a) => a.fabric_status !== "offline" && a.fabric_status !== "shutting_down").length,
    workers_alive: workers.length,
    workers_active: workers.filter((a) => a.fabric_status !== "offline" && a.fabric_status !== "shutting_down").length,
    by_status: Object.fromEntries(
      [...new Set(all.map((a) => a.fabric_status))].map((s) => [
        s,
        all.filter((a) => a.fabric_status === s).length,
      ])
    ),
    by_role: Object.fromEntries(
      [...new Set(all.map((a) => a.role))].map((r) => [
        r,
        {
          alive: all.filter((a) => a.role === r && a.process_alive).length,
          total: all.filter((a) => a.role === r).length,
        },
      ])
    ),
  };

  return result;
}

// ──────────────────────────────────────────────────────────────
// HTTP Handlers
// ──────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function serveDashboard(res: ServerResponse) {
  try {
    const dashboardPath = resolve(__dirname, "../../dashboard/index.html");
    const html = readFileSync(dashboardPath, "utf8");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("dashboard/index.html not found. Run monitor from project root.");
  }
}

function serveApiAgents(res: ServerResponse) {
  // Memory-first: use in-memory Map. DB syncs in background.
  const all = Array.from(agents.values()).map((a) => ({ ...a }));
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(all, null, 2));
}

function serveApiAgentOutputs(res: ServerResponse, agentId: string, url: URL) {
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50, 1), 500);
  try {
    const messages = readAgentOutputs(agentId, limit);
    sendJson(res, 200, {
      agent_id: agentId,
      messages,
      lastUpdated: messages.length ? messages[messages.length - 1].timestamp : null,
    });
  } catch (err) {
    sendJson(res, 500, { success: false, error: String(err) });
  }
}

function agentExists(agentId: string): MonitoredAgent | null {
  const fromMemory = agents.get(agentId);
  if (fromMemory) return fromMemory;
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT agent_id, role, pid, pane_id, session, model,
             fabric_status, current_task, pending_correlations,
             is_streaming, is_thinking, active_tool, queue_length,
             last_seen_at, last_error, status
      FROM agents WHERE agent_id = ?
    `).get(agentId) as any;
    if (!row) return null;
    return {
      agent_id: row.agent_id,
      role: row.role,
      pid: row.pid ?? null,
      pane_id: row.pane_id ?? "",
      session: row.session ?? "",
      model: row.model ?? "",
      fabric_status: row.fabric_status ?? "idle",
      current_task: row.current_task ?? null,
      pending_correlations: JSON.parse(row.pending_correlations || "[]"),
      is_streaming: !!row.is_streaming,
      is_thinking: !!row.is_thinking,
      active_tool: row.active_tool ?? null,
      queue_length: row.queue_length ?? 0,
      last_seen_at: row.last_seen_at ?? "",
      last_error: row.last_error ?? null,
      process_alive: checkPid(row.pid ?? null),
      mailbox_pending: computeMailboxPending(row.agent_id, row.pid ?? null),
      offline_cycles: 0,
    };
  } catch {
    return null;
  }
}

function createPmTaskForAgentMessage(body: any, agentId: string): number | null {
  const projectId = Number(body.project_id);
  const description = String(body.description ?? body.text ?? "").trim();
  if (!Number.isFinite(projectId) || projectId <= 0 || !description) return null;

  try {
    const db = getPmDb();
    const title = String(body.title ?? description.split("\n")[0] ?? "Web task").slice(0, 120);
    const seqRow = db.prepare("SELECT COALESCE(MAX(sequence_order), 0) + 1 AS seq FROM tasks WHERE project_id = ?").get(projectId) as { seq: number };
    const result = db.prepare(`
      INSERT INTO tasks
        (project_id, title, description, status, orchestrator_agent_id, sequence_order, created_at, updated_at)
      VALUES (?, ?, ?, 'in_progress', ?, ?, datetime('now'), datetime('now'))
    `).run(projectId, title, description, agentId, seqRow?.seq ?? 0);
    const taskId = Number(result.lastInsertRowid);

    if (Array.isArray(body.acceptance_criteria) && body.acceptance_criteria.length > 0) {
      db.prepare(`
        INSERT INTO task_analyses
          (task_id, version, keywords, human_note, agent_note, analysis_type, confidence_score, author_id, author_type, created_at, is_active)
        VALUES (?, 'v1', ?, ?, ?, 'planning', 70, 'monitor', 'system', ?, 1)
      `).run(
        taskId,
        JSON.stringify(["agent-control-panel", "acceptance-criteria", agentId]),
        "Tarea creada desde Agent Control Panel con criterios estructurados.",
        `Acceptance criteria enviados al agente ${agentId}:\n${JSON.stringify(body.acceptance_criteria, null, 2)}`,
        new Date().toISOString(),
      );
    }

    appendFileSync(PROJECTS_EVENTS_LOG, JSON.stringify({
      type: "task.created",
      task_id: taskId,
      project_id: projectId,
      agent_id: agentId,
      ts: new Date().toISOString(),
    }) + "\n");

    return taskId;
  } catch (err) {
    monitorLog("warn", "agent_message.pm_task_create_failed", { agent_id: agentId, error: String(err) });
    return null;
  }
}

async function serveApiAgentMessage(res: ServerResponse, req: IncomingMessage, agentId: string) {
  try {
    if (/[\\/]/.test(agentId)) {
      sendJson(res, 400, { success: false, error: "Invalid agent id" });
      return;
    }

    const agent = agentExists(agentId);
    if (!agent) {
      sendJson(res, 404, { success: false, error: "Agent not found" });
      return;
    }

    const pid = agent.pid ?? null;
    if (!pid || !checkPid(pid)) {
      sendJson(res, 400, { success: false, error: "Agent offline" });
      return;
    }

    const body = await readJsonBody(req);
    const type = String(body.type ?? "chat");
    if (!["chat", "task"].includes(type)) {
      sendJson(res, 400, { success: false, error: "Invalid body: type must be 'chat' or 'task'" });
      return;
    }

    const text = String(body.text ?? body.description ?? "").trim();
    if (!text) {
      sendJson(res, 400, { success: false, error: "Invalid body: text/description is required" });
      return;
    }

    const acceptanceCriteria = Array.isArray(body.acceptance_criteria) ? body.acceptance_criteria : undefined;
    let taskId = body.task_id != null ? String(body.task_id) : undefined;
    if (type === "task" && !taskId) {
      const createdTaskId = createPmTaskForAgentMessage(body, agentId);
      if (createdTaskId != null) taskId = String(createdTaskId);
    }

    const messageId = randomUUID();
    const mailboxPath = `${MAILBOX_DIR}/${agentId}.jsonl`;
    if (!existsSync(MAILBOX_DIR)) mkdirSync(MAILBOX_DIR, { recursive: true });

    const payload: Record<string, unknown> = type === "task"
      ? {
          text,
          description: String(body.description ?? text),
          acceptance_criteria: acceptanceCriteria ?? [],
          report_to_when_done: body.report_to_when_done ?? "secretary",
          task_id: taskId,
        }
      : { text };

    appendFileSync(mailboxPath, JSON.stringify({
      message_id: messageId,
      from: String(body.from ?? "human"),
      to: agentId,
      type,
      payload,
      timestamp: new Date().toISOString(),
    }) + "\n");

    process.kill(pid, "SIGUSR1");

    const busyStatuses = new Set(["processing", "turn_active", "waiting_llm", "agent_starting", "processing_inbox", "streaming", "thinking", "tool_running", "waiting_response"]);
    const status = busyStatuses.has(agent.fabric_status) ? 202 : 200;
    sendJson(res, status, {
      success: true,
      messageId,
      taskId: taskId ?? null,
      note: status === 202 ? "Agent busy, message queued" : "Message delivered",
    });
  } catch (err) {
    sendJson(res, 500, { success: false, error: String(err) });
  }
}

function serveApiMetrics(res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(computeMetrics(), null, 2));
}

function serveApiEvents(res: ServerResponse, url: URL) {
  const since = Number(url.searchParams.get("since")) || 0;
  if (!existsSync(EVENTS_LOG)) {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ events: [], total: 0 }));
    return;
  }

  const data = readFileSync(EVENTS_LOG, "utf8");
  const lines = data.split("\n").filter(Boolean);
  const events = lines.slice(since).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);

  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify({ events, total: lines.length }, null, 2));
}

function serveApiLog(res: ServerResponse, agentId: string, url: URL) {
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 500);
  const mbox = `${MAILBOX_DIR}/${agentId}.jsonl`;
  if (!existsSync(mbox)) {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ agent_id: agentId, lines: [] }));
    return;
  }

  try {
    const data = readFileSync(mbox, "utf8");
    const lines = data.split("\n").filter(Boolean).slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ agent_id: agentId, lines }, null, 2));
  } catch (err) {
    res.writeHead(500, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

// ── Chat API: reads all mailboxes, filters conversational messages ──

interface ChatMessage {
  id: string;
  ts: string;
  from: string;
  to: string;
  type: string;
  content: string;
  context?: string;
}

const CHAT_TYPES = new Set(["chat", "response", "message", "contract", "telegram_request", "telegram_user_message", "telegram_response", "telegram_agent_response"]);

function formatMonitorCriteria(criteria: unknown): string {
  if (!Array.isArray(criteria)) return "";
  return criteria.map((criterion, index) => {
    if (criterion && typeof criterion === "object") {
      const c = criterion as Record<string, unknown>;
      const id = String(c.id ?? `c${index + 1}`);
      const required = c.required === false ? "optional" : "required";
      const type = String(c.type ?? "manual");
      const description = String(c.description ?? "Sin descripción");
      return `  - ${id} (${required}, ${type}): ${description}`;
    }
    return `  - ${String(criterion)}`;
  }).join("\n");
}

function formatMonitorVerification(results: unknown): string {
  if (!Array.isArray(results) || results.length === 0) return "";
  return results.map((result, index) => {
    if (result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      const icon = r.passed === true ? "✅" : "❌";
      const required = r.required === false ? "optional" : "required";
      const error = r.error ? ` — ${String(r.error)}` : "";
      return `  ${icon} ${String(r.criterion_id ?? `criterion-${index + 1}`)} (${required})${error}`;
    }
    return `  - ${String(result)}`;
  }).join("\n");
}

function extractContent(msg: Record<string, unknown>): { content: string; context?: string } {
  const payload = (msg.payload as Record<string, unknown>) || {};
  const type = String(msg.type || "");

  // Telegram / chat / response text
  if (typeof payload.text === "string" && payload.text) {
    return { content: payload.text };
  }

  // Response with summary (report_completion)
  if (typeof payload.summary === "string" && payload.summary) {
    const status = String(payload.status || "");
    const artifacts = Array.isArray(payload.artifacts) && payload.artifacts.length
      ? `\n📎 Artifacts: ${payload.artifacts.map((a) => String(a)).join(", ")}`
      : "";
    const verification = formatMonitorVerification(payload.verification_results);
    return { content: `[${status.toUpperCase()}] ${payload.summary}${verification ? `\n🧪 Verification:\n${verification}` : ""}${artifacts}` };
  }

  // Contract / task description
  if (typeof payload.description === "string" && payload.description) {
    const formattedCriteria = formatMonitorCriteria(payload.acceptance_criteria);
    const criteria = formattedCriteria ? `\n✅ Criteria:\n${formattedCriteria}` : "";
    const reportTarget = typeof payload.report_to_when_done === "string" ? payload.report_to_when_done : payload.report_to;
    const reportTo = typeof reportTarget === "string" ? `\n📬 Report to: ${reportTarget}` : "";
    return { content: `📋 Task: ${payload.description}${criteria}${reportTo}` };
  }

  // Generic message fallback
  if (typeof payload.message === "string" && payload.message) {
    return { content: payload.message };
  }

  // Fallback: stringify payload (but limit)
  const payloadStr = JSON.stringify(payload);
  if (payloadStr.length > 2 && payloadStr !== "{}") {
    return { content: payloadStr.slice(0, 500) + (payloadStr.length > 500 ? "…" : "") };
  }

  return { content: `[${type}]` };
}

function serveApiChat(res: ServerResponse, url: URL) {
  const since = Number(url.searchParams.get("since")) || 0;
  const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 1000);
  const agentFilter = url.searchParams.get("agent") || "";

  try {
    if (!existsSync(MAILBOX_DIR)) {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ messages: [], total: 0 }));
      return;
    }

    const entries = readdirSync(MAILBOX_DIR, { withFileTypes: true });
    let allMessages: ChatMessage[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const mboxPath = `${MAILBOX_DIR}/${entry.name}`;
      try {
        const data = readFileSync(mboxPath, "utf8");
        const lines = data.split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            const type = String(msg.type || "");
            if (!CHAT_TYPES.has(type)) continue;

            const from = String(msg.from || "unknown");
            const to = String(msg.to || "unknown");

            // Agent filter
            if (agentFilter && from !== agentFilter && to !== agentFilter) continue;

            const ts = String(msg.timestamp || new Date().toISOString());
            const tsMs = new Date(ts).getTime();
            if (tsMs < since) continue;

            const { content, context } = extractContent(msg);
            if (!content.trim()) continue;

            allMessages.push({
              id: String(msg.message_id || `${from}-${tsMs}`),
              ts,
              from,
              to,
              type,
              content,
              context,
            });
          } catch {
            // skip corrupt line
          }
        }
      } catch {
        // skip unreadable mailbox
      }
    }

    // Sort by timestamp ascending
    allMessages.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    // Deduplicate by id (same message may appear in both sender and receiver mailboxes)
    const seen = new Set<string>();
    const deduped: ChatMessage[] = [];
    for (const m of allMessages) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      deduped.push(m);
    }

    const total = deduped.length;
    const messages = deduped.slice(-limit);

    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ messages, total }, null, 2));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

function serveApiKill(res: ServerResponse, agentId: string) {
  const agent = agents.get(agentId);
  if (!agent) {
    res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: "Agent not found" }));
    monitorLog("warn", "kill.not_found", { agent_id: agentId });
    return;
  }
  if (!agent.pane_id) {
    res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: "No pane_id for agent" }));
    monitorLog("warn", "kill.no_pane", { agent_id: agentId });
    return;
  }
  try {
    execSync(`tmux kill-pane -t ${agent.pane_id}`, { encoding: "utf8" });
    agent.fabric_status = "shutting_down";
    broadcastSSE("agent-update", agentFromMemory(agentId));
    monitorLog("info", "kill.success", { agent_id: agentId, pane_id: agent.pane_id });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, action: "kill-pane", pane_id: agent.pane_id }));
  } catch (err) {
    monitorLog("error", "kill.failed", { agent_id: agentId, pane_id: agent.pane_id, error: String(err) });
    res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

function getTmuxSessionForPane(paneId: string): string | null {
  if (!paneId) return null;
  try {
    const out = execSync(
      `tmux list-panes -a -F '#{pane_id} #{session_name}' 2>/dev/null | grep '^${paneId} ' | awk '{print $2}'`,
      { encoding: "utf8", timeout: 2000 }
    ).trim();
    if (out) return out;
  } catch {
    // ignore
  }
  return null;
}

function serveApiHealthcheck(res: ServerResponse, agentId: string) {
  const agent = agents.get(agentId);
  if (!agent) {
    res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: "Agent not found" }));
    return;
  }
  const mbox = `${MAILBOX_DIR}/${agentId}.jsonl`;
  const msg = JSON.stringify({
    message_id: randomUUID(),
    from: "monitor",
    to: agentId,
    type: "healthcheck",
    payload: { ts: new Date().toISOString() },
    timestamp: new Date().toISOString(),
  }) + "\n";
  try {
    appendFileSync(mbox, msg);
    if (agent.pid) {
      try { process.kill(agent.pid, "SIGUSR1"); } catch {}
    }
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, action: "healthcheck", target: agentId }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

// ──────────────────────────────────────────────────────────────
// Project Management Event Pipeline
// ──────────────────────────────────────────────────────────────
// PM Query Wrappers (read-only, in-memory enrichment)
// ──────────────────────────────────────────────────────────────

function getProjects(filters?: { status?: string }): (DashboardRow & { task_counts: Record<string, number> })[] {
  const db = getPmDb();
  const rows = getDashboard(db);
  const mapped = rows.map((r) => ({
    ...r,
    task_counts: {
      total: r.task_count,
      completed: r.tasks_completed,
    } as Record<string, number>,
  }));
  if (filters?.status) return mapped.filter((r) => r.status === filters.status);
  return mapped;
}

type ActiveCoordinatorRoutingSnapshot = {
  agent_id: string;
  role: "secretary" | "coordinator" | "sub-coordinator";
  fabric_status: string;
  current_task: string | null;
  session: string;
  last_seen_at: string;
  process_alive: boolean;
};

type ActiveProjectRoutingSnapshot = {
  project_id: number;
  name: string;
  status: string;
  short_title: string;
};

function getActiveCoordinators(): ActiveCoordinatorRoutingSnapshot[] {
  const allowedRoles = new Set(["secretary", "coordinator", "sub-coordinator"]);
  const blockedStatuses = new Set(["offline", "shutting_down"]);

  return Array.from(agents.values())
    .filter((a) => allowedRoles.has(a.role) && a.process_alive && !blockedStatuses.has(a.fabric_status))
    .map((a) => ({
      agent_id: a.agent_id,
      role: a.role as "secretary" | "coordinator" | "sub-coordinator",
      fabric_status: a.fabric_status,
      current_task: a.current_task,
      session: a.session,
      last_seen_at: a.last_seen_at,
      process_alive: a.process_alive,
    }));
}

function getActiveProjects(): ActiveProjectRoutingSnapshot[] {
  return getProjects({ status: "active" }).map((p) => ({
    project_id: p.project_id,
    name: p.name,
    status: p.status,
    short_title: String(p.name || "").slice(0, 80),
  }));
}

function getProjectById(id: number): ProjectTree | null {
  try {
    const db = getPmDb();
    return getProjectTree(db, id);
  } catch {
    return null;
  }
}

function getTasks(filters?: { project_id?: number; status?: string; agent_id?: string; active_only?: boolean }): (TaskRow & { agent_ids: string[] })[] {
  const db = getPmDb();
  const dbFilters: { project_id?: number; status?: string; agent_id?: string } = {};
  if (filters?.project_id != null) dbFilters.project_id = filters.project_id;
  if (filters?.status) dbFilters.status = filters.status;
  if (filters?.agent_id) dbFilters.agent_id = filters.agent_id;
  let rows = getTasksFromDb(db, dbFilters);
  if (filters?.active_only) {
    rows = rows.filter((r) => r.status !== "completed" && r.status !== "failed");
  }
  return rows.map((t) => ({
    ...t,
    agent_ids: [t.coordinator_agent_id, t.orchestrator_agent_id].filter(Boolean) as string[],
  }));
}

function getTaskById(id: number): (TaskRow & { agent_ids: string[]; subtasks: (SubtaskRow & { agent_ids: string[] })[] }) | null {
  try {
    const db = getPmDb();
    const task = getTaskByIdFromDb(db, id);
    if (!task) return null;
    const subtasks = getSubtasksByTaskIdFromDb(db, id).map((s) => ({
      ...s,
      agent_ids: [s.worker_agent_id, s.qa_agent_id].filter(Boolean) as string[],
    }));
    return { ...task, agent_ids: [task.coordinator_agent_id, task.orchestrator_agent_id].filter(Boolean) as string[], subtasks };
  } catch {
    return null;
  }
}

function getSubtasksByTaskId(taskId: number): (SubtaskRow & { agent_ids: string[] })[] {
  const db = getPmDb();
  return getSubtasksByTaskIdFromDb(db, taskId).map((s) => ({
    ...s,
    agent_ids: [s.worker_agent_id, s.qa_agent_id].filter(Boolean) as string[],
  }));
}

function initProjectsDb(): void {
  getPmDb();
}

function seedProjectsDb(): void {
  seed(PM_DB_PATH);
}

/**
 * Truncate runtime-events.jsonl to keep file size under MAX_LOG_SIZE_MB.
 * Keeps the most recent events, discarding oldest ones.
 * Called periodically to prevent unbounded file growth.
 */
const MAX_LOG_SIZE_MB = 5;
const MAX_LOG_SIZE_BYTES = MAX_LOG_SIZE_MB * 1024 * 1024;

function truncateRuntimeEventsLog(): void {
  try {
    if (!existsSync(RUNTIME_EVENTS_LOG)) {
      return;
    }

    const stats = statSync(RUNTIME_EVENTS_LOG);
    if (stats.size <= MAX_LOG_SIZE_BYTES) {
      return; // File is within size limit
    }

    // File is too large, truncate to keep recent events
    const content = readFileSync(RUNTIME_EVENTS_LOG, "utf8");
    const lines = content.split("\n").filter(Boolean);

    // Calculate how many lines to keep (aim for ~80% of max size to avoid rapid re-truncation)
    const targetSizeBytes = MAX_LOG_SIZE_BYTES * 0.8;
    let bytesSum = 0;
    let keepFrom = lines.length;

    // Iterate from end to find how many recent lines fit in target size
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(lines[i] + "\n", "utf8");
      if (bytesSum + lineBytes > targetSizeBytes) {
        keepFrom = i + 1;
        break;
      }
      bytesSum += lineBytes;
    }

    const keptLines = lines.slice(Math.max(0, keepFrom));
    const truncatedContent = keptLines.join("\n") + (keptLines.length > 0 ? "\n" : "");

    writeFileSync(RUNTIME_EVENTS_LOG, truncatedContent, "utf8");
    runtimeEventsOffset = 0; // Reset offset since file was truncated

    const discardedCount = lines.length - keptLines.length;
    monitorLog("info", "runtime_events_truncated", {
      total_lines: lines.length,
      kept_lines: keptLines.length,
      discarded_lines: discardedCount,
      original_size_mb: (stats.size / 1024 / 1024).toFixed(2),
      new_size_mb: (truncatedContent.length / 1024 / 1024).toFixed(2),
    });
  } catch (err) {
    monitorLog("warn", "runtime_events_truncate_failed", {
      error: String(err),
    });
  }
}

function serveStream(res: ServerResponse) {
  const clientId = randomUUID();
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const client: SSEClient = { id: clientId, res, alive: true };
  clients.set(clientId, client);

  // Send snapshot from in-memory state (DB syncs in background)
  const snapshot = Array.from(agents.values()).map((a) => ({ ...a }));
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

  const projectsSnapshot = getProjects();
  res.write(`event: projects-snapshot\ndata: ${JSON.stringify(projectsSnapshot)}\n\n`);

  // Send current Telegram bridge status
  res.write(`event: telegram-status\ndata: ${JSON.stringify({
    connected: telegramBridgeState.connected,
    info: telegramBridgeState.info,
    last_error: telegramBridgeState.lastError,
    timestamp: new Date().toISOString(),
  })}\n\n`);

  // Heartbeat
  const heartbeat = setInterval(() => {
    if (!client.alive) {
      clearInterval(heartbeat);
      return;
    }
    try {
      res.write(`event: ping\ndata: {}\n\n`);
    } catch {
      client.alive = false;
      clearInterval(heartbeat);
      clients.delete(clientId);
    }
  }, 15000);

  res.on("close", () => {
    client.alive = false;
    clearInterval(heartbeat);
    clients.delete(clientId);
    log(`SSE client ${clientId.slice(0, 6)} disconnected`);
  });

  log(`SSE client ${clientId.slice(0, 6)} connected (${clients.size} total)`);
}

// ──────────────────────────────────────────────────────────────
// Project Management API Handlers
// ──────────────────────────────────────────────────────────────

function serveApiProjects(res: ServerResponse, url: URL) {
  try {
    const filter = url.searchParams.get("filter");
    const filters = filter === "active" ? { status: "active" } : undefined;
    const data = getProjects(filters);
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(data, null, 2));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

function serveApiProjectById(res: ServerResponse, id: string, url: URL) {
  try {
    const includeAgents = url.searchParams.get("include_agents") === "true";
    const tree = getProjectById(Number(id));
    if (!tree) {
      res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Project not found" }));
      return;
    }
    const tasks = tree.tasks.map((t) => ({
      ...t,
      agent_ids: [t.coordinator_agent_id, t.orchestrator_agent_id].filter(Boolean),
      subtasks: t.subtasks.map((s) => ({
        ...s,
        agent_ids: [s.worker_agent_id, s.qa_agent_id].filter(Boolean),
      })),
    }));
    let payload: Record<string, unknown> = { project: tree.project, tasks };
    if (includeAgents) {
      const agentIds = getAgentIdsForProject(getPmDb(), Number(id));
      payload = { ...payload, agents: resolveAgentStates(agentIds) };
    }
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(payload, null, 2));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

function serveApiTasks(res: ServerResponse, url: URL) {
  try {
    const filters: { project_id?: number; status?: string; agent_id?: string; active_only?: boolean } = {};
    if (url.searchParams.has("project_id")) filters.project_id = Number(url.searchParams.get("project_id"));
    if (url.searchParams.has("status")) filters.status = url.searchParams.get("status")!;
    if (url.searchParams.has("agent_id")) filters.agent_id = url.searchParams.get("agent_id")!;
    if (url.searchParams.get("filter") === "active") filters.active_only = true;
    const data = getTasks(filters);
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(data, null, 2));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

function serveApiTaskById(res: ServerResponse, id: string, url: URL) {
  try {
    const includeAgents = url.searchParams.get("include_agents") === "true";
    const db = getPmDb();
    const taskRow = getTaskByIdFromDb(db, Number(id));
    if (!taskRow) {
      res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Task not found" }));
      return;
    }
    const details = getTaskWithDetails(db, Number(id));
    const subtasks = details.subtasks.map((s) => ({
      ...s,
      agent_ids: [s.worker_agent_id, s.qa_agent_id].filter(Boolean),
    }));
    let payload: Record<string, unknown> = {
      ...taskRow,
      agent_ids: [taskRow.coordinator_agent_id, taskRow.orchestrator_agent_id].filter(Boolean),
      subtasks,
      blocked_by: details.blocked_by,
      events: details.events,
    };
    if (includeAgents) {
      const agentIds = new Set<string>(payload.agent_ids as string[]);
      for (const s of subtasks) {
        for (const aid of s.agent_ids) if (aid) agentIds.add(aid);
      }
      payload.agents = resolveAgentStates(Array.from(agentIds));
    }
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(payload, null, 2));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

function serveApiSubtasks(res: ServerResponse, url: URL) {
  try {
    const taskId = url.searchParams.get("task_id");
    if (!taskId) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Missing task_id query param" }));
      return;
    }
    const data = getSubtasksByTaskId(Number(taskId));
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(data, null, 2));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

function serveApiDashboardSnapshot(res: ServerResponse, url: URL) {
  try {
    const filter = url.searchParams.get("filter");
    const includeAgents = url.searchParams.get("include_agents") === "true";
    const projectFilters = filter === "active" ? { status: "active" } : undefined;
    const taskFilters = filter === "active"
      ? { status: "in_progress", active_only: true }
      : { status: "in_progress" };
    const activeTasks = getTasks(taskFilters);
    let agentStates: Record<string, AgentRuntimeState | null> | undefined;
    if (includeAgents) {
      const allAgentIds = new Set<string>();
      for (const t of activeTasks) {
        for (const aid of t.agent_ids) if (aid) allAgentIds.add(aid);
      }
      agentStates = resolveAgentStates(Array.from(allAgentIds));
    }
    const data = {
      agents: Array.from(agents.values()).map((a) => ({ ...a })),
      projects: getProjects(projectFilters),
      active_tasks: activeTasks,
      agent_states: agentStates,
    };
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(data, null, 2));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

async function serveApiTelegramOutbound(res: ServerResponse, req: IncomingMessage) {
  if (!ensureMonitorBridgeOwnership("telegram-outbound")) {
    res.writeHead(409, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: false, error: "telegram bridge is owned by another monitor instance" }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const data = JSON.parse(body) as TelegramResponsePayload;
      const normalized = normalizeTelegramOutboundPayload(data);

      if (normalized.lifecycle_event === "router_queued") {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: "status=router_queued is monitor-owned and not accepted on outbound API" }));
        return;
      }

      if (!normalized.text) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: "telegram_message.text or legacy text is required" }));
        return;
      }

      let finalReplyTo = normalized.replyTo;
      let finalChatId = normalized.chatId;
      const pending = normalized.requestId ? getPendingRequest(normalized.requestId) : undefined;
      if (pending) {
        finalReplyTo ??= pending.messageId;
        finalChatId ??= pending.chatId;
      }

      if (!finalChatId) {
        auditTelegramDelivery({
          request_id: normalized.requestId,
          status: "dropped",
          via: "http_outbound",
          error: "missing_chat_id",
        });
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: "chat_id is required (or request_id must resolve to one)" }));
        return;
      }

      console.log(`[telegram-outbound] chat=${finalChatId} reply_to=${finalReplyTo || '-'} request_id=${normalized.requestId || '-'}: ${normalized.text.slice(0, 100)}...`);

      const config = readTelegramConfig();
      if (config.botToken) {
        try {
          auditTelegramDelivery({
            request_id: normalized.requestId,
            status: "attempt",
            via: "http_outbound",
            chat_id: finalChatId,
            reply_to: finalReplyTo,
            target_coordinator: pending?.agentId,
            details: { lifecycle_event: normalized.lifecycle_event, status: normalized.status },
          });

          const sent = await tgSendMessage(config.botToken, finalChatId, normalized.text, {
            replyTo: finalReplyTo,
            parseMode: normalized.parseMode,
          });

          const shouldFinalize = normalized.lifecycle_event === "agent_final";
          if (shouldFinalize && normalized.requestId) finalizePendingRequest(normalized.requestId);
          auditTelegramDelivery({
            request_id: normalized.requestId,
            status: "sent",
            via: "http_outbound",
            chat_id: sent.chatId ?? finalChatId,
            reply_to: finalReplyTo,
            telegram_message_id: sent.messageId,
            target_coordinator: pending?.agentId,
            details: {
              lifecycle_event: normalized.lifecycle_event,
              status: normalized.status,
              ...(sent.raw && typeof sent.raw === "object" ? (sent.raw as Record<string, unknown>) : {}),
            },
          });

          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({
            ok: true,
            delivered: true,
            chat_id: sent.chatId ?? finalChatId,
            reply_to: finalReplyTo ?? null,
            telegram_message_id: sent.messageId ?? null,
          }));
          return;
        } catch (sendErr) {
          const errorText = String(sendErr);
          const terminal = isTerminalTelegramDeliveryError(sendErr);
          const shouldFinalizeOnTerminal = terminal && normalized.lifecycle_event === "agent_final";
          if (shouldFinalizeOnTerminal && normalized.requestId) finalizePendingRequest(normalized.requestId);
          auditTelegramDelivery({
            request_id: normalized.requestId,
            status: terminal ? "failed_terminal" : "failed",
            via: "http_outbound",
            chat_id: finalChatId,
            reply_to: finalReplyTo,
            target_coordinator: pending?.agentId,
            error: errorText,
            details: { lifecycle_event: normalized.lifecycle_event, status: normalized.status },
          });
          res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: false, error: errorText, terminal_failure: terminal }));
          return;
        }
      } else {
        console.log("[telegram-outbound] Telegram not configured — response logged but not sent to chat.");
        auditTelegramDelivery({
          request_id: normalized.requestId,
          status: "failed",
          via: "http_outbound",
          chat_id: finalChatId,
          reply_to: finalReplyTo,
          target_coordinator: pending?.agentId,
          error: "telegram_not_configured",
        });
      }

      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, delivered: false, chat_id: finalChatId, reply_to: finalReplyTo ?? null }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
}

function serveApiPurgeOffline(res: ServerResponse) {
  try {
    const db = getDb();
    const toPurge: MonitoredAgent[] = [];

    for (const agent of agents.values()) {
      if (agent.fabric_status === "offline" || agent.fabric_status === "shutting_down") {
        toPurge.push(agent);
      }
    }

    const purged: string[] = [];
    for (const agent of toPurge) {
      agents.delete(agent.agent_id);
      try {
        db.prepare("DELETE FROM agents WHERE agent_id = ?").run(agent.agent_id);
      } catch {}
      try {
        const pidPath = `${PID_DIR}/${agent.agent_id}.pid`;
        if (existsSync(pidPath)) unlinkSync(pidPath);
      } catch {}
      try {
        const mboxPath = `${MAILBOX_DIR}/${agent.agent_id}.jsonl`;
        if (existsSync(mboxPath)) unlinkSync(mboxPath);
      } catch {}
      try {
        const statePath = `${STATE_DIR}/${agent.agent_id}.json`;
        if (existsSync(statePath)) unlinkSync(statePath);
      } catch {}

      broadcastSSE("agent-removed", { agent_id: agent.agent_id, reason: "purged_offline" });
      monitorLog("info", "purge_offline", { agent_id: agent.agent_id, pane_id: agent.pane_id, pid: agent.pid });
      purged.push(agent.agent_id);
    }

    db.close();
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, purged_count: purged.length, purged }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

function serveApiSubtasksQueue(res: ServerResponse) {
  try {
    const db = getPmDb();

    const ready = db.prepare(`
      SELECT s.*, t.title as task_title, t.id as task_id
      FROM subtasks s
      LEFT JOIN tasks t ON t.id = s.task_id
      WHERE s.status IN ('backlog', 'ready')
        AND NOT EXISTS (
          SELECT 1 FROM subtask_dependencies d
          JOIN subtasks dep ON dep.id = d.depends_on_subtask_id
          WHERE d.subtask_id = s.id AND d.dependency_type = 'blocking' AND dep.status != 'done'
        )
      ORDER BY s.priority DESC, s.sequence_order ASC
    `).all() as Array<SubtaskRow & { task_title: string | null; task_id: number }>;

    const running = db.prepare(`
      SELECT s.*, t.title as task_title, t.id as task_id
      FROM subtasks s
      LEFT JOIN tasks t ON t.id = s.task_id
      WHERE s.status = 'running'
      ORDER BY s.priority DESC, s.sequence_order ASC
    `).all() as Array<SubtaskRow & { task_title: string | null; task_id: number }>;

    const blocked = db.prepare(`
      SELECT s.*, t.title as task_title, t.id as task_id
      FROM subtasks s
      LEFT JOIN tasks t ON t.id = s.task_id
      WHERE s.status = 'blocked'
         OR EXISTS (
           SELECT 1 FROM subtask_dependencies d
           JOIN subtasks dep ON dep.id = d.depends_on_subtask_id
           WHERE d.subtask_id = s.id AND d.dependency_type = 'blocking' AND dep.status != 'done'
         )
      ORDER BY s.priority DESC, s.sequence_order ASC
    `).all() as Array<SubtaskRow & { task_title: string | null; task_id: number }>;

    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({
      ready,
      running,
      blocked,
      counts: {
        ready: ready.length,
        running: running.length,
        blocked: blocked.length,
      },
    }, null, 2));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

function serveApiSubtasksAssignments(res: ServerResponse) {
  const db = getPmDb();
  let attached = false;
  try {
    execWithSqliteRetry(db, `ATTACH DATABASE '${REGISTRY_DB}' AS registry`);
    attached = true;

    const assignments = prepareAllWithRetry(db.prepare(`
      SELECT
        a.subtask_id,
        a.agent_id,
        COALESCE(ag.role, 'unknown') as role,
        a.status,
        a.assigned_at
      FROM subtask_assignments a
      LEFT JOIN registry.agents ag ON ag.agent_id = a.agent_id
      ORDER BY a.assigned_at DESC
    `), []) as Array<{ subtask_id: number; agent_id: string; role: string; status: string; assigned_at: string }>;

    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ assignments }, null, 2));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: String(err) }));
  } finally {
    if (attached) {
      try {
        execWithSqliteRetry(db, `DETACH DATABASE registry`);
      } catch {
        // ignore detach failures
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Router
// ──────────────────────────────────────────────────────────────

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  const agentOutputMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/outputs$/);
  const agentMessageMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/message$/);

  if (url.pathname === "/" && req.method === "GET") {
    serveDashboard(res);
  } else if (agentOutputMatch && req.method === "GET") {
    serveApiAgentOutputs(res, decodeURIComponent(agentOutputMatch[1]), url);
  } else if (agentMessageMatch && req.method === "POST") {
    await serveApiAgentMessage(res, req, decodeURIComponent(agentMessageMatch[1]));
  } else if (url.pathname === "/api/agents" && req.method === "GET") {
    serveApiAgents(res);
  } else if (url.pathname === "/api/metrics" && req.method === "GET") {
    serveApiMetrics(res);
  } else if (url.pathname === "/api/events" && req.method === "GET") {
    serveApiEvents(res, url);
  } else if (url.pathname.startsWith("/api/log/") && req.method === "GET") {
    const agentId = url.pathname.slice("/api/log/".length);
    serveApiLog(res, agentId, url);
  } else if (url.pathname.startsWith("/api/kill/") && req.method === "POST") {
    const agentId = url.pathname.slice("/api/kill/".length);
    serveApiKill(res, agentId);
  } else if (url.pathname.startsWith("/api/healthcheck/") && req.method === "POST") {
    const agentId = url.pathname.slice("/api/healthcheck/".length);
    serveApiHealthcheck(res, agentId);
  } else if (url.pathname === "/api/projects" && req.method === "GET") {
    serveApiProjects(res, url);
  } else if (url.pathname.startsWith("/api/projects/") && req.method === "GET") {
    const id = url.pathname.split("/")[3];
    serveApiProjectById(res, id, url);
  } else if (url.pathname === "/api/tasks" && req.method === "GET") {
    serveApiTasks(res, url);
  } else if (url.pathname.startsWith("/api/tasks/") && req.method === "GET") {
    const id = url.pathname.split("/")[3];
    serveApiTaskById(res, id, url);
  } else if (url.pathname === "/api/subtasks" && req.method === "GET") {
    serveApiSubtasks(res, url);
  } else if (url.pathname === "/api/subtasks/queue" && req.method === "GET") {
    serveApiSubtasksQueue(res);
  } else if (url.pathname === "/api/subtasks/assignments" && req.method === "GET") {
    serveApiSubtasksAssignments(res);
  } else if (url.pathname === "/api/dashboard/snapshot" && req.method === "GET") {
    serveApiDashboardSnapshot(res, url);
  } else if (url.pathname === "/api/events/projects" && req.method === "GET") {
    serveApiProjectsEvents(res, url);
  } else if (url.pathname === "/api/purge-offline" && req.method === "POST") {
    serveApiPurgeOffline(res);
  } else if (url.pathname === "/api/telegram/outbound" && req.method === "POST") {
    serveApiTelegramOutbound(res, req);
  } else if (url.pathname === "/api/chat" && req.method === "GET") {
    serveApiChat(res, url);
  } else if (url.pathname === "/api/stream" && req.method === "GET") {
    serveStream(res);
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

// ──────────────────────────────────────────────────────────────
// fs.watch for events log + state files
// ──────────────────────────────────────────────────────────────

let fabricWatcher: ReturnType<typeof watch> | null = null;

function setupWatchers(): ReturnType<typeof watch> | null {
  // Watch the events log
  if (existsSync(EVENTS_LOG)) {
    const stats = statSync(EVENTS_LOG);
    eventsLogOffset = stats.size;
    lastEventLogSize = stats.size;
  }

  if (existsSync(PROJECTS_EVENTS_LOG)) {
    const stats = statSync(PROJECTS_EVENTS_LOG);
    projectsEventsOffset = stats.size;
    lastProjectsEventLogSize = stats.size;
  }

  try {
    const watcher = watch(FABRIC_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      if ((eventType === "change" || eventType === "rename") && filename === "agents.jsonl") {
        try {
          const events = readNewEvents();
          for (const ev of events) {
            applyEvent(ev);
          }
        } catch (err) {
          if (isRegistryDegradedError(err)) {
            setRegistryDegraded(err);
          } else {
            monitorLog("warn", "agents_events.watch_failed", { error: String(err) });
          }
        }
      }
      if ((eventType === "change" || eventType === "rename") && filename === "projects.jsonl") {
        try {
          const events = readNewProjectEvents();
          for (const ev of events) {
            applyProjectEvent(ev);
          }
        } catch (err) {
          monitorLog("warn", "projects_events.watch_failed", { error: String(err) });
        }
      }
      if ((eventType === "change" || eventType === "rename") && filename.startsWith("outputs/") && extname(filename) === ".jsonl") {
        scanOutputFile(basename(filename, ".jsonl"));
      }
      if ((eventType === "change" || eventType === "rename") && filename.startsWith("state/") && extname(filename) === ".json") {
        const agentId = basename(filename, ".json");
        const agent = agents.get(agentId);
        if (agent) {
          try {
            const statePath = `${STATE_DIR}/${filename}`;
            if (existsSync(statePath)) {
              const state = JSON.parse(readFileSync(statePath, "utf8"));
              if (state.lastFabricStatus) agent.fabric_status = state.lastFabricStatus;
              if (state.pendingCorrelations) agent.pending_correlations = state.pendingCorrelations;
            }
          } catch {
            // ignore
          }
          broadcastSSE("agent-update", agentFromMemory(agentId));
        }
      }
    });

    watcher.on("error", (err) => {
      log("fs.watch error:", err.message);
    });
    fabricWatcher = watcher;
    return watcher;
  } catch (err) {
    log("Failed to setup fs.watch:", (err as Error).message);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// Telegram Bridge Polling
// ──────────────────────────────────────────────────────────────

async function startTelegramPolling() {
  if (!ensureMonitorBridgeOwnership("polling-start")) {
    updateTelegramState(false, "(standby — another monitor owns bridge)");
    log("[telegram] Standby monitor — bridge disabled");
    return;
  }

  let offset = 0;
  const RECONNECT_BASE_MS = 2000;
  const RECONNECT_MAX_MS = 30000;

  log("[telegram] Bridge starting...");

  while (telegramRunning) {
    if (!ensureMonitorBridgeOwnership("polling-loop")) break;

    const config = readTelegramConfig();

    if (!config.botToken) {
      updateTelegramState(false, "(no botToken — run /telegram-setup in pi)");
      const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, telegramBridgeState.reconnectAttempt),
        RECONNECT_MAX_MS
      );
      telegramBridgeState.reconnectAttempt++;
      log(`[telegram] No botToken. Retrying in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    telegramAbortController = new AbortController();

    updateTelegramState(true, "(polling)");

    try {
      while (telegramRunning) {
        if (!ensureMonitorBridgeOwnership("polling-request")) break;

        const updates = await tgGetUpdates(config.botToken, offset, telegramAbortController.signal);
        for (const update of updates) {
          offset = update.update_id + 1;
          const msg = update.message;
          if (!msg || !msg.text) continue;

          if (config.allowedUserId && msg.from?.id !== config.allowedUserId) {
            await tgSendMessage(config.botToken, msg.chat.id, "⛔ Not authorized.");
            continue;
          }

          const text: string = msg.text;
          const chatId: number = msg.chat.id;
          const messageId: number = msg.message_id;
          const userId: number | undefined = msg.from?.id;

          const coordinatorSnapshot = getActiveCoordinators();
          const activeProjects = getActiveProjects();
          const agentInfos = coordinatorSnapshot.map((a) => ({
            agent_id: a.agent_id,
            role: a.role,
            fabric_status: a.fabric_status,
            current_task: a.current_task,
          }));

          await processTelegramMessage(
            config.botToken,
            chatId,
            text,
            messageId,
            userId,
            agentInfos,
            activeProjects,
            "secretary"
          );
        }

        // Normal poll interval between successful requests
        await waitForSigusr1OrTimeout(2000);

        if (!ensureMonitorBridgeOwnership("polling-idle-wait")) break;
      }
    } catch (err) {
      if (!telegramRunning || (err as Error).name === "AbortError") break;

      if (!ensureMonitorBridgeOwnership("polling-error")) break;

      const errMsg = (err as Error).message;
      updateTelegramState(false, "(error — reconnecting)", errMsg);
      log("[telegram] Polling error:", errMsg);

      // Exponential backoff
      const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, telegramBridgeState.reconnectAttempt),
        RECONNECT_MAX_MS
      );
      telegramBridgeState.reconnectAttempt++;
      log(`[telegram] Reconnecting in ${delay / 1000}s (attempt ${telegramBridgeState.reconnectAttempt})...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  updateTelegramState(false, "(stopped)");
  log("[telegram] Polling stopped.");
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

function main() {
  // Ensure fabric directory exists so fs.watch and DB work
  if (!existsSync(FABRIC_DIR)) {
    mkdirSync(FABRIC_DIR, { recursive: true });
  }

  if (!tryAcquireMonitorInstance()) {
    process.exit(1);
    return;
  }

  if (!existsSync(EVENTS_LOG)) {
    try { appendFileSync(EVENTS_LOG, "", { flag: "a" }); } catch {}
  }
  if (!existsSync(PROJECTS_EVENTS_LOG)) {
    try { appendFileSync(PROJECTS_EVENTS_LOG, "", { flag: "a" }); } catch {}
  }
  if (!existsSync(OUTPUTS_DIR)) {
    try { mkdirSync(OUTPUTS_DIR, { recursive: true }); } catch {}
  }

  // Initialize project DB
  try {
    initProjectsDb();
    const existing = getProjects();
    if (existing.length === 0) {
      seedProjectsDb();
      log("Projects DB seeded");
    } else {
      log(`Projects DB already has ${existing.length} project(s)`);
    }
  } catch (err) {
    log("Warning: could not init projects DB:", (err as Error).message);
  }

  // Initial load
  try {
    drainRuntimeEvents();
    refreshAgentsFromDb();
    clearRegistryDegraded();
    log(`Loaded ${agents.size} agents from registry`);
  } catch (err) {
    if (isRegistryDegradedError(err)) {
      setRegistryDegraded(err);
    }
    log("Warning: could not load agents from registry:", (err as Error).message);
    log("Will populate on-the-fly when events arrive.");
  }

  scanOutputsDirectory(true);
  const watcher = setupWatchers();

  // fs.watch fallback for agent output files (macOS /tmp can miss events)
  const outputPollingTimer = setInterval(() => scanOutputsDirectory(false), 2000);

  // Watchdog
  const watchdogTimer = setInterval(runWatchdog, WATCHDOG_INTERVAL_MS);

  // Background DB sync — keeps in-memory agents Map aligned with registry
  const dbSyncTimer = setInterval(() => {
    try {
      drainRuntimeEvents();
      refreshAgentsFromDb();
      clearRegistryDegraded();
      // Check and truncate runtime events log if needed (every 10s)
      truncateRuntimeEventsLog();
    } catch (err) {
      if (isRegistryDegradedError(err)) {
        setRegistryDegraded(err);
        return;
      }
      throw err;
    }
  }, 10000);

  // Keep monitor PID file fresh so mailbox senders can always wake the live process.
  const monitorPidHeartbeat = setInterval(() => {
    if (!ensureMonitorBridgeOwnership("pid-heartbeat")) return;
    try {
      writeFileSync(MONITOR_PID_FILE, String(process.pid));

      const instanceOwner = readMonitorInstanceOwner();
      if (!instanceOwner.pid || instanceOwner.pid === process.pid) {
        writeFileSync(MONITOR_INSTANCE_LOCK, JSON.stringify({
          pid: process.pid,
          port: PORT,
          acquired_at: new Date().toISOString(),
        }));
      }
    } catch (err) {
      log("[monitor] Failed to refresh PID file:", (err as Error).message);
    }
  }, 10000);

  // Graceful shutdown on Ctrl+C / SIGTERM
  function gracefulShutdown(signal: string) {
    log(`\n[shutdown] Received ${signal}, shutting down gracefully...`);

    // Stop Telegram bridge
    telegramRunning = false;
    if (telegramAbortController) {
      try {
        telegramAbortController.abort();
        log("[shutdown] Telegram bridge abort signal sent");
      } catch { /* ignore */ }
    }

    // Stop accepting new connections
    server.close(() => {
      log("[shutdown] HTTP server closed");
    });

    // Close SSE clients
    for (const client of clients.values()) {
      try {
        client.res.end();
      } catch { /* ignore */ }
    }
    clients.clear();

    // Stop fs watcher
    if (watcher) {
      try {
        watcher.close();
        log("[shutdown] File watcher closed");
      } catch { /* ignore */ }
    }

    // Stop intervals
    clearInterval(watchdogTimer);
    clearInterval(dbSyncTimer);
    clearInterval(monitorPidHeartbeat);
    clearInterval(outputPollingTimer);

    // Give async tasks a moment to finish, then exit
    setTimeout(() => {
      releaseMonitorBridge();
      releaseMonitorInstance();
      log("[shutdown] Bye 👋");
      process.exit(0);
    }, 500);
  }

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  if (!tryAcquireMonitorBridge()) {
    log("[monitor] Fatal: could not acquire Telegram/mailbox bridge despite holding instance lock. Exiting.");
    releaseMonitorInstance();
    process.exit(1);
    return;
  }

  // Setup monitor mailbox (so agents can reply back via mailbox+SIGUSR1)
  initMonitorMailbox();

  // SIGUSR1 handler for monitor's own mailbox
  process.on("SIGUSR1", () => {
    // Check if it's for the monitor's mailbox
    processMonitorMailbox().catch((err) => {
      log("[monitor] SIGUSR1 mailbox error:", (err as Error).message);
    });
  });

  server.listen(PORT, HOST, () => {
    log(`🧠 Fabric Monitor listening on http://${HOST}:${PORT}`);
    log(`Dashboard: http://${HOST}:${PORT}/`);
    log(`API agents: http://${HOST}:${PORT}/api/agents`);
    log(`SSE stream: http://${HOST}:${PORT}/api/stream`);
    log(`Telegram outbound: http://${HOST}:${PORT}/api/telegram/outbound`);
  });

  // Start Telegram bridge (async — does not block server)
  startTelegramPolling().catch((err) => {
    log("[telegram] Fatal:", err);
  });
}

main();
