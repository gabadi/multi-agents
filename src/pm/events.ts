/**
 * pm-events.ts — Project Management event logger
 * Append-only JSONL for real-time monitor consumption.
 */

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const FABRIC_DIR = "/tmp/fabric-agents";
const PROJECTS_EVENT_LOG = join(FABRIC_DIR, "projects.jsonl");

export interface ProjectEvent {
  event_id?: string;
  type: string;
  entity_type: "project" | "task" | "subtask";
  entity_id: number;
  payload: Record<string, unknown>;
  actor?: string;
  ts?: string;
}

export function appendProjectEvent(event: ProjectEvent): void {
  try {
    if (!existsSync(FABRIC_DIR)) {
      mkdirSync(FABRIC_DIR, { recursive: true });
    }

    const logEntry: Record<string, unknown> = {
      ...event,
      event_id: event.event_id || randomUUID(),
      ts: event.ts || new Date().toISOString(),
    };

    appendFileSync(PROJECTS_EVENT_LOG, JSON.stringify(logEntry) + "\n", "utf8");
  } catch (err) {
    console.error("[pm-events] Failed to append project event:", err);
  }
}
