#!/bin/bash
set -e

# 1. Start the virtual display (Xvfb)
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99

# 2. WAIT for Xvfb to be ready
echo "Waiting for Xvfb to start..."
for i in $(seq 1 10); do
    if xdpyinfo -display :99 >/dev/null 2>&1; then
        echo "Xvfb is ready!"
        break
    fi
    echo "Attempt $i/10: Xvfb not ready, waiting 1 second..."
    sleep 1
done

# 3. Start the window manager
fluxbox &

# 4. Start x11vnc (now that the display is guaranteed to be ready)
x11vnc -display :99 -nopw -listen 0.0.0.0 -forever &

# 5. Start noVNC internally on port 6080
websockify --web /usr/share/novnc 6080 localhost:5900 &

# 6. Start Cockroach Browser internally on port 43110
export COCKROACH_BROWSER_HOST=0.0.0.0
export COCKROACH_BROWSER_PORT=43110
npx cockroach-browser serve --host $COCKROACH_BROWSER_HOST --port $COCKROACH_BROWSER_PORT &

# 7. Start the proxy IN THE FOREGROUND
sleep 2
node /home/browser/proxy.js
