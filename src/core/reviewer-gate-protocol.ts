export type ReviewerGateLane = "implementation" | "reviewer";

export type ReviewerGateAcceptanceCriterion = {
  id: string;
  description: string;
  type: string;
  params: Record<string, unknown>;
  required: boolean;
};

export type ReviewerGateMetadata = {
  kind: "reviewer_gate_v1";
  phase_id: string;
  phase_label: string | null;
  task_id: string | null;
  coordinator_agent_id: string;
  final_report_to: string;
  implementation_agent_id: string;
  implementation_role: string | null;
  implementation_mode: string | null;
  reviewer_agent_id: string;
  reviewer_role: string | null;
  reviewer_mode: string | null;
  lane: ReviewerGateLane;
  implementation_attempt: number;
  max_implementation_attempts: number;
};

export type ReviewerGateRetryRequest = {
  kind: "reviewer_gate_retry_v1";
  phase_id: string;
  task_id: string | null;
  reviewer_agent_id: string;
  implementation_agent_id: string;
  rejected_attempt: number;
  next_attempt: number;
  max_implementation_attempts: number;
  final_report_to: string;
  findings: string;
};

export type ReviewerGateCleanupDirective = {
  skipReporterCleanup: boolean;
  reason: string | null;
  additionalCleanupTargets: Array<{
    agentId: string;
    role?: string | null;
    mode?: string | null;
  }>;
};

export type ReviewerGateContractPayload = {
  description: string;
  acceptance_criteria: ReviewerGateAcceptanceCriterion[];
  report_to: string;
  report_to_when_done: string;
  files: string[];
  task_id: string;
  reviewer_gate: ReviewerGateMetadata;
};

function toOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return null;
}

function isTerminalStatus(value: unknown): boolean {
  return value === "done" || value === "failed" || value === "blocked";
}

export function parseReviewerGateMetadata(value: unknown): ReviewerGateMetadata | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "reviewer_gate_v1") return null;

  const phaseId = toOptionalString(raw.phase_id);
  const coordinatorAgentId = toOptionalString(raw.coordinator_agent_id);
  const finalReportTo = toOptionalString(raw.final_report_to);
  const implementationAgentId = toOptionalString(raw.implementation_agent_id);
  const reviewerAgentId = toOptionalString(raw.reviewer_agent_id);
  const lane = raw.lane === "implementation" || raw.lane === "reviewer"
    ? raw.lane
    : null;
  const implementationAttempt = toPositiveInteger(raw.implementation_attempt) ?? 1;
  const maxImplementationAttempts = toPositiveInteger(raw.max_implementation_attempts) ?? 2;

  if (!phaseId || !coordinatorAgentId || !finalReportTo || !implementationAgentId || !reviewerAgentId || !lane) {
    return null;
  }

  return {
    kind: "reviewer_gate_v1",
    phase_id: phaseId,
    phase_label: toOptionalString(raw.phase_label),
    task_id: toOptionalString(raw.task_id),
    coordinator_agent_id: coordinatorAgentId,
    final_report_to: finalReportTo,
    implementation_agent_id: implementationAgentId,
    implementation_role: toOptionalString(raw.implementation_role),
    implementation_mode: toOptionalString(raw.implementation_mode),
    reviewer_agent_id: reviewerAgentId,
    reviewer_role: toOptionalString(raw.reviewer_role),
    reviewer_mode: toOptionalString(raw.reviewer_mode),
    lane,
    implementation_attempt: implementationAttempt,
    max_implementation_attempts: Math.max(implementationAttempt, maxImplementationAttempts),
  };
}

export function parseReviewerGateRetryRequest(value: unknown): ReviewerGateRetryRequest | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "reviewer_gate_retry_v1") return null;

  const phaseId = toOptionalString(raw.phase_id);
  const reviewerAgentId = toOptionalString(raw.reviewer_agent_id);
  const implementationAgentId = toOptionalString(raw.implementation_agent_id);
  const finalReportTo = toOptionalString(raw.final_report_to);
  const findings = toOptionalString(raw.findings);
  const rejectedAttempt = toPositiveInteger(raw.rejected_attempt);
  const nextAttempt = toPositiveInteger(raw.next_attempt);
  const maxAttempts = toPositiveInteger(raw.max_implementation_attempts);

  if (!phaseId || !reviewerAgentId || !implementationAgentId || !finalReportTo || !findings || !rejectedAttempt || !nextAttempt || !maxAttempts) {
    return null;
  }

  return {
    kind: "reviewer_gate_retry_v1",
    phase_id: phaseId,
    task_id: toOptionalString(raw.task_id),
    reviewer_agent_id: reviewerAgentId,
    implementation_agent_id: implementationAgentId,
    rejected_attempt: rejectedAttempt,
    next_attempt: nextAttempt,
    max_implementation_attempts: Math.max(nextAttempt, maxAttempts),
    final_report_to: finalReportTo,
    findings,
  };
}

function buildReviewerGateBase(input: {
  phase_id: string;
  phase_label?: string | null;
  task_id?: string | null;
  coordinator_agent_id: string;
  final_report_to: string;
  implementation_agent_id: string;
  implementation_role?: string | null;
  implementation_mode?: string | null;
  reviewer_agent_id: string;
  reviewer_role?: string | null;
  reviewer_mode?: string | null;
  max_implementation_attempts?: number;
}) {
  const maxImplementationAttempts = Math.max(2, Math.floor(input.max_implementation_attempts ?? 2));
  return {
    kind: "reviewer_gate_v1" as const,
    phase_id: input.phase_id,
    phase_label: toOptionalString(input.phase_label) ?? null,
    task_id: toOptionalString(input.task_id) ?? null,
    coordinator_agent_id: input.coordinator_agent_id,
    final_report_to: input.final_report_to,
    implementation_agent_id: input.implementation_agent_id,
    implementation_role: toOptionalString(input.implementation_role) ?? null,
    implementation_mode: toOptionalString(input.implementation_mode) ?? "rpc",
    reviewer_agent_id: input.reviewer_agent_id,
    reviewer_role: toOptionalString(input.reviewer_role) ?? "reviewer",
    reviewer_mode: toOptionalString(input.reviewer_mode) ?? "rpc",
    max_implementation_attempts: maxImplementationAttempts,
  };
}

function buildDefaultReviewerDescription(input: {
  phase_id: string;
  phase_label?: string | null;
  implementation_agent_id: string;
  final_report_to: string;
  max_implementation_attempts: number;
}) {
  const label = toOptionalString(input.phase_label) ?? input.phase_id;
  return (
    `Validate reviewer-gated phase \"${label}\" after terminal completion reports from ${input.implementation_agent_id}. ` +
    `Do not implement code. Do not send a terminal verdict before a terminal completion report arrives from ${input.implementation_agent_id}. ` +
    `Validate against the acceptance criteria and available evidence. ` +
    `If review fails on attempt 1, send a direct retry request to ${input.implementation_agent_id} with findings and allow exactly one retry. ` +
    `If review fails on attempt ${input.max_implementation_attempts}, report failed to ${input.final_report_to}. ` +
    `If review passes, report done to ${input.final_report_to}.`
  );
}

export function buildReviewerGateContracts(input: {
  phase_id: string;
  phase_label?: string | null;
  task_id: string;
  coordinator_agent_id: string;
  final_report_to: string;
  implementation_agent_id: string;
  implementation_role?: string | null;
  implementation_mode?: string | null;
  reviewer_agent_id: string;
  reviewer_role?: string | null;
  reviewer_mode?: string | null;
  implementation_description: string;
  reviewer_description?: string | null;
  acceptance_criteria: ReviewerGateAcceptanceCriterion[];
  files?: string[];
  max_implementation_attempts?: number;
}): {
  phase_id: string;
  implementation_contract: ReviewerGateContractPayload;
  reviewer_contract: ReviewerGateContractPayload;
} {
  const base = buildReviewerGateBase(input);
  const files = Array.isArray(input.files) ? input.files.map((file) => String(file)) : [];
  const criteria = Array.isArray(input.acceptance_criteria) ? input.acceptance_criteria.map((criterion) => ({
    id: String(criterion.id),
    description: String(criterion.description),
    type: String(criterion.type),
    params: criterion.params ?? {},
    required: Boolean(criterion.required),
  })) : [];

  const implementationGate: ReviewerGateMetadata = {
    ...base,
    lane: "implementation",
    implementation_attempt: 1,
  };
  const reviewerGate: ReviewerGateMetadata = {
    ...base,
    lane: "reviewer",
    implementation_attempt: 1,
  };

  return {
    phase_id: input.phase_id,
    implementation_contract: {
      description: input.implementation_description,
      acceptance_criteria: criteria,
      report_to: input.reviewer_agent_id,
      report_to_when_done: input.reviewer_agent_id,
      files,
      task_id: input.task_id,
      reviewer_gate: implementationGate,
    },
    reviewer_contract: {
      description: toOptionalString(input.reviewer_description)
        ?? buildDefaultReviewerDescription({
          phase_id: input.phase_id,
          phase_label: input.phase_label,
          implementation_agent_id: input.implementation_agent_id,
          final_report_to: input.final_report_to,
          max_implementation_attempts: base.max_implementation_attempts,
        }),
      acceptance_criteria: criteria,
      report_to: input.final_report_to,
      report_to_when_done: input.final_report_to,
      files,
      task_id: input.task_id,
      reviewer_gate: reviewerGate,
    },
  };
}

export function getReviewerGateAutoCleanupDirective(input: {
  reporterAgentId?: unknown;
  status?: unknown;
  reviewerGate?: unknown;
}): ReviewerGateCleanupDirective {
  const reporterAgentId = toOptionalString(input.reporterAgentId);
  const reviewerGate = parseReviewerGateMetadata(input.reviewerGate);

  if (!reporterAgentId || !reviewerGate || !isTerminalStatus(input.status)) {
    return {
      skipReporterCleanup: false,
      reason: null,
      additionalCleanupTargets: [],
    };
  }

  if (reviewerGate.lane === "implementation" && reporterAgentId === reviewerGate.implementation_agent_id) {
    return {
      skipReporterCleanup: true,
      reason: "awaiting_reviewer_gate_verdict",
      additionalCleanupTargets: [],
    };
  }

  if (reviewerGate.lane === "reviewer" && reporterAgentId === reviewerGate.reviewer_agent_id) {
    return {
      skipReporterCleanup: false,
      reason: null,
      additionalCleanupTargets: [
        {
          agentId: reviewerGate.implementation_agent_id,
          role: reviewerGate.implementation_role,
          mode: reviewerGate.implementation_mode,
        },
      ],
    };
  }

  return {
    skipReporterCleanup: false,
    reason: null,
    additionalCleanupTargets: [],
  };
}

export function isReviewerGateRetryAllowed(input: {
  reviewerGate?: unknown;
  implementationAttempt?: unknown;
}): boolean {
  const reviewerGate = parseReviewerGateMetadata(input.reviewerGate);
  const implementationAttempt = toPositiveInteger(input.implementationAttempt) ?? reviewerGate?.implementation_attempt ?? 1;
  if (!reviewerGate || reviewerGate.lane !== "reviewer") return false;
  return implementationAttempt < reviewerGate.max_implementation_attempts;
}

export function buildReviewerGateRetryRequest(input: {
  reviewerGate: ReviewerGateMetadata;
  implementationAttempt: number;
  findings: string;
}): { text: string; reviewer_gate_retry: ReviewerGateRetryRequest } {
  const rejectedAttempt = Math.max(1, Math.floor(input.implementationAttempt));
  const nextAttempt = Math.min(
    input.reviewerGate.max_implementation_attempts,
    rejectedAttempt + 1
  );
  const findings = input.findings.trim();

  const retryRequest: ReviewerGateRetryRequest = {
    kind: "reviewer_gate_retry_v1",
    phase_id: input.reviewerGate.phase_id,
    task_id: input.reviewerGate.task_id,
    reviewer_agent_id: input.reviewerGate.reviewer_agent_id,
    implementation_agent_id: input.reviewerGate.implementation_agent_id,
    rejected_attempt: rejectedAttempt,
    next_attempt: nextAttempt,
    max_implementation_attempts: input.reviewerGate.max_implementation_attempts,
    final_report_to: input.reviewerGate.final_report_to,
    findings,
  };

  const text =
    `REVIEWER GATE RETRY REQUEST\n` +
    `phase_id: ${retryRequest.phase_id}\n` +
    `task_id: ${retryRequest.task_id ?? "unknown"}\n` +
    `rejected_attempt: ${retryRequest.rejected_attempt}\n` +
    `next_attempt: ${retryRequest.next_attempt}\n` +
    `max_attempts: ${retryRequest.max_implementation_attempts}\n` +
    `report_to_after_retry: ${input.reviewerGate.reviewer_agent_id}\n` +
    `final_report_to: ${retryRequest.final_report_to}\n` +
    `instructions:\n` +
    `- Apply the reviewer findings.\n` +
    `- Re-run the contract acceptance criteria.\n` +
    `- Report terminal completion again to ${input.reviewerGate.reviewer_agent_id}.\n` +
    `- Do not report directly to ${retryRequest.final_report_to}.\n` +
    `- This is the only retry allowed for this phase.\n` +
    `findings:\n${findings}`;

  return {
    text,
    reviewer_gate_retry: retryRequest,
  };
}
