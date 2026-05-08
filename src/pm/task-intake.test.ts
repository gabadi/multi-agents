import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "./db.js";
import { createProject } from "./commands.js";
import { computeNextTaskSequence, createTaskWithContext, planTaskCreation } from "./task-intake.js";

describe("task-intake", () => {
  let baseDir = "";
  let dbPath = "";

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "cmd-center-task-intake-"));
    dbPath = join(baseDir, "projects.sqlite");
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("computeNextTaskSequence increments within project", () => {
    const db = initDb(dbPath);
    const project = createProject(db, {
      name: "Fabric Control",
      code: "fab",
      repo_local_path: "/repo/fabric",
      status: "active",
    });

    db.prepare("INSERT INTO tasks (project_id, title, status, sequence_order) VALUES (?, ?, ?, ?)").run(project.id, "A", "draft", 2);
    db.prepare("INSERT INTO tasks (project_id, title, status, sequence_order) VALUES (?, ?, ?, ?)").run(project.id, "B", "draft", 5);

    assert.strictEqual(computeNextTaskSequence(db, project.id), 6);
    db.close();
  });

  test("planTaskCreation requires explicit repo path confirmation for create_and_kickoff", () => {
    const db = initDb(dbPath);
    createProject(db, {
      name: "Fabric Control",
      code: "fab",
      status: "active",
    });

    const plan = planTaskCreation(db, {
      project_code: "fab",
      title: "Implement task creation",
      behavior: "create_and_kickoff",
      git_root: "/repo/fabric",
    });

    assert.strictEqual(plan.can_commit, false);
    assert.ok(plan.blockers.includes("repo_local_path_confirmation_required_for_kickoff"));
    assert.ok(plan.requires_confirmation);
    assert.strictEqual(plan.kickoff.proposed_repo_local_path, "/repo/fabric");
    assert.ok(plan.warnings.some((warning) => warning.includes("confirm_repo_local_path")));
    db.close();
  });

  test("planTaskCreation supports create_and_kickoff after explicit repo path confirmation", () => {
    const db = initDb(dbPath);
    createProject(db, {
      name: "Fabric Control",
      code: "fab",
      status: "active",
    });

    const plan = planTaskCreation(db, {
      project_code: "fab",
      title: "Implement task creation",
      behavior: "create_and_kickoff",
      confirm_repo_local_path: "/repo/fabric",
      base_branch: "public-main",
    });

    assert.strictEqual(plan.can_commit, true);
    assert.strictEqual(plan.kickoff_supported, true);
    assert.strictEqual(plan.kickoff.repo_local_path, "/repo/fabric");
    assert.strictEqual(plan.kickoff.repo_local_path_source, "confirmed_input");
    assert.ok(plan.kickoff.worktree_path?.includes("/worktrees/fabric/"));
    assert.strictEqual(plan.kickoff.session_name, `fabric-task-${plan.next_task_id}`);
    assert.strictEqual(plan.kickoff.sub_agent_id, `sub-boss-${plan.next_task_id}`);
    db.close();
  });

  test("createTaskWithContext creates create_only task and active planning analysis", () => {
    const db = initDb(dbPath);
    const project = createProject(db, {
      name: "Fabric Control",
      code: "fab",
      repo_local_path: "/repo/fabric",
      status: "active",
    });

    const created = createTaskWithContext(db, {
      project_id: project.id,
      title: "Implement PM context snapshot",
      description: "Read project context without manual SQL.",
      context_capsule: "User asked for a reusable PM helper.",
      acceptance_criteria: ["project resolves", "preview is safe"],
      keywords: ["pm", "snapshot"],
      coordinator_agent_id: "boss",
      behavior: "create_only",
    });

    assert.ok(created.task.id > 0);
    assert.strictEqual(created.task.project_id, project.id);
    assert.strictEqual(created.task.sequence_order, 1);
    assert.strictEqual(created.task.base_branch, "main");
    assert.ok(created.task.branch_name?.startsWith("fab-"));
    assert.ok(created.analysis?.id);

    const analysisRow = db.prepare("SELECT agent_note, is_active FROM task_analyses WHERE task_id = ?").get(created.task.id) as { agent_note: string; is_active: number };
    assert.strictEqual(analysisRow.is_active, 1);
    assert.ok(analysisRow.agent_note.includes("context_capsule: User asked for a reusable PM helper."));
    db.close();
  });

  test("createTaskWithContext seeds kickoff metadata for create_and_kickoff tasks", () => {
    const db = initDb(dbPath);
    const project = createProject(db, {
      name: "Fabric Control",
      code: "fab",
      status: "active",
    });

    const created = createTaskWithContext(db, {
      project_id: project.id,
      title: "Launch benchmark task",
      behavior: "create_and_kickoff",
      coordinator_agent_id: "boss",
      confirm_repo_local_path: "/repo/fabric",
      base_branch: "public-main",
    });

    assert.ok(created.task.id > 0);
    assert.strictEqual(created.task.status, "draft");
    assert.strictEqual(created.task.orchestrator_agent_id, `sub-boss-${created.task.id}`);
    assert.strictEqual(created.plan.kickoff_supported, true);

    const analysisRow = db.prepare("SELECT agent_note FROM task_analyses WHERE task_id = ?").get(created.task.id) as { agent_note: string };
    assert.ok(analysisRow.agent_note.includes("behavior: create_and_kickoff"));
    assert.ok(analysisRow.agent_note.includes("confirmed_repo_local_path: /repo/fabric"));
    assert.ok(analysisRow.agent_note.includes(`kickoff_sub_agent_id: sub-boss-${created.task.id}`));
    db.close();
  });
});
