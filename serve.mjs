#!/usr/bin/env node
// Minimal static server for portal-met-bridge. No dependencies.
//   node serve.mjs            → http://localhost:8787
//   PORT=9000 node serve.mjs
// Web Bluetooth only works from a secure origin, and http://localhost counts,
// so the app must be served (not opened as a file) and opened as localhost.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT) || 8787;
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

http
  .createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path === '/') path = '/index.html';
      const file = normalize(join(root, path));
      if (!file.startsWith(root)) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
      const s = await stat(file);
      if (s.isDirectory()) throw Object.assign(new Error('dir'), { code: 'ENOENT' });
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(await readFile(file));
    } catch (e) {
      res.writeHead(e.code === 'ENOENT' ? 404 : 403, { 'Content-Type': 'text/plain' });
      res.end(e.code === 'ENOENT' ? 'Not found' : 'Forbidden');
    }
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`portal-met-bridge → http://localhost:${port}`);
  });
