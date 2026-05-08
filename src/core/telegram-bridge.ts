/**
 * Telegram Bridge — monitor-owned Telegram transport + routing enqueue.
 * Zero external deps. Node builtins + fetch only.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  interpretMessage,
  type ActiveCoordinatorSnapshot,
  type ActiveProjectSnapshot,
  type TelegramRoutingIntent,
} from "./telegram-nlu.js";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram-config.json");

function getFabricDir(): string {
  return process.env.FABRIC_DIR || "/tmp/fabric-agents";
}

function getMailboxDir(): string {
  return join(getFabricDir(), "mailboxes");
}

function getPidDir(): string {
  return join(getFabricDir(), "pids");
}

function getTelegramDeliveriesLogPath(): string {
  return join(getFabricDir(), "telegram-deliveries.jsonl");
}

function getTelegramSessionsPath(): string {
  return join(getFabricDir(), "telegram-sessions.json");
}

interface PendingRequest {
  requestId: string;
  chatId: number;
  messageId: number;
  agentId: string;
  originalText: string;
  timestamp: number;
}

export interface TelegramSendResult {
  ok: true;
  raw: unknown;
  messageId?: number;
  chatId?: number;
  date?: number;
}

export interface TelegramDeliveryAuditEvent {
  request_id?: string;
  status: "pending_registered" | "attempt" | "sent" | "failed" | "failed_terminal" | "dropped";
  via: "http_outbound" | "monitor_mailbox" | "monitor";
  chat_id?: number;
  reply_to?: number;
  telegram_message_id?: number;
  from_agent?: string;
  target_coordinator?: string;
  error?: string;
  details?: Record<string, unknown>;
}

const pendingRequests = new Map<string, PendingRequest>();
const PENDING_TTL_MS = 10 * 60 * 1000;

export interface AgentInfo {
  agent_id: string;
  role: string;
  fabric_status: string;
  current_task?: string | null;
}

export interface TelegramConfig {
  botToken?: string;
  allowedUserId?: number;
}

export interface ChatSession {
  chatId: number;
  userId?: number;
  activeCoordinatorId: string;
  mode: "streaming" | "buffer" | "approval";
  lastActivity: string;
}

function appendTelegramDeliveryAudit(event: TelegramDeliveryAuditEvent): void {
  try {
    const logPath = getTelegramDeliveriesLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      JSON.stringify({
        ts: new Date().toISOString(),
        source: "telegram-bridge",
        ...event,
      }) + "\n"
    );
  } catch {
    // audit log best effort; never break routing path.
  }
}

function cleanupPending() {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [requestId, req] of pendingRequests) {
    if (req.timestamp < cutoff) {
      pendingRequests.delete(requestId);
      appendTelegramDeliveryAudit({
        request_id: requestId,
        status: "dropped",
        via: "monitor",
        chat_id: req.chatId,
        target_coordinator: req.agentId,
        error: "pending_ttl_expired",
      });
    }
  }
}

export function registerPendingRequest(
  requestId: string,
  chatId: number,
  messageId: number,
  agentId: string,
  originalText: string
): void {
  cleanupPending();
  const entry: PendingRequest = {
    requestId,
    chatId,
    messageId,
    agentId,
    originalText,
    timestamp: Date.now(),
  };
  pendingRequests.set(requestId, entry);
  appendTelegramDeliveryAudit({
    request_id: requestId,
    status: "pending_registered",
    via: "monitor",
    chat_id: chatId,
    reply_to: messageId,
    target_coordinator: agentId,
  });
}

export function getPendingRequest(requestId: string): PendingRequest | undefined {
  cleanupPending();
  return pendingRequests.get(requestId);
}

export function finalizePendingRequest(requestId: string): PendingRequest | undefined {
  const req = pendingRequests.get(requestId);
  if (req) pendingRequests.delete(requestId);
  return req;
}

export function auditTelegramDelivery(event: TelegramDeliveryAuditEvent): void {
  appendTelegramDeliveryAudit(event);
}

export function readConfig(): TelegramConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const file = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as TelegramConfig;
    const config: TelegramConfig = {};

    if (typeof file.botToken === "string" && file.botToken.trim()) {
      config.botToken = file.botToken.trim();
    }

    if (typeof file.allowedUserId === "number" && Number.isFinite(file.allowedUserId)) {
      config.allowedUserId = file.allowedUserId;
    }

    return config;
  } catch {
    return {};
  }
}

export async function tgGetUpdates(
  token: string,
  offset: number,
  signal: AbortSignal
): Promise<any[]> {
  const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&limit=10`;
  const res = await fetch(url, { signal });
  const raw = await res.text();

  let data: any = null;
  if (raw.trim()) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const details = data?.description || raw.trim() || "Telegram API error";
    throw new Error(`HTTP ${res.status}: ${details}`);
  }
  if (!data) throw new Error("Telegram API returned empty or non-JSON body");
  if (!data.ok) throw new Error(data.description || "Telegram API error");
  return data.result || [];
}

export async function tgSendMessage(
  token: string,
  chatId: number,
  text: string,
  options?: { replyTo?: number; parseMode?: string }
): Promise<TelegramSendResult> {
  if (!text.trim()) {
    return { ok: true, raw: { skipped: true, reason: "empty_text" }, chatId };
  }
  if (!Number.isFinite(chatId) || chatId <= 0) {
    throw new Error(`Invalid Telegram chat_id: ${String(chatId)}`);
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: text.slice(0, 4096),
    ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
    ...(options?.replyTo ? { reply_to_message_id: options.replyTo } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  if (!res.ok) throw new Error(`[telegram-bridge] sendMessage failed: HTTP ${res.status} ${raw}`);

  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`[telegram-bridge] sendMessage returned non-JSON body: ${raw}`);
  }

  if (data?.ok === false) {
    throw new Error(data.description || "Telegram API error");
  }

  const result = data?.result;
  return {
    ok: true,
    raw: data,
    messageId: typeof result?.message_id === "number" ? result.message_id : undefined,
    chatId: typeof result?.chat?.id === "number" ? result.chat.id : chatId,
    date: typeof result?.date === "number" ? result.date : undefined,
  };
}

const chatSessions = new Map<number, ChatSession>();
let sessionsLoaded = false;

function loadChatSessions(): void {
  if (sessionsLoaded) return;
  sessionsLoaded = true;

  const path = getTelegramSessionsPath();
  if (!existsSync(path)) return;

  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(raw)) return;

    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const session = item as Partial<ChatSession>;
      const chatId = Number(session.chatId);
      if (!Number.isFinite(chatId) || chatId <= 0) continue;
      chatSessions.set(chatId, {
        chatId,
        userId: typeof session.userId === "number" ? session.userId : undefined,
        activeCoordinatorId: typeof session.activeCoordinatorId === "string" && session.activeCoordinatorId.trim()
          ? session.activeCoordinatorId.trim()
          : "boss",
        mode: session.mode === "buffer" || session.mode === "approval" ? session.mode : "streaming",
        lastActivity: typeof session.lastActivity === "string" && session.lastActivity
          ? session.lastActivity
          : new Date().toISOString(),
      });
    }
  } catch {
    // Ignore corrupt session files; runtime state can be rebuilt.
  }
}

function persistChatSessions(): void {
  try {
    const path = getTelegramSessionsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(Array.from(chatSessions.values()), null, 2), "utf8");
  } catch {
    // best effort; routing should still function in-memory.
  }
}

function touchSession(session: ChatSession): ChatSession {
  session.lastActivity = new Date().toISOString();
  persistChatSessions();
  return session;
}

export function getChatSession(chatId: number, userId?: number): ChatSession {
  loadChatSessions();

  if (!chatSessions.has(chatId)) {
    chatSessions.set(chatId, {
      chatId,
      userId,
      activeCoordinatorId: "boss",
      mode: "streaming",
      lastActivity: new Date().toISOString(),
    });
    persistChatSessions();
  }

  const session = chatSessions.get(chatId)!;
  if (userId != null && session.userId == null) {
    session.userId = userId;
  }
  return touchSession(session);
}

export function getAllSessions(): ChatSession[] {
  loadChatSessions();
  return Array.from(chatSessions.values());
}

export function resetTelegramBridgeStateForTests(): void {
  pendingRequests.clear();
  chatSessions.clear();
  sessionsLoaded = false;
}

export function getActiveCoordinators(agents: AgentInfo[]): ActiveCoordinatorSnapshot[] {
  const allowedRoles = new Set(["coordinator", "sub-coordinator"]);
  const blockedStatuses = new Set(["offline", "shutting_down"]);

  return agents
    .filter((a) => allowedRoles.has(a.role) && !blockedStatuses.has(String(a.fabric_status || "")))
    .map((a) => ({
      agent_id: a.agent_id,
      role: a.role as "coordinator" | "sub-coordinator",
      fabric_status: a.fabric_status,
      current_task: a.current_task ?? null,
    }));
}

function validateCoordinatorRoute(
  targetCoordinatorId: string,
  activeCoordinators: ActiveCoordinatorSnapshot[]
): { ok: true; coordinator: ActiveCoordinatorSnapshot } | { ok: false; reason: string } {
  const coordinator = activeCoordinators.find((c) => c.agent_id === targetCoordinatorId);
  if (!coordinator) return { ok: false, reason: "target_not_active_coordinator" };
  if (coordinator.role !== "coordinator" && coordinator.role !== "sub-coordinator") {
    return { ok: false, reason: "target_not_coordinator_role" };
  }
  return { ok: true, coordinator };
}

export function forwardToValidatedCoordinator(
  coordinatorId: string,
  chatId: number,
  userId: number | undefined,
  rawText: string,
  messageId: number,
  mode: string,
  routingIntent: TelegramRoutingIntent
): string | null {
  const requestId = `tg-req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const queuedAt = new Date().toISOString();

  const msg = {
    message_id: `tg-${Date.now()}`,
    from: "telegram-gateway",
    to: coordinatorId,
    type: "telegram_user_message",
    payload: {
      channel: "telegram",
      request_id: requestId,
      chat_id: chatId,
      user_id: userId,
      message_id: messageId,
      reply_to: messageId,
      received_at: queuedAt,
      raw: {
        text: rawText,
        language: routingIntent.original_language,
      },
      routing: {
        target_coordinator_id: coordinatorId,
        selected_by: routingIntent.monitor_action === "route" ? "llm_intent" : "fallback_boss",
        route_reason: routingIntent.route_reason,
        confidence: routingIntent.confidence,
        project_hint: routingIntent.project_hint,
      },
      normalized: {
        instruction: routingIntent.normalized_instruction,
        original_language: routingIntent.original_language,
      },
      queue_policy: {
        priority: "telegram_high",
        turn_policy: "next_turn_no_interrupt",
        interrupt_current_turn: false,
        ack_when_dequeued: true,
      },
      reply_policy: {
        ack_required: true,
        ack_timing: "when_dequeued",
        final_required: true,
        mode,
      },
      legacy: {
        telegram_request_compat: {
          text: routingIntent.normalized_instruction,
          mode,
        },
      },
    },
    timestamp: queuedAt,
  };

  try {
    const mailboxDir = getMailboxDir();
    mkdirSync(mailboxDir, { recursive: true });
    const mboxPath = `${mailboxDir}/${coordinatorId}.jsonl`;
    appendFileSync(mboxPath, JSON.stringify(msg) + "\n");

    const pidDir = getPidDir();
    const pidPath = `${pidDir}/${coordinatorId}.pid`;
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, "utf8").trim());
      if (pid > 0) {
        try {
          process.kill(pid, "SIGUSR1");
        } catch {
          // stale PID acceptable: mailbox enqueue already durable.
        }
      }
    }

    return requestId;
  } catch (err) {
    console.error(`[telegram-bridge] Failed to forward telegram_user_message to ${coordinatorId}:`, err);
    return null;
  }
}

// Backward-compat wrapper. Legacy path still emits telegram_request.
export function forwardToCoordinator(
  coordinatorId: string,
  chatId: number,
  userId: number | undefined,
  text: string,
  messageId: number,
  mode: string
): string | null {
  const requestId = `tg-req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const msg = {
    message_id: `tg-${Date.now()}`,
    from: "telegram-gateway",
    to: coordinatorId,
    type: "telegram_request",
    payload: {
      chat_id: chatId,
      user_id: userId,
      text,
      reply_to: messageId,
      mode,
      request_id: requestId,
    },
    timestamp: new Date().toISOString(),
  };

  try {
    const mailboxDir = getMailboxDir();
    mkdirSync(mailboxDir, { recursive: true });
    const mboxPath = `${mailboxDir}/${coordinatorId}.jsonl`;
    appendFileSync(mboxPath, JSON.stringify(msg) + "\n");
    const pidDir = getPidDir();
    const pidPath = `${pidDir}/${coordinatorId}.pid`;
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, "utf8").trim());
      if (pid > 0) {
        try { process.kill(pid, "SIGUSR1"); } catch {}
      }
    }
    return requestId;
  } catch (err) {
    console.error(`[telegram-bridge] Failed to forward legacy telegram_request to ${coordinatorId}:`, err);
    return null;
  }
}

function routeQueueStatusText(target: ActiveCoordinatorSnapshot): string {
  const busyStatuses = new Set(["turn_active", "waiting_llm", "streaming", "thinking", "tool_running", "processing"]);
  const busy = busyStatuses.has(String(target.fabric_status || ""));

  // router_queued semantic notification (monitor-level, not agent ACK).
  const state = busy ? "busy" : "idle";
  return busy
    ? `router_queued: queued for ${target.agent_id} (${target.role}, ${state}). It will run next turn without interrupting current work.`
    : `router_queued: queued for ${target.agent_id} (${target.role}, ${state}). It should start on next turn.`;
}

function formatTelegramStatusReply(session: ChatSession, activeCoordinators: ActiveCoordinatorSnapshot[]): string {
  const activeTarget = activeCoordinators.find((c) => c.agent_id === session.activeCoordinatorId);
  const targetStatus = activeTarget
    ? `${activeTarget.agent_id} (${activeTarget.role}, ${activeTarget.fabric_status})`
    : `${session.activeCoordinatorId} (inactive)`;

  return [
    `Current coordinator: ${targetStatus}`,
    `Mode: ${session.mode}`,
    `Active coordinators: ${activeCoordinators.length}`,
  ].join("\n");
}

function formatTelegramCoordinatorList(session: ChatSession, activeCoordinators: ActiveCoordinatorSnapshot[]): string {
  if (activeCoordinators.length === 0) {
    return "No active coordinators are available right now.";
  }

  return [
    "Active coordinators:",
    ...activeCoordinators.map((coordinator) => {
      const marker = coordinator.agent_id === session.activeCoordinatorId ? " [current]" : "";
      const task = coordinator.current_task ? ` task=${coordinator.current_task}` : "";
      return `- ${coordinator.agent_id} (${coordinator.role}, ${coordinator.fabric_status})${task}${marker}`;
    }),
  ].join("\n");
}

export async function processTelegramMessage(
  token: string,
  chatId: number,
  text: string,
  messageId: number,
  userId: number | undefined,
  agents: AgentInfo[],
  activeProjects: ActiveProjectSnapshot[],
  defaultCoordinator: string
): Promise<{ handled: boolean; action?: string; target?: string }> {
  const activeCoordinators = getActiveCoordinators(agents);

  const slash = await handleTelegramCommand(token, chatId, text, messageId, userId, activeCoordinators);
  if (slash === "status") {
    const session = getChatSession(chatId, userId);
    await tgSendMessage(token, chatId, formatTelegramStatusReply(session, activeCoordinators), { replyTo: messageId });
    return { handled: true, action: "status" };
  }

  if (slash === "agents") {
    const session = getChatSession(chatId, userId);
    await tgSendMessage(token, chatId, formatTelegramCoordinatorList(session, activeCoordinators), { replyTo: messageId });
    return { handled: true, action: "agents" };
  }

  if (slash !== "forward") {
    return { handled: true, action: slash };
  }

  if (activeCoordinators.length === 0) {
    await tgSendMessage(token, chatId, "No active coordinator is available right now.", { replyTo: messageId });
    return { handled: true, action: "clarify" };
  }

  const intent = await interpretMessage(text, activeCoordinators, activeProjects, defaultCoordinator);

  if (intent.monitor_action === "clarify" || intent.needs_clarification) {
    await tgSendMessage(
      token,
      chatId,
      intent.user_facing_clarification || "Please clarify which coordinator should handle this.",
      { replyTo: messageId }
    );
    return { handled: true, action: "clarify" };
  }

  const session = getChatSession(chatId, userId);
  const targetId = intent.monitor_action === "route" && intent.intended_coordinator_id
    ? intent.intended_coordinator_id
    : (session.activeCoordinatorId || intent.intended_coordinator_id || defaultCoordinator);

  const routeCheck = validateCoordinatorRoute(targetId, activeCoordinators);
  if (!routeCheck.ok) {
    await tgSendMessage(
      token,
      chatId,
      `Cannot route to '${targetId}' (${routeCheck.reason}). Use /coordinators to list active coordinator targets.`,
      { replyTo: messageId }
    );
    return { handled: true, action: "clarify" };
  }

  session.activeCoordinatorId = routeCheck.coordinator.agent_id;
  touchSession(session);

  const requestId = forwardToValidatedCoordinator(
    routeCheck.coordinator.agent_id,
    chatId,
    userId,
    text,
    messageId,
    session.mode,
    {
      ...intent,
      intended_coordinator_id: routeCheck.coordinator.agent_id,
    }
  );

  if (!requestId) {
    await tgSendMessage(token, chatId, `Failed to enqueue request for ${routeCheck.coordinator.agent_id}.`, { replyTo: messageId });
    return { handled: true, action: "enqueue_failed", target: routeCheck.coordinator.agent_id };
  }

  registerPendingRequest(requestId, chatId, messageId, routeCheck.coordinator.agent_id, text);

  // router_queued is monitor-owned and emitted only after successful enqueue.
  const queuedSend = await tgSendMessage(token, chatId, routeQueueStatusText(routeCheck.coordinator), { replyTo: messageId });
  auditTelegramDelivery({
    request_id: requestId,
    status: "sent",
    via: "monitor",
    chat_id: queuedSend.chatId ?? chatId,
    reply_to: messageId,
    telegram_message_id: queuedSend.messageId,
    target_coordinator: routeCheck.coordinator.agent_id,
    details: {
      lifecycle_event: "router_queued",
      status: "router_queued",
      monitor_owner: true,
    },
  });

  return { handled: true, action: "router_queued", target: routeCheck.coordinator.agent_id };
}

async function handleSystemCommand(
  token: string,
  chatId: number,
  text: string,
  messageId: number,
  agents: AgentInfo[]
): Promise<boolean> {
  const lower = text.toLowerCase();

  if (lower.includes("kill") || lower.includes("matar") || lower.includes("detener")) {
    try {
      const { execSync } = await import("node:child_process");
      const killed: string[] = [];
      for (const agent of agents) {
        try {
          execSync(`kill ${agent.agent_id.includes("telegram") ? "-9 " : ""}$(cat /tmp/fabric-agents/pids/${agent.agent_id}.pid 2>/dev/null) 2>/dev/null || true`);
          killed.push(agent.agent_id);
        } catch {}
      }
      await tgSendMessage(
        token,
        chatId,
        killed.length > 0
          ? `Killed processes: ${killed.join(", ")}`
          : "No processes matched for termination.",
        { replyTo: messageId }
      );
    } catch {
      await tgSendMessage(token, chatId, "Error executing kill command.", { replyTo: messageId });
    }
    return true;
  }

  return false;
}

export async function handleTelegramCommand(
  token: string,
  chatId: number,
  text: string,
  messageId: number,
  userId: number | undefined,
  activeCoordinators: ActiveCoordinatorSnapshot[]
): Promise<"handled" | "status" | "agents" | "forward"> {
  const lower = text.toLowerCase().trim();
  const session = getChatSession(chatId, userId);

  if (lower === "/status") return "status";
  if (lower === "/agents" || lower === "/coordinators") return "agents";

  if (lower === "/mode streaming") {
    session.mode = "streaming";
    touchSession(session);
    await tgSendMessage(token, chatId, "Mode: streaming", { replyTo: messageId });
    return "handled";
  }

  if (lower === "/mode buffer") {
    session.mode = "buffer";
    touchSession(session);
    await tgSendMessage(token, chatId, "Mode: buffer", { replyTo: messageId });
    return "handled";
  }

  if (lower === "/mode approval") {
    session.mode = "approval";
    touchSession(session);
    await tgSendMessage(token, chatId, "Mode: approval", { replyTo: messageId });
    return "handled";
  }

  if (lower === "/results") {
    await tgSendMessage(token, chatId, "No buffered results yet.", { replyTo: messageId });
    return "handled";
  }

  if (lower.startsWith("/switch ")) {
    const target = text.slice(8).trim();
    if (!activeCoordinators.some((c) => c.agent_id === target)) {
      await tgSendMessage(token, chatId, `Invalid coordinator '${target}'. Use /coordinators.`, { replyTo: messageId });
      return "handled";
    }
    session.activeCoordinatorId = target;
    touchSession(session);
    await tgSendMessage(token, chatId, `Routing switched to: ${target}`, { replyTo: messageId });
    return "handled";
  }

  if (lower === "/who") {
    await tgSendMessage(token, chatId, `Current coordinator: ${session.activeCoordinatorId}`, { replyTo: messageId });
    return "handled";
  }

  if (lower === "/boss") {
    session.activeCoordinatorId = "boss";
    touchSession(session);
    await tgSendMessage(token, chatId, "Routing switched to: boss", { replyTo: messageId });
    return "handled";
  }

  if (lower === "/help") {
    const help = [
      "Commands:",
      "/status",
      "/coordinators",
      "/switch <coordinator-id>",
      "/who",
      "/boss",
      "/mode streaming|buffer|approval",
    ].join("\n");
    await tgSendMessage(token, chatId, help, { replyTo: messageId });
    return "handled";
  }

  if (lower.startsWith("/to ")) {
    // /to is routed by NLU parser into TelegramRoutingIntent.
    return "forward";
  }

  if (lower.startsWith("/kill ") || lower === "/kill") {
    const did = await handleSystemCommand(token, chatId, text, messageId, activeCoordinators as AgentInfo[]);
    if (did) return "handled";
  }

  return "forward";
}
