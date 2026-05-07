#!/bin/bash
# Fabric Agent Launcher — Helper para el Coordinator
# Uso: ./launch-agent.sh --role=<rol> --agent-id=<id> [--mode=interactive|rpc] [--model=<modelo>]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ROLE=""
AGENT_ID=""
MODE=""
MODEL=""
SESSION="fabric-default"

while [[ $# -gt 0 ]]; do
  case $1 in
    --role) ROLE="$2"; shift 2 ;;
    --agent-id) AGENT_ID="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --session) SESSION="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$ROLE" || -z "$AGENT_ID" ]]; then
  echo "Usage: $0 --role=<rol> --agent-id=<id> [--mode=interactive|rpc] [--model=<modelo>] [--session=<session>]"
  echo "Roles: coordinator, reviewer, devops, architect, chat"
  exit 1
fi

ARGS=(
  --role="$ROLE"
  --agent-id="$AGENT_ID"
  --session="$SESSION"
)

[[ -n "$MODE" ]] && ARGS+=(--mode="$MODE")
[[ -n "$MODEL" ]] && ARGS+=(--model="$MODEL")

cd "$REPO_ROOT"
export ENABLE_CMD_CENTER=TRUE
exec npx tsx src/core/launcher.ts "${ARGS[@]}"
