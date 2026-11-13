#!/usr/bin/env node
// Static server for portal-met-bridge, with an optional data folder. No dependencies.
//   node serve.mjs                         → http://localhost:8787, files stay in the browser
//   PORT=9000 node serve.mjs
//   DATA_DIR=~/Documents/portal-met-bridge node serve.mjs
//       → the app can write its shot files, exports, reports, reviews, backups and
//         logs into that folder on this computer (Settings → Files and folders)
//   HOST=0.0.0.0 node serve.mjs            → reachable from the LAN (the Home Assistant app does this)
//   TLS_PORT=8788 TLS_CERT=cert.pem TLS_KEY=key.pem node serve.mjs
//       → the same app also on https://…:8788. Web Bluetooth needs a secure page, and a
//         LAN address is only secure over https with a certificate the browser trusts;
//         GET api/cert hands out the certificate so it can be trusted once. A page on
//         https cannot call the machine's plain-http API itself (mixed content), so it
//         goes through the proxy below.
//   ALLOWED_HOSTS=espresso.example.org node serve.mjs
//       → also answer to that name. The server answers only to names that cannot be the
//         target of a DNS-rebinding attack on their own: IP addresses, localhost, single-label
//         and .local/.lan/.home/.internal names, this computer's hostname, and the names in the
//         TLS certificate. A public DNS name (a reverse proxy, DuckDNS, a tailnet name) must be
//         listed here, comma-separated; ALLOWED_HOSTS=* turns the check off.
//   ALLOW_QUIT=0 node serve.mjs            → the page's Stop button may not stop this server
//       (by default a page served to this same computer may: POST api/quit; the macOS app
//        and start.command rely on it); ALLOW_QUIT=1 lets any client stop it (the Home
//        Assistant app, where a stop also stops the app itself through the Supervisor)
// Machine proxy: /machine/<host[:port]>/<path> is forwarded to http://<host[:port]>/<path>
//   — REST and the socket.io WebSocket alike — so the page can reach the Meticulous
//   through this server when it cannot directly (an https page, or a browser on
//   another network). Only private/LAN hosts are accepted; see machineTarget().
// Web Bluetooth only works from a secure origin, and http://localhost counts,
// so the app must be served (not opened as a file) and opened as localhost — or
// over https as above — or, when it is served from another machine over plain
// http, that origin must be allowed in chrome://flags/#unsafely-treat-insecure-origin-as-secure
// (see docs/PACKAGING.md).

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { readFile, stat, mkdir, rm, open, readdir, realpath } from 'node:fs/promises';
import { readFileSync, createWriteStream } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { extname, join, normalize, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces, hostname } from 'node:os';

const root = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(argOf('--port') || process.env.PORT) || 8787;
const host = argOf('--host') || process.env.HOST || '127.0.0.1';
const dataDirArg = argOf('--data') || process.env.DATA_DIR || '';
const dataDir = dataDirArg ? resolve(dataDirArg.replace(/^~(?=\/|$)/, process.env.HOME || '~')) : null;
const dataDirShown = dataDirArg.startsWith('~') ? dataDirArg.replace(/\/+$/, '') : dataDir; // "~/Documents/…" reads better in the page than the full path
const MAX_BODY = 512 * 1024 * 1024; // a backup with years of shots is tens of MB; leave room
const allowQuit = process.env.ALLOW_QUIT !== '0';
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const tlsPort = Number(process.env.TLS_PORT) || 0;
const tlsCertFile = process.env.TLS_CERT || '';
const tlsKeyFile = process.env.TLS_KEY || '';
const tlsSelfSigned = process.env.TLS_SELF_SIGNED === '1';
const supervisorToken = process.env.SUPERVISOR_TOKEN || ''; // present inside a Home Assistant app container
const platform = supervisorToken ? 'home-assistant' : process.env.PMB_PLATFORM || 'server';
let server = null;
let tlsServer = null;

// ------------------------------------------------------------- hardening --
// The server has no accounts: whoever can reach it can use it. That is the
// point on localhost and acceptable on a home LAN, but a *web page* the user
// happens to visit must not be able to use it through their browser. Three
// checks see to that (docs/SECURITY.md has the reasoning):
//   1. hostAllowed():  the Host header must be a name this server answers to,
//      which stops DNS rebinding (evil.example re-pointed at 127.0.0.1);
//   2. crossSite():    api/ and machine/ requests that a browser marks as coming
//      from another site (Origin, Sec-Fetch-Site) are refused, which stops
//      cross-site request forgery — a page elsewhere stopping the server,
//      starting a brew through the relay, or probing the LAN with it;
//   3. the response headers below, and a Content-Security-Policy on the page.

