import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { DatabaseSync } from "node:sqlite";
import { execSync, spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import {
  writeAnalysis,
  readAnalyses,
  latestAnalysis,
  invalidateAnalysis,
  getAgentContext,
  getHumanSummary,
  buildTaskContextForAgent,
  type TaskAnalysisRow,
} from "../pm/analyses.js";
import {
  ensureRegistrySchema,
  openFabricDb,
  openFabricDbReadOnly,
  prepareAllWithRetry,
  prepareRunWithRetry,
} from "./sqlite-utils.js";
import { appendRuntimeEvent } from "./runtime-events.js";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

type FabricMessageType =
  | "message"
  | "contract"
  | "healthcheck"
  | "response"
  | "chat"
  | "telegram_request"
  | "telegram_user_message"
  | "telegram_response"
  | "telegram_agent_response"
  | "task";

type FabricStatus =
  | "registering"
  | "idle"
  | "queued"
  | "processing_inbox"
  | "agent_starting"
  | "processing"
  | "turn_active"
  | "waiting_llm"
  | "streaming"
  | "thinking"
  | "tool_running"
  | "tool_blocked"
  | "compacting"
  | "waiting_response"
  | "error"
  | "shutting_down";

interface FabricMessage {
  message_id: string;
  from: string;
  to: string;
  type: FabricMessageType;
  correlation_id?: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

interface AgentStateFile {
  lastOffset: number;
  lastProcessed: number;
  pendingCorrelations: string[];
  lastFabricStatus: FabricStatus;
}

// ──────────────────────────────────────────────────────────────
// Config from env
// ──────────────────────────────────────────────────────────────

const ENABLED = process.env.ENABLE_CMD_CENTER === "TRUE";
const ROLE = process.env.FABRIC_ROLE;
const AGENT_ID = process.env.PI_AGENT_ID || "";
const PANE_ID = process.env.FABRIC_PANE_ID || process.env.TMUX_PANE || "";
const SESSION = process.env.FABRIC_SESSION || "";
const MODE = process.env.FABRIC_MODE || "rpc";
const MODEL = process.env.FABRIC_MODEL || "unknown";

const FABRIC_DIR = "/tmp/fabric-agents";
const REGISTRY_DB = process.env.FABRIC_REGISTRY_DB || `${FABRIC_DIR}/registry.sqlite`;
const MAILBOX_DIR = process.env.FABRIC_MAILBOX_DIR || `${FABRIC_DIR}/mailboxes`;
const PID_DIR = process.env.FABRIC_PID_DIR || `${FABRIC_DIR}/pids`;
const STATE_DIR = process.env.FABRIC_STATE_DIR || `${FABRIC_DIR}/state`;
const EVENTS_LOG = `${FABRIC_DIR}/agents.jsonl`;
const OUTPUTS_DIR = process.env.FABRIC_OUTPUTS_DIR || `${FABRIC_DIR}/outputs`;
const RUNTIME_EVENTS_LOG = `${FABRIC_DIR}/runtime-events.jsonl`;

// Modo agente: solo cuando PI_AGENT_ID fue seteado explícitamente por el launcher.
// Esto evita que cualquier sesión pi con ENABLE_CMD_CENTER=TRUE se registre como
// agente zombie cuando el usuario abre pi manualmente en otro directorio.
const IS_AGENT_MODE = ENABLED && !!AGENT_ID && !!ROLE;

// ──────────────────────────────────────────────────────────────
// Globals (per extension instance = per pi process)
// ──────────────────────────────────────────────────────────────

let unreadCount = 0;
let inboxProcessing = false;
let activeCtx: ExtensionContext | null = null;
let shutdownRequested = false;

let currentFabricStatus: FabricStatus = "registering";
let activeToolName: string | null = null;
let isStreaming = false;
let isThinking = false;
let queuedCount = 0;
const pendingCorrelations: string[] = [];
let currentModel = MODEL; // env var inicial; se actualiza desde ctx.model
let lastKnownRuntimeTask: string | null = null;
let lastKnownRuntimeError: string | null = null;

// Pending messages captured during SIGUSR1 when ctx might not be ready
const pendingMessages: FabricMessage[] = [];

// Reference to ExtensionAPI for sendUserMessage / sendMessage injection
let fabricApi: ExtensionAPI | null = null;

// ── Telegram bridge integration ──
// When a telegram_request/telegram_user_message arrives, we keep routing context
// plus the latest assistant text. Primary path: explicit
// fabric_send_message(...telegram_agent_response|telegram_response).
// Fallback path: auto-dispatch latest assistant text at turn_end if the model
// forgot to call the tool.
type TelegramTurnContext = {
  chatId?: number;
  replyTo?: number;
  requestId?: string;
  awaitingResponse: boolean;
  responseSent: boolean;
  ackSent: boolean;
};

type QueuedTelegramUserMessage = {
  text: string;
  chatId: number;
  replyTo?: number;
  requestId: string;
  queuePriority: string;
  turnPolicy: string;
  interruptCurrentTurn: boolean;
  ackWhenDequeued: boolean;
  ackRequired: boolean;
};

let telegramContext: TelegramTurnContext | null = null;
let telegramMessageAccumulator: string = "";
let telegramCompletedMessages: string[] = [];
let telegramContextTimeout: ReturnType<typeof setTimeout> | null = null;
const TELEGRAM_CONTEXT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const telegramUserMessageQueue: QueuedTelegramUserMessage[] = [];
let turnInProgress = false;
const shouldClearTelegramContext = (status: unknown): boolean => {
  if (typeof status !== "string") return true;
  return status === "final" || status === "blocked" || status === "error";
};

function clearTelegramContext() {
  telegramContext = null;
  telegramMessageAccumulator = "";
  telegramCompletedMessages = [];
  if (telegramContextTimeout) {
    clearTimeout(telegramContextTimeout);
    telegramContextTimeout = null;
  }
}

function refreshTelegramContext() {
  if (telegramContextTimeout) clearTimeout(telegramContextTimeout);
  telegramContextTimeout = setTimeout(clearTelegramContext, TELEGRAM_CONTEXT_TTL_MS);
}

function captureTelegramAssistantMessage(message: any) {
  if (!telegramContext?.awaitingResponse || telegramContext.responseSent) return;
  if (message?.role !== "assistant") return;

  const { content } = extractAssistantText(message);
  const trimmed = content.trim();
  if (!trimmed) return;

  telegramMessageAccumulator = trimmed;
  telegramCompletedMessages.push(trimmed);
  refreshTelegramContext();
}

async function sendTelegramResponse(
  payload: Record<string, unknown>,
  context: { chatId?: number; replyTo?: number; requestId?: string }
): Promise<boolean> {
  const monitorPort = process.env.FABRIC_MONITOR_PORT || "7474";
  const outbound = {
    ...payload,
    request_id: payload.request_id ?? context.requestId,
    chat_id: payload.chat_id ?? context.chatId,
    reply_to: payload.reply_to ?? context.replyTo,
  };

  console.log(
    `[fabric-telegram] sendTelegramResponse: chat=${String(outbound.chat_id ?? '-')} reply_to=${String(outbound.reply_to ?? '-')} req_id=${String(outbound.request_id ?? '-')} text_len=${String((outbound.telegram_message as any)?.text ?? outbound.text ?? '').length}`
  );

  try {
    const res = await fetch(`http://127.0.0.1:${monitorPort}/api/telegram/outbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outbound),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${raw}`);
    console.log(`[fabric-telegram] sendTelegramResponse: OK ${raw}`);
    return true;
  } catch (err) {
    console.error("[fabric-telegram] Failed to send Telegram response:", err);
    return false;
  }
}

async function flushTelegramFallback(reason: string): Promise<boolean> {
  if (!telegramContext?.awaitingResponse || telegramContext.responseSent) return false;

  const text = telegramMessageAccumulator.trim();
  if (!text) return false;

  const ok = await sendTelegramResponse({
    channel: "telegram",
    status: "final",
    text,
    sender: {
      agent_id: AGENT_ID,
      role: ROLE,
      display_name: AGENT_ID,
    },
    telegram_message: {
      text,
      format: "plain",
      include_sender_header: true,
    },
  }, telegramContext);
  if (ok) {
    console.log(`[fabric-telegram] Fallback delivered via ${reason}`);
    clearTelegramContext();
    return true;
  }

  return false;
}

function isTelegramTurnBlocked(): boolean {
  if (turnInProgress) return true;
  if (isStreaming || isThinking) return true;
  if (activeToolName) return true;
  const blockedStatuses = new Set<FabricStatus>([
    "agent_starting",
    "processing",
    "turn_active",
    "waiting_llm",
    "streaming",
    "thinking",
    "tool_running",
    "compacting",
  ]);
  return blockedStatuses.has(currentFabricStatus);
}

function buildTelegramInstructionsFromQueue(msg: QueuedTelegramUserMessage): string {
  const coordinationGuardrails = isCoordinationIntentTelegram(msg.text)
    ? `\nREGLAS EXTRA PARA ESTE MENSAJE (coordinación/delegación detectada):\n` +
      `1. Tu PRIMER resultado debe ser un plan breve al humano por Telegram; no saltes directo a editar código localmente.\n` +
      `2. Si el pedido implica delegar, crear agente, cambiar el plan, rollback o cierre con git/PR, primero delegá con contrato claro y mantené ownership correcto.\n` +
      `3. Si la tarea ya pertenece a un sub-coordinador, no pises su worktree desde acá salvo cancelación o reasignación explícita.\n` +
      `4. Commit/push/gh pr create se delegan al agente git; no los hagas ad-hoc desde el coordinator.\n\n`
    : "";

  return (
    `\n\n---📬 TELEGRAM CHANNEL CONTRACT---\n` +
    `This message came from Telegram chat ${msg.chatId}.\n` +
    `Queue policy: priority=${msg.queuePriority}, turn_policy=${msg.turnPolicy}, interrupt_current_turn=${String(msg.interruptCurrentTurn)}, ack_when_dequeued=${String(msg.ackWhenDequeued)}.\n` +
    `Do not interrupt active LLM/tool turn. Reply on next safe turn.\n` +
    coordinationGuardrails +
    `When responding, use fabric_send_message to monitor with preferred type \"telegram_agent_response\".\n` +
    `Required payload fields:\n` +
    `- status: "ack" when dequeued/start-processing, "final" for successful completion, or "blocked"/"error" for terminal failures\n` +
    `- sender.agent_id\n` +
    `- sender.role\n` +
    `- telegram_message.text\n` +
    `Optional payload fields:\n` +
    `- sender.display_name\n` +
    `- telegram_message.format: \"telegram_markdown\" | \"plain\"\n` +
    `- telegram_message.include_sender_header: true|false\n` +
    `Legacy compatibility: payload.text still works as telegram_response.\n\n` +
    `Example:\n` +
    `fabric_send_message({\n` +
    `  to: \"monitor\",\n` +
    `  type: \"telegram_agent_response\",\n` +
    `  payload: {\n` +
    `    request_id: \"${msg.requestId}\",\n` +
    `    chat_id: ${msg.chatId},\n` +
    `    reply_to: ${msg.replyTo ?? "undefined"},\n` +
    `    status: \"final\",\n` +
    `    sender: { agent_id: \"${AGENT_ID}\", role: \"${ROLE}\", display_name: \"${AGENT_ID}\" },\n` +
    `    telegram_message: { format: \"telegram_markdown\", include_sender_header: true, text: \"<human response>\" }\n` +
    `  }\n` +
    `})\n` +
    `--------------------------------`
  );
}

function tryDequeueTelegramUserMessage(reason: string): boolean {
  if (telegramUserMessageQueue.length === 0) return false;
  if (!fabricApi || !activeCtx) return false;
  if (isTelegramTurnBlocked()) return false;

  const next = telegramUserMessageQueue.shift()!;

  clearTelegramContext();
  telegramContext = {
    chatId: next.chatId,
    replyTo: next.replyTo,
    requestId: next.requestId,
    awaitingResponse: true,
    responseSent: false,
    ackSent: false,
  };
  refreshTelegramContext();

  if (next.ackRequired && telegramContext && !telegramContext.ackSent) {
    const ackText = `agent_ack: ${AGENT_ID} started processing your queued request.`;
    void sendTelegramResponse({
      channel: "telegram",
      status: "ack",
      sender: {
        agent_id: AGENT_ID,
        role: ROLE,
        display_name: AGENT_ID,
      },
      telegram_message: {
        text: ackText,
        format: "plain",
        include_sender_header: true,
      },
    }, telegramContext).then((ackOk) => {
      if (ackOk && telegramContext && telegramContext.requestId === next.requestId) {
        telegramContext.ackSent = true;
      }
    });
  }

  try {
    fabricApi.sendUserMessage(
      `[telegram] ${next.text}${buildTelegramInstructionsFromQueue(next)}`,
      { deliverAs: "followUp" }
    );
    console.log(`[fabric-telegram] dequeued telegram_user_message req=${next.requestId} reason=${reason}`);
    return true;
  } catch {
    telegramUserMessageQueue.unshift(next);
    return false;
  }
}

// ── Metrics timers ──
let llmRequestAt = 0;
let toolStartAt = 0;
let turnStartAt = 0;
let agentStartAt = 0;

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function ensureDirs() {
  for (const d of [FABRIC_DIR, MAILBOX_DIR, PID_DIR, STATE_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

function withRegistryReadDb<T>(fn: (db: DatabaseSync) => T): T {
  ensureDirs();
  const db = openFabricDbReadOnly(REGISTRY_DB);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// ── Runtime registry emission helpers ──
function emitRuntimeRegistryEvent(type: string, overrides?: { status?: string; fabricStatus?: FabricStatus; currentTask?: string | null; lastError?: string | null }) {
  if (!AGENT_ID) return;
  appendRuntimeEvent(RUNTIME_EVENTS_LOG, {
    type,
    agent_id: AGENT_ID,
    payload: {
      role: ROLE,
      pane_id: PANE_ID,
      session: SESSION,
      pid: process.pid,
      model: currentModel,
      status: overrides?.status ?? "active",
      fabric_status: overrides?.fabricStatus ?? currentFabricStatus,
      current_task: overrides?.currentTask ?? null,
      pending_correlations: pendingCorrelations,
      last_error: overrides?.lastError ?? null,
      is_streaming: isStreaming,
      is_thinking: isThinking,
      active_tool: activeToolName,
      queue_length: queuedCount,
    },
  });
}

function getMailboxPath(agentId: string) {
  return `${MAILBOX_DIR}/${agentId}.jsonl`;
}

function getStatePath(agentId: string) {
  return `${STATE_DIR}/${agentId}.json`;
}

function getPidPath(agentId: string) {
  return `${PID_DIR}/${agentId}.pid`;
}

type TerminalCompletionStatus = "done" | "failed" | "blocked";

export type ChildAgentCleanupTarget = {
  agentId: string;
  role?: string | null;
  mode?: string | null;
  paneId?: string | null;
  session?: string | null;
  pid?: number | null;
};

export type ChildAgentCleanupResult = {
  cleaned: boolean;
  agentId: string;
  killedPane: boolean;
  signaledPid: boolean;
  removedArtifacts: string[];
  registryDeleted: boolean;
  errors: string[];
};

export type ChildAgentCleanupOptions = {
  runCommand?: (command: string) => void;
  signalPid?: (pid: number, signal: NodeJS.Signals) => void;
  removePath?: (path: string) => void;
  appendRuntimeCleanupEvent?: (event: { type: string; agent_id: string; payload: Record<string, unknown> }) => void;
  deleteRegistryAgent?: (agentId: string) => void;
  resolveArtifactPaths?: (agentId: string) => string[];
};

const PROTECTED_AUTO_CLEANUP_ROLES = new Set(["coordinator", "sub-coordinator"]);

function toOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function isTerminalCompletionStatus(value: unknown): value is TerminalCompletionStatus {
  return value === "done" || value === "failed" || value === "blocked";
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function defaultCleanupArtifactPaths(agentId: string): string[] {
  return [
    getPidPath(agentId),
    getStatePath(agentId),
    getMailboxPath(agentId),
    `${FABRIC_DIR}/launch-scripts/${safeAgentFileName(agentId)}.sh`,
  ];
}

function deleteRegistryAgentRecord(agentId: string): void {
  ensureDirs();
  const db = openFabricDb(REGISTRY_DB);
  try {
    ensureRegistrySchema(db);
    prepareRunWithRetry(db.prepare("DELETE FROM agents WHERE agent_id = ?"), [agentId]);
  } finally {
    db.close();
  }
}

export function shouldAutoCleanupCompletedRpcWorker(input: {
  agentId?: unknown;
  role?: unknown;
  mode?: unknown;
  status?: unknown;
}): boolean {
  const agentId = toOptionalString(input.agentId);
  const role = (toOptionalString(input.role) ?? "").toLowerCase();
  const mode = (toOptionalString(input.mode) ?? "").toLowerCase();
  const status = (toOptionalString(input.status) ?? "").toLowerCase();

  if (!agentId || agentId === AGENT_ID) return false;
  if (!isTerminalCompletionStatus(status)) return false;
  if (mode !== "rpc") return false;
  if (!role) return false;
  if (PROTECTED_AUTO_CLEANUP_ROLES.has(role)) return false;

  return true;
}

export function cleanupChildAgentResources(
  target: ChildAgentCleanupTarget,
  options: ChildAgentCleanupOptions = {}
): ChildAgentCleanupResult {
  const agentId = toOptionalString(target.agentId);
  const role = toOptionalString(target.role);
  const mode = toOptionalString(target.mode);
  const paneId = toOptionalString(target.paneId);
  const session = toOptionalString(target.session);
  const pid = toOptionalNumber(target.pid);
  const errors: string[] = [];
  const removedArtifacts: string[] = [];

  if (!agentId) {
    return {
      cleaned: false,
      agentId: "unknown",
      killedPane: false,
      signaledPid: false,
      removedArtifacts,
      registryDeleted: false,
      errors: ["missing_agent_id"],
    };
  }

  const runCommand = options.runCommand ?? ((command: string) => {
    execSync(command, { stdio: "pipe" });
  });
  const signalPid = options.signalPid ?? ((targetPid: number, signal: NodeJS.Signals) => {
    process.kill(targetPid, signal);
  });
  const removePath = options.removePath ?? ((path: string) => {
    rmSync(path, { force: true });
  });
  const appendRuntimeCleanupEvent = options.appendRuntimeCleanupEvent ?? ((event: {
    type: string;
    agent_id: string;
    payload: Record<string, unknown>;
  }) => {
    appendRuntimeEvent(RUNTIME_EVENTS_LOG, event);
  });
  const deleteRegistryAgent = options.deleteRegistryAgent ?? deleteRegistryAgentRecord;
  const artifactPaths = (options.resolveArtifactPaths ?? defaultCleanupArtifactPaths)(agentId);

  let killedPane = false;
  if (paneId) {
    try {
      runCommand(`tmux kill-pane -t ${shellEscape(paneId)}`);
      killedPane = true;
    } catch (err) {
      errors.push(`kill_pane_failed:${String(err)}`);
    }
  }

  let signaledPid = false;
  if (!killedPane && pid) {
    try {
      signalPid(pid, "SIGTERM");
      signaledPid = true;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== "ESRCH") {
        errors.push(`signal_pid_failed:${String(err)}`);
      }
    }
  }

  for (const path of artifactPaths) {
    try {
      removePath(path);
      removedArtifacts.push(path);
    } catch (err) {
      errors.push(`remove_artifact_failed:${path}:${String(err)}`);
    }
  }

  let registryDeleted = false;
  try {
    deleteRegistryAgent(agentId);
    registryDeleted = true;
  } catch (err) {
    errors.push(`delete_registry_failed:${String(err)}`);
  }

  const cleanupPayload = {
    role,
    mode,
    pane_id: paneId ?? "",
    session: session ?? "",
    pid: pid ?? null,
  };

  try {
    appendRuntimeCleanupEvent({
      type: "agent.offline",
      agent_id: agentId,
      payload: {
        ...cleanupPayload,
        status: "offline",
        fabric_status: "offline",
      },
    });
  } catch (err) {
    errors.push(`append_offline_event_failed:${String(err)}`);
  }

  try {
    appendRuntimeCleanupEvent({
      type: "agent.removed",
      agent_id: agentId,
      payload: {
        ...cleanupPayload,
        reason: "auto_cleanup_after_terminal_response",
      },
    });
  } catch (err) {
    errors.push(`append_removed_event_failed:${String(err)}`);
  }

  appendGlobalEvent({
    type: "agent.child_auto_cleanup",
    agent_id: AGENT_ID || "system",
    payload: {
      child_agent_id: agentId,
      child_role: role,
      child_mode: mode,
      child_pane_id: paneId,
      child_session: session,
      child_pid: pid,
      killed_pane: killedPane,
      signaled_pid: signaledPid,
      registry_deleted: registryDeleted,
      removed_artifacts: removedArtifacts,
      errors,
    },
  });

  return {
    cleaned: errors.length === 0,
    agentId,
    killedPane,
    signaledPid,
    removedArtifacts,
    registryDeleted,
    errors,
  };
}

function readState(): AgentStateFile {
  const path = getStatePath(AGENT_ID);
  if (!existsSync(path)) return { lastOffset: 0, lastProcessed: 0, pendingCorrelations: [], lastFabricStatus: "idle" };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AgentStateFile;
  } catch {
    return { lastOffset: 0, lastProcessed: 0, pendingCorrelations: [], lastFabricStatus: "idle" };
  }
}

function writeState(offset: number) {
  writeFileSync(
    getStatePath(AGENT_ID),
    JSON.stringify({
      lastOffset: offset,
      lastProcessed: Date.now(),
      pendingCorrelations,
      lastFabricStatus: currentFabricStatus,
    })
  );
}

function appendEvent(type: string, agentId: string, payload: Record<string, unknown>) {
  const eventId = `evt-${Date.now()}-${randomUUID().slice(0, 4)}`;

  appendGlobalEvent({
    event_id: eventId,
    type,
    agent_id: agentId,
    payload,
  });

  appendRuntimeEvent(RUNTIME_EVENTS_LOG, {
    type: "registry.event",
    agent_id: agentId,
    payload: {
      event_type: type,
      payload,
    },
  });
}

function appendGlobalEvent(event: Record<string, unknown>) {
  const line = JSON.stringify({ ...event, ts: new Date().toISOString() }) + "\n";
  try {
    appendFileSync(EVENTS_LOG, line);
  } catch {
    // ignore
  }
}

function appendMetric(metric: string, value: number, context?: Record<string, unknown>) {
  appendGlobalEvent({
    type: "agent.metric",
    agent_id: AGENT_ID,
    payload: {
      metric,
      value,
      context: { model: currentModel, ...(context || {}) },
    },
  });
}

function safeAgentFileName(agentId: string) {
  return agentId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function timestampToIso(value: unknown): string {
  const raw = typeof value === "number" || typeof value === "string" ? value : Date.now();
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function extractAssistantText(message: any): { content: string; isError: boolean } {
  if (message?.errorMessage) {
    return { content: `[Error] ${String(message.errorMessage)}`, isError: true };
  }

  const rawContent = message?.content;
  if (typeof rawContent === "string") {
    return { content: rawContent, isError: false };
  }

  if (Array.isArray(rawContent)) {
    const text = rawContent
      .filter((block: any) => block?.type === "text")
      .map((block: any) => String(block.text ?? ""))
      .filter((text: string) => text.trim().length > 0)
      .join("\n\n");
    return { content: text, isError: false };
  }

  return { content: "", isError: false };
}

function persistAgentOutput(message: any) {
  if (!IS_AGENT_MODE || !AGENT_ID) return;
  if (message?.role !== "assistant") return;

  const { content, isError } = extractAssistantText(message);
  const trimmed = content.trim();
  if (!trimmed) return;

  try {
    if (!existsSync(OUTPUTS_DIR)) mkdirSync(OUTPUTS_DIR, { recursive: true });

    const output = {
      agent_id: AGENT_ID,
      timestamp: timestampToIso(message.timestamp),
      content: trimmed.length > 50_000 ? `${trimmed.slice(0, 50_000)}\n\n…[truncated]` : trimmed,
      model: message.model
        ? `${message.provider ? `${message.provider}/` : ""}${message.model}`
        : currentModel,
      stopReason: message.stopReason ?? "unknown",
      isError,
    };

    appendFileSync(`${OUTPUTS_DIR}/${safeAgentFileName(AGENT_ID)}.jsonl`, JSON.stringify(output) + "\n");
    appendGlobalEvent({
      type: "agent.output",
      agent_id: AGENT_ID,
      payload: {
        timestamp: output.timestamp,
        preview: output.content.slice(0, 200),
        isError,
        model: output.model,
        stopReason: output.stopReason,
      },
    });
  } catch {
    // Never break the pi agent flow because observability persistence failed.
  }
}

function setFabricStatus(
  newStatus: FabricStatus,
  task?: string,
  error?: string
) {
  if (!ENABLED || !AGENT_ID) return;
  const from = currentFabricStatus;
  const nextTask = task ?? null;
  const nextError = error ?? null;

  if (
    from === newStatus &&
    nextTask === lastKnownRuntimeTask &&
    nextError === lastKnownRuntimeError
  ) {
    return;
  }

  currentFabricStatus = newStatus;
  lastKnownRuntimeTask = nextTask;
  lastKnownRuntimeError = nextError;

  emitRuntimeRegistryEvent("agent.status_runtime", {
    status: newStatus === "shutting_down" ? "offline" : "active",
    fabricStatus: newStatus,
    currentTask: nextTask,
    lastError: nextError,
  });

  appendGlobalEvent({
    event_id: `evt-${Date.now()}-${randomUUID().slice(0, 4)}`,
    type: "agent.status_change",
    agent_id: AGENT_ID,
    payload: {
      from,
      to: newStatus,
      task: nextTask,
      details: {
        model: currentModel,
        queue_length: queuedCount,
        active_tool: activeToolName,
        is_streaming: isStreaming,
        is_thinking: isThinking,
        pending_correlations_count: pendingCorrelations.length,
      },
    },
  });

  updateFooter();
}

function updateFooter() {
  if (!activeCtx) return;
  const statusIcon: Record<FabricStatus, string> = {
    registering: "🟡",
    idle: "🟢",
    queued: "📬",
    processing_inbox: "📥",
    agent_starting: "🚀",
    processing: "🔵",
    turn_active: "🔵",
    waiting_llm: "⏳",
    streaming: "🟣",
    thinking: "🧠",
    tool_running: "🔨",
    tool_blocked: "🚫",
    compacting: "🗜️",
    waiting_response: "📨",
    error: "🔴",
    shutting_down: "⚪",
  };
  const icon = statusIcon[currentFabricStatus] || "⚪";
  const text = `${icon} ${AGENT_ID} | ${ROLE} | ${currentFabricStatus}${queuedCount > 0 ? ` | 📬${queuedCount}` : ""}${activeToolName ? ` | 🔨${activeToolName}` : ""}`;
  activeCtx.ui.setStatus("cmd-center", text);
}

function registerSelf() {
  if (!AGENT_ID) return; // dev mode — not launched via fabric launcher
  const pid = process.pid;
  lastKnownRuntimeTask = "Initializing fabric agent";
  lastKnownRuntimeError = null;

  emitRuntimeRegistryEvent("agent.registered", {
    status: "active",
    fabricStatus: currentFabricStatus,
    currentTask: lastKnownRuntimeTask,
    lastError: null,
  });

  writeFileSync(getPidPath(AGENT_ID), String(pid));

  const mbox = getMailboxPath(AGENT_ID);
  if (!existsSync(mbox)) {
    writeFileSync(mbox, "", { flag: "a" });
  }

  appendEvent("agent.registered", AGENT_ID, {
    pane_id: PANE_ID,
    session: SESSION,
    mode: MODE,
    model: currentModel,
    pid,
  });
}

function heartbeat() {
  if (!AGENT_ID) return;
  try {
    const pid = process.pid;
    emitRuntimeRegistryEvent("agent.heartbeat", { status: "active", fabricStatus: currentFabricStatus });
    writeFileSync(getPidPath(AGENT_ID), String(pid));
  } catch {
    // ignore — registry may be locked transiently
  }
}

function markSelfOffline() {
  if (!AGENT_ID) return;
  try {
    emitRuntimeRegistryEvent("agent.offline", { status: "offline", fabricStatus: "shutting_down" });
    appendEvent("agent.offline", AGENT_ID, { pid: process.pid });
  } catch {
    // ignore during shutdown
  }
}

function formatPayloadForPrompt(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatAcceptanceCriteriaForPrompt(criteria: unknown): string {
  if (!Array.isArray(criteria)) return "";
  return criteria
    .map((criterion, index) => {
      if (criterion && typeof criterion === "object") {
        const c = criterion as Record<string, unknown>;
        const id = String(c.id ?? `c${index + 1}`);
        const required = c.required === false ? "optional" : "required";
        const description = String(c.description ?? "No description provided");
        const type = String(c.type ?? "manual");
        return `- ${id} (${required}, ${type}): ${description}\n  params: ${formatPayloadForPrompt(c.params ?? {})}`;
      }
      return `- ${String(criterion)}`;
    })
    .join("\n");
}

function formatVerificationResultsForPrompt(results: unknown): string {
  if (!Array.isArray(results) || results.length === 0) return "";
  return results
    .map((result, index) => {
      if (result && typeof result === "object") {
        const r = result as Record<string, unknown>;
        const status = r.passed === true ? "PASS" : "FAIL";
        const required = r.required === false ? "optional" : "required";
        const error = r.error ? ` — ${String(r.error)}` : "";
        return `${status} ${String(r.criterion_id ?? `criterion-${index + 1}`)} (${required})${error}`;
      }
      return `- ${String(result)}`;
    })
    .join("\n");
}

function formatResponsePayloadForPrompt(payload: Record<string, unknown>): string {
  if (typeof payload.text === "string" && payload.text) return payload.text;
  if (typeof payload.summary === "string" && payload.summary) {
    const status = String(payload.status ?? "response").toUpperCase();
    const taskId = String(payload.task_id ?? "unknown");
    const artifacts = Array.isArray(payload.artifacts) && payload.artifacts.length > 0
      ? `\n\nARTIFACTS:\n${payload.artifacts.map((a) => `- ${String(a)}`).join("\n")}`
      : "";
    const verification = formatVerificationResultsForPrompt(payload.verification_results);
    return `[${status}] task=${taskId}\n\n${payload.summary}${verification ? `\n\nVERIFICATION:\n${verification}` : ""}${artifacts}`;
  }
  return formatPayloadForPrompt(payload);
}

function sendMessage(to: string, msg: FabricMessage): boolean {
  try {
    const line = JSON.stringify(msg) + "\n";
    appendFileSync(getMailboxPath(to), line);

    const pidPath = getPidPath(to);
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, "utf8").trim());
      if (pid > 0) {
        try {
          process.kill(pid, "SIGUSR1");
        } catch {
          // PID stale — receiver may pick up on startup or via turn_end fallback
        }
      }
    }
    return true;
  } catch (err) {
    console.error("[fabric] sendMessage failed:", err);
    return false;
  }
}

// ──────────────────────────────────────────────────────────────
// Inbox processing
// ──────────────────────────────────────────────────────────────

function processInbox() {
  if (!AGENT_ID || inboxProcessing) return;
  inboxProcessing = true;

  setFabricStatus("processing_inbox", "Processing mailbox messages");

  try {
    // First drain any messages captured during SIGUSR1
    while (pendingMessages.length > 0) {
      const msg = pendingMessages.shift()!;
      handleMessage(msg);
    }

    const mbox = getMailboxPath(AGENT_ID);
    if (!existsSync(mbox)) {
      inboxProcessing = false;
      setFabricStatus("idle", "Ready");
      return;
    }

    const state = readState();
    const fd = openSync(mbox, "r");
    const stats = fstatSync(fd);
    const newBytes = stats.size - state.lastOffset;

    if (newBytes <= 0) {
      closeSync(fd);
      inboxProcessing = false;
      setFabricStatus("idle", "Ready");
      return;
    }

    const buffer = Buffer.alloc(newBytes);
    readSync(fd, buffer, 0, newBytes, state.lastOffset);
    closeSync(fd);

    const lines = buffer.toString("utf8").split("\n").filter(Boolean);
    const messages: FabricMessage[] = [];
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line) as FabricMessage);
      } catch {
        // skip corrupt line
      }
    }

    for (const msg of messages) {
      handleMessage(msg);
      unreadCount = Math.max(0, unreadCount - 1);
    }

    writeState(stats.size);
    setFabricStatus("idle", "Ready");
  } catch (err) {
    setFabricStatus("error", "Inbox processing failed", String(err));
    console.error("[fabric] processInbox error:", err);
  } finally {
    inboxProcessing = false;
    // Scheduler checkpoint after mailbox processing.
    tryDequeueTelegramUserMessage("process_inbox_finally");
  }
}

function normalizeMailboxChatText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”"'`*_~.,;:()\[\]{}-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAckLikeMailboxChat(text: string): boolean {
  const normalized = normalizeMailboxChatText(text);
  if (!normalized) return true;
  if (/[?¿]/.test(text)) return false;
  if (normalized.length > 180) return false;
  if (/\b(blocked|bloquead|need|necesit|puedes|pod[eé]s|can you|por favor|please|confirm|confirma|approve|aprueba|review|revisa|help|ayuda|error|fail|falla|urgent|urgente|task|tarea|contrato)\b/.test(normalized)) {
    return false;
  }

  const ackPatterns = [
    /^(ack|ok|okay|dale|listo|perfecto|entendido|recibido|recibida|copiado|roger|noted|gracias|thanks|thank you)\b/,
    /^quedo (atento|atenta|disponible)\b/,
    /^sin acciones adicionales\b/,
    /^cierro (hilo|definitivamente)\b/,
    /^recibido cerrado\b/,
    /^ack final recibido\b/,
    /^no responder[eé]? m[aá]s\b/,
    /^entendido\b.*\bcierro\b/,
    /^[👍👌✅]+$/,
  ];

  const wordCount = normalized.split(" ").filter(Boolean).length;
  return wordCount <= 16 && ackPatterns.some((pattern) => pattern.test(normalized));
}

