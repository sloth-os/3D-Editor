// A static host for the end-to-end tests: the built web app (apps/web/dist) at the root of one
// origin and under a folder of it, files only, as the nginx example of docs/embedding.md ("Static
// hosts") serves it (try_files $uri $uri/ =404), with no editor server behind it.
// Usage: node fixtures/static-host.mjs <port> <dist directory> [<folder> ...]
//
//  - each folder (and the root) maps its paths to the files of the build: a file is sent with its
//    type and Cache-Control: no-cache, a directory with its index.html; a directory named without
//    its slash is redirected to it (301), as nginx does
//  - anything else is the host's own 404 (text/plain, 'not found on this static host'): deeper
//    paths, the desk's clean URL and its look-alikes (<folder>/desk, <folder>/desk/), the server's
//    routes; the host writes no <base href> into a page and maps nothing to index.html
//  - GET and HEAD only (405 otherwise)
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const [port, dist, ...rawFolders] = process.argv.slice(2);
if (!port || !dist) {
  console.error('usage: node static-host.mjs <port> <dist directory> [<folder such as /folder/> ...]');
  process.exit(2);
}
const root = resolve(dist);
// the longest first, so that /folder/ wins over the root
const folders = [...rawFolders.map((f) => `/${f.replace(/^\/+|\/+$/g, '')}/`), '/'].sort(
  (a, b) => b.length - a.length,
);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

/** The file of the build a request path names, or null (outside the build, or no folder of the host). */
function fileOf(pathname) {
  const folder = folders.find((f) => pathname.startsWith(f));
  if (!folder) return null;
  let rel;
  try {
    rel = decodeURIComponent(pathname.slice(folder.length));
  } catch {
    return null;
  }
  const file = resolve(root, rel);
  return file === root || file.startsWith(`${root}${sep}`) ? file : null;
}

async function kind(file) {
  try {
    const s = await stat(file);
    return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null;
  } catch {
    return null;
  }
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
  res.end('not found on this static host\n');
}

async function send(req, res, file) {
  const { size } = await stat(file);
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': String(size),
    'cache-control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://static.invalid');
  if (folders.includes(`${url.pathname}/`)) {
    res.writeHead(301, { location: `${url.pathname}/${url.search}` }).end();
    return;
  }
  const file = fileOf(url.pathname);
  const found = file && (await kind(file));
  if (found === 'file' && !url.pathname.endsWith('/')) return send(req, res, file);
  if (found === 'dir') {
    if (!url.pathname.endsWith('/')) {
      res.writeHead(301, { location: `${url.pathname}/${url.search}` }).end();
      return;
    }
    const index = join(file, 'index.html');
    if ((await kind(index)) === 'file') return send(req, res, index);
  }
  return notFound(res);
});

server.listen(Number(port), '127.0.0.1', () => {
  console.log(`static host: http://127.0.0.1:${port} serves ${root} at ${folders.join(' and ')}`);
});
