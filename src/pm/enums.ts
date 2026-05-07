// ============================================================
// Project Management Enums — Product Model
// ============================================================

// Projects: containers only, no agents
export const PROJECT_STATUSES = ['planned', 'active', 'blocked', 'completed', 'cancelled', 'failed', 'archived'] as const;
export type ProjectStatus = typeof PROJECT_STATUSES[number];

// Tasks: exactly 4 states
export const TASK_STATUSES = ['draft', 'in_progress', 'completed', 'failed'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

// Subtasks: exactly 6 states
export const SUBTASK_STATUSES = ['backlog', 'ready', 'running', 'validating', 'done', 'failed', 'blocked'] as const;
export type SubtaskStatus = typeof SUBTASK_STATUSES[number];

export const WORKTREE_STATUSES = ['active', 'archived', 'deleted'] as const;
export type WorktreeStatus = typeof WORKTREE_STATUSES[number];

export const SUBTASK_DEPENDENCY_TYPES = ['blocking', 'logical'] as const;
export type SubtaskDependencyType = typeof SUBTASK_DEPENDENCY_TYPES[number];

export const ENTITY_TYPES = ['project', 'task', 'subtask'] as const;
export type EntityType = typeof ENTITY_TYPES[number];

export const ACTOR_TYPES = ['user', 'agent', 'system'] as const;
export type ActorType = typeof ACTOR_TYPES[number];

// Project links
export const PROJECT_LINK_TYPES = [
  'technical_spec',
  'release_plan',
  'architecture_doc',
  'github',
  'slack',
  'notion',
  'other'
] as const;
export type ProjectLinkType = typeof PROJECT_LINK_TYPES[number];

// Bugs
export const BUG_STATUSES = ['open', 'acknowledged', 'fixing', 'resolved', 'wontfix'] as const;
export type BugStatus = typeof BUG_STATUSES[number];

export const BUG_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type BugSeverity = typeof BUG_SEVERITIES[number];

// Task Analyses
export const ANALYSIS_TYPES = [
  'debugging',
  'root_cause',
  'planning',
  'review',
  'validation',
  'evaluation',
  'retro',
  'decision',
  'general',
] as const;
export type AnalysisType = typeof ANALYSIS_TYPES[number];

// ============================================================
// Validators
// ============================================================

export function isValidStatus(entity: 'project' | 'task' | 'subtask', status: string): boolean {
  switch (entity) {
    case 'project':
      return PROJECT_STATUSES.includes(status as ProjectStatus);
    case 'task':
      return TASK_STATUSES.includes(status as TaskStatus);
    case 'subtask':
      return SUBTASK_STATUSES.includes(status as SubtaskStatus);
    default:
      return false;
  }
}

export function isValidProjectLinkType(type: string): boolean {
  return PROJECT_LINK_TYPES.includes(type as ProjectLinkType);
}

export function isValidBugStatus(status: string): boolean {
  return BUG_STATUSES.includes(status as BugStatus);
}

export function isValidBugSeverity(severity: string): boolean {
  return BUG_SEVERITIES.includes(severity as BugSeverity);
}
