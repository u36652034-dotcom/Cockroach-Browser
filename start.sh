#!/bin/bash

# 1. Start Xvfb
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99

for i in $(seq 1 10); do
    if xdpyinfo -display :99 >/dev/null 2>&1; then break; fi
    sleep 1
done

# 2. Window manager & VNC (Added -auth guess for stability)
fluxbox &
x11vnc -display :99 -auth guess -nopw -listen 0.0.0.0 -forever > /home/browser/x11vnc.log 2>&1 &

# 3. noVNC
websockify --web /usr/share/novnc 6080 localhost:5900 > /home/browser/websockify.log 2>&1 &

# 4. Cockroach Daemon
export HEADLESS=false
export DISPLAY=:99
export XDG_CONFIG_HOME=/tmp/.chromium
export XDG_CACHE_HOME=/tmp/.chromium
export CHROMIUM_ARGS="--no-sandbox --disable-gpu --disable-dev-shm-usage --disable-crash-reporter --user-data-dir=/tmp/chromium-data"

npx cockroach-browser serve --host 0.0.0.0 --port 43110 > /home/browser/cockroach-daemon.log 2>&1 &

# 5. MCP Proxy (Fixed command: removed the double dash, added logs)
sleep 3
mcp-proxy --port 43111 npx -y cockroach-browser mcp > /home/browser/mcp-proxy.log 2>&1 &

# 6. Idle Killer
bash /home/browser/idle-killer.sh &

# 7. Proxy Gateway (Foreground)
sleep 2
node /home/browser/proxy.js
