FROM node:22-bookworm-slim

# Install system dependencies: Chromium, Xvfb, x11vnc, noVNC, and a minimal window manager
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    x11vnc \
    fluxbox \
    novnc \
    websockify \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user (Hostless runs as a non-root user, but we set one up for clarity)
RUN useradd -m -s /bin/bash browser
USER browser
WORKDIR /home/browser

# Install Cockroach Browser globally
RUN npm install -g cockroach-browser

# Expose the ports:
# 43110 -> Cockroach Browser daemon (for MCP & SDK)
# 6080  -> noVNC web interface (for manual viewing)
EXPOSE 43110 6080

# Copy the startup script
COPY start.sh /home/browser/start.sh
RUN chmod +x /home/browser/start.sh

CMD ["/home/browser/start.sh"]
