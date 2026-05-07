import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillProfile {
  name: string;
  description: string;
  model: string;
  tools: string[];
  thinking: "low" | "medium" | "high";
  mode: "interactive" | "rpc";
  systemPrompt: string;
  skillPath: string;
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { body: content };
  }

  const frontmatter = match[1];
  const body = match[2].trim();
  const result: Record<string, unknown> = { body };

  for (const line of frontmatter.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();

    if (!rawValue) continue;

    // Strip quotes
    const value = rawValue.replace(/^"|"$/g, "").replace(/^'|'$/g, "");

    if (value.startsWith("[") && value.endsWith("]")) {
      result[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (value === "true") {
      result[key] = true;
    } else if (value === "false") {
      result[key] = false;
    } else if (!isNaN(Number(value)) && value !== "") {
      result[key] = Number(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

function findSkillsDir(): string | null {
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), "../../skills"),
    resolve(process.cwd(), "skills"),
  ];
  for (const p of candidates) {
    if (existsSync(p) && statSync(p).isDirectory()) return p;
  }
  return null;
}

export function loadProfileFromSkill(role: string): SkillProfile {
  const skillsDir = findSkillsDir();
  if (!skillsDir) {
    throw new Error(
      `Skills directory not found. Searched: ${resolve(dirname(fileURLToPath(import.meta.url)), "../../skills")}, ${resolve(process.cwd(), "skills")}`
    );
  }

  const skillPath = resolve(skillsDir, role);
  const skillFile = resolve(skillPath, "SKILL.md");

  if (!existsSync(skillFile)) {
    throw new Error(
      `Skill not found for role '${role}'. Expected: ${skillFile}\n` +
        `Available roles: ${listAvailableRoles(skillsDir).join(", ")}`
    );
  }

  const content = readFileSync(skillFile, "utf8");
  const fm = parseFrontmatter(content);

  // Required fields
  const required = ["model", "tools", "thinking"];
  const missing = required.filter((k) => fm[k] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Skill '${role}': missing required frontmatter fields: ${missing.join(", ")}`
    );
  }

  const tools = Array.isArray(fm.tools)
    ? fm.tools.map(String)
    : String(fm.tools)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

  const validModes = ["interactive", "rpc"];
  const mode = String(fm.mode ?? "rpc");
  if (!validModes.includes(mode)) {
    throw new Error(
      `Skill '${role}': invalid mode '${mode}'. Must be one of: ${validModes.join(", ")}`
    );
  }

  const validThinking = ["low", "medium", "high"];
  const thinking = String(fm.thinking ?? "medium");
  if (!validThinking.includes(thinking)) {
    throw new Error(
      `Skill '${role}': invalid thinking '${thinking}'. Must be one of: ${validThinking.join(", ")}`
    );
  }

  // Build a MINIMAL but PRECISE system prompt. The full skill manual is loaded via --skill
  // only when needed. The system prompt is sent on EVERY API call — keep it under 300 chars.
  const modeInstructions =
    mode === "rpc"
      ? "Headless machine agent. Mailbox/tool driven. Inter-agent output must be compact English, not human-facing prose."
      : "Interactive agent. Use human chat when needed; keep inter-agent mailbox traffic compact English.";

  const systemPrompt =
    `You are ${String(fm.name || role)}. ` +
    `${String(fm.description || "").slice(0, 100)}. ` +
    `Mode: ${mode}. ${modeInstructions} Choose tools from context. Tools: ${tools.join(", ")}.`;

  return {
    name: String(fm.name || role),
    description: String(fm.description || ""),
    model: String(fm.model),
    tools,
    thinking: thinking as "low" | "medium" | "high",
    mode: mode as "interactive" | "rpc",
    systemPrompt,
    skillPath,
  };
}

export function listAvailableRoles(skillsDir?: string): string[] {
  const dir =
    skillsDir ??
    findSkillsDir() ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../../skills");
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => {
      const sub = resolve(dir, name);
      return statSync(sub).isDirectory() && existsSync(resolve(sub, "SKILL.md"));
    })
    .sort();
}

export function getSkillPath(role: string): string | null {
  const skillsDir = findSkillsDir();
  if (!skillsDir) return null;
  const p = resolve(skillsDir, role);
  return existsSync(resolve(p, "SKILL.md")) ? p : null;
}
