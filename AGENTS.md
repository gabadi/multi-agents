# AGENTS.md

Agent operating notes for the public `multi-agents` repository.

## Repository purpose

This repo provides a local multi-agent control plane for `pi.dev`.

Core ideas:
- `tmux` panes host agents
- mailbox JSONL files provide peer-to-peer messaging
- `SIGUSR1` wakes sleeping workers
- SQLite stores shared runtime state
- skills under `skills/*/SKILL.md` define roles

## Minimum assumptions

Any agent working in this repository should assume:

- Node.js 22+
- `tmux` available
- `pi` already installed
- the extension is only active when `ENABLE_CMD_CENTER=TRUE`
- runtime state defaults to `/tmp/fabric-agents`

## Activation rule

Before starting `pi`, export:

```bash
export ENABLE_CMD_CENTER=TRUE
```

If this variable is missing, Fabric commands and tools will not be available.

## Main runnable entry points

- `src/core/extension.ts` — `pi.dev` extension entry point
- `src/core/launcher.ts` — starts agents in tmux
- `src/core/monitor.ts` — HTTP/SSE monitor and dashboard backend
- `create-project-task.ts` — sample PM helper
- `setup-subcoordinator.sh` — example sub-coordinator/session bootstrap

## Main directories

- `src/core/` — launcher, extension, monitor, runtime helpers
- `src/pm/` — project/task management over SQLite
- `src/agents/` — standalone-agent namespace
- `skills/` — agent role instructions
- `dashboard/` — browser UI

## Default runtime layout

```text
/tmp/fabric-agents/
├── registry.sqlite
├── mailboxes/{id}.jsonl
├── pids/{id}.pid
├── state/{id}.json
├── agents.jsonl
├── projects.sqlite
└── projects.jsonl
```

## Operational rules

1. Coordinator should usually run in `interactive` mode.
2. Workers should usually run in `rpc` mode.
3. Launch agents through `src/core/launcher.ts` instead of hand-building `pi` commands.
4. Keep mailbox traffic compact and machine-oriented.
5. Do not replace SIGUSR1 wakeups with polling.
6. Prefer environment variables over hardcoded paths.
7. New implementation/investigation tasks should default to kickoff intent: create a dedicated worktree/workspace and assign a dedicated sub-coordinator unless the human explicitly asks for create-only/backlog-only behavior.
8. If a blocking clarification is needed for kickoff, ask the minimum necessary question, then continue with workspace creation and sub-coordinator launch.

## Recommended startup flow

```bash
npm install
pi install .
export ENABLE_CMD_CENTER=TRUE
npx tsx src/core/monitor.ts --port=7474
npx tsx src/core/launcher.ts --role=coordinator --agent-id=boss --mode=interactive
```

Then add workers as needed, for example:

```bash
npx tsx src/core/launcher.ts --role=dev --agent-id=dev-1 --mode=rpc
npx tsx src/core/launcher.ts --role=reviewer --agent-id=reviewer-1 --mode=rpc
```

## First troubleshooting checks

```bash
pi list
sqlite3 /tmp/fabric-agents/registry.sqlite "SELECT agent_id, role, status FROM agents;"
tmux ls
```

If the extension schema changed, use `/reload` inside `pi`.

## Source of truth

For human-readable setup and runnable examples, use `README.md`.
