import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SQLITE_BUSY_ERRCODE = 5;
const DEFAULT_MAX_RETRIES = 6;
const DEFAULT_BASE_DELAY_MS = 25;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

function sleepSync(delayMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

export function isSqliteBusyError(err: unknown): boolean {
  const sqliteErr = err as { code?: string; errcode?: number; message?: string } | null;
  return (
    sqliteErr?.errcode === SQLITE_BUSY_ERRCODE ||
    sqliteErr?.code === "SQLITE_BUSY" ||
    sqliteErr?.message?.includes("database is locked") === true ||
    sqliteErr?.message?.includes("DB locked") === true
  );
}

export function isSqliteMalformedError(err: unknown): boolean {
  const sqliteErr = err as { message?: string } | null;
  const message = sqliteErr?.message ?? "";
  return (
    message.includes("database disk image is malformed") ||
    message.includes("btreeInitPage") ||
    message.includes("malformed")
  );
}

export function isSqliteIoError(err: unknown): boolean {
  const sqliteErr = err as { message?: string; errstr?: string } | null;
  const message = `${sqliteErr?.message ?? ""} ${sqliteErr?.errstr ?? ""}`;
  return message.includes("disk I/O error");
}

export function isRegistryDegradedError(err: unknown): boolean {
  return isSqliteMalformedError(err) || isSqliteIoError(err);
}

export function withSqliteRetry<T>(fn: () => T, options?: { maxRetries?: number; baseDelayMs?: number }): T {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isSqliteBusyError(err)) {
        throw err;
      }
      lastError = err;
      if (attempt === maxRetries - 1) break;
      sleepSync(baseDelayMs * Math.pow(2, attempt));
    }
  }

  throw lastError;
}

export function execWithSqliteRetry(db: DatabaseSync, sql: string, options?: { maxRetries?: number; baseDelayMs?: number }): void {
  withSqliteRetry(() => db.exec(sql), options);
}

export function prepareRunWithRetry<T>(stmt: { run: (...args: any[]) => T }, args: any[], options?: { maxRetries?: number; baseDelayMs?: number }): T {
  return withSqliteRetry(() => stmt.run(...args), options);
}

export function prepareGetWithRetry<T>(stmt: { get: (...args: any[]) => T }, args: any[], options?: { maxRetries?: number; baseDelayMs?: number }): T {
  return withSqliteRetry(() => stmt.get(...args), options);
}

export function prepareAllWithRetry<T>(stmt: { all: (...args: any[]) => T }, args: any[], options?: { maxRetries?: number; baseDelayMs?: number }): T {
  return withSqliteRetry(() => stmt.all(...args), options);
}

export function configureFabricDb(db: DatabaseSync): void {
  execWithSqliteRetry(db, `PRAGMA busy_timeout=${DEFAULT_BUSY_TIMEOUT_MS};`);
  execWithSqliteRetry(db, "PRAGMA journal_mode=WAL;");
}

export function configureFabricDbReadOnly(db: DatabaseSync): void {
  execWithSqliteRetry(db, `PRAGMA busy_timeout=${DEFAULT_BUSY_TIMEOUT_MS};`);
}

export function openFabricDb(dbPath: string): DatabaseSync {
  const parent = dirname(dbPath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  configureFabricDb(db);
  return db;
}

export function openFabricDbReadOnly(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readonly: true });
  configureFabricDbReadOnly(db);
  return db;
}

export function ensureRegistrySchema(db: DatabaseSync): void {
  execWithSqliteRetry(
    db,
    `
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        pane_id TEXT,
        session TEXT,
        pid INTEGER,
        model TEXT,
        status TEXT DEFAULT 'active',
        registered_at TEXT DEFAULT (datetime('now')),
        last_seen_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        agent_id TEXT,
        payload TEXT,
        ts TEXT DEFAULT (datetime('now'))
      );
    `
  );

  const columns = [
    { name: "fabric_status", def: "TEXT DEFAULT 'idle'" },
    { name: "current_task", def: "TEXT DEFAULT NULL" },
    { name: "pending_correlations", def: "TEXT DEFAULT '[]'" },
    { name: "last_error", def: "TEXT DEFAULT NULL" },
    { name: "is_streaming", def: "INTEGER DEFAULT 0" },
    { name: "is_thinking", def: "INTEGER DEFAULT 0" },
    { name: "active_tool", def: "TEXT DEFAULT NULL" },
    { name: "queue_length", def: "INTEGER DEFAULT 0" },
  ];

  const existing = prepareAllWithRetry(db.prepare("PRAGMA table_info(agents)"), []) as Array<{ name: string }>;
  const existingNames = new Set(existing.map((column) => column.name));
  for (const column of columns) {
    if (!existingNames.has(column.name)) {
      try {
        execWithSqliteRetry(db, `ALTER TABLE agents ADD COLUMN ${column.name} ${column.def}`);
      } catch {
        // Another process may have added it first.
      }
    }
  }
}
