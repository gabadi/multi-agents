#!/usr/bin/env npx tsx

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { initDb } from "./src/pm/db.js";
import { createProject, createTask } from "./src/pm/commands.js";

const fabricDir = process.env.FABRIC_DIR || "/tmp/fabric-agents";
const dbPath = `${fabricDir}/projects.sqlite`;

mkdirSync(dirname(dbPath), { recursive: true });
const db = initDb(dbPath);

const projectName = process.env.PROJECT_NAME || "Sample Multi-Agent Project";
const projectDescription =
  process.env.PROJECT_DESCRIPTION ||
  "A sample project created from create-project-task.ts for local testing.";
const repoLocalPath = process.env.REPO_LOCAL_PATH || process.cwd();
const taskTitle = process.env.TASK_TITLE || "Sample task";
const taskDescription =
  process.env.TASK_DESCRIPTION ||
  "Use the coordinator to assign this task to a worker and validate the full Fabric workflow.";
const branchName = process.env.BRANCH_NAME || "main";

try {
  const project = createProject(db, {
    name: projectName,
    description: projectDescription,
    repo_local_path: repoLocalPath,
  });

  const task = createTask(db, {
    project_id: project.id,
    title: taskTitle,
    description: taskDescription,
    branch_name: branchName,
  });

  console.log(JSON.stringify({
    ok: true,
    dbPath,
    project: {
      id: project.id,
      name: projectName,
      repo_local_path: repoLocalPath,
    },
    task: {
      id: task.id,
      title: taskTitle,
      branch_name: branchName,
    },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  db.close();
}
