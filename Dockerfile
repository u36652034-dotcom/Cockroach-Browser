FROM node:22-bookworm-slim

# 1. INSTALL SYSTEM DEPENDENCIES AS ROOT
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

# 2. INSTALL GLOBAL NPM PACKAGES AS ROOT
RUN npm install -g cockroach-browser http-proxy mcp-proxy

# 3. SET ENVIRONMENT VARIABLES
ENV NODE_PATH=/usr/local/lib/node_modules
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROME_BIN=/usr/bin/chromium
ENV XDG_CONFIG_HOME=/tmp/.chromium
ENV XDG_CACHE_HOME=/tmp/.chromium

# 4. CREATE USER AND DIRECTORIES
RUN useradd -m -s /bin/bash browser
RUN mkdir -p /home/browser/.local/share/pki/nssdb /tmp/.chromium /home/browser/.cockroach/profiles
RUN chown -R browser:browser /home/browser/.local /home/browser/.cockroach /tmp/.chromium

# 5. SWITCH TO NON-ROOT USER
USER browser
WORKDIR /home/browser

# 6. COPY SCRIPTS AND MAKE THEM EXECUTABLE
COPY --chown=browser:browser start.sh /home/browser/start.sh
COPY --chown=browser:browser proxy.js /home/browser/proxy.js
COPY --chown=browser:browser idle-killer.sh /home/browser/idle-killer.sh
RUN chmod +x /home/browser/start.sh /home/browser/idle-killer.sh

# 7. EXPOSE AND RUN
EXPOSE 8000
CMD ["bash", "/home/browser/start.sh"]
