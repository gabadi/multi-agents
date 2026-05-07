import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

const DEFAULT_FABRIC_DIR = "/tmp/fabric-agents";
const PROTECTED_AUTO_CLEANUP_ROLES = new Set(["coordinator", "sub-coordinator"]);

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
  selfAgentId?: string | null;
  runCommand?: (command: string) => void;
  signalPid?: (pid: number, signal: NodeJS.Signals) => void;
  removePath?: (path: string) => void;
  appendRuntimeCleanupEvent?: (event: { type: string; agent_id: string; payload: Record<string, unknown> }) => void;
  deleteRegistryAgent?: (agentId: string) => void;
  resolveArtifactPaths?: (agentId: string) => string[];
};

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

function safeAgentFileName(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function defaultCleanupArtifactPaths(agentId: string): string[] {
  return [
    `${DEFAULT_FABRIC_DIR}/pids/${agentId}.pid`,
    `${DEFAULT_FABRIC_DIR}/state/${agentId}.json`,
    `${DEFAULT_FABRIC_DIR}/mailboxes/${agentId}.jsonl`,
    `${DEFAULT_FABRIC_DIR}/launch-scripts/${safeAgentFileName(agentId)}.sh`,
  ];
}

export function shouldAutoCleanupCompletedRpcWorker(input: {
  agentId?: unknown;
  role?: unknown;
  mode?: unknown;
  status?: unknown;
  selfAgentId?: unknown;
}): boolean {
  const agentId = toOptionalString(input.agentId);
  const role = (toOptionalString(input.role) ?? "").toLowerCase();
  const mode = (toOptionalString(input.mode) ?? "").toLowerCase();
  const status = (toOptionalString(input.status) ?? "").toLowerCase();
  const selfAgentId = toOptionalString(input.selfAgentId);

  if (!agentId || (selfAgentId && agentId === selfAgentId)) return false;
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
  const appendRuntimeCleanupEvent = options.appendRuntimeCleanupEvent ?? (() => {});
  const deleteRegistryAgent = options.deleteRegistryAgent ?? (() => {});
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
