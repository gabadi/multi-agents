import { DatabaseSync } from "node:sqlite";
import { getProjectTree, type ProjectRow, type TaskRow } from "./queries.js";
import { collectAgentIdsFromProjectTree, resolveAgentStates, type AgentRuntimeState } from "./agent-state-reader.js";

export type ProjectContextInput = {
  project_id?: number;
  project_code?: string;
  project_name?: string;
  repo_local_path?: string;
  repo_url?: string;
  cwd?: string;
  git_root?: string;
  origin_url?: string;
  include_tasks?: boolean;
  include_task_analyses?: boolean;
  include_agent_states?: boolean;
  active_only?: boolean;
};

export type ProjectResolutionCandidate = {
  project: ProjectRow;
  score: number;
  matched_by: string[];
};

export type ProjectResolutionResult = {
  project: ProjectRow | null;
  matched_by: string | null;
  candidates: ProjectResolutionCandidate[];
  warnings: string[];
  ambiguous: boolean;
};

export type TaskAnalysisSummary = {
  task_id: number;
  version: string;
  analysis_type: string;
  confidence_score: number;
  human_note: string | null;
  keywords: string[];
  created_at: string;
};

export type ProjectContextSnapshot = {
  resolution: {
    project_id: number | null;
    matched_by: string | null;
    ambiguous: boolean;
    warnings: string[];
    candidate_ids: number[];
  };
  project: ProjectRow | null;
  repo: {
    repo_local_path: string | null;
    repo_url: string | null;
    cwd: string | null;
    git_root: string | null;
    origin_url: string | null;
    runtime_repo_candidate: string | null;
    missing_repo_local_path: boolean;
  };
  tasks: {
    active: TaskRow[];
    recent: TaskRow[];
  };
  task_analysis_summaries: TaskAnalysisSummary[];
  agent_states: Record<string, AgentRuntimeState | null>;
  recommended_next_actions: string[];
};

