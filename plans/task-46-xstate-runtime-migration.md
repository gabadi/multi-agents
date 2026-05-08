# Task 46 — XState runtime migration investigation

## Scope

Investigate whether cmd-center-v2 should migrate its current Fabric runtime/communication model toward XState, using the current repository runtime and the Stately XState repository as reference.

External reference audited:
- `statelyai/xstate` commit `37a967a87660714f7e240d3508e6038e8ea30aa9` (2026-05-07)
- `xstate` package `5.31.0`
- `@xstate/store` package `3.17.5`

## Executive recommendation

Recommended direction: adopt a **hybrid XState runtime**, not a transport rewrite.

- Keep **tmux + separate pi processes** as the process model.
- Keep **mailbox JSONL + SIGUSR1** as the cross-process transport in the first migration.
- Introduce **XState/@xstate/store as the source of truth for runtime state and orchestration state**.
- Use XState **inspection events** as the new observability spine.
- Only evaluate replacing mailbox/SIGUSR1 after the runtime state model is already XState-backed and stable.

Reason: XState is an excellent fit for lifecycle/state/orchestration, but it is **not itself a cross-process transport**. The current Fabric mesh is distributed across tmux-hosted OS processes, while XState actor systems are in-process by default.

## 1. Current cmd-center-v2 architecture audit

### 1.1 Message transport: mailbox JSONL + SIGUSR1

Current send path in `src/core/extension.ts`:
- `sendMessage()` appends a JSON line to the target mailbox file and then sends `SIGUSR1` to the target PID if present (`src/core/extension.ts:1044-1064`).
- Each agent mailbox lives at `/tmp/fabric-agents/mailboxes/{agent-id}.jsonl` (`src/core/extension.ts:473-482`).
- The agent `SIGUSR1` handler checks mailbox growth relative to `state.lastOffset` and triggers inbox processing (`src/core/extension.ts:1956-1983`).
- Actual inbox processing re-reads the mailbox from the last persisted offset, parses JSONL lines, handles messages, then persists the new offset (`src/core/extension.ts:1071-1123`, `728-747`).

Implication for migration:
- Today, delivery semantics are transport-first: file append is the durable event log, `SIGUSR1` is the wakeup, and `state.lastOffset` is the consumer cursor.
- Any XState migration must either:
  1. keep this transport and wrap it as an actor/adapter, or
  2. replace all three pieces together: event log, wakeup, and cursoring.

### 1.2 Runtime status and registry state

Current runtime state is split across multiple primitives:

1. In-memory extension globals:
- `currentFabricStatus`
- `pendingCorrelations`
- `queuedCount`
- `isStreaming`
- `isThinking`
- `activeToolName`
- `lastKnownRuntimeTask`
- `lastKnownRuntimeError`

2. Per-agent state JSON file:
- `lastOffset`
- `lastProcessed`
- `pendingCorrelations`
- `lastFabricStatus`
- persisted in `src/core/extension.ts:728-747`

3. PID file:
- written on register/heartbeat (`src/core/extension.ts:951`, `971-972`)

4. Runtime event log:
- extension emits runtime registry/status events to `runtime-events.jsonl` (`src/core/extension.ts:449-470`, `884-909`, `944-964`)

5. SQLite registry:
- `refreshAgentRuntimeRegistration()` rewrites mailbox/pid/state handles and upserts the `agents` row in `registry.sqlite`, then emits `agent.runtime_refreshed` (`src/core/runtime-observability.ts:358-516`)

Implication for migration:
- Current state is **not owned by a single model**; it is reconstructed from globals + files + events + SQLite.
- XState can improve this by making one actor/store snapshot the authoritative runtime state and deriving files/DB rows from that snapshot.

### 1.3 Launcher / lifecycle orchestration

