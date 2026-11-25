FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    x11vnc \
    fluxbox \
    novnc \
    websockify \
    && rm -rf /var/lib/apt/lists/*

# Install Cockroach, the proxy, and mcp-proxy globally
RUN npm install -g cockroach-browser http-proxy mcp-proxy

ENV NODE_PATH=/usr/local/lib/node_modules
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROME_BIN=/usr/bin/chromium

RUN useradd -m -s /bin/bash browser
USER browser
WORKDIR /home/browser

COPY --chown=browser:browser start.sh /home/browser/start.sh
COPY --chown=browser:browser proxy.js /home/browser/proxy.js

EXPOSE 8000
CMD ["bash", "/home/browser/start.sh"]