const listedHosts = new Set((process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)); // named by whoever runs the server
const allowedHosts = new Set(listedHosts); // …plus the names in the TLS certificate, added at start

/** The hostname of a Host header value: lower-case, without port or IPv6 brackets. */
export function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined);
  return h.replace(/:\d+$/, '');
}

/**
 * Whether this server answers to the name in a Host header. Names that DNS
 * rebinding cannot produce are always fine; anything else must be listed
 * (ALLOWED_HOSTS, or a name in the TLS certificate).
 */
export function hostAllowed(hostHeader, extra = allowedHosts) {
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  if (extra.has('*')) return true;
  if (net.isIP(name)) return true; // an address, not a name: nothing to rebind
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (!name.includes('.')) return true; // a single-label LAN name (homeassistant, meticulous)
  if (/\.(local|lan|home|internal|home\.arpa)$/.test(name)) return true; // not resolvable from the public DNS
  if (name === hostname().toLowerCase()) return true;
  return extra.has(name);
}

/**
 * Whether a browser says this request comes from another site. Requests
 * without these headers (curl, scripts, the tests) are not a browser's and pass.
 */
export function crossSite(req, listed = listedHosts) {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (origin === 'null') return true; // a sandboxed frame, a file, a redirect chain
    try {
      const o = new URL(origin);
      if (o.host.toLowerCase() === String(req.headers.host || '').toLowerCase()) return false;
      return !listed.has(o.hostname.toLowerCase()); // behind a reverse proxy that rewrites Host, the public name listed in ALLOWED_HOSTS is this server too
    } catch {
      return true;
    }
  }
  const site = req.headers['sec-fetch-site'];
  return site === 'cross-site' || site === 'same-site'; // same-site still means another origin (another port on localhost)
}

/** The page's Content-Security-Policy: the one in index.html's <meta>, so there is a single source. */
let pageCsp = '';
try {
  pageCsp = readFileSync(join(root, 'index.html'), 'utf8').match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] || '';
} catch {
  /* no index.html next to the server (tests importing the helpers) */
}

