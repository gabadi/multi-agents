---
name: agent_launcher
description: Shared agent launching patterns for all Fabric roles. Canonical reference for launching agents correctly with proper tmux session handling, directory setup, and mode selection. All roles should reference this when launching agents.
model: fern/gemini-3.1-flash-lite
tools: read,bash
thinking: medium
mode: rpc
---

# Agent Launcher Skill (Shared Reference)

**Purpose:** This skill provides the canonical patterns for launching Fabric agents correctly. All roles (secretary, coordinator, sub-coordinator, etc.) should follow these patterns when launching agents.

**Status:** Reference only - include relevant sections in role-specific skills.

---

## Table of Contents

1. [Role-to-Mode Mapping](#role-to-mode-mapping)
2. [Two Launch Approaches](#two-launch-approaches)
3. [Pattern A: fabric_launch_agent (Simple)](#pattern-a-fabric_launch_agent-simple)
4. [Pattern B: Manual tmux (Full Control)](#pattern-b-manual-tmux-full-control)
5. [Post-Launch Validation](#post-launch-validation)
6. [Common Mistakes](#common-mistakes)
7. [Environment Setup](#environment-setup)
8. [Kill and Recreate Pattern](#kill-and-recreate-pattern)

---

## Role-to-Mode Mapping (ALWAYS USE THIS)

| Role | Mode | Needs TTY | Use Case |
|------|------|-----------|----------|
| `coordinator` | `interactive` | YES | Top-level orchestration |
| `sub-coordinator` | `interactive` | YES | Task-level orchestration |
| `chat` | `interactive` | YES | Human-facing translation |
| `secretary` | `interactive` | YES | Human-facing admin |
| `dev` | `rpc` | NO | Implementation work |
| `reviewer` | `rpc` | NO | Code review |
| `test` | `rpc` | NO | Test execution |
| `git` | `rpc` | NO | Git/PR operations |
| `devops` | `rpc` | NO | Infrastructure |
| `security` | `rpc` | NO | Security audit |

**RULE:** If you launch a coordinator in `rpc` mode, it will fail to start or not respond to interactive commands. Always check this table.

---

## Two Launch Approaches

### When to Use Each

| Approach | Control Level | Best For | Trade-off |
|----------|---------------|----------|-----------|
| `fabric_launch_agent` | Low (launcher controls layout) | Background workers, quick launches | Cannot customize tmux layout |
| Manual `tmux` | High (you control everything) | Human-facing sessions with specific windows | More commands to manage |

### Decision Tree

```
Does human want specific tmux layout?
├── YES (lazygit, specific windows, named session)
│   └── Use Pattern B: Manual tmux
│
└── NO (just need agent running)
    └── Use Pattern A: fabric_launch_agent
```

---

## Pattern A: fabric_launch_agent (Simple)

Use when: Agent needs to run, tmux layout doesn't matter.

### Template

```yaml
Action: fabric_launch_agent
Parameters:
  agent_id: "<unique-id>"           # REQUIRED: unique identifier
  role: "<role>"                     # REQUIRED: from role-to-mode table
  mode: "<interactive|rpc>"          # REQUIRED: use table above
  report_to: "<parent-agent-id>"    # REQUIRED: who receives reports
  workspace_dir: "</path/to/dir>"    # OPTIONAL: where agent operates
  session: "<tmux-session>"          # OPTIONAL: hint (launcher may ignore)
```

### Example: Coordinator (Interactive)

```yaml
agent_id: coord-payments
role: coordinator
mode: interactive
report_to: boss
workspace_dir: /Users/jescobar/code/worktrees/project/payments-feature
```

### Example: Dev Worker (RPC)

```yaml
agent_id: dev-payments-1
role: dev
mode: rpc
report_to: coord-payments
workspace_dir: /Users/jescobar/code/worktrees/project/payments-feature
```

### Important Notes

- **Session name:** The launcher creates its own session name. The `session` parameter is a hint, not a guarantee.
- **Window layout:** You cannot control window names, pane splits, or additional windows.
- **Directory:** `workspace_dir` sets where the agent operates internally, but the shell prompt may show a different path depending on launcher implementation.

---

## Pattern B: Manual tmux (Full Control)

Use when: Human asks for specific windows (lazygit, terminal), specific session names, or custom layouts.

### Prerequisites

1. Determine the correct `node` path (if using `npx tsx`):
   ```bash
   which node
   # Example output: /Users/jescobar/.local/share/mise/installs/node/24.15.0/bin/node
   ```

2. Determine launcher.ts path (usually cmd-center-v2 root):
   ```bash
   /Users/jescobar/code/cmd-center-v2/src/core/launcher.ts
   ```

### Template: Interactive Coordinator with Layout

```bash
# === CONFIGURATION ===
SESSION_NAME="<session-name>"
AGENT_ID="<agent-id>"
ROLE="<coordinator|sub-coordinator|chat>"
WORKDIR="</path/to/working/directory>"
LAUNCHER_PATH="/Users/jescobar/code/cmd-center-v2/src/core/launcher.ts"
NODE_BIN="/Users/jescobar/.local/share/mise/installs/node/24.15.0/bin"

# === STEP 1: Create base session ===
tmux new-session -d -s "$SESSION_NAME" -n 'coordinator' -c "$WORKDIR"

# === STEP 2: Launch agent in coordinator window ===
# Note: interactive mode needs TTY, use send-keys to run in the tmux pane
tmux send-keys -t "$SESSION_NAME":0 "export PATH=$NODE_BIN:\$PATH && npx tsx $LAUNCHER_PATH --role=$ROLE --agent-id=$AGENT_ID --mode=interactive" Enter

# === STEP 3: Create additional windows ===
tmux new-window -t "$SESSION_NAME" -n 'lazygit' -c "$WORKDIR" 'lazygit'
tmux new-window -t "$SESSION_NAME" -n 'terminal' -c "$WORKDIR"

# === STEP 4: Set active window ===
tmux select-window -t "$SESSION_NAME":0
```

### Template: RPC Worker (No TTY needed)

```bash
# === CONFIGURATION ===
SESSION_NAME="<session-name>"
AGENT_ID="<agent-id>"
ROLE="<dev|reviewer|test|git|devops|security>"
WORKDIR="</path/to/working/directory>"
LAUNCHER_PATH="/Users/jescobar/code/cmd-center-v2/src/core/launcher.ts"
NODE_BIN="/Users/jescobar/.local/share/mise/installs/node/24.15.0/bin"
REPORT_TO="<parent-agent-id>"

# === Launch RPC agent ===
tmux new-session -d -s "$SESSION_NAME" -n 'worker' -c "$WORKDIR"
tmux send-keys -t "$SESSION_NAME":0 "export PATH=$NODE_BIN:\$PATH && npx tsx $LAUNCHER_PATH --role=$ROLE --agent-id=$AGENT_ID --mode=rpc --report-to=$REPORT_TO" Enter
```

### Common Window Configurations

**Config A: Coordinator + Lazygit + Terminal**
```bash
tmux new-session -d -s my-session -n 'coordinator' -c /work/dir
tmux send-keys -t my-session:0 "...launch coordinator..." Enter
tmux new-window -t my-session -n 'lazygit' -c /work/dir 'lazygit'
tmux new-window -t my-session -n 'terminal' -c /work/dir
tmux select-window -t my-session:0
```

**Config B: Multi-Agent Session (1 coordinator + N workers)**
```bash
# Coordinator
tmux new-session -d -s my-session -n 'coord' -c /work/dir
tmux send-keys -t my-session:0 "...launch coordinator..." Enter

# Worker 1
tmux split-window -t my-session:0 -c /work/dir
tmux send-keys -t my-session:0.1 "...launch dev-1..." Enter

# Worker 2
tmux split-window -t my-session:0 -c /work/dir
tmux send-keys -t my-session:0.2 "...launch dev-2..." Enter
```

---

## Post-Launch Validation

**MANDATORY:** After ANY agent launch, run these validations:

### 1. Check Registry
```bash
sqlite3 /tmp/fabric-agents/registry.sqlite "SELECT agent_id, role, status FROM agents WHERE agent_id='AGENT_ID';"
```
Expected: Shows `active` status

### 2. Check tmux Session
```bash
tmux list-sessions
tmux list-windows -t SESSION_NAME
tmux list-panes -s -t SESSION_NAME
```
Expected: Session exists, windows match configuration

### 3. Check Agent Directory (for manual tmux)
```bash
tmux capture-pane -pt SESSION_NAME:WINDOW_INDEX
tmux list-panes -s -t SESSION_NAME:WINDOW_INDEX -F '#{pane_current_path}'
```
Expected: Prompt shows correct working directory

### 4. Check Process
```bash
ps aux | grep AGENT_ID | grep -v grep
```
Expected: Node process running

**DO NOT report success to human until all validations pass.**

---

## Common Mistakes

### Mistake 1: Coordinator in RPC Mode
```yaml
# WRONG - coordinator needs interactive mode
role: coordinator
mode: rpc  # ❌ Coordinator won't have TTY

# CORRECT
role: coordinator
mode: interactive  # ✅ TTY allocated
```

### Mistake 2: Wrong Working Directory
```bash
# WRONG - launcher.ts not found
npx tsx src/core/launcher.ts  # ❌ From wrong directory

# CORRECT - absolute path
npx tsx /absolute/path/to/src/core/launcher.ts  # ✅ Always works
```

### Mistake 3: Missing Node Environment
```bash
# WRONG - tmux doesn't inherit shell env
tmux send-keys -t session:0 'npx tsx ...' Enter  # ❌ May use wrong node

# CORRECT - explicitly set PATH
tmux send-keys -t session:0 'export PATH=/path/to/node/bin:$PATH && npx tsx ...' Enter  # ✅
```

### Mistake 4: Assuming fabric_launch_agent Controls Layout
```yaml
# WRONG - session name not guaranteed
fabric_launch_agent:
  session: my-specific-session  # ❌ Launcher may ignore

# CORRECT - use manual tmux if layout matters
tmux new-session -s my-specific-session  # ✅ You control this
```

### Mistake 5: Not Validating
```bash
# WRONG - report success without checking
echo "Done!"  # ❌ Agent may have crashed

# CORRECT - validate first
sleep 2
tmux capture-pane -pt session:0  # Check output
sqlite3 ... "SELECT status FROM agents..."  # ✅ Confirm active
```

---

## Environment Setup

### Node/Path Discovery

Before launching, determine the correct environment:

```bash
# Node path
which node
# Output: /Users/jescobar/.local/share/mise/installs/node/24.15.0/bin/node

# Mise activation (if needed)
eval "$(mise activate zsh)"

# Launcher path (absolute)
ls /Users/jescobar/code/cmd-center-v2/src/core/launcher.ts
```

### Common Environment Variables

```bash
export ENABLE_CMD_CENTER=TRUE
export PATH=/Users/jescobar/.local/share/mise/installs/node/24.15.0/bin:$PATH
```

---

## Kill and Recreate Pattern

When replacing an existing session/agent cleanly:

```bash
# === STEP 1: Kill existing ===
pkill -f AGENT_ID || true
tmux kill-session -t SESSION_NAME 2>/dev/null || true

# === STEP 2: Verify cleanup ===
tmux list-sessions 2>/dev/null | grep SESSION_NAME || echo "Session killed"
sqlite3 /tmp/fabric-agents/registry.sqlite "DELETE FROM agents WHERE agent_id='AGENT_ID';" 2>/dev/null || true

# === STEP 3: Wait for cleanup ===
sleep 1

# === STEP 4: Create fresh ===
# ... follow Pattern A or B ...

# === STEP 5: Validate ===
# ... run validation checklist ...
```

---

## Quick Reference Card

```
ROLE           MODE           TTY?    LAYOUT CONTROL?
coordinator    interactive    YES     Use manual tmux
sub-coordinator interactive   YES     Use manual tmux
chat           interactive    YES     Use manual tmux
dev            rpc            NO      fabric_launch_agent OK
reviewer       rpc            NO      fabric_launch_agent OK
test           rpc            NO      fabric_launch_agent OK
git            rpc            NO      fabric_launch_agent OK
```

**Always validate after launch.**
**Ask about layout before launching.**
**Use absolute paths for launcher.ts.**
