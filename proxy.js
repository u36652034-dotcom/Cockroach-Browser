const httpProxy = require('http-proxy');
const http = require('http');

const proxy = httpProxy.createProxyServer({ ws: true });
const PORT = process.env.PORT || 8000;

http.createServer((req, res) => {
    // 1. Health check
    if (req.url === '/' || req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
    }

    // 2. Forward to noVNC (Strip /vnc so it sees /vnc.html or /websockify)
    if (req.url.startsWith('/vnc')) {
        req.url = req.url.replace('/vnc', '') || '/';
        proxy.web(req, res, { target: 'http://127.0.0.1:6080' });
    } 
    // 3. Forward to Cockroach MCP
    else {
        req.url = req.url.replace('/mcp', '') || '/';
        proxy.web(req, res, { target: 'http://127.0.0.1:43110' });
    }
}).on('upgrade', (req, socket, head) => {
    // 4. WebSocket upgrade for noVNC (Strip /vnc)
    if (req.url.startsWith('/vnc')) {
        req.url = req.url.replace('/vnc', '') || '/';
        proxy.ws(req, socket, head, { target: 'ws://127.0.0.1:6080' });
    } else {
        socket.destroy();
    }
}).listen(PORT, '0.0.0.0', () => {
    console.log(`Proxy listening on port ${PORT}`);
});
