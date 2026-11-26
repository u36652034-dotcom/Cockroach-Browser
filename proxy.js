'use strict';
/**
 * Single lightweight gateway (replaces python websockify + separate static server).
 *   /healthz, /healthz?deep=1   health check (open)
 *   /login                      password-only login (sets a cookie)
 *   /wstest                     browser self-test for websockets (open)
 *   /wsecho   (WS)              echo endpoint used by /wstest (open)
 *   /websockify (WS)            bridge to x11vnc on 127.0.0.1:5900 (login required)
 *   /mcp, /sse                  mcp-proxy 127.0.0.1:43111 (X-API-Key)
 *   /api/session/*              cockroach CLI wrapper (X-API-Key)
 *   everything else             noVNC static files from /usr/share/novnc (login required)
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const httpProxy = require('http-proxy');
const { WebSocketServer } = require('ws');

const VERSION = 6;
const PORT = parseInt(process.env.PORT || '8000', 10);
const VNC_PORT = 5900;
const NOVNC_ROOT = path.resolve(process.env.NOVNC_ROOT || '/usr/share/novnc');
const MCP = 'http://127.0.0.1:43111';
const MCP_WS = 'ws://127.0.0.1:43111';
const API_KEY = process.env.MCP_API_KEY || '';
const PASSWORD = process.env.VNC_PASSWORD || '';
const COCKROACH_CLI = process.env.COCKROACH_CLI || '/usr/local/lib/node_modules/cockroach-browser/dist/cli.js';
const COCKROACH_URL = process.env.COCKROACH_BROWSER_URL || 'http://127.0.0.1:43110';
const TOKEN_FILE =
  process.env.COCKROACH_TOKEN_FILE || path.join(os.homedir(), '.cockroach-browser', 'auth-token');
const DESKTOP = '/vnc.html?autoconnect=true&resize=scale&path=websockify&quality=4&compression=7';

// ---------- auth (password only) ----------
const SESSION = crypto.createHash('sha256').update(`${PASSWORD}:session-v1`).digest('hex');
const COOKIE = `bsess=${SESSION}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`;
function safeEq(x, y) {
  const a = Buffer.from(String(x)), b = Buffer.from(String(y));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function loggedIn(req) {
  if (!PASSWORD) return false; // fail closed
  const m = /(?:^|;\s*)bsess=([0-9a-f]{64})/.exec(req.headers.cookie || '');
  return Boolean(m && safeEq(m[1], SESSION));
}
function apiAuthorized(req) {
  return Boolean(API_KEY) && safeEq(req.headers['x-api-key'] || '', API_KEY);
}

// ---------- helpers ----------
const mcpProxy = httpProxy.createProxyServer({ ws: true });
mcpProxy.on('error', (err, req, res) => {
  console.error(`[gateway] mcp upstream error: ${err.message}`);
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('MCP not running (set ENABLE_COCKROACH=1).\n');
  } else if (res && typeof res.destroy === 'function') res.destroy();
});

function probe(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 800 });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function cli(args, cb) {
  execFile('node', [COCKROACH_CLI, ...args, '--url', COCKROACH_URL, '--token-file', TOKEN_FILE],
    { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, cb);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain', '.map': 'application/json'
};
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { res.writeHead(400); return res.end('bad path'); }
  if (rel.includes('\0')) { res.writeHead(400); return res.end('bad path'); }
  const file = path.join(NOVNC_ROOT, path.normalize('/' + rel)); // normalize('/'+x) cannot climb above root
  if (!file.startsWith(NOVNC_ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      console.log(`[gateway] 404 ${pathname}`);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found\n');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'public, max-age=3600'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

// ---------- pages ----------
const landing = `<!doctype html><meta charset="utf-8"><title>Cockroach Browser</title>
<meta http-equiv="refresh" content="0; url=${DESKTOP}"><a href="${DESKTOP}">Open the browser</a>`;

const loginPage = (msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Login</title>
<body style="font-family:sans-serif;background:#222;color:#eee;display:flex;height:100vh;align-items:center;justify-content:center;margin:0">
<form method="POST" action="/login" style="display:flex;flex-direction:column;gap:12px;width:260px">
<b style="font-size:20px">Browser login</b>${msg ? `<span style="color:#f77">${msg}</span>` : ''}
<input type="password" name="password" placeholder="Password" autofocus style="padding:10px;font-size:16px">
<button style="padding:10px;font-size:16px">Sign in</button></form></body>`;

const wsTestPage = `<!doctype html><meta charset="utf-8"><title>WebSocket test</title>
<body style="font-family:monospace;background:#111;color:#ddd;padding:20px"><h3>WebSocket self-test (gateway v${VERSION})</h3><pre id="o"></pre>
<script>
const o = document.getElementById('o'); const log = (m) => { o.textContent += m + '\\n'; };
const base = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
function t(name, url, bin) { return new Promise((resolve) => {
  let done = false; const s = new WebSocket(url, bin ? ['binary'] : []); s.binaryType = 'arraybuffer';
  const fin = (m) => { if (done) return; done = true; log(name + ': ' + m); try { s.close(); } catch (e) {} resolve(); };
  s.onopen = () => log(name + ': connection opened');
  s.onmessage = (e) => fin('OK - got "' + (typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data).trim().slice(0, 12)) + '"');
  s.onerror = () => fin('FAILED (error event)'); s.onclose = (ev) => fin('closed before data, code ' + ev.code);
  setTimeout(() => fin('TIMEOUT after 8s'), 8000); }); }
(async () => {
  await t('1) edge + gateway  (/wsecho)   ', base + '/wsecho', false);
  await t('2) desktop         (/websockify)', base + '/websockify', true);
  log('\\nIf 1 fails: hostless blocks websockets. If 1 works and 2 fails: log in at /login first, or x11vnc is down.');
})();
</script>`;

// ---------- http ----------
const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const pathname = url.split('?')[0];

  if (pathname === '/healthz') {
    if (url.includes('deep=1')) {
      const [vnc, daemon, mcp] = await Promise.all([VNC_PORT, 43110, 43111].map(probe));
      const probe43110 = daemon;
      return json(res, 200, { gateway: VERSION, x11vnc: vnc, cockroachDaemon: daemon, mcpProxy: mcp, novncRoot: fs.existsSync(path.join(NOVNC_ROOT, 'vnc.html')), chromiumPath: process.env.CHROMIUM_PATH || null, cockroachEnabled: probe43110 });
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok\n');
  }

  if (pathname === '/login') {
    if (req.method === 'POST') {
      let pw = '';
      try { pw = new URLSearchParams(await readBody(req, 4096)).get('password') || ''; } catch (e) { /* ignore */ }
      if (PASSWORD && safeEq(pw, PASSWORD)) {
        console.log('[gateway] login ok');
        res.writeHead(302, { 'Set-Cookie': COOKIE, Location: DESKTOP });
        return res.end();
      }
      console.log('[gateway] failed login attempt');
      await new Promise((r) => setTimeout(r, 1000));
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(loginPage('Wrong password'));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(loginPage(''));
  }

  if (pathname === '/wstest') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(wsTestPage); }
  if (pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(landing); }

  if (pathname === '/mcp' || pathname.startsWith('/mcp/') || pathname === '/sse' || pathname === '/messages') {
    return mcpProxy.web(req, res, { target: MCP });
  }

  if (pathname === '/api/session/create' && req.method === 'POST') {
    if (!apiAuthorized(req)) return json(res, 401, { error: 'missing or invalid X-API-Key' });
    let tmp;
    try {
      const body = await readBody(req);
      JSON.parse(body);
      tmp = path.join(os.tmpdir(), `session-${crypto.randomUUID()}.json`);
      fs.writeFileSync(tmp, body, { mode: 0o600 });
    } catch (e) { return json(res, 400, { error: `invalid JSON body: ${e.message}` }); }
    return cli(['session', 'create', '--config', tmp], (err, stdout, stderr) => {
      fs.rm(tmp, { force: true }, () => {});
      if (err) return json(res, 500, { error: (stderr || err.message).trim() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(stdout);
    });
  }
  if (pathname.startsWith('/api/session/kill/') && req.method === 'DELETE') {
    if (!apiAuthorized(req)) return json(res, 401, { error: 'missing or invalid X-API-Key' });
    const id = decodeURIComponent(pathname.split('/').pop());
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) return json(res, 400, { error: 'bad session id' });
    return cli(['session', 'close', '--id', id], (err, _o, stderr) =>
      json(res, err ? 500 : 200, { success: !err, message: err ? (stderr || err.message).trim() : 'Session killed' }));
  }
  if (pathname.startsWith('/api/')) return json(res, 404, { error: 'unknown api route' });

  if (pathname.startsWith('/websockify')) {
    console.log(`[gateway] PLAIN HTTP ${req.method} ${pathname}: no websocket upgrade arrived (upgrade-hdr=${req.headers.upgrade || '-'}). The edge is not forwarding websockets.`);
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    return res.end('Websocket upgrade required\n');
  }

  if (!loggedIn(req)) { res.writeHead(302, { Location: '/login' }); return res.end(); }
  return serveStatic(req, res, pathname);
});

