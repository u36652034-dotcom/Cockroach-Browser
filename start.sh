#!/bin/bash
# ... (Start Xvfb, fluxbox, x11vnc, noVNC as before)

# 5. Start Cockroach Browser
export HEADLESS=false
export DISPLAY=:99
export XDG_CONFIG_HOME=/tmp/.chromium
export XDG_CACHE_HOME=/tmp/.chromium
export CHROMIUM_ARGS="--no-sandbox --disable-gpu --disable-dev-shm-usage --disable-crash-reporter --user-data-dir=/tmp/chromium-data"

# Start the daemon directly (no mcp-proxy needed for the daemon itself)
npx cockroach-browser serve --host 0.0.0.0 --port 43110 > /home/browser/cockroach.log 2>&1 &

# 6. Start the Idle Killer Cron Job in the background
# (We will add a simple loop or use a lightweight cron)
bash /home/browser/idle-killer.sh &

# 7. Start the Proxy (which now also handles session creation/killing)
sleep 2
node /home/browser/proxy.js
