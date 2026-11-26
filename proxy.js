'use strict';
/**
 * Public gateway. Listens on $PORT (hostless injects it) and fans out to:
 *   /healthz            -> answered here (never touches a backend)
 *   /                   -> tiny page that redirects to noVNC (also answers 200 for health checks)
 *   /websockify  (WS)   -> noVNC websocket   127.0.0.1:6080
 *   /mcp, /sse          -> mcp-proxy         127.0.0.1:43111   (protected by X-API-Key)
 *   /api/session/*      -> cockroach CLI wrapper                (protected by X-API-Key)
 *   everything else     -> noVNC static files 127.0.0.1:6080   (vnc.html, app/, core/, vendor/ ...)
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const httpProxy = require('http-proxy');

const PORT = parseInt(process.env.PORT || '8000', 10);
const NOVNC = 'http://127.0.0.1:6080';
const NOVNC_WS = 'ws://127.0.0.1:6080';
const MCP = 'http://127.0.0.1:43111';
const MCP_WS = 'ws://127.0.0.1:43111';
const API_KEY = process.env.MCP_API_KEY || '';
const BASIC_USER = process.env.BASIC_USER || 'admin';
const BASIC_PASS = process.env.VNC_PASSWORD || '';
const COCKROACH_URL = process.env.COCKROACH_BROWSER_URL || 'http://127.0.0.1:43110';
const TOKEN_FILE =
  process.env.COCKROACH_TOKEN_FILE || path.join(os.homedir(), '.cockroach-browser', 'auth-token');

const proxy = httpProxy.createProxyServer({ ws: true });
proxy.on('open', () => console.log('[gateway] websocket to noVNC opened'));
proxy.on('close', () => console.log('[gateway] websocket closed'));

proxy.on('error', (err, req, res) => {
  console.error(`[gateway] upstream error for ${req && req.url}: ${err.message}`);
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Upstream not reachable yet (${err.code || err.message}). Check the app logs.\n`);
  } else if (res && typeof res.destroy === 'function') {
    res.destroy(); // websocket socket
  }
});

function probe(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 800 });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

function authorized(req) {
  if (!API_KEY) return false; // API disabled unless a key is configured
  const given = req.headers['x-api-key'] || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// HTTP Basic login for the desktop (page + websocket). No 8-char VNC limit, no x11vnc lockouts.
const SESSION = crypto.createHash('sha256').update(`${BASIC_USER}:${BASIC_PASS}:session-v1`).digest('hex');
const COOKIE = `bsess=${SESSION}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`;
function safeEq(x, y) {
  const a = Buffer.from(String(x)), b = Buffer.from(String(y));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Accepts either the Basic header or the session cookie (cookies are always sent on websocket handshakes).
function basicOk(req) {
  if (!BASIC_PASS) return false; // fail closed
  const m = /(?:^|;\s*)bsess=([0-9a-f]{64})/.exec(req.headers.cookie || '');
  if (m && safeEq(m[1], SESSION)) return 'cookie';
  return false;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cli(args, cb) {
  // execFile (no shell) -> no command injection through ids or bodies
  execFile('cockroach-browser', [...args, '--url', COCKROACH_URL, '--token-file', TOKEN_FILE],
    { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, cb);
}

const landing = `<!doctype html><meta charset="utf-8"><title>Cockroach Browser</title>
<meta http-equiv="refresh" content="0; url=/vnc.html?autoconnect=true&resize=scale&path=websockify&quality=4&compression=7">
<a href="/vnc.html?autoconnect=true&resize=scale&path=websockify&quality=4&compression=7">Open the browser (noVNC)</a>`;

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const pathname = url.split('?')[0];

  if (pathname === '/healthz') {
    if (url.includes('deep=1')) {
      const [novnc, vnc, daemon, mcp] = await Promise.all([6080, 5900, 43110, 43111].map(probe));
      return json(res, 200, { gateway: true, novnc, vnc, cockroachDaemon: daemon, mcpProxy: mcp });
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok\n');
  }

  if (pathname === '/login') {
    const page = (msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Login</title>
<body style="font-family:sans-serif;background:#222;color:#eee;display:flex;height:100vh;align-items:center;justify-content:center;margin:0">
<form method="POST" action="/login" style="display:flex;flex-direction:column;gap:12px;width:260px">
<b style="font-size:20px">Browser login</b>${msg ? `<span style="color:#f77">${msg}</span>` : ''}
<input type="password" name="password" placeholder="Password" autofocus style="padding:10px;font-size:16px">
<button style="padding:10px;font-size:16px">Sign in</button></form></body>`;
    if (req.method === 'POST') {
      let pw = '';
      try { pw = new URLSearchParams(await readBody(req, 4096)).get('password') || ''; } catch (e) { /* ignore */ }
      if (BASIC_PASS && safeEq(pw, BASIC_PASS)) {
        res.writeHead(302, { 'Set-Cookie': COOKIE, Location: '/vnc.html?autoconnect=true&resize=scale&path=websockify&quality=4&compression=7' });
        return res.end();
      }
      console.log('[gateway] failed login attempt');
      await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page('Wrong password'));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page(''));
  }

  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(landing);
  }

  if (pathname === '/mcp' || pathname.startsWith('/mcp/') || pathname === '/sse' || pathname === '/messages') {
    return proxy.web(req, res, { target: MCP });
  }

  if (pathname === '/api/session/create' && req.method === 'POST') {
    if (!authorized(req)) return json(res, 401, { error: 'missing or invalid X-API-Key' });
    let tmp;
    try {
      const body = await readBody(req);
      JSON.parse(body); // validate
      tmp = path.join(os.tmpdir(), `session-${crypto.randomUUID()}.json`);
      fs.writeFileSync(tmp, body, { mode: 0o600 });
    } catch (e) {
      return json(res, 400, { error: `invalid JSON body: ${e.message}` });
    }
    return cli(['session', 'create', '--config', tmp], (err, stdout, stderr) => {
      fs.rm(tmp, { force: true }, () => {});
      if (err) return json(res, 500, { error: (stderr || err.message).trim() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(stdout);
    });
  }

  if (pathname.startsWith('/api/session/kill/') && req.method === 'DELETE') {
    if (!authorized(req)) return json(res, 401, { error: 'missing or invalid X-API-Key' });
    const id = decodeURIComponent(pathname.split('/').pop());
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) return json(res, 400, { error: 'bad session id' });
    return cli(['session', 'close', '--id', id], (err, _o, stderr) =>
      json(res, err ? 500 : 200, { success: !err, message: err ? (stderr || err.message).trim() : 'Session killed' }));
  }

  if (pathname.startsWith('/api/')) return json(res, 404, { error: 'unknown api route' });

  // Default: noVNC static files (vnc.html, app/*, core/*, vendor/*, package.json, ...)
  if (!basicOk(req)) {
    res.writeHead(302, { Location: '/login' });
    return res.end();
  }
  if (pathname.startsWith('/websockify')) {
    console.log(`[gateway] PLAIN HTTP ${req.method} ${pathname} (no websocket upgrade seen) upgrade-hdr=${req.headers.upgrade || '-'} connection-hdr=${req.headers.connection || '-'}`);
  }
  res.setHeader('Set-Cookie', COOKIE);
  return proxy.web(req, res, { target: NOVNC });
});

server.on('upgrade', (req, socket, head) => {
  socket.on('error', (err) => console.error('[gateway] socket error:', err.message));
  const p = (req.url || '').split('?')[0];
  if (p.startsWith('/websockify')) {
    const how = basicOk(req);
    console.log(`[gateway] websocket upgrade ${p} auth=${how || 'REJECTED'} origin=${req.headers.origin || '-'}`);
    if (!how) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
    return proxy.ws(req, socket, head, { target: NOVNC_WS });
  }
  if (p === '/mcp' || p.startsWith('/mcp/') || p === '/sse') return proxy.ws(req, socket, head, { target: MCP_WS });
  socket.destroy();
});

server.on('error', (e) => { console.error('[gateway] fatal:', e.message); process.exit(1); });
process.on('uncaughtException', (e) => console.error('[gateway] uncaught:', e));

server.listen(PORT, '0.0.0.0', () => console.log(`[gateway] listening on 0.0.0.0:${PORT}`));
