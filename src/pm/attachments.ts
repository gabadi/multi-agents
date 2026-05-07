import { DatabaseSync } from "node:sqlite";

function validateUrl(url: string): void {
  if (!url || typeof url !== "string" || !(url.startsWith("https://") || url.startsWith("http://"))) {
    throw new Error("Invalid URL: must be a non-empty string starting with http:// or https://");
  }
}

function getTaskById(db: DatabaseSync, taskId: number): any {
  const stmt = db.prepare("SELECT * FROM tasks WHERE id = ?");
  const task = stmt.get(taskId);
  if (!task) {
    throw new Error(`Task with ID ${taskId} not found`);
  }
  return task;
}

export function attachPR(
  db: DatabaseSync,
  taskId: number,
  prUrl: string,
  prNumber: number
): { taskId: number; prUrl: string; prNumber: number } {
  getTaskById(db, taskId);
  validateUrl(prUrl);

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("Invalid PR number: must be a positive integer");
  }

  const stmt = db.prepare(
    "UPDATE tasks SET pr_url = ?, pr_number = ?, updated_at = datetime('now') WHERE id = ?"
  );
  stmt.run(prUrl, prNumber, taskId);

  return { taskId, prUrl, prNumber };
}

export function markPRMerged(db: DatabaseSync, taskId: number): {
  taskId: number;
  pr_merged_at: string;
} {
  getTaskById(db, taskId);

  const stmt = db.prepare(
    "UPDATE tasks SET pr_merged_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  );
  stmt.run(taskId);

  return { taskId, pr_merged_at: new Date().toISOString() };
}

export function getAttachments(db: DatabaseSync, taskId: number): {
  prUrl: string | null;
  prNumber: number | null;
  prMergedAt: string | null;
} {
  const task = getTaskById(db, taskId);

  return {
    prUrl: task.pr_url ?? null,
    prNumber: task.pr_number ?? null,
    prMergedAt: task.pr_merged_at ?? null,
  };
}
