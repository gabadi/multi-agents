import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getChatSession,
  handleTelegramCommand,
  processTelegramMessage,
  resetTelegramBridgeStateForTests,
  tgSendMessage,
  type AgentInfo,
} from "./telegram-bridge.js";

type FetchCall = {
  url: string;
  body: Record<string, unknown>;
};

describe("telegram bridge routing", () => {
  let baseDir = "";
  let fetchCalls: FetchCall[] = [];
  let nextMessageId = 1000;
  const originalFetch = globalThis.fetch;
  const originalFabricDir = process.env.FABRIC_DIR;
  const originalFernApiKey = process.env.FERN_API_KEY;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

  const activeCoordinators: AgentInfo[] = [
    { agent_id: "boss", role: "coordinator", fabric_status: "idle", current_task: null },
    { agent_id: "sub-boss-36", role: "sub-coordinator", fabric_status: "idle", current_task: "36" },
  ];

  beforeEach(() => {
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
    baseDir = mkdtempSync(join(tmpdir(), "cmd-center-telegram-bridge-"));
    mkdirSync(join(baseDir, "mailboxes"), { recursive: true });
    mkdirSync(join(baseDir, "pids"), { recursive: true });

    process.env.FABRIC_DIR = baseDir;
    process.env.FERN_API_KEY = "";
    process.env.OPENAI_API_KEY = "";
    resetTelegramBridgeStateForTests();

    fetchCalls = [];
    nextMessageId = 1000;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      fetchCalls.push({ url, body });

      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: nextMessageId++,
          chat: { id: Number(body.chat_id) || 0 },
          date: 1778200000,
          text: String(body.text || ""),
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalFabricDir == null) delete process.env.FABRIC_DIR;
    else process.env.FABRIC_DIR = originalFabricDir;
    if (originalFernApiKey == null) delete process.env.FERN_API_KEY;
    else process.env.FERN_API_KEY = originalFernApiKey;
    if (originalOpenAiApiKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    resetTelegramBridgeStateForTests();
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
    baseDir = "";
  });

  test("/switch persists selected coordinator and /who stays consistent after reload", async () => {
    const switchResult = await handleTelegramCommand(
      "test-token",
      5675614752,
      "/switch sub-boss-36",
      10,
      999,
      activeCoordinators.map((a) => ({
        agent_id: a.agent_id,
        role: a.role as "coordinator" | "sub-coordinator",
        fabric_status: a.fabric_status,
        current_task: a.current_task,
      }))
    );

    assert.strictEqual(switchResult, "handled");
    assert.strictEqual(getChatSession(5675614752, 999).activeCoordinatorId, "sub-boss-36");
    assert.strictEqual(fetchCalls.at(-1)?.body.text, "Routing switched to: sub-boss-36");

    resetTelegramBridgeStateForTests();
    const persisted = getChatSession(5675614752, 999);
    assert.strictEqual(persisted.activeCoordinatorId, "sub-boss-36");

    const whoResult = await handleTelegramCommand(
      "test-token",
      5675614752,
      "/who",
      11,
      999,
      activeCoordinators.map((a) => ({
        agent_id: a.agent_id,
        role: a.role as "coordinator" | "sub-coordinator",
        fabric_status: a.fabric_status,
        current_task: a.current_task,
      }))
    );

    assert.strictEqual(whoResult, "handled");
    assert.strictEqual(fetchCalls.at(-1)?.body.text, "Current coordinator: sub-boss-36");
  });

  test("next message after /switch routes to selected coordinator instead of default boss", async () => {
    await handleTelegramCommand(
      "test-token",
      5675614752,
      "/switch sub-boss-36",
      20,
      999,
      activeCoordinators.map((a) => ({
        agent_id: a.agent_id,
        role: a.role as "coordinator" | "sub-coordinator",
        fabric_status: a.fabric_status,
        current_task: a.current_task,
      }))
    );

    resetTelegramBridgeStateForTests();

    const result = await processTelegramMessage(
      "test-token",
      5675614752,
      "continue with the task plan",
      21,
      999,
      activeCoordinators,
      [],
      "boss"
    );

    assert.deepStrictEqual(result, {
      handled: true,
      action: "router_queued",
      target: "sub-boss-36",
    });

    const subMailboxPath = join(baseDir, "mailboxes", "sub-boss-36.jsonl");
    const bossMailboxPath = join(baseDir, "mailboxes", "boss.jsonl");

    assert.ok(existsSync(subMailboxPath), "selected coordinator mailbox should exist");
    const subMessages = readFileSync(subMailboxPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.strictEqual(subMessages.length, 1);
    assert.strictEqual(subMessages[0].to, "sub-boss-36");
    assert.strictEqual(subMessages[0].type, "telegram_user_message");
    assert.strictEqual(subMessages[0].payload.routing.target_coordinator_id, "sub-boss-36");

    const bossMailboxContents = existsSync(bossMailboxPath) ? readFileSync(bossMailboxPath, "utf8").trim() : "";
    assert.strictEqual(bossMailboxContents, "", "default coordinator should not receive the post-switch message");
    assert.ok(
      fetchCalls.some((call) => String(call.body.text || "").includes("queued for sub-boss-36")),
      "router_queued confirmation should mention the selected coordinator"
    );
  });

  test("tgSendMessage posts to Telegram chat and returns Telegram metadata", async () => {
    const result = await tgSendMessage("test-token", 5675614752, "hello from test", {
      replyTo: 33,
      parseMode: "Markdown",
    });

    assert.strictEqual(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].url.includes("/sendMessage"));
    assert.deepStrictEqual(fetchCalls[0].body, {
      chat_id: 5675614752,
      text: "hello from test",
      parse_mode: "Markdown",
      reply_to_message_id: 33,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.chatId, 5675614752);
    assert.strictEqual(result.messageId, 1000);
  });
});
