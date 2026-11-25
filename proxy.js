const httpProxy = require('http-proxy');
const http = require('http');
const { exec } = require('child_process');

const proxy = httpProxy.createProxyServer({ ws: true });
const PORT = process.env.PORT || 8000;

http.createServer((req, res) => {
    // 1. Route VNC
    if (req.url === '/' || req.url.startsWith('/vnc.html') || req.url.startsWith('/app') || req.url.startsWith('/core')) {
        proxy.web(req, res, { target: 'http://127.0.0.1:6080', changeOrigin: true });
        return;
    }

    // 2. Route WebSocket for VNC
    if (req.url.startsWith('/websockify')) {
        proxy.web(req, res, { target: 'http://127.0.0.1:6080', changeOrigin: true });
        return;
    }

    // 3. Agent Session Management API (Create/Kill)
    if (req.url === '/api/session/create' && req.method === 'POST') {
        // Creates a session with a persistent profile for cookie saving
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

    // 4. Route MCP (The agent connects here)
    if (req.url.startsWith('/mcp')) {
        proxy.web(req, res, { target: 'http://127.0.0.1:43111', changeOrigin: true });
        return;
    }

    // Fallback
    res.writeHead(404);
    res.end('Not found');
}).on('upgrade', (req, socket, head) => {
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
