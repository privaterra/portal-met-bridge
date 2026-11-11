#!/usr/bin/env node
// Static server for portal-met-bridge, with an optional data folder. No dependencies.
//   node serve.mjs                         → http://localhost:8787, files stay in the browser
//   PORT=9000 node serve.mjs
//   DATA_DIR=~/Documents/portal-met-bridge node serve.mjs
//       → the app can write its shot files, exports, reports, reviews, backups and
//         logs into that folder on this computer (Settings → Files and folders)
//   HOST=0.0.0.0 node serve.mjs            → reachable from the LAN (the Home Assistant app does this)
//   ALLOW_QUIT=0 node serve.mjs            → the page's Stop button may not stop this server
//       (by default a page served to this same computer may: POST api/quit; the macOS app
//        and start.command rely on it, the Home Assistant app sets ALLOW_QUIT=0 — s6 would
//        only restart it)
// Web Bluetooth only works from a secure origin, and http://localhost counts,
// so the app must be served (not opened as a file) and opened as localhost — or,
// when it is served from another machine, that origin must be allowed in
// chrome://flags/#unsafely-treat-insecure-origin-as-secure (see docs/PACKAGING.md).

import http from 'node:http';
import { readFile, stat, mkdir, rm, open } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
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
let server = null;

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
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
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

async function handleFiles(req, res, path) {
  if (!dataDir) return json(res, 404, { error: 'This server has no data folder. Start it with DATA_DIR=<folder> (or --data <folder>).' });
  const rel = decodeURIComponent(path.slice('/api/files'.length)).replace(/^\/+/, '');
  if (req.method === 'GET' && !rel) return json(res, 200, { dataDir: dataDirShown, host: hostname(), write: 'PUT /api/files/<path>[?append=1]', erase: 'DELETE /api/files/<path>' });
  const full = safeDataPath(dataDir, rel);
  if (!full) return json(res, 400, { error: `Refused path: ${rel || '(empty)'}` });
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
    if (s.isDirectory()) return json(res, 400, { error: 'That is a folder.' });
    res.writeHead(200, { 'Content-Type': types[extname(full)] || 'application/octet-stream', 'Content-Length': s.size, 'Cache-Control': 'no-store' });
    const fh = await open(full);
    fh.createReadStream().pipe(res);
    return undefined;
  }
  return json(res, 405, { error: 'GET, PUT or DELETE' });
}

/** What the page may ask of this server: GET api/server → who it is; POST api/quit → stop it (Stop button). */
function handleServer(req, res, path) {
  const local = isLoopback(req.socket.remoteAddress);
  const mayQuit = allowQuit && (local || process.env.ALLOW_QUIT === '1');
  if (path === '/api/server' && req.method === 'GET') return json(res, 200, { app: 'portal-met-bridge', version, pid: process.pid, host: hostname(), dataDir: dataDir ? dataDirShown : null, quit: mayQuit, local });
  if (path === '/api/quit') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST' });
    if (!mayQuit) return json(res, 403, { error: local ? 'quitting is disabled (ALLOW_QUIT=0)' : 'only the computer running the server may stop it' });
    console.log(`stop requested by ${req.socket.remoteAddress}; exiting`);
    json(res, 200, { stopping: true, pid: process.pid });
    setTimeout(() => {
      server?.close();
      process.exit(0);
    }, 150);
    return undefined;
  }
  return json(res, 404, { error: 'unknown' });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path === '/api/files' || path.startsWith('/api/files/')) return await handleFiles(req, res, path);
      if (path === '/api/server' || path === '/api/quit') return handleServer(req, res, path);
      if (path === '/') path = '/index.html';
      const file = normalize(join(root, path));
      if (!file.startsWith(root)) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
      const s = await stat(file);
      if (s.isDirectory()) throw Object.assign(new Error('dir'), { code: 'ENOENT' });
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(await readFile(file));
    } catch (e) {
      if (res.headersSent) return res.end();
      if (isApi(req) && e.code !== 'ENOENT' && e.code !== 'EACCES') return json(res, 500, { error: e.message });
      res.writeHead(e.code === 'ENOENT' ? 404 : 403, { 'Content-Type': 'text/plain' });
      res.end(e.code === 'ENOENT' ? 'Not found' : 'Forbidden');
    }
  });
}

const isApi = (req) => req.url.startsWith('/api/');

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (dataDir) await mkdir(dataDir, { recursive: true }).catch((e) => console.error(`data folder ${dataDir}: ${e.message}`));
  server = createServer();
  server.listen(port, host, () => {
    const lines = [`portal-met-bridge → http://localhost:${port}`];
    if (host !== '127.0.0.1' && host !== 'localhost') {
      for (const list of Object.values(networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) lines.push(`                    http://${n.address}:${port}  (LAN; Bluetooth needs the chrome://flags exception, see docs/PACKAGING.md)`);
    }
    if (dataDir) lines.push(`files               ${dataDir}`);
    console.log(lines.join('\n'));
  });
}
