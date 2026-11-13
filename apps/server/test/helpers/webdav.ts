import http, { type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Writable } from 'node:stream';
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

export interface TestWebDAVOptions {
  username?: string;
  password?: string;
  /**
   * Send the ETag of a file with GET, HEAD and PUT responses, like Nextcloud and rclone (a new
   * one for every write). Without it, like webdav-server itself: no ETag with GET or PUT, only
   * PROPFIND reports one (an md5 of the modification time in ms).
   */
  etagHeaders?: boolean;
  /**
   * Check If-Match and If-None-Match on PUT and apply the write in the same step (HTTP 412 when
   * they fail), like Nextcloud and Apache. Without it they are ignored, like webdav-server itself,
   * nginx and rclone. ETags then change with every write (also in PROPFIND).
   */
  conditional?: boolean;
  /**
   * Runs before a request is handled: tests let another writer save at an exact point between a
   * writer's requests (tell writers apart by a header their client sends).
   */
  onRequest?: (req: { method: string; path: string; headers: IncomingHttpHeaders }) => unknown;
}

/** Virtual file system whose ETags change with every write (a counter, like Nextcloud's). */
class VersionedFileSystem extends webdav.VirtualFileSystem {
  private counter = 0;
  private readonly versions = new Map<string, number>();

  /** The ETag of a file, or null when there is none at that path. */
  etagOf(path: string): string | null {
    const r = this.resources[path];
    return r && r.type.isFile ? `"w${this.versions.get(path) ?? 0}"` : null;
  }

  protected override _openWriteStream(
    path: webdav.Path,
    ctx: webdav.OpenWriteStreamInfo,
    callback: webdav.ReturnCallback<Writable>,
  ): void {
    super._openWriteStream(path, ctx, (e, stream) => {
      // after the content is replaced (the listener registered before this one)
      stream?.on('finish', () => this.versions.set(path.toString(), ++this.counter));
      callback(e, stream);
    });
  }

  protected override _etag(
    path: webdav.Path,
    _ctx: webdav.ETagInfo,
    callback: webdav.ReturnCallback<string>,
  ): void {
    callback(undefined, `"w${this.versions.get(path.toString()) ?? 0}"`);
  }
}

/** Whether an If-Match / If-None-Match value names `etag` (null: no file). */
function names(header: string, etag: string | null): boolean {
  if (header.trim() === '*') return etag !== null;
  return etag !== null && header.split(',').some((t) => t.trim() === etag);
}

/**
 * In-process WebDAV server (webdav-server v2, in-memory file system, basic auth) behind an HTTP
 * front that adds what the options ask for.
 */
export async function startWebDAV(opts: TestWebDAVOptions = {}): Promise<TestWebDAV> {
  const username = opts.username ?? 'alice';
  const password = opts.password ?? 'secret';
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const users = new webdav.SimpleUserManager();
  const user = users.addUser(username, password, false);
  const privileges = new webdav.SimplePathPrivilegeManager();
  privileges.setRights(user, '/', ['all']);
  const versioned = opts.etagHeaders || opts.conditional ? new VersionedFileSystem() : null;
  const server = new webdav.WebDAVServer({
    httpAuthentication: new webdav.HTTPBasicAuthentication(users, 'test'),
    privilegeManager: privileges,
    ...(versioned ? { rootFileSystem: versioned } : {}),
  });
  // GET, HEAD, PUT and DELETE of a path run one at a time: an ETag sent with a GET belongs to the
  // content sent, and a conditional PUT is checked and written in one step
  const locks = new Map<string, Promise<void>>();
  const lock = async (key: string): Promise<() => void> => {
    const prev = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    const chained = prev.then(() => next);
    locks.set(key, chained);
    await prev;
    return () => {
      release();
      if (locks.get(key) === chained) locks.delete(key);
    };
  };
  const front = http.createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/(.)\/+$/, '$1');
      await opts.onRequest?.({ method, path, headers: req.headers });
      if (!versioned || !['GET', 'HEAD', 'PUT', 'DELETE'].includes(method)) {
        server.executeRequest(req, res);
        return;
      }
      const release = await lock(path);
      res.once('close', release);
      if (req.headers.authorization === authorization) {
        const current = versioned.etagOf(path);
        if (method === 'PUT' && opts.conditional) {
          const ifMatch = req.headers['if-match'];
          const ifNoneMatch = req.headers['if-none-match'];
          if ((ifMatch && !names(ifMatch, current)) || (ifNoneMatch && names(ifNoneMatch, current))) {
            req.resume();
            res.writeHead(412).end();
            return;
          }
        }
        if (opts.etagHeaders && (method === 'GET' || method === 'HEAD') && current)
          res.setHeader('ETag', current);
        if (opts.etagHeaders && method === 'PUT') withEtagOnEnd(res, () => versioned.etagOf(path));
      }
      server.executeRequest(req, res);
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
  const port = (front.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    username,
    password,
    server,
    authorization,
    stop: () =>
      new Promise<void>((resolve) => {
        front.close(() => resolve());
        front.closeAllConnections();
      }),
  };
}

/** Adds the ETag of the written file to a successful PUT response (sent when it ends). */
function withEtagOnEnd(res: ServerResponse, etag: () => string | null): void {
  const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
  res.end = ((...args: unknown[]) => {
    const value = res.statusCode < 300 && !res.headersSent ? etag() : null;
    if (value) res.setHeader('ETag', value);
    return end(...args);
  }) as ServerResponse['end'];
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
