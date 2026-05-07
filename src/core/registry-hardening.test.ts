import { test, describe, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openFabricDb, ensureRegistrySchema, withSqliteRetry, prepareRunWithRetry } from "./sqlite-utils.js";

describe("registry hardening", () => {
  let baseDir = "";
  let registryPath = "";

  beforeEach(() => {
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
    baseDir = mkdtempSync(join(tmpdir(), "cmd-center-registry-"));
    registryPath = join(baseDir, "registry.sqlite");
  });

  test("retries transient SQLITE busy failures", () => {
    let attempts = 0;
    const result = withSqliteRetry(() => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error("database is locked") as Error & { code?: string; errcode?: number };
        err.code = "ERR_SQLITE_ERROR";
        err.errcode = 5;
        throw err;
      }
      return "ok";
    }, { maxRetries: 4, baseDelayMs: 1 });

    assert.strictEqual(result, "ok");
    assert.strictEqual(attempts, 3);
  });

  test("upsert recreates agent row after registry reset", () => {
    const db = openFabricDb(registryPath);
    ensureRegistrySchema(db);

    const upsert = db.prepare(`
      INSERT INTO agents (agent_id, role, status, fabric_status, last_seen_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(agent_id) DO UPDATE SET
        role = excluded.role,
        status = excluded.status,
        fabric_status = excluded.fabric_status,
        last_seen_at = datetime('now')
    `);

    prepareRunWithRetry(upsert, ["boss", "coordinator", "active", "idle"]);
    db.exec("DELETE FROM agents WHERE agent_id = 'boss'");
    prepareRunWithRetry(upsert, ["boss", "coordinator", "active", "thinking"]);

    const row = db.prepare("SELECT agent_id, role, status, fabric_status FROM agents WHERE agent_id = ?").get("boss") as {
      agent_id: string;
      role: string;
      status: string;
      fabric_status: string;
    };

    assert.strictEqual(row.agent_id, "boss");
    assert.strictEqual(row.role, "coordinator");
    assert.strictEqual(row.status, "active");
    assert.strictEqual(row.fabric_status, "thinking");
    db.close();
  });
});
