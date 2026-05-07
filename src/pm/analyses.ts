/**
 * Task Analyses — Chronological context per task.
 *
 * Each analysis captures reasoning, decisions, configs, errors,
 * and any context the agent needs to continue or restart work.
 *
 * Schema:
 *   agent_note: todo lo util para el agente, texto plano sin tags
 *   human_note: resumen corto para humanos, opcional
 *   is_active: solo el ultimo analisis es active=1
 *   superseded_by_id:链接 a la versión que lo reemplazó
 */

import { DatabaseSync } from "node:sqlite";
import { initDb } from "./db.js";
import { ANALYSIS_TYPES, type AnalysisType } from "./enums.js";

// ── Singleton PM DB ──────────────────────────────────────────────

let _pmDb: DatabaseSync | null = null;

function getPmDb(): DatabaseSync {
  if (!_pmDb) {
    const pmPath = process.env.FABRIC_DIR
      ? `${process.env.FABRIC_DIR}/projects.sqlite`
      : "/tmp/fabric-agents/projects.sqlite";
    _pmDb = initDb(pmPath);
  }
  return _pmDb;
}

// ── Types ────────────────────────────────────────────────────────

export interface TaskAnalysisRow {
  id: number;
  task_id: number;
  version: string;
  keywords: string;      // JSON array
  human_note: string | null;
  agent_note: string;
  analysis_type: AnalysisType;
  confidence_score: number;
  author_id: string | null;
  author_type: string | null;
  created_at: string;
  invalidated_at: string | null;
  superseded_by_id: number | null;
  is_active: number;
}

export interface WriteAnalysisParams {
  task_id: number;
  agent_note: string;
  human_note?: string | null;
  keywords?: string[];
  analysis_type?: AnalysisType;
  confidence_score?: number;
  author_id?: string;
  author_type?: "agent" | "user" | "system";
}

export interface ReadAnalysesParams {
  task_id?: number;
  keywords?: string;        // substring match over keywords JSON
  analysis_type?: AnalysisType;
  include_invalidated?: boolean;
  task_ids?: number[];      // for batch queries
}

// ── Helpers ──────────────────────────────────────────────────────

function _parseKeywords(raw: string): string[] {
  try { return JSON.parse(raw || "[]"); } catch { return []; }
}

function _nextVersion(db: DatabaseSync, taskId: number): string {
  const row = db.prepare(`
    SELECT version FROM task_analyses
    WHERE task_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(taskId) as { version: string } | undefined;

  if (!row) return "v1";
  const num = parseInt(row.version.replace("v", ""), 10);
  return `v${num + 1}`;
}

// ── Write ────────────────────────────────────────────────────────

export function writeAnalysis(params: WriteAnalysisParams): TaskAnalysisRow {
  const db = getPmDb();
  const version = _nextVersion(db, params.task_id);
  const keywords = JSON.stringify(params.keywords ?? []);
  const now = new Date().toISOString();

  // Deactivate previous active analysis for this task
  db.prepare(`
    UPDATE task_analyses
    SET is_active = 0, invalidated_at = ?
    WHERE task_id = ? AND is_active = 1
  `).run(now, params.task_id);

  const stmt = db.prepare(`
    INSERT INTO task_analyses
      (task_id, version, keywords, human_note, agent_note, analysis_type,
       confidence_score, author_id, author_type, created_at, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const result = stmt.run(
    params.task_id,
    version,
    keywords,
    params.human_note ?? null,
    params.agent_note,
    params.analysis_type ?? "general",
    params.confidence_score ?? 50,
    params.author_id ?? null,
    params.author_type ?? "agent",
    now,
  );

  return db.prepare("SELECT * FROM task_analyses WHERE id = ?").get(result.lastInsertRowid) as TaskAnalysisRow;
}

// ── Read ─────────────────────────────────────────────────────────

export function readAnalyses(params: ReadAnalysesParams): TaskAnalysisRow[] {
  const db = getPmDb();
  const conditions: string[] = [];
  const values: (string | number | boolean)[] = [];

  if (params.task_id != null) {
    conditions.push("task_id = ?");
    values.push(params.task_id);
  }

  if (params.task_ids?.length) {
    conditions.push(`task_id IN (${params.task_ids.map(() => "?").join(",")})`);
    values.push(...params.task_ids);
  }

  if (params.keywords) {
    conditions.push("keywords LIKE ?");
    values.push(`%${params.keywords}%`);
  }

  if (params.analysis_type) {
    conditions.push("analysis_type = ?");
    values.push(params.analysis_type);
  }

  if (!params.include_invalidated) {
    conditions.push("is_active = 1");
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT * FROM task_analyses ${where} ORDER BY created_at DESC`;
  return db.prepare(sql).all(...values) as TaskAnalysisRow[];
}

// ── Latest ───────────────────────────────────────────────────────

export function latestAnalysis(taskId: number): TaskAnalysisRow | null {
  const rows = readAnalyses({ task_id: taskId });
  return rows.length > 0 ? rows[0] : null;
}

// ── Invalidate ───────────────────────────────────────────────────

export function invalidateAnalysis(analysisId: number, supersededById?: number): TaskAnalysisRow | null {
  const db = getPmDb();
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE task_analyses
    SET is_active = 0, invalidated_at = ?, superseded_by_id = ?
    WHERE id = ?
  `).run(now, supersededById ?? null, analysisId);

  return db.prepare("SELECT * FROM task_analyses WHERE id = ?").get(analysisId) as TaskAnalysisRow | null;
}

// ── Build context string for agent injection ─────────────────────

/**
 * Returns agent_note content of the latest analysis for a task,
 * formatted as a single string suitable for LLM injection.
 * Returns empty string if no analysis exists.
 */
export function getAgentContext(taskId: number): string {
  const row = latestAnalysis(taskId);
  if (!row) return "";
  return row.agent_note;
}

/**
 * Returns a summary line for human display.
 */
export function getHumanSummary(taskId: number): string {
  const row = latestAnalysis(taskId);
  if (!row) return "(sin análisis)";
  const kw = _parseKeywords(row.keywords);
  return `[${row.version}] ${row.analysis_type} | conf=${row.confidence_score} | kw=${kw.join(", ")} | ${row.human_note ?? "(sin resumen humano)"}`;
}

// ── Batch write for coordinator context injection ────────────────

/**
 * Given a task_id, returns the agent_note of the latest analysis
 * so the coordinator can inject it via fabric_send_message or fabric_send_task.
 */
export function buildTaskContextForAgent(taskId: number, extraContext?: string): string {
  const base = getAgentContext(taskId);
  if (!base) return extraContext ?? "";
  return extraContext ? `${base}\n\n-- adicional --\n${extraContext}` : base;
}