/**
 * Telegram routing NLU proxy.
 *
 * Strictly normalizes raw Telegram text into TelegramRoutingIntent JSON.
 * It does not inspect internals, logs, mailboxes, or task/project details.
 */

// ── Config ──
const FERN_API_KEY = process.env.FERN_API_KEY || process.env.OPENAI_API_KEY || "";
const FERN_BASE_URL = process.env.FERN_BASE_URL || "https://api.fern.dev/v1";
const LLM_TIMEOUT_MS = 8000;
const NLU_MODEL = process.env.FERN_NLU_MODEL || "fern/gpt-4o-mini";

export interface ActiveCoordinatorSnapshot {
  agent_id: string;
  role: "coordinator" | "sub-coordinator";
  fabric_status: string;
  current_task?: string | null;
}

export interface ActiveProjectSnapshot {
  project_id: number;
  name: string;
  status: string;
  short_title?: string;
}

export interface TelegramRoutingIntent {
  kind: "telegram_routing_intent";
  original_language: string;
  normalized_instruction: string;
  intended_coordinator_id: string | null;
  project_hint: {
    project_id: number | null;
    project_name: string | null;
    matched_text: string | null;
  };
  confidence: number;
  route_reason: string;
  needs_clarification: boolean;
  user_facing_clarification: string | null;
  monitor_action: "route" | "clarify" | "fallback_to_default";
}

function emptyProjectHint() {
  return { project_id: null, project_name: null, matched_text: null };
}

function detectLanguage(raw: string): string {
  return /\b(el|la|los|las|que|por|para|necesito|quiero|actualiza|dile|hola)\b/i.test(raw)
    ? "es"
    : "en";
}

function inferProjectHint(raw: string, projects: ActiveProjectSnapshot[]): TelegramRoutingIntent["project_hint"] {
  const lower = raw.toLowerCase();
  for (const project of projects) {
    const name = String(project.name || "").trim();
    if (name && lower.includes(name.toLowerCase())) {
      return { project_id: project.project_id, project_name: project.name, matched_text: name };
    }
    const short = String(project.short_title || "").trim();
    if (short && lower.includes(short.toLowerCase())) {
      return { project_id: project.project_id, project_name: project.name, matched_text: short };
    }
  }
  return emptyProjectHint();
}

function baseIntent(raw: string, projects: ActiveProjectSnapshot[]): TelegramRoutingIntent {
  return {
    kind: "telegram_routing_intent",
    original_language: detectLanguage(raw),
    normalized_instruction: raw.trim(),
    intended_coordinator_id: null,
    project_hint: inferProjectHint(raw, projects),
    confidence: 0.5,
    route_reason: "fallback",
    needs_clarification: false,
    user_facing_clarification: null,
    monitor_action: "fallback_to_default",
  };
}

export function validateTelegramRoutingIntent(
  raw: unknown,
  activeCoordinatorIds: string[],
  defaultCoordinator: string
): TelegramRoutingIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;

  if (data.kind !== "telegram_routing_intent") return null;

  const monitorAction = String(data.monitor_action || "");
  if (!(["route", "clarify", "fallback_to_default"] as string[]).includes(monitorAction)) {
    return null;
  }

  const intended = data.intended_coordinator_id == null
    ? null
    : String(data.intended_coordinator_id);

  if (intended && !activeCoordinatorIds.includes(intended)) {
    return null;
  }

  const hint = (data.project_hint && typeof data.project_hint === "object")
    ? (data.project_hint as Record<string, unknown>)
    : {};

  const confidenceRaw = Number(data.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0.5;

  const normalizedInstruction = String(data.normalized_instruction || "").trim();

  const intent: TelegramRoutingIntent = {
    kind: "telegram_routing_intent",
    original_language: String(data.original_language || "unknown"),
    normalized_instruction: normalizedInstruction,
    intended_coordinator_id: intended,
    project_hint: {
      project_id: Number.isFinite(Number(hint.project_id)) ? Number(hint.project_id) : null,
      project_name: hint.project_name == null ? null : String(hint.project_name),
      matched_text: hint.matched_text == null ? null : String(hint.matched_text),
    },
    confidence,
    route_reason: String(data.route_reason || "llm_normalized"),
    needs_clarification: Boolean(data.needs_clarification),
    user_facing_clarification: data.user_facing_clarification == null
      ? null
      : String(data.user_facing_clarification),
    monitor_action: monitorAction as TelegramRoutingIntent["monitor_action"],
  };

  if (!intent.normalized_instruction && intent.monitor_action !== "clarify") {
    intent.normalized_instruction = "(empty instruction)";
  }

  if (intent.monitor_action === "fallback_to_default") {
    intent.intended_coordinator_id = defaultCoordinator;
  }

  if (intent.monitor_action === "route" && !intent.intended_coordinator_id) {
    return null;
  }

  return intent;
}

