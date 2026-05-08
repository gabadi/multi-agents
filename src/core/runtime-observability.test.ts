import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openFabricDb, ensureRegistrySchema } from "./sqlite-utils.js";
import {
  refreshAgentRuntimeRegistration,
  buildRuntimeSnapshot,
  buildRuntimeLogSnapshot,
} from "./runtime-observability.js";

test("refreshAgentRuntimeRegistration writes runtime artifacts and upserts registry", () => {
  const fabricDir = mkdtempSync(join(tmpdir(), "cmd-center-runtime-observability-"));

  try {
    const result = refreshAgentRuntimeRegistration({
      fabricDir,
      agentId: "dev-1",
      role: "dev",
      paneId: "%12",
      session: "fabric-default",
      pid: process.pid,
      model: "fern/test",
      status: "active",
      fabricStatus: "idle",
      currentTask: "Task 39 runtime refresh",
      pendingCorrelations: ["corr-1"],
      lastError: null,
      isStreaming: false,
      isThinking: true,
      activeTool: "fabric_refresh_runtime",
      queueLength: 2,
      ensureStateFile: true,
      state: {
        lastOffset: 11,
        lastProcessed: 22,
        pendingCorrelations: ["corr-1"],
        lastFabricStatus: "idle",
      },
    });

    assert.equal(existsSync(result.registry_db_path), true);
    assert.equal(existsSync(result.mailbox_path), true);
    assert.equal(readFileSync(result.pid_path, "utf8").trim(), String(process.pid));

    const state = JSON.parse(readFileSync(result.state_path, "utf8"));
    assert.equal(state.lastOffset, 11);
    assert.deepEqual(state.pendingCorrelations, ["corr-1"]);

    const db = openFabricDb(result.registry_db_path);
    try {
      ensureRegistrySchema(db);
      const row = db.prepare("SELECT agent_id, role, fabric_status, current_task, queue_length FROM agents WHERE agent_id = ?").get("dev-1") as Record<string, unknown>;
      assert.equal(row.agent_id, "dev-1");
      assert.equal(row.role, "dev");
      assert.equal(row.fabric_status, "idle");
      assert.equal(row.current_task, "Task 39 runtime refresh");
      assert.equal(row.queue_length, 2);
    } finally {
      db.close();
    }

    const runtimeEvents = readFileSync(result.runtime_events_path, "utf8");
    assert.match(runtimeEvents, /agent\.runtime_refreshed/);
    assert.match(runtimeEvents, /dev-1/);
  } finally {
    rmSync(fabricDir, { recursive: true, force: true });
  }
});

test("buildRuntimeSnapshot and buildRuntimeLogSnapshot return deterministic registry and log handles", () => {
  const fabricDir = mkdtempSync(join(tmpdir(), "cmd-center-runtime-observability-"));

  try {
    const db = openFabricDb(join(fabricDir, "registry.sqlite"));
    try {
      ensureRegistrySchema(db);
      db.prepare(
        `INSERT INTO agents (
          agent_id, role, pane_id, session, pid, model, status, fabric_status,
          current_task, pending_correlations, last_error, is_streaming, is_thinking,
          active_tool, queue_length
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "boss",
        "coordinator",
        "%1",
        "fabric-default",
        process.pid,
        "fern/test",
        "active",
        "idle",
        "Task 39",
        JSON.stringify(["corr-a"]),
        null,
        0,
        1,
        "fabric_get_runtime_snapshot",
        1,
      );
    } finally {
      db.close();
    }

    mkdirSync(join(fabricDir, "mailboxes"), { recursive: true });
    mkdirSync(join(fabricDir, "outputs"), { recursive: true });
    mkdirSync(join(fabricDir, "state"), { recursive: true });
    mkdirSync(join(fabricDir, "pids"), { recursive: true });

    writeFileSync(join(fabricDir, "mailboxes", "boss.jsonl"), [
      JSON.stringify({ from: "dev-1", to: "boss", type: "response", payload: { status: "done" }, timestamp: "2026-05-08T00:00:00.000Z" }),
      JSON.stringify({ from: "reviewer-1", to: "boss", type: "message", payload: { note: "queued" }, timestamp: "2026-05-08T00:00:01.000Z" }),
      "",
    ].join("\n"));
    writeFileSync(join(fabricDir, "outputs", "boss.jsonl"), [
      JSON.stringify({ timestamp: "2026-05-08T00:01:00.000Z", content: "First output", model: "fern/test", stopReason: "end_turn", isError: false }),
      JSON.stringify({ timestamp: "2026-05-08T00:02:00.000Z", content: "Second output", model: "fern/test", stopReason: "end_turn", isError: false }),
      "",
    ].join("\n"));
    writeFileSync(join(fabricDir, "state", "boss.json"), JSON.stringify({
      lastOffset: 10,
      lastProcessed: 20,
      pendingCorrelations: ["corr-a"],
      lastFabricStatus: "idle",
    }));
    writeFileSync(join(fabricDir, "pids", "boss.pid"), String(process.pid));
    writeFileSync(join(fabricDir, "runtime-events.jsonl"), [
      JSON.stringify({ event_id: "evt-1", type: "agent.registered", agent_id: "boss", payload: { role: "coordinator" }, ts: "2026-05-08T00:00:00.000Z" }),
      JSON.stringify({ event_id: "evt-2", type: "agent.runtime_refreshed", agent_id: "boss", payload: { fabric_status: "idle" }, ts: "2026-05-08T00:03:00.000Z" }),
      "",
    ].join("\n"));
    writeFileSync(join(fabricDir, "monitor.log"), "line 1\nline 2\nline 3\n");

    const snapshot = buildRuntimeSnapshot({
      fabricDir,
      agentIds: ["boss"],
      includeRecentEvents: true,
      recentEventLimit: 5,
    });

    assert.equal(snapshot.summary.selected_agents, 1);
    assert.equal(snapshot.summary.alive_agents, 1);
    assert.equal(snapshot.summary.queued_agents, 1);
    assert.equal(snapshot.agents[0].agent_id, "boss");
    assert.equal(snapshot.agents[0].mailbox.exists, true);
    assert.equal(snapshot.agents[0].output_log.exists, true);
    assert.equal(snapshot.recent_runtime_events.length, 2);
    assert.equal(snapshot.warnings.length, 0);

    const logSnapshot = buildRuntimeLogSnapshot({
      fabricDir,
      agentIds: ["boss"],
      sources: ["output", "mailbox", "runtime_events", "monitor"],
      lineLimit: 2,
    });

    assert.equal(logSnapshot.handles.length, 4);
    const outputHandle = logSnapshot.handles.find((handle) => handle.handle_id === "output:boss") as Record<string, any>;
    const mailboxHandle = logSnapshot.handles.find((handle) => handle.handle_id === "mailbox:boss") as Record<string, any>;
    const runtimeHandle = logSnapshot.handles.find((handle) => handle.handle_id === "runtime_events:boss") as Record<string, any>;
    const monitorHandle = logSnapshot.handles.find((handle) => handle.handle_id === "monitor:global") as Record<string, any>;

    assert.equal(outputHandle.exists, true);
    assert.equal(outputHandle.preview.length, 2);
    assert.equal(mailboxHandle.preview.length, 2);
    assert.equal(runtimeHandle.preview.length, 2);
    assert.deepEqual(monitorHandle.preview, ["line 2", "line 3"]);
  } finally {
    rmSync(fabricDir, { recursive: true, force: true });
  }
});
