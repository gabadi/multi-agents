import { DatabaseSync } from "node:sqlite";
import { createTask } from "./commands.js";
import { generateBranchName } from "./worktree.js";
import { buildProjectContextSnapshot, resolveProjectSelector, type ProjectContextInput } from "./project-context.js";
import type { TaskRow } from "./queries.js";

export type TaskIntakeBehavior = "create_only" | "create_and_kickoff";

export type TaskIntakeInput = ProjectContextInput & {
  title: string;
  description?: string;
  context_capsule?: string;
  acceptance_criteria?: string[];
  keywords?: string[];
  coordinator_agent_id?: string;
  orchestrator_agent_id?: string;
  status?: string;
  base_branch?: string;
  behavior?: TaskIntakeBehavior;
  confirm_repo_local_path?: string;
};

export type KickoffRepoLocalPathSource = "project" | "confirmed_input" | null;

export type TaskKickoffPlan = {
  requested: boolean;
  supported: boolean;
  repo_local_path: string | null;
  repo_local_path_source: KickoffRepoLocalPathSource;
  proposed_repo_local_path: string | null;
  requires_repo_local_path_confirmation: boolean;
  worktree_path: string | null;
  session_name: string | null;
  sub_agent_id: string | null;
  status_on_success: "in_progress";
};

export type TaskCreationPlan = {
  project_id: number | null;
  project_name: string | null;
  matched_by: string | null;
  next_task_id: number | null;
  sequence_order: number | null;
  suggested_branch_name: string | null;
  base_branch: string;
  behavior: TaskIntakeBehavior;
  warnings: string[];
  blockers: string[];
  requires_confirmation: boolean;
  can_commit: boolean;
  kickoff_supported: boolean;
  kickoff: TaskKickoffPlan;
  snapshot_summary: ReturnType<typeof buildProjectContextSnapshot>;
};

export type CreatedTaskWithContext = {
  task: TaskRow;
  analysis: {
    id: number;
    version: string;
  } | null;
  plan: TaskCreationPlan;
};

