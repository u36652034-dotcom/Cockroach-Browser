'use strict';
/**
 * Deep server-side diagnostics.
 *   - GET /diag on the gateway (needs the desktop login cookie OR X-API-Key) returns this report as text.
 *   - start.sh also runs `node diag.js` ~60s and ~300s after boot and prints it into the hostless log with a [diag] prefix.
 * It never prints secrets (passwords, API key, daemon token are redacted).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const util = require('util');
const { execFile } = require('child_process');

const LOG_DIR = process.env.LOG_DIR || '/tmp/logs';
const HOME = process.env.HOME || os.homedir();
const CLI = process.env.COCKROACH_CLI || '/usr/local/lib/node_modules/cockroach-browser/dist/cli.js';
const ROOT = process.env.COCKROACH_ROOT || path.join(HOME, '.cockroach-browser');
const TOKEN_FILE = process.env.COCKROACH_TOKEN_FILE || path.join(ROOT, 'auth-token');

// ---- in-memory ring of the gateway's own console output (only filled when used inside the gateway)
const ring = [];
function captureConsole() {
  for (const k of ['log', 'error', 'warn']) {
    const orig = console[k].bind(console);
    console[k] = (...a) => {
      ring.push(`${new Date().toISOString().slice(11, 19)} ${util.format(...a)}`);
      if (ring.length > 300) ring.shift();
      orig(...a);
    };
  }
}

// ---- helpers
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
function tail(p, bytes = 8000, lines = 40) {
  try {
    const st = fs.statSync(p);
    const len = Math.min(st.size, bytes);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(p, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return { size: st.size, text: buf.toString('utf8').split('\n').slice(-lines).join('\n').trim() };
  } catch (e) { return null; }
}
function run(cmd, args, timeout = 10000) {
  return new Promise((resolve) => {
    const t = Date.now();
    execFile(cmd, args, { timeout, maxBuffer: 1 << 20, env: process.env }, (err, so, se) => resolve({
      code: err ? (err.code != null ? err.code : (err.signal || 1)) : 0,
      timedOut: Boolean(err && err.killed),
      ms: Date.now() - t,
      out: (so || '').trim().slice(0, 1500),
      err: (se || '').trim().slice(0, 1500)
    }));
  });
}
function finfo(p) {
  try {
    const l = fs.lstatSync(p);
    const type = l.isSymbolicLink() ? `SYMLINK -> ${fs.readlinkSync(p)}` : l.isDirectory() ? 'dir' : 'file';
    return `${p}: ${type}, size=${l.size}, mode=${(l.mode & 0o777).toString(8)}, uid=${l.uid}`;
  } catch (e) { return `${p}: MISSING (${e.code})`; }
}
function probe(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 800 });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}
function httpGet(url, headers = {}) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers, timeout: 3000 }, (res) => {
      let b = ''; res.on('data', (c) => { if (b.length < 600) b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 400) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
  });
}
function listeners() {
  const set = new Set();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const t = read(f); if (!t) continue;
    for (const line of t.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c[3] === '0A') set.add(parseInt(c[1].split(':')[1], 16));
    }
  }
  return [...set].sort((a, b) => a - b);
}
function procs() {
  const out = [];
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)); } catch (e) { return out; }
  for (const pid of pids) {
    const st = read(`/proc/${pid}/status`); if (!st) continue;
    const rss = /VmRSS:\s+(\d+)/.exec(st), name = /Name:\s+(\S+)/.exec(st), ppid = /PPid:\s+(\d+)/.exec(st), state = /State:\s+(\S)/.exec(st);
    const cmd = (read(`/proc/${pid}/cmdline`) || '').split('\0').join(' ').trim();
    out.push({ pid: +pid, ppid: ppid ? +ppid[1] : 0, state: state ? state[1] : '?', rssMB: rss ? Math.round(rss[1] / 1024) : 0, name: name ? name[1] : '?', cmd: cmd.slice(0, 150) });
  }
  return out.sort((a, b) => b.rssMB - a.rssMB);
}
function cgroup() {
  const g = (f) => (read(`/sys/fs/cgroup/${f}`) || '').trim();
  const v1 = (f) => (read(`/sys/fs/cgroup/memory/${f}`) || '').trim();
  const events = {};
  for (const l of g('memory.events').split('\n')) { const [k, v] = l.split(' '); if (k) events[k] = +v; }
  const cpu = {};
  for (const l of g('cpu.stat').split('\n')) { const [k, v] = l.split(' '); if (k) cpu[k] = +v; }
  return {
    memMax: g('memory.max') || v1('memory.limit_in_bytes') || 'unknown',
    memCur: g('memory.current') || v1('memory.usage_in_bytes') || 'unknown',
    events, cpuMax: g('cpu.max') || 'unknown', cpu
  };
}
const mb = (n) => (Number.isFinite(+n) ? `${Math.round(+n / 1048576)}MB` : String(n));

// ---- the report
async function report() {
  const L = [];
  const add = (s = '') => L.push(s);
  const H = (t) => { add(); add(`=== ${t} ===`); };
  const findings = [];

  const env = process.env;
  const secrets = [env.VNC_PASSWORD, env.MCP_API_KEY].filter((s) => s && s.length >= 4);
  const tokenRaw = (read(TOKEN_FILE) || '').trim();
  if (tokenRaw) secrets.push(tokenRaw);

  const ports = await Promise.all([5900, 43110, 43111].map(probe));
  const [vncUp, daemonUp, mcpUp] = ports;
  const listening = listeners();
  const ps = procs();
  const cg = cgroup();
  const files = {
    cli: finfo(CLI), token: finfo(TOKEN_FILE), chromium: finfo(env.CHROMIUM_PATH || '/usr/bin/chromium'),
    novnc: finfo('/usr/share/novnc/vnc.html'), xsock: finfo('/tmp/.X11-unix/X99'), dataDir: finfo(ROOT)
  };

  add(`DIAG REPORT  ${new Date().toISOString()}  (uptime of this process ${Math.round(process.uptime())}s, host uptime ${Math.round(os.uptime())}s)`);

  H('IDENTITY / ENV');
  add(`node ${process.version}, pid ${process.pid}, uid ${process.getuid ? process.getuid() : '?'}, HOME=${HOME}, cwd=${process.cwd()}`);
  add(`ENABLE_COCKROACH=${env.ENABLE_COCKROACH === undefined ? '(unset -> start.sh defaults to 0)' : JSON.stringify(env.ENABLE_COCKROACH)}`);
  add(`PORT=${env.PORT} DISPLAY=${env.DISPLAY} NODE_OPTIONS=${env.NODE_OPTIONS || '(none)'} MALLOC_ARENA_MAX=${env.MALLOC_ARENA_MAX || '(unset)'}`);
  add(`COCKROACH_CLI=${CLI}`);
  add(`CHROMIUM_PATH=${env.CHROMIUM_PATH || '(unset)'}`);
  const sh8 = (s) => require('crypto').createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
  add(`MCP_API_KEY sha256[:8]=${env.MCP_API_KEY ? sh8(env.MCP_API_KEY) : '-'}   VNC_PASSWORD sha256[:8]=${env.VNC_PASSWORD ? sh8(env.VNC_PASSWORD) : '-'}   (compare: printf %s 'yourkey' | sha256sum | cut -c1-8)`);
  const stray = Object.keys(env).filter((k) => k.startsWith('COCKROACH_BROWSER_'));
  add(`stray COCKROACH_BROWSER_* env vars: ${stray.join(', ') || '(none)'}`);
  add(`VNC_PASSWORD set=${Boolean(env.VNC_PASSWORD)} (len ${(env.VNC_PASSWORD || '').length}), MCP_API_KEY set=${Boolean(env.MCP_API_KEY)} (len ${(env.MCP_API_KEY || '').length})`);

  H('MEMORY / CPU (cgroup = what hostless enforces)');
  add(`memory: current=${mb(cg.memCur)} max=${mb(cg.memMax)}`);
  add(`memory.events: ${JSON.stringify(cg.events)}   <- oom_kill > 0 means the kernel killed a process for lack of RAM`);
  add(`cpu.max: ${cg.cpuMax}   cpu.stat: nr_periods=${cg.cpu.nr_periods} nr_throttled=${cg.cpu.nr_throttled} throttled_usec=${cg.cpu.throttled_usec}`);
  add(`loadavg: ${os.loadavg().map((x) => x.toFixed(2)).join(' ')}   visible cpus: ${os.cpus().length}`);

  H('FILES');
  Object.values(files).forEach((f) => add(f));
  try { add(`${ROOT} contents: ${fs.readdirSync(ROOT).join(', ') || '(empty)'}`); } catch (e) { add(`${ROOT} contents: unreadable (${e.code})`); }

  H('WRITE TESTS (can this user create nested folders + files here?)');
  const wt = (dir) => {
    try {
      const base = path.join(dir, '.diag-probe');
      fs.mkdirSync(path.join(base, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(base, 'sub', 'x'), '1');
      fs.rmSync(base, { recursive: true, force: true });
      return 'OK';
    } catch (e) { return `FAILED ${e.code}: ${e.message}`; }
  };
  const wdirs = [...new Set([ROOT, path.join(HOME, '.cockroach-browser'), HOME, '/tmp'])].filter((d2) => fs.existsSync(d2));
  const writes = {};
  wdirs.forEach((d2) => { writes[d2] = wt(d2); add(`${d2}: ${writes[d2]}`); });

  H('LISTENING TCP PORTS (from /proc/net/tcp)');
  add(`${listening.join(', ') || '(none)'}`);
  add(`expected: ${env.PORT || 8000}=gateway, 5900=x11vnc, 43110=cockroach daemon, 43111=mcp-proxy`);
  add(`connect test -> x11vnc:${vncUp}  daemon:${daemonUp}  mcp-proxy:${mcpUp}`);

  H('PROCESSES (top by memory; total by name)');
  const byName = {};
  ps.forEach((p) => { byName[p.name] = byName[p.name] || { n: 0, mb: 0 }; byName[p.name].n++; byName[p.name].mb += p.rssMB; });
  add(Object.entries(byName).sort((a, b) => b[1].mb - a[1].mb).map(([k, v]) => `${k} x${v.n}=${v.mb}MB`).join('  '));
  add(`sum RSS (double counts shared pages): ${ps.reduce((s, p) => s + p.rssMB, 0)}MB`);
  ps.slice(0, 18).forEach((p) => add(`  pid=${p.pid} ppid=${p.ppid} ${p.state} ${String(p.rssMB).padStart(4)}MB ${p.name}  ${p.cmd}`));
  const has = (re) => ps.some((p) => re.test(p.name) || re.test(p.cmd));

  H('COMMAND TESTS');
  const nodeV = await run('node', ['--version'], 5000);
  add(`node --version -> code=${nodeV.code} ${nodeV.out}`);
  const cliV = await run('node', [CLI, 'version'], 15000);
  add(`node <cockroach cli> version -> code=${cliV.code} ${cliV.ms}ms out=${JSON.stringify(cliV.out)} err=${JSON.stringify(cliV.err)}`);
  const symlinkPath = '/usr/local/bin/cockroach-browser';
  if (fs.existsSync(symlinkPath)) {
    const symV = await run(symlinkPath, ['version'], 15000);
    add(`${symlinkPath} version (bin symlink) -> code=${symV.code} out=${JSON.stringify(symV.out)}   <- EMPTY here is the known silent-no-op bug; never start the daemon this way`);
  }
  const chrV = await run(env.CHROMIUM_PATH || '/usr/bin/chromium', ['--version'], 15000);
  add(`chromium --version -> code=${chrV.code} ${chrV.out || chrV.err}`);

  H('COCKROACH DAEMON CHECK');
  let health = null;
  if (!tokenRaw) add('token file: missing or empty, so the daemon has never started successfully');
  else {
    add(`token file present (${tokenRaw.length} chars, value hidden)`);
    health = await httpGet('http://127.0.0.1:43110/v1/health', { authorization: `Bearer ${tokenRaw}` });
    add(`GET :43110/v1/health -> ${JSON.stringify(health)}`);
  }

  H('CHILD PROCESS LOGS (last lines, from /tmp/logs/*.log)');
  let logFiles = [];
  try { logFiles = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.log')).sort(); } catch (e) { add(`cannot read ${LOG_DIR}: ${e.code}`); }
  const logs = {};
  for (const f of logFiles) {
    const t = tail(path.join(LOG_DIR, f));
    logs[f] = t;
    add(`--- ${f} (${t ? t.size : '?'} bytes total) ---`);
    add(t && t.text ? t.text : '(empty: this process has printed nothing)');
  }

  if (ring.length) {
    H('GATEWAY CONSOLE (last lines)');
    ring.slice(-40).forEach((l) => add(l));
  }

  // ---- verdict
  const cockroachOn = env.ENABLE_COCKROACH === '1';
  const cl = logs['cockroach.log'];
  if (cg.events && cg.events.oom_kill > 0) findings.push(`OUT OF MEMORY: the kernel has killed ${cg.events.oom_kill} process(es) in this container. See PROCESSES for what is using RAM.`);
  if (Number.isFinite(+cg.memCur) && Number.isFinite(+cg.memMax) && +cg.memCur > 0.85 * +cg.memMax) findings.push(`Memory is above 85% of the limit (${mb(cg.memCur)} of ${mb(cg.memMax)}).`);
  if (cg.cpu.nr_periods > 100 && cg.cpu.nr_throttled / cg.cpu.nr_periods > 0.3) findings.push(`CPU is being throttled in ${Math.round(100 * cg.cpu.nr_throttled / cg.cpu.nr_periods)}% of periods (0.5 vCPU limit). Things will be slow, not broken.`);
  Object.entries(writes).forEach(([d2, r]) => {
    if (r === 'OK') return;
    const expected = d2.startsWith(HOME);
    findings.push(expected ? `${d2} is not writable (${r.split(':')[0]}). Expected on hostless: all data is kept under /tmp, so this is informational.` : `Cannot create folders/files in ${d2} (${r}). Anything that needs to write there will crash.`);
  });
  const strayVars = Object.keys(env).filter((k) => k.startsWith('COCKROACH_BROWSER_'));
  if (strayVars.length) findings.push(`Hosting env has ${strayVars.join(', ')}. The cockroach CLI prefers these over the token file; the gateway now ignores them for API calls, but delete them from the hostless env settings.`);
  if (!fs.existsSync('/tmp/.X11-unix/X99')) findings.push('Xvfb display :99 is missing, so nothing graphical can run. Check xvfb.log.');
  if (!vncUp) findings.push('x11vnc is not listening on 5900, so the desktop page cannot work. Check x11vnc.log.');
  if (!has(/chromium/)) findings.push('No chromium process is running (the restart loop in start.sh should bring it back; check chromium.log).');
  if (!fs.existsSync('/usr/share/novnc/vnc.html')) findings.push('noVNC files are missing at /usr/share/novnc.');

  if (!cockroachOn) {
    findings.push(`Cockroach/MCP is OFF because ENABLE_COCKROACH is ${env.ENABLE_COCKROACH === undefined ? 'not set' : JSON.stringify(env.ENABLE_COCKROACH)} (must be exactly "1"). Set it in hostless env vars and redeploy. This alone explains cockroachDaemon:false and mcpProxy:false.`);
  } else {
    if (!fs.existsSync(CLI)) findings.push(`Cockroach CLI file not found at ${CLI}. The npm install -g step did not put it there.`);
    else if (!cliV.out) findings.push(`Running "node ${CLI} version" printed nothing (code ${cliV.code}, err=${JSON.stringify(cliV.err)}). The package is broken or the node version is wrong.`);
    if (!tokenRaw) {
      if (!has(/cli\.js/) || !has(/ serve /)) findings.push('The cockroach daemon process is not running and never wrote its token. ' + (cl && cl.text ? `Its log says: ${JSON.stringify(cl.text.split('\n').slice(-2).join(' | ').slice(0, 300))}` : 'cockroach.log is empty, so it exited without output or was never started. Check the [start] lines at the top of the hostless log for "cockroach".'));
      else findings.push('The daemon process exists but has not written the token yet; it may still be starting or is stuck. Compare with cockroach.log.');
    } else if (!daemonUp) {
      findings.push('Token exists but nothing listens on 43110: the daemon started once and then died. Read cockroach.log for the reason (OOM kills are shown under MEMORY).');
    } else if (!health || health.status !== 200) {
      findings.push(`Daemon is listening but /v1/health returned ${JSON.stringify(health)}.`);
    }
    if (daemonUp && !mcpUp) findings.push('Daemon is up but mcp-proxy is not listening on 43111. Read mcp.log. (start.sh only starts mcp-proxy after the token file appears.)');
    if (daemonUp && mcpUp) findings.push('Cockroach daemon and MCP proxy are both up. If the agent still gets 401, its X-API-Key differs from the MCP_API_KEY env var.');
  }
  if (!findings.length) findings.push('No problems detected by the automatic checks.');

  H('VERDICT (automatic findings)');
  findings.forEach((f, i) => add(`${i + 1}. ${f}`));

  let text = L.join('\n');
  for (const s of secrets) text = text.split(s).join('[REDACTED]');
  return text;
}

module.exports = { report, captureConsole };

if (require.main === module) {
  report().then((t) => { console.log(t); }).catch((e) => { console.log('diag failed:', e); process.exitCode = 1; });
}
