# multi-agents

A local multi-agent orchestration system for `pi.dev`.

This repository lets you run one interactive coordinator plus multiple specialist agents inside `tmux`, using:

- file-based mailboxes
- `SIGUSR1` wakeups
- a shared SQLite registry
- skill-based agent roles
- an HTTP/SSE monitor dashboard

It does **not** require Redis, RabbitMQ, Docker, or Kubernetes.

## What is in this repo

- `src/core/` — the `pi.dev` extension, launcher, monitor, registry helpers, Telegram bridge
- `src/pm/` — project/task tracking over SQLite
- `src/agents/` — standalone-agent namespace for optional external agents
- `skills/` — role definitions for coordinator, dev, reviewer, tester, devops, security, git, chat, setup, architect, and sub-coordinator
- `dashboard/` — browser dashboard
- `prompts/` — reusable prompts
- `patches/` — optional integration patches

## Minimum environment

To run this repository, the minimum practical environment is:

- macOS or Linux
- `git`
- `tmux`
- Node.js **22+**
- `npm`
- `pi` installed and working
- a shell such as `bash` or `zsh`

Optional but useful:

- `sqlite3` CLI for debugging the registry and PM database
- a modern browser for the dashboard
- Telegram bot credentials if you want the Telegram bridge

## Important requirement: `pi` must already exist

This repository extends `pi.dev`; it does not replace it.

If this command fails, install/configure `pi` first:

```bash
pi --version
```

Also verify `tmux` and Node:

```bash
tmux -V
node -v
npm -v
```

## Quick start

### 1. Clone the repository

```bash
git clone git@github.com:deazoft/multi-agents.git
cd multi-agents
```

### 2. Install local Node dependencies

```bash
npm install
```

### 3. Install the package into `pi`

From the repository root:

```bash
pi install .
```

You can also install directly from Git:

```bash
pi install git:github.com/deazoft/multi-agents.git
```

For active development, a symlink also works:

```bash
ln -s "$(pwd)" ~/.pi/agent/extensions/cmd-center
```

### 4. Enable the extension

The extension is intentionally inactive unless this variable is set **before starting `pi`**:

```bash
export ENABLE_CMD_CENTER=TRUE
```

Without it:

- Fabric commands are not registered
- Fabric tools are not visible to the model
- no mailbox/SIGUSR1 lifecycle is activated

### 5. Start the monitor

In one terminal:

```bash
export ENABLE_CMD_CENTER=TRUE
npx tsx src/core/monitor.ts --port=7474
```

Open the dashboard at:

```text
http://localhost:7474
```

### 6. Start the coordinator

In another terminal:

```bash
export ENABLE_CMD_CENTER=TRUE
npx tsx src/core/launcher.ts --role=coordinator --agent-id=boss --mode=interactive
```

This creates or reuses a `tmux` session and starts the main coordinator.

Attach to the session if needed:

```bash
tmux attach -t fabric-default
```

### 7. Start workers

Examples:

```bash
export ENABLE_CMD_CENTER=TRUE
npx tsx src/core/launcher.ts --role=reviewer --agent-id=reviewer-1 --mode=rpc
npx tsx src/core/launcher.ts --role=dev --agent-id=dev-1 --mode=rpc
npx tsx src/core/launcher.ts --role=tester --agent-id=tester-1 --mode=rpc
```

## One-copy-paste demo

If you want the smallest possible working demo, use these three terminals.

### Terminal 1 — monitor

```bash
cd multi-agents
export ENABLE_CMD_CENTER=TRUE
npx tsx src/core/monitor.ts --port=7474
```

### Terminal 2 — coordinator

```bash
cd multi-agents
export ENABLE_CMD_CENTER=TRUE
npx tsx src/core/launcher.ts --role=coordinator --agent-id=boss --mode=interactive
```

### Terminal 3 — one worker

```bash
cd multi-agents
export ENABLE_CMD_CENTER=TRUE
npx tsx src/core/launcher.ts --role=dev --agent-id=dev-1 --mode=rpc
```

Now open the dashboard at `http://localhost:7474` and attach to tmux if you want to inspect panes:

```bash
tmux attach -t fabric-default
```

## How the runtime works

Runtime state lives by default in:

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

The basic model is:

1. an agent writes a JSONL message into another agent's mailbox
2. the sender raises `SIGUSR1`
3. the target wakes up and processes the new mailbox content
4. shared state is reflected in SQLite

## Available roles

These roles are included in `skills/`:

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

### Recommended usage

- use `coordinator` in `interactive` mode
- use workers in `rpc` mode
- launch new agents through `src/core/launcher.ts`
- keep `ENABLE_CMD_CENTER=TRUE` in every terminal that starts a Fabric agent

## Commands available inside `pi`

When the extension is loaded, the coordinator can use commands such as:

```text
/fabric-list
/fabric-health
/fabric-broadcast
/fabric-report
/fabric-workers
/fabric-launch-worker
/reload
```

`/reload` is useful after changing extension code so that `pi` reloads command/tool schemas.

## Example: launching a sub-coordinator in a separate worktree

You can use the helper script:

```bash
REPO_DIR="$(pwd)" TASK_ID="42" ./setup-subcoordinator.sh
```

Or call the launcher directly:

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

## Example: creating a sample PM project and task

This repository includes a small helper script you can run from the repo root:

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

## Example: structured task contract

A coordinator should send structured tasks to workers. Conceptually, the payload looks like this:

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

## Troubleshooting

### Fabric commands do not appear inside `pi`

Make sure:

```bash
export ENABLE_CMD_CENTER=TRUE
```

Then restart `pi` or run:

```text
/reload
```

### The launcher cannot find the extension

Install the package from the repository root:

```bash
pi install .
```

Then retry the launcher.

### The monitor starts but the dashboard looks empty

Check whether agents have started and registered:

```bash
sqlite3 /tmp/fabric-agents/registry.sqlite "SELECT agent_id, role, status, last_seen_at FROM agents;"
```

### You want a clean reset

```bash
rm -rf /tmp/fabric-agents
tmux kill-session -t fabric-default || true
```

## Notes for contributors

- the runtime is intentionally local-first and file-based
- workers should stay idle until they receive mailbox activity
- do not replace SIGUSR1 wakeups with polling
- the coordinator is typically the only interactive agent
- all runtime configuration is environment-variable driven

## Shareable/public version policy

This public repository keeps the runtime code, skills, prompts, dashboard, helper scripts, and agent assets.

Large internal planning documents and private working notes are intentionally excluded from the public shareable flow.
