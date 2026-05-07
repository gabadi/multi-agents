#!/usr/bin/env npx tsx
/**
 * agent-state-reader.ts — Read-only agent runtime state resolver.
 *
 * Reads from the existing agent infrastructure:
 *   - registry.sqlite (agents table)
 *   - /tmp/fabric-agents/pids/{id}.pid
 *   - /tmp/fabric-agents/mailboxes/{id}.jsonl
 *   - /tmp/fabric-agents/agents.jsonl (recent events)
 *
 * Does NOT write to any file.
 * Does NOT join with PM tables.
 * Does NOT create new tables.
 *
 * This module is a read-model object for dashboard integration.
 * It is called by the monitor/dashboard layer, never by PM domain code.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openFabricDbReadOnly } from "../core/sqlite-utils.js";

const FABRIC_DIR = process.env.FABRIC_DIR || "/tmp/fabric-agents";
const REGISTRY_DB = join(FABRIC_DIR, "registry.sqlite");
const PID_DIR = join(FABRIC_DIR, "pids");
const MAILBOX_DIR = join(FABRIC_DIR, "mailboxes");
const EVENTS_LOG = join(FABRIC_DIR, "agents.jsonl");

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface AgentRuntimeState {
  agent_id: string;
  role: string;
  fabric_status: string;
  model: string;
  current_task: string | null;
  pid: number | null;
  process_alive: boolean;
  pane_id: string;
  session: string;
  last_seen_at: string;
  mailbox_pending: number;
  is_streaming: boolean;
  is_thinking: boolean;
  active_tool: string | null;
  pending_correlations: string[];
}

// ─────────────────────────────────────────────────────────────
// Low-level helpers (read-only, zero side effects)
// ─────────────────────────────────────────────────────────────

function isProcessAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(agentId: string): number | null {
  const path = join(PID_DIR, `${agentId}.pid`);
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8").trim();
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function countMailboxLines(agentId: string): number {
  const path = join(MAILBOX_DIR, `${agentId}.jsonl`);
  if (!existsSync(path)) return 0;
  try {
    const text = readFileSync(path, "utf8");
    // Count non-empty lines
    return text.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────
// Registry queries (read-only, short-lived connection)
// ─────────────────────────────────────────────────────────────

function withRegistryDb<T>(fn: (db: DatabaseSync) => T): T {
  if (!existsSync(REGISTRY_DB)) {
    throw new Error(`Registry database not found: ${REGISTRY_DB}`);
  }
  const db = openFabricDbReadOnly(REGISTRY_DB);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Read the runtime state of a single agent from the existing agent system.
 * Returns null if the agent is not in the registry.
 */
export function readAgentState(agentId: string): AgentRuntimeState | null {
  return withRegistryDb((db) => {
    const row = db.prepare(
      `SELECT
        agent_id, role, fabric_status, model, current_task,
        pane_id, session, last_seen_at, is_streaming, is_thinking,
        active_tool, pending_correlations
       FROM agents WHERE agent_id = ?`
    ).get(agentId) as {
      agent_id: string;
      role: string;
      fabric_status: string;
      model: string;
      current_task: string | null;
      pane_id: string;
      session: string;
      last_seen_at: string;
      is_streaming: number;
      is_thinking: number;
      active_tool: string | null;
      pending_correlations: string | null;
    } | undefined;

    if (!row) return null;

    const pid = readPid(agentId);

    let pending_correlations: string[] = [];
    if (row.pending_correlations) {
      try {
        const parsed = JSON.parse(row.pending_correlations);
        if (Array.isArray(parsed)) pending_correlations = parsed;
      } catch { /* ignore invalid JSON */ }
    }

    return {
      agent_id: row.agent_id,
      role: row.role,
      fabric_status: row.fabric_status,
      model: row.model,
      current_task: row.current_task,
      pid,
      process_alive: isProcessAlive(pid),
      pane_id: row.pane_id,
      session: row.session,
      last_seen_at: row.last_seen_at,
      mailbox_pending: countMailboxLines(agentId),
      is_streaming: Boolean(row.is_streaming),
      is_thinking: Boolean(row.is_thinking),
      active_tool: row.active_tool,
      pending_correlations,
    };
  });
}

/**
 * List all agents currently registered in the agent system.
 * Does NOT filter by project, task, or subtask.
 */
export function listAgents(): AgentRuntimeState[] {
  return withRegistryDb((db) => {
    const rows = db.prepare(
      `SELECT
        agent_id, role, fabric_status, model, current_task,
        pane_id, session, last_seen_at, is_streaming, is_thinking,
        active_tool, pending_correlations
       FROM agents ORDER BY last_seen_at DESC`
    ).all() as Array<{
      agent_id: string;
      role: string;
      fabric_status: string;
      model: string;
      current_task: string | null;
      pane_id: string;
      session: string;
      last_seen_at: string;
      is_streaming: number;
      is_thinking: number;
      active_tool: string | null;
      pending_correlations: string | null;
    }>;

    return rows.map((row) => {
      const pid = readPid(row.agent_id);

      let pending_correlations: string[] = [];
      if (row.pending_correlations) {
        try {
          const parsed = JSON.parse(row.pending_correlations);
          if (Array.isArray(parsed)) pending_correlations = parsed;
        } catch { /* ignore */ }
      }

      return {
        agent_id: row.agent_id,
        role: row.role,
        fabric_status: row.fabric_status,
        model: row.model,
        current_task: row.current_task,
        pid,
        process_alive: isProcessAlive(pid),
        pane_id: row.pane_id,
        session: row.session,
        last_seen_at: row.last_seen_at,
        mailbox_pending: countMailboxLines(row.agent_id),
        is_streaming: Boolean(row.is_streaming),
        is_thinking: Boolean(row.is_thinking),
        active_tool: row.active_tool,
        pending_correlations,
      };
    });
  });
}

/**
 * Resolve runtime states for a list of agent IDs.
 * Missing or unregistered agents map to `null`.
 *
 * Use this to enrich a PM task/subtask view with agent runtime data.
 */
export function resolveAgentStates(agentIds: string[]): Record<string, AgentRuntimeState | null> {
  const result: Record<string, AgentRuntimeState | null> = {};
  for (const id of agentIds) {
    if (!id) continue;
    result[id] = readAgentState(id);
  }
  return result;
}

/**
 * Collect all distinct agent IDs referenced by a project tree query result.
 * This is a pure helper; it does not touch the database.
 */
export function collectAgentIdsFromProjectTree(tree: {
  project: unknown;
  tasks: Array<{
    coordinator_agent_id?: string | null;
    orchestrator_agent_id?: string | null;
    subtasks?: Array<{
      worker_agent_id?: string | null;
      qa_agent_id?: string | null;
    }>;
  }>;
}): string[] {
  const ids = new Set<string>();
  for (const task of tree.tasks) {
    if (task.coordinator_agent_id) ids.add(task.coordinator_agent_id);
    if (task.orchestrator_agent_id) ids.add(task.orchestrator_agent_id);
    for (const sub of task.subtasks || []) {
      if (sub.worker_agent_id) ids.add(sub.worker_agent_id);
      if (sub.qa_agent_id) ids.add(sub.qa_agent_id);
    }
  }
  return Array.from(ids);
}