function isCoordinationIntentTelegram(text: string): boolean {
  const normalized = normalizeMailboxChatText(text);
  if (!normalized) return false;

  const coordinationPatterns = [
    /\bdeleg/,
    /\bsub\s*coordinador\b/,
    /\bsub\s*coord\b/,
    /\bcrea(r)?\s+un\s+agente\b/,
    /\blanza(r)?\s+un\s+agente\b/,
    /\bworker\b/,
    /\brollback\b/,
    /\brevert/,
    /\bcambia(r)?\s+el\s+plan\b/,
    /\bplan\s+de\s+cierre\b/,
    /\bpull\s+request\b/,
    /\bpr\b/,
    /\bgh\b/,
    /\bgit\b/,
    /\bcierre\b/,
    /\bvalidaciones\b/,
  ];

  return coordinationPatterns.some((pattern) => pattern.test(normalized));
}

function getCleanupTargetFromResponseMessage(msg: FabricMessage): ChildAgentCleanupTarget {
  return {
    agentId: msg.from,
    role: toOptionalString(msg.payload.reporter_role ?? msg.payload.role),
    mode: toOptionalString(msg.payload.reporter_mode ?? msg.payload.mode),
    paneId: toOptionalString(msg.payload.reporter_pane_id ?? msg.payload.pane_id),
    session: toOptionalString(msg.payload.reporter_session ?? msg.payload.session),
    pid: toOptionalNumber(msg.payload.reporter_pid ?? msg.payload.pid),
  };
}

