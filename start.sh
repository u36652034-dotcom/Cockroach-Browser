#!/bin/bash
set -e

# 1. Start the virtual display (Xvfb)
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99

# 2. Start a window manager
fluxbox &

# 3. Start x11vnc
x11vnc -display :99 -nopw -listen 0.0.0.0 -forever &

# 4. Start noVNC internally on port 6080
websockify --web /usr/share/novnc 6080 localhost:5900 &

# 5. Start Cockroach Browser internally on port 43110
export COCKROACH_BROWSER_HOST=0.0.0.0
export COCKROACH_BROWSER_PORT=43110
npx cockroach-browser serve --host $COCKROACH_BROWSER_HOST --port $COCKROACH_BROWSER_PORT &

# 6. Start the proxy IN THE FOREGROUND on the Hostless $PORT
sleep 2
node /home/browser/proxy.js
