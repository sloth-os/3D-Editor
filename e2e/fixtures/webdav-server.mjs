// Real WebDAV server for end-to-end tests (in-memory, basic auth, CORS for direct browser access).
// Usage: node fixtures/webdav-server.mjs [port]
import { v2 as webdav } from 'webdav-server';

const port = Number(process.argv[2] ?? process.env.WEBDAV_PORT ?? 4199);
const users = new webdav.SimpleUserManager();
const user = users.addUser('editor', 'secret', false);
const privileges = new webdav.SimplePathPrivilegeManager();
privileges.setRights(user, '/', ['all']);

const server = new webdav.WebDAVServer({
  port,
  hostname: '127.0.0.1',
  httpAuthentication: new webdav.HTTPBasicAuthentication(users, 'e2e'),
  privilegeManager: privileges,
  requireAuthentification: true,
});

server.beforeRequest((ctx, next) => {
  const origin = ctx.request.headers.origin;
  const res = ctx.response;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,DELETE,PROPFIND,PROPPATCH,MKCOL,MOVE,COPY,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Depth,If-Match,If-None-Match,Destination,Overwrite');
    res.setHeader('Access-Control-Expose-Headers', 'ETag,DAV,Content-Length');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (ctx.request.method === 'OPTIONS' && origin) {
    res.statusCode = 204;
    res.end();
    ctx.exit();
    return;
  }
  next();
});

server.start(() => console.log(`[webdav] listening on http://127.0.0.1:${port}`));
const stop = () => server.stop(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