Current lifecycle orchestration is external-process oriented:
- Launcher creates tmux panes and sets Fabric env vars (`src/core/launcher.ts:344-368`, `384-410`).
- Launcher emits `agent.launching` runtime event (`src/core/launcher.ts:472-484`).
- Launcher precreates mailbox/state artifacts (`src/core/launcher.ts:486-487`).
- Launcher waits for an alive ACK by tailing the parent mailbox for a `healthcheck` message with `status=alive` (`src/core/launcher.ts:204-227`, `493-540`).
- Extension sends the alive ACK during `session_start` (`src/core/extension.ts:1662-1697`).

Implication for migration:
- The launch handshake is already a state machine in practice (`launching -> waiting_ack -> ready|failed`), but it is encoded as procedural code.
- This is a strong candidate for an explicit XState machine.

### 1.4 Monitor / observability pipeline

Current monitor is a second reconstruction layer:
- It drains `runtime-events.jsonl` and upserts registry rows for a defined set of event types (`src/core/monitor.ts:701-827`).
- It loads agents from `agents` SQLite rows and computes derived fields like mailbox pending bytes (`src/core/monitor.ts:846-950`).
- It watches filesystem changes under `/tmp/fabric-agents` and refreshes outputs/state-driven SSE (`src/core/monitor.ts:2764-2840`).
- It uses polling fallback for outputs and periodic DB/runtime reconciliation (`src/core/monitor.ts:3007-3026`).
- It runs a watchdog to recover PIDs from tmux panes, mark agents offline, purge stale non-coordinator agents, and emit blocked/offline updates (`src/core/monitor.ts:1277-1509`).
- The monitor itself also participates in mailbox+SIGUSR1 for Telegram responses (`src/core/monitor.ts:491-630`, `3106-3115`).

Implication for migration:
- The monitor is doing both **event ingestion** and **state machine inference** today.
- XState could absorb the inference layer and make watchdog/blocked/offline logic first-class states and transitions instead of timer-driven heuristics.

### 1.5 Agent output and deterministic runtime snapshots

Current observability also depends on output files and runtime snapshot tooling:
- Assistant output is appended to per-agent JSONL output logs (`src/core/extension.ts:834-856`).
- `buildRuntimeSnapshot()` reads registry rows plus mailbox/state/output handles and previews (`src/core/runtime-observability.ts:542-640`).
- `buildRuntimeLogSnapshot()` materializes deterministic handles for output, mailbox, runtime events, and monitor log (`src/core/runtime-observability.ts:668-760`).

Implication for migration:
- Any XState observability migration must preserve current operational affordances: durable handles, previews, and shell-debuggable artifacts.
- Replacing everything with only in-memory inspection would regress current debugging unless the inspection stream is persisted/adapted.

## 2. Relevant XState primitives audited

### 2.1 Actors are in-process event loops with an internal mailbox

In XState core:
- `createActor()` creates an actor and implicitly creates an actor system for the root actor (`packages/core/src/createActor.ts:839-860`).
- Each actor has an in-memory `Mailbox` used to enqueue events (`packages/core/src/createActor.ts:94-96`, `729-742`).
- The mailbox implementation is an in-memory linked queue, not a file/socket/broker (`packages/core/src/Mailbox.ts:6-56`).

Important conclusion:
- XState provides a mailbox abstraction, but **not the same kind of mailbox** cmd-center-v2 uses.
- It cannot directly replace cross-process file mailboxes by itself.

### 2.2 Actor systems, keyed actors, and event relay

In XState core:
- `createSystem()` owns actor registration, lookup, inspection, scheduling, and relay (`packages/core/src/system.ts:48-86`, `91-214`).
- Systems can key actors by `systemId` and retrieve them later (`packages/core/src/system.ts:56-58`, `189-204`).
- `system._relay()` emits an inspection event and delivers the event to the target actor (`packages/core/src/system.ts:66-74`, `157-167`, `205-214`).

Best-fit mapping:
- `agent_id` in Fabric should map to `systemId` inside any XState-backed runtime model.
- Current correlation-driven coordinator/worker flows map naturally to actor-to-actor event relay.

### 2.3 Inspection events are a strong fit for monitor observability

