#!/usr/bin/env npx tsx

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { openFabricDb, ensureRegistrySchema, prepareRunWithRetry } from "./sqlite-utils.js";

type RecoveredAgent = {
  agent_id: string;
  role: string;
  pid: number | null;
  pane_id: string;
  session: string;
  model: string;
  status: string;
  fabric_status: string;
};

function getArg(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (index === -1) return undefined;
  if (args[index].includes("=")) return args[index].split("=")[1];
  return args[index + 1];
}

const fabricDir = getArg("--fabric-dir") ?? process.env.FABRIC_DIR ?? "/tmp/fabric-agents";
const registryPath = getArg("--registry") ?? join(fabricDir, "registry.sqlite");
const pidDir = join(fabricDir, "pids");
const outputsDir = join(fabricDir, "outputs");
const eventsLog = join(fabricDir, "agents.jsonl");

function readLastKnownModels(): Map<string, string> {
  const models = new Map<string, string>();
  if (!existsSync(outputsDir)) return models;

  for (const entry of readdirSync(outputsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const agentId = entry.name.replace(/\.jsonl$/, "");
    const lines = readFileSync(join(outputsDir, entry.name), "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as { model?: string };
        if (parsed.model) {
          models.set(agentId, parsed.model);
          break;
        }
      } catch {
        // ignore invalid lines
      }
    }
  }

  return models;
}

function readAgentFactsFromEvents(): Map<string, Partial<RecoveredAgent>> {
  const facts = new Map<string, Partial<RecoveredAgent>>();
  if (!existsSync(eventsLog)) return facts;

  for (const line of readFileSync(eventsLog, "utf8").split("\n").filter(Boolean)) {
    try {
      const event = JSON.parse(line) as { type?: string; agent_id?: string; payload?: Record<string, unknown> };
      if (!event.agent_id) continue;
      const current = facts.get(event.agent_id) ?? {};
      const payload = event.payload ?? {};

      if (event.type === "agent.registered") {
        current.pane_id = String(payload.pane_id ?? current.pane_id ?? "");
        current.session = String(payload.session ?? current.session ?? "");
        current.model = String(payload.model ?? current.model ?? "unknown");
      }

      if (event.type === "agent.status_change") {
        current.fabric_status = String(payload.to ?? current.fabric_status ?? "idle");
      }

      if (event.type === "agent.model_changed") {
        current.model = String(payload.full_model ?? payload.to ?? current.model ?? "unknown");
      }

      facts.set(event.agent_id, current);
    } catch {
      // ignore invalid lines
    }
  }

  return facts;
}

function readTmuxPaneMetadata(): Map<string, { session: string; pane_id: string }> {
  const panes = new Map<string, { session: string; pane_id: string }>();
  try {
    const output = execSync("tmux list-panes -a -F '#{pane_title}\t#{session_name}\t#{pane_id}'", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of output.split("\n").filter(Boolean)) {
      const [title, session, paneId] = line.split("\t");
      if (!title) continue;
      panes.set(title, { session: session ?? "", pane_id: paneId ?? "" });
    }
  } catch {
    // tmux may be offline during rebuild
  }
  return panes;
}

function inferRole(agentId: string): string {
  if (agentId === "boss") return "coordinator";
  if (agentId === "monitor") return "monitor";
  if (agentId.startsWith("sub-")) return "sub-coordinator";
  return agentId.split("-")[0] || "unknown";
}

function collectRecoveredAgents(): RecoveredAgent[] {
  const facts = readAgentFactsFromEvents();
  const panes = readTmuxPaneMetadata();
  const models = readLastKnownModels();
  const agentsById = new Map<string, RecoveredAgent>();

  if (!existsSync(pidDir)) return agents;

  for (const entry of readdirSync(pidDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".pid")) continue;
    const agentId = entry.name.replace(/\.pid$/, "");
    const eventFacts = facts.get(agentId) ?? {};
    const tmuxFacts = panes.get(agentId);
    const rawPid = readFileSync(join(pidDir, entry.name), "utf8").trim();
    const pid = Number(rawPid);

    agentsById.set(agentId, {
      agent_id: agentId,
      role: eventFacts.role ?? inferRole(agentId),
      pid: Number.isFinite(pid) && pid > 0 ? pid : null,
      pane_id: tmuxFacts?.pane_id ?? eventFacts.pane_id ?? "",
      session: tmuxFacts?.session ?? eventFacts.session ?? "",
      model: models.get(agentId) ?? eventFacts.model ?? "unknown",
      status: "active",
      fabric_status: eventFacts.fabric_status ?? "idle",
    });
  }

  return Array.from(agentsById.values());
}

function main(): void {
  if (!existsSync(fabricDir)) {
    throw new Error(`Fabric dir not found: ${fabricDir}`);
  }

  mkdirSync(fabricDir, { recursive: true });

  const db = openFabricDb(registryPath);
  ensureRegistrySchema(db);
  db.exec("DELETE FROM events;");
  db.exec("DELETE FROM agents;");

  const agents = collectRecoveredAgents();
  const insertAgent = db.prepare(`
    INSERT INTO agents (
      agent_id, role, pane_id, session, pid, model, status, registered_at, last_seen_at, fabric_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      role = excluded.role,
      pane_id = excluded.pane_id,
      session = excluded.session,
      pid = excluded.pid,
      model = excluded.model,
      status = excluded.status,
      last_seen_at = datetime('now'),
      fabric_status = excluded.fabric_status
  `);
  const insertEvent = db.prepare("INSERT INTO events (event_id, type, agent_id, payload) VALUES (?, ?, ?, ?)");

  for (const agent of agents) {
    prepareRunWithRetry(insertAgent, [
      agent.agent_id,
      agent.role,
      agent.pane_id,
      agent.session,
      agent.pid,
      agent.model,
      agent.status,
      agent.fabric_status,
    ]);
    prepareRunWithRetry(insertEvent, [
      `evt-${randomUUID()}`,
      "agent.recovered",
      agent.agent_id,
      JSON.stringify({ pid: agent.pid, pane_id: agent.pane_id, session: agent.session, model: agent.model }),
    ]);
  }

  db.close();

  writeFileSync(
    join(fabricDir, "registry-rebuild-summary.json"),
    JSON.stringify({ registry: registryPath, recovered_agents: agents }, null, 2)
  );

  console.log(JSON.stringify({ ok: true, registry: registryPath, recovered_agents: agents.length }, null, 2));
}

main();
