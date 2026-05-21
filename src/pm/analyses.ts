/**
 * Task Analyses — Chronological context per task.
 *
 * Each analysis captures reasoning, decisions, configs, errors,
 * and any context the agent needs to continue or restart work.
 *
 * Schema:
 *   agent_note: todo lo util para el agente, texto plano sin tags
 *   human_note: resumen corto para humanos, opcional
 *   invalidated: solo el ultimo analisis tiene invalidated=0
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
  task_id: number | null;  // NULL if analysis is at project level (task was deleted)
  project_id: number | null; // For project-level context and orphaned analyses
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
  invalidated: number;
}

export interface WriteAnalysisParams {
  task_id?: number;      // Optional - can be null for project-level analyses
  project_id?: number;   // Optional - for project-level context
  agent_note: string;
  human_note?: string | null;
  keywords?: string[];
  analysis_type?: AnalysisType;
  confidence_score?: number;
  author_id?: string;
  author_type?: "agent" | "user" | "system";
}

export interface WriteProjectAnalysisParams {
  project_id: number;
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
  project_id?: number;      // Filter by project (includes orphaned task analyses)
  keywords?: string;        // substring match over keywords JSON
  analysis_type?: AnalysisType;
  include_invalidated?: boolean;
  task_ids?: number[];      // for batch queries
  include_orphaned?: boolean; // Include analyses where task was deleted (task_id IS NULL)
}

// ── Helpers ──────────────────────────────────────────────────────

function _parseKeywords(raw: string): string[] {
  try { return JSON.parse(raw || "[]"); } catch { return []; }
}

function _nextVersion(db: DatabaseSync, taskId?: number, projectId?: number): string {
  let row: { version: string } | undefined;
  
  if (taskId != null) {
    row = db.prepare(`
      SELECT version FROM task_analyses
      WHERE task_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(taskId) as { version: string } | undefined;
  } else if (projectId != null) {
    // For project-level analyses, get next version for this project (where task_id IS NULL)
    row = db.prepare(`
      SELECT version FROM task_analyses
      WHERE project_id = ? AND task_id IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(projectId) as { version: string } | undefined;
  }

  if (!row) return "v1";
  const num = parseInt(row.version.replace("v", ""), 10);
  return `v${num + 1}`;
}

// ── Write ────────────────────────────────────────────────────────

export function writeAnalysis(params: WriteAnalysisParams): TaskAnalysisRow {
  const db = getPmDb();
  const version = _nextVersion(db, params.task_id, params.project_id);
  const keywords = JSON.stringify(params.keywords ?? []);
  const now = new Date().toISOString();

  // Deactivate previous active analysis for this task (if task_id provided)
  if (params.task_id != null) {
    db.prepare(`
      UPDATE task_analyses
      SET invalidated = 1, invalidated_at = ?
      WHERE task_id = ? AND invalidated = 0
    `).run(now, params.task_id);
  } else if (params.project_id != null) {
    // For project-level analyses, deactivate previous project-level analysis
    db.prepare(`
      UPDATE task_analyses
      SET invalidated = 1, invalidated_at = ?
      WHERE project_id = ? AND task_id IS NULL AND invalidated = 0
    `).run(now, params.project_id);
  }

  const stmt = db.prepare(`
    INSERT INTO task_analyses
      (task_id, project_id, version, keywords, human_note, agent_note, analysis_type,
       confidence_score, author_id, author_type, created_at, invalidated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);

  const result = stmt.run(
    params.task_id ?? null,
    params.project_id ?? null,
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

/**
 * Write an analysis at the project level (not tied to a specific task).
 * Useful for documenting project-wide decisions, architecture, etc.
 */