XState emits structured inspection events:
- `@xstate.actor`
- `@xstate.event`
- `@xstate.snapshot`
- `@xstate.microstep`
- `@xstate.action`
- defined in `packages/core/src/inspection.ts:8-58`

Actors emit inspection events on actor creation, event reception, action execution, and snapshot changes (`packages/core/src/createActor.ts:245-252`, `349-354`, `543-548`).

Best-fit mapping:
- Current custom runtime events (`agent.registered`, `agent.status_runtime`, `agent.heartbeat`, etc.) can be normalized into inspection-derived events.
- The monitor SSE backend could consume a single XState-flavored event stream instead of reconstructing behavior from multiple low-level files.

### 2.4 Persistence exists and is usable

For actors/machines:
- actors expose `getPersistedSnapshot()` (`packages/core/src/createActor.ts:775-790`)
- machine persistence includes child snapshots with `src` and `systemId` metadata (`packages/core/src/State.ts:420-470`)
- inline child actors are not persistable unless unsafe options are used (`packages/core/src/State.ts:457-465`)

For stores:
- `@xstate/store` supports inspection (`packages/xstate-store/src/store.ts:145-171`)
- `@xstate/store/persist` supports snapshot persistence and event-log persistence with checkpointing and replay (`packages/xstate-store/src/persist.ts:465-666`, `697-758`, `880-909`)

Best-fit mapping:
- Simple runtime registries/cursors are a strong fit for `@xstate/store`.
- More complex orchestration (launcher handshake, worker contract lifecycle, watchdog states, reviewer gate) is a fit for full `xstate` machines.

### 2.5 Reducer-style bridge option exists

`fromTransition()` creates actor logic from reducer-like transitions and persisted snapshots (`packages/core/src/actors/transition.ts:167-214`).

Best-fit mapping:
- This is a practical bridge for incremental migration from current imperative status updates to event-driven state updates without designing a full machine upfront.

## 3. Mapping current Fabric architecture to XState

## 3.1 Mailboxes

Current Fabric:
- File append + SIGUSR1 + offset cursor.

XState-compatible bridge:
- Introduce a `transport actor` that owns:
  - outbound `SEND` events -> append JSONL + optional SIGUSR1
  - inbound `SIGUSR1_RECEIVED` / `POLL_MAILBOX` events -> read from offset, parse messages, emit `MESSAGE_RECEIVED`
  - persisted cursor state (`lastOffset`, `lastProcessed`)
- Keep mailbox JSONL as the transport during the first migration.

Replacement option:
- Replace the file mailbox with a new broker transport (Unix domain socket / local HTTP / WebSocket / named pipe).
- This is not an XState feature by itself; it is an additional system rewrite.

Recommendation:
- Bridge first. Do not replace mailbox transport in phase 1.

## 3.2 SIGUSR1 wakeups

Current Fabric:
- `SIGUSR1` is the low-level nudge to wake a sleeping process after file append.

XState-compatible bridge:
- Treat `SIGUSR1` as an external event source feeding the transport actor or root runtime actor.
- Model semantics as events such as `WAKE_SIGNAL_RECEIVED`, `INBOX_BYTES_AVAILABLE`, `INBOX_DRAIN_REQUESTED`.

Replacement option:
- Remove SIGUSR1 only if a new always-on transport/broker guarantees delivery and wakeup.

Recommendation:
- Keep SIGUSR1 as a bridge transport concern until the project intentionally adopts a different IPC layer.

## 3.3 Registry/runtime state

Current Fabric:
- Registry rows are updated from runtime events and explicit refreshes.
- State files and in-memory globals can diverge temporarily.

XState-compatible bridge:
- Make one runtime actor/store snapshot authoritative for:
  - `fabric_status`
  - `current_task`
  - `last_error`
  - `pending_correlations`
  - queue/unread counts
  - launcher/waiting/blocked states
- Derive:
  - state JSON file from snapshot persistence
  - registry row from snapshot projection
  - runtime event emission from snapshot/inspection projection

Recommendation:
- This is the highest-value migration target.

## 3.4 Monitor/runtime observability

