#!/bin/bash
set -e

# 1. Start the virtual display (Xvfb) on display :99
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99

# 2. Start a window manager (optional but recommended for usable interaction)
fluxbox &

# 3. Start x11vnc to serve the display on port 5900
#    (No password for simplicity; add one for production security)
x11vnc -display :99 -nopw -listen 0.0.0.0 -forever &

# 4. Start noVNC to bridge VNC to the web on port 6080
websockify --web /usr/share/novnc 6080 localhost:5900 &

# 5. Start the Cockroach Browser daemon in HEADED mode
#    It will listen on the port defined by Hostless (default 43110 if unset)
export COCKROACH_BROWSER_HOST=0.0.0.0
export COCKROACH_BROWSER_PORT=${PORT:-43110}
npx cockroach-browser serve --host $COCKROACH_BROWSER_HOST --port $COCKROACH_BROWSER_PORT &

# Keep the container running
wait