/** Headers every response carries. */
const baseHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};
/** Headers for the app's own page and files. */
const pageHeaders = (type) => ({
  ...baseHeaders,
  'Content-Type': type,
  'Cache-Control': 'no-store',
  ...(type.startsWith('text/html') ? { 'Content-Security-Policy': `${pageCsp ? pageCsp + '; ' : ''}frame-ancestors 'none'`, 'Cross-Origin-Opener-Policy': 'same-origin', 'Permissions-Policy': 'bluetooth=(self), camera=(), microphone=(), geolocation=(), payment=(), usb=()' } : {}),
});
/** What the static server hands out: the app, nothing else in the folder (no .git, tests, tools, package files). */
const STATIC_ROOTS = new Set(['index.html', 'css', 'js', 'vendor', 'assets', 'docs', 'LICENSE', 'README.md']);
export function staticAllowed(path) {
  const parts = String(path).split('/').filter(Boolean);
  if (!parts.length || !STATIC_ROOTS.has(parts[0])) return false;
  return !parts.some((p) => p.startsWith('.') || p.includes('\\') || p.includes('\0'));
}
/** Files from the data folder are data: typed as text or bytes, downloaded rather than rendered, and sandboxed if a browser opens one anyway. */
const DATA_TYPES = { '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

/** Requests from this computer itself (the page opened on localhost). */
export function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === 'localhost';
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

const json = (res, status, body) => {
  res.writeHead(status, { ...baseHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

/**
 * A path inside the data folder, or null when the request tries to leave it.
 * Segments are plain names: no '.', '..', empty or hidden parts, no control
 * characters, nothing Windows would refuse either.
 */
export function safeDataPath(dir, rel) {
  if (!dir || typeof rel !== 'string') return null;
  const parts = rel.split('/').filter((p) => p !== '');
  if (!parts.length) return null;
  for (const p of parts) {
    if (p === '.' || p === '..' || p.startsWith('.')) return null;
    if (/[\0-\x1f<>:"|?*\\]/.test(p)) return null;
    if (p.length > 200) return null;
  }
  const full = resolve(dir, ...parts);
  if (full !== dir && !full.startsWith(dir + sep)) return null;
  return full;
}

/**
 * The same check against the real filesystem: the deepest part of `full` that
 * exists must still be inside the data folder once symbolic links are followed,
 * so a link planted in the folder cannot lead a read, write or delete outside it.
 */
export async function insideDataDir(dir, full) {
  let realDir;
  try {
    realDir = await realpath(dir);
  } catch {
    return false;
  }
  let probe = full;
  for (;;) {
    try {
      const real = await realpath(probe);
      return real === realDir || real.startsWith(realDir + sep);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return false;
      const up = dirname(probe);
      if (up === probe) return false;
      probe = up;
    }
  }
}

async function handleFiles(req, res, path) {
  if (!dataDir) return json(res, 404, { error: 'This server has no data folder. Start it with DATA_DIR=<folder> (or --data <folder>).' });
  const rel = path.slice('/api/files'.length).replace(/^\/+/, ''); // `path` is already decoded, once
  if (req.method === 'GET' && !rel) return json(res, 200, { dataDir: dataDirShown, host: hostname(), write: 'PUT /api/files/<path>[?append=1]', erase: 'DELETE /api/files/<path>' });
  const full = safeDataPath(dataDir, rel);
  if (!full || !(await insideDataDir(dataDir, full))) return json(res, 400, { error: `Refused path: ${rel || '(empty)'}` });
  if (req.method === 'PUT') {
    const append = /(?:^|[?&])append=1(?:&|$)/.test(new URL(req.url, 'http://x').search);
    await mkdir(dirname(full), { recursive: true });
    let bytes = 0;
    await new Promise((ok, fail) => {
      const out = createWriteStream(full, { flags: append ? 'a' : 'w' });
      out.on('error', fail);
      out.on('finish', ok);
      req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY) {
          req.destroy();
          out.destroy();
          fail(new Error('too large'));
        }
      });
      req.on('error', fail);
      req.pipe(out);
    });
    return json(res, 200, { path: rel, bytes, append });
  }
  if (req.method === 'DELETE') {
    let existed = true;
    try {
      await stat(full);
    } catch {
      existed = false;
    }
    if (existed) await rm(full, { recursive: true, force: true });
    return json(res, 200, { path: rel, removed: existed });
  }
  if (req.method === 'GET') {
    const s = await stat(full);
    if (s.isDirectory()) {
      // a listing, so the page can offer saved backups to restore: files only, newest first
      const names = await readdir(full);
      const entries = [];
      for (const name of names) {
        if (name.startsWith('.')) continue;
        try {
          const st = await stat(join(full, name));
          entries.push({ name, size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() });
        } catch {
          /* vanished meanwhile */
        }
      }
      entries.sort((a, b) => b.mtime - a.mtime);
      return json(res, 200, { dir: rel, entries });
    }
    res.writeHead(200, { ...baseHeaders, 'Content-Type': DATA_TYPES[extname(full).toLowerCase()] || 'application/octet-stream', 'Content-Length': s.size, 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment', 'Content-Security-Policy': "sandbox; default-src 'none'" });
    const fh = await open(full);
    fh.createReadStream().pipe(res);
    return undefined;
  }
  return json(res, 405, { error: 'GET, PUT or DELETE' });
}

/**
 * The machine behind /machine/<host[:port]>/…: a LAN/private address or a
 * .local name only, so this is not an open proxy. Returns { host, port } or null.
 */
export function machineTarget(spec) {
  if (typeof spec !== 'string' || spec.length > 253) return null;
  const m = spec.match(/^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/i);
  if (!m) return null;
  const host = m[1];
  const port = m[2] ? Number(m[2]) : 80;
  if (!(port >= 1 && port <= 65535)) return null;
  const ip4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ip4) {
    const [a, b] = [Number(ip4[1]), Number(ip4[2])];
    if (ip4.slice(1).some((x) => Number(x) > 255)) return null;
    const privateIp = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 127;
    if (host === '169.254.169.254') return null; // a cloud metadata service is never an espresso machine
    return privateIp ? { host, port } : null;
  }
  if (/^(supervisor|hassio|observer)$/i.test(host)) return null; // Home Assistant's own control plane, reachable only from inside the app's container
  if (/^localhost$/i.test(host) || /\.local$/i.test(host) || /\.lan$/i.test(host) || /\.home$/i.test(host) || /\.internal$/i.test(host) || !host.includes('.')) return { host, port };
  return null;
}

/** REST through the proxy: /machine/<target>/<path> → http://<target>/<path>, streamed both ways. */
function handleMachineProxy(req, res, path) {
  const m = path.match(/^\/machine\/([^/]+)(\/.*)?$/);
  const target = m && machineTarget(m[1]);
  if (!target) return json(res, 400, { error: 'machine proxy: give a LAN address, e.g. /machine/192.168.1.20/api/v1/machine' });
  const search = new URL(req.url, 'http://x').search;
  const headers = { ...req.headers, host: `${target.host}:${target.port}` };
  // the machine gets the request, not this origin's credentials or where it came from
  for (const h of ['accept-encoding', 'cookie', 'authorization', 'origin', 'referer']) delete headers[h];
  const up = http.request({ host: target.host, port: target.port, method: req.method, path: (m[2] || '/') + search, headers, timeout: 15000 }, (r) => {
    const h = { ...r.headers };
    // …and its answer may not set cookies or policy for this origin
    for (const k of Object.keys(h)) if (/^(access-control-|set-cookie|content-security-policy|strict-transport-security|clear-site-data|x-frame-options|cross-origin-|permissions-policy|service-worker-allowed)/i.test(k)) delete h[k];
    res.writeHead(r.statusCode || 502, { ...h, ...baseHeaders, ...(/^text\/html|^image\/svg/i.test(String(h['content-type'] || '')) ? { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" } : {}) });
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', (e) => {
    if (!res.headersSent) json(res, 502, { error: `machine ${target.host}:${target.port}: ${e.message}` });
    else res.end();
  });
  req.pipe(up);
  return undefined;
}

/** The WebSocket (socket.io) through the proxy: pipe the upgrade to the machine and the bytes both ways. */
function handleMachineUpgrade(req, socket, head) {
  const path = req.url;
  const m = path.match(/^\/machine\/([^/?]+)(\/[^?]*)?(\?.*)?$/);
  const target = m && machineTarget(m[1]);
  if (!target) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  const upstream = net.connect(target.port, target.host, () => {
    const lines = [`${req.method} ${(m[2] || '/') + (m[3] || '')} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (/^(cookie|authorization|origin)$/i.test(k)) continue;
      lines.push(`${k}: ${k.toLowerCase() === 'host' ? `${target.host}:${target.port}` : v}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const drop = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('error', drop);
  socket.on('error', drop);
  upstream.setTimeout(0);
  socket.setTimeout(0);
  return undefined;
}

/** Inside a Home Assistant app, ask the Supervisor to stop this app (so Home Assistant shows it stopped). */
async function supervisorStopSelf() {
  if (!supervisorToken) return false;
  return new Promise((resolve) => {
    const r = http.request({ host: 'supervisor', port: 80, path: '/addons/self/stop', method: 'POST', headers: { Authorization: `Bearer ${supervisorToken}`, 'Content-Type': 'application/json' }, timeout: 8000 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.end();
  });
}

/** What the page may ask of this server: GET api/server → who it is; POST api/quit → stop it (Stop button). */
function handleServer(req, res, path) {
  const local = isLoopback(req.socket.remoteAddress);
  const mayQuit = allowQuit && (local || process.env.ALLOW_QUIT === '1');
  if (path === '/api/server' && req.method === 'GET') {
    return json(res, 200, {
      app: 'portal-met-bridge',
      version,
      pid: process.pid,
      host: hostname(),
      platform,
      dataDir: dataDir ? dataDirShown : null,
      quit: mayQuit,
      quitStopsApp: mayQuit && !!supervisorToken, // Home Assistant: the Stop button stops the app itself
      local,
      tls: tlsServer ? { port: tlsPort, selfSigned: tlsSelfSigned, certUrl: 'api/cert' } : null,
      machineProxy: true,
    });
  }
  if (path === '/api/cert' && req.method === 'GET') {
    if (!tlsCertFile) return json(res, 404, { error: 'This server has no certificate (TLS_CERT is not set).' });
    try {
      const pem = readFileSync(tlsCertFile, 'utf8');
      const cert = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0] || pem; // the leaf only, never a key
      res.writeHead(200, { 'Content-Type': 'application/x-pem-file', 'Content-Disposition': 'attachment; filename="portal-met-bridge.pem"', 'Cache-Control': 'no-store' });
      return res.end(cert + '\n');
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }
  if (path === '/api/quit') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST' });
    if (!mayQuit) return json(res, 403, { error: local ? 'quitting is disabled (ALLOW_QUIT=0)' : 'only the computer running the server may stop it' });
    console.log(`stop requested by ${req.socket.remoteAddress}; ${supervisorToken ? 'asking the Supervisor to stop this app' : 'exiting'}`);
    json(res, 200, { stopping: true, pid: process.pid, app: !!supervisorToken });
    setTimeout(async () => {
      const stoppedByHa = await supervisorStopSelf();
      if (!stoppedByHa) {
        server?.close();
        tlsServer?.close();
        process.exit(0);
      }
    }, 150);
    return undefined;
  }
  return json(res, 404, { error: 'unknown' });
}

/** Why a request is refused before it reaches a handler, or null. */
function refusal(req) {
  if (!hostAllowed(req.headers.host)) {
    return { status: 421, error: `This server does not answer to the name "${hostnameOf(req.headers.host) || '(none)'}". Open it by its address or its .local name, or start it with ALLOWED_HOSTS=${hostnameOf(req.headers.host) || '<name>'} (Home Assistant: the app's allowed_hosts option).` };
  }
  if (isApi(req) && crossSite(req)) return { status: 403, error: 'Cross-site requests are refused: this API answers only the page it serves.' };
  return null;
}

async function handleRequest(req, res) {
    try {
      const no = refusal(req);
      if (no) return json(res, no.status, { error: no.error });
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path === '/api/files' || path.startsWith('/api/files/')) return await handleFiles(req, res, path);
      if (path === '/api/server' || path === '/api/quit' || path === '/api/cert') return handleServer(req, res, path);
      if (path.startsWith('/machine/')) return handleMachineProxy(req, res, path);
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'GET' });
      if (path === '/') path = '/index.html';
      if (!staticAllowed(path)) throw Object.assign(new Error('not served'), { code: 'ENOENT' });
      const file = normalize(join(root, path));
      if (!file.startsWith(root)) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
      const s = await stat(file);
      if (s.isDirectory()) throw Object.assign(new Error('dir'), { code: 'ENOENT' });
      res.writeHead(200, pageHeaders(types[extname(file)] || 'application/octet-stream'));
      res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof URIError) return json(res, 400, { error: 'malformed URL' });
      if (isApi(req) && e.code !== 'ENOENT' && e.code !== 'EACCES') return json(res, 500, { error: e.message });
      res.writeHead(e.code === 'ENOENT' ? 404 : 403, { ...baseHeaders, 'Content-Type': 'text/plain' });
      res.end(e.code === 'ENOENT' ? 'Not found' : 'Forbidden');
    }
}

export function createServer(tlsOptions = null) {
  const srv = tlsOptions ? https.createServer(tlsOptions, handleRequest) : http.createServer(handleRequest);
  srv.on('upgrade', (req, socket, head) => {
    // a WebSocket is not bound by the same-origin policy, so the Origin check here is the only one there is
    if (refusal(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    if (req.url.startsWith('/machine/')) return handleMachineUpgrade(req, socket, head);
    socket.destroy();
    return undefined;
  });
  return srv;
}

const isApi = (req) => req.url.startsWith('/api/') || req.url.startsWith('/machine/');

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (dataDir) await mkdir(dataDir, { recursive: true }).catch((e) => console.error(`data folder ${dataDir}: ${e.message}`));
  server = createServer();
  server.listen(port, host, () => {
    const lines = [`portal-met-bridge → http://localhost:${port}`];
    if (host !== '127.0.0.1' && host !== 'localhost') {
      for (const list of Object.values(networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) lines.push(`                    http://${n.address}:${port}  (LAN; for Bluetooth open the https address below, or set the chrome://flags exception — docs/PACKAGING.md)`);
    }
    if (dataDir) lines.push(`files               ${dataDir}`);
    if (platform === 'home-assistant') lines.push('platform            Home Assistant app (Stop in the page stops the app)');
    console.log(lines.join('\n'));
  });
  if (tlsPort && tlsCertFile && tlsKeyFile) {
    try {
      const certPem = readFileSync(tlsCertFile);
      // the names the certificate was issued for are names this server answers to
      try {
        const sans = new X509Certificate(certPem).subjectAltName || '';
        for (const m of sans.matchAll(/DNS:([^,\s]+)/g)) if (!m[1].includes('*')) allowedHosts.add(m[1].toLowerCase());
      } catch {
        /* an unreadable certificate fails below, with its own message */
      }
      tlsServer = createServer({ cert: certPem, key: readFileSync(tlsKeyFile), minVersion: 'TLSv1.2' });
      tlsServer.listen(tlsPort, host, () => {
        const names = [];
        if (host !== '127.0.0.1' && host !== 'localhost') for (const list of Object.values(networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) names.push(n.address);
        console.log(`secure              https://${names[0] || 'localhost'}:${tlsPort}${tlsSelfSigned ? '  (self-signed: trust the certificate from api/cert once)' : ''}`);
      });
    } catch (e) {
      console.error(`TLS not started: ${e.message}`);
    }
  }
}
