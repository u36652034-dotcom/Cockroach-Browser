const httpProxy = require('http-proxy');
const http = require('http');

const proxy = httpProxy.createProxyServer({ ws: true });
const PORT = process.env.PORT || 8000;

http.createServer((req, res) => {
    // Route /mcp to Cockroach Browser
    if (req.url.startsWith('/mcp')) {
        req.url = req.url.replace('/mcp', '') || '/';
        proxy.web(req, res, { target: 'http://127.0.0.1:43110', changeOrigin: true });
    } 
    // Route EVERYTHING ELSE to noVNC
    else {
        proxy.web(req, res, { target: 'http://127.0.0.1:6080', changeOrigin: true });
    }
}).on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/mcp')) {
        socket.destroy();
    } else {
        // Forward WebSocket connections to noVNC
        proxy.ws(req, socket, head, { target: 'ws://127.0.0.1:6080', changeOrigin: true });
    }
}).listen(PORT, '0.0.0.0', () => {
    console.log(`Proxy listening on port ${PORT}`);
});
