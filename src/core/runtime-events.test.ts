import { test, describe, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendRuntimeEvent, readRuntimeEventsSince } from "./runtime-events.js";

describe("runtime events", () => {
  let baseDir = "";
  let eventsPath = "";

  beforeEach(() => {
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
    baseDir = mkdtempSync(join(tmpdir(), "cmd-center-runtime-events-"));
    eventsPath = join(baseDir, "runtime-events.jsonl");
  });

  test("appends and reads events incrementally", () => {
    appendRuntimeEvent(eventsPath, {
      type: "agent.registered",
      agent_id: "boss",
      payload: { role: "coordinator" },
    });
    appendRuntimeEvent(eventsPath, {
      type: "agent.heartbeat",
      agent_id: "boss",
      payload: { status: "active" },
    });

    const firstRead = readRuntimeEventsSince(eventsPath, 0);
    assert.strictEqual(firstRead.events.length, 2);
    assert.strictEqual(firstRead.events[0].type, "agent.registered");
    assert.strictEqual(firstRead.events[1].type, "agent.heartbeat");

    const secondRead = readRuntimeEventsSince(eventsPath, firstRead.nextOffset);
    assert.strictEqual(secondRead.events.length, 0);
  });
});
