#!/usr/bin/env npx tsx
/**
 * Fabric Launcher — Fase 1
 * Crea agentes en tmux panes con pi.dev + Fabric extension activa.
 * Soporte opcional: --monitor para lanzar fabric-monitor.ts
 */

import { execSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, statSync, appendFileSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfileFromSkill, getSkillPath, listAvailableRoles } from "./skill-loader.js";
import { openFabricDbReadOnly, prepareAllWithRetry } from "./sqlite-utils.js";
import { appendRuntimeEvent } from "./runtime-events.js";

const FABRIC_DIR = "/tmp/fabric-agents";
const REGISTRY_DB = `${FABRIC_DIR}/registry.sqlite`;
const RUNTIME_EVENTS_LOG = `${FABRIC_DIR}/runtime-events.jsonl`;

let monitorProc: ReturnType<typeof spawn> | null = null;

function generateId(role: string): string {
  return `${role}-${randomBytes(2).toString("hex")}`;
}

function ensureDirs() {
  for (const dir of ["mailboxes", "pids", "state"]) {
    mkdirSync(`${FABRIC_DIR}/${dir}`, { recursive: true });
  }
}

function initRuntimeLayout() {
  ensureDirs();
  if (!existsSync(RUNTIME_EVENTS_LOG)) {
    appendFileSync(RUNTIME_EVENTS_LOG, "", { flag: "a" });
  }
}

