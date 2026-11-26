FROM node:22-bookworm-slim

# 1. System deps (root). fonts-liberation: otherwise web pages render with no text.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium xvfb x11vnc novnc \
    fonts-liberation ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

# 2. Node tools (root). Pinned to the version the CLI flags in start.sh were checked against.
RUN npm install -g cockroach-browser@0.4.1 http-proxy ws mcp-proxy && npm cache clean --force

ENV NODE_PATH=/usr/local/lib/node_modules \
    XDG_CONFIG_HOME=/tmp/.chromium \
    XDG_CACHE_HOME=/tmp/.chromium

# 3. Non-root user + writable dirs
RUN useradd -m -s /bin/bash browser \
    && mkdir -p /tmp/.chromium /home/browser/.cockroach-browser /home/browser/.local/share/pki/nssdb \
    && chown -R browser:browser /tmp/.chromium /home/browser
USER browser
WORKDIR /home/browser

COPY --chown=browser:browser start.sh proxy.js /home/browser/
RUN chmod +x /home/browser/start.sh

EXPOSE 8000
CMD ["bash", "/home/browser/start.sh"]
