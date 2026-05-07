# multi-agents

Open-source local multi-agent orchestration for `pi.dev`.

Run a **boss coordinator** plus multiple specialized AI agents in `tmux`, communicate through **file-based mailboxes**, wake workers with **`SIGUSR1`**, and monitor the whole mesh through a lightweight **HTTP/SSE dashboard**.

No Redis. No Docker. No Kubernetes. No central broker.

---

## Why this project exists

Most multi-agent systems become heavy too fast:

- too many services
- too much infrastructure
- too many moving parts
- too hard to inspect locally

`multi-agents` takes the opposite approach:

- **local-first**
- **inspectable**
- **simple runtime primitives**
- **good for real development workflows**

If you want to orchestrate multiple AI agents on your own machine using `pi.dev`, this repo gives you the core runtime to do it.

---

## What you get

### Core runtime
- `pi.dev` extension
- tmux-based agent launcher
- mailbox-based peer-to-peer agent communication
- `SIGUSR1` wakeup model for sleeping workers
- shared SQLite registry and PM database
- HTTP/SSE monitor server

### Agent model
- one **interactive coordinator**
- many **headless rpc workers**
- skill-based role loading from `skills/*/SKILL.md`
- support for sub-coordinators and worktree-based task isolation

### Included roles
- `coordinator`
- `sub-coordinator`
- `dev`
- `reviewer`
- `tester`
- `devops`
- `security`
- `git`
- `architect`
- `chat`
- `setup`
- `orchestrator`

---

## Repository layout

```text
multi-agents/
├── AGENTS.md
├── README.md
├── package.json
├── src/
│   ├── core/
│   ├── pm/
│   └── agents/
├── skills/
├── prompts/
├── dashboard/
```

### Important directories

- `src/core/` — extension, launcher, monitor, runtime helpers
- `src/pm/` — project and task management over SQLite
- `src/agents/` — standalone-agent namespace for external/optional agents
- `skills/` — role definitions loaded dynamically by the launcher
- `dashboard/` — browser UI powered by the monitor SSE stream

---

## How agent skills are loaded

Agent skills are loaded from **files on disk**, not from the database.

The source of truth is:

```text
skills/<role>/SKILL.md
```

Example:

- `--role=dev` → `skills/dev/SKILL.md`
- `--role=reviewer` → `skills/reviewer/SKILL.md`
- `--role=coordinator` → `skills/coordinator/SKILL.md`

### Loading flow

When you launch an agent, the runtime does this:

```text
role -> skills/<role>/SKILL.md -> skill-loader.ts reads frontmatter -> launcher passes --skill to pi
```

More concretely:

1. `src/core/launcher.ts` receives `--role=<role>`
2. `src/core/skill-loader.ts` finds `skills/<role>/SKILL.md`
3. it reads the frontmatter fields such as:
   - `model`
   - `tools`
   - `thinking`
   - `mode`
   - `description`
4. the launcher builds the agent profile from that file
5. the launcher starts `pi` and passes the skill path through `--skill`

This means the skill file is used in two ways:

- to configure the agent launch profile
- to load the full skill content into the running `pi` agent context

### Are skills stored in SQLite?

No.

The SQLite databases are used for runtime and project-management state, such as:

- registered agents
- mailbox/runtime metadata
- projects
- tasks
- subtasks
- analyses
- events

But the actual skill definitions are **not** stored there.

### Workspace/local skills

If you launch an agent with a `workspace_dir`, the launcher can also load workspace-local skills from the target repository, for example:

- `<workspace>/.pi/skills`
- `<workspace>/skills`
- `<workspace>/.agents/skills`
- `<workspace>/.claude/skills`

This is especially useful for sub-coordinators or workers running inside another repo.

You can control that behavior with:

- `--workspace-skills=<a,b,c>`
- `--no-workspace-skills`

### What happens if a skill changes?

If you edit a `SKILL.md` file:

- newly launched agents will use the updated version
- already running agents usually need to be relaunched to pick up the change

So in practice, skills are a **file-based source of truth**.

---

## Minimum environment required

This is the **minimum practical environment** needed to run the repo:

- macOS or Linux
- `git`
- `tmux`
- Node.js **22+**
- `npm`
- `pi` installed and working
- `bash` or `zsh`

