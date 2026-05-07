import { describe, test } from "node:test";
import assert from "node:assert";
import { unlinkSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  validateContractCompletion,
  allRequiredPassed,
  formatVerificationReport,
  type TaskContract,
} from "./contract-schema.js";

describe("contract-schema", () => {
  const tmpDir = "/tmp/fabric-agents/contract-test";

  function setup(): void {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    mkdirSync(tmpDir, { recursive: true });
  }

  // ─────────────────────────────────────────────────────────────
  // file_exists
  // ─────────────────────────────────────────────────────────────

  test("file_exists passes when file exists", () => {
    setup();
    const path = join(tmpDir, "foo.ts");
    writeFileSync(path, "export const x = 1;");

    const contract: TaskContract = {
      description: "Test",
      acceptance_criteria: [
        { id: "c1", description: "File exists", type: "file_exists", params: { path }, required: true },
      ],
      report_to_when_done: "boss",
    };

    const results = validateContractCompletion(contract);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].passed, true);
    assert.strictEqual(allRequiredPassed(results), true);
  });

  test("file_exists fails when file missing", () => {
    setup();
    const contract: TaskContract = {
      description: "Test",
      acceptance_criteria: [
        { id: "c1", description: "File exists", type: "file_exists", params: { path: "/nonexistent/file.txt" }, required: true },
      ],
      report_to_when_done: "boss",
    };

    const results = validateContractCompletion(contract);
    assert.strictEqual(results[0].passed, false);
    assert.strictEqual(allRequiredPassed(results), false);
  });

  // ─────────────────────────────────────────────────────────────
  // file_contains
  // ─────────────────────────────────────────────────────────────

  test("file_contains passes when pattern found", () => {
    setup();
    const path = join(tmpDir, "bar.ts");
    writeFileSync(path, "export function validateUser() {}");

    const contract: TaskContract = {
      description: "Test",
      acceptance_criteria: [
        { id: "c1", description: "Contains function", type: "file_contains", params: { path, pattern: "function validateUser" }, required: true },
      ],
      report_to_when_done: "boss",
    };

    const results = validateContractCompletion(contract);
    assert.strictEqual(results[0].passed, true);
  });

  test("file_contains fails when pattern missing", () => {
    setup();
    const path = join(tmpDir, "baz.ts");
    writeFileSync(path, "export const x = 1;");

    const contract: TaskContract = {
      description: "Test",
      acceptance_criteria: [
        { id: "c1", description: "Contains function", type: "file_contains", params: { path, pattern: "function missing" }, required: true },
      ],
      report_to_when_done: "boss",
    };

    const results = validateContractCompletion(contract);
    assert.strictEqual(results[0].passed, false);
  });

  test("file_not_contains passes when pattern absent", () => {
    setup();
    const path = join(tmpDir, "no-any.ts");
    writeFileSync(path, "export const x: unknown = 1;");

    const contract: TaskContract = {
      description: "Test",
      acceptance_criteria: [
        { id: "c1", description: "No any", type: "file_not_contains", params: { path, pattern: "\\bany\\b" }, required: true },
      ],
      report_to_when_done: "boss",
    };

    const results = validateContractCompletion(contract);
    assert.strictEqual(results[0].passed, true);
  });

  test("file_not_contains fails when pattern present", () => {
    setup();
    const path = join(tmpDir, "has-any.ts");
    writeFileSync(path, "export const x: any = 1;");

    const contract: TaskContract = {
      description: "Test",
      acceptance_criteria: [
        { id: "c1", description: "No any", type: "file_not_contains", params: { path, pattern: "\\bany\\b" }, required: true },
      ],
      report_to_when_done: "boss",
    };

    const results = validateContractCompletion(contract);
    assert.strictEqual(results[0].passed, false);
    assert.strictEqual(allRequiredPassed(results), false);
  });

  // ─────────────────────────────────────────────────────────────
  // test_passes
  // ─────────────────────────────────────────────────────────────

  test("test_passes with expected_output", () => {
    const contract: TaskContract = {
      description: "Test",
      acceptance_criteria: [
        { id: "c1", description: "Echo works", type: "test_passes", params: { command: "echo hello", expected_output: "hello" }, required: true },
      ],
      report_to_when_done: "boss",
    };

    const results = validateContractCompletion(contract);
    assert.strictEqual(results[0].passed, true);
  });

  test("test_passes fails when expected_output missing", () => {
    const contract: TaskContract = {
      description: "Test",
      acceptance_criteria: [
        { id: "c1", description: "Echo works", type: "test_passes", params: { command: "echo hello", expected_output: "world" }, required: true },
      ],
      report_to_when_done: "boss",
    };

    const results = validateContractCompletion(contract);
    assert.strictEqual(results[0].passed, false);
  });

  // ─────────────────────────────────────────────────────────────
  // db_query
  // ─────────────────────────────────────────────────────────────

  test("db_query with expected_rows", () => {
    setup();
    const dbPath = join(tmpDir, "test.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1), (2);");
    db.close();

    const contract: TaskContract = {
      description: "Test",
      acceptance_criteria: [
        { id: "c1", description: "2 rows", type: "db_query", params: { sql: "SELECT * FROM t", db_path: dbPath, expected_rows: 2 }, required: true },
      ],
      report_to_when_done: "boss",
    };

    const results = validateContractCompletion(contract);
    assert.strictEqual(results[0].passed, true);
  });

  test("db_query fails when expected_rows mismatch", () => {
    setup();
    const dbPath = join(tmpDir, "test2.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1);");
    db.close();

    const contract: TaskContract = {
      description: "Test",
      acceptance_criteria: [
        { id: "c1", description: "2 rows", type: "db_query", params: { sql: "SELECT * FROM t", db_path: dbPath, expected_rows: 2 }, required: true },
      ],
      report_to_when_done: "boss",
    };

    const results = validateContractCompletion(contract);
    assert.strictEqual(results[0].passed, false);
  });

  // ─────────────────────────────────────────────────────────────
  // command_exit_0
  // ─────────────────────────────────────────────────────────────

  test("command_exit_0 passes on success", () => {
    const contract: TaskContract = {
      description: "Test",
      acceptance_criteria: [
        { id: "c1", description: "True exits 0", type: "command_exit_0", params: { command: "true" }, required: true },
      ],
      report_to_when_done: "boss",
    };

    const results = validateContractCompletion(contract);
    assert.strictEqual(results[0].passed, true);
  });

  test("command_exit_0 fails on error", () => {
    const contract: TaskContract = {
      description: "Test",
      acceptance_criteria: [
        { id: "c1", description: "False exits 1", type: "command_exit_0", params: { command: "false" }, required: true },
      ],
      report_to_when_done: "boss",
    };

    const results = validateContractCompletion(contract);
    assert.strictEqual(results[0].passed, false);
  });

  test("command_output_contains passes when output includes expected text", () => {
    const contract: TaskContract = {
      description: "Test",
      acceptance_criteria: [
        { id: "c1", description: "Echo includes hello", type: "command_output_contains", params: { command: "echo hello", expected_output: "hello" }, required: true },
      ],
      report_to_when_done: "boss",
    };

    const results = validateContractCompletion(contract);
    assert.strictEqual(results[0].passed, true);
  });

  test("command_output_not_contains fails when forbidden output appears", () => {
    const contract: TaskContract = {
      description: "Test",
      acceptance_criteria: [
        { id: "c1", description: "Output must not include secret", type: "command_output_not_contains", params: { command: "echo secret", forbidden_output: "secret" }, required: true },
      ],
      report_to_when_done: "boss",
    };

    const results = validateContractCompletion(contract);
    assert.strictEqual(results[0].passed, false);
  });

  // ─────────────────────────────────────────────────────────────
  // required vs optional
  // ─────────────────────────────────────────────────────────────

  test("optional criterion failure does not block done", () => {
    const contract: TaskContract = {
      description: "Test",
      acceptance_criteria: [
        { id: "c1", description: "Required passes", type: "command_exit_0", params: { command: "true" }, required: true },
        { id: "c2", description: "Optional fails", type: "command_exit_0", params: { command: "false" }, required: false },
      ],
      report_to_when_done: "boss",
    };

    const results = validateContractCompletion(contract);
    assert.strictEqual(allRequiredPassed(results), true);
    assert.strictEqual(results[0].passed, true);
    assert.strictEqual(results[1].passed, false);
  });

  // ─────────────────────────────────────────────────────────────
  // formatVerificationReport
  // ─────────────────────────────────────────────────────────────

  test("formatVerificationReport shows icons and summary", () => {
    const results = [
      { criterion_id: "c1", passed: true, actual: true, expected: true, required: true },
      { criterion_id: "c2", passed: false, actual: "error", expected: "ok", error: "something broke", required: false },
    ];
    const report = formatVerificationReport(results);
    assert.ok(report.includes("✅ c1 (required): PASSED"));
    assert.ok(report.includes("❌ c2 (optional): FAILED"));
    // c2 is optional (required:false), so allRequiredPassed should be true
    assert.ok(report.includes("✅ ALL REQUIRED PASSED"));
  });
});
