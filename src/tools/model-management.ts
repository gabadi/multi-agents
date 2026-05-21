#!/usr/bin/env npx tsx
/**
 * Model Management Tools
 * 
 * Tools for fetching available models from the fern proxy and tracking consumption.
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { z } from "zod";

const FERN_BASE_URL = "https://fern.addi.com/v1";
const MODELS_JSON_PATH = `${process.env.HOME || "/Users/jescobar"}/.pi/agent/models.json`;

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const FetchModelsInputSchema = z.object({
  provider: z.string().default("fern").describe("Provider to fetch models from (default: fern)"),
  update_json: z.boolean().default(false).describe("Update models.json with fetched models"),
});

export type FetchModelsInput = z.infer<typeof FetchModelsInputSchema>;

export const FetchModelsOutputSchema = z.object({
  success: z.boolean(),
  models: z.array(z.object({
    id: z.string(),
    name: z.string().optional(),
    contextWindow: z.number().optional(),
    maxTokens: z.number().optional(),
    inputCost: z.number().optional(),
    outputCost: z.number().optional(),
    reasoning: z.boolean().optional(),
  })),
  updated: z.boolean().optional(),
  error: z.string().optional(),
});

export type FetchModelsOutput = z.infer<typeof FetchModelsOutputSchema>;

export const GetConsumptionInputSchema = z.object({
  model_id: z.string().optional().describe("Filter by specific model ID"),
  provider: z.string().default("fern").describe("Provider to check consumption for"),
});

export type GetConsumptionInput = z.infer<typeof GetConsumptionInputSchema>;

export const GetConsumptionOutputSchema = z.object({
  success: z.boolean(),
  consumption: z.array(z.object({
    model: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
    cost: z.object({
      input: z.number(),
      output: z.number(),
      total: z.number(),
    }),
  })),
  totalCost: z.number(),
  error: z.string().optional(),
});

export type GetConsumptionOutput = z.infer<typeof GetConsumptionOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function getApiKey(): string | null {
  // Try common env vars
  return process.env.LITELLM_API_KEY || 
         process.env.FERN_API_KEY || 
         process.env.OPENAI_API_KEY ||
         null;
}

interface FernModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface PricingInfo {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost: PricingInfo;
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

// ─────────────────────────────────────────────────────────────────────────────
// Fetch Models Tool
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchModels(input: FetchModelsInput): Promise<FetchModelsOutput> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      success: false,
      models: [],
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
        success: false,
        models: [],
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
          ...known,
        };
      })
      .sort((a, b) => (a.inputCost ?? 999999) - (b.inputCost ?? 999999));

    // Update models.json if requested
    let updated = false;
    if (input.update_json && existsSync(MODELS_JSON_PATH)) {
      try {
        const existingJson = JSON.parse(readFileSync(MODELS_JSON_PATH, "utf8"));
        
        // Update models array while preserving other settings
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
      success: true,
      models: enrichedModels,
      updated,
    };

  } catch (err: any) {
    return {
      success: false,
      models: [],
      error: `Error fetching models: ${err.message}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Get Consumption Tool
// ─────────────────────────────────────────────────────────────────────────────

interface UsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    total: number;
  };
}

export async function getConsumption(input: GetConsumptionInput): Promise<GetConsumptionOutput> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      success: false,
      consumption: [],
      totalCost: 0,
      error: "No API key found. Set LITELLM_API_KEY or FERN_API_KEY environment variable.",
    };
  }

  try {
    // Load models.json for pricing info
    let modelPricing: Record<string, { input: number; output: number }> = {};
    try {
      if (existsSync(MODELS_JSON_PATH)) {
        const modelsJson = JSON.parse(readFileSync(MODELS_JSON_PATH, "utf8"));
        const models = modelsJson.providers?.fern?.models || [];
        for (const m of models) {
          modelPricing[m.id] = {
            input: m.cost?.input ?? 0,
            output: m.cost?.output ?? 0,
          };
        }
      }
    } catch {
      // Ignore errors reading models.json
    }

    // For now, return a placeholder since we don't have a direct API for consumption
    // In a real implementation, this would query a usage API or parse logs
    return {
      success: true,
      consumption: [],
      totalCost: 0,
      error: "Consumption tracking not yet implemented via API. Check logs or dashboard for usage.",
    };

  } catch (err: any) {
    return {
      success: false,
      consumption: [],
      totalCost: 0,
      error: `Error getting consumption: ${err.message}`,
    };
  }
}