Optional but recommended:

- `sqlite3` CLI for debugging
- a browser for the dashboard
- Telegram bot credentials if you want the Telegram bridge

### Verify your environment

Run this before anything else:

```bash
pi --version
tmux -V
node -v
npm -v
git --version
```

If `pi` is missing or broken, fix that first. This repository extends `pi.dev`; it does not replace it.

---

## Installation

### Clone the repository

```bash
git clone git@github.com:deazoft/multi-agents.git
cd multi-agents
```

### Install Node dependencies

```bash
npm install
```

### Install the package into `pi`

From the repository root:

```bash
pi install .
```

You can also install directly from Git:

```bash
pi install git:github.com/deazoft/multi-agents.git
```

### Optional: hot-reload style local development

```bash
ln -s "$(pwd)" ~/.pi/agent/extensions/cmd-center
```

Note: the repository is named `multi-agents`, while the current package name in `package.json` is still `cmd-center`.

---

## Critical activation step

The extension stays dormant unless you export this variable **before starting `pi` or launching agents**:

```bash
export ENABLE_CMD_CENTER=TRUE
```

If you skip this step:

- Fabric commands will not appear
- Fabric tools will not be registered
- mailbox handlers will not activate
- agent runtime integration will appear to be missing

---

# Quick start

If you only want to get the system running, follow these exact steps.

## Terminal 1 — start the monitor

```bash
cd multi-agents
export ENABLE_CMD_CENTER=TRUE
npx tsx src/core/monitor.ts --port=7474
```

Open:

```text
http://localhost:7474
```

## Terminal 2 — start the coordinator

```bash
cd multi-agents
export ENABLE_CMD_CENTER=TRUE
npx tsx src/core/launcher.ts --role=coordinator --agent-id=boss --mode=interactive
```

## Terminal 3 — start a worker

```bash
cd multi-agents
export ENABLE_CMD_CENTER=TRUE
npx tsx src/core/launcher.ts --role=dev --agent-id=dev-1 --mode=rpc
```

## Optional — attach to tmux

```bash
tmux attach -t fabric-default
```

At this point you should have:

- a running monitor
- a live interactive coordinator named `boss`
- at least one worker
- a visible dashboard at `http://localhost:7474`

---

## Architecture at a glance

```text
┌──────────────────────────────────────────────────────────────┐
│                       tmux session                           │
│                                                              │
│   boss (interactive)                                         │
│      │                                                       │
│      ├── dev-1 (rpc)                                         │
│      ├── reviewer-1 (rpc)                                    │
│      ├── tester-1 (rpc)                                      │
│      └── devops-1 (rpc)                                      │
│                                                              │
│      Communication: mailbox JSONL + SIGUSR1                  │
│      Shared state: SQLite                                    │
│      Monitoring: HTTP + SSE dashboard                        │
└──────────────────────────────────────────────────────────────┘
```

---

## How it works

The runtime uses simple primitives:

1. one agent writes a message to another agent's mailbox
2. the sender wakes the target with `SIGUSR1`
3. the target processes the new messages
4. shared runtime state is stored in SQLite

Default runtime location:

```text
/tmp/fabric-agents/
```

Typical contents:

```text
/tmp/fabric-agents/
├── registry.sqlite
├── mailboxes/{agent-id}.jsonl
├── pids/{agent-id}.pid
├── state/{agent-id}.json
├── agents.jsonl
├── projects.sqlite
└── projects.jsonl
```

This makes the system easy to debug with normal shell tools.

---

## Common commands

### Start the monitor with npm

```bash
npm run start:monitor
```

### Start the coordinator with npm

```bash
npm run start:boss
```

### Launch a worker manually

```bash
export ENABLE_CMD_CENTER=TRUE
npx tsx src/core/launcher.ts --role=reviewer --agent-id=reviewer-1 --mode=rpc
```

### Clean the local runtime

```bash
npm run clean
```

---

## Commands available inside `pi`

When the extension is loaded correctly, the coordinator can use commands like:

```text
/fabric-list
/fabric-health
/fabric-broadcast
/fabric-report
/fabric-workers
/fabric-launch-worker
/reload
```

Use `/reload` after changing the extension code so `pi` refreshes command/tool schemas.

---

## Real examples

## Example 1 — launch multiple workers

