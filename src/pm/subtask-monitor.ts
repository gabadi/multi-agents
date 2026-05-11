import { DatabaseSync } from "node:sqlite";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  findReadySubtasks,
  countActiveAssignmentsByRole,
} from "./subtask-queries.js";
import {
  launchWorker,
  assignSubtask,
  handleLaunchError,
  sendTaskContract,
} from "./subtask-launcher.js";

// ─── Configuration (lazy evaluation so tests can set env vars before runMonitorLoop) ───
function getIntervalMs(): number {
  return Number(process.env.SUBTASK_MONITOR_INTERVAL_MS) || 5000;
}
function getMaxConcurrent(role: string): number {
  const defaults: Record<string, number> = {
    dev: Number(process.env.SUBTASK_MAX_CONCURRENT_DEV) || 3,
    reviewer: Number(process.env.SUBTASK_MAX_CONCURRENT_REVIEWER) || 2,
    devops: Number(process.env.SUBTASK_MAX_CONCURRENT_DEVOPS) || 2,
  };
  return defaults[role.toLowerCase()] ?? defaults["dev"];
}
function getLogPath(): string {
  return (
    process.env.SUBTASK_MONITOR_LOG_PATH ||
    "/tmp/fabric-agents/subtask-monitor.log"
  );
}
function getDbPath(): string {
  return (
    process.env.PROJECTS_DB_PATH ||
    join(process.env.FABRIC_DIR || "/tmp/fabric-agents", "projects.sqlite")
  );
}

// ─── Runtime state ───
let running = false;
let iteration = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let coordinatorIdGlobal: string | null = null;
let isTickRunning = false;

// ─── Injected dependencies (for testing) ───
interface MonitorDeps {
  findReadySubtasks: typeof findReadySubtasks;
  countActiveAssignmentsByRole: typeof countActiveAssignmentsByRole;
  launchWorker: typeof launchWorker;
  assignSubtask: typeof assignSubtask;
  handleLaunchError: typeof handleLaunchError;
}

const defaultDeps: MonitorDeps = {
  findReadySubtasks,
  countActiveAssignmentsByRole,
  launchWorker,
  assignSubtask,
  handleLaunchError,
};

let deps = defaultDeps;

// ─── Logging ───
function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(level: string, message: string): void {
  const path = getLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // ignore if dir already exists
  }
  appendFileSync(path, `[${timestamp()}] [${level}] ${message}\n`);
}

// ─── Helpers ───
function getMaxForRole(role: string): number {
  return getMaxConcurrent(role);
}

function getMailboxPath(agentId: string): string {
  return join(
    process.env.FABRIC_DIR || "/tmp/fabric-agents",
    "mailboxes",
    `${agentId}.jsonl`
  );
}

function getMonitorOffsetPath(coordinatorId: string): string {
  return join(
    process.env.FABRIC_DIR || "/tmp/fabric-agents",
    "state",
    `monitor-${coordinatorId}-offset.json`
  );
}

function extractSubtaskId(payload: Record<string, any>): number | null {
  const explicit = payload.subtask_id ?? payload.subtaskId;
  if (typeof explicit === "number") return explicit;

  const taskId = payload.task_id ?? payload.taskId;
  if (typeof taskId === "string") {
    const match = /^subtask-(\d+)$/.exec(taskId.trim());
    if (match) return Number(match[1]);
  }

  return null;
}

function extractAgentId(payload: Record<string, any>): string | null {
  const agentId = payload.agent_id ?? payload.agentId ?? payload.reporter_agent_id;
  return typeof agentId === "string" && agentId.trim() ? agentId : null;
}

function getReportedStatus(payload: Record<string, any>): "done" | "failed" | "blocked" {
  const status = payload.status;
  if (status === "failed" || status === "blocked") return status;
  return "done";
}

function getSummary(payload: Record<string, any>): string | null {
  const summary = payload.summary;
  return typeof summary === "string" && summary.trim() ? summary : null;
}

