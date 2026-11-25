#!/bin/bash
# Everything logs to stdout/stderr so it shows up in the hostless log viewer.
set -u

export PORT="${PORT:-8000}"
export DISPLAY=:99
export HOME=/home/browser
SCREEN="${SCREEN:-1280x720x24}"
START_URL="${START_URL:-about:blank}"
ENABLE_COCKROACH="${ENABLE_COCKROACH:-0}"   # set to 1 only after VNC works (needs ~250MB more RAM)
TOKEN_FILE="$HOME/.cockroach-browser/auth-token"
export COCKROACH_TOKEN_FILE="$TOKEN_FILE"

log() { echo "[start] $*"; }
# run NAME cmd args... : background process, every output line prefixed with NAME
run() { local name="$1"; shift; ( "$@" 2>&1 | sed -u "s/^/[$name] /" ) & }

mem_limit() { cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo unknown; }
mem_used()  { cat /sys/fs/cgroup/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null || echo unknown; }

log "PORT=$PORT cpus=$(nproc) memory_limit_bytes=$(mem_limit)"

# ---- secrets (set VNC_PASSWORD / MCP_API_KEY in hostless env vars to choose your own)
if [ -z "${VNC_PASSWORD:-}" ]; then VNC_PASSWORD="$(openssl rand -hex 6)"; log "generated VNC_PASSWORD=$VNC_PASSWORD (set the env var to make it permanent)"; fi
if [ -z "${MCP_API_KEY:-}" ];  then MCP_API_KEY="$(openssl rand -hex 16)"; log "generated MCP_API_KEY=$MCP_API_KEY (header: X-API-Key)"; fi
export MCP_API_KEY

# ---- 1. gateway FIRST so the platform health check passes immediately
node /home/browser/proxy.js &
PROXY_PID=$!

# ---- 2. virtual display (no xdpyinfo in the image, so wait for the X socket)
Xvfb :99 -screen 0 "$SCREEN" -nolisten tcp -ac 2>&1 | sed -u 's/^/[xvfb] /' &
for i in $(seq 1 30); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.5; done
[ -S /tmp/.X11-unix/X99 ] && log "X display ready" || log "ERROR: Xvfb did not start"

run fluxbox fluxbox

# ---- 3. VNC (password protected, only reachable through the gateway)
x11vnc -storepasswd "$VNC_PASSWORD" /tmp/vncpass >/dev/null 2>&1
run x11vnc x11vnc -display :99 -rfbport 5900 -localhost -rfbauth /tmp/vncpass -forever -shared -noxdamage -wait 30 -defer 30

# ---- 4. noVNC web client
[ -f /usr/share/novnc/vnc.html ] || log "WARNING: /usr/share/novnc/vnc.html missing: $(ls /usr/share/novnc 2>&1 | tr '\n' ' ')"
run websockify websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900

# ---- 5. Chromium on the virtual display (restarts if it dies / is OOM-killed)
mkdir -p /tmp/chromium-data /tmp/chromium-cache
(
  while true; do
    chromium \
      --no-sandbox --test-type --disable-gpu --disable-dev-shm-usage \
      --no-first-run --no-default-browser-check --disable-crash-reporter \
      --user-data-dir=/tmp/chromium-data --disk-cache-dir=/tmp/chromium-cache --disk-cache-size=33554432 \
      --window-position=0,0 --window-size=1280,720 \
      --renderer-process-limit=2 --js-flags=--max-old-space-size=256 \
      --disable-background-networking --disable-component-update --disable-sync \
      "$START_URL" 2>&1 | grep --line-buffered -v -i 'dbus\|gcm\|Fontconfig' | sed -u 's/^/[chromium] /'
    log "chromium exited, restarting in 3s"; sleep 3
  done
) &

# ---- 6. optional: cockroach daemon (loopback only -- it refuses 0.0.0.0 without TLS) + MCP
if [ "$ENABLE_COCKROACH" = "1" ]; then
  mkdir -p "$(dirname "$TOKEN_FILE")"
  run cockroach cockroach-browser serve --host 127.0.0.1 --port 43110 --token-file "$TOKEN_FILE"
  for i in $(seq 1 60); do [ -s "$TOKEN_FILE" ] && break; sleep 1; done
  if [ -s "$TOKEN_FILE" ]; then
    run mcp env COCKROACH_BROWSER_URL=http://127.0.0.1:43110 COCKROACH_BROWSER_TOKEN="$(tr -d '\n' < "$TOKEN_FILE")" \
      mcp-proxy --host 127.0.0.1 --port 43111 --apiKey "$MCP_API_KEY" -- cockroach-browser mcp
  else
    log "ERROR: cockroach daemon never wrote $TOKEN_FILE (see [cockroach] lines above)"
  fi
fi

# ---- 7. memory heartbeat: tells you how close to the limit you are
( while true; do sleep 60; log "memory used=$(mem_used) limit=$(mem_limit)"; done ) &

log "all started; gateway pid $PROXY_PID"
wait "$PROXY_PID"
