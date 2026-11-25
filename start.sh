#!/bin/bash
set -e

# 1. Start the virtual display (Xvfb) on display :99
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99

# 2. Start a window manager
fluxbox &

# 3. Start x11vnc to serve the display on port 5900
x11vnc -display :99 -nopw -listen 0.0.0.0 -forever &

# 4. Start noVNC to bridge VNC to the web on port 6080
websockify --web /usr/share/novnc 6080 localhost:5900 &

# 5. Start Cockroach Browser daemon and save logs
export COCKROACH_BROWSER_HOST=0.0.0.0
export COCKROACH_BROWSER_PORT=${PORT:-43110}

# We use nohup and redirect output to a log file
nohup npx cockroach-browser serve --host $COCKROACH_BROWSER_HOST --port $COCKROACH_BROWSER_PORT > /home/browser/cockroach.log 2>&1 &

# 6. KEEP THE CONTAINER ALIVE
# This infinite command prevents the container from exiting
tail -f /dev/null
