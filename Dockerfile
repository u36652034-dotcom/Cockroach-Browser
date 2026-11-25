FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    x11vnc \
    fluxbox \
    novnc \
    websockify \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install Cockroach, the proxy, and mcp-proxy
RUN npm install -g cockroach-browser http-proxy mcp-proxy

ENV NODE_PATH=/usr/local/lib/node_modules
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROME_BIN=/usr/bin/chromium

# Fix Chromium crashpad and nssdb issues
ENV XDG_CONFIG_HOME=/tmp/.chromium
ENV XDG_CACHE_HOME=/tmp/.chromium

RUN useradd -m -s /bin/bash browser
USER browser
WORKDIR /home/browser

# Create directories for Chromium and Cockroach persistent profiles
RUN mkdir -p /home/browser/.local/share/pki/nssdb /tmp/.chromium /home/browser/.cockroach/profiles
RUN chown -R browser:browser /home/browser/.local /home/browser/.cockroach /tmp/.chromium

COPY --chown=browser:browser start.sh /home/browser/start.sh
COPY --chown=browser:browser proxy.js /home/browser/proxy.js
COPY --chown=browser:browser idle-killer.sh /home/browser/idle-killer.sh
RUN chmod +x /home/browser/start.sh /home/browser/idle-killer.sh

EXPOSE 8000
CMD ["bash", "/home/browser/start.sh"]FROM node:22-bookworm-slim

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