Current Fabric:
- SSE + fs.watch + polling + runtime-event drain + SQLite queries + watchdog heuristics.

XState-compatible bridge:
- Feed monitor from:
  - XState inspection events for actor/event/snapshot/action visibility
  - persisted snapshot/store state for durable recovery
- Keep `runtime-events.jsonl` initially, but populate it from the XState inspection adapter.
- Move watchdog to an explicit machine/statechart with states like `online`, `suspect`, `offline`, `purging`, `recovered`.

Recommendation:
- Use XState inspection as the new semantic stream, not as an in-memory-only replacement.

## 3.5 Agent lifecycle orchestration

Current Fabric:
- Launcher, extension session startup, ACK wait, worker completion, auto cleanup, and watchdog recovery are procedural.

XState-compatible bridge:
- Model explicit lifecycle machines for:
  1. launcher bootstrap (`launching -> awaiting_alive_ack -> ready | launch_failed`)
  2. agent runtime (`registering -> idle -> queued -> processing_inbox -> turn_active -> waiting_llm/streaming/tool_running -> waiting_response -> idle | error | shutting_down`)
  3. worker contract lifecycle (`accepted -> running -> done|failed|blocked`)
  4. watchdog (`healthy -> suspect -> offline -> purge_candidate -> removed|recovered`)

Recommendation:
- Use full `xstate` here, not only stores.

## 4. Recommended migration shape

## 4.1 Use a hybrid, not a pure rewrite

Recommended technology split:

- Use `xstate` for:
  - agent lifecycle machine
  - launcher handshake machine
  - contract/reviewer-gate machine
  - watchdog machine
  - monitor-side transport/liveness orchestration

- Use `@xstate/store` for:
  - registry projections
  - runtime snapshot cache
  - deterministic monitor views
  - persisted cursors and lightweight derived state

Why this split works:
- Much of current monitor/registry state is reducer-like.
- Only some behaviors need hierarchical/temporal statecharts.
- This minimizes over-modeling while still giving a consistent runtime backbone.

## 4.2 Do not try to collapse the multi-process model into one XState actor system

Not recommended:
- “One root XState system for all agents” as if all agents were in one Node process.

Why:
- Current agents are separate tmux-hosted `pi` processes.
- XState actor systems are in-process by default.
- Forcing a single-process actor system would require re-architecting the whole `pi` execution model, not just runtime state.

## 4.3 Treat transport as an adapter boundary

Recommended boundary:
- `transport adapter` is outside the XState semantic core.
- It converts OS/filesystem/signals into XState events and converts XState outbound events into mailbox writes + signals.

That keeps the future open:
- mailbox+SIGUSR1 today
- socket-based transport later
- same runtime machines above the transport boundary

## 5. Phased migration plan

## Phase 0 — ADR + dependency baseline

Deliverables:
- add `xstate` and `@xstate/store`
- write an ADR describing “XState for runtime state, mailbox transport retained initially”
- define canonical Fabric runtime event vocabulary

Success criteria:
- no behavior changes yet
- agreed event names and state ownership

## Phase 1 — Agent runtime machine inside extension

Implement:
- new `agent-runtime.machine.ts` or equivalent
- move current status transitions out of scattered globals and `setFabricStatus()` callers
- represent `pendingCorrelations`, `queuedCount`, `isStreaming`, `isThinking`, `activeToolName`, `lastKnownRuntimeTask`, `lastKnownRuntimeError` inside the machine/store snapshot
- adapt existing `fabric_refresh_runtime` to serialize from actor/store snapshot instead of free globals

Keep unchanged:
- mailbox files
- SIGUSR1 wakeup
- SQLite schema
- tmux launcher behavior

Expected value:
- one authoritative state model per agent process
- less drift between UI footer, state file, registry row, and runtime events

## Phase 2 — Transport actor bridge

Implement:
- transport actor wrapping mailbox send/read/offset persistence
- external signal hook dispatches `WAKE_SIGNAL_RECEIVED`
- outbound runtime machine emits `SEND_MESSAGE` events to transport actor
- inbound mailbox messages become typed runtime events (`CONTRACT_RECEIVED`, `RESPONSE_RECEIVED`, `HEALTHCHECK_RECEIVED`, etc.)