function normalize(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeTaskIntakeBehavior(value: string | null | undefined): TaskIntakeBehavior {
  const normalized = normalize(value)?.toLowerCase();
  if (
    normalized === "create_only" ||
    normalized === "backlog_only" ||
    normalized === "backlog-only" ||
    normalized === "no_kickoff" ||
    normalized === "no-kickoff"
  ) {
    return "create_only";
  }
  return "create_and_kickoff";
}

function nextTaskId(db: DatabaseSync): number {
  const row = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM tasks").get() as { next_id: number };
  return row.next_id;
}

export function computeNextTaskSequence(db: DatabaseSync, projectId: number): number {
  const row = db.prepare("SELECT COALESCE(MAX(sequence_order), 0) + 1 AS seq FROM tasks WHERE project_id = ?").get(projectId) as { seq: number };
  return row.seq;
}

function deriveSuggestedRepoLocalPath(input: TaskIntakeInput): string | null {
  return normalize(input.repo_local_path) ?? normalize(input.git_root) ?? null;
}

function buildKickoffWorktreePath(repoLocalPath: string, branchName: string): string {
  const repoName = repoLocalPath
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || "repo";
  return `${repoLocalPath}/../worktrees/${repoName}/${branchName}`;
}

function buildKickoffPlan(input: TaskIntakeInput, options: {
  plannedTaskId: number | null;
  suggestedBranchName: string | null;
  projectRepoLocalPath: string | null;
}): TaskKickoffPlan {
  const requested = normalizeTaskIntakeBehavior(input.behavior) === "create_and_kickoff";
  const confirmedRepoLocalPath = normalize(input.confirm_repo_local_path);
  const existingRepoLocalPath = normalize(options.projectRepoLocalPath);
  const proposedRepoLocalPath = deriveSuggestedRepoLocalPath(input);
  const repoLocalPath = existingRepoLocalPath ?? confirmedRepoLocalPath;
  const repoLocalPathSource: KickoffRepoLocalPathSource = existingRepoLocalPath
    ? "project"
    : (confirmedRepoLocalPath ? "confirmed_input" : null);
  const requiresRepoLocalPathConfirmation = requested && !repoLocalPath;
  const sessionName = requested && options.plannedTaskId != null ? `fabric-task-${options.plannedTaskId}` : null;
  const subAgentId = requested && options.plannedTaskId != null ? `sub-boss-${options.plannedTaskId}` : null;
  const worktreePath = requested && repoLocalPath && options.suggestedBranchName
    ? buildKickoffWorktreePath(repoLocalPath, options.suggestedBranchName)
    : null;

  return {
    requested,
    supported: requested && !requiresRepoLocalPathConfirmation,
    repo_local_path: repoLocalPath,
    repo_local_path_source: repoLocalPathSource,
    proposed_repo_local_path: proposedRepoLocalPath,
    requires_repo_local_path_confirmation: requiresRepoLocalPathConfirmation,
    worktree_path: worktreePath,
    session_name: sessionName,
    sub_agent_id: subAgentId,
    status_on_success: "in_progress",
  };
}

function buildContextCapsule(input: TaskIntakeInput, plan: TaskCreationPlan): string {
  const lines: string[] = [
    `Task created via pm_create_task_intelligent.`,
    `project_id: ${plan.project_id ?? "unknown"}`,
    `project_name: ${plan.project_name ?? "unknown"}`,
    `matched_by: ${plan.matched_by ?? "unknown"}`,
    `behavior: ${plan.behavior}`,
    `base_branch: ${plan.base_branch}`,
  ];

  const description = normalize(input.description);
  if (description) lines.push(`description: ${description}`);

  const capsule = normalize(input.context_capsule);
  if (capsule) lines.push(`context_capsule: ${capsule}`);

  const confirmedRepoLocalPath = normalize(input.confirm_repo_local_path);
  if (confirmedRepoLocalPath) {
    lines.push(`confirmed_repo_local_path: ${confirmedRepoLocalPath}`);
  }

  if (plan.kickoff.requested) {
    lines.push(`kickoff_supported: ${String(plan.kickoff.supported)}`);
    lines.push(`kickoff_status_on_success: ${plan.kickoff.status_on_success}`);
    if (plan.kickoff.repo_local_path) {
      lines.push(`kickoff_repo_local_path: ${plan.kickoff.repo_local_path}`);
    }
    if (plan.kickoff.repo_local_path_source) {
      lines.push(`kickoff_repo_local_path_source: ${plan.kickoff.repo_local_path_source}`);
    }
    if (!plan.kickoff.repo_local_path && plan.kickoff.proposed_repo_local_path) {
      lines.push(`kickoff_proposed_repo_local_path: ${plan.kickoff.proposed_repo_local_path}`);
    }
    if (plan.kickoff.requires_repo_local_path_confirmation) {
      lines.push(`kickoff_requires_repo_local_path_confirmation: true`);
    }
    if (plan.kickoff.worktree_path) {
      lines.push(`kickoff_worktree_path: ${plan.kickoff.worktree_path}`);
    }
    if (plan.kickoff.session_name) {
      lines.push(`kickoff_session_name: ${plan.kickoff.session_name}`);
    }
    if (plan.kickoff.sub_agent_id) {
      lines.push(`kickoff_sub_agent_id: ${plan.kickoff.sub_agent_id}`);
    }
  }

  const criteria = Array.isArray(input.acceptance_criteria)
    ? input.acceptance_criteria.map((item) => String(item).trim()).filter(Boolean)
    : [];
  if (criteria.length > 0) {
    lines.push(`acceptance_criteria:`);
    for (const criterion of criteria) lines.push(`- ${criterion}`);
  }

  if (plan.warnings.length > 0) {
    lines.push(`warnings:`);
    for (const warning of plan.warnings) lines.push(`- ${warning}`);
  }

  return lines.join("\n");
}

function nextAnalysisVersion(db: DatabaseSync, taskId: number): string {
  const row = db.prepare(
    `SELECT version FROM task_analyses WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`
  ).get(taskId) as { version: string } | undefined;

  if (!row) return "v1";
  const parsed = Number(String(row.version).replace(/^v/, ""));
  return Number.isFinite(parsed) ? `v${parsed + 1}` : "v1";
}

function writeInitialAnalysis(db: DatabaseSync, taskId: number, input: TaskIntakeInput, plan: TaskCreationPlan): { id: number; version: string } | null {
  const agentNote = buildContextCapsule(input, plan).trim();
  if (!agentNote) return null;

  const now = new Date().toISOString();
  const version = nextAnalysisVersion(db, taskId);
  const keywords = JSON.stringify((input.keywords ?? []).map((item) => String(item)));

  db.prepare(
    `UPDATE task_analyses SET is_active = 0, invalidated_at = ? WHERE task_id = ? AND is_active = 1`
  ).run(now, taskId);

  const result = db.prepare(
    `INSERT INTO task_analyses
      (task_id, version, keywords, human_note, agent_note, analysis_type,
       confidence_score, author_id, author_type, created_at, is_active)
     VALUES (?, ?, ?, ?, ?, 'planning', 80, ?, 'agent', ?, 1)`
  ).run(
    taskId,
    version,
    keywords,
    `Task created via intelligent PM helper: ${input.title}`,
    agentNote,
    input.coordinator_agent_id ?? null,
    now,
  );

  return {
    id: Number(result.lastInsertRowid),
    version,
  };
}

export function planTaskCreation(db: DatabaseSync, input: TaskIntakeInput): TaskCreationPlan {
  const title = normalize(input.title);
  if (!title) {
    throw new Error("title is required");
  }

  const behavior = normalizeTaskIntakeBehavior(input.behavior);
  const resolution = resolveProjectSelector(db, input);
  const warnings = [...resolution.warnings];
  const blockers: string[] = [];
  const baseBranch = normalize(input.base_branch) ?? "main";
  const snapshot = buildProjectContextSnapshot(db, {
    ...input,
    include_tasks: true,
    include_task_analyses: true,
    include_agent_states: false,
    active_only: true,
  });

  if (!resolution.project) {
    blockers.push(resolution.ambiguous ? "project_resolution_ambiguous" : "project_not_resolved");
  }

  const project = resolution.project;
  const plannedTaskId = project ? nextTaskId(db) : null;
  const sequenceOrder = project ? computeNextTaskSequence(db, project.id) : null;
  const suggestedBranchName = project && plannedTaskId
    ? generateBranchName(plannedTaskId, project.code, title)
    : null;
  const kickoff = buildKickoffPlan(input, {
    plannedTaskId,
    suggestedBranchName,
    projectRepoLocalPath: project?.repo_local_path ?? null,
  });

  if (behavior === "create_only" && project && !project.repo_local_path) {
    warnings.push("Project repo_local_path is missing; create_only can continue, kickoff cannot.");
  }

  if (behavior === "create_and_kickoff") {
    warnings.push("create_and_kickoff creates the task in draft first and promotes it to in_progress after worktree creation and launch initiation succeed.");

    if (kickoff.repo_local_path_source === "confirmed_input" && !project?.repo_local_path) {
      warnings.push("Project repo_local_path will be persisted from explicit confirm_repo_local_path before kickoff.");
    }

    if (kickoff.requires_repo_local_path_confirmation) {
      blockers.push("repo_local_path_confirmation_required_for_kickoff");
      warnings.push("Project repo_local_path is missing; create_and_kickoff requires explicit confirm_repo_local_path before kickoff.");
      if (kickoff.proposed_repo_local_path) {
        warnings.push(`Suggested confirm_repo_local_path=${kickoff.proposed_repo_local_path}`);
      }
    }
  }

  const canCommit = blockers.length === 0 && !!project;
  const kickoffSupported = behavior === "create_and_kickoff" && canCommit && kickoff.supported;

  return {
    project_id: project?.id ?? null,
    project_name: project?.name ?? null,
    matched_by: resolution.matched_by,
    next_task_id: plannedTaskId,
    sequence_order: sequenceOrder,
    suggested_branch_name: suggestedBranchName,
    base_branch: baseBranch,
    behavior,
    warnings,
    blockers,
    requires_confirmation: resolution.ambiguous || kickoff.requires_repo_local_path_confirmation,
    can_commit: canCommit,
    kickoff_supported: kickoffSupported,
    kickoff: {
      ...kickoff,
      supported: kickoffSupported,
    },
    snapshot_summary: snapshot,
  };
}

export function createTaskWithContext(db: DatabaseSync, input: TaskIntakeInput): CreatedTaskWithContext {
  const plan = planTaskCreation(db, input);
  if (!plan.can_commit || !plan.project_id || plan.sequence_order == null) {
    throw new Error(`Task creation blocked: ${plan.blockers.join(", ") || "project_not_resolved"}`);
  }

  const initialStatus = plan.behavior === "create_and_kickoff"
    ? "draft"
    : (input.status ?? "draft");
  const kickoffOrchestratorId = plan.behavior === "create_and_kickoff"
    ? (plan.kickoff.sub_agent_id ?? undefined)
    : undefined;

  const created = createTask(db, {
    project_id: plan.project_id,
    title: input.title.trim(),
    description: normalize(input.description) ?? undefined,
    status: initialStatus,
    sequence_order: plan.sequence_order,
    coordinator_agent_id: normalize(input.coordinator_agent_id) ?? undefined,
    orchestrator_agent_id: normalize(input.orchestrator_agent_id) ?? kickoffOrchestratorId,
    branch_name: plan.suggested_branch_name ?? undefined,
    base_branch: plan.base_branch,
  });

  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(created.id) as TaskRow | undefined;
  if (!task) {
    throw new Error(`Created task ${created.id} could not be reloaded`);
  }

  const analysis = writeInitialAnalysis(db, task.id, input, plan);
  return { task, analysis, plan };
}
