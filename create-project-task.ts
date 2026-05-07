import { DatabaseSync } from "node:sqlite";
import { initDb } from "./src/pm/db.js";
import { createProject, createTask } from "./src/pm/commands.js";
import fs from "node:fs";

const dbPath = process.env.FABRIC_DIR ? `${process.env.FABRIC_DIR}/projects.sqlite` : "/tmp/fabric-agents/projects.sqlite";

const db = new DatabaseSync(dbPath);

// Verify DB structure
try {
  const resultProject = createProject(db, {
    name: "LoanTransferV2",
    description: "Migrar el flujo LoanSellProcess, actualmente en la JVM a Go.",
    repo_local_path: "~/code/core-financial-platform/"
  });
  const projectId = resultProject.id;

  console.log(`Created Project LoanTransferV2 with ID: ${projectId}`);

  const resultTask = createTask(db, {
    project_id: projectId,
    title: "Fix Google environment variables & Analysis",
    description: "Arreglar las variables de entorno del Google, porque no se están recibiendo. Hacer un análisis completo del problema.",
    branch_name: "master"
  });
  const taskId = resultTask.id;

  console.log(`Created Task with ID: ${taskId} under Project ${projectId}`);
} catch (error) {
  console.error("Error:", error);
}

db.close();