Keep unchanged:
- JSONL mailbox format
- PID files
- SIGUSR1 as the wakeup primitive

Expected value:
- transport logic becomes replaceable without rewriting orchestration state

## Phase 3 — Monitor/store rework

Implement:
- monitor-side `@xstate/store` for registry projection and derived views
- XState machine for watchdog/liveness state
- inspection-to-SSE adapter
- optionally keep writing `runtime-events.jsonl` as the persisted event spine for compatibility with existing tooling

Expected value:
- remove ad-hoc state inference from monitor timers and fs.watch callbacks
- move blocked/offline/recovered transitions into explicit models

## Phase 4 — Contract/lifecycle machines

Implement:
- launcher ACK state machine
- worker contract/reviewer-gate machine
- timeout/retry policy modeled explicitly

Expected value:
- current procedural coordinator-worker flows become testable and replayable

## Phase 5 — Optional transport replacement evaluation

Only after phases 1-4 stabilize.

Evaluate:
- keep mailbox+SIGUSR1 forever if it remains good enough
- or replace with a broker transport while keeping the same XState runtime machines

Expected value:
- transport swap becomes an adapter change, not a runtime rewrite

## 6. Risks and tooling gaps

1. XState does not solve cross-process IPC by itself
- biggest conceptual trap in this migration
- adopting XState does not automatically remove mailbox files or signals

2. Persistence discipline is required
- machine child actors need stable `src`/`systemId` to persist cleanly (`packages/core/src/State.ts:457-470`)
- avoid inline actors for persistable runtime machines

3. Inspection is not a durable log by itself
- current repo depends on durable files and SQLite
- inspection should feed persisted artifacts, not replace durability with memory-only streams

4. Migration can accidentally duplicate truth sources
- during transition, the machine/store snapshot must become primary, not “one more status cache”

5. tmux/PID recovery remains outside pure XState semantics
- pane existence, OS PID checks, and process signals still need adapter code

6. Test coverage will be necessary
- statechart migration without transition tests will be fragile
- launcher ACK, transport bridge, watchdog, and worker contract flows need deterministic tests

## 7. Final recommendation

Use XState to replace **runtime state inference**, not to prematurely replace **transport plumbing**.

Concrete recommendation:
- Phase 1-2: keep mailbox/SIGUSR1/tmux, but put an XState runtime model above them.
- Phase 3-4: move monitor/watchdog/contract orchestration to XState.
- Phase 5: only then decide whether mailbox/SIGUSR1 should stay or be replaced.

This gives cmd-center-v2 the main benefits of XState:
- explicit states
- typed transitions
- durable snapshots
- inspection-driven observability
- cleaner lifecycle logic

without paying the immediate cost of a full IPC rewrite.

## Boss-next-actions

1. Create an ADR in the repo stating:
   - XState is adopted for runtime/orchestration state.
   - mailbox JSONL + SIGUSR1 remain the first transport adapter.
   - `agent_id` maps to XState `systemId`.
   - monitor observability will converge on XState inspection events plus persisted projections.

2. Open a follow-up implementation task for Phase 1:
   - add `xstate` and `@xstate/store`
   - build `agent-runtime.machine.ts`
   - replace extension runtime globals as the source of truth for status/correlations/queue state
   - keep current external behavior unchanged

3. Open a second follow-up task for Phase 2:
   - create mailbox transport actor/adapter
   - map SIGUSR1 and mailbox drain to explicit runtime events
   - keep existing JSONL envelope format and PID wakeup behavior

4. Open a third follow-up task for monitor refactor discovery:
   - design inspection-to-SSE adapter
   - design monitor registry store/watchdog machine
   - define which current runtime event files remain for backward compatibility

5. Do not start with “replace mailbox+SIGUSR1” as the first implementation task.
   - That is a later transport decision, not the right first migration step.
