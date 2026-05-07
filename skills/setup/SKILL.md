---
name: setup
description: Initial setup skill for cmd-center-v2 agents. Covers communication, registration, launcher usage, and basic health checks.
model: fern/glm-5
tools: read,bash
thinking: low
mode: rpc
---

# Setup Skill

## Inter-Agent Mailbox Protocol (Strict)

Mailbox traffic is machine-to-machine control data. It is not human-facing chat.

Rules:
1. English only.
2. No emojis, greetings, thanks, apologies, filler, markdown decoration, or narrative summaries.
3. Prefer fixed key-value lines over prose. Send only the fields the receiver can act on.
4. Do not acknowledge acknowledgements. Do not send terminal "ok" messages.
5. Persist technical details in PM notes, task analyses, PR bodies, closeout notes, or artifacts. Mailbox messages to parent agents should carry IDs and required actions only.
6. If a human needs an explanation, use a human-facing channel or translation method. Do not put human-readable narrative in inter-agent mailbox traffic.
7. When a contract is complete, use `fabric_report_completion` with compact summaries and structured artifacts/verification results. Do not open a parallel chat unless blocked.

Allowed parent update shape:

```text
Task 18 recovered and closed.
closeout_note_id: 991
follow_up_task_id: 20
cleanup_request_id: 44
priority: low
```

Allowed blocked shape:

```text
Task 18 closeout blocked.
blocker: missing_pr_url
requested_input: PR URL or branch name
priority: normal
```

Do not add extra lines unless the receiver explicitly requested them.


## Purpose

Initialize and troubleshoot the cmd-center-v2 agent ecosystem.

## Prerequisites

Set before launching `pi` or the launcher:

```bash
export ENABLE_CMD_CENTER=TRUE
```

Without this variable:
- Fabric extension commands are not registered.
- LLM tools are not registered.
- Mailbox/SIGUSR1 handlers are not active.
- Agent status footer and registry integration are absent.

## Install

```bash
pi install .
```

For local development hot reload:

```bash
ln -s "$(pwd)" ~/.pi/agent/extensions/cmd-center
```

## Launch Coordinator

```bash
npx tsx src/core/launcher.ts   --role=coordinator   --agent-id=boss   --mode=interactive
```

## Launch Worker

```bash
npx tsx src/core/launcher.ts   --role=dev   --agent-id=dev-1   --mode=rpc   --report-to=boss
```

## Launch Monitor

```bash
npx tsx src/core/monitor.ts --port=7474
```

Dashboard: `http://localhost:7474`.

## Health Checks

- Registry: `/tmp/fabric-agents/registry.sqlite`
- Mailboxes: `/tmp/fabric-agents/mailboxes/*.jsonl`
- PIDs: `/tmp/fabric-agents/pids/*.pid`
- Events: `/tmp/fabric-agents/agents.jsonl`

Useful commands:

```bash
sqlite3 /tmp/fabric-agents/registry.sqlite "SELECT agent_id, role, fabric_status, current_task, last_seen_at FROM agents;"
tmux ls
```
