#!/usr/bin/env bash
# Shows / safely restarts the backend that listens on the API port (macOS and Linux; needs lsof).
#   bash scripts/backend-process.sh status    which process listens on the port: PID, folder, command, age, version
#   bash scripts/backend-process.sh restart   stop it ONLY if it is a node process started from THIS folder, then
#                                             start the current code with `npm start` (package.json) in the foreground
# A process from another folder or another program is never stopped: the script explains and exits.
set -u
cd "$(dirname "$0")/.." || exit 1
HERE="$(pwd -P)"
PORT="${PORT:-$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]"')}"
PORT="${PORT:-4001}"
command -v lsof >/dev/null || { echo "lsof is required"; exit 2; }

pids() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u; }
cwd_of() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }

describe() {
  local pid="$1"
  echo "  PID:      $pid"
  echo "  folder:   $(cwd_of "$pid")"
  echo "  command:  $(ps -o command= -p "$pid")"
  echo "  running:  $(ps -o etime= -p "$pid" | tr -d ' ') (dd-hh:mm:ss)"
}

version() {
  local body
  body="$(curl -s -m 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null)"
  if echo "$body" | grep -q '"status"'; then echo "  version:  CURRENT code (health: $body)";
  elif [ -n "$body" ]; then echo "  version:  OLD code - its /api/health answers $body (the current code answers with \"status\")";
  else echo "  version:  no answer on /api/health"; fi
}

case "${1:-status}" in
  status)
    list="$(pids)"
    if [ -z "$list" ]; then echo "Nothing listens on port $PORT."; exit 0; fi
    echo "Listening on port $PORT:"
    for p in $list; do describe "$p"; done
    version
    ;;
  restart)
    for p in $(pids); do
      dir="$(cwd_of "$p")"; cmd="$(ps -o command= -p "$p")"
      echo "Found on port $PORT:"; describe "$p"
      case "$cmd" in *node*) ;; *) echo "NOT stopping it: it is not a node process. Stop it yourself or change PORT."; exit 3;; esac
      if [ "$(cd "$dir" 2>/dev/null && pwd -P)" != "$HERE" ]; then
        echo "NOT stopping it: it was started from another folder ($dir), not from $HERE."
        echo "If it is an old copy of this backend, stop it there (Ctrl+C in its terminal) and run this task again."
        exit 3
      fi
      echo "Stopping PID $p (SIGTERM, the server closes its connections cleanly)..."
      kill -TERM "$p"
      for _ in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.5; done
      if kill -0 "$p" 2>/dev/null; then echo "PID $p did not stop within 10 s - stop it yourself (kill -9 $p) and run this again."; exit 4; fi
      echo "Stopped."
    done
    echo "Starting the current backend: npm start (node src/index.js) in $HERE"
    exec npm start
    ;;
  *) echo "usage: $0 status|restart"; exit 1;;
esac
