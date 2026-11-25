#!/bin/bash
set -e

# 1. Virtual display
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99

# 2. Window manager
fluxbox &

# 3. VNC server (with auth guess to avoid MIT-MAGIC-COOKIE issues)
x11vnc -display :99 -auth guess -nopw -listen 0.0.0.0 -forever &

# 4. noVNC websockify — serve static files under /vnc and WebSocket at /vnc/websockify
websockify --web /usr/share/novnc 6080 localhost:5900 &

# 5. Cockroach Browser
export COCKROACH_BROWSER_HOST=0.0.0.0
export COCKROACH_BROWSER_PORT=43110
npx cockroach-browser serve --host $COCKROACH_BROWSER_HOST --port $COCKROACH_BROWSER_PORT &

# 6. Proxy (foreground)
sleep 2
node /home/browser/proxy.js
