import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { initDb } from "./db.js";
import { seed } from "./seed.js";
import { getDashboard, getProjectTree } from "./queries.js";

const STATUS_EMOJIS: Record<string, string> = {
  // Shared / Task states
  draft: "⚪",
  in_progress: "🟡",
  completed: "✅",
  failed: "🔴",
  // Subtask states
  backlog: "⚪",
  running: "🟡",
  validating: "🔵",
  done: "✅",
  // Project states
  planned: "⚪",
  active: "🟢",
  blocked: "🔴",
  cancelled: "⚫",
  archived: "⚫",
};

export function showDashboard(dbPath: string): void {
  let db: DatabaseSync;

  if (!existsSync(dbPath)) {
    console.log("Database not found. Seeding...");
    seed(dbPath);
    db = new DatabaseSync(dbPath);
  } else {
    db = initDb(dbPath);
    const count = (db.prepare(`SELECT COUNT(*) as c FROM projects`).get() as { c: number }).c;
    if (count === 0) {
      console.log("Database empty. Seeding...");
      seed(dbPath);
    }
  }

  const projects = getDashboard(db);

  console.log("\n📊 PROJECT DASHBOARD");
  console.table(projects.map(p => ({
    id: p.id,
    name: p.name,
    code: p.code,
    status: p.status,
    tasks: p.task_count,
    completed: p.tasks_completed,
  })));

  console.log("\n📁 PROJECT TREES");
  for (const proj of projects) {
    const tree = getProjectTree(db, proj.id);
    console.log(`\n🔷 ${tree.project.name} (${tree.project.code}) — ${tree.project.status}`);

    for (const task of tree.tasks) {
      const emoji = STATUS_EMOJIS[task.status] || "⚪";
      const prInfo = task.pr_number ? ` [PR#${task.pr_number}]` : "";
      console.log(`  ${emoji} [${task.status}] ${task.title}${prInfo}`);

      for (const sub of task.subtasks) {
        const subEmoji = STATUS_EMOJIS[sub.status] || "⚪";
        console.log(`    ${subEmoji} [${sub.status}] ${sub.title}`);
      }
    }
  }

  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.argv[2] || "data/project_management.db";
  showDashboard(dbPath);
}
