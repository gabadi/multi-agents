import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "./db.js";
import { createProject, createTask } from "./commands.js";
import { buildProjectContextSnapshot, resolveProjectSelector } from "./project-context.js";

describe("project-context", () => {
  let baseDir = "";
  let dbPath = "";

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "cmd-center-project-context-"));
    dbPath = join(baseDir, "projects.sqlite");
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("resolveProjectSelector prefers exact repo/runtime matches", () => {
    const db = initDb(dbPath);
    const project = createProject(db, {
      name: "Fabric Control",
      code: "fab",
      repo_url: "git@github.com:deazoft/multi-agents.git",
      repo_local_path: "/repo/fabric",
      status: "active",
    });
    createProject(db, {
      name: "Other Project",
      code: "other",
      repo_url: "git@github.com:deazoft/other.git",
      repo_local_path: "/repo/other",
      status: "active",
    });

    const resolution = resolveProjectSelector(db, {
      git_root: "/repo/fabric",
      origin_url: "git@github.com:deazoft/multi-agents.git",
    });

    assert.strictEqual(resolution.project?.id, project.id);
    assert.strictEqual(resolution.ambiguous, false);
    assert.ok((resolution.matched_by || "").includes("git_root"));
    assert.ok((resolution.matched_by || "").includes("origin_url"));
    db.close();
  });

  test("buildProjectContextSnapshot returns active tasks and analysis summaries", () => {
    const db = initDb(dbPath);
    const project = createProject(db, {
      name: "Fabric Control",
      code: "fab",
      repo_url: "git@github.com:deazoft/multi-agents.git",
      repo_local_path: "/repo/fabric",
      status: "active",
    });
    const taskA = createTask(db, {
      project_id: project.id,
      title: "Implement PM tool",
      status: "in_progress",
      sequence_order: 1,
    });
    createTask(db, {
      project_id: project.id,
      title: "Old completed task",
      status: "completed",
      sequence_order: 2,
    });

    db.prepare(
      `INSERT INTO task_analyses
        (task_id, version, keywords, human_note, agent_note, analysis_type, confidence_score, author_id, author_type, created_at, is_active)
       VALUES (?, 'v1', ?, ?, ?, 'planning', 80, 'tester', 'agent', datetime('now'), 1)`
    ).run(taskA.id, JSON.stringify(["pm", "context"]), "summary", "agent context");

    const snapshot = buildProjectContextSnapshot(db, {
      project_code: "fab",
      include_tasks: true,
      include_task_analyses: true,
      active_only: true,
    });

    assert.strictEqual(snapshot.project?.id, project.id);
    assert.strictEqual(snapshot.tasks.active.length, 1);
    assert.strictEqual(snapshot.tasks.active[0].title, "Implement PM tool");
    assert.strictEqual(snapshot.task_analysis_summaries.length, 1);
    assert.deepStrictEqual(snapshot.task_analysis_summaries[0].keywords, ["pm", "context"]);
    assert.strictEqual(snapshot.repo.runtime_repo_candidate, null);
    db.close();
  });

  test("buildProjectContextSnapshot suggests explicit repo path confirmation when project is missing repo_local_path", () => {
    const db = initDb(dbPath);
    createProject(db, {
      name: "Fabric Control",
      code: "fab",
      repo_url: "git@github.com:deazoft/multi-agents.git",
      status: "active",
    });

    const snapshot = buildProjectContextSnapshot(db, {
      project_code: "fab",
      git_root: "/repo/fabric",
      include_tasks: true,
      include_task_analyses: false,
      active_only: true,
    });

    assert.strictEqual(snapshot.project?.code, "fab");
    assert.strictEqual(snapshot.repo.runtime_repo_candidate, "/repo/fabric");
    assert.ok(snapshot.recommended_next_actions.some((item) => item.includes("confirm_repo_local_path=/repo/fabric")));
    db.close();
  });
});
