import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { appendFileSync, readFileSync, existsSync, statSync } from "node:fs";

function getFabricDir(): string {
  return process.env.FABRIC_DIR || "/tmp/fabric-agents";
}

function getMailboxPath(agentId: string): string {
  return join(getFabricDir(), "mailboxes", `${agentId}.jsonl`);
}

export interface SubtaskLaunchInput {
  id: number;
  title: string;
  description?: string;
  required_role?: string;
  acceptance_criteria?: Array<{
    id: string;
    description: string;
    type: string;
    params: Record<string, unknown>;
    required: boolean;
  }>;
}

/**
 * Spawns a Fabric worker via src/core/launcher.ts and waits for the agent
 * to ACK via mailbox healthcheck to the coordinator.
 *
 * @param subtask — Subtask descriptor (must expose id, title, optional required_role)
 * @param coordinatorId — Agent ID of the coordinator that will receive the task contract
 * @param model — Optional model override passed to launcher.ts
 * @returns Promise resolving to the generated agentId
 */
export function launchWorker(
  subtask: SubtaskLaunchInput,
  coordinatorId: string,
  model?: string
): Promise<string> {
  const role = subtask.required_role || "dev";
  const agentId = `subtask-${subtask.id}-${Date.now()}`;

  const args = [
    "tsx",
    "src/core/launcher.ts",
    "--role",
    role,
    "--agent-id",
    agentId,
    "--mode",
    "rpc",
    "--report-to",
    coordinatorId,
  ];
  if (model) {
    args.push("--model", model);
  }

  const cwd = process.cwd();

  return new Promise((resolve, reject) => {
    const proc = spawn("npx", args, {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
    });

    proc.on("error", (err) => {
      reject(err);
    });

    proc.stdout?.on("data", () => {
      /* no-op: launcher logs go to pane */
    });

    proc.stderr?.on("data", () => {
      /* no-op: launcher errors go to pane */
    });

    proc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        // Process exited before ACK — waitForWorkerAck will eventually reject,
        // but we do not short-circuit here so the caller gets the standard
        // timeout error message.
      }
    });

    const timeoutMs = Number(process.env.SUBTASK_LAUNCH_TIMEOUT_MS) || 20_000;
    waitForWorkerAck(agentId, coordinatorId, timeoutMs)
      .then((ackAgentId) => {
        if (ackAgentId) {
          resolve(ackAgentId);
        } else {
          reject(
            new Error(
              `Agent ${agentId} did not send alive ACK within ${timeoutMs}ms`
            )
          );
        }
      })
      .catch(reject);
  });
}

/**
 * Waits for the worker to send a healthcheck alive ACK into the coordinator mailbox.
 *
 * @param agentId — Worker identifier to look for
 * @param coordinatorId — Coordinator mailbox receiving the ACK
 * @param timeoutMs — Maximum time to wait
 * @returns The agentId if found, otherwise null
 */
export async function waitForWorkerAck(
  agentId: string,
  coordinatorId: string,
  timeoutMs: number
): Promise<string | null> {
  const mailboxPath = getMailboxPath(coordinatorId);
  const startSize = existsSync(mailboxPath) ? (statSync(mailboxPath).size || 0) : 0;
  const deadline = Date.now() + timeoutMs;
  const interval = 300;

  while (Date.now() < deadline) {
    try {
      if (existsSync(mailboxPath)) {
        const raw = readFileSync(mailboxPath);
        if (raw.length > startSize) {
          const lines = raw.subarray(startSize).toString("utf8").split(/\r?\n/).filter(Boolean);
          for (const line of lines) {
            try {
              const msg = JSON.parse(line) as {
                from?: string;
                type?: string;
                payload?: { status?: string };
              };
              if (msg.from === agentId && msg.type === "healthcheck" && msg.payload?.status === "alive") {
                return agentId;
              }
            } catch {
              // ignore invalid line while tailing mailbox
            }
          }
        }
      }
    } catch {
      // Mailbox may not exist yet.
    }

    await new Promise<void>((r) => setTimeout(r, interval));
  }

  return null;
}

/**
 * Marks a subtask as running and records the worker assignment.
 *
 * @param db — PM DatabaseSync instance
 * @param subtaskId — Subtask primary key
 * @param agentId — Fabric agent_id of the launched worker
 * @param role — Role/skill assigned to the worker (e.g. 'dev', 'reviewer')
 */
export function assignSubtask(
  db: DatabaseSync,
  subtaskId: number,
  agentId: string,
  role: string
): void {
  db.prepare(
    `UPDATE subtasks
     SET status = 'running',
         worker_agent_id = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(agentId, subtaskId);

  db.prepare(
    `INSERT INTO subtask_assignments
       (subtask_id, agent_id, assignment_type, status)
     VALUES (?, ?, 'worker', 'active')`
  ).run(subtaskId, agentId);
}

/**
 * Records a launcher failure on the subtask.
 *
 * @param db — PM DatabaseSync instance
 * @param subtaskId — Subtask primary key
 * @param error — Human-readable failure reason
 */
export function handleLaunchError(
  db: DatabaseSync,
  subtaskId: number,
  error: string
): void {
  db.prepare(
    `UPDATE subtasks
     SET status = 'failed',
         result_summary = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(error, subtaskId);
}

/**
 * Sends a structured task contract to a worker's mailbox and wakes it via
 * SIGUSR1.
 *
 * @param workerMailboxPath — Absolute path to the worker's JSONL mailbox
 * @param subtask           — Subtask descriptor (id, title, description)
 * @param coordinatorId     — Agent ID of the coordinator that will receive the report
 * @param workerAgentId     — Agent ID of the target worker (used for PID lookup)
 */
export function sendTaskContract(
  workerMailboxPath: string,
  subtask: SubtaskLaunchInput,
  coordinatorId: string,
  workerAgentId: string
): void {
  const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const description = subtask.title + (subtask.description ? "\n\n" + subtask.description : "");
  const acceptanceCriteria = subtask.acceptance_criteria?.length
    ? subtask.acceptance_criteria
    : [
        {
          id: `manual-subtask-${subtask.id}`,
          description: "Manually verify that the subtask satisfies the title and description.",
          type: "manual",
          params: { instructions: description },
          required: true,
        },
      ];

  const contract = {
    message_id: messageId,
    from: coordinatorId,
    to: workerAgentId,
    type: "contract",
    payload: {
      description,
      acceptance_criteria: acceptanceCriteria,
      report_to: coordinatorId,
      report_to_when_done: coordinatorId,
      task_id: `subtask-${subtask.id}`,
      files: [] as string[],
    },
    timestamp: new Date().toISOString(),
  };

  appendFileSync(workerMailboxPath, JSON.stringify(contract) + "\n");

  const pidPath = join(
    process.env.FABRIC_DIR || "/tmp/fabric-agents",
    "pids",
    `${workerAgentId}.pid`
  );

  if (existsSync(pidPath)) {
    try {
      const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
      if (!isNaN(pid) && pid > 0) {
        process.kill(pid, "SIGUSR1");
      }
    } catch {
      // Swallow signal errors (process may have died)
    }
  }
}