// ---------- websockets ----------
const echoWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const vncWss = new WebSocketServer({
  noServer: true, perMessageDeflate: false, maxPayload: 8 * 1024 * 1024,
  handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false)
});

function bridge(ws) {
  const tcp = net.connect({ host: '127.0.0.1', port: VNC_PORT });
  tcp.setNoDelay(true);
  let up = 0, down = 0, closed = false;
  const end = (why) => {
    if (closed) return; closed = true;
    console.log(`[gateway] desktop session closed (${why}) up=${up}B down=${down}B`);
    tcp.destroy(); try { ws.close(); } catch (e) { /* ignore */ }
  };
  tcp.on('connect', () => console.log('[gateway] desktop session: connected to x11vnc'));
  tcp.on('data', (d) => {
    if (ws.readyState !== 1) return;
    down += d.length;
    ws.send(d, { binary: true }, () => { if (tcp.isPaused() && ws.bufferedAmount < (1 << 20)) tcp.resume(); });
    if (ws.bufferedAmount > (4 << 20)) tcp.pause(); // backpressure on a slow client
  });
  ws.on('message', (d) => { up += d.length; if (!tcp.destroyed) tcp.write(d); });
  tcp.on('error', (e) => end(`x11vnc error: ${e.message}`));
  tcp.on('close', () => end('x11vnc closed'));
  ws.on('error', (e) => end(`ws error: ${e.message}`));
  ws.on('close', () => end('browser closed'));
}