function parseExplicitRouting(
  raw: string,
  coordinators: ActiveCoordinatorSnapshot[],
  projects: ActiveProjectSnapshot[],
  defaultCoordinator: string
): TelegramRoutingIntent | null {
  const text = raw.trim();
  const coordinatorIds = new Set(coordinators.map((c) => c.agent_id));

  const toMatch = text.match(/^\/to\s+([a-zA-Z0-9._-]+)\s+([\s\S]+)$/i);
  if (toMatch) {
    const target = toMatch[1];
    const instruction = toMatch[2].trim();
    const base = baseIntent(raw, projects);
    if (!coordinatorIds.has(target)) {
      return {
        ...base,
        confidence: 0.98,
        monitor_action: "clarify",
        needs_clarification: true,
        route_reason: `Invalid /to target: ${target}`,
        user_facing_clarification: `Coordinator '${target}' is not active. Use /coordinators to list valid targets.`,
      };
    }
    return {
      ...base,
      intended_coordinator_id: target,
      normalized_instruction: instruction,
      confidence: 0.99,
      route_reason: "explicit /to command",
      monitor_action: "route",
    };
  }

  const switchMatch = text.match(/^\/switch\s+([a-zA-Z0-9._-]+)$/i);
  if (switchMatch) {
    const target = switchMatch[1];
    const base = baseIntent(raw, projects);
    if (!coordinatorIds.has(target)) {
      return {
        ...base,
        confidence: 0.97,
        monitor_action: "clarify",
        needs_clarification: true,
        route_reason: `Invalid /switch target: ${target}`,
        user_facing_clarification: `Coordinator '${target}' is not active. Use /coordinators to list valid targets.`,
      };
    }
    return {
      ...base,
      intended_coordinator_id: target,
      normalized_instruction: `Switch chat routing to ${target}`,
      confidence: 0.99,
      route_reason: "explicit /switch command",
      monitor_action: "route",
    };
  }

  for (const coordinator of coordinators) {
    const id = coordinator.agent_id;
    const mentionRegex = new RegExp(`\\b${id.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "i");
    if (mentionRegex.test(text)) {
      const cleaned = text
        .replace(/^(dile\s+a\s+|tell\s+)/i, "")
        .replace(new RegExp(`\\b${id.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "i"), "")
        .replace(/^(que|to)\s+/i, "")
        .trim();

      return {
        ...baseIntent(raw, projects),
        intended_coordinator_id: id,
        normalized_instruction: cleaned || raw.trim(),
        confidence: 0.92,
        route_reason: "explicit coordinator mention",
        monitor_action: "route",
      };
    }
  }

  if (coordinatorIds.has(defaultCoordinator)) {
    return {
      ...baseIntent(raw, projects),
      intended_coordinator_id: defaultCoordinator,
      confidence: 0.6,
      route_reason: "fallback default coordinator",
      monitor_action: "fallback_to_default",
    };
  }

  return {
    ...baseIntent(raw, projects),
    confidence: 0.3,
    needs_clarification: true,
    monitor_action: "clarify",
    route_reason: "no active default coordinator",
    user_facing_clarification: "No active coordinator is available right now. Try again in a moment.",
  };
}

async function callFernProxy(systemPrompt: string, userPrompt: string): Promise<string> {
  const url = `${FERN_BASE_URL}/chat/completions`;

  const body = {
    model: NLU_MODEL,
    temperature: 0,
    max_tokens: 400,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${FERN_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Fern HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as any;
    return String(data?.choices?.[0]?.message?.content ?? "");
  } finally {
    clearTimeout(timeout);
  }
}

async function llmInterpret(
  rawMessage: string,
  coordinators: ActiveCoordinatorSnapshot[],
  projects: ActiveProjectSnapshot[],
  defaultCoordinator: string
): Promise<TelegramRoutingIntent | null> {
  const outputSchema = {
    kind: "telegram_routing_intent",
    original_language: "string",
    normalized_instruction: "string",
    intended_coordinator_id: "string|null",
    project_hint: {
      project_id: "number|null",
      project_name: "string|null",
      matched_text: "string|null",
    },
    confidence: "number(0..1)",
    route_reason: "string",
    needs_clarification: "boolean",
    user_facing_clarification: "string|null",
    monitor_action: "route|clarify|fallback_to_default",
  };

  const routingRules = [
    "Targets must be active coordinator agents only.",
    "Workers are never valid targets.",
    "Use only provided input. Do not infer project/task internals.",
    "Output must be JSON only and match schema.",
    `Default coordinator is '${defaultCoordinator}'.`,
  ];

  const systemPrompt = [
    "You are a lightweight Telegram routing normalizer for Fabric.",
    "Return only valid JSON matching TelegramRoutingIntent.",
    "Use only provided raw_telegram_message, active_coordinators, active_projects, output_schema, routing_rules.",
    "Do not use external knowledge.",
    "Do not infer task internals.",
    "Do not target workers.",
    "No markdown. No prose.",
  ].join(" ");

  const input = {
    raw_telegram_message: rawMessage,
    active_coordinators: coordinators.map((c) => ({
      agent_id: c.agent_id,
      role: c.role,
      status: c.fabric_status,
      current_task: c.current_task ?? null,
    })),
    active_projects: projects.map((p) => ({
      project_id: p.project_id,
      name: p.name,
      status: p.status,
      short_title: p.short_title ?? "",
    })),
    output_schema: outputSchema,
    routing_rules: routingRules,
  };

  const raw = await callFernProxy(systemPrompt, JSON.stringify(input));

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }

  return validateTelegramRoutingIntent(parsed, coordinators.map((c) => c.agent_id), defaultCoordinator);
}

export async function interpretMessage(
  rawMessage: string,
  activeCoordinators: ActiveCoordinatorSnapshot[],
  activeProjects: ActiveProjectSnapshot[],
  defaultCoordinator: string
): Promise<TelegramRoutingIntent> {
  const explicit = parseExplicitRouting(rawMessage, activeCoordinators, activeProjects, defaultCoordinator);
  if (explicit && explicit.monitor_action !== "fallback_to_default") {
    return explicit;
  }

  if (FERN_API_KEY) {
    try {
      const llm = await llmInterpret(rawMessage, activeCoordinators, activeProjects, defaultCoordinator);
      if (llm) return llm;
    } catch (err) {
      console.error("[telegram-nlu] LLM normalization failed:", (err as Error).message);
    }
  }

  return explicit ?? parseExplicitRouting(rawMessage, activeCoordinators, activeProjects, defaultCoordinator)!;
}
