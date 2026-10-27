#!/usr/bin/env node
// Zero-dependency dev server for public/. Camera access needs a secure context;
// http://localhost counts as one, so no certificate is needed.
// The lists of cameras, drivers and filters (*/index.json) are rebuilt on every request, so new or
// edited files show up after a reload.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLibrary, serialize } from './lib/library.mjs';
import { devInfo } from './lib/build-info.mjs';

const ROOT = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

let lastErrors = '';

const LISTS = { '/cameras/index.json': 'cameras', '/drivers/index.json': 'drivers', '/filters/index.json': 'filters' };

async function list(key) {
  const { indexes, errors } = await buildLibrary({ fresh: true });
  const report = errors.join('\n');
  if (report && report !== lastErrors) console.warn(`\nProblems (these items are skipped):\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
  lastErrors = report;
  return serialize(indexes[key]);
}

createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/build.json') {
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
      res.end(serialize(await devInfo()));
      return;
    }
    if (LISTS[pathname]) {
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
      res.end(await list(LISTS[pathname]));
      return;
    }
    let file = resolve(ROOT, `.${decodeURIComponent(pathname)}`);
    if (file !== ROOT && !file.startsWith(ROOT + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info) {
      res.writeHead(404, { 'content-type': TYPES['.txt'] }).end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(file));
  } catch (e) {
    res.writeHead(500, { 'content-type': TYPES['.txt'] }).end(String(e));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`USB Cam Preview is running at http://localhost:${PORT}`);
});
