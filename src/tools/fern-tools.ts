/**
 * Fern Tools - Model Management
 * 
 * Tools for fetching available models from the fern proxy and tracking consumption.
 * This is a standalone extension file that can be loaded separately for testing.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const FERN_BASE_URL = "https://fern.addi.com/v1";
const MODELS_JSON_PATH = `${process.env.HOME || "/Users/jescobar"}/.pi/agent/models.json`;

interface FernModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface ModelInfo {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  api?: string;
}

// Known model configurations (fallback when API doesn't provide full info)
const KNOWN_MODELS: Record<string, Partial<ModelInfo>> = {
  "gemini-3.1-flash-lite": {
    name: "Gemini 3.1 Flash Lite",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 0.25, output: 1.5, cacheRead: 0, cacheWrite: 0 },
  },
  "minimax-m2.7": {
    name: "MiniMax M2.7",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 },
  },
  "qwen3p6-plus": {
    name: "Qwen 3.6 Plus",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 0.5, output: 3.0, cacheRead: 0, cacheWrite: 0 },
  },
  "kimi-k2.5": {
    name: "Kimi K2.5",
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 262144,
    cost: { input: 0.6, output: 3.0, cacheRead: 0, cacheWrite: 0 },
  },
  "kimi-k2.6": {
    name: "Kimi K2.6",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 0.95, output: 4.0, cacheRead: 0, cacheWrite: 0 },
  },
  "claude-haiku-4-5": {
    name: "Claude Haiku 4.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    cost: { input: 1.0, output: 5.0, cacheRead: 0, cacheWrite: 0 },
  },
  "glm-5": {
    name: "GLM-5",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 1.0, output: 3.2, cacheRead: 0, cacheWrite: 0 },
  },
  "glm-5p1": {
    name: "GLM-5.1",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 1.4, output: 4.4, cacheRead: 0, cacheWrite: 0 },
  },
  "gpt-5.3-codex": {
    name: "GPT-5.3 Codex",
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 272000,
    maxTokens: 128000,
    cost: { input: 1.75, output: 14.0, cacheRead: 0, cacheWrite: 0 },
  },
  "gemini-3.1-pro": {
    name: "Gemini 3.1 Pro",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 2.0, output: 12.0, cacheRead: 0, cacheWrite: 0 },
  },
  "gpt-5.4": {
    name: "GPT-5.4",
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1050000,
    maxTokens: 128000,
    cost: { input: 2.5, output: 15.0, cacheRead: 0, cacheWrite: 0 },
  },
  "gpt-5.5": {
    name: "GPT-5.5",
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1050000,
    maxTokens: 128000,
    cost: { input: 2.5, output: 15.0, cacheRead: 0, cacheWrite: 0 },
  },
  "claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 64000,
    cost: { input: 3.0, output: 15.0, cacheRead: 0, cacheWrite: 0 },
  },
  "claude-opus-4-6": {
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 128000,
    cost: { input: 5.0, output: 25.0, cacheRead: 0, cacheWrite: 0 },
  },
  "claude-opus-4-7": {
    name: "Claude Opus 4.7",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 128000,
    cost: { input: 5.0, output: 25.0, cacheRead: 0, cacheWrite: 0 },
  },
  "all-proxy-models": {
    name: "All Proxy Models (fallback)",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
};

async function fetchModels(input: { provider: string; update_json: boolean }) {
  const apiKey = process.env.LITELLM_API_KEY || process.env.FERN_API_KEY || null;
  if (!apiKey) {
    return {
      success: false as const,
      models: [] as { id: string; name?: string; contextWindow?: number; maxTokens?: number; inputCost?: number; outputCost?: number; reasoning?: boolean }[],
      error: "No API key found. Set LITELLM_API_KEY or FERN_API_KEY environment variable.",
    };
  }

  try {
    const response = await fetch(`${FERN_BASE_URL}/models`, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return {
        success: false as const,
        models: [] as { id: string; name?: string; contextWindow?: number; maxTokens?: number; inputCost?: number; outputCost?: number; reasoning?: boolean }[],
        error: `API error: ${response.status} ${response.statusText}`,
      };
    }

    const data = await response.json() as { data?: FernModel[] };
    const models = data.data || [];

    // Merge with known model info and sort by input cost
    const enrichedModels = models
      .map((m: FernModel) => {
        const known = KNOWN_MODELS[m.id] || {};
        return {
          id: m.id,
          name: known.name || m.id,
          contextWindow: known.contextWindow,
          maxTokens: known.maxTokens,
          inputCost: known.cost?.input,
          outputCost: known.cost?.output,
          reasoning: known.reasoning ?? false,
        };
      })
      .sort((a, b) => (a.inputCost ?? 999999) - (b.inputCost ?? 999999));

    // Update models.json if requested
    let updated = false;
    if (input.update_json && existsSync(MODELS_JSON_PATH)) {
      try {
        const existingJson = JSON.parse(readFileSync(MODELS_JSON_PATH, "utf8"));
        
        const newModels = enrichedModels.map(m => ({
          id: m.id,
          name: m.name,
          reasoning: m.reasoning,
          input: KNOWN_MODELS[m.id]?.input || ["text"],
          contextWindow: m.contextWindow || 128000,
          maxTokens: m.maxTokens || 16384,
          cost: {
            input: m.inputCost ?? 0,
            output: m.outputCost ?? 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          ...(KNOWN_MODELS[m.id]?.api ? { api: KNOWN_MODELS[m.id].api } : {}),
        }));

        existingJson.providers = existingJson.providers || {};
        existingJson.providers.fern = existingJson.providers.fern || {};
        existingJson.providers.fern.models = newModels;

        writeFileSync(MODELS_JSON_PATH, JSON.stringify(existingJson, null, 2));
        updated = true;
      } catch (err) {
        console.error("Failed to update models.json:", err);
      }
    }

    return {
      success: true as const,
      models: enrichedModels,
      updated,
    };

  } catch (err: any) {
    return {
      success: false as const,
      models: [] as { id: string; name?: string; contextWindow?: number; maxTokens?: number; inputCost?: number; outputCost?: number; reasoning?: boolean }[],
      error: `Error fetching models: ${err.message}`,
    };
  }
}

interface FernUserInfo {
  user_info: {
    user_id: string;
    user_email: string;
    max_budget: number;
    spend: number;
    budget_reset_at: string;
  };
  teams: Array<{
    team_id: string;
    team_alias: string;
    max_budget: number;
    spend: number;
    budget_reset_at: string;
    keys: Array<{
      key_alias: string;
      user_id: string;
      spend: number;
    }>;
    members_with_roles: Array<{
      user_id: string;
      user_email: string | null;
      role: string;
    }>;
  }>;
}

interface FernSpendLog {
  request_id: string;
  spend: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  startTime: string;
  model_group: string;
  model: string;
  user: string;
  metadata: {
    user_api_key_alias?: string;
    cost_breakdown?: {
      input_cost: number;
      output_cost: number;
      total_cost: number;
    };
  };
}

async function getClaudeAuthToken(): Promise<string | null> {
  const settingsPath = `${process.env.HOME || "/Users/jescobar"}/.claude/settings.json`;
  try {
    if (!existsSync(settingsPath)) return null;
    const content = readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(content);
    return settings.env?.ANTHROPIC_AUTH_TOKEN || null;
  } catch {
    return null;
  }
}

async function getSpendLogs(apiKey: string, userId?: string, limit: number = 1000): Promise<FernSpendLog[]> {
  try {
    const params = new URLSearchParams();
    if (userId) params.append("user_id", userId);
    params.append("limit", limit.toString());
    
    const response = await fetch(`https://fern.addi.com/spend/logs?${params.toString()}`, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.error(`[fern-tools] Failed to fetch spend logs: ${response.status} ${response.statusText}`);
      return [];
    }

    return await response.json() as FernSpendLog[];
  } catch (err: any) {
    console.error(`[fern-tools] Error fetching spend logs: ${err.message}`);
    return [];
  }
}

interface MonthlySpend {
  month: string;
  totalSpend: number;
  totalTokens: number;
  requests: number;
  byModel: Record<string, { spend: number; tokens: number; requests: number }>;
}

function aggregateByMonth(logs: FernSpendLog[]): MonthlySpend[] {
  const grouped: Record<string, MonthlySpend> = {};

  for (const log of logs) {
    const month = log.startTime?.substring(0, 7) || "unknown"; // YYYY-MM
    const model = log.model_group || log.model?.split("/").pop() || "unknown";
    
    if (!grouped[month]) {
      grouped[month] = {
        month,
        totalSpend: 0,
        totalTokens: 0,
        requests: 0,
        byModel: {},
      };
    }

    grouped[month].totalSpend += log.spend || 0;
    grouped[month].totalTokens += log.total_tokens || 0;
    grouped[month].requests += 1;

    if (!grouped[month].byModel[model]) {
      grouped[month].byModel[model] = { spend: 0, tokens: 0, requests: 0 };
    }
    grouped[month].byModel[model].spend += log.spend || 0;
    grouped[month].byModel[model].tokens += log.total_tokens || 0;
    grouped[month].byModel[model].requests += 1;
  }

  return Object.values(grouped).sort((a, b) => b.month.localeCompare(a.month));
}

function formatMonthlySpend(monthly: MonthlySpend[]): string {
  if (monthly.length === 0) return "";

  let output = "\n📈 MONTHLY SPEND BREAKDOWN\n";
  output += "══════════════════════════════════════════════════════════════════\n";

  for (const month of monthly) {
    output += `\n📅 ${month.month}\n`;
    output += `   Total: $${month.totalSpend.toFixed(2)} | ${month.requests.toLocaleString()} requests | ${month.totalTokens.toLocaleString()} tokens\n`;
    output += `   ───────────────────────────────────────────────────────────────\n`;

    // Sort models by spend (descending)
    const models = Object.entries(month.byModel)
      .sort((a, b) => b[1].spend - a[1].spend)
      .slice(0, 5); // Top 5 models

    for (const [model, data] of models) {
      const spendPct = month.totalSpend > 0 ? ((data.spend / month.totalSpend) * 100).toFixed(1) : "0";
      output += `   ${model.padEnd(20)} $${data.spend.toFixed(2).padStart(8)} (${spendPct}%) | ${data.requests.toLocaleString().padStart(5)} req\n`;
    }

    const otherModels = Object.keys(month.byModel).length - models.length;
    if (otherModels > 0) {
      output += `   ${`(+ ${otherModels} more models)`.padEnd(20)}\n`;
    }
  }

  return output;
}

async function getConsumption(input: { provider: string; model_id?: string }) {
  const apiKey = await getClaudeAuthToken();
  if (!apiKey) {
    // Fallback to environment variables
    const envKey = process.env.LITELLM_API_KEY || process.env.FERN_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
    if (envKey) {
      return getConsumptionWithKey(envKey, input);
    }
    return {
      success: false as const,
      consumption: [] as { model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost: { input: number; output: number; total: number } }[],
      monthlyBreakdown: [] as MonthlySpend[],
      totalCost: 0,
      error: "No API key found. Set LITELLM_API_KEY, FERN_API_KEY, ANTHROPIC_AUTH_TOKEN or configure ~/.claude/settings.json.",
    };
  }

  return getConsumptionWithKey(apiKey, input);
}

async function getConsumptionWithKey(apiKey: string, input: { provider: string; model_id?: string }) {
  try {
    // Fetch user info and spend logs in parallel
    const [userInfoResponse, logs] = await Promise.all([
      fetch("https://fern.addi.com/user/info", {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }),
      getSpendLogs(apiKey, undefined, 1000),
    ]);

    if (!userInfoResponse.ok) {
      return {
        success: false as const,
        consumption: [] as { model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost: { input: number; output: number; total: number } }[],
        monthlyBreakdown: [] as MonthlySpend[],
        totalCost: 0,
        error: `API error: ${userInfoResponse.status} ${userInfoResponse.statusText}`,
      };
    }

    const data = await userInfoResponse.json() as FernUserInfo;
    
    const team = data.teams[0];
    const userId = data.user_info.user_id;
    
    // Personal spend comes directly from user_info.spend
    const personalSpend = data.user_info.spend || 0;
    
    // Team spend comes from teams[0].spend
    const teamSpend = team?.spend || 0;
    const teamName = team?.team_alias || "Unknown";

    // Calculate personal key spend from team keys (for reference)
    const personalKeySpend = team?.keys
      ?.filter(k => k.user_id === userId)
      ?.reduce((sum, k) => sum + (k.spend || 0), 0) || 0;

    // Aggregate spend logs by month and model
    const monthlyBreakdown = aggregateByMonth(logs);

    // Calculate current month total from logs (for comparison with API spend)
    const currentMonth = new Date().toISOString().substring(0, 7);
    const currentMonthLogs = monthlyBreakdown.find(m => m.month === currentMonth);
    const currentMonthSpend = currentMonthLogs?.totalSpend || 0;

    return {
      success: true as const,
      userBudget: data.user_info.max_budget,
      userSpend: personalSpend,
      userKeySpend: personalKeySpend,
      userResetDate: data.user_info.budget_reset_at?.split("T")[0],
      teamName: teamName,
      teamBudget: team?.max_budget || 0,
      teamSpend: teamSpend,
      teamResetDate: team?.budget_reset_at?.split("T")[0],
      consumption: [] as { model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost: { input: number; output: number; total: number } }[],
      totalCost: personalSpend,
      currentMonthSpend,
      logTotalSpend: logs.reduce((sum, log) => sum + (log.spend || 0), 0),
      totalLogs: logs.length,
      monthlyBreakdown,
      teamMembers: team?.members_with_roles?.map(m => ({
        userId: m.user_id,
        email: m.user_email,
        role: m.role,
      })) || [],
      teamKeys: team?.keys?.map(k => ({
        alias: k.key_alias,
        userId: k.user_id,
        spend: k.spend,
      })) || [],
    };

  } catch (err: any) {
    return {
      success: false as const,
      consumption: [] as { model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost: { input: number; output: number; total: number } }[],
      monthlyBreakdown: [] as MonthlySpend[],
      totalCost: 0,
      error: `Error fetching consumption: ${err.message}`,
    };
  }
}

// Extension factory function
export default function registerFernTools(pi: ExtensionAPI) {
  console.log("[fern-tools] Registering Fern tools...");

  pi.registerTool({
    name: "fern_fetch_models",
    label: "Fetch Fern Models",
    description: "Fetch available models from the fern proxy API and optionally update models.json. Returns models sorted by input cost (lowest first).",
    promptSnippet: "Fetch and list available models from fern proxy",
    parameters: Type.Object({
      provider: Type.String({ description: "Provider to fetch models from (default: fern)" }),
      update_json: Type.Boolean({ description: "Update models.json with fetched models" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await fetchModels({
        provider: params.provider || "fern",
        update_json: params.update_json || false,
      });

      if (!result.success) {
        return {
          content: [{ type: "text", text: `Error: ${result.error}` }],
          details: result,
        };
      }

      const text = result.models
        .map(m => `| ${m.id} | ${m.name || '-'} | ${m.inputCost ?? '-'} | ${m.outputCost ?? '-'} | ${m.contextWindow ? Math.round(m.contextWindow/1000)+'k' : '-'} |`)
        .join('\n');

      return {
        content: [{
          type: "text",
          text: `| Model | Name | Input Cost | Output Cost | Context |\n|-------|------|------------|-------------|---------|\n${text}${result.updated ? '\n\nUpdated models.json' : ''}`,
        }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "fern_get_consumption",
    label: "Get Fern Consumption",
    description: "Get consumption/cost data by model from the fern proxy. Shows token usage and costs per model.",
    promptSnippet: "Get consumption and costs by model",
    parameters: Type.Object({
      model_id: Type.Optional(Type.String({ description: "Filter by specific model ID" })),
      provider: Type.String({ description: "Provider to check consumption for (default: fern)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await getConsumption({
        provider: params.provider || "fern",
        model_id: params.model_id,
      });

      if (!result.success) {
        return {
          content: [{ type: "text", text: `Error: ${result.error}` }],
          details: result,
        };
      }

      const userUsagePct = result.userBudget ? ((result.userSpend / result.userBudget) * 100).toFixed(1) : '0';
      const teamUsagePct = result.teamBudget ? ((result.teamSpend / result.teamBudget) * 100).toFixed(1) : '0';

      // Build team members spend table
      let membersTable = '';
      if (result.teamKeys && result.teamKeys.length > 0) {
        const memberRows = result.teamKeys
          .map(k => {
            const member = result.teamMembers?.find(m => m.userId === k.userId);
            const email = member?.email || k.alias || 'Unknown';
            const role = member?.role || '-';
            return `  ${email.padEnd(20)} ${role.padEnd(10)} $${k.spend.toFixed(2).padStart(10)}`;
          })
          .join('\n');
        if (memberRows) {
          membersTable = `\n  Members Breakdown:\n${memberRows}`;
        }
      }

      // Format monthly breakdown
      const monthlyOutput = formatMonthlySpend(result.monthlyBreakdown || []);

      // Add summary note about log coverage
      const logSummary = result.totalLogs > 0 
        ? `\n📋 Based on last ${result.totalLogs.toLocaleString()} requests totaling $${(result.logTotalSpend || 0).toFixed(2)}\n`
        : '';

      const output = `
📊 MONTHLY USAGE (Personal)
──────────────────────────────────────────────────────────────────
Budget:          $${result.userBudget?.toFixed(2) ?? 'N/A'}
Spent:           $${result.userSpend?.toFixed(2) ?? 'N/A'}
Key Spend:       $${result.userKeySpend?.toFixed(2) ?? 'N/A'}
Usage %:         ${userUsagePct}%
Reset Date:      ${result.userResetDate ?? 'N/A'}

👥 TEAM USAGE (${result.teamName})
──────────────────────────────────────────────────────────────────
Budget:          $${result.teamBudget?.toFixed(2) ?? 'N/A'}
Spent:           $${result.teamSpend?.toFixed(2) ?? 'N/A'}
Usage %:         ${teamUsagePct}%
Reset Date:      ${result.teamResetDate ?? 'N/A'}${membersTable}${monthlyOutput}${logSummary}
`;

      return {
        content: [{ type: "text", text: output }],
        details: result,
      };
    },
  });

  console.log("[fern-tools] Fern tools registered successfully");
  
  // Log available tools
  const allTools = pi.getAllTools();
  const fernTools = allTools.filter((t) => t.name.startsWith("fern_")).map((t) => t.name);
  console.log(`[fern-tools] Registered tools: ${fernTools.join(", ") || "none"}`);
}
