FROM node:22-bookworm-slim

# 1. Install minimal system dependencies (Runs as root)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    x11vnc \
    fluxbox \
    novnc \
    websockify \
    && rm -rf /var/lib/apt/lists/*

# 2. Install global npm packages AS ROOT (Fixes the EACCES error)
RUN npm install -g cockroach-browser http-proxy

# 3. Create the non-root user and switch to it
RUN useradd -m -s /bin/bash browser
USER browser
WORKDIR /home/browser

# 4. Tell Node where to find the global modules
ENV NODE_PATH=/usr/local/lib/node_modules

# 5. Copy the scripts and make them executable (giving ownership to the browser user)
COPY --chown=browser:browser start.sh /home/browser/start.sh
COPY --chown=browser:browser proxy.js /home/browser/proxy.js

# ... (previous lines remain the same)
# 6. Expose the port Hostless expects
EXPOSE 8000

# 7. Start the container
CMD ["bash", "/home/browser/start.sh"]
