import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readSync, fstatSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface RuntimeEvent {
  event_id: string;
  type: string;
  agent_id: string;
  payload: Record<string, unknown>;
  ts: string;
}

export function appendRuntimeEvent(eventsPath: string, event: Omit<RuntimeEvent, "event_id" | "ts"> & Partial<Pick<RuntimeEvent, "event_id" | "ts">>): RuntimeEvent {
  const parent = dirname(eventsPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const fullEvent: RuntimeEvent = {
    event_id: event.event_id ?? `rte-${randomUUID()}`,
    ts: event.ts ?? new Date().toISOString(),
    type: event.type,
    agent_id: event.agent_id,
    payload: event.payload ?? {},
  };
  appendFileSync(eventsPath, JSON.stringify(fullEvent) + "\n");
  return fullEvent;
}

export function readRuntimeEventsSince(eventsPath: string, offset: number): { events: RuntimeEvent[]; nextOffset: number } {
  if (!existsSync(eventsPath)) {
    return { events: [], nextOffset: offset };
  }

  const fd = openSync(eventsPath, "r");
  try {
    const stats = fstatSync(fd);
    const safeOffset = Math.min(offset, stats.size);
    const bytesToRead = stats.size - safeOffset;
    if (bytesToRead <= 0) {
      return { events: [], nextOffset: stats.size };
    }

    const buffer = Buffer.alloc(bytesToRead);
    readSync(fd, buffer, 0, bytesToRead, safeOffset);
    const lines = buffer.toString("utf8").split("\n").filter(Boolean);
    const events: RuntimeEvent[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as RuntimeEvent);
      } catch {
        // ignore invalid line
      }
    }
    return { events, nextOffset: stats.size };
  } finally {
    closeSync(fd);
  }
}
