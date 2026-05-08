import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { appendRuntimeEvent, type RuntimeEvent } from "./runtime-events.js";
import {
  ensureRegistrySchema,
  openFabricDb,
  openFabricDbReadOnly,
  prepareAllWithRetry,
  prepareGetWithRetry,
  prepareRunWithRetry,
} from "./sqlite-utils.js";

const DEFAULT_FABRIC_DIR = process.env.FABRIC_DIR || "/tmp/fabric-agents";
const DEFAULT_TAIL_BYTES = 64 * 1024;
const DEFAULT_PREVIEW_LINES = 8;

export type RuntimeLogSource = "output" | "mailbox" | "runtime_events" | "monitor";

export interface RuntimeRefreshInput {
  fabricDir?: string;
  agentId: string;
  role: string;
  paneId?: string | null;
  session?: string | null;
  pid?: number | null;
  model?: string | null;
  status?: string | null;
  fabricStatus?: string | null;
  currentTask?: string | null;
  pendingCorrelations?: string[];
  lastError?: string | null;
  isStreaming?: boolean;
  isThinking?: boolean;
  activeTool?: string | null;
  queueLength?: number;
  ensureStateFile?: boolean;
  state?: {
    lastOffset?: number;
    lastProcessed?: number;
    pendingCorrelations?: string[];
    lastFabricStatus?: string | null;
  };
}

export interface RuntimeRefreshResult {
  refreshed_at: string;
  event_id: string;
  registry_db_path: string;
  runtime_events_path: string;
  mailbox_path: string;
  pid_path: string;
  state_path: string;
  agent: Record<string, unknown>;
}

export interface RuntimeSnapshotInput {
  fabricDir?: string;
  agentIds?: string[];
  roles?: string[];
  session?: string;
  includeRecentEvents?: boolean;
  recentEventLimit?: number;
}

export interface RuntimeLogSnapshotInput {
  fabricDir?: string;
  agentIds?: string[];
  sources?: RuntimeLogSource[] | string[];
  lineLimit?: number;
}

interface RuntimePaths {
  fabricDir: string;
  registryDbPath: string;
  runtimeEventsPath: string;
  monitorLogPath: string;
  outputsDir: string;
  mailboxDir: string;
  pidDir: string;
  stateDir: string;
}

interface RegistryAgentRow {
  agent_id: string;
  role: string;
  pane_id: string | null;
  session: string | null;
  pid: number | null;
  model: string | null;
  status: string | null;
  registered_at: string | null;
  last_seen_at: string | null;
  fabric_status: string | null;
  current_task: string | null;
  pending_correlations: string | null;
  last_error: string | null;
  is_streaming: number | null;
  is_thinking: number | null;
  active_tool: string | null;
  queue_length: number | null;
}

interface TailTextResult {
  path: string;
  exists: boolean;
  size_bytes: number;
  truncated: boolean;
  total_lines: number | null;
  returned_lines: number;
  lines: string[];
}

function getRuntimePaths(fabricDir = DEFAULT_FABRIC_DIR): RuntimePaths {
  return {
    fabricDir,
    registryDbPath: join(fabricDir, "registry.sqlite"),
    runtimeEventsPath: join(fabricDir, "runtime-events.jsonl"),
    monitorLogPath: join(fabricDir, "monitor.log"),
    outputsDir: join(fabricDir, "outputs"),
    mailboxDir: join(fabricDir, "mailboxes"),
    pidDir: join(fabricDir, "pids"),
    stateDir: join(fabricDir, "state"),
  };
}

