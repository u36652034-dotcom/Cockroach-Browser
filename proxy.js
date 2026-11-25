const httpProxy = require('http-proxy');
const http = require('http');

const proxy = httpProxy.createProxyServer({ ws: true });
const PORT = process.env.PORT || 8000; // Default to 8000 for Hostless

http.createServer((req, res) => {
    // Health check for Hostless
    if (req.url === '/' || req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
    }

    if (req.url.startsWith('/vnc')) {
        req.url = req.url.replace('/vnc', '') || '/';
        proxy.web(req, res, { target: 'http://127.0.0.1:6080' });
    } else {
        // Everything else goes to Cockroach MCP
        req.url = req.url.replace('/mcp', '') || '/';
        proxy.web(req, res, { target: 'http://127.0.0.1:43110' });
    }
}).on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/vnc')) {
        req.url = req.url.replace('/vnc', '') || '/';
        proxy.ws(req, socket, head, { target: 'ws://127.0.0.1:6080' });
    } else {
        socket.destroy();
    }
}).listen(PORT, '0.0.0.0', () => {
    console.log(`Proxy listening on port ${PORT}`);
});
