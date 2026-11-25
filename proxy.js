const httpProxy = require('http-proxy');
const http = require('http');
const { exec } = require('child_process');

const proxy = httpProxy.createProxyServer({ ws: true });
const PORT = process.env.PORT || 8000;

// CRITICAL FIX: Prevent proxy.js from crashing if a target is down
proxy.on('error', (err, req, res) => {
    console.error('Proxy error:', err.message);
    if (res && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Proxy error: target service unreachable');
    }
});

http.createServer((req, res) => {
    // 1. Route VNC static files
    if (req.url === '/' || req.url.startsWith('/vnc.html') || req.url.startsWith('/app') || req.url.startsWith('/core')) {
        proxy.web(req, res, { target: 'http://127.0.0.1:6080', changeOrigin: true });
        return;
    }

    // 2. Route WebSocket for VNC
    if (req.url.startsWith('/websockify')) {
        proxy.web(req, res, { target: 'http://127.0.0.1:6080', changeOrigin: true });
        return;
    }

    // 3. Agent Session Management API
    if (req.url === '/api/session/create' && req.method === 'POST') {
        exec('npx cockroach-browser session create --profile default --json', (err, stdout) => {
            res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
            res.end(err ? JSON.stringify({ error: err.message }) : stdout);
        });
        return;
    }

    if (req.url.startsWith('/api/session/kill/') && req.method === 'DELETE') {
        const sessionId = req.url.split('/').pop();
        exec(`npx cockroach-browser session close --id ${sessionId}`, (err) => {
            res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: !err, message: err ? err.message : "Session killed" }));
        });
        return;
    }

    // 4. Route MCP
    if (req.url.startsWith('/mcp')) {
        proxy.web(req, res, { target: 'http://127.0.0.1:43111', changeOrigin: true });
        return;
    }

    res.writeHead(404);
    res.end('Not found');
}).on('upgrade', (req, socket, head) => {
    // Prevent socket crashes
    socket.on('error', (err) => console.error('Socket error:', err.message));

    if (req.url.startsWith('/websockify')) {
        proxy.ws(req, socket, head, { target: 'ws://127.0.0.1:6080', changeOrigin: true });
    } else if (req.url.startsWith('/mcp')) {
        proxy.ws(req, socket, head, { target: 'ws://127.0.0.1:43111', changeOrigin: true });
    } else {
        socket.destroy();
    }
}).listen(PORT, '0.0.0.0', () => {
    console.log(`Proxy listening on port ${PORT}`);
});