```bash
export ENABLE_CMD_CENTER=TRUE
npx tsx src/core/launcher.ts --role=dev --agent-id=dev-1 --mode=rpc
npx tsx src/core/launcher.ts --role=reviewer --agent-id=reviewer-1 --mode=rpc
npx tsx src/core/launcher.ts --role=tester --agent-id=tester-1 --mode=rpc
npx tsx src/core/launcher.ts --role=devops --agent-id=ops-1 --mode=rpc
```

## Example 2 — create a sample project and task

```bash
PROJECT_NAME="Demo Project" \
TASK_TITLE="Review launcher flow" \
TASK_DESCRIPTION="Validate that coordinator and worker startup succeeds" \
npx tsx create-project-task.ts
```

Example output:

```json
{
  "ok": true,
  "dbPath": "/tmp/fabric-agents/projects.sqlite",
  "project": {
    "id": 1,
    "name": "Demo Project",
    "repo_local_path": "/path/to/repo"
  },
  "task": {
    "id": 1,
    "title": "Review launcher flow",
    "branch_name": "main"
  }
}
```

## Example 3 — start a sub-coordinator

Using the helper script:

```bash
REPO_DIR="$(pwd)" TASK_ID="42" ./setup-subcoordinator.sh
```

Or directly:

```bash
export ENABLE_CMD_CENTER=TRUE
export FABRIC_PARENT_AGENT_ID=boss
export FABRIC_TASK_ID=42
npx tsx src/core/launcher.ts \
  --role=sub-coordinator \
  --agent-id=sub-boss-42 \
  --mode=interactive \
  --session=fabric-task-42 \
  --workspace-dir="$(pwd)"
```

## Example 4 — structured worker contract

A coordinator should delegate work using a structured contract. Conceptually, the payload looks like this:

```json
{
  "to": "dev-1",
  "description": "Implement input validation in src/api/users.ts",
  "acceptance_criteria": [
    {
      "id": "ac-1",
      "description": "src/api/users.ts contains validateUser",
      "type": "file_contains",
      "params": {
        "path": "src/api/users.ts",
        "pattern": "validateUser"
      },
      "required": true
    },
    {
      "id": "ac-2",
      "description": "unit tests pass",
      "type": "test_passes",
      "params": {
        "command": "npm test"
      },
      "required": true
    }
  ],
  "report_to_when_done": "boss",
  "task_id": "task-42"
}
```

---

## Troubleshooting

### I do not see Fabric commands inside `pi`

Make sure you exported:

```bash
export ENABLE_CMD_CENTER=TRUE
```

Then restart `pi` or run:

```text
/reload
```

### The launcher cannot find or activate the extension

Run this from the repo root:

```bash
pi install .
```

Then retry the launcher.

### The dashboard is empty

Check whether agents are actually registered:

```bash
sqlite3 /tmp/fabric-agents/registry.sqlite "SELECT agent_id, role, status, last_seen_at FROM agents;"
```

### I want to reset everything

```bash
rm -rf /tmp/fabric-agents
tmux kill-session -t fabric-default || true
```

### I changed extension code and nothing updated

Inside `pi`, run:

```text
/reload
```

---

## Who this is for

This project is useful if you want to:

- experiment with cooperative AI agents locally
- orchestrate role-based AI workers on real codebases
- avoid heavyweight distributed infrastructure
- inspect every part of the runtime with standard Unix tools
- build sub-coordinator or worktree-based agent workflows

---

## Design principles

- **local-first**
- **no polling if avoidable**
- **simple primitives over heavy infrastructure**
- **coordinator interactive, workers headless**
- **file-based recovery over hidden in-memory state**
- **environment-driven configuration**

---

## Contributing / public repo policy

This public repository intentionally keeps:

- runtime code
- skills
- dashboard assets
- helper scripts
- shareable agent assets

Large internal planning notes and private working documents are intentionally excluded from the public shareable version.

---

## Summary

If you want a practical open-source starting point for **local multi-agent orchestration on top of `pi.dev`**, this repo gives you:

- a coordinator
- workers
- launcher
- mailbox protocol
- shared registry
- project/task model
- dashboard
- role system

Clone it, install it, export `ENABLE_CMD_CENTER=TRUE`, and you can run the full system locally.