function maybeAutoCleanupCompletedRpcWorkerFromResponse(msg: FabricMessage): ChildAgentCleanupResult | null {
  const cleanupTarget = getCleanupTargetFromResponseMessage(msg);
  if (!shouldAutoCleanupCompletedRpcWorker({
    agentId: cleanupTarget.agentId,
    role: cleanupTarget.role,
    mode: cleanupTarget.mode,
    status: msg.payload.status,
  })) {
    return null;
  }

  return cleanupChildAgentResources(cleanupTarget);
}

function handleMessage(msg: FabricMessage) {
  if (!activeCtx) {
    // Queue for later if ctx not yet available
    pendingMessages.push(msg);
    return;
  }

  const ctx = activeCtx;
  const injectMailboxPrompt = (text: string, deliverAs: "followUp" | "steer") => {
    if (!fabricApi) return false;
    try {
      fabricApi.sendUserMessage(text, { deliverAs });
      return true;
    } catch {
      return false;
    }
  };

  switch (msg.type) {
    case "chat": {
      const text = String(msg.payload.text ?? "");
      const ackLike = isAckLikeMailboxChat(text);
      const replyInstructions = ackLike
        ? `\n\nMAILBOX NOTE\n` +
          `Machine-to-machine packet. This looks like a terminal ACK or informational closeout.\n` +
          `Do not reply unless you have new actionable data or a real question.\n` +
          `Never ACK an ACK.`
        : `\n\nMAILBOX PROTOCOL\n` +
          `Machine-to-machine message from agent "${msg.from}".\n` +
          `Audience is another agent, not a human.\n` +
          `Reply only if action, data, or a decision is required.\n` +
          `Keep the reply flat, compact, and in English.\n` +
          `Prefer tool use over narration.\n` +
          `Use fabric_send_message with:\n` +
          `- to: "${msg.from}"\n` +
          `- type: "chat"\n` +
          `- payload: { "text": "<compact English message>" }\n` +
          `Fallback only if the tool is unavailable:\n` +
          `echo '{"message_id":"<random>","from":"${AGENT_ID}","to":"${msg.from}","type":"chat","payload":{"text":"<compact English message>"},"timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> /tmp/fabric-agents/mailboxes/${msg.from}.jsonl && kill -USR1 $(cat /tmp/fabric-agents/pids/${msg.from}.pid)`;
      const injected = injectMailboxPrompt(
        `MAILBOX CHAT FROM ${msg.from}\n\n${text}${replyInstructions}`,
        "followUp"
      );
      if (!injected) {
        ctx.ui.notify(`💬 ${msg.from}: ${text.slice(0, 200)}`, "info");
      }
      break;
    }
    case "telegram_request":
    case "telegram_user_message": {
      const text = String(msg.payload.text ?? (msg.payload.normalized as any)?.instruction ?? "");
      const chatId = Number(msg.payload.chat_id);
      const replyTo = msg.payload.reply_to ? Number(msg.payload.reply_to) : undefined;
      const requestId = String(msg.payload.request_id ?? "");

      const queuePolicy = (msg.payload.queue_policy as Record<string, unknown> | undefined) ?? {};
      const queuePriority = String(queuePolicy.priority ?? "telegram_high");
      const turnPolicy = String(queuePolicy.turn_policy ?? "next_turn_no_interrupt");
      const interruptCurrentTurn = Boolean(queuePolicy.interrupt_current_turn ?? false);
      const ackWhenDequeued = Boolean(queuePolicy.ack_when_dequeued ?? true);
      const ackRequired = (msg.payload.reply_policy as Record<string, unknown> | undefined)?.ack_required !== false;

      if (msg.type === "telegram_user_message") {
        telegramUserMessageQueue.push({
          text,
          chatId,
          replyTo,
          requestId,
          queuePriority,
          turnPolicy,
          interruptCurrentTurn,
          ackWhenDequeued,
          ackRequired,
        });

        // True next-turn scheduler: dequeue only at safe turn boundary/idle state.
        tryDequeueTelegramUserMessage("mailbox_enqueue");
        break;
      }

      // Legacy compatibility path: telegram_request remains immediate followUp behavior.
      clearTelegramContext();
      telegramContext = {
        chatId,
        replyTo,
        requestId,
        awaitingResponse: true,
        responseSent: false,
        ackSent: false,
      };
      refreshTelegramContext();

      const injected = injectMailboxPrompt(
        `[telegram] ${text}${buildTelegramInstructionsFromQueue({
          text,
          chatId,
          replyTo,
          requestId,
          queuePriority,
          turnPolicy,
          interruptCurrentTurn,
          ackWhenDequeued,
          ackRequired,
        })}`,
        "followUp"
      );
      if (!injected) {
        ctx.ui.notify(`📱 Telegram from ${chatId}: ${text.slice(0, 100)}`, "info");
      }
      break;
    }
    case "contract":
    case "task": {
      const desc = String(msg.payload.description ?? msg.payload.text ?? "");
      const criteria = formatAcceptanceCriteriaForPrompt(msg.payload.acceptance_criteria);
      const reportTo = String(msg.payload.report_to_when_done ?? msg.payload.report_to ?? "");
      const files = Array.isArray(msg.payload.files)
        ? msg.payload.files.map((f: unknown) => String(f)).join(", ")
        : "";
      const taskId = String(msg.payload.task_id ?? "unknown");

      const taskPrompt =
        `MACHINE CONTRACT\n` +
        `source_agent: ${msg.from}\n` +
        `task_id: ${taskId}\n` +
        `communication_mode: machine_to_machine\n` +
        `audience: another_agent\n\n` +
        `Execution rules:\n` +
        `- Do not optimize for human readability.\n` +
        `- Optimize for correct tool selection, verification, and task completion.\n` +
        `- Use repository context and the raw contract to decide which tools to call.\n` +
        `- Keep all new inter-agent communication flat, compact, and in English.\n` +
        `- Do not add greetings, filler, narrative summaries, or decorative formatting.\n` +
        `- If blocked, report blocked status compactly in English.\n\n` +
        `DESCRIPTION:\n${desc}\n\n` +
        (criteria ? `ACCEPTANCE CRITERIA:\n${criteria}\n\n` : "") +
        (files ? `RELEVANT FILES:\n${files}\n\n` : "") +
        (reportTo ? `REPORT TO WHEN DONE: ${reportTo}\n\n` : "") +
        `RAW CONTRACT JSON:\n${formatPayloadForPrompt(msg.payload)}\n\n` +
        `When finished, call fabric_report_completion with to="${reportTo || msg.from}". ` +
        `Include verification_results for every acceptance criterion.`;

      const injected = injectMailboxPrompt(taskPrompt, "steer");
      if (!injected) {
        ctx.ui.notify(
          `📋 Contract from ${msg.from}: ${JSON.stringify(msg.payload).slice(0, 100)}`,
          "info"
        );
      }
      sendMessage(msg.from, {
        message_id: randomUUID(),
        from: AGENT_ID,
        to: msg.from,
        type: "response",
        correlation_id: msg.correlation_id,
        payload: { status: "accepted", task_id: taskId },
        timestamp: new Date().toISOString(),
      });
      break;
    }
    case "healthcheck": {
      heartbeat(); // sync PID in case process changed (e.g. /new)
      sendMessage(msg.from, {
        message_id: randomUUID(),
        from: AGENT_ID,
        to: msg.from,
        type: "response",
        correlation_id: msg.correlation_id,
        payload: { status: "alive", pid: process.pid, role: ROLE, mode: MODE },
        timestamp: new Date().toISOString(),
      });
      break;
    }
    case "response": {
      // Remove from pending correlations if matched
      if (msg.correlation_id) {
        const idx = pendingCorrelations.indexOf(msg.correlation_id);
        if (idx !== -1) {
          pendingCorrelations.splice(idx, 1);
        }
      }
      const text = formatResponsePayloadForPrompt(msg.payload);
      const context = msg.payload.context
        ? `\n\nATTACHED CONTEXT\n${msg.payload.context}`
        : "";
      // Mailbox responses should never interrupt an ongoing coordinator turn.
      // Always queue them as followUp so the current task can finish first.
      let injected = false;
      if (fabricApi) {
        injected = injectMailboxPrompt(
          `MACHINE RESPONSE FROM ${msg.from}\n` +
          `Reply only if action is required. Keep mailbox traffic flat and in English.\n\n` +
          `RESPONSE:\n${text}${context}`,
          "followUp"
        );
      } else {
        pendingMessages.push(msg);
        injected = true;
      }
      if (!injected) {
        const payloadPreview = JSON.stringify(msg.payload).slice(0, 200);
        ctx.ui.notify(`↩️ ${msg.from}: ${payloadPreview}`, "info");
      }

      const cleanupResult = maybeAutoCleanupCompletedRpcWorkerFromResponse(msg);
      if (cleanupResult) {
        const cleanupSummary = cleanupResult.errors.length === 0
          ? `auto-cleaned completed RPC worker ${cleanupResult.agentId}`
          : `auto-cleanup partial for ${cleanupResult.agentId}: ${cleanupResult.errors.join(" | ")}`;
        ctx.ui.notify(cleanupSummary, cleanupResult.errors.length === 0 ? "info" : "warning");
      }
      break;
    }
    default: {
      ctx.ui.notify(`📨 ${msg.from} [${msg.type}]`, "info");
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Extension factory
// ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  fabricApi = pi;

  // ── Conditional activation ──
  if (!ENABLED) return;

  if (!ROLE) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify("Fabric: FABRIC_ROLE no definido", "warning");
    });
    return;
  }

  // ── Register self on session start ──
  pi.on("session_start", async (event, ctx) => {
    activeCtx = ctx;

    if (!IS_AGENT_MODE) {
      ctx.ui.notify("🔌 Fabric commands available (dev mode — not registered as agent)", "info");
      return;
    }

    // Ensure Fabric + PM custom tools are active so the LLM can call them.
    // This protects agents from stale sessions or accidental --tools allowlists.
    const allTools = pi.getAllTools();
    const meshTools = allTools
      .filter((t) => t.name.startsWith("fabric_") || t.name.startsWith("pm_"))
      .map((t) => t.name);
    const activeTools = new Set(pi.getActiveTools());
    const missing = meshTools.filter((t) => !activeTools.has(t));
    if (missing.length > 0) {
      pi.setActiveTools([...Array.from(activeTools), ...missing]);
      ctx.ui.notify(`🔧 Activated mesh tools: ${missing.join(", ")}`, "info");
    }

    currentFabricStatus = "registering";
    registerSelf();

    // Heartbeat: re-register PID every 10s in case the process restarted
    // (e.g. /new in pi) without triggering session_start again
    setInterval(heartbeat, 10000);

    // Read active model from context if available
    try {
      const modelFromCtx = (ctx as any).model;
      if (modelFromCtx?.id) {
        currentModel = `${modelFromCtx.provider ?? "unknown"}/${modelFromCtx.id}`;
        // Update DB immediately
        emitRuntimeRegistryEvent("agent.model_runtime", { status: "active", fabricStatus: currentFabricStatus });
      }
    } catch {
      // ignore if ctx.model is not available
    }

    ctx.ui.notify(
      `🧠 Fabric Agent: ${AGENT_ID} | role=${ROLE} | pid=${process.pid} | session=${SESSION} | model=${currentModel}`,
      "info"
    );

    // Send alive ACK to whoever launched us (coordinator / parent)
    if (REPORT_TO) {
      sendMessage(REPORT_TO, {
        message_id: randomUUID(),
        from: AGENT_ID,
        to: REPORT_TO,
        type: "healthcheck",
        payload: { status: "alive", event: "agent_start", pid: process.pid, role: ROLE, mode: MODE, model: currentModel },
        timestamp: new Date().toISOString(),
      });
      appendEvent("agent.alack_sent", AGENT_ID, { to: REPORT_TO, mode: MODE });
    }

    // Process any pending messages + pending inbox
    processInbox();

    // Drain pendingMessages that may have arrived before session_start
    if (pendingMessages.length > 0 && fabricApi) {
      const msgs = [...pendingMessages];
      pendingMessages.length = 0;
      for (const msg of msgs) {
        const text = String(msg.payload.text ?? "");
        fabricApi.sendUserMessage(
          `[Mensaje acumulado de ${msg.from}]: ${text}`,
          { deliverAs: "followUp" }
        );
      }
    }
  });

  // ── Session shutdown ──
  pi.on("session_shutdown", async (_event, _ctx) => {
    shutdownRequested = true;
    if (IS_AGENT_MODE) {
      setFabricStatus("shutting_down", "Session shutting down");
      markSelfOffline();
    }
    activeCtx = null;
  });

  // ── Input detection (queue tracking) ──
  pi.on("input", async (event, _ctx) => {
    queuedCount++;
    if (currentFabricStatus === "idle" || currentFabricStatus === "streaming" || currentFabricStatus === "processing") {
      setFabricStatus("queued", `${queuedCount} message(s) queued`);
    }
    // We don't block — let it continue
  });

  // ── Before agent start ──
  pi.on("before_agent_start", async (event, _ctx) => {
    const promptPreview = event.prompt?.slice(0, 50) ?? "unknown prompt";
    setFabricStatus("agent_starting", `Starting: ${promptPreview}...`);
  });

  // ── Agent start ──
  pi.on("agent_start", async (_event, _ctx) => {
    queuedCount = Math.max(0, queuedCount - 1);
    setFabricStatus("processing", "Agent loop active");
    agentStartAt = Date.now();
  });

  // ── Turn start ──
  pi.on("turn_start", async (event, _ctx) => {
    turnInProgress = true;
    setFabricStatus("turn_active", `Turn #${event.turnIndex ?? "?"} started`);
    turnStartAt = Date.now();
    // Heartbeat
    try {
        emitRuntimeRegistryEvent("agent.turn_heartbeat", { status: "active", fabricStatus: currentFabricStatus });
    } catch {
      // ignore
    }
  });

  // ── Before provider request (waiting LLM) ──
  pi.on("before_provider_request", async (event, _ctx) => {
    const modelName = (event as any).payload?.model ?? currentModel ?? "LLM";
    setFabricStatus("waiting_llm", `Requesting ${modelName}`);
    llmRequestAt = Date.now();
  });

  // ── After provider response ──
  pi.on("after_provider_response", async (event, _ctx) => {
    if (event.status === 429) {
      setFabricStatus("error", "Rate limited by provider", `HTTP ${event.status}`);
    } else if (event.status >= 400) {
      setFabricStatus("error", `Provider error HTTP ${event.status}`, `HTTP ${event.status}`);
    }
    if (llmRequestAt > 0) {
      const latency = Date.now() - llmRequestAt;
      appendMetric("llm_latency_ms", latency, { status: event.status });
      llmRequestAt = 0;
    }
    // If streaming, message_update will switch to streaming
    // If no streaming, next state comes from turn_end / tool_execution_start
  });

  // ── Message update (streaming / thinking tokens) ──
  pi.on("message_update", async (event, _ctx) => {
    const assistantEvent = (event as any).assistantMessageEvent;
    if (assistantEvent?.type === "text_delta") {
      isStreaming = true;
      isThinking = false;
      setFabricStatus("streaming", "Receiving LLM response");
    } else if (assistantEvent?.type === "thinking_delta") {
      isThinking = true;
      isStreaming = false;
      setFabricStatus("thinking", "Model reasoning");
    }
  });

  // ── Message end ──
  pi.on("message_end", async (event, _ctx) => {
    isStreaming = false;
    isThinking = false;
    const message = (event as any).message;
    persistAgentOutput(message);
    captureTelegramAssistantMessage(message);
  });

  // ── Tool execution start ──
  pi.on("tool_execution_start", async (event, _ctx) => {
    activeToolName = event.toolName;
    setFabricStatus("tool_running", `Executing ${event.toolName}...`);
    toolStartAt = Date.now();
  });

  // ── Tool call (detect blocking) ──
  pi.on("tool_call", async (event, _ctx) => {
    // If a later handler blocks the tool, tool_execution_start won't fire.
    // We can't know here, but we can record that a tool was attempted.
    // If tool_execution_start doesn't happen within a tick, we could infer blocked.
    // For now, just track the tool name.
  });

  // ── Tool execution end ──
  pi.on("tool_execution_end", async (event, _ctx) => {
    activeToolName = null;
    if (toolStartAt > 0) {
      const duration = Date.now() - toolStartAt;
      appendMetric("tool_duration_ms", duration, { tool: event.toolName });
      toolStartAt = 0;
    }
    // Will go back to turn_active via turn_end or waiting_llm if new LLM call
  });

  // ── Turn end ──
  pi.on("turn_end", async (_event, _ctx) => {
    turnInProgress = false;
    if (turnStartAt > 0) {
      const duration = Date.now() - turnStartAt;
      appendMetric("turn_duration_ms", duration);
      turnStartAt = 0;
    }

    await flushTelegramFallback("turn_end");

    // Check if there are unread messages to process
    if (unreadCount > 0 || pendingMessages.length > 0) {
      processInbox();
    }

    // True next-turn dequeue: only after active turn ended.
    tryDequeueTelegramUserMessage("turn_end");
  });

  // ── Agent end ──
  pi.on("agent_end", async (_event, ctx) => {
    turnInProgress = false;
    activeToolName = null;
    isStreaming = false;
    isThinking = false;

    if (agentStartAt > 0) {
      const duration = Date.now() - agentStartAt;
      appendMetric("agent_duration_ms", duration);
      agentStartAt = 0;
    }

    // Last-resort Telegram flush in case the turn ended while shutdown/agent_end races.
    await flushTelegramFallback("agent_end");
    telegramCompletedMessages = [];
    telegramMessageAccumulator = "";

    // Drain any mailbox messages that arrived while we were busy
    if (pendingMessages.length > 0 && fabricApi) {
      const msgs = [...pendingMessages];
      pendingMessages.length = 0;
      for (const msg of msgs) {
        const text = String(msg.payload.text ?? "");
        const context = msg.payload.context
          ? `\n\n${msg.payload.context}`
          : "";
        // Hybrid delivery: code blocks interrupt immediately (steer),
        // lightweight acks wait for next idle cycle (followUp)
        const deliverAs = text.includes("```") ? "steer" : "followUp";
        try {
          fabricApi.sendUserMessage(
            `[Mensaje pendiente de ${msg.from}]: ${text}${context}`,
            { deliverAs }
          );
        } catch (err) {
          // Silently ignore sendUserMessage errors
        }
      }
      ctx.ui.notify(`📬 ${msgs.length} mensaje(s) del mailbox inyectados`, "info");
    } else if (pendingMessages.length > 0) {
      // pendingMessages exist but fabricApi not ready yet
    }

    if (pendingCorrelations.length > 0) {
      setFabricStatus("waiting_response", `Waiting ${pendingCorrelations.length} Fabric response(s)`);
    } else if (ctx.isIdle && ctx.isIdle()) {
      setFabricStatus("idle", "Ready");
    } else {
      setFabricStatus("idle", "Ready");
    }

    tryDequeueTelegramUserMessage("agent_end");
  });

  // ── Compaction ──
  pi.on("session_before_compact", async (_event, _ctx) => {
    setFabricStatus("compacting", "Summarizing conversation context");
  });

  pi.on("session_compact", async (_event, _ctx) => {
    if (activeCtx && (activeCtx as any).isIdle && (activeCtx as any).isIdle()) {
      setFabricStatus("idle", "Ready");
    }
    // Otherwise remain in whatever active state we're in
  });

  // ── Model select ──
  pi.on("model_select", async (event, _ctx) => {
    const prevModel = (event as any).previousModel;
    const nextModel = event.model;
    currentModel = `${nextModel.provider ?? "unknown"}/${nextModel.id}`;

    // Update SQLite so dashboard reflects change immediately
    try {
      emitRuntimeRegistryEvent("agent.model_runtime", { status: "active", fabricStatus: currentFabricStatus });
    } catch {
      // ignore
    }

    appendGlobalEvent({
      type: "agent.model_changed",
      agent_id: AGENT_ID,
      payload: {
        from: prevModel?.id ?? null,
        to: nextModel.id,
        provider: nextModel.provider,
        full_model: currentModel,
      },
    });

    // Update footer
    updateFooter();
  });

  // ── Safety net: process inbox after each turn ──
  pi.on("turn_end", async (_event, _ctx) => {
    if (unreadCount > 0 || pendingMessages.length > 0) {
      processInbox();
    }
    tryDequeueTelegramUserMessage("turn_end_safety_net");
  });

  // ── SIGUSR1 wakes us to process inbox ──
  process.on("SIGUSR1", () => {
    if (!AGENT_ID) return; // dev mode — no mailbox to watch
    try {
      const mbox = getMailboxPath(AGENT_ID);
      if (!existsSync(mbox)) return;

      const state = readState();
      const fd = openSync(mbox, "r");
      const stats = fstatSync(fd);
      const newBytes = stats.size - state.lastOffset;
      closeSync(fd);

      if (newBytes <= 0) return;

      // Count unread but DO NOT advance offset here — processInbox does the real work
      unreadCount += Math.max(1, Math.ceil(newBytes / 80)); // rough estimate
      if (activeCtx) {
        setFabricStatus("processing_inbox", "SIGUSR1 wake — processing mailbox");
        processInbox();
      } else {
        // No ctx yet — just mark that we have work to do
        currentFabricStatus = "queued";
      }
    } catch (err) {
      console.error("[fabric] SIGUSR1 handler error:", err);
    }
  });

  // ── Commands ──

  pi.registerCommand("fabric-list", {
    description: "List all registered Fabric agents",
    handler: async (_args, ctx) => {
      try {
        const rows = withRegistryReadDb((db) => {
          const stmt = db.prepare(
            `SELECT agent_id, role, pane_id, session, pid, model, status,
                    fabric_status, current_task, queue_length, active_tool,
                    is_streaming, is_thinking, last_seen_at
             FROM agents ORDER BY registered_at`
          );
          return prepareAllWithRetry(stmt, []) as Array<{
            agent_id: string;
            role: string;
            pane_id: string;
            session: string;
            pid: number;
            model: string;
            status: string;
            fabric_status: string;
            current_task: string | null;
            queue_length: number;
            active_tool: string | null;
            is_streaming: number;
            is_thinking: number;
            last_seen_at: string;
          }>;
        });

        if (rows.length === 0) {
          ctx.ui.notify("No agents registered.", "info");
          return;
        }

        const lines = rows.map(
          (r) =>
            `• ${r.agent_id} | ${r.role} | ${r.fabric_status ?? r.status} | pid=${r.pid ?? "?"} | session=${r.session ?? "?"} | model=${r.model ?? "?"}${r.active_tool ? ` | tool=${r.active_tool}` : ""}`
        );
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err) {
        ctx.ui.notify(`Error: ${err}`, "error");
      }
    },
  });

  pi.registerCommand("fabric-send", {
    description: "Send a chat message to another agent: /fabric-send <to> <text>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui.notify("Usage: /fabric-send <agent-id> <message>", "warning");
        return;
      }
      const to = parts[0];
      const text = parts.slice(1).join(" ");

      const correlationId = randomUUID();

      const ok = sendMessage(to, {
        message_id: randomUUID(),
        from: AGENT_ID,
        to,
        type: "chat",
        correlation_id: correlationId,
        payload: { text },
        timestamp: new Date().toISOString(),
      });

      if (ok) {
        pendingCorrelations.push(correlationId);
        ctx.ui.notify(`📤 Sent to ${to}: ${text.slice(0, 80)}`, "info");
        setFabricStatus("waiting_response", `Waiting response from ${to}`);
      } else {
        ctx.ui.notify(`Failed to send to ${to}`, "error");
      }
    },
  });

  pi.registerCommand("fabric-inbox", {
    description: "Show unread messages in my mailbox",
    handler: async (_args, ctx) => {
      try {
        const mbox = getMailboxPath(AGENT_ID);
        if (!existsSync(mbox)) {
          ctx.ui.notify("Mailbox empty.", "info");
          return;
        }
        const state = readState();
        const fd = openSync(mbox, "r");
        const stats = fstatSync(fd);
        const newBytes = stats.size - state.lastOffset;
        closeSync(fd);

        if (newBytes <= 0) {
          ctx.ui.notify("No unread messages.", "info");
          return;
        }

        ctx.ui.notify(
          `📬 ${Math.ceil(newBytes / 200)}+ bytes unread in mailbox (offset=${state.lastOffset}, size=${stats.size})`,
          "info"
        );
      } catch (err) {
        ctx.ui.notify(`Error reading inbox: ${err}`, "error");
      }
    },
  });

  pi.registerCommand("fabric-chat", {
    description: "Start interactive chat with another agent: /fabric-chat <agent-id>",
    handler: async (args, ctx) => {
      const to = args.trim().split(/\s+/)[0];
      if (!to) {
        ctx.ui.notify("Usage: /fabric-chat <agent-id>", "warning");
        return;
      }

      sendMessage(to, {
        message_id: randomUUID(),
        from: AGENT_ID,
        to,
        type: "chat",
        payload: { text: `👋 ${AGENT_ID} wants to chat.` },
        timestamp: new Date().toISOString(),
      });

      ctx.ui.notify(
        `💬 Chat handshake sent to ${to}. Use /fabric-send ${to} <msg> to continue.`,
        "info"
      );
    },
  });

  pi.registerCommand("fabric-health", {
    description: "Show my Fabric health status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `🏥 ${AGENT_ID} | role=${ROLE} | pid=${process.pid} | mode=${MODE} | session=${SESSION} | pane=${PANE_ID} | status=${currentFabricStatus}`,
        "info"
      );
    },
  });

  pi.registerCommand("fabric-broadcast", {
    description: "Broadcast a chat message to all active agents",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        ctx.ui.notify("Usage: /fabric-broadcast <message>", "warning");
        return;
      }

      try {
        const rows = withRegistryReadDb((db) => {
          const stmt = db.prepare(
            "SELECT agent_id FROM agents WHERE status = 'active' AND agent_id != ?"
          );
          return prepareAllWithRetry(stmt, [AGENT_ID]) as Array<{ agent_id: string }>;
        });

        let sent = 0;
        for (const { agent_id } of rows) {
          const ok = sendMessage(agent_id, {
            message_id: randomUUID(),
            from: AGENT_ID,
            to: agent_id,
            type: "chat",
            payload: { text: `[broadcast] ${text}` },
            timestamp: new Date().toISOString(),
          });
          if (ok) sent++;
        }

        ctx.ui.notify(`📢 Broadcast sent to ${sent} agent(s).`, "info");
      } catch (err) {
        ctx.ui.notify(`Broadcast failed: ${err}`, "error");
      }
    },
  });

  // ── Sub-coordinator commands ──

  const PARENT_AGENT_ID = process.env.FABRIC_PARENT_AGENT_ID;
