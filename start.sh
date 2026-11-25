#!/bin/bash

# 1. Start Xvfb
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99

# Wait for Xvfb
for i in $(seq 1 10); do
    if xdpyinfo -display :99 >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

# 2. Window manager & VNC
fluxbox &
x11vnc -display :99 -nopw -listen 0.0.0.0 -forever &
websockify --web /usr/share/novnc 6080 localhost:5900 &

# 3. Environment variables for Cockroach
export HEADLESS=false
export DISPLAY=:99
export XDG_CONFIG_HOME=/tmp/.chromium
export XDG_CACHE_HOME=/tmp/.chromium
export CHROMIUM_ARGS="--no-sandbox --disable-gpu --disable-dev-shm-usage --disable-crash-reporter --user-data-dir=/tmp/chromium-data"

# 4. Start Cockroach Daemon (Handles sessions and browser execution)
npx cockroach-browser serve --host 0.0.0.0 --port 43110 > /home/browser/cockroach.log 2>&1 &

# 5. Start MCP Server wrapped in mcp-proxy (Agent connects here)
sleep 2
mcp-proxy --port 43111 -- npx -y cockroach-browser mcp >> /home/browser/cockroach.log 2>&1 &

# 6. Start Idle Session Killer
bash /home/browser/idle-killer.sh &

# 7. Start Proxy Gateway (Foreground)
sleep 2
node /home/browser/proxy.js
