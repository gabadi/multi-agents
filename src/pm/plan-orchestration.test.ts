import { describe, test } from "node:test";
import assert from "node:assert";
import { unlinkSync } from "node:fs";
import { initDb } from "./db.js";
import { parseSpokenPlanToOrchestration, materializeOrchestrationPlan } from "./plan-orchestration.js";

describe("plan-orchestration", () => {
  test("parseSpokenPlanToOrchestration parses steps and explicit dependencies", () => {
    const plan = parseSpokenPlanToOrchestration({
      plan_text: `
      1) Diseñar parser base role:dev
      2) Implementar endpoint /api/plan [deps:1]
      3) Integrar dashboard depende de 2
      `,
      default_role: "dev",
      infer_linear_dependencies: false,
    });

    assert.strictEqual(plan.subtasks.length, 3);
    assert.strictEqual(plan.subtasks[0].local_id, "S1");
    assert.strictEqual(plan.subtasks[1].depends_on_local_ids[0], "S1");
    assert.strictEqual(plan.subtasks[2].depends_on_local_ids[0], "S2");
    assert.strictEqual(plan.dependencies.length, 2);
  });

  test("parseSpokenPlanToOrchestration infers linear dependencies when missing", () => {
    const plan = parseSpokenPlanToOrchestration({
      plan_text: "Diseñar schema; Implementar monitor API; Conectar dashboard",
      infer_linear_dependencies: true,
    });

    assert.strictEqual(plan.subtasks.length, 3);
    assert.deepStrictEqual(plan.subtasks[0].depends_on_local_ids, []);
    assert.deepStrictEqual(plan.subtasks[1].depends_on_local_ids, ["S1"]);
    assert.deepStrictEqual(plan.subtasks[2].depends_on_local_ids, ["S2"]);
    assert.strictEqual(plan.dependencies.length, 2);
  });

  test("materializeOrchestrationPlan inserts subtasks and dependencies", () => {
    const dbPath = "/tmp/fabric-agents/test-plan-orchestration.db";
    try { unlinkSync(dbPath); } catch {}

    const db = initDb(dbPath);

    db.prepare("INSERT INTO projects (name, code, status) VALUES (?, ?, ?)").run("Plan Project", "PLAN", "active");
    const projectId = (db.prepare("SELECT id FROM projects WHERE code = ?").get("PLAN") as { id: number }).id;

    db.prepare("INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)").run(projectId, "Task plan", "in_progress");
    const taskId = (db.prepare("SELECT id FROM tasks WHERE title = ?").get("Task plan") as { id: number }).id;

    const parsed = parseSpokenPlanToOrchestration({
      plan_text: "Paso uno; Paso dos; Paso tres",
      infer_linear_dependencies: true,
    });

    const created = materializeOrchestrationPlan(db, taskId, parsed);

    assert.strictEqual(created.created_subtasks.length, 3);
    assert.strictEqual(created.created_dependencies.length, 2);

    const rowCount = db.prepare("SELECT COUNT(*) as c FROM subtasks WHERE task_id = ?").get(taskId) as { c: number };
    assert.strictEqual(rowCount.c, 3);

    const depCount = db.prepare("SELECT COUNT(*) as c FROM subtask_dependencies").get() as { c: number };
    assert.strictEqual(depCount.c, 2);

    db.close();
  });
});
