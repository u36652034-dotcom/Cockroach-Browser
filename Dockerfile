FROM node:22-bookworm-slim

# 1. Install minimal system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    x11vnc \
    fluxbox \
    novnc \
    websockify \
    && rm -rf /var/lib/apt/lists/*

# 2. Set up a non-root user
RUN useradd -m -s /bin/bash browser
USER browser
WORKDIR /home/browser

# 3. Install Cockroach Browser AND http-proxy globally
RUN npm install -g cockroach-browser http-proxy

# 4. Tell Node where to find global modules
ENV NODE_PATH=/usr/local/lib/node_modules

# 5. Copy the startup script and the proxy script
COPY start.sh /home/browser/start.sh
COPY proxy.js /home/browser/proxy.js

# 6. Expose default port (Hostless will override with $PORT)
EXPOSE 3000

# 7. Start the container
CMD ["bash", "/home/browser/start.sh"]
