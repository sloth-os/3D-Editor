import type { Server } from 'node:http';
import { v2 as webdav } from 'webdav-server';

export interface TestWebDAV {
  /** http://127.0.0.1:<port> */
  origin: string;
  port: number;
  username: string;
  password: string;
  server: InstanceType<typeof webdav.WebDAVServer>;
  /** Basic auth header value. */
  authorization: string;
  stop(): Promise<void>;
}

/** In-process WebDAV server (webdav-server v2, in-memory file system, basic auth). */
export async function startWebDAV(opts: { username?: string; password?: string } = {}): Promise<TestWebDAV> {
  const username = opts.username ?? 'alice';
  const password = opts.password ?? 'secret';
  const users = new webdav.SimpleUserManager();
  const user = users.addUser(username, password, false);
  const privileges = new webdav.SimplePathPrivilegeManager();
  privileges.setRights(user, '/', ['all']);
  const server = new webdav.WebDAVServer({
    httpAuthentication: new webdav.HTTPBasicAuthentication(users, 'test'),
    privilegeManager: privileges,
    port: 0,
    hostname: '127.0.0.1',
  });
  await new Promise<void>((resolve) => server.start(() => resolve()));
  // the underlying http.Server is a protected member of WebDAVServer
  const address = (server as unknown as { server: Server }).server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    username,
    password,
    server,
    authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
    stop: () => new Promise<void>((resolve) => server.stop(() => resolve())),
  };
}

/** Creates nested collections on the WebDAV server (e.g. '/files/alice'). */
export async function mkcolPath(dav: TestWebDAV, p: string): Promise<void> {
  let cur = '';
  for (const part of p.split('/').filter(Boolean)) {
    cur += `/${encodeURIComponent(part)}`;
    const res = await fetch(`${dav.origin}${cur}/`, {
      method: 'MKCOL',
      headers: { authorization: dav.authorization },
    });
    if (!res.ok && res.status !== 405) throw new Error(`MKCOL ${cur} failed: ${res.status}`);
  }
}
