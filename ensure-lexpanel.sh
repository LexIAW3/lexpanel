#!/usr/bin/env bash
# Ensures the LexPanel service (Vite preview) is running on port 8090.
# Safe to run from cron or from ensure-running.sh.
set -euo pipefail

LEXPANEL_PORT=8090
LEXPANEL_BASE_URL="http://127.0.0.1:$LEXPANEL_PORT"
LEXPANEL_DIR="/home/paperclip/despacho/lexpanel"
LOG_FILE="/tmp/lexreclama-watchdog.log"

log() {
  echo "[$(date)] [lexpanel] $*" >> "$LOG_FILE"
}

is_lexpanel_up() {
  local status
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$LEXPANEL_BASE_URL/" 2>/dev/null || true)"
  [[ "$status" == "200" ]]
}

free_port() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    kill $pids 2>/dev/null || true
    sleep 1
    local still_up
    still_up="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$still_up" ]]; then
      kill -9 $still_up 2>/dev/null || true
    fi
  fi
}

restart_lexpanel() {
  log "LexPanel down on :$LEXPANEL_PORT. Restarting via vite preview."

  free_port "$LEXPANEL_PORT"

  cd "$LEXPANEL_DIR"
  nohup npm run preview >> /tmp/lexpanel-server.log 2>&1 &

  local new_pid=$!
  sleep 2

  if is_lexpanel_up; then
    log "LexPanel restarted successfully (PID $new_pid)."
    return 0
  fi

  log "Restart attempted (PID $new_pid) but LexPanel health check failed."
  return 1
}

if ! is_lexpanel_up; then
  restart_lexpanel
else
  log "LexPanel OK on :$LEXPANEL_PORT."
fi
