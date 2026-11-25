#!/bin/bash

# 1. Start Xvfb
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99

# 2. Wait for Xvfb to be ready
for i in $(seq 1 10); do
    if xdpyinfo -display :99 >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

# 3. Window manager & VNC
fluxbox &
x11vnc -display :99 -nopw -listen 0.0.0.0 -forever &

# 4. noVNC (serves on 6080)
websockify --web /usr/share/novnc 6080 localhost:5900 &

# 5. Cockroach Browser via mcp-proxy (serves on 43110)
export HEADLESS=false
export DISPLAY=:99
mcp-proxy --port 43110 -- npx -y cockroach-browser > /home/browser/cockroach.log 2>&1 &

# 6. Proxy (foreground)
sleep 2
node /home/browser/proxy.js