const REPORT_TO = process.env.FABRIC_REPORT_TO || PARENT_AGENT_ID || "";

  pi.registerCommand("fabric-report", {
    description: "Send a structured report to the parent coordinator (sub-coordinator only)",
    handler: async (args, ctx) => {
      if (!PARENT_AGENT_ID) {
        ctx.ui.notify("FABRIC_PARENT_AGENT_ID not set. Not a sub-coordinator?", "warning");
        return;
      }
      const summary = args.trim() || "Task completed. No additional details provided.";
      const taskId = process.env.FABRIC_TASK_ID || "unknown";

      const ok = sendMessage(PARENT_AGENT_ID, {
        message_id: randomUUID(),
        from: AGENT_ID,
        to: PARENT_AGENT_ID,
        type: "response",
        payload: {
          type: "subcoord.report",
          task_id: taskId,
          agent_id: AGENT_ID,
          session: SESSION,
          summary,
          timestamp: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      });

      if (ok) {
        ctx.ui.notify(`📋 Report sent to ${PARENT_AGENT_ID}`, "info");
      } else {
        ctx.ui.notify(`Failed to send report to ${PARENT_AGENT_ID}`, "error");
      }
    },
  });

  pi.registerCommand("fabric-workers", {
    description: "List agents in my current tmux session (local workers)",
    handler: async (_args, ctx) => {
      try {
        const rows = withRegistryReadDb((db) => {
          const stmt = db.prepare(
            `SELECT agent_id, role, fabric_status, model, active_tool, queue_length
             FROM agents WHERE session = ? AND status = 'active' AND agent_id != ?
             ORDER BY registered_at`
          );
          return prepareAllWithRetry(stmt, [SESSION, AGENT_ID]) as Array<{
            agent_id: string;
            role: string;
            fabric_status: string;
            model: string;
            active_tool: string | null;
            queue_length: number;
          }>;
        });

        if (rows.length === 0) {
          ctx.ui.notify(`No local workers in session ${SESSION}.`, "info");
          return;
        }

        const lines = rows.map(
          (r) =>
            `• ${r.agent_id} | ${r.role} | ${r.fabric_status} | model=${r.model ?? "?"}${r.active_tool ? ` | tool=${r.active_tool}` : ""}${r.queue_length > 0 ? ` | 📬${r.queue_length}` : ""}`
        );
        ctx.ui.notify(`Local workers in ${SESSION}:\n${lines.join("\n")}`, "info");
      } catch (err) {
        ctx.ui.notify(`Error: ${err}`, "error");
      }
    },
  });

  pi.registerCommand("fabric-launch-worker", {
    description: "Launch a worker agent in my session: /fabric-launch-worker <role> <agent-id> [--model=...]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui.notify("Usage: /fabric-launch-worker <role> <agent-id> [--model=<model>]", "warning");
        return;
      }
      const workerRole = parts[0];
      const workerId = parts[1];
      const modelFlag = parts.find((p) => p.startsWith("--model="));
      const modelArg = modelFlag ? modelFlag.split("=")[1] : "";

      // Find launcher script path
      const launcherCandidates = [
        resolve(dirname(fileURLToPath(import.meta.url)), "launcher.ts"),
        resolve(process.cwd(), "src/core/launcher.ts"),
      ];
      let launcherPath = null;
      for (const p of launcherCandidates) {
        if (existsSync(p)) {
          launcherPath = p;
          break;
        }
      }
      if (!launcherPath) {
        ctx.ui.notify("launcher.ts not found. Cannot spawn worker.", "error");
        return;
      }

      const cmdParts = [
        "npx", "tsx", launcherPath,
        `--role=${workerRole}`,
        `--agent-id=${workerId}`,
        `--mode=rpc`,
        `--session=${SESSION}`,
      ];
      if (modelArg) cmdParts.push(`--model=${modelArg}`);

      try {
        const proc = spawn(cmdParts[0], cmdParts.slice(1), {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        ctx.ui.notify(`🚀 Launched worker ${workerId} (role=${workerRole}) in session ${SESSION} (launcher pid=${proc.pid})`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed to launch worker: ${err.message || err}`, "error");
      }
    },
  });

  // ── PM Task Analysis Commands ──

  pi.registerCommand("pm-analysis", {
    description: "Ver últimos análisis de una tarea: /pm-analysis <task-id> [--invalidated]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const taskId = parseInt(parts[0], 10);
      if (isNaN(taskId)) {
        ctx.ui.notify("Usage: /pm-analysis <task-id> [--invalidated]", "warning");
        return;
      }
      const showInvalidated = parts.includes("--invalidated");
      try {
        const rows = readAnalyses({ task_id: taskId, include_invalidated: showInvalidated });
        if (rows.length === 0) {
          ctx.ui.notify(`No analyses for task ${taskId}.`, "info");
          return;
        }
        const lines = rows.map(r => {
          const kw = JSON.parse(r.keywords || "[]");
          return `• ${r.id} | ${r.version} | ${r.analysis_type} | conf=${r.confidence_score} | kw=[${kw.join(",")}] | ${r.is_active ? "✓active" : "✗invalidated"}`;
        });
        ctx.ui.notify(`Análisis de task ${taskId} (${rows.length}):\n${lines.join("\n")}`, "info");
      } catch (err) {
        ctx.ui.notify(`Error: ${err}`, "error");
      }
    },
  });

  pi.registerCommand("pm-context", {
    description: "Injectar contexto de análisis en el chat: /pm-context <task-id>",
    handler: async (args, ctx) => {
      const taskId = parseInt(args.trim(), 10);
      if (isNaN(taskId)) {
        ctx.ui.notify("Usage: /pm-context <task-id>", "warning");
        return;
      }
      const context = getAgentContext(taskId);
      if (!context) {
        ctx.ui.notify(`No hay análisis activo para task ${taskId}.`, "info");
        return;
      }
      // Inject into the current chat context
      if (fabricApi) {
        fabricApi.sendUserMessage(
          `--- CONTEXTO ANALISIS task ${taskId} ---\n${context}\n--------------------------------`,
          { deliverAs: "steer" }
        );
        ctx.ui.notify(`Contexto de task ${taskId} inyectado en el chat.`, "info");
      } else {
        ctx.ui.notify(`Contexto:\n${context}`, "info");
      }
    },
  });

  // ── PM Task Analysis Tools ──

  pi.registerTool({
    name: "pm_write_analysis",
    label: "PM Write Analysis",
    description: "Escribe un análisis cronológico para una tarea. Captura todo el contexto útil que el agente necesita para decidir: errores, configs, decisiones, resultados de queries, paths, criterios de aceptación, etc. El texto agente es la fuente de verdad; el resumen humano es opcional.",
    promptSnippet: "Escribir análisis contextual para una tarea en el sistema PM",
    promptGuidelines: [
      "Usa pm_write_analysis cuando termines un ciclo de trabajo y necesites guardar contexto para el futuro.",
      "agent_note es OBLIGATORIO — debe contener TODO lo útil para continuar: paths, errores, decisiones, configs, criteria results.",
      "human_note es OPCIONAL — solo si hay algo que un humano deba saber rápido.",
      "keywords ayudan a recuperar contexto rápido — incluye términos relevantes sin tags.",
      "confidence_score: 0-100, indica qué tan seguro estás del análisis.",
      "analysis_type: debugging | root_cause | planning | review | validation | evaluation | retro | decision | general.",
      "Si reescribes para corregir o actualizar, el sistema autoincrementa la versión automáticamente.",
    ],
    parameters: Type.Object({
      task_id: Type.Number({ description: "ID de la tarea" }),
      agent_note: Type.String({ description: "Contexto denso para el agente. Todo lo que necesite para decidir. Sin tags, sin markdown. Texto plano." }),
      human_note: Type.Optional(Type.String({ description: "Resumen corto para humanos (opcional, ~500 chars)" })),
      keywords: Type.Optional(Type.Array(Type.String(), { description: "Palabras clave para búsqueda rápida" })),
      analysis_type: Type.Optional(Type.String({ description: "Tipo: debugging|root_cause|planning|review|validation|evaluation|retro|decision|general" })),
      confidence: Type.Optional(Type.Number({ description: "Confidence 0-100" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const row = writeAnalysis({
          task_id: params.task_id,
          agent_note: params.agent_note,
          human_note: params.human_note ?? null,
          keywords: params.keywords ?? [],
          analysis_type: (params.analysis_type ?? "general") as any,
          confidence_score: params.confidence ?? 50,
          author_id: AGENT_ID || "unknown",
          author_type: "agent",
        });
        return {
          content: [{ type: "text", text: `Analysis ${row.id} written (${row.version}) for task ${row.task_id} | ${row.analysis_type} | conf=${row.confidence_score}` }],
          details: { id: row.id, version: row.version, task_id: row.task_id },
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error writing analysis: ${err.message || err}` }], details: { error: String(err) } };
      }
    },
  });

  pi.registerTool({
    name: "pm_read_analyses",
    label: "PM Read Analyses",
    description: "Lee análisis cronológicos de tareas. Filtra por keywords, tipo, o ID. Solo devuelve el agente (agent_note) para inyección directa en contexto. Incluye invalidated solo si se pide explícitamente.",
    promptSnippet: "Leer análisis previos de una tarea para recuperar contexto",
    promptGuidelines: [
      "Usa pm_read_analyses para recuperar contexto de tareas anteriores antes de tomar decisiones.",
      "Sin parámetros: devuelve todos los análisis activos de todas las tareas con contexto.",
      "task_id: filtra a una tarea específica.",
      "keywords: busca en las palabras clave de los análisis (substring match).",
      "analysis_type: filtra por tipo (ej: 'root_cause', 'debugging').",
      "include_invalidated: por defecto solo muestra activos; incluye históricos si lo necesitas.",
      "El output incluye agent_note directo para copiar a contexto LLM.",
    ],
    parameters: Type.Object({
      task_id: Type.Optional(Type.Number({ description: "Filtrar por ID de tarea" })),
      keywords: Type.Optional(Type.String({ description: "Buscar en keywords (substring)" })),
      analysis_type: Type.Optional(Type.String({ description: "Filtrar por tipo: debugging|root_cause|planning|review|validation|evaluation|retro|decision|general" })),
      include_invalidated: Type.Optional(Type.Boolean({ description: "Incluir análisis reemplazados (default false)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const rows = readAnalyses({
          task_id: params.task_id,
          keywords: params.keywords ?? undefined,
          analysis_type: (params.analysis_type as any) ?? undefined,
          include_invalidated: params.include_invalidated ?? false,
        });

        if (rows.length === 0) {
          return { content: [{ type: "text", text: "No analyses found matching criteria." }], details: { count: 0 } };
        }

        const summary = rows.map(r => {
          const kw = JSON.parse(r.keywords || "[]");
          return `[${r.version}] task=${r.task_id} type=${r.analysis_type} conf=${r.confidence_score} kw=${kw.join(",")} ${r.is_active ? "✓" : "✗"}`;
        }).join("\n");

        const details = rows.map(r => {
          const prefix = r.is_active ? "" : `[INVALIDATED ${r.version}] `;
          return `${prefix}=== Task ${r.task_id} (${r.version}) ===\n${r.agent_note}`;
        }).join("\n\n");

        return {
          content: [
            { type: "text", text: `${rows.length} análisis(es):\n${summary}\n\n--- CONTEXTO ---\n${details}` },
          ],
          details: { count: rows.length, rows },
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error reading analyses: ${err.message || err}` }], details: { error: String(err) } };
      }
    },
  });

  pi.registerTool({
    name: "pm_inject_task_context",
    label: "PM Inject Task Context",
    description: "Inyecta el contexto del agente (agent_note) de una tarea en el chat actual. Útil para que el coordinador passe contexto a un worker sin escribirlo manualmente. Devuelve el agent_note listo para copiar.",
    promptSnippet: "Inyectar contexto de análisis de tarea directamente en la conversación",
    promptGuidelines: [
      "Usa pm_inject_task_context para recuperar el agent_note de una tarea y mostrarla como bloque de texto.",
      "Útil para que el coordinador diga 'aquí tienes el contexto de lo que intentamos antes' a un worker nuevo.",
      "Devuelve el agent_note sin formato — listo para que el LLM lo consuma directo.",
      "Si no hay análisis para esa tarea, devuelve texto vacío con nota.",
    ],
    parameters: Type.Object({
      task_id: Type.Number({ description: "ID de la tarea" }),
      extra_context: Type.Optional(Type.String({ description: "Contexto adicional a concatenar" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const context = buildTaskContextForAgent(params.task_id, params.extra_context ?? undefined);
      if (!context) {
        return {
          content: [{ type: "text", text: `(No hay análisis previo para task ${params.task_id})` }],
          details: { task_id: params.task_id, found: false },
        };
      }
      return {
        content: [{ type: "text", text: context }],
        details: { task_id: params.task_id, found: true, length: context.length },
      };
    },
  });

  // ── Custom tools ──

  pi.registerTool({
    name: "fabric_send_message",
    label: "Fabric Send",
    description: "Send a message to another Fabric agent via mailbox + SIGUSR1",
    promptSnippet: "Send a P2P message to another agent in the Fabric mesh",
    promptGuidelines: [
      "Use fabric_send_message when you need to communicate with another agent.",
      "Set 'to' to the target agent_id, 'type' to 'chat' for text, 'contract' for tasks, 'response' for replies, or 'telegram_agent_response'/'telegram_response' when replying to monitor.",
      "Put the actual content inside 'payload' as a JSON object.",
      "For telegram_agent_response preferred schema: payload.sender.agent_id + payload.sender.role + payload.telegram_message.text (+ optional payload.telegram_message.format=telegram_markdown|plain and include_sender_header).",
      "Legacy telegram_response compatibility is preserved: payload.text still works; extension maps missing fields from telegramContext when possible."
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Target agent ID" }),
      type: Type.String({ description: "Message type: chat | contract | healthcheck | message | response | telegram_response | telegram_agent_response | telegram_user_message | task" }),
      payload: Type.Object({}, { description: "JSON payload" }),
      correlation_id: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const validTypes: FabricMessageType[] = [
        "chat",
        "contract",
        "healthcheck",
        "message",
        "response",
        "telegram_response",
        "telegram_agent_response",
        "telegram_user_message",
        "task",
        "telegram_request",
      ];
      const msgType = validTypes.includes(params.type as FabricMessageType)
        ? (params.type as FabricMessageType)
        : "message";

      const payload = { ...(params.payload as Record<string, unknown>) };
      if (msgType === "telegram_response" || msgType === "telegram_agent_response") {
        if (telegramContext) {
          if (payload.request_id == null && telegramContext.requestId) payload.request_id = telegramContext.requestId;
          if (payload.chat_id == null) payload.chat_id = telegramContext.chatId;
          if (payload.reply_to == null && telegramContext.replyTo != null) payload.reply_to = telegramContext.replyTo;
        }

        const telegramMessage = (payload.telegram_message && typeof payload.telegram_message === "object")
          ? (payload.telegram_message as Record<string, unknown>)
          : {};
        const lifecycleStatus = typeof payload.status === "string" ? payload.status : "final";
        const text = typeof telegramMessage.text === "string"
          ? telegramMessage.text
          : (typeof payload.text === "string" ? payload.text : "");

        if (typeof payload.sender !== "object" || payload.sender == null) {
          payload.sender = {
            agent_id: AGENT_ID,
            role: ROLE,
            display_name: AGENT_ID,
          };
        }

        payload.status = lifecycleStatus;
        payload.telegram_message = {
          format: typeof telegramMessage.format === "string" ? telegramMessage.format : "plain",
          include_sender_header: telegramMessage.include_sender_header ?? true,
          ...telegramMessage,
          text,
        };

        if (lifecycleStatus === "router_queued") {
          return {
            content: [{ type: "text", text: "telegram_agent_response status=router_queued is monitor-owned and not allowed from agents" }],
            details: { sent: false, target: params.to, type: msgType, error: "invalid_status_router_queued" },
          };
        }

        if (typeof text !== "string" || text.trim() === "") {
          return {
            content: [{ type: "text", text: "telegram_agent_response requires payload.telegram_message.text or legacy payload.text" }],
            details: { sent: false, target: params.to, type: msgType, error: "missing_text" },
          };
        }
        if (payload.request_id == null && payload.chat_id == null) {
          return {
            content: [{ type: "text", text: "telegram_agent_response requires payload.request_id or payload.chat_id (routing missing)" }],
            details: { sent: false, target: params.to, type: msgType, error: "missing_telegram_routing" },
          };
        }

        const terminalTelegramStatus = shouldClearTelegramContext(lifecycleStatus);
        const directOk = await sendTelegramResponse(payload, {
          chatId: typeof payload.chat_id === "number" ? payload.chat_id : undefined,
          replyTo: typeof payload.reply_to === "number" ? payload.reply_to : undefined,
          requestId: typeof payload.request_id === "string" ? payload.request_id : undefined,
        });

        if (directOk) {
          if (terminalTelegramStatus) {
            clearTelegramContext();
          } else {
            refreshTelegramContext();
          }
          return {
            content: [{ type: "text", text: "Telegram response delivered via monitor outbound" }],
            details: { sent: true, target: "monitor", type: msgType, payload, via: "http_outbound" },
          };
        }

        const mailboxOk = sendMessage(params.to, {
          message_id: randomUUID(),
          from: AGENT_ID,
          to: params.to,
          type: msgType,
          correlation_id: params.correlation_id,
          payload,
          timestamp: new Date().toISOString(),
        });

        if (mailboxOk) {
          if (terminalTelegramStatus) {
            clearTelegramContext();
          } else {
            refreshTelegramContext();
          }
        } else if (telegramContext) {
          refreshTelegramContext();
        }

        return {
          content: [
            {
              type: "text",
              text: mailboxOk
                ? `Telegram response queued to ${params.to} mailbox after outbound fallback failed`
                : `Failed to send Telegram response to ${params.to}`,
            },
          ],
          details: { sent: mailboxOk, target: params.to, type: msgType, payload, via: "mailbox_fallback" },
        };
      }

      const ok = sendMessage(params.to, {
        message_id: randomUUID(),
        from: AGENT_ID,
        to: params.to,
        type: msgType,
        correlation_id: params.correlation_id,
        payload,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [
          {
            type: "text",
            text: ok
              ? `Message sent to ${params.to}`
              : `Failed to send to ${params.to}`,
          },
        ],
        details: { sent: ok, target: params.to, type: msgType, payload },
      };
    },
  });

  pi.registerTool({
    name: "fabric_launch_agent",
    label: "Fabric Launch Agent",
    description: "Launch a new Fabric agent via launcher.ts asynchronously. Supports workspace_dir plus selective workspace skills for monorepos via workspace_skills/no_workspace_skills. Opens pane in the caller's current tmux window using split-window with zsh interactivo (loads ~/.zshrc naturally).",
    promptSnippet: "Launch a new worker agent in the Fabric mesh",
    promptGuidelines: [
      "Use fabric_launch_agent to spawn a new agent with a specific role.",
      "Required: role, agent_id, and report_to (who receives the alive ACK).",
      "Mode defaults to 'rpc' (headless). Use 'interactive' only for coordinators/sub-coordinators.",
      "For worktree/repo workers, always pass workspace_dir so the worker starts in the correct repo.",
      "For monorepos, prefer explicit workspace_skills (minimum necessary) or no_workspace_skills=true. Do not load all workspace skills into every worker.",
      "Examples: workspace_skills=['temporal-io','deposits'] for deposits workflows; no_workspace_skills=true for generic tests/grep.",
      "The new pane opens in your current tmux window and tiles automatically.",
      "This tool returns immediately; the alive ACK arrives via mailbox + SIGUSR1."
    ],
    parameters: Type.Object({
      role: Type.String({ description: "Role/skill to load (dev, reviewer, chat, etc.)" }),
      agent_id: Type.String({ description: "Unique agent identifier" }),
      mode: Type.Optional(Type.String({ description: "interactive or rpc (default: rpc)" })),
      model: Type.Optional(Type.String({ description: "Override model (e.g. fern/gpt-5.3-codex)" })),
      report_to: Type.String({ description: "Agent ID that receives alive ACK and task reports" }),
      session: Type.Optional(Type.String({ description: "tmux session fallback (only used if launcher runs outside tmux; default: fabric-default)" })),
      parent_agent_id: Type.Optional(Type.String({ description: "Parent coordinator ID for federated sub-coordinators" })),
      workspace_dir: Type.Optional(Type.String({ description: "Workspace directory/worktree for the launched agent" })),
      workspace_skills: Type.Optional(Type.Array(Type.String(), { description: "Only load these workspace-local skills (e.g. ['temporal-io','deposits']). If omitted, Pi auto-discovers all workspace skills." })),
      no_workspace_skills: Type.Optional(Type.Boolean({ description: "Disable workspace skill auto-discovery; load only the role skill unless workspace_skills is set." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const launcherCandidates = [
        resolve(dirname(fileURLToPath(import.meta.url)), "launcher.ts"),
        resolve(process.cwd(), "src/core/launcher.ts"),
      ];
      let launcherPath = null;
      for (const p of launcherCandidates) {
        if (existsSync(p)) { launcherPath = p; break; }
      }
      if (!launcherPath) {
        return { content: [{ type: "text", text: "launcher.ts not found" }], details: { error: "launcher_not_found" } };
      }

      const cmdParts = [
        "npx", "tsx", launcherPath,
        `--role=${params.role}`,
        `--agent-id=${params.agent_id}`,
        `--mode=${params.mode || "rpc"}`,
        `--report-to=${params.report_to}`,
        `--session=${params.session || "fabric-default"}`,
      ];
      if (params.model) cmdParts.push(`--model=${params.model}`);
      if (params.parent_agent_id) cmdParts.push(`--parent-agent-id=${params.parent_agent_id}`);
      if (params.workspace_dir) cmdParts.push(`--workspace-dir=${params.workspace_dir}`);
      if (Array.isArray(params.workspace_skills) && params.workspace_skills.length > 0) {
        cmdParts.push(`--workspace-skills=${params.workspace_skills.join(",")}`);
      }
      if (params.no_workspace_skills) cmdParts.push(`--no-workspace-skills`);

      try {
        const logDir = `${FABRIC_DIR}/launch-logs`;
        mkdirSync(logDir, { recursive: true });
        const logPath = `${logDir}/${params.agent_id}-${Date.now()}.log`;
        const logFd = openSync(logPath, "a");
        const proc = spawn(cmdParts[0], cmdParts.slice(1), {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: { ...process.env, ENABLE_CMD_CENTER: "TRUE" },
        });
        proc.unref();
        closeSync(logFd);
        return {
          content: [{ type: "text", text: `Launch initiated for ${params.agent_id}. PID=${proc.pid}. ACK will arrive via mailbox. Log: ${logPath}` }],
          details: { launched: true, launcher_pid: proc.pid, log_path: logPath },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Launch failed: ${err.message || err}` }],
          details: { launched: false, error: String(err) },
        };
      }
    },
  });

  pi.registerTool({
    name: "fabric_send_task",
    label: "Fabric Send Task",
    description: "Send a structured task contract to a worker agent. The payload includes description, structured acceptance criteria, and who to report to when done.",
    promptSnippet: "Send a structured task contract to another agent",
    promptGuidelines: [
      "Use fabric_send_task to assign work to a worker agent.",
      "Required: to (worker id), description (what to do), and report_to_when_done (who gets the completion report).",
      "Write description, acceptance criteria descriptions, and manual instructions in English.",
      "Write contracts for a machine receiver: compact, imperative, tool-oriented, no human-facing filler.",
      "acceptance_criteria (REQUIRED): array of structured objects, each with: id, description, type (file_exists|file_contains|file_not_contains|test_passes|db_query|http_status|command_exit_0|command_output_contains|command_output_not_contains|manual), params (object), required (boolean).",
      "Optional: files (relevant paths), and task_id."
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Target worker agent ID" }),
      description: Type.String({ description: "What the worker must do, in English, written for a machine receiver" }),
      acceptance_criteria: Type.Array(Type.Object({
        id: Type.String({ description: "Unique criterion identifier" }),
        description: Type.String({ description: "Human-readable criterion" }),
        type: Type.String({ description: "file_exists | file_contains | file_not_contains | test_passes | db_query | http_status | command_exit_0 | command_output_contains | command_output_not_contains | manual" }),
        params: Type.Record(Type.String(), Type.Any(), { description: "Type-specific parameters" }),
        required: Type.Boolean({ description: "If true, failure blocks done status" }),
      }), { description: "Structured acceptance criteria (REQUIRED)" }),
      report_to_when_done: Type.String({ description: "Agent ID to report completion to" }),
      files: Type.Optional(Type.Array(Type.String(), { description: "Relevant file paths" })),
      task_id: Type.Optional(Type.String({ description: "Optional task identifier" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const payload: Record<string, unknown> = {
        description: params.description,
        acceptance_criteria: params.acceptance_criteria || [],
        report_to: params.report_to_when_done,
        report_to_when_done: params.report_to_when_done,
        files: params.files || [],
        task_id: params.task_id || `task-${Date.now()}`,
      };

      const ok = sendMessage(params.to, {
        message_id: randomUUID(),
        from: AGENT_ID || "anonymous",
        to: params.to,
        type: "contract",
        payload,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [{ type: "text", text: ok ? `Task sent to ${params.to}` : `Failed to send task to ${params.to}` }],
        details: { sent: ok, target: params.to, task_id: payload.task_id },
      };
    },
  });

  pi.registerTool({
    name: "fabric_report_completion",
    label: "Fabric Report Completion",
    description: "Report task completion (done, failed, or blocked) to the designated agent. Include verification_results when acceptance criteria were checked.",
    promptSnippet: "Report the result of a completed task to the coordinator or another agent",
    promptGuidelines: [
      "Use fabric_report_completion when you finish a task assigned by another agent.",
      "Required: to (who to report to), status ('done', 'failed', or 'blocked'), and summary.",
      "MUST include verification_results: array of {criterion_id, passed, actual, expected, error?} for each acceptance criterion from the contract.",
      "Only report 'done' if ALL required acceptance criteria passed.",
      "Optional: task_id and artifacts (array of file paths or PRs).",
      "This is the deterministic way to report; never use raw bash to write completion messages."
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Agent ID to report to" }),
      status: Type.String({ description: "done | failed | blocked" }),
      summary: Type.String({ description: "Summary of what was accomplished or why it failed" }),
      task_id: Type.Optional(Type.String({ description: "Task identifier" })),
      artifacts: Type.Optional(Type.Array(Type.String(), { description: "Paths to generated files or PRs" })),
      verification_results: Type.Optional(Type.Array(Type.Object({
        criterion_id: Type.String(),
        passed: Type.Boolean(),
        actual: Type.Any(),
        expected: Type.Any(),
        error: Type.Optional(Type.String()),
        required: Type.Optional(Type.Boolean()),
      }), { description: "Results from verifying acceptance criteria" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const verificationResults = Array.isArray(params.verification_results)
        ? params.verification_results
        : [];
      const blockingFailures = verificationResults.filter((r: any) => r?.passed === false && r?.required !== false);
      if (params.status === "done" && blockingFailures.length > 0) {
        return {
          content: [{ type: "text", text: `Refusing to report done: required acceptance criteria failed: ${blockingFailures.map((r: any) => r.criterion_id).join(", ")}` }],
          details: { sent: false, target: params.to, status: params.status, blocking_failures: blockingFailures },
        };
      }

      const payload: Record<string, unknown> = {
        status: params.status,
        summary: params.summary,
        task_id: params.task_id || "unknown",
        artifacts: params.artifacts || [],
        verification_results: verificationResults,
        reporter_agent_id: AGENT_ID || "anonymous",
        reporter_role: ROLE || null,
        reporter_mode: MODE || null,
        reporter_pid: process.pid,
        reporter_pane_id: PANE_ID || null,
        reporter_session: SESSION || null,
      };

      const ok = sendMessage(params.to, {
        message_id: randomUUID(),
        from: AGENT_ID || "anonymous",
        to: params.to,
        type: "response",
        payload,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [{ type: "text", text: ok ? `Report sent to ${params.to}` : `Failed to report to ${params.to}` }],
        details: { sent: ok, target: params.to, status: params.status },
      };
    },
  });

  pi.registerTool({
    name: "fabric_list_agents",
    label: "Fabric List",
    description: "List all registered Fabric agents from the registry",
    promptSnippet: "List all active agents in the Fabric mesh",
    promptGuidelines: [
      "Use fabric_list_agents to check which agents are alive, their roles, and status.",
      "No parameters needed."
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const rows = withRegistryReadDb((db) => {
        const stmt = db.prepare(
          `SELECT agent_id, role, status, fabric_status, pid, session, model,
                  current_task, queue_length, active_tool, is_streaming, is_thinking,
                  last_seen_at
           FROM agents ORDER BY registered_at`
        );
        return prepareAllWithRetry(stmt, []) as Array<{
          agent_id: string;
          role: string;
          status: string;
          fabric_status: string;
          pid: number;
          session: string;
          model: string;
          current_task: string | null;
          queue_length: number;
          active_tool: string | null;
          is_streaming: number;
          is_thinking: number;
          last_seen_at: string;
        }>;
      });

      const text = rows.length
        ? rows
            .map(
              (r) =>
                `- ${r.agent_id} (${r.role}) status=${r.fabric_status ?? r.status} pid=${r.pid ?? "?"} session=${r.session ?? "?"} model=${r.model ?? "?"}${r.active_tool ? ` tool=${r.active_tool}` : ""}`
            )
            .join("\n")
        : "No agents registered.";

      return {
        content: [{ type: "text", text }],
        details: { agents: rows },
      };
    },
  });
}
