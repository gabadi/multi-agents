#!/bin/bash
set -e

REPO_DIR="$HOME/code/core-financial-platform"
TASK_ID="18"
BRANCH_NAME="task/18-loan-transfer-v2"
WORKTREE_DIR="$HOME/worktrees/core-financial-platform-task-$TASK_ID"
SESSION_NAME="fabric-task-$TASK_ID"

echo "Creating worktree at $WORKTREE_DIR..."
mkdir -p "$HOME/worktrees"
cd "$REPO_DIR"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_NAME" master || git worktree add "$WORKTREE_DIR" "$BRANCH_NAME"

cd "$WORKTREE_DIR"

echo "Creating tmux session $SESSION_NAME..."
tmux new-session -d -s "$SESSION_NAME" -c "$WORKTREE_DIR"

# Left pane: lazygit
tmux send-keys -t "$SESSION_NAME:0.0" "lazygit" C-m

# Right pane top: sub-coordinator
tmux split-window -h -t "$SESSION_NAME:0.0" -c "$WORKTREE_DIR"
tmux send-keys -t "$SESSION_NAME:0.1" "export ENABLE_CMD_CENTER=TRUE" C-m
tmux send-keys -t "$SESSION_NAME:0.1" "export FABRIC_PARENT_AGENT_ID=boss" C-m
tmux send-keys -t "$SESSION_NAME:0.1" "export FABRIC_TASK_ID=$TASK_ID" C-m
tmux send-keys -t "$SESSION_NAME:0.1" "npx tsx $HOME/code/cmd-center-v2/src/core/launcher.ts --role=sub-coordinator --agent-id=sub-boss-$TASK_ID --mode=interactive --session=$SESSION_NAME --workspace-dir=\"$WORKTREE_DIR\"" C-m

# Right pane bottom: bash console
tmux split-window -v -t "$SESSION_NAME:0.1" -c "$WORKTREE_DIR"

echo "Session created! You can attach to it with:"
echo "tmux attach -t $SESSION_NAME"
