import { DatabaseSync } from "node:sqlite";
import { createSubtask } from "./commands.js";
import { addSubtaskDependency } from "./dependencies.js";

export type OrchestrationDependency = {
  from_local_id: string;
  to_local_id: string;
  dependency_type: "blocking";
};

export type OrchestrationSubtask = {
  local_id: string;
  title: string;
  description: string | null;
  sequence_order: number;
  priority: number;
  required_role: string;
  acceptance_criteria_text: string[];
  acceptance_criteria_structured: Array<{
    id: string;
    description: string;
    type: "manual";
    params: { instructions: string };
    required: boolean;
  }>;
  depends_on_local_ids: string[];
};

export type OrchestrationPlan = {
  source: "spoken_plan";
  summary: string;
  subtasks: OrchestrationSubtask[];
  dependencies: OrchestrationDependency[];
  warnings: string[];
};

export type ParseSpokenPlanInput = {
  plan_text: string;
  default_role?: string;
  infer_linear_dependencies?: boolean;
  max_subtasks?: number;
};

export type MaterializedOrchestrationPlan = {
  task_id: number;
  created_subtasks: Array<{
    local_id: string;
    subtask_id: number;
    title: string;
  }>;
  created_dependencies: Array<{
    from_subtask_id: number;
    to_subtask_id: number;
    dependency_type: "blocking";
  }>;
};

type ParsedStepDraft = {
  raw: string;
  title: string;
  description: string | null;
  role: string;
  acceptanceCriteria: string[];
  explicitDependencyRefs: string[];
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripListPrefix(line: string): string {
  return line
    .replace(/^\s*(?:[-*+•]|\d+[\).:-]|(?:fase|phase)\s+\d+[:.-]?)\s*/i, "")
    .trim();
}

function splitSpokenPlanIntoSteps(planText: string): string[] {
  const lines = planText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const lineMarkers = lines.filter((line) => /^\s*(?:[-*+•]|\d+[\).:-]|(?:fase|phase)\s+\d+[:.-]?)/i.test(line));

  if (lines.length >= 2 && lineMarkers.length >= 2) {
    const grouped: string[] = [];
    let current = "";

    for (const line of lines) {
      const isMarker = /^\s*(?:[-*+•]|\d+[\).:-]|(?:fase|phase)\s+\d+[:.-]?)/i.test(line);
      if (isMarker) {
        if (current) grouped.push(current.trim());
        current = stripListPrefix(line);
      } else {
        current = current ? `${current} ${line}` : line;
      }
    }
    if (current) grouped.push(current.trim());
    return grouped.filter(Boolean);
  }

  const compact = normalizeWhitespace(planText.replace(/\r?\n+/g, " "));
  if (!compact) return [];

  const separator = /\s*(?:;|\.\s+(?=[A-ZÁÉÍÓÚÑ0-9])|\s+y\s+luego\s+|\s+y\s+despu[eé]s\s+|\s+despu[eé]s\s+|\s+luego\s+|\s+then\s+|\s+after\s+that\s+)\s*/gi;
  const parts = compact
    .split(separator)
    .map((part) => stripListPrefix(part))
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);

  if (parts.length <= 1) {
    return [compact];
  }

  return parts;
}

function parseDependencyRefs(refChunk: string): string[] {
  const refs: string[] = [];

  for (const match of refChunk.matchAll(/\bS(\d+)\b/gi)) {
    refs.push(`S${Number(match[1])}`);
  }
  for (const match of refChunk.matchAll(/#?(\d{1,3})\b/g)) {
    refs.push(`S${Number(match[1])}`);
  }

  return Array.from(new Set(refs));
}

function extractDependencies(raw: string): { cleaned: string; refs: string[] } {
  let cleaned = raw;
  const refs = new Set<string>();

  const bracketMatches = Array.from(cleaned.matchAll(/\[(?:deps?|depends?)\s*:\s*([^\]]+)\]/gi));
  for (const match of bracketMatches) {
    for (const ref of parseDependencyRefs(match[1])) refs.add(ref);
    cleaned = cleaned.replace(match[0], " ");
  }

  const naturalMatches = Array.from(cleaned.matchAll(/(?:depende(?:n)?\s+de|depends?\s+on)\s+([^.;]+)/gi));
  for (const match of naturalMatches) {
    for (const ref of parseDependencyRefs(match[1])) refs.add(ref);
    cleaned = cleaned.replace(match[0], " ");
  }

  return {
    cleaned: normalizeWhitespace(cleaned),
    refs: Array.from(refs),
  };
}