function normalize(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function lower(value: string | null | undefined): string | null {
  const normalized = normalize(value);
  return normalized ? normalized.toLowerCase() : null;
}

function matchesPrefix(candidate: string | null | undefined, prefix: string | null | undefined): boolean {
  const a = normalize(candidate);
  const b = normalize(prefix);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function parseKeywords(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function scoreProject(project: ProjectRow, input: ProjectContextInput): ProjectResolutionCandidate | null {
  let score = 0;
  const matchedBy: string[] = [];

  if (input.project_id != null && project.id === input.project_id) {
    score += 1000;
    matchedBy.push("project_id");
  }
  if (lower(project.code) && lower(project.code) === lower(input.project_code)) {
    score += 220;
    matchedBy.push("project_code");
  }
  if (lower(project.name) && lower(project.name) === lower(input.project_name)) {
    score += 180;
    matchedBy.push("project_name");
  }
  if (normalize(project.repo_local_path) && normalize(project.repo_local_path) === normalize(input.repo_local_path)) {
    score += 240;
    matchedBy.push("repo_local_path");
  }
  if (normalize(project.repo_url) && normalize(project.repo_url) === normalize(input.repo_url)) {
    score += 220;
    matchedBy.push("repo_url");
  }
  if (normalize(project.repo_local_path) && normalize(project.repo_local_path) === normalize(input.git_root)) {
    score += 220;
    matchedBy.push("git_root");
  }
  if (normalize(project.repo_url) && normalize(project.repo_url) === normalize(input.origin_url)) {
    score += 220;
    matchedBy.push("origin_url");
  }
  if (matchesPrefix(input.cwd, project.repo_local_path)) {
    score += 160;
    matchedBy.push("cwd");
  }

  if (score <= 0) return null;
  return { project, score, matched_by: matchedBy };
}

function readProjectRows(db: DatabaseSync): ProjectRow[] {
  return db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as ProjectRow[];
}

export function resolveProjectSelector(db: DatabaseSync, input: ProjectContextInput): ProjectResolutionResult {
  const warnings: string[] = [];
  const rows = readProjectRows(db);
  const candidates = rows
    .map((project) => scoreProject(project, input))
    .filter((candidate): candidate is ProjectResolutionCandidate => candidate != null)
    .sort((a, b) => b.score - a.score || a.project.id - b.project.id);

  if (candidates.length === 0) {
    warnings.push("No project matched the provided selectors/runtime hints.");
    return { project: null, matched_by: null, candidates: [], warnings, ambiguous: false };
  }

  const topScore = candidates[0].score;
  const topCandidates = candidates.filter((candidate) => candidate.score === topScore);
  if (topCandidates.length > 1) {
    warnings.push(`Project resolution is ambiguous across candidates: ${topCandidates.map((candidate) => candidate.project.id).join(", ")}`);
    return {
      project: null,
      matched_by: null,
      candidates,
      warnings,
      ambiguous: true,
    };
  }

  const selected = candidates[0];
  if (!selected.project.repo_local_path) {
    warnings.push("Resolved project is missing repo_local_path.");
  }

  return {
    project: selected.project,
    matched_by: selected.matched_by.join(","),
    candidates,
    warnings,
    ambiguous: false,
  };
}

function filterActiveTasks(tasks: TaskRow[], activeOnly: boolean): TaskRow[] {
  if (!activeOnly) return tasks;
  return tasks.filter((task) => task.status !== "completed" && task.status !== "failed");
}

function readAnalysisSummaries(db: DatabaseSync, taskIds: number[]): TaskAnalysisSummary[] {
  if (taskIds.length === 0) return [];
  const placeholders = taskIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT task_id, version, analysis_type, confidence_score, human_note, keywords, created_at
     FROM task_analyses
     WHERE task_id IN (${placeholders}) AND is_active = 1
     ORDER BY created_at DESC`
  ).all(...taskIds) as Array<{
    task_id: number;
    version: string;
    analysis_type: string;
    confidence_score: number;
    human_note: string | null;
    keywords: string;
    created_at: string;
  }>;

  return rows.map((row) => ({
    ...row,
    keywords: parseKeywords(row.keywords),
  }));
}

function deriveRuntimeRepoCandidate(input: ProjectContextInput): string | null {
  return normalize(input.repo_local_path) ?? normalize(input.git_root) ?? null;
}

export function buildProjectContextSnapshot(db: DatabaseSync, input: ProjectContextInput): ProjectContextSnapshot {
  const resolution = resolveProjectSelector(db, input);
  const runtimeRepoCandidate = deriveRuntimeRepoCandidate(input);

  if (!resolution.project) {
    return {
      resolution: {
        project_id: null,
        matched_by: null,
        ambiguous: resolution.ambiguous,
        warnings: resolution.warnings,
        candidate_ids: resolution.candidates.map((candidate) => candidate.project.id),
      },
      project: null,
      repo: {
        repo_local_path: normalize(input.repo_local_path),
        repo_url: normalize(input.repo_url),
        cwd: normalize(input.cwd),
        git_root: normalize(input.git_root),
        origin_url: normalize(input.origin_url),
        runtime_repo_candidate: runtimeRepoCandidate,
        missing_repo_local_path: false,
      },
      tasks: { active: [], recent: [] },
      task_analysis_summaries: [],
      agent_states: {},
      recommended_next_actions: resolution.ambiguous
        ? ["Provide a definitive project selector (project_id/project_code/repo path)."]
        : ["Provide more project context or create the project first."],
    };
  }

  const tree = getProjectTree(db, resolution.project.id);
  const activeOnly = input.active_only !== false;
  const activeTasks = filterActiveTasks(tree.tasks, activeOnly);
  const recentTasks = [...tree.tasks]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 10);
  const taskIds = tree.tasks.map((task) => task.id);
  const analysisSummaries = input.include_task_analyses === false ? [] : readAnalysisSummaries(db, taskIds);
  const agentStates = input.include_agent_states
    ? resolveAgentStates(collectAgentIdsFromProjectTree(tree))
    : {};

  const recommendedNextActions: string[] = [];
  if (!resolution.project.repo_local_path) {
    recommendedNextActions.push(
      runtimeRepoCandidate
        ? `Project is missing repo_local_path. Task creation defaults to kickoff intent, so use confirm_repo_local_path=${runtimeRepoCandidate} to persist it explicitly or set behavior=create_only for backlog-only creation.`
        : "Provide or confirm repo_local_path before kickoff-intent task creation, or set behavior=create_only for backlog-only creation."
    );
  }
  if (resolution.ambiguous) {
    recommendedNextActions.push("Resolve project ambiguity before mutating PM state.");
  }
  if (activeTasks.length > 0) {
    recommendedNextActions.push(`Review ${activeTasks.length} active task(s) for duplicates before creating a new task.`);
  }

  return {
    resolution: {
      project_id: resolution.project.id,
      matched_by: resolution.matched_by,
      ambiguous: resolution.ambiguous,
      warnings: resolution.warnings,
      candidate_ids: resolution.candidates.map((candidate) => candidate.project.id),
    },
    project: resolution.project,
    repo: {
      repo_local_path: resolution.project.repo_local_path,
      repo_url: resolution.project.repo_url,
      cwd: normalize(input.cwd),
      git_root: normalize(input.git_root),
      origin_url: normalize(input.origin_url),
      runtime_repo_candidate: runtimeRepoCandidate,
      missing_repo_local_path: !resolution.project.repo_local_path,
    },
    tasks: {
      active: input.include_tasks === false ? [] : activeTasks,
      recent: input.include_tasks === false ? [] : recentTasks,
    },
    task_analysis_summaries: analysisSummaries,
    agent_states: agentStates,
    recommended_next_actions: recommendedNextActions,
  };
}

export function buildCurrentProjectContext(db: DatabaseSync, runtimeHints: ProjectContextInput): ProjectContextSnapshot {
  return buildProjectContextSnapshot(db, runtimeHints);
}
