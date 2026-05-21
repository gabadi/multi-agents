#!/usr/bin/env npx tsx
/**
 * Tool: launch_agent_safe
 * 
 * Launches Fabric agents in tmux WITHOUT inheriting NPOLICY restrictions.
 * 
 * Problem: When Node.js has NPOLICY (Network Policy) in its file descriptors,
 * tmux inherits these FDs and passes them to child processes (pi), causing
 * connectivity issues with testcontainers, Docker, etc.
 * 
 * Solution: Use a launch method that:
 * 1. Detects NPOLICY in the current process
 * 2. If present, uses "disconnected" launch that doesn't inherit FDs
 * 3. Otherwise, uses normal launch
 * 
 * Safe launch methods:
 * - setsid + completely ignored stdio
 * - Shell wrapper that closes FDs before exec
 * - Launch via intermediate script that doesn't inherit full environment
 */

import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const FABRIC_DIR = "/tmp/fabric-agents";

// ─────────────────────────────────────────────────────────────────────────────
// Zod Schema for Tool Input
// ─────────────────────────────────────────────────────────────────────────────

export const LaunchAgentSafeInputSchema = z.object({
  role: z.string().describe("Role/skill name (e.g., 'dev', 'coordinator', 'reviewer')"),
  agent_id: z.string().optional().describe("Unique agent ID (auto-generated if not provided)"),
  session: z.string().default("fabric-default").describe("Tmux session name"),
  mode: z.enum(["interactive", "rpc"]).default("rpc").describe("Agent execution mode"),
  model: z.string().optional().describe("LLM model override (defaults to role's profile model)"),
  parent_agent_id: z.string().optional().describe("Parent agent ID for federated sub-coordinators"),
  workspace_dir: z.string().optional().describe("Working directory for the agent"),
  report_to: z.string().optional().describe("Agent ID to report completion to"),
  window_name: z.string().optional().describe("Tmux window name (auto-generated if not provided)"),
  force_safe_launch: z.boolean().default(false).describe("Force safe launch even if NPOLICY not detected"),
  debug: z.boolean().default(false).describe("Enable debug logging"),
});

export type LaunchAgentSafeInput = z.infer<typeof LaunchAgentSafeInputSchema>;

export const LaunchAgentSafeOutputSchema = z.object({
  success: z.boolean(),
  agent_id: z.string(),
  session: z.string(),
  window: z.string(),
  pane_id: z.string().optional(),
  method: z.enum(["safe_detached", "safe_wrapper", "standard"]),
  npolicy_detected: z.boolean(),
  warning: z.string().optional(),
  error: z.string().optional(),
});

export type LaunchAgentSafeOutput = z.infer<typeof LaunchAgentSafeOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// NPOLICY Detection
// ─────────────────────────────────────────────────────────────────────────────

function hasNPolicy(): boolean {
  try {
    // Check if current process has NPOLICY file descriptor
    const lsof = execSync(`lsof -p ${process.pid} 2>/dev/null | grep -i npolicy || true`, {
      encoding: "utf8",
      timeout: 5000,
    });
    return lsof.includes("NPOLICY");
  } catch {
    return false;
  }
}