server.on('upgrade', (req, socket, head) => {
  socket.on('error', (err) => console.error('[gateway] socket error:', err.message));
  const p = (req.url || '').split('?')[0];

  if (p === '/wsecho') {
    console.log('[gateway] websocket test (/wsecho) reached the gateway');
    return echoWss.handleUpgrade(req, socket, head, (ws) => { ws.on('error', () => {}); ws.send('hello from gateway'); });
  }
  if (p.startsWith('/websockify')) {
    const ok = loggedIn(req);
    console.log(`[gateway] websocket /websockify login=${ok ? 'ok' : 'REJECTED'} protocols=${req.headers['sec-websocket-protocol'] || '-'}`);
    if (!ok) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
    return vncWss.handleUpgrade(req, socket, head, bridge);
  }
  if (p === '/mcp' || p.startsWith('/mcp/') || p === '/sse') return mcpProxy.ws(req, socket, head, { target: MCP_WS });
  socket.destroy();
});

// keep idle desktop sessions alive through proxies
setInterval(() => { for (const ws of vncWss.clients) { try { ws.ping(); } catch (e) { /* ignore */ } } }, 30000).unref();

server.on('error', (e) => { console.error('[gateway] fatal:', e.message); process.exit(1); });
process.on('uncaughtException', (e) => console.error('[gateway] uncaught:', e));
server.listen(PORT, '0.0.0.0', () => console.log(`[gateway] v${VERSION} listening on 0.0.0.0:${PORT}`));