function extractRole(raw: string, fallbackRole: string): { cleaned: string; role: string } {
  const match = raw.match(/(?:worker|agent|agente|role|rol)\s*[:=]\s*([a-zA-Z0-9_-]+)/i);
  if (!match) {
    return { cleaned: raw, role: fallbackRole };
  }

  const role = normalizeWhitespace(match[1]).toLowerCase();
  const cleaned = normalizeWhitespace(raw.replace(match[0], " "));
  return { cleaned, role: role || fallbackRole };
}

function extractAcceptanceCriteria(raw: string): { cleaned: string; criteria: string[] } {
  const match = raw.match(/(?:acceptance\s*criteria|acceptance|criterios?|criteria)\s*[:=]\s*(.+)$/i);
  if (!match) {
    return { cleaned: raw, criteria: [] };
  }

  const criteria = match[1]
    .split(/\s*\|\s*|\s*;\s*/)
    .map((item) => normalizeWhitespace(item))
    .filter(Boolean);

  const cleaned = normalizeWhitespace(raw.replace(match[0], " "));
  return { cleaned, criteria };
}

function deriveTitleAndDescription(raw: string): { title: string; description: string | null } {
  const clean = normalizeWhitespace(raw);
  if (!clean) {
    return { title: "Untitled step", description: null };
  }

  const colonSplit = clean.split(/\s*:\s*/, 2);
  if (colonSplit.length === 2 && colonSplit[0].length >= 6 && colonSplit[0].length <= 100) {
    const title = normalizeWhitespace(colonSplit[0]);
    const description = normalizeWhitespace(colonSplit[1]);
    return {
      title,
      description: description && description !== title ? description : null,
    };
  }

  const sentence = normalizeWhitespace((clean.split(/[.;]/)[0] || clean));
  if (sentence.length >= 8 && sentence.length <= 100 && clean.length > sentence.length + 4) {
    return { title: sentence, description: clean };
  }

  if (clean.length <= 100) {
    return { title: clean, description: null };
  }

  const truncated = clean.slice(0, 100);
  const safeTitle = truncated.includes(" ")
    ? truncated.slice(0, truncated.lastIndexOf(" ")).trim()
    : truncated.trim();

  return {
    title: safeTitle || "Untitled step",
    description: clean,
  };
}

function buildStructuredManualCriteria(localId: string, title: string, criteria: string[], description: string | null) {
  const source = criteria.length > 0
    ? criteria
    : [`Validate completion of ${title}.`];

  return source.map((criterion, index) => ({
    id: `${localId.toLowerCase()}-ac-${index + 1}`,
    description: criterion,
    type: "manual" as const,
    params: {
      instructions: description
        ? `${criterion} Context: ${description}`
        : criterion,
    },
    required: true,
  }));
}

