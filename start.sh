#!/bin/bash
# Everything logs to stdout/stderr so it shows up in the hostless log viewer.
set -u

export PORT="${PORT:-8000}"
# stale cockroach env vars from the hosting dashboard would override our token file; drop them (mcp gets its own below)
for v in $(env | grep -o '^COCKROACH_BROWSER_[A-Z_]*'); do echo "[start] ignoring env var $v from hosting settings"; unset "$v"; done
export MALLOC_ARENA_MAX=2   # glibc: fewer per-thread arenas = noticeably lower RSS
export DISPLAY=:99
export HOME=/home/browser
SCREEN="${SCREEN:-1280x720x16}"            # 16-bit colour: less RAM and less VNC traffic
START_URL="${START_URL:-about:blank}"
ENABLE_COCKROACH="${ENABLE_COCKROACH:-0}"  # 1 = also run cockroach daemon + MCP (~+300MB)
export ENABLE_COCKROACH START_URL SCREEN
export LOG_DIR=/tmp/logs; mkdir -p "$LOG_DIR"   # per-process logs, read by diag.js (/diag endpoint + [diag] lines)
# /home/browser is not writable for new subfolders on hostless (mkdir ENOENT), /tmp is
export COCKROACH_ROOT=/tmp/cockroach
TOKEN_FILE="$COCKROACH_ROOT/auth-token"
# NOTE: the package does nothing when started through its bin symlink, so always run it via node + real path
export COCKROACH_CLI="${COCKROACH_CLI:-$(npm root -g)/cockroach-browser/dist/cli.js}"
export COCKROACH_TOKEN_FILE="$TOKEN_FILE"

log() { echo "[start] $*"; }
run() { local name="$1"; shift; ( "$@" 2>&1 | tee -a "$LOG_DIR/$name.log" | sed -u "s/^/[$name] /" ) & }
mem_limit() { cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo unknown; }
mem_used()  { cat /sys/fs/cgroup/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null || echo unknown; }

log "ENABLE_COCKROACH=$ENABLE_COCKROACH cli=$COCKROACH_CLI exists=$([ -f "$COCKROACH_CLI" ] && echo yes || echo NO)"
log "PORT=$PORT cpus=$(nproc) memory_limit_bytes=$(mem_limit)"

# ---- secrets. Login for the desktop page: user "admin" (or $BASIC_USER) + $VNC_PASSWORD (any length)
VNC_PASSWORD="${VNC_PASSWORD:-Osman@7878}"   # hardcoded default; a VNC_PASSWORD env var overrides it
if [ -z "${MCP_API_KEY:-}" ];  then MCP_API_KEY="$(openssl rand -hex 16)"; log "generated MCP_API_KEY=$MCP_API_KEY (header: X-API-Key)"; fi
export VNC_PASSWORD MCP_API_KEY
# real chromium binary for API sessions (the daemon refuses symlinks)
CHROMIUM_PATH="$(command -v chromium)"; [ -L "$CHROMIUM_PATH" ] && CHROMIUM_PATH="$(readlink -f "$CHROMIUM_PATH")"
export CHROMIUM_PATH; log "chromium path for sessions: $CHROMIUM_PATH"

# ---- 1. gateway first so the health check passes immediately
node --max-old-space-size=48 /home/browser/proxy.js &
PROXY_PID=$!

# ---- 2. virtual display (no window manager: one Chromium window fills the screen)
run xvfb Xvfb :99 -screen 0 "$SCREEN" -nolisten tcp -noreset -ac
for i in $(seq 1 30); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.5; done
[ -S /tmp/.X11-unix/X99 ] && log "X display ready" || log "ERROR: Xvfb did not start"

# ---- 3. VNC: loopback only, no VNC password (the gateway does the login)
run x11vnc x11vnc -display :99 -rfbport 5900 -localhost -nopw -forever -shared -noxdamage -nowf -noscr -wait 40 -defer 40 -quiet

# ---- 4. noVNC files are served by the gateway itself (no python websockify process)
[ -f /usr/share/novnc/vnc.html ] || log "WARNING: /usr/share/novnc/vnc.html missing: $(ls /usr/share/novnc 2>&1 | tr '\n' ' ')"

# ---- 5. Chromium, low-memory flags, restarts if it dies
mkdir -p /tmp/chromium-data /tmp/chromium-cache
(
  while true; do
    chromium \
      --no-sandbox --test-type --no-first-run --no-default-browser-check --disable-crash-reporter \
      --disable-gpu --disable-vulkan --disable-software-rasterizer --disable-dev-shm-usage \
      --no-zygote --enable-low-end-device-mode --disable-breakpad --disable-hang-monitor --renderer-process-limit=2 \
      --disable-features=site-per-process,IsolateOrigins,Translate,MediaRouter,BackForwardCache,OptimizationHints \
      --js-flags=--max-old-space-size=192 --mute-audio \
      --disable-background-networking --disable-component-update --disable-sync --disable-extensions \
      --user-data-dir=/tmp/chromium-data --disk-cache-dir=/tmp/chromium-cache --disk-cache-size=33554432 \
      --window-position=0,0 --window-size=1280,720 \
      "$START_URL" 2>&1 | grep --line-buffered -v -i 'dbus\|gcm\|fontconfig\|zygote_host\|nss_util\|vkCreateInstance\|CheckVkSuccess\|dawn' | tee -a "$LOG_DIR/chromium.log" | sed -u 's/^/[chromium] /'
    log "chromium exited, restarting in 3s"; sleep 3
  done
) &

# ---- 6. optional cockroach daemon (loopback only) + MCP, heap-capped
if [ "$ENABLE_COCKROACH" = "1" ]; then
  export NODE_OPTIONS="--max-old-space-size=96"
  mkdir -p "$COCKROACH_ROOT"
  run cockroach node "$COCKROACH_CLI" serve --host 127.0.0.1 --port 43110 --root "$COCKROACH_ROOT" --token-file "$TOKEN_FILE" --allow-session-host-config
  for i in $(seq 1 60); do [ -s "$TOKEN_FILE" ] && break; sleep 1; done
  if [ -s "$TOKEN_FILE" ]; then
    run mcp env COCKROACH_BROWSER_URL=http://127.0.0.1:43110 COCKROACH_BROWSER_TOKEN="$(tr -d '\n' < "$TOKEN_FILE")" \
      mcp-proxy --host 127.0.0.1 --port 43111 --apiKey "$MCP_API_KEY" -- node "$COCKROACH_CLI" mcp
  else
    log "ERROR: cockroach daemon never wrote $TOKEN_FILE (see [cockroach] lines)"
  fi
  unset NODE_OPTIONS
fi

# ---- 7. deep diagnostics: full report in this log ~60s and ~300s after boot (also live at /diag)
( sleep 60; node /home/browser/diag.js 2>&1 | sed -u 's/^/[diag] /'; sleep 240; node /home/browser/diag.js 2>&1 | sed -u 's/^/[diag] /' ) &
# keep per-process log files small (truncate in place, processes keep appending)
( while true; do sleep 300; for f in "$LOG_DIR"/*.log; do [ -f "$f" ] && [ "$(stat -c %s "$f")" -gt 1048576 ] && { tail -c 262144 "$f" > "$f.tmp"; cat "$f.tmp" > "$f"; rm -f "$f.tmp"; }; done; done ) &

# ---- 8. memory heartbeat (every 5 min, quiet)
( while true; do sleep 300; log "memory used=$(mem_used) limit=$(mem_limit)"; done ) &

log "all started; gateway pid $PROXY_PID"
wait "$PROXY_PID"