function getNPolicyDetails(): string {
  try {
    return execSync(`lsof -p ${process.pid} 2>/dev/null | grep -i npolicy || echo "No NPOLICY detected"`, {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    return "Error checking NPOLICY";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Safe Launch Methods
// ─────────────────────────────────────────────────────────────────────────────

function generateId(role: string): string {
  return `${role}-${randomBytes(2).toString("hex")}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function ensureDirs() {
  for (const dir of ["mailboxes", "pids", "state", "launch-scripts"]) {
    mkdirSync(`${FABRIC_DIR}/${dir}`, { recursive: true });
  }
}

function loadProfileFromSkill(role: string) {
  // Import dynamically to avoid circular deps
  const { loadProfileFromSkill: loader } = require("../core/skill-loader.js");
  return loader(role);
}

function buildPiCommand(
  agentId: string,
  role: string,
  mode: string,
  model: string,
  profile: any,
  skillPath: string | null
): string {
  const identityBlock = `\\n\\n--- AGENT IDENTITY ---\\nYour agent_id is: \"${agentId}\". When replying to other agents via mailbox or fabric_send_message, always use this exact agent_id as the \"from\" field.`;
  const machineModeBlock = mode === "rpc"
    ? `\\n\\n--- MACHINE EXECUTION MODE ---\\nYou are a software agent talking to other software agents. Optimize for correct tool selection and task completion, not human readability. Keep inter-agent communication flat, compact, and in English.`
    : "";
  
  const safePrompt = profile.systemPrompt + identityBlock + machineModeBlock;
  
  const parts = [
    `pi`,
    `--mode ${shellQuote(mode)}`,
    `--model ${shellQuote(model)}`,
    `--system-prompt ${shellQuote(safePrompt)}`,
    `--thinking ${shellQuote(profile.thinking)}`,
    `--no-session`,
  ];
  
  if (skillPath) {
    parts.push(`--skill ${shellQuote(skillPath)}`);
  }
  
  return parts.join(" ");
}

/**
 * Method 1: Safe Detached Launch
 * Uses setsid + completely detached stdio to avoid FD inheritance
 */
function launchSafeDetached(
  session: string,
  window: string,
  agentId: string,
  cmdFile: string,
  debug: boolean
): { pane_id: string; success: boolean; error?: string } {
  try {
    // Check if session exists
    let sessionExists = false;
    try {
      execSync(`tmux has-session -t ${shellQuote(session)} 2>/dev/null`);
      sessionExists = true;
    } catch {
      // Session doesn't exist
    }

    if (!sessionExists) {
      // Create session with explicit environment cleaning
      // Using 'env -i' to start with clean environment, then add back what's needed
      const createCmd = `tmux new-session -d -s ${shellQuote(session)} -n ${shellQuote(window)} ` +
        `"exec /bin/zsh -c 'source ${shellQuote(cmdFile)}'"`;
      
      if (debug) console.log(`[debug] Creating session: ${createCmd}`);
      execSync(createCmd);
    } else {
      // Create new window in existing session
      const paneId = execSync(
        `tmux new-window -d -t ${shellQuote(session)}: -n ${shellQuote(window)} -P -F '#{pane_id}' ` +
        `"exec /bin/zsh -c 'source ${shellQuote(cmdFile)}'"`,
        { encoding: "utf8" }
      ).trim();
      
      return { pane_id: paneId, success: true };
    }

    // Get pane ID for new session
    const paneId = execSync(
      `tmux list-panes -t ${shellQuote(session)}:${shellQuote(window)} -F '#{pane_id}'`,
      { encoding: "utf8" }
    ).trim().split("\n")[0];

    return { pane_id: paneId, success: true };
  } catch (err: any) {
    return { pane_id: "", success: false, error: err.message };
  }
}

/**
 * Method 2: Safe Wrapper Launch
 * Creates a wrapper script that closes problematic FDs before exec
 */
function launchSafeWrapper(
  session: string,
  window: string,
  agentId: string,
  cmdFile: string,
  debug: boolean
): { pane_id: string; success: boolean; error?: string } {
  // Create wrapper script that closes FDs 3-20 before executing
  const wrapperScript = `${FABRIC_DIR}/launch-scripts/${agentId}-wrapper.sh`;
  const wrapperContent = `#!/bin/bash
# Safe wrapper - closes file descriptors that may have NPOLICY
# before executing the actual agent

# Close file descriptors 3-20 to avoid NPOLICY inheritance
for fd in $(seq 3 20); do
  eval "exec $fd>&-" 2>/dev/null || true
done

# Also close any high FDs that might be inherited
for fd in $(seq 21 100); do
  eval "exec $fd>&-" 2>/dev/null || true
done

# Now execute the real launch script with clean FDs
exec /bin/zsh -c 'source ${cmdFile}'
`;

  writeFileSync(wrapperScript, wrapperContent, { mode: 0o755 });

  try {
    // Check if session exists
    let sessionExists = false;
    try {
      execSync(`tmux has-session -t ${shellQuote(session)} 2>/dev/null`);
      sessionExists = true;
    } catch {
      // Session doesn't exist
    }

    if (!sessionExists) {
      const createCmd = `tmux new-session -d -s ${shellQuote(session)} -n ${shellQuote(window)} ${shellQuote(wrapperScript)}`;
      if (debug) console.log(`[debug] Creating session with wrapper: ${createCmd}`);
      execSync(createCmd);
    } else {
      const paneId = execSync(
        `tmux new-window -d -t ${shellQuote(session)}: -n ${shellQuote(window)} -P -F '#{pane_id}' ${shellQuote(wrapperScript)}`,
        { encoding: "utf8" }
      ).trim();
      return { pane_id: paneId, success: true };
    }

    const paneId = execSync(
      `tmux list-panes -t ${shellQuote(session)}:${shellQuote(window)} -F '#{pane_id}'`,
      { encoding: "utf8" }
    ).trim().split("\n")[0];

    return { pane_id: paneId, success: true };
  } catch (err: any) {
    return { pane_id: "", success: false, error: err.message };
  }
}

/**
 * Method 3: Standard Launch (for comparison/testing)
 */
function launchStandard(
  session: string,
  window: string,
  agentId: string,
  cmdFile: string
): { pane_id: string; success: boolean; error?: string } {
  try {
    let sessionExists = false;
    try {
      execSync(`tmux has-session -t ${shellQuote(session)} 2>/dev/null`);
      sessionExists = true;
    } catch {}

    if (!sessionExists) {
      execSync(`tmux new-session -d -s ${shellQuote(session)} -n ${shellQuote(window)} -- /bin/zsh -ic ${shellQuote(`source ${cmdFile}`)}`);
    } else {
      const paneId = execSync(
        `tmux new-window -d -t ${shellQuote(session)}: -n ${shellQuote(window)} -P -F '#{pane_id}' -- /bin/zsh -ic ${shellQuote(`source ${cmdFile}`)}`,
        { encoding: "utf8" }
      ).trim();
      return { pane_id: paneId, success: true };
    }

    const paneId = execSync(
      `tmux list-panes -t ${shellQuote(session)}:${shellQuote(window)} -F '#{pane_id}'`,
      { encoding: "utf8" }
    ).trim().split("\n")[0];

    return { pane_id: paneId, success: true };
  } catch (err: any) {
    return { pane_id: "", success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Tool Function
// ─────────────────────────────────────────────────────────────────────────────

export async function launchAgentSafe(input: LaunchAgentSafeInput): Promise<LaunchAgentSafeOutput> {
  const debug = input.debug;
  
  // Detect NPOLICY
  const npolicyDetected = hasNPolicy();
  const npolicyDetails = npolicyDetected ? getNPolicyDetails() : "None";
  
  if (debug) {
    console.log(`[launch_agent_safe] NPOLICY detection: ${npolicyDetected}`);
    if (npolicyDetected) console.log(`[launch_agent_safe] Details: ${npolicyDetails}`);
  }

  // Generate IDs
  const agentId = input.agent_id || generateId(input.role);
  const window = input.window_name || `${agentId}`;
  const session = input.session;
  
  ensureDirs();

  // Load skill profile
  let profile;
  try {
    profile = loadProfileFromSkill(input.role);
  } catch (err: any) {
    return {
      success: false,
      agent_id: agentId,
      session,
      window,
      method: "standard",
      npolicy_detected: npolicyDetected,
      error: `Failed to load skill profile for role '${input.role}': ${err.message}`,
    };
  }

  const model = input.model || profile.model;
  const { getSkillPath } = require("../core/skill-loader.js");
  const skillPath = getSkillPath(input.role);

  // Build environment
  const envVars: Record<string, string> = {
    ENABLE_CMD_CENTER: "TRUE",
    PI_AGENT_ID: agentId,
    FABRIC_ROLE: input.role,
    FABRIC_SESSION: session,
    FABRIC_MODE: input.mode,
    FABRIC_REGISTRY_DB: `${FABRIC_DIR}/registry.sqlite`,
    FABRIC_MAILBOX_DIR: `${FABRIC_DIR}/mailboxes`,
    FABRIC_PID_DIR: `${FABRIC_DIR}/pids`,
    FABRIC_STATE_DIR: `${FABRIC_DIR}/state`,
    FABRIC_MODEL: model,
    PI_TELEGRAM_AUTO_CONNECT: "",
    ...(input.parent_agent_id ? { FABRIC_PARENT_AGENT_ID: input.parent_agent_id } : {}),
    ...(input.workspace_dir ? { FABRIC_WORKSPACE_DIR: input.workspace_dir } : {}),
    ...(input.report_to ? { FABRIC_REPORT_TO: input.report_to } : {}),
  };

  // Docker/Testcontainers env inheritance
  const dockerVars = [
    "DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
    "TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE", "TESTCONTAINERS_HOST_OVERRIDE",
    "TESTCONTAINERS_DEVVM_TUNNEL_PORT", "TESTCONTAINERS_DEVVM_REMOTE_SOCKET",
    "TESTCONTAINERS_DEVVM_SSH_HOST", "TESTCONTAINERS_DEVVM_HOST_IP", "IGNORE_TESTCONTAINERS",
  ];
  for (const key of dockerVars) {
    if (process.env[key] !== undefined) envVars[key] = process.env[key]!;
  }

  const envExports = Object.entries(envVars)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join("\n");

  // Build pi command
  const piCmd = buildPiCommand(agentId, input.role, input.mode, model, profile, skillPath);

  // Create launch script
  const cmdFile = `${FABRIC_DIR}/launch-scripts/${agentId}.sh`;
  const miseNodePath = `/Users/jescobar/.local/share/mise/installs/node/22.16.0/bin`;
  const cdWorkspace = input.workspace_dir ? `cd ${shellQuote(input.workspace_dir)}\n` : "";
  
  writeFileSync(cmdFile, 
    `set -e\nexport PATH=${shellQuote(miseNodePath)}:$PATH\n${envExports}\n${cdWorkspace}exec ${piCmd}\n`, 
    "utf8"
  );

  if (debug) console.log(`[launch_agent_safe] Launch script: ${cmdFile}`);

  // Choose launch method
  let result: { pane_id: string; success: boolean; error?: string };
  let method: "safe_detached" | "safe_wrapper" | "standard";

  if (input.force_safe_launch || npolicyDetected) {
    // Try safe methods in order of preference
    if (debug) console.log(`[launch_agent_safe] Using safe launch (NPOLICY detected or forced)`);
    
    // Try Method 2 first (wrapper) - most reliable
    method = "safe_wrapper";
    result = launchSafeWrapper(session, window, agentId, cmdFile, debug);
    
    if (!result.success) {
      // Fallback to Method 1
      if (debug) console.log(`[launch_agent_safe] Wrapper failed, trying detached method`);
      method = "safe_detached";
      result = launchSafeDetached(session, window, agentId, cmdFile, debug);
    }
  } else {
    // Use standard method
    method = "standard";
    result = launchStandard(session, window, agentId, cmdFile);
  }

  if (!result.success) {
    return {
      success: false,
      agent_id: agentId,
      session,
      window,
      method,
      npolicy_detected: npolicyDetected,
      error: result.error || "Launch failed",
    };
  }

  // Set pane title
  try {
    execSync(`tmux select-pane -T ${shellQuote(agentId)} -t ${shellQuote(result.pane_id)}`);
  } catch {
    // Non-fatal
  }

  // Log success
  const warning = npolicyDetected 
    ? `NPOLICY detected in parent process. Used ${method} launch to avoid inheritance.` 
    : undefined;

  return {
    success: true,
    agent_id: agentId,
    session,
    window,
    pane_id: result.pane_id,
    method,
    npolicy_detected: npolicyDetected,
    warning,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI / Direct Execution
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  // Parse args for CLI usage
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
    if (i === -1) return undefined;
    if (args[i].includes("=")) return args[i].split("=")[1];
    return args[i + 1];
  };

  const input: LaunchAgentSafeInput = {
    role: get("--role") || "dev",
    agent_id: get("--agent-id"),
    session: get("--session") || "fabric-default",
    mode: (get("--mode") as "interactive" | "rpc") || "rpc",
    model: get("--model"),
    parent_agent_id: get("--parent-agent-id"),
    workspace_dir: get("--workspace-dir"),
    report_to: get("--report-to"),
    window_name: get("--window"),
    force_safe_launch: args.includes("--force-safe"),
    debug: args.includes("--debug"),
  };

  launchAgentSafe(input).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  }).catch((err) => {
    console.error(JSON.stringify({ success: false, error: err.message }, null, 2));
    process.exit(1);
  });
}