export function parseSpokenPlanToOrchestration(input: ParseSpokenPlanInput): OrchestrationPlan {
  const rawPlanText = String(input.plan_text ?? "").trim();
  if (!rawPlanText) throw new Error("plan_text is required");
  const planText = normalizeWhitespace(rawPlanText);

  const defaultRole = normalizeWhitespace(input.default_role || "dev").toLowerCase() || "dev";
  const inferLinear = input.infer_linear_dependencies !== false;
  const maxSubtasks = Math.min(Math.max(Number(input.max_subtasks ?? 20), 1), 50);
  const warnings: string[] = [];

  const rawSteps = splitSpokenPlanIntoSteps(rawPlanText);
  const limitedSteps = rawSteps.slice(0, maxSubtasks);
  if (rawSteps.length > maxSubtasks) {
    warnings.push(`max_subtasks_exceeded: truncated_to_${maxSubtasks}`);
  }

  const drafts: ParsedStepDraft[] = limitedSteps.map((raw) => {
    const depExtracted = extractDependencies(raw);
    const roleExtracted = extractRole(depExtracted.cleaned, defaultRole);
    const criteriaExtracted = extractAcceptanceCriteria(roleExtracted.cleaned);
    const { title, description } = deriveTitleAndDescription(criteriaExtracted.cleaned);

    return {
      raw,
      title,
      description,
      role: roleExtracted.role,
      acceptanceCriteria: criteriaExtracted.criteria,
      explicitDependencyRefs: depExtracted.refs,
    };
  });

  const localIds = drafts.map((_draft, idx) => `S${idx + 1}`);

  const subtasks: OrchestrationSubtask[] = drafts.map((draft, idx) => {
    const local_id = localIds[idx];
    const dependsOn = draft.explicitDependencyRefs.filter((ref) => localIds.includes(ref) && ref !== local_id);

    if (draft.explicitDependencyRefs.length > 0) {
      for (const ref of draft.explicitDependencyRefs) {
        if (!localIds.includes(ref)) warnings.push(`unknown_dependency_ref:${local_id}->${ref}`);
      }
    }

    if (dependsOn.length === 0 && inferLinear && idx > 0) {
      dependsOn.push(localIds[idx - 1]);
    }

    const priority = Math.max(1, drafts.length - idx);
    const structuredCriteria = buildStructuredManualCriteria(local_id, draft.title, draft.acceptanceCriteria, draft.description);

    return {
      local_id,
      title: draft.title,
      description: draft.description,
      sequence_order: idx + 1,
      priority,
      required_role: draft.role,
      acceptance_criteria_text: structuredCriteria.map((criterion) => criterion.description),
      acceptance_criteria_structured: structuredCriteria,
      depends_on_local_ids: Array.from(new Set(dependsOn)),
    };
  });

  const dependencies: OrchestrationDependency[] = [];
  for (const subtask of subtasks) {
    for (const dep of subtask.depends_on_local_ids) {
      dependencies.push({
        from_local_id: dep,
        to_local_id: subtask.local_id,
        dependency_type: "blocking",
      });
    }
  }

  return {
    source: "spoken_plan",
    summary: planText.slice(0, 240),
    subtasks,
    dependencies,
    warnings: Array.from(new Set(warnings)),
  };
}

export function materializeOrchestrationPlan(
  db: DatabaseSync,
  taskId: number,
  plan: OrchestrationPlan,
): MaterializedOrchestrationPlan {
  const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId) as { id: number } | undefined;
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  const seqBaseRow = db
    .prepare("SELECT COALESCE(MAX(sequence_order), 0) AS max_seq FROM subtasks WHERE task_id = ?")
    .get(taskId) as { max_seq: number };
  const baseSequence = Number(seqBaseRow?.max_seq ?? 0);

  const createdSubtasks: MaterializedOrchestrationPlan["created_subtasks"] = [];
  const localToDbId = new Map<string, number>();

  for (const subtask of plan.subtasks) {
    const validationCriteria = subtask.acceptance_criteria_text.length > 0
      ? subtask.acceptance_criteria_text.map((criterion) => `- ${criterion}`).join("\n")
      : null;

    const created = createSubtask(db, {
      task_id: taskId,
      title: subtask.title,
      description: subtask.description ?? undefined,
      status: "backlog",
      sequence_order: baseSequence + subtask.sequence_order,
      priority: subtask.priority,
      validation_criteria: validationCriteria ?? undefined,
    });

    const subtaskId = Number(created.id);
    localToDbId.set(subtask.local_id, subtaskId);
    createdSubtasks.push({
      local_id: subtask.local_id,
      subtask_id: subtaskId,
      title: subtask.title,
    });
  }

  const createdDependencies: MaterializedOrchestrationPlan["created_dependencies"] = [];
  for (const dependency of plan.dependencies) {
    const fromId = localToDbId.get(dependency.from_local_id);
    const toId = localToDbId.get(dependency.to_local_id);
    if (!fromId || !toId || fromId === toId) continue;

    try {
      addSubtaskDependency(db, toId, fromId, "blocking");
      createdDependencies.push({
        from_subtask_id: fromId,
        to_subtask_id: toId,
        dependency_type: "blocking",
      });
    } catch {
      // ignore duplicates/invalid references during materialization
    }
  }

  return {
    task_id: taskId,
    created_subtasks: createdSubtasks,
    created_dependencies: createdDependencies,
  };
}