function ensureRuntimeDirs(paths: RuntimePaths): void {
  for (const dir of [paths.fabricDir, paths.mailboxDir, paths.pidDir, paths.stateDir, paths.outputsDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function withRegistryReadDb<T>(registryDbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = openFabricDbReadOnly(registryDbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
}

function parsePendingCorrelations(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function safeReadJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function safeFileSize(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readTailLines(path: string, maxLines = DEFAULT_PREVIEW_LINES, maxBytes = DEFAULT_TAIL_BYTES): TailTextResult {
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      size_bytes: 0,
      truncated: false,
      total_lines: 0,
      returned_lines: 0,
      lines: [],
    };
  }

  const fd = openSync(path, "r");
  try {
    const stats = fstatSync(fd);
    const bytesToRead = Math.min(stats.size, maxBytes);
    const offset = Math.max(0, stats.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    readSync(fd, buffer, 0, bytesToRead, offset);

    const rawText = buffer.toString("utf8");
    const split = rawText.split(/\r?\n/);
    if (offset > 0 && split.length > 0) {
      split.shift();
    }
    const nonEmptyLines = split.filter((line) => line.trim().length > 0);
    const lines = nonEmptyLines.slice(-maxLines);

    return {
      path,
      exists: true,
      size_bytes: stats.size,
      truncated: offset > 0,
      total_lines: offset === 0 ? nonEmptyLines.length : null,
      returned_lines: lines.length,
      lines,
    };
  } finally {
    closeSync(fd);
  }
}

function safePreviewText(value: unknown, maxLen = 180): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

function isProcessAlive(pid: number | null): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRegistryAgents(registryDbPath: string): RegistryAgentRow[] {
  if (!existsSync(registryDbPath)) return [];
  return withRegistryReadDb(registryDbPath, (db) => {
    const stmt = db.prepare(
      `SELECT
        agent_id,
        role,
        pane_id,
        session,
        pid,
        model,
        status,
        registered_at,
        last_seen_at,
        fabric_status,
        current_task,
        pending_correlations,
        last_error,
        is_streaming,
        is_thinking,
        active_tool,
        queue_length
       FROM agents
       ORDER BY last_seen_at DESC, registered_at DESC, agent_id ASC`
    );
    return prepareAllWithRetry(stmt, []) as RegistryAgentRow[];
  });
}

function previewMailboxEntries(path: string, lineLimit: number) {
  const tail = readTailLines(path, lineLimit);
  return {
    ...tail,
    entries: tail.lines.map((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return {
          timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
          from: typeof parsed.from === "string" ? parsed.from : null,
          to: typeof parsed.to === "string" ? parsed.to : null,
          type: typeof parsed.type === "string" ? parsed.type : null,
          correlation_id: typeof parsed.correlation_id === "string" ? parsed.correlation_id : null,
          payload_keys: parsed.payload && typeof parsed.payload === "object"
            ? Object.keys(parsed.payload as Record<string, unknown>).sort()
            : [],
        };
      } catch {
        return { raw: safePreviewText(line) };
      }
    }),
  };
}

function previewOutputEntries(path: string, lineLimit: number) {
  const tail = readTailLines(path, lineLimit);
  return {
    ...tail,
    entries: tail.lines.map((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return {
          timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
          model: typeof parsed.model === "string" ? parsed.model : null,
          stop_reason: typeof parsed.stopReason === "string" ? parsed.stopReason : null,
          is_error: Boolean(parsed.isError),
          preview: safePreviewText(parsed.content),
        };
      } catch {
        return { raw: safePreviewText(line) };
      }
    }),
  };
}

function previewRuntimeEvents(path: string, lineLimit: number, agentIds?: Set<string>) {
  const tail = readTailLines(path, Math.max(lineLimit * 8, lineLimit));
  const entries = tail.lines
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as RuntimeEvent;
        return parsed;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is RuntimeEvent => Boolean(entry))
    .filter((entry) => !agentIds || agentIds.size === 0 || agentIds.has(entry.agent_id))
    .slice(-lineLimit)
    .map((entry) => ({
      event_id: entry.event_id,
      ts: entry.ts,
      type: entry.type,
      agent_id: entry.agent_id,
      payload_keys: entry.payload && typeof entry.payload === "object"
        ? Object.keys(entry.payload as Record<string, unknown>).sort()
        : [],
    }));

  return {
    ...tail,
    returned_lines: entries.length,
    entries,
  };
}

function previewMonitorLog(path: string, lineLimit: number) {
  return readTailLines(path, lineLimit);
}

export function refreshAgentRuntimeRegistration(input: RuntimeRefreshInput): RuntimeRefreshResult {
  const fabricDir = input.fabricDir || DEFAULT_FABRIC_DIR;
  const paths = getRuntimePaths(fabricDir);
  ensureRuntimeDirs(paths);

  const mailboxPath = join(paths.mailboxDir, `${input.agentId}.jsonl`);
  const pidPath = join(paths.pidDir, `${input.agentId}.pid`);
  const statePath = join(paths.stateDir, `${input.agentId}.json`);

  if (!existsSync(mailboxPath)) {
    writeFileSync(mailboxPath, "", { flag: "a" });
  }

  const pid = typeof input.pid === "number" && Number.isFinite(input.pid) && input.pid > 0
    ? Math.trunc(input.pid)
    : null;
  if (pid) {
    writeFileSync(pidPath, String(pid));
  }

  if (input.ensureStateFile !== false) {
    const statePayload = {
      lastOffset: Math.max(0, Math.trunc(input.state?.lastOffset ?? 0)),
      lastProcessed: Math.max(0, Math.trunc(input.state?.lastProcessed ?? Date.now())),
      pendingCorrelations: normalizeStringArray(input.state?.pendingCorrelations ?? input.pendingCorrelations ?? []),
      lastFabricStatus: input.state?.lastFabricStatus ?? input.fabricStatus ?? input.status ?? "idle",
    };
    writeFileSync(statePath, JSON.stringify(statePayload));
  }

  const pendingCorrelations = normalizeStringArray(input.pendingCorrelations);
  const payload = {
    role: input.role,
    pane_id: input.paneId ?? "",
    session: input.session ?? "",
    pid,
    model: input.model ?? "unknown",
    status: input.status ?? "active",
    fabric_status: input.fabricStatus ?? "idle",
    current_task: input.currentTask ?? null,
    pending_correlations: pendingCorrelations,
    last_error: input.lastError ?? null,
    is_streaming: Boolean(input.isStreaming),
    is_thinking: Boolean(input.isThinking),
    active_tool: input.activeTool ?? null,
    queue_length: Math.max(0, Math.trunc(input.queueLength ?? 0)),
  };

  const db = openFabricDb(paths.registryDbPath);
  try {
    ensureRegistrySchema(db);
    prepareRunWithRetry(
      db.prepare(
        `INSERT INTO agents (
          agent_id,
          role,
          pane_id,
          session,
          pid,
          model,
          status,
          fabric_status,
          current_task,
          pending_correlations,
          last_error,
          is_streaming,
          is_thinking,
          active_tool,
          queue_length,
          registered_at,
          last_seen_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          COALESCE((SELECT registered_at FROM agents WHERE agent_id = ?), datetime('now')),
          datetime('now')
        )
        ON CONFLICT(agent_id) DO UPDATE SET
          role = excluded.role,
          pane_id = excluded.pane_id,
          session = excluded.session,
          pid = excluded.pid,
          model = excluded.model,
          status = excluded.status,
          fabric_status = excluded.fabric_status,
          current_task = excluded.current_task,
          pending_correlations = excluded.pending_correlations,
          last_error = excluded.last_error,
          is_streaming = excluded.is_streaming,
          is_thinking = excluded.is_thinking,
          active_tool = excluded.active_tool,
          queue_length = excluded.queue_length,
          last_seen_at = datetime('now')`
      ),
      [
        input.agentId,
        input.role,
        input.paneId ?? null,
        input.session ?? null,
        pid,
        input.model ?? null,
        input.status ?? "active",
        input.fabricStatus ?? "idle",
        input.currentTask ?? null,
        JSON.stringify(pendingCorrelations),
        input.lastError ?? null,
        payload.is_streaming ? 1 : 0,
        payload.is_thinking ? 1 : 0,
        input.activeTool ?? null,
        payload.queue_length,
        input.agentId,
      ]
    );

    const row = prepareGetWithRetry(
      db.prepare(
        `SELECT
          agent_id,
          role,
          pane_id,
          session,
          pid,
          model,
          status,
          fabric_status,
          current_task,
          pending_correlations,
          last_error,
          is_streaming,
          is_thinking,
          active_tool,
          queue_length,
          registered_at,
          last_seen_at
         FROM agents WHERE agent_id = ?`
      ),
      [input.agentId]
    ) as Record<string, unknown>;

    const event = appendRuntimeEvent(paths.runtimeEventsPath, {
      event_id: `rte-${randomUUID()}`,
      type: "agent.runtime_refreshed",
      agent_id: input.agentId,
      payload,
    });

    return {
      refreshed_at: event.ts,
      event_id: event.event_id,
      registry_db_path: paths.registryDbPath,
      runtime_events_path: paths.runtimeEventsPath,
      mailbox_path: mailboxPath,
      pid_path: pidPath,
      state_path: statePath,
      agent: row,
    };
  } finally {
    db.close();
  }
}

export function buildRuntimeSnapshot(input: RuntimeSnapshotInput = {}) {
  const fabricDir = input.fabricDir || DEFAULT_FABRIC_DIR;
  const paths = getRuntimePaths(fabricDir);
  const requestedAgentIds = new Set(normalizeStringArray(input.agentIds));
  const requestedRoles = new Set(normalizeStringArray(input.roles));
  const sessionFilter = typeof input.session === "string" && input.session.trim().length > 0
    ? input.session.trim()
    : null;
  const warnings: string[] = [];

  const rows = readRegistryAgents(paths.registryDbPath).filter((row) => {
    if (requestedAgentIds.size > 0 && !requestedAgentIds.has(row.agent_id)) return false;
    if (requestedRoles.size > 0 && !requestedRoles.has(row.role)) return false;
    if (sessionFilter && row.session !== sessionFilter) return false;
    return true;
  });

  if (!existsSync(paths.registryDbPath)) {
    warnings.push(`Registry database not found: ${paths.registryDbPath}`);
  }
  if (rows.length === 0 && (requestedAgentIds.size > 0 || requestedRoles.size > 0 || sessionFilter)) {
    warnings.push("No agents matched the provided runtime filters.");
  }

  const agents = rows.map((row) => {
    const mailboxPath = join(paths.mailboxDir, `${row.agent_id}.jsonl`);
    const pidPath = join(paths.pidDir, `${row.agent_id}.pid`);
    const statePath = join(paths.stateDir, `${row.agent_id}.json`);
    const outputPath = join(paths.outputsDir, `${row.agent_id.replace(/[^a-zA-Z0-9._-]/g, "_")}.jsonl`);
    const state = safeReadJson<{
      lastOffset?: number;
      lastProcessed?: number;
      pendingCorrelations?: string[];
      lastFabricStatus?: string;
    }>(statePath);
    const mailboxPreview = previewMailboxEntries(mailboxPath, 3);
    const outputPreview = previewOutputEntries(outputPath, 3);
    const mailboxUnreadBytes = mailboxPreview.size_bytes > 0
      ? Math.max(0, mailboxPreview.size_bytes - Math.max(0, Math.trunc(state?.lastOffset ?? 0)))
      : 0;
    const pidFromFile = existsSync(pidPath)
      ? Number(readFileSync(pidPath, "utf8").trim()) || null
      : null;
    const effectivePid = row.pid ?? pidFromFile ?? null;
    const pendingCorrelations = parsePendingCorrelations(row.pending_correlations);

    return {
      agent_id: row.agent_id,
      role: row.role,
      status: row.status ?? "active",
      fabric_status: row.fabric_status ?? row.status ?? "unknown",
      process_alive: isProcessAlive(effectivePid),
      pid: effectivePid,
      pid_file_present: existsSync(pidPath),
      pane_id: row.pane_id ?? "",
      session: row.session ?? "",
      model: row.model ?? "unknown",
      current_task: row.current_task ?? null,
      last_error: row.last_error ?? null,
      queue_length: row.queue_length ?? 0,
      active_tool: row.active_tool ?? null,
      is_streaming: Boolean(row.is_streaming),
      is_thinking: Boolean(row.is_thinking),
      pending_correlations: pendingCorrelations,
      registered_at: row.registered_at,
      last_seen_at: row.last_seen_at,
      mailbox: {
        path: mailboxPath,
        exists: mailboxPreview.exists,
        size_bytes: mailboxPreview.size_bytes,
        total_messages: mailboxPreview.total_lines,
        unread_bytes: mailboxUnreadBytes,
        preview: mailboxPreview.entries,
      },
      state_file: {
        path: statePath,
        exists: existsSync(statePath),
        last_offset: Math.trunc(state?.lastOffset ?? 0),
        last_processed: Math.trunc(state?.lastProcessed ?? 0),
        last_fabric_status: state?.lastFabricStatus ?? null,
        pending_correlations: normalizeStringArray(state?.pendingCorrelations ?? []),
      },
      output_log: {
        path: outputPath,
        exists: outputPreview.exists,
        size_bytes: outputPreview.size_bytes,
        preview: outputPreview.entries,
      },
    };
  });

  const selectedAgentIds = new Set(agents.map((agent) => agent.agent_id));
  const recentEvents = input.includeRecentEvents
    ? previewRuntimeEvents(paths.runtimeEventsPath, Math.max(1, Math.trunc(input.recentEventLimit ?? 10)), selectedAgentIds)
    : { exists: existsSync(paths.runtimeEventsPath), path: paths.runtimeEventsPath, size_bytes: safeFileSize(paths.runtimeEventsPath), truncated: false, total_lines: 0, returned_lines: 0, lines: [], entries: [] as Array<Record<string, unknown>> };

  return {
    snapshot_id: `runtime-${Date.now()}`,
    generated_at: new Date().toISOString(),
    filters: {
      agent_ids: Array.from(requestedAgentIds),
      roles: Array.from(requestedRoles),
      session: sessionFilter,
      include_recent_events: Boolean(input.includeRecentEvents),
      recent_event_limit: Math.max(1, Math.trunc(input.recentEventLimit ?? 10)),
    },
    paths: {
      fabric_dir: paths.fabricDir,
      registry_db: paths.registryDbPath,
      runtime_events: paths.runtimeEventsPath,
      monitor_log: paths.monitorLogPath,
      outputs_dir: paths.outputsDir,
      mailbox_dir: paths.mailboxDir,
      state_dir: paths.stateDir,
      pid_dir: paths.pidDir,
    },
    summary: {
      selected_agents: agents.length,
      alive_agents: agents.filter((agent) => agent.process_alive).length,
      queued_agents: agents.filter((agent) => agent.queue_length > 0 || agent.mailbox.unread_bytes > 0).length,
      error_agents: agents.filter((agent) => Boolean(agent.last_error) || agent.fabric_status === "error").length,
      sessions: Array.from(new Set(agents.map((agent) => agent.session).filter(Boolean))).sort(),
      roles: Array.from(new Set(agents.map((agent) => agent.role).filter(Boolean))).sort(),
    },
    agents,
    recent_runtime_events: recentEvents.entries,
    warnings,
  };
}

export function buildRuntimeLogSnapshot(input: RuntimeLogSnapshotInput = {}) {
  const fabricDir = input.fabricDir || DEFAULT_FABRIC_DIR;
  const paths = getRuntimePaths(fabricDir);
  const requestedAgentIds = normalizeStringArray(input.agentIds);
  const lineLimit = Math.max(1, Math.trunc(input.lineLimit ?? DEFAULT_PREVIEW_LINES));
  const normalizedSources = new Set<RuntimeLogSource>(
    normalizeStringArray(input.sources).flatMap((source) => {
      switch (source) {
        case "output":
        case "mailbox":
        case "runtime_events":
        case "monitor":
          return [source];
        default:
          return [];
      }
    })
  );
  const sources = normalizedSources.size > 0
    ? Array.from(normalizedSources)
    : (["output", "mailbox", "runtime_events", "monitor"] as RuntimeLogSource[]);

  const warnings: string[] = [];
  const handles: Array<Record<string, unknown>> = [];

  if (requestedAgentIds.length === 0 && sources.some((source) => source === "output" || source === "mailbox")) {
    warnings.push("Agent-specific log sources require agent_ids. Global runtime_events and monitor handles are still returned.");
  }

  for (const source of sources) {
    if (source === "output") {
      for (const agentId of requestedAgentIds) {
        const path = join(paths.outputsDir, `${agentId.replace(/[^a-zA-Z0-9._-]/g, "_")}.jsonl`);
        const preview = previewOutputEntries(path, lineLimit);
        handles.push({
          handle_id: `output:${agentId}`,
          source,
          agent_id: agentId,
          path,
          exists: preview.exists,
          size_bytes: preview.size_bytes,
          returned_lines: preview.returned_lines,
          total_lines: preview.total_lines,
          preview: preview.entries,
        });
      }
    }

    if (source === "mailbox") {
      for (const agentId of requestedAgentIds) {
        const path = join(paths.mailboxDir, `${agentId}.jsonl`);
        const preview = previewMailboxEntries(path, lineLimit);
        handles.push({
          handle_id: `mailbox:${agentId}`,
          source,
          agent_id: agentId,
          path,
          exists: preview.exists,
          size_bytes: preview.size_bytes,
          returned_lines: preview.returned_lines,
          total_lines: preview.total_lines,
          preview: preview.entries,
        });
      }
    }

    if (source === "runtime_events") {
      if (requestedAgentIds.length > 0) {
        for (const agentId of requestedAgentIds) {
          const preview = previewRuntimeEvents(paths.runtimeEventsPath, lineLimit, new Set([agentId]));
          handles.push({
            handle_id: `runtime_events:${agentId}`,
            source,
            agent_id: agentId,
            path: paths.runtimeEventsPath,
            exists: preview.exists,
            size_bytes: preview.size_bytes,
            returned_lines: preview.returned_lines,
            total_lines: preview.total_lines,
            preview: preview.entries,
          });
        }
      } else {
        const preview = previewRuntimeEvents(paths.runtimeEventsPath, lineLimit);
        handles.push({
          handle_id: "runtime_events:global",
          source,
          agent_id: null,
          path: paths.runtimeEventsPath,
          exists: preview.exists,
          size_bytes: preview.size_bytes,
          returned_lines: preview.returned_lines,
          total_lines: preview.total_lines,
          preview: preview.entries,
        });
      }
    }

    if (source === "monitor") {
      const preview = previewMonitorLog(paths.monitorLogPath, lineLimit);
      handles.push({
        handle_id: "monitor:global",
        source,
        agent_id: null,
        path: paths.monitorLogPath,
        exists: preview.exists,
        size_bytes: preview.size_bytes,
        returned_lines: preview.returned_lines,
        total_lines: preview.total_lines,
        preview: preview.lines,
      });
    }
  }

  return {
    snapshot_id: `log-${Date.now()}`,
    generated_at: new Date().toISOString(),
    sources,
    agent_ids: requestedAgentIds,
    handles,
    warnings,
    paths: {
      fabric_dir: paths.fabricDir,
      runtime_events: paths.runtimeEventsPath,
      monitor_log: paths.monitorLogPath,
      outputs_dir: paths.outputsDir,
      mailbox_dir: paths.mailboxDir,
    },
  };
}
