# cmd-center

A lightweight multi-agent command center for `pi.dev`.

`cmd-center` lets you run a coordinator plus multiple specialist agents inside `tmux`, with peer-to-peer communication over mailbox files and `SIGUSR1`. It is designed for local orchestration without Redis, Docker, or a separate message broker.

## What it does

- Launches AI agents as `tmux` panes
- Uses file-based mailboxes for agent-to-agent messaging
- Wakes sleeping workers with `SIGUSR1`
- Keeps a shared agent registry in SQLite
- Exposes a monitor/dashboard over HTTP + SSE
- Loads reusable role skills from `skills/*/SKILL.md`
- Supports coordinator, sub-coordinator, dev, reviewer, tester, devops, security, git, and chat roles

## Requirements

Before using this package, make sure you have:

- `pi` installed and working
- Node.js 22+ with `tsx` support available through `npx`
- `tmux`
- a Unix-like environment with `sqlite` support in Node

## Installation

### Install from a local path

```bash
pi install /path/to/cmd-center-v2
```

### Install from Git

```bash
pi install git:github.com/deazoft/multi-agents.git
```

## Enable the extension

The Fabric extension is intentionally dormant until you enable it.

Set the environment variable before starting `pi`:

```bash
export ENABLE_CMD_CENTER=TRUE
```

If this variable is missing, the package stays transparent and the Fabric commands/tools are not registered.

## Start the monitor

The monitor provides the local HTTP/SSE stream used by the dashboard.

```bash
npx tsx src/core/monitor.ts --port=7474
```

Then open the dashboard at:

```text
http://localhost:7474
```

## Launch agents

### Coordinator

```bash
npx tsx src/core/launcher.ts --role=coordinator --agent-id=boss --mode=interactive
```

### Worker examples

```bash
npx tsx src/core/launcher.ts --role=reviewer --agent-id=alice --mode=rpc
npx tsx src/core/launcher.ts --role=dev --agent-id=builder --mode=rpc
npx tsx src/core/launcher.ts --role=devops --agent-id=ops --mode=rpc
```

## Runtime model

The system uses:

- `tmux` for process layout
- mailbox JSONL files for communication
- `SIGUSR1` for wakeups
- SQLite for the shared registry and project-management state

Runtime data is stored under:

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
├── projects.sqlite
└── projects.jsonl
```

## Main package contents

This shareable package focuses on installable/runtime assets:

- `src/` — extension, launcher, monitor, PM domain
- `skills/` — agent role instructions
- `prompts/` — reusable prompt templates
- `dashboard/` — browser dashboard
- `patches/` — optional integration patches

Internal planning notes and long-form documentation are kept out of the shareable package flow.

## Useful commands inside `pi`

Once the extension is active, the interactive coordinator can use commands such as:

```text
/fabric-list
/fabric-health
/fabric-broadcast
/fabric-report
/fabric-workers
/fabric-launch-worker
```

If you changed the extension code and want `pi` to reload tool schemas, run:

```text
/reload
```

## Development notes

- No Redis
- No Docker
- No central broker
- Workers stay idle until they receive a mailbox event
- The coordinator is typically the only interactive agent; workers should run in `rpc` mode

## License / sharing

Share this repository as a `pi` package or install it directly from Git. The repo is structured so the runtime code and agent assets are the main deliverables.