function writeSubtaskEvent(
  db: DatabaseSync,
  subtaskId: number,
  newState: string,
  agentId: string | null,
  reason: string | null,
  payload?: Record<string, unknown>
): void {
  db.prepare(
    `INSERT INTO event_log (entity_type, entity_id, actor_type, actor_id, new_state, reason, agent_id, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "subtask",
    subtaskId,
    agentId ? "agent" : "system",
    agentId,
    newState,
    reason,
    agentId,
    payload ? JSON.stringify(payload) : null
  );
}

function scheduleNext(): void {
  if (running) {
    timer = setTimeout(() => tick(), getIntervalMs());
  }
}

// ─── Graceful shutdown ───
function shutdown(): void {
  log("SHUTDOWN", "signal received");
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!isTickRunning) {
    process.exit(0);
  }
  // If a tick is in-flight, tick() will see running=false when it finishes
  // and exit the process.
}

// ─── Core tick ───
async function tick(): Promise<void> {
  if (!running) {
    process.exit(0);
    return;
  }

  if (isTickRunning) {
    iteration++;
    log("MONITOR", `iteration ${iteration} skipped (previous still running)`);
    scheduleNext();
    return;
  }

  isTickRunning = true;
  iteration++;
  log("MONITOR", `iteration ${iteration}`);

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(getDbPath());
    processCompletedSubtasks(db, coordinatorIdGlobal!);
    const ready = deps.findReadySubtasks(db);
    const counts = deps.countActiveAssignmentsByRole(db);

    const countMap = new Map<string, number>();
    for (const c of counts) {
      countMap.set(c.role.toLowerCase(), c.count);
    }

    for (const subtask of ready) {
      const role = (subtask.required_role || "dev").toLowerCase();
      const current = countMap.get(role) || 0;
      const max = getMaxForRole(role);

      if (current >= max) {
        log("CAPACITY", `role ${role} full (${current}/${max})`);
        continue;
      }

      try {
        const agentId = await deps.launchWorker(
          subtask,
          coordinatorIdGlobal!
        );
        log("LAUNCH", `subtask ${subtask.id} -> agent ${agentId} (${role})`);

        const workerMailboxPath = join(
          process.env.FABRIC_DIR || "/tmp/fabric-agents",
          "mailboxes",
          `${agentId}.jsonl`
        );
        sendTaskContract(workerMailboxPath, subtask, coordinatorIdGlobal!, agentId);

        deps.assignSubtask(db, subtask.id, agentId, role);
        countMap.set(role, current + 1);

        // 1. Write event_log
        db!.prepare(
          `INSERT INTO event_log (entity_type, entity_id, actor_type, actor_id, new_state, reason) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          "subtask",
          subtask.id,
          "system",
          "subtask-monitor",
          "running",
          "Auto-assigned by subtask-monitor"
        );

        // 2. Notify coordinator mailbox
        const mailboxPath = getMailboxPath(coordinatorIdGlobal!);
        const notification = JSON.stringify({
          type: "notification",
          payload: {
            event: "subtask.assigned",
            subtask_id: subtask.id,
            agent_id: agentId,
            role,
          },
        });
        try {
          mkdirSync(dirname(mailboxPath), { recursive: true });
        } catch {
          // ignore if dir already exists
        }
        appendFileSync(mailboxPath, notification + "\n");
      } catch (e: any) {
        const errMsg = e?.message || String(e);
        log(
          "ERROR",
          `launchWorker failed for subtask ${subtask.id}: ${errMsg}`
        );
        deps.handleLaunchError(db, subtask.id, errMsg);
      }
    }
  } catch (e: any) {
    log("ERROR", String(e?.message || e));
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
    isTickRunning = false;
  }

  if (!running) {
    process.exit(0);
  } else {
    scheduleNext();
  }
}

// ─── Public API ───

/**
 * Starts the subtask monitor loop. The loop runs until SIGTERM/SIGINT is
 * received or {@link stopMonitorLoop} is called.
 *
 * @param coordinatorId — Fabric agent_id that will receive task contracts
 * @param overrides    — Optional dependency overrides for testing
 */
export function runMonitorLoop(
  coordinatorId: string,
  overrides?: Partial<MonitorDeps>
): void {
  if (running) {
    throw new Error("Monitor loop is already running");
  }
  running = true;
  coordinatorIdGlobal = coordinatorId;
  if (overrides) {
    deps = { ...defaultDeps, ...overrides };
  }

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  tick();
}

