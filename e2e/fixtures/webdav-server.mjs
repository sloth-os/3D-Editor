// Real WebDAV server for end-to-end tests (in-memory, basic auth, CORS for direct browser access).
// Usage: node fixtures/webdav-server.mjs [port]
//
// Two behaviours on the same port:
//  - /...    webdav-server as it is: no ETag with GET or PUT (PROPFIND reports one, an md5 of the
//            modification time in ms), If-Match and If-None-Match ignored
//  - /nc/... like Nextcloud: an ETag with GET, HEAD and PUT responses that changes with every
//            write, and If-Match / If-None-Match checked in the same step as the write (HTTP 412)
import http from 'node:http';
import { v2 as webdav } from 'webdav-server';

const port = Number(process.argv[2] ?? process.env.WEBDAV_PORT ?? 4199);
const users = new webdav.SimpleUserManager();
const user = users.addUser('editor', 'secret', false);
const privileges = new webdav.SimplePathPrivilegeManager();
privileges.setRights(user, '/', ['all']);
const authorization = `Basic ${Buffer.from('editor:secret').toString('base64')}`;

const dav = new webdav.WebDAVServer({
  httpAuthentication: new webdav.HTTPBasicAuthentication(users, 'e2e'),
  privilegeManager: privileges,
  requireAuthentification: true,
});

/** Virtual file system whose ETags change with every write (a counter, like Nextcloud's). */
class VersionedFileSystem extends webdav.VirtualFileSystem {
  counter = 0;
  versions = new Map();

  /** The ETag of a file, or null when there is none at that path. */
  etagOf(path) {
    const r = this.resources[path];
    return r && r.type.isFile ? `"w${this.versions.get(path) ?? 0}"` : null;
  }

  _openWriteStream(path, ctx, callback) {
    super._openWriteStream(path, ctx, (e, stream) => {
      // after the content is replaced (the listener registered before this one)
      stream?.on('finish', () => this.versions.set(path.toString(), ++this.counter));
      callback(e, stream);
    });
  }

  _etag(path, _ctx, callback) {
    callback(undefined, `"w${this.versions.get(path.toString()) ?? 0}"`);
  }
}

const NC = '/nc';
const versioned = new VersionedFileSystem();
dav.setFileSystemSync(NC, versioned);

/** Whether an If-Match / If-None-Match value names `etag` (null: no file). */
function names(header, etag) {
  if (header.trim() === '*') return etag !== null;
  return etag !== null && header.split(',').some((t) => t.trim() === etag);
}

// GET, HEAD, PUT and DELETE of a path under /nc run one at a time: an ETag sent with a GET belongs
// to the content sent, and a conditional PUT is checked and written in one step
const locks = new Map();
async function lock(key) {
  const prev = locks.get(key) ?? Promise.resolve();
  let release;
  const next = new Promise((resolve) => (release = resolve));
  const chained = prev.then(() => next);
  locks.set(key, chained);
  await prev;
  return () => {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  };
}

/** Adds the ETag of the written file to a successful PUT response (sent when it ends). */
function withEtagOnEnd(res, etag) {
  const end = res.end.bind(res);
  res.end = (...args) => {
    const value = res.statusCode < 300 && !res.headersSent ? etag() : null;
    if (value) res.setHeader('ETag', value);
    return end(...args);
  };
}

/** Handles a request under /nc: ETags in GET, HEAD and PUT responses, conditional PUT. */
async function nextcloudLike(req, res, method, path) {
  const sub = path.slice(NC.length) || '/';
  const release = await lock(sub);
  res.once('close', release);
  if (req.headers.authorization === authorization) {
    const current = versioned.etagOf(sub);
    if (method === 'PUT') {
      const ifMatch = req.headers['if-match'];
      const ifNoneMatch = req.headers['if-none-match'];
      if ((ifMatch && !names(ifMatch, current)) || (ifNoneMatch && names(ifNoneMatch, current))) {
        req.resume();
        res.statusCode = 412;
        res.end();
        return;
      }
      withEtagOnEnd(res, () => versioned.etagOf(sub));
    } else if ((method === 'GET' || method === 'HEAD') && current) res.setHeader('ETag', current);
  }
  dav.executeRequest(req, res);
}

const ALLOW_METHODS = 'GET,HEAD,PUT,DELETE,PROPFIND,PROPPATCH,MKCOL,MOVE,COPY,OPTIONS';
const ALLOW_HEADERS = 'Authorization,Content-Type,Depth,If-Match,If-None-Match,Destination,Overwrite';
const EXPOSE_HEADERS = 'ETag,DAV,Content-Length,Allow';

// A plain HTTP front so CORS preflights are answered before authentication (browsers never send
// credentials on preflight requests) and ETag is exposed to scripts.
const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    const setHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => {
      const n = String(name).toLowerCase();
      if (n === 'access-control-allow-origin') value = origin;
      if (n === 'access-control-expose-headers') value = EXPOSE_HEADERS;
      return setHeader(name, value);
    };
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', EXPOSE_HEADERS);
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.statusCode = 204;
      res.end();
      return;
    }
  }
  const method = req.method ?? 'GET';
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/(.)\/+$/, '$1');
  if ((path === NC || path.startsWith(`${NC}/`)) && ['GET', 'HEAD', 'PUT', 'DELETE'].includes(method)) {
    nextcloudLike(req, res, method, path).catch(() => res.destroy());
    return;
  }
  dav.executeRequest(req, res);
});

server.listen(port, '127.0.0.1', () => console.log(`[webdav] listening on http://127.0.0.1:${port}`));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
