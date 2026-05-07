#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER_PATH="$SCRIPT_DIR/src/core/launcher.ts"

REPO_DIR="${REPO_DIR:-${1:-$(pwd)}}"
TASK_ID="${TASK_ID:-${2:-demo}}"
BRANCH_NAME="${BRANCH_NAME:-task/${TASK_ID}}"
WORKTREE_DIR="${WORKTREE_DIR:-$REPO_DIR/.worktrees/$TASK_ID}"
SESSION_NAME="${SESSION_NAME:-fabric-task-$TASK_ID}"
BASE_REF="${BASE_REF:-$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
PARENT_AGENT_ID="${FABRIC_PARENT_AGENT_ID:-boss}"
SUB_AGENT_ID="${SUB_AGENT_ID:-sub-boss-$TASK_ID}"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required but was not found in PATH"
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required but was not found in PATH"
  exit 1
fi

if [ ! -d "$REPO_DIR/.git" ] && [ ! -f "$REPO_DIR/.git" ]; then
  echo "REPO_DIR does not look like a git repository: $REPO_DIR"
  exit 1
fi

if [ ! -f "$LAUNCHER_PATH" ]; then
  echo "Could not find launcher at: $LAUNCHER_PATH"
  exit 1
fi

mkdir -p "$(dirname "$WORKTREE_DIR")"

echo "Creating worktree at $WORKTREE_DIR"
git -C "$REPO_DIR" worktree add "$WORKTREE_DIR" -b "$BRANCH_NAME" "$BASE_REF" \
  || git -C "$REPO_DIR" worktree add "$WORKTREE_DIR" "$BRANCH_NAME"

echo "Creating tmux session $SESSION_NAME"
tmux new-session -d -s "$SESSION_NAME" -c "$WORKTREE_DIR"

# Left pane: shell
tmux send-keys -t "$SESSION_NAME:0.0" "cd \"$WORKTREE_DIR\"" C-m

# Right pane top: sub-coordinator
tmux split-window -h -t "$SESSION_NAME:0.0" -c "$WORKTREE_DIR"
tmux send-keys -t "$SESSION_NAME:0.1" "export ENABLE_CMD_CENTER=TRUE" C-m
tmux send-keys -t "$SESSION_NAME:0.1" "export FABRIC_PARENT_AGENT_ID=$PARENT_AGENT_ID" C-m
tmux send-keys -t "$SESSION_NAME:0.1" "export FABRIC_TASK_ID=$TASK_ID" C-m
tmux send-keys -t "$SESSION_NAME:0.1" "npx tsx \"$LAUNCHER_PATH\" --role=sub-coordinator --agent-id=$SUB_AGENT_ID --mode=interactive --session=$SESSION_NAME --workspace-dir=\"$WORKTREE_DIR\" --report-to=$PARENT_AGENT_ID" C-m

# Right pane bottom: extra shell
tmux split-window -v -t "$SESSION_NAME:0.1" -c "$WORKTREE_DIR"

echo "Done"
echo "Session: $SESSION_NAME"
echo "Worktree: $WORKTREE_DIR"
echo "Attach with: tmux attach -t $SESSION_NAME"