export function writeProjectAnalysis(params: WriteProjectAnalysisParams): TaskAnalysisRow {
  return writeAnalysis({
    ...params,
    task_id: undefined,  // No task - this is project-level
  });
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

  // Filter by project - includes both project-level and task-level analyses
  if (params.project_id != null) {
    conditions.push("project_id = ?");
    values.push(params.project_id);
  }

  // Handle orphaned analyses (where task was deleted but analysis preserved)
  if (params.include_orphaned === false) {
    conditions.push("task_id IS NOT NULL");
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
    conditions.push("invalidated = 0");
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT * FROM task_analyses ${where} ORDER BY created_at DESC`;
  return db.prepare(sql).all(...values) as TaskAnalysisRow[];
}

/**
 * Read all analyses for a project, including:
 * - Project-level analyses (task_id IS NULL)
 * - Task-level analyses that belong to this project
 * - Orphaned analyses (task was deleted but analysis preserved)
 */
export function readProjectAnalyses(projectId: number, options?: { include_invalidated?: boolean; analysis_type?: AnalysisType }): TaskAnalysisRow[] {
  const db = getPmDb();
  const conditions: string[] = ["project_id = ?"];
  const values: (string | number | boolean)[] = [projectId];

  if (options?.analysis_type) {
    conditions.push("analysis_type = ?");
    values.push(options.analysis_type);
  }

  if (!options?.include_invalidated) {
    conditions.push("invalidated = 0");
  }

  const sql = `SELECT * FROM task_analyses WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`;
  return db.prepare(sql).all(...values) as TaskAnalysisRow[];
}

// ── Latest ───────────────────────────────────────────────────────

export function latestAnalysis(taskId: number): TaskAnalysisRow | null {
  const rows = readAnalyses({ task_id: taskId });
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Get the latest project-level analysis for a project.
 * This includes only analyses where task_id IS NULL (true project-level context).
 */
export function latestProjectAnalysis(projectId: number): TaskAnalysisRow | null {
  const db = getPmDb();
  const row = db.prepare(`
    SELECT * FROM task_analyses
    WHERE project_id = ? AND task_id IS NULL AND invalidated = 0
    ORDER BY created_at DESC LIMIT 1
  `).get(projectId) as TaskAnalysisRow | undefined;
  return row ?? null;
}

/**
 * Get latest analysis for either a task or project.
 * If taskId is provided, returns task analysis.
 * Otherwise, if projectId is provided, returns project-level analysis.
 */
export function latestContext(taskId?: number, projectId?: number): TaskAnalysisRow | null {
  if (taskId != null) return latestAnalysis(taskId);
  if (projectId != null) return latestProjectAnalysis(projectId);
  return null;
}

// ── Invalidate ───────────────────────────────────────────────────

export function invalidateAnalysis(analysisId: number, supersededById?: number): TaskAnalysisRow | null {
  const db = getPmDb();
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE task_analyses
    SET invalidated = 1, invalidated_at = ?, superseded_by_id = ?
    WHERE id = ?
  `).run(now, supersededById ?? null, analysisId);

  return db.prepare("SELECT * FROM task_analyses WHERE id = ?").get(analysisId) as TaskAnalysisRow | null;
}

// ── Build context string for agent injection ─────────────────────

/**
 * Returns agent_note content of the latest analysis for a task or project,
 * formatted as a single string suitable for LLM injection.
 * Returns empty string if no analysis exists.
 */
export function getAgentContext(taskId?: number, projectId?: number): string {
  const row = latestContext(taskId, projectId);
  if (!row) return "";
  return row.agent_note;
}

/**
 * Returns a summary line for human display.
 * Can handle both task-level and project-level analyses.
 */
export function getHumanSummary(taskId?: number, projectId?: number): string {
  const row = latestContext(taskId, projectId);
  if (!row) return "(sin análisis)";
  const kw = _parseKeywords(row.keywords);
  const scope = row.task_id ? `task:${row.task_id}` : `project:${row.project_id}`;
  return `[${row.version}] ${scope} ${row.analysis_type} | conf=${row.confidence_score} | kw=${kw.join(", ")} | ${row.human_note ?? "(sin resumen humano)"}`;
}

/**
 * Build a comprehensive context string combining project and task analyses.
 * Useful for agents that need full context of a task within its project.
 */
export function buildFullContext(projectId: number, taskId?: number, extraContext?: string): string {
  const parts: string[] = [];

  // First: project-level context
  const projectContext = latestProjectAnalysis(projectId);
  if (projectContext) {
    parts.push(`## Project Context (${projectContext.version})\n${projectContext.agent_note}`);
  }

  // Second: task-level context (if provided)
  if (taskId != null) {
    const taskContext = latestAnalysis(taskId);
    if (taskContext) {
      parts.push(`## Task Context (${taskContext.version})\n${taskContext.agent_note}`);
    }
  }

  // Third: extra context
  if (extraContext) {
    parts.push(`## Additional Context\n${extraContext}`);
  }

  return parts.join('\n\n');
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