#!/usr/bin/env bash
# Orchestrates the parallel branch of the production-readiness plan.
# - P5 (durable-memory), P6 (tool-activator), P8 (safe-defaults) run in
# isolated git worktrees on separate cursor-agent processes.
# - The critical path P1 → P2 → P3 → P4 → P7 remains in the main session
# and is NOT covered by this script.
#
# Usage:
# ./scripts/spawn-parallel-phases.sh # spawn all three
# ./scripts/spawn-parallel-phases.sh p5 # only P5
# ./scripts/spawn-parallel-phases.sh status # tail output files

set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR=".cursor/subagents-out"
mkdir -p "$OUT_DIR"
TS=$(date +%Y%m%d-%H%M%S)

spawn() {
  local name="$1" agent="$2" model="$3" worktree="$4"
  local log="$OUT_DIR/${name}-${TS}.jsonl"
  echo "[spawn] $name → $log (model=$model worktree=$worktree)"
  cursor-agent -p "/$agent execute the entire phase per the agent description and report when complete" \
    --model "$model" \
    --output-format stream-json \
    --force \
    --worktree "$worktree" \
    > "$log" 2>&1 &
  echo "$!" > "$OUT_DIR/${name}.pid"
}

case "${1:-all}" in
  p5)
    spawn p5-memory durable-memory-implementer gpt-5.3-codex-high p5-memory
    ;;
  p6)
    spawn p6-tools  tool-activator-implementer gpt-5.3-codex-high p6-tools
    ;;
  p8)
    spawn p8-safe   safe-defaults-implementer  gpt-5.3-codex      p8-safe
    ;;
  all)
    spawn p5-memory durable-memory-implementer gpt-5.3-codex-high p5-memory
    spawn p6-tools  tool-activator-implementer gpt-5.3-codex-high p6-tools
    spawn p8-safe   safe-defaults-implementer  gpt-5.3-codex      p8-safe
    echo "[spawn] all three launched; tail logs with: tail -f $OUT_DIR/*-${TS}.jsonl"
    ;;
  status)
    for pid_file in "$OUT_DIR"/*.pid; do
      [ -f "$pid_file" ] || continue
      pid=$(cat "$pid_file")
      name=$(basename "$pid_file" .pid)
      if kill -0 "$pid" 2>/dev/null; then
        echo "[running] $name (pid=$pid)"
      else
        echo "[done]    $name (pid=$pid)"
      fi
    done
    ;;
 *)
    echo "usage: $0 {p5|p6|p8|all|status}" >&2
    exit 64
    ;;
esac
