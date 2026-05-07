import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// ============================================================
// Contract Schema — Estructura obligatoria para fabric_send_task
// ============================================================

export interface TaskContract {
  /** Descripción de la tarea */
  description: string;

  /** Criterios de aceptación CONCRETOS y VERIFICABLES */
  acceptance_criteria: AcceptanceCriterion[];

  /** A quién reportar cuando termine */
  report_to_when_done: string;

  /** ID de la subtarea en PM DB (si aplica) */
  task_id?: string; // ej: "subtask-42"

  /** Archivos que debe leer antes de empezar */
  files?: string[];
}

export type AcceptanceCriterionType =
  | "file_exists"
  | "file_contains"
  | "file_not_contains"
  | "test_passes"
  | "db_query"
  | "http_status"
  | "command_exit_0"
  | "command_output_contains"
  | "command_output_not_contains"
  | "manual";

export interface AcceptanceCriterion {
  /** ID único del criterio (para referencia en reports) */
  id: string;

  /** Descripción legible del criterio */
  description: string;

  /** Tipo de verificación */
  type: AcceptanceCriterionType;

  /** Parámetro según tipo:
   * - file_exists:                 { path: string }
   * - file_contains:               { path: string, pattern: string } (regex o substring)
   * - file_not_contains:           { path: string, pattern: string } (regex o substring)
   * - test_passes:                 { command: string, expected_output?: string }
   * - db_query:                    { sql: string, db_path: string, expected_rows?: number, expected_first_row?: object }
   * - http_status:                 { url: string, method?: string, expected_status: number }
   * - command_exit_0:              { command: string }
   * - command_output_contains:     { command: string, expected_output: string }
   * - command_output_not_contains: { command: string, forbidden_output: string }
   * - manual:                      { instructions: string }
   */
  params: Record<string, unknown>;

  /** Si es true, este criterio es bloqueante (veredicto = failed si falla).
   *  Si es false, es "nice to have" (warning, no bloquea done). */
  required: boolean;
}

export interface VerificationResult {
  criterion_id: string;
  passed: boolean;
  actual: unknown;
  expected: unknown;
  error?: string;
  required: boolean;
}

// ============================================================
// Validador de contratos — lo invoca el worker antes de reportar
// ============================================================

export function validateContractCompletion(
  contract: TaskContract
): VerificationResult[] {
  const results: VerificationResult[] = [];

  for (const criterion of contract.acceptance_criteria) {
    try {
      const result = verifyCriterion(criterion);
      results.push(result);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      results.push({
        criterion_id: criterion.id,
        passed: false,
        actual: message,
        expected: criterion.description,
        error: `Verification crashed: ${message}`,
        required: criterion.required,
      });
    }
  }

  return results;
}

export function allRequiredPassed(results: VerificationResult[]): boolean {
  return results.filter((r) => r.required).every((r) => r.passed);
}

export function formatVerificationReport(results: VerificationResult[]): string {
  const lines = results.map((r) => {
    const icon = r.passed ? "✅" : "❌";
    const required = r.required ? "required" : "optional";
    return `${icon} ${r.criterion_id} (${required}): ${r.passed ? "PASSED" : "FAILED"}${
      r.error ? ` — ${r.error}` : ""
    }`;
  });
  const summary = allRequiredPassed(results) ? "✅ ALL REQUIRED PASSED" : "❌ SOME REQUIRED FAILED";
  return `${lines.join("\n")}\n\n${summary}`;
}

// ─── Internal verifiers ───

function makeResult(
  criterion: AcceptanceCriterion,
  passed: boolean,
  actual: unknown,
  expected: unknown,
  error?: string,
): VerificationResult {
  return {
    criterion_id: criterion.id,
    passed,
    actual,
    expected,
    ...(error ? { error } : {}),
    required: criterion.required,
  };
}

function readTextFile(path: string): string {
  return readFileSync(path, "utf-8");
}

function patternMatches(content: string, pattern: string): boolean {
  try {
    return new RegExp(pattern).test(content);
  } catch {
    return content.includes(pattern);
  }
}

