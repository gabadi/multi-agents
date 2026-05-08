import type { DatabaseSync } from "node:sqlite";
import type { ActorType } from "./enums.js";
import { getTaskById, type TaskRow } from "./queries.js";

export interface SetTaskPrOptions {
  taskId: number;
  prUrl?: string | null;
  prNumber?: number | null;
  prMergedAt?: string | null;
  actorType: ActorType;
  actorId?: string;
  agentId?: string;
  reason?: string;
}

export interface SetTaskPrResult {
  before: Pick<TaskRow, "pr_url" | "pr_number" | "pr_merged_at" | "status">;
  after: Pick<TaskRow, "pr_url" | "pr_number" | "pr_merged_at" | "status">;
  task: TaskRow;
}

export function setTaskPr(db: DatabaseSync, options: SetTaskPrOptions): SetTaskPrResult {
  const task = getTaskById(db, options.taskId);
  if (!task) {
    throw new Error(`Task ${options.taskId} not found`);
  }

  const before = {
    pr_url: task.pr_url,
    pr_number: task.pr_number,
    pr_merged_at: task.pr_merged_at,
    status: task.status,
  };

  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE tasks
       SET pr_url = ?,
           pr_number = ?,
           pr_merged_at = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      options.prUrl ?? null,
      options.prNumber ?? null,
      options.prMergedAt ?? null,
      options.taskId,
    );

    db.prepare(
      `INSERT INTO event_log (
        entity_type,
        entity_id,
        actor_type,
        actor_id,
        previous_state,
        new_state,
        reason,
        agent_id,
        payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "task",
      options.taskId,
      options.actorType,
      options.actorId ?? null,
      task.status,
      task.status,
      options.reason ?? "pr_info_updated",
      options.agentId ?? null,
      JSON.stringify({
        before,
        after: {
          pr_url: options.prUrl ?? null,
          pr_number: options.prNumber ?? null,
          pr_merged_at: options.prMergedAt ?? null,
        },
      }),
    );

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const updated = getTaskById(db, options.taskId);
  if (!updated) {
    throw new Error(`Task ${options.taskId} disappeared after PR update`);
  }

  return {
    before,
    after: {
      pr_url: updated.pr_url,
      pr_number: updated.pr_number,
      pr_merged_at: updated.pr_merged_at,
      status: updated.status,
    },
    task: updated,
  };
}
