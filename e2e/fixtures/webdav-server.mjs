// Real WebDAV server for end-to-end tests (in-memory, basic auth, CORS for direct browser access).
// Usage: node fixtures/webdav-server.mjs [port]
import http from 'node:http';
import { v2 as webdav } from 'webdav-server';

const port = Number(process.argv[2] ?? process.env.WEBDAV_PORT ?? 4199);
const users = new webdav.SimpleUserManager();
const user = users.addUser('editor', 'secret', false);
const privileges = new webdav.SimplePathPrivilegeManager();
privileges.setRights(user, '/', ['all']);

const dav = new webdav.WebDAVServer({
  httpAuthentication: new webdav.HTTPBasicAuthentication(users, 'e2e'),
  privilegeManager: privileges,
  requireAuthentification: true,
});

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
  dav.executeRequest(req, res);
});

server.listen(port, '127.0.0.1', () => console.log(`[webdav] listening on http://127.0.0.1:${port}`));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