function verifyCriterion(criterion: AcceptanceCriterion): VerificationResult {
  const { type, params } = criterion;

  switch (type) {
    case "file_exists": {
      const { path } = params as { path: string };
      const passed = existsSync(path);
      return makeResult(criterion, passed, passed, true, passed ? undefined : `File does not exist: ${path}`);
    }

    case "file_contains": {
      const { path, pattern } = params as { path: string; pattern: string };
      const content = readTextFile(path);
      const passed = patternMatches(content, pattern);
      return makeResult(criterion, passed, passed, `contains ${pattern}`, passed ? undefined : `Pattern not found: ${pattern}`);
    }

    case "file_not_contains": {
      const { path, pattern } = params as { path: string; pattern: string };
      const content = readTextFile(path);
      const found = patternMatches(content, pattern);
      return makeResult(criterion, !found, found ? `found ${pattern}` : `not found ${pattern}`, `does not contain ${pattern}`, found ? `Forbidden pattern found: ${pattern}` : undefined);
    }

    case "test_passes": {
      const { command, expected_output } = params as { command: string; expected_output?: string };
      try {
        const output = execSync(command, { encoding: "utf-8", timeout: 30000 });
        if (expected_output !== undefined) {
          const passed = output.includes(expected_output);
          return makeResult(criterion, passed, output.trim(), expected_output, passed ? undefined : `Expected output missing: ${expected_output}`);
        }
        return makeResult(criterion, true, output.trim(), "exit 0");
      } catch (e: unknown) {
        const err = e as { stderr?: Buffer | string; message?: string; status?: number };
        const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString();
        return makeResult(criterion, false, stderr || err.message || String(e), "exit 0", `Command failed${err.status !== undefined ? ` with exit ${err.status}` : ""}`);
      }
    }

    case "db_query": {
      const { sql, db_path, expected_rows, expected_first_row } = params as {
        sql: string;
        db_path: string;
        expected_rows?: number;
        expected_first_row?: Record<string, unknown>;
      };
      const db = new DatabaseSync(db_path);
      try {
        const rows = db.prepare(sql).all() as Record<string, unknown>[];

        let passed = true;
        let actual: unknown = rows.length;
        const expected: unknown = expected_rows ?? expected_first_row ?? "any rows";

        if (expected_rows !== undefined && rows.length !== expected_rows) {
          passed = false;
        }
        if (expected_first_row !== undefined) {
          if (rows.length === 0) {
            passed = false;
            actual = [];
          } else {
            const first = rows[0];
            actual = first;
            for (const [key, val] of Object.entries(expected_first_row)) {
              if (first[key] !== val) {
                passed = false;
                break;
              }
            }
          }
        }

        return makeResult(criterion, passed, actual, expected, passed ? undefined : "DB query result did not match expectation");
      } finally {
        db.close();
      }
    }

    case "http_status": {
      const { url, method = "GET", expected_status } = params as {
        url: string;
        method?: string;
        expected_status: number;
      };
      try {
        const output = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", method, url], {
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        const actualStatus = Number(output);
        const passed = actualStatus === expected_status;
        return makeResult(criterion, passed, actualStatus, expected_status, passed ? undefined : `Expected HTTP ${expected_status}, got ${actualStatus}`);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return makeResult(criterion, false, message, expected_status, `HTTP check failed: ${message}`);
      }
    }

    case "command_exit_0": {
      const { command } = params as { command: string };
      try {
        execSync(command, { timeout: 30000 });
        return makeResult(criterion, true, "exit 0", "exit 0");
      } catch (e: unknown) {
        const err = e as { status?: number; message?: string };
        return makeResult(criterion, false, err.status ?? err.message ?? String(e), "exit 0", `Command failed${err.status !== undefined ? ` with exit ${err.status}` : ""}`);
      }
    }

    case "command_output_contains": {
      const { command, expected_output } = params as { command: string; expected_output: string };
      try {
        const output = execSync(command, { encoding: "utf-8", timeout: 30000 });
        const passed = output.includes(expected_output);
        return makeResult(criterion, passed, output.trim(), `contains ${expected_output}`, passed ? undefined : `Expected output missing: ${expected_output}`);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return makeResult(criterion, false, message, `contains ${expected_output}`, `Command failed: ${message}`);
      }
    }

    case "command_output_not_contains": {
      const { command, forbidden_output } = params as { command: string; forbidden_output: string };
      try {
        const output = execSync(command, { encoding: "utf-8", timeout: 30000 });
        const found = output.includes(forbidden_output);
        return makeResult(criterion, !found, output.trim(), `does not contain ${forbidden_output}`, found ? `Forbidden output found: ${forbidden_output}` : undefined);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return makeResult(criterion, false, message, `does not contain ${forbidden_output}`, `Command failed: ${message}`);
      }
    }

    case "manual": {
      const { instructions } = params as { instructions: string };
      // Manual criteria cannot be auto-verified; worker must mark as passed/failed
      return makeResult(
        criterion,
        false,
        "requires manual verification",
        instructions,
        "MANUAL: worker must verify and override",
      );
    }

    default: {
      const neverType = type as string;
      return makeResult(
        criterion,
        false,
        `unknown type: ${neverType}`,
        "valid verifier",
        `No verifier implemented for type: ${neverType}`,
      );
    }
  }
}