/** Stops the monitor loop without sending a signal. */
export function stopMonitorLoop(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Returns current monitor runtime state (for testing / observability). */
/** Resets all internal monitor state (for testing). */
export function resetMonitorState(): void {
  running = false;
  iteration = 0;
  timer = null;
  coordinatorIdGlobal = null;
  isTickRunning = false;
  deps = defaultDeps;
}

/** Returns current monitor runtime state (for testing / observability). */
export function getMonitorState(): {
  running: boolean;
  isTickRunning: boolean;
  iteration: number;
  timer: ReturnType<typeof setTimeout> | null;
} {
  return { running, isTickRunning, iteration, timer };
}

/**
 * Reads the coordinator mailbox looking for response/completion messages
 * that reference subtasks, then applies the reported terminal status,
 * assignment outcome, and retry behavior.
 *
 * @param db            — open SQLite DatabaseSync handle
 * @param coordinatorId — Fabric agent_id whose mailbox is read
 */
export function processCompletedSubtasks(
  db: DatabaseSync,
  coordinatorId: string
): void {
  const mailboxPath = getMailboxPath(coordinatorId);
  const offsetPath = getMonitorOffsetPath(coordinatorId);

  let offset = 0;
  try {
    const stateRaw = readFileSync(offsetPath, "utf8");
    const state = JSON.parse(stateRaw);
    offset = state.offset || 0;
  } catch {
    // no state yet, start from 0
  }

  if (!existsSync(mailboxPath)) {
    return;
  }

  const raw = readFileSync(mailboxPath, "utf8");
  if (raw.length <= offset) {
    return;
  }

  const newChunk = raw.slice(offset);
  const lines = newChunk.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type !== "response" && msg.type !== "completion") {
        continue;
      }

      const payload = (msg.payload || msg) as Record<string, any>;
      const subtaskId = extractSubtaskId(payload);
      const agentId = extractAgentId(payload);
      const reportedStatus = getReportedStatus(payload);
      const summary = getSummary(payload);

      if (subtaskId == null) {
        continue;
      }

      const subtask = db.prepare(
        `SELECT attempt_count, max_attempts FROM subtasks WHERE id = ?`
      ).get(subtaskId) as { attempt_count: number | null; max_attempts: number | null } | undefined;
      if (!subtask) {
        continue;
      }

      const attempts = subtask.attempt_count ?? 0;
      const maxAttempts = subtask.max_attempts ?? 2;
      const verificationResults = Array.isArray(payload.verification_results)
        ? payload.verification_results
        : [];
      const eventPayload = {
        reported_status: reportedStatus,
        verification_results: verificationResults,
        task_id: payload.task_id ?? null,
      };

      const assignmentStatus = reportedStatus === "done"
        ? "completed"
        : reportedStatus === "blocked"
          ? "cancelled"
          : "failed";
      const assignmentSql = agentId
        ? `UPDATE subtask_assignments
             SET status = ?, completed_at = datetime('now'), result_summary = ?
           WHERE subtask_id = ? AND agent_id = ?`
        : `UPDATE subtask_assignments
             SET status = ?, completed_at = datetime('now'), result_summary = ?
           WHERE subtask_id = ?`;
      const assignmentParams = agentId
        ? [assignmentStatus, summary, subtaskId, agentId]
        : [assignmentStatus, summary, subtaskId];
      db.prepare(assignmentSql).run(...assignmentParams);

      if (reportedStatus === "done") {
        db.prepare(
          `UPDATE subtasks
           SET status = 'done',
               result_summary = ?,
               completed_at = datetime('now'),
               updated_at = datetime('now')
           WHERE id = ?`
        ).run(summary, subtaskId);
        writeSubtaskEvent(db, subtaskId, "done", agentId, summary, eventPayload);
        continue;
      }

      if (reportedStatus === "blocked") {
        db.prepare(
          `UPDATE subtasks
           SET status = 'blocked',
               result_summary = ?,
               last_error = ?,
               completed_at = datetime('now'),
               updated_at = datetime('now')
           WHERE id = ?`
        ).run(summary, summary, subtaskId);
        writeSubtaskEvent(db, subtaskId, "blocked", agentId, summary, eventPayload);
        continue;
      }

      if (attempts < maxAttempts) {
        db.prepare(
          `UPDATE subtasks
           SET status = 'ready',
               worker_agent_id = NULL,
               result_summary = ?,
               last_error = ?,
               completed_at = NULL,
               updated_at = datetime('now')
           WHERE id = ?`
        ).run(summary, summary, subtaskId);
        writeSubtaskEvent(
          db,
          subtaskId,
          "ready",
          agentId,
          summary || `Retry queued (${attempts}/${maxAttempts})`,
          { ...eventPayload, retry_queued: true, attempt_count: attempts, max_attempts: maxAttempts }
        );
      } else {
        db.prepare(
          `UPDATE subtasks
           SET status = 'failed',
               result_summary = ?,
               last_error = ?,
               completed_at = datetime('now'),
               updated_at = datetime('now')
           WHERE id = ?`
        ).run(summary, summary, subtaskId);
        writeSubtaskEvent(
          db,
          subtaskId,
          "failed",
          agentId,
          summary,
          { ...eventPayload, retry_queued: false, attempt_count: attempts, max_attempts: maxAttempts }
        );
      }
    } catch {
      // skip malformed lines
    }
  }

  try {
    mkdirSync(dirname(offsetPath), { recursive: true });
  } catch {
    // ignore if dir already exists
  }
  writeFileSync(offsetPath, JSON.stringify({ offset: raw.length }));
}
