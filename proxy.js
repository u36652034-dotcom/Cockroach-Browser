const httpProxy = require('http-proxy');
const http = require('http');

const proxy = httpProxy.createProxyServer({ ws: true });
const PORT = process.env.PORT || 8000;

http.createServer((req, res) => {
    // Health check
    if (req.url === '/' || req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
    }

    // Proxy noVNC under /vnc without stripping the prefix
    if (req.url.startsWith('/vnc')) {
        // noVNC's WebSocket endpoint is /vnc/websockify
        // Everything else under /vnc is a static file
        proxy.web(req, res, { target: 'http://127.0.0.1:6080' });
    } else {
        // All other paths go to Cockroach MCP
        proxy.web(req, res, { target: 'http://127.0.0.1:43110' });
    }
}).on('upgrade', (req, socket, head) => {
    // WebSocket upgrade for noVNC
    if (req.url.startsWith('/vnc')) {
        proxy.ws(req, socket, head, { target: 'ws://127.0.0.1:6080' });
    } else {
        socket.destroy();
    }
}).listen(PORT, '0.0.0.0', () => {
    console.log(`Proxy listening on port ${PORT}`);
});
