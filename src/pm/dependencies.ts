import { DatabaseSync } from "node:sqlite";

export function addSubtaskDependency(
  db: DatabaseSync,
  subtaskId: number,
  dependsOnSubtaskId: number,
  type: "blocking" | "logical" = "blocking"
) {
  if (subtaskId === dependsOnSubtaskId) throw new Error("Subtask cannot depend on itself");
  if (!["blocking", "logical"].includes(type)) throw new Error("Invalid dependency type");

  const subtaskCheck = db.prepare("SELECT id FROM subtasks WHERE id = ? OR id = ?");
  const results = subtaskCheck.all(subtaskId, dependsOnSubtaskId);
  if (results.length < 2) throw new Error("Subtask(s) not found");

  try {
    const stmt = db.prepare(
      "INSERT INTO subtask_dependencies (subtask_id, depends_on_subtask_id, dependency_type) VALUES (?, ?, ?)"
    );
    const info = stmt.run(subtaskId, dependsOnSubtaskId, type);
    return { id: info.lastInsertRowid, subtaskId, dependsOnSubtaskId, type };
  } catch (e: any) {
    if (e.code === "SQLITE_CONSTRAINT_UNIQUE") throw new Error("Dependency already exists");
    throw e;
  }
}

export function removeSubtaskDependency(db: DatabaseSync, subtaskId: number, dependsOnSubtaskId: number) {
  const stmt = db.prepare(
    "DELETE FROM subtask_dependencies WHERE subtask_id = ? AND depends_on_subtask_id = ?"
  );
  const info = stmt.run(subtaskId, dependsOnSubtaskId);
  if (info.changes === 0) throw new Error("Dependency not found");
  return { removed: true };
}

export function getSubtaskDependencies(db: DatabaseSync, subtaskId: number) {
  const stmt = db.prepare("SELECT * FROM subtask_dependencies WHERE subtask_id = ?");
  const dependencies = stmt.all(subtaskId) as any[];
  const blockedBy = dependencies.map((d) => d.depends_on_subtask_id);
  return { dependencies, blockedBy };
}

export function getSubtaskDependents(db: DatabaseSync, subtaskId: number) {
  const stmt = db.prepare("SELECT * FROM subtask_dependencies WHERE depends_on_subtask_id = ?");
  const dependents = stmt.all(subtaskId) as any[];
  return { dependents };
}
