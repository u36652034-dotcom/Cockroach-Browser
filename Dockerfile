FROM node:22-bookworm-slim

# 1. Install minimal system dependencies
# - chromium: the browser
# - xvfb, x11vnc, fluxbox: the virtual display stack
# - novnc, websockify: the web-based VNC client
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    x11vnc \
    fluxbox \
    novnc \
    websockify \
    && rm -rf /var/lib/apt/lists/*

# 2. Set up a non-root user for security
RUN useradd -m -s /bin/bash browser
USER browser
WORKDIR /home/browser

# 3. Install Cockroach Browser globally
RUN npm install -g cockroach-browser

# 4. Install the local proxy dependency (http-proxy)
# Copying package.json first allows Docker to cache this step
COPY package.json ./
RUN npm install

# 5. Copy the startup script and the proxy script
COPY start.sh /home/browser/start.sh
COPY proxy.js /home/browser/proxy.js
RUN chmod +x /home/browser/start.sh

# 6. Expose the fallback port (Hostless will override this with its $PORT variable)
EXPOSE 3000

# 7. Start the container
CMD ["/home/browser/start.sh"]