function parseArgs(): {
  role: string;
  agentId: string;
  model?: string;
  session: string;
  mode: "interactive" | "rpc";
  monitor: boolean;
  monitorPort: number;
  skillPath: string | null;
  profile: import("./skill-loader.js").SkillProfile;
  parentAgentId?: string;
  workspaceDir?: string;
  reportTo?: string;
  workspaceSkills: string[];
  noWorkspaceSkills: boolean;
} {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
    if (i === -1) return undefined;
    if (args[i].includes("=")) return args[i].split("=")[1];
    return args[i + 1];
  };

  const role = get("--role");
  if (!role) {
    const available = listAvailableRoles();
    console.error("Usage: npx tsx src/core/launcher.ts --role=<role> [--agent-id=...] [--model=...] [--session=...] [--mode=interactive|rpc] [--parent-agent-id=...] [--workspace-dir=...] [--workspace-skills=a,b] [--no-workspace-skills] [--monitor] [--monitor-port=7474]");
    console.error(`Available roles (from skills/): ${available.join(", ") || "none found"}`);
    process.exit(1);
  }

  let profile;
  try {
    profile = loadProfileFromSkill(role);
  } catch (err) {
    console.error(`Failed to load skill for role '${role}': ${err}`);
    const available = listAvailableRoles();
    console.error(`Available roles: ${available.join(", ") || "none found"}`);
    process.exit(1);
  }

  const rawMode = get("--mode") as "interactive" | "rpc" | undefined;
  const mode = rawMode ?? profile.mode ?? "rpc";
  if (mode !== "interactive" && mode !== "rpc") {
    console.error(`Invalid mode: ${mode}. Must be 'interactive' or 'rpc'.`);
    process.exit(1);
  }

  return {
    role,
    agentId: get("--agent-id") ?? generateId(role),
    model: get("--model") ?? profile.model,
    session: get("--session") ?? "fabric-default",
    mode,
    monitor: args.includes("--monitor"),
    monitorPort: Number(get("--monitor-port")) || 7474,
    skillPath: getSkillPath(role),
    profile,
    parentAgentId: get("--parent-agent-id"),
    workspaceDir: get("--workspace-dir"),
    reportTo: get("--report-to") ?? get("--parent-agent-id") ?? process.env.FABRIC_REPORT_TO,
    workspaceSkills: (get("--workspace-skills") ?? process.env.FABRIC_WORKSPACE_SKILLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    noWorkspaceSkills: args.includes("--no-workspace-skills") || process.env.FABRIC_NO_WORKSPACE_SKILLS === "TRUE",
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function tmuxExec(cmd: string): string {
  return execSync(`tmux ${cmd}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function ensurePiExtensionInstalled(): void {
  try {
    const hotReloadSymlink = resolve(process.env.HOME || "", ".pi/agent/extensions/cmd-center");
    if (existsSync(hotReloadSymlink)) {
      console.log(`[launcher] Extension cmd-center available via hot-reload symlink: ${hotReloadSymlink}`);
      return;
    }

    const listOutput = execSync("pi list", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const isInstalled = listOutput.includes("cmd-center-v2");
    if (!isInstalled) {
      console.log("[launcher] Extension cmd-center-v2 not found in pi. Installing...");
      execSync("pi install /Users/jescobar/code/cmd-center-v2", { encoding: "utf8", stdio: "inherit" });
      console.log("[launcher] Extension installed successfully.");
    } else {
      console.log("[launcher] Extension cmd-center-v2 already installed in pi.");
    }
  } catch (err) {
    console.warn("[launcher] Could not verify/install pi extension:", (err as Error).message);
  }
}

function findMonitorScript(): string | null {
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), "monitor.ts"),
    resolve(dirname(fileURLToPath(import.meta.url)), "fabric-monitor.ts"),
    resolve(process.cwd(), "src/core/monitor.ts"),
    resolve(process.cwd(), "fabric-monitor.ts"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function detectCallerWindow(): { session: string; window: string } | null {
  // If the launcher runs inside tmux (e.g., from a coordinator pi process),
  // detect the current session:window so we spawn the new pane HERE.
  if (!process.env.TMUX) return null;
  try {
    const output = execSync(`tmux display-message -p '#{session_name}:#{window_index}'`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const [sess, win] = output.split(":");
    if (sess && win) return { session: sess, window: win };
  } catch {
    // not in tmux or tmux command failed
  }
  return null;
}

function getAliveAgentPaneIds(): string[] {
  try {
    const db = openFabricDbReadOnly(REGISTRY_DB);
    try {
      const rows = prepareAllWithRetry(
        db.prepare("SELECT agent_id, pane_id, pid, status FROM agents WHERE pane_id IS NOT NULL AND pane_id != ''"),
        []
      ) as Array<{ agent_id: string; pane_id: string; pid: number | null; status: string }>;
      return rows
        .filter((r) => {
          if (r.status === "offline" || r.status === "dead") return false;
          if (!r.pid) return false;
          try {
            process.kill(r.pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .map((r) => r.pane_id);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function mailboxContainsAliveAck(mailboxPath: string, startOffset: number, expectedAgentId: string): boolean {
  if (!existsSync(mailboxPath)) return false;

  const raw = readFileSync(mailboxPath);
  if (raw.length <= startOffset) return false;

  const lines = raw.subarray(startOffset).toString("utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as {
        from?: string;
        type?: string;
        payload?: { status?: string };
      };
      if (msg.from === expectedAgentId && msg.type === "healthcheck" && msg.payload?.status === "alive") {
        return true;
      }
    } catch {
      // ignore partial/corrupt lines during tailing
    }
  }

  return false;
}

function findFreePane(session: string, window: string): string | null {
  try {
    const lines = execSync(
      `tmux list-panes -t ${session}:${window} -F '#{pane_id} #{pane_title} #{pane_pid}'`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim().split("\n");
    for (const line of lines) {
      const parts = line.trim().split(" ");
      if (parts.length < 3) continue;
      const [paneId, title, pidStr] = parts;
      if (title === "free") {
        try {
          process.kill(Number(pidStr), 0);
        } catch {
          return paneId; // Process dead → pane is free
        }
      }
    }
  } catch {
    // list-panes may fail if window doesn't exist yet
  }
  return null;
}

function getWorkspaceSkillRoots(workspaceDir: string): string[] {
  return [
    `${workspaceDir}/.pi/skills`,
    `${workspaceDir}/skills`,
    `${workspaceDir}/.agents/skills`,
    `${workspaceDir}/.claude/skills`,
  ];
}

function resolveWorkspaceSkill(workspaceDir: string, skillNameOrPath: string): string | null {
  const direct = resolve(workspaceDir, skillNameOrPath);
  if (existsSync(direct)) return direct;

  for (const root of getWorkspaceSkillRoots(workspaceDir)) {
    const asDir = resolve(root, skillNameOrPath);
    const asFile = resolve(root, skillNameOrPath, "SKILL.md");
    if (existsSync(asFile)) return asDir;
    if (existsSync(asDir)) return asDir;
  }

  return null;
}

function launchMonitor(port: number) {
  const script = findMonitorScript();
  if (!script) {
    console.error("[launcher] fabric-monitor.ts not found — dashboard will not be available");
    return;
  }
  const proc = spawn("npx", ["tsx", script, `--port=${port}`], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (d) => console.log(`[monitor] ${d.toString().trim()}`));
  proc.stderr?.on("data", (d) => console.error(`[monitor] ${d.toString().trim()}`));
  proc.on("exit", (code) => {
    console.log(`[launcher] Monitor exited with code ${code}`);
    monitorProc = null;
  });
  monitorProc = proc;
  console.log(`[launcher] Spawned monitor on port ${port} (pid=${proc.pid})`);
}

async function main() {
  initRuntimeLayout();
  const { monitor, monitorPort, role, agentId, model, session, mode, skillPath, profile, parentAgentId, workspaceDir, reportTo, workspaceSkills, noWorkspaceSkills } = parseArgs();

  if (monitor) {
    launchMonitor(monitorPort);
  }

  // Ensure the Fabric extension is installed so pi loads it when ENABLE_CMD_CENTER=TRUE
  ensurePiExtensionInstalled();

  console.log(`[launcher] Launching agent ${agentId} (role=${role}, mode=${mode}, session=${session})`);
  if (parentAgentId) {
    console.log(`[launcher] Parent agent: ${parentAgentId} (federated sub-coordinator)`);
  }
  if (workspaceDir) {
    console.log(`[launcher] Workspace dir: ${workspaceDir}`);
  }

  // Determine target window: caller's current window (if inside tmux), else fallback to session arg
  const callerWindow = detectCallerWindow();
  let targetSession: string;
  let targetWindow: string;
  let paneId: string;

  if (callerWindow) {
    targetSession = callerWindow.session;
    targetWindow = callerWindow.window;
    console.log(`[launcher] Caller detected in tmux window ${targetSession}:${targetWindow}`);
  } else {
    targetSession = session;
    targetWindow = "0";
    // Ensure fallback session exists
    let sessionExists = false;
    try {
      tmuxExec(`has-session -t ${targetSession}`);
      sessionExists = true;
    } catch {
      // session does not exist
    }
    if (!sessionExists) {
      tmuxExec(`new-session -d -s ${targetSession}`);
      console.log(`[launcher] Created tmux session: ${targetSession}`);
    }
  }

  const target = `${targetSession}:${targetWindow}`;

  // Build env exports for the launch script
  const envVars: Record<string, string> = {
    ENABLE_CMD_CENTER: "TRUE",
    PI_AGENT_ID: agentId,
    FABRIC_ROLE: role,
    FABRIC_SESSION: targetSession,
    FABRIC_MODE: mode,
    FABRIC_REGISTRY_DB: REGISTRY_DB,
    FABRIC_MAILBOX_DIR: `${FABRIC_DIR}/mailboxes`,
    FABRIC_PID_DIR: `${FABRIC_DIR}/pids`,
    FABRIC_STATE_DIR: `${FABRIC_DIR}/state`,
    FABRIC_MODEL: model ?? profile.model,
    // Telegram is now handled by the dedicated telegram-gateway agent.
    PI_TELEGRAM_AUTO_CONNECT: "",
    // Federated sub-coordinator context
    ...(parentAgentId ? { FABRIC_PARENT_AGENT_ID: parentAgentId } : {}),
    ...(workspaceDir ? { FABRIC_WORKSPACE_DIR: workspaceDir } : {}),
    ...(workspaceSkills.length > 0 ? { FABRIC_WORKSPACE_SKILLS: workspaceSkills.join(",") } : {}),
    ...(noWorkspaceSkills ? { FABRIC_NO_WORKSPACE_SKILLS: "TRUE" } : {}),
    ...(reportTo ? { FABRIC_REPORT_TO: reportTo } : {}),
  };

  const envExports = Object.entries(envVars)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join("\n");

  // Do NOT pass --tools here. Pi treats --tools as a strict allowlist across
  // built-in, extension, and custom tools; passing only role built-ins would
  // hide Fabric/PM tools like fabric_send_task and pm_write_analysis.
  // Role tool restrictions are documented in the skill prompt; the extension
  // also activates fabric_* and pm_* tools during session_start.
  const toolsFlag: string | null = null;

  // Append agent identity so the LLM knows its own ID when replying via mailbox.
  const identityBlock = `\n\n--- AGENT IDENTITY ---\nYour agent_id is: "${agentId}". When replying to other agents via mailbox or fabric_send_message, always use this exact agent_id as the "from" field.`;
  const machineModeBlock = mode === "rpc"
    ? `\n\n--- MACHINE EXECUTION MODE ---\nYou are a software agent talking to other software agents. Optimize for correct tool selection and task completion, not human readability. Keep inter-agent communication flat, compact, and in English.`
    : "";
  const safePrompt = profile.systemPrompt + identityBlock + machineModeBlock;

  const piCmdParts = [
    `pi`,
    `--mode ${shellQuote(mode)}`,
    `--model ${shellQuote(model ?? profile.model)}`,
    `--system-prompt ${shellQuote(safePrompt)}`,
    ...(toolsFlag ? [`--tools ${shellQuote(toolsFlag)}`] : []),
    `--thinking ${shellQuote(profile.thinking)}`,
    `--no-session`,
  ];

  // Auto-load the role skill so pi injects it into context
  if (skillPath) {
    piCmdParts.push(`--skill ${shellQuote(skillPath)}`);
    console.log(`[launcher] Auto-loading skill from ${skillPath}`);
  }

  if (workspaceDir) {
    const selectiveWorkspaceSkills = noWorkspaceSkills || workspaceSkills.length > 0;

    if (selectiveWorkspaceSkills) {
      // --no-skills disables project/user/package auto-discovery, but explicit
      // --skill paths still load. This lets monorepos opt into only the domain
      // skills needed for this worker.
      piCmdParts.push(`--no-skills`);

      if (workspaceSkills.length === 0) {
        console.log("[launcher] Workspace skill auto-discovery disabled; only explicit role skill will load.");
      }

      for (const skillName of workspaceSkills) {
        const resolvedSkill = resolveWorkspaceSkill(workspaceDir, skillName);
        if (resolvedSkill) {
          piCmdParts.push(`--skill ${shellQuote(resolvedSkill)}`);
          console.log(`[launcher] Auto-loading selected workspace skill ${skillName} from ${resolvedSkill}`);
        } else {
          console.warn(`[launcher] Workspace skill not found: ${skillName}`);
        }
      }
    } else {
      // Workspace-local skills are discovered by pi automatically after we cd into
      // workspaceDir below. Do not also pass them via --skill, otherwise symlinked
      // dirs such as .claude/skills -> .agents/skills can be validated/loaded twice.
      const localSkillPaths = getWorkspaceSkillRoots(workspaceDir).filter((localPath) => existsSync(localPath));
      if (localSkillPaths.length > 0) {
        console.log(`[launcher] Workspace skills will be auto-discovered after cd: ${localSkillPaths.join(", ")}`);
      }
    }
  }

  const piCmd = piCmdParts.join(" ");

  // Write launch script to file (avoids ARG_MAX and quoting hell).
  // zsh -i will source ~/.zshrc automatically; we just set env vars and run pi.
  const cmdFile = `${FABRIC_DIR}/launch-scripts/${agentId}.sh`;
  mkdirSync(`${FABRIC_DIR}/launch-scripts`, { recursive: true });
  const cdWorkspace = workspaceDir ? `cd ${shellQuote(workspaceDir)}\n` : "";
  writeFileSync(cmdFile, `set -e\n${envExports}\n${cdWorkspace}exec ${piCmd}\n`, "utf8");

  // Find free pane or create new one — thread-safe via split-window -P -F
  // which returns pane_id directly, eliminating the race condition.
  const freePane = findFreePane(targetSession, targetWindow);
  if (freePane) {
    // Reuse existing pane: respawn-pane kills old process and starts new one.
    // zsh -i loads ~/.zshrc, then sources our script.
    tmuxExec(`respawn-pane -k -t ${freePane} -- /bin/zsh -ic ${shellQuote(`source ${shellQuote(cmdFile)}`)}`);
    tmuxExec(`select-pane -T ${agentId} -t ${freePane}`);
    paneId = freePane;
    console.log(`[launcher] Reused pane ${paneId}`);
  } else {
    // Create new pane: split-window executes /bin/zsh directly (no sh -c).
    // -P prints pane_id, -F formats it. -- separates tmux args from command args.
    paneId = tmuxExec(
      `split-window -h -t ${shellQuote(target)} -P -F '#{pane_id}' -- /bin/zsh -ic ${shellQuote(`source ${shellQuote(cmdFile)}`)}`
    );
    tmuxExec(`select-pane -T ${agentId} -t ${paneId}`);
    console.log(`[launcher] Created pane ${paneId}`);
  }

  // Auto-reorganize all panes in this window for best layout
  try {
    tmuxExec(`select-layout -t ${target} tiled`);
    console.log(`[launcher] Reorganized panes in ${target} (tiled layout)`);
  } catch {
    console.warn(`[launcher] Could not reorganize panes in ${target}`);
  }

  console.log(`[launcher] Pane ID: ${paneId}`);

  appendRuntimeEvent(RUNTIME_EVENTS_LOG, {
    type: "agent.launching",
    agent_id: agentId,
    payload: {
      role,
      pane_id: paneId,
      session: targetSession,
      model: model ?? profile.model,
      mode,
      status: "launching",
      fabric_status: "agent_starting",
    },
  });

  // Pre-create mailbox and state files so the extension finds them immediately
  writeFileSync(`${FABRIC_DIR}/mailboxes/${agentId}.jsonl`, "", { flag: "a" });

  console.log(`[launcher] Agent ${agentId} registered. Waiting for pi to start...`);
  console.log(`[launcher] To attach: tmux attach -t ${targetSession}`);
  console.log(`[launcher] To kill pane: tmux kill-pane -t ${paneId}`);

  // Wait for alive ACK from the agent (sent by extension.ts on session_start)
  if (reportTo) {
    const deadline = Date.now() + 20000;
    let ackReceived = false;
    const targetMailbox = `${FABRIC_DIR}/mailboxes/${reportTo}.jsonl`;
    const startSize = existsSync(targetMailbox) ? (statSync(targetMailbox).size || 0) : 0;

    while (Date.now() < deadline) {
      try {
        if (mailboxContainsAliveAck(targetMailbox, startSize, agentId)) {
          ackReceived = true;
          break;
        }
      } catch {
        // ignore transient mailbox races
      }

      await new Promise<void>((r) => setTimeout(r, 300));
    }

    if (ackReceived) {
      console.log(`[launcher] Agent ${agentId} ACK received. Ready for work.`);
    } else {
      console.warn(`[launcher] WARNING: Agent ${agentId} did not send alive ACK within 20s. Killing pane and cleaning up.`);
      try {
        const paneLog = execSync(`tmux capture-pane -p -t ${paneId} -S -20`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
        console.warn(`[launcher] Last 20 lines from pane ${paneId}:\n${paneLog}`);
      } catch {
        console.warn(`[launcher] Could not capture pane ${paneId} for diagnostics.`);
      }
      // Auto-kill stuck pane
      try {
        tmuxExec(`kill-pane -t ${paneId}`);
        console.log(`[launcher] Killed stuck pane ${paneId}`);
      } catch {
        console.warn(`[launcher] Failed to kill pane ${paneId}`);
      }
      // Mark agent as failed in registry
      try {
        appendRuntimeEvent(RUNTIME_EVENTS_LOG, {
          type: "agent.launch_failed",
          agent_id: agentId,
          payload: { status: "failed", fabric_status: "error", pane_id: paneId, session: targetSession },
        });
      } catch {
        // ignore
      }
    }
  } else {
    console.log(`[launcher] No --report-to set. Skipping alive ACK wait.`);
  }
}

main();
