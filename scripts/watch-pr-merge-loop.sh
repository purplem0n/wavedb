#!/usr/bin/env bash
# Watch an open dev→main PR until CI + CodeRabbit are idle, then wake the agent.
# Used by /loop and merge-autopilot flows (see .cursor/rules/coderabbit-pr-loop.mdc).
#
# Usage:
#   ./scripts/watch-pr-merge-loop.sh <pr-number> [--wait]
#   PR=6 ./scripts/watch-pr-merge-loop.sh --wait
#
# With --wait: block until ready (run in Shell with high block_until_ms, e.g. 900000).
# Without --wait: print one status line and exit 0 (for quick checks).
#
# Wake line (stdout): AGENT_LOOP_WAKE_pr-merge {"pr":N,"reason":"...","prompt":"..."}

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_FILE="$ROOT/scripts/.pr-loop-state.json"
PID_FILE="$ROOT/scripts/.pr-loop-watch.pid"
SENTINEL="AGENT_LOOP_WAKE_pr-merge"
POLL_SECS="${POLL_SECS:-20}"
REQUIRED_CI=(rust native-and-ts)
REQUIRED_BOT="CodeRabbit"

PR="${PR:-${1:-}}"
WAIT=0
if [[ "${1:-}" == "--wait" ]]; then
  WAIT=1
  PR="${PR:-${2:-}}"
elif [[ "${2:-}" == "--wait" ]]; then
  WAIT=1
fi

if [[ -z "$PR" ]]; then
  echo "Usage: $0 <pr-number> [--wait]  (or PR=<n> $0 --wait)" >&2
  exit 2
fi

DEFAULT_PROMPT="PR merge loop on #${PR}: run coderabbit-pr-loop.mdc steps A–G (outside-diff included). Fix on dev, push, resolve threads; gh pr merge ${PR} --merge if merge-ready and the user authorized merge in this loop."

write_state() {
  local phase="$1"
  local reason="$2"
  local head="${3:-}"
  mkdir -p "$(dirname "$STATE_FILE")"
  printf '%s\n' "{\"pr\":${PR},\"headRefOid\":\"${head}\",\"phase\":\"${phase}\",\"reason\":\"${reason}\",\"updatedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >"$STATE_FILE"
}

emit_wake() {
  local reason="$1"
  local prompt="${2:-$DEFAULT_PROMPT}"
  local head
  head="$(gh pr view "$PR" --json headRefOid --jq .headRefOid 2>/dev/null || echo "")"
  write_state "wake" "$reason" "$head"
  # JSON-escape prompt for single-line payload (minimal: escape backslash and double-quote)
  local esc
  esc=$(printf '%s' "$prompt" | sed 's/\\/\\\\/g; s/"/\\"/g')
  echo "${SENTINEL} {\"pr\":${PR},\"headRefOid\":\"${head}\",\"reason\":\"${reason}\",\"prompt\":\"${esc}\"}"
}

check_status() {
  local ci_pending=0 ci_fail=0 ci_pass=0 bot_pending=0 bot_fail=0 bot_done=0
  local line name status _rest checks_out

  # gh exits 8 while required checks are pending; output is still usable.
  checks_out=$(gh pr checks "$PR" 2>&1) || true
  if [[ -z "$checks_out" ]]; then
    echo "gh_error"
    return 0
  fi
  if printf '%s\n' "$checks_out" | grep -qiE '^(HTTP |GraphQL:|failed to )'; then
    echo "gh_error"
    return 0
  fi

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    name=$(printf '%s' "$line" | awk '{print $1}')
    status=$(printf '%s' "$line" | awk '{print $2}')
    case "$status" in
      pass | success)
        for c in "${REQUIRED_CI[@]}"; do
          [[ "$name" == "$c" ]] && ci_pass=$((ci_pass + 1))
        done
        ;;
      pending | queued | in_progress)
        if [[ "$name" == "$REQUIRED_BOT" ]]; then bot_pending=1; fi
        for c in "${REQUIRED_CI[@]}"; do
          [[ "$name" == "$c" ]] && ci_pending=1
        done
        ;;
      fail | failure | cancelled | timed_out)
        if [[ "$name" == "$REQUIRED_BOT" ]]; then bot_fail=1; fi
        for c in "${REQUIRED_CI[@]}"; do
          [[ "$name" == "$c" ]] && ci_fail=1
        done
        ;;
      *) ;;
    esac
    if [[ "$name" == "$REQUIRED_BOT" ]] && [[ "$status" == "pass" || "$status" == "success" ]]; then
      bot_done=1
    fi
  done <<< "$checks_out"

  if [[ "$ci_fail" -eq 1 ]]; then
    echo "ci_fail"
    return 0
  fi
  if [[ "$bot_fail" -eq 1 ]]; then
    echo "coderabbit_fail"
    return 0
  fi
  if [[ "$ci_pending" -eq 1 ]] || [[ "$ci_pass" -lt ${#REQUIRED_CI[@]} ]]; then
    echo "waiting_ci"
    return 0
  fi
  if [[ "$bot_pending" -eq 1 ]]; then
    echo "waiting_coderabbit"
    return 0
  fi
  if [[ "$bot_done" -eq 1 ]]; then
    echo "ready_to_triage"
    return 0
  fi
  if [[ "$bot_pending" -eq 0 ]] && [[ "$bot_fail" -eq 0 ]]; then
    # CodeRabbit check not present on repo — CI green is enough to triage/merge
    echo "ready_to_triage"
    return 0
  fi
  echo "waiting_coderabbit"
}

maybe_watch_ci_run() {
  local url run_id
  url="$(gh pr view "$PR" --json statusCheckRollup --jq '.statusCheckRollup[] | select(.name=="rust" and .status!="COMPLETED") | .detailsUrl' 2>/dev/null | head -1)"
  [[ -z "$url" ]] && return 0
  run_id="$(printf '%s' "$url" | sed -n 's|.*/actions/runs/\([0-9]*\)/.*|\1|p')"
  [[ -z "$run_id" ]] && return 0
  gh run watch "$run_id" --exit-status 2>/dev/null || true
}

if [[ "$WAIT" -eq 0 ]]; then
  phase="$(check_status)"
  write_state "status" "$phase"
  printf 'status=%s pr=%s\n' "$phase" "$PR"
  exit 0
fi

echo $$ >"$PID_FILE"
trap 'rm -f "$PID_FILE"' EXIT

head="$(gh pr view "$PR" --json headRefOid --jq .headRefOid)"
write_state "watching" "started" "$head"

while true; do
  phase="$(check_status)"
  write_state "watching" "$phase" "$(gh pr view "$PR" --json headRefOid --jq .headRefOid 2>/dev/null || echo "")"

  case "$phase" in
    waiting_ci)
      maybe_watch_ci_run
      ;;
    gh_error)
      emit_wake "gh_error" "PR #${PR} gh pr checks failed — retry triage; verify auth and network."
      exit 0
      ;;
    ci_fail)
      emit_wake "ci_fail" "PR #${PR} CI failed — read logs, fix on dev, push, then re-arm watch or continue loop."
      exit 0
      ;;
    coderabbit_fail)
      emit_wake "coderabbit_fail" "PR #${PR} CodeRabbit check failed — triage review on GitHub and fix or dismiss on dev."
      exit 0
      ;;
    waiting_coderabbit)
      ;;
    ready_to_triage)
      emit_wake "ready_to_triage" "$DEFAULT_PROMPT"
      exit 0
      ;;
  esac

  sleep "$POLL_SECS"
done
