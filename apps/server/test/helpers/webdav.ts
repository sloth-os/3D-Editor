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
   * Hold write locks by their tokens, against the user who took them too (webdav-server lets that
   * user write without the lock's token, holds every condition of an If header true and fails on a
   * list without a resource tag). A PUT, PROPPATCH, DELETE, MKCOL or MOVE of a locked path, or of a
   * path under a collection locked with depth infinity, is answered 423 Locked, with the root of the
   * lock in a `lock-token-submitted` error as Sabre/DAV writes it (`<d:href>/a/x.txt</d:href>`),
   * unless its If header submits the lock's token in a list that applies to the path: a list without
   * a tag, or one tagged with this server's URL of the path (`<http://127.0.0.1:<port>/a/x.txt>` or
   * `</a/x.txt>`, its query aside); a tag that names another server's resource applies to none of
   * them. That is stricter, on purpose, than Apache httpd's mod_dav and Sabre/DAV, which take a
   * lock's token from any list of the header, one tagged with another resource too: a test then sees
   * each tag arrive mapped, since a tag left in the editor's namespace would apply to nothing and the
   * write would get 423. A request whose If header has lists that apply to its path, none of which
   * holds (its conditions: the tokens of the locks that cover the path, its ETag), is answered 412,
   * and one whose If header does not parse 400. The front reads the If header and passes requests on
   * without it (LOCK's, which renew a lock with it, with it); files get ETags that change with every
   * write, as with `conditional`.
   */
  locks?: boolean;
  /**
   * With `locks`: give out lock tokens as golang.org/x/net/webdav does, and so rclone, bare
   * decimal numbers (`Lock-Token: <1795880655>`), in place of webdav-server's `urn:uuid:…`. The front
   * then answers LOCK and UNLOCK itself, as x/net/webdav does. A LOCK with a body locks a path that
   * holds a resource (404 for one that does not, where x/net/webdav creates an empty file; 423 for
   * one a lock covers) and is answered 200 with the lock's token in `Lock-Token` and its lock
   * discovery (`<D:lockroot><D:href>/a/x.txt</D:href>`); a LOCK without one renews the lock whose
   * token is the one condition of the If header's one list, a list that applies to the path (400 for
   * an If header of another shape, 412 when no such lock covers the path), and is answered 200 with
   * its lock discovery and no `Lock-Token`. An UNLOCK takes off the lock its `Lock-Token` names (204;
   * 409 for no such lock, 400 for a value not in `<` and `>`).
   */
  decimalLockTokens?: boolean;
  /**
   * Runs before a request is handled: tests let another writer save at an exact point between a
   * writer's requests (tell writers apart by a header their client sends). `path` is decoded,
   * without the query; `url` is the request target as the server got it; `headers` a copy of its
   * headers as they arrived.
   */
  onRequest?: (req: { method: string; path: string; url: string; headers: IncomingHttpHeaders }) => unknown;
}

/** A lock the front holds (option `locks`). */
interface HeldLock {
  /**
   * The lock's token as webdav-server gives it out (`urn:uuid:…`), or the front with
   * `decimalLockTokens` (`1795880655`), without `<` and `>`.
   */
  token: string;
  /** Decoded path of the lock's root. */
  root: string;
  /** Depth infinity: the lock covers the paths under its root too. */
  deep: boolean;
}

/** One list of an If header: its resource tag (null without one) and its conditions. */
interface IfList {
  tag: string | null;
  conditions: { not: boolean; token?: string; etag?: string }[];
}

/**
 * The lists of an If header (RFC 4918 section 10.4.2), or null when it is none: a resource tag or
 * state token in `<…>`, `(` and `)` around a list, `Not`, an entity tag in `[…]` (a quoted string,
 * `\` escapes the character after it), with spaces and tabs between them.
 */
function parseIfLists(header: string): IfList[] | null {
  const token = /[ \t]*(?:<([^<>\s]+)>|(\()|(\))|(not)(?=[ \t<[])|\[((?:W\/)?"(?:[^"\\]|\\.)*")\])/iy;
  const lists: IfList[] = [];
  let tag: string | null = null;
  let list: IfList | null = null;
  let not = false;
  for (;;) {
    const at = token.lastIndex;
    const m = token.exec(header);
    if (!m) return header.slice(at).trim() === '' && !list && lists.length > 0 ? lists : null;
    const [, url, open, close, notWord, etag] = m;
    if (url !== undefined) {
      if (list) list.conditions.push({ not, token: url });
      else tag = url;
      not = false;
    } else if (open) {
      if (list) return null;
      list = { tag, conditions: [] };
    } else if (close) {
      if (!list || not || list.conditions.length === 0) return null;
      lists.push(list);
      list = null;
    } else if (notWord) {
      if (!list || not) return null;
      not = true;
    } else {
      if (!list) return null;
      list.conditions.push({ not, etag });
      not = false;
    }
  }
}

/** The body of a 423 answer, as Sabre/DAV writes it: the root of the lock whose token is missing. */
function lockedBody(root: string): string {
  const href = root.split('/').map(encodeURIComponent).join('/');
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:error xmlns:d="DAV:"><d:lock-token-submitted><d:href>${href}</d:href></d:lock-token-submitted></d:error>`;
}

/** Methods that change the resource at the request's path, which a lock on it holds back. */
const LOCKED_METHODS = new Set(['PUT', 'PROPPATCH', 'DELETE', 'MKCOL', 'MOVE']);

/** The first lock token the front gives out with `decimalLockTokens` (one more for each later lock). */
const FIRST_DECIMAL_TOKEN = 1_795_880_655;

/**
 * The answer to a LOCK as golang.org/x/net/webdav writes it (writeLockInfo): the lock's discovery,
 * its root as a path (`/a/x.txt`).
 */
function lockInfoBody(lock: HeldLock, timeout: string): string {
  const root = lock.root.split('/').map(encodeURIComponent).join('/');
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>\n' +
    '\t<D:locktype><D:write/></D:locktype>\n' +
    '\t<D:lockscope><D:exclusive/></D:lockscope>\n' +
    `\t<D:depth>${lock.deep ? 'infinity' : '0'}</D:depth>\n` +
    `\t<D:timeout>${timeout}</D:timeout>\n` +
    `\t<D:locktoken><D:href>${lock.token}</D:href></D:locktoken>\n` +
    `\t<D:lockroot><D:href>${root}</D:href></D:lockroot>\n` +
    '</D:activelock></D:lockdiscovery></D:prop>'
  );
}

/** Reads a request's body as text. */
async function readText(req: http.IncomingMessage): Promise<string> {
  let text = '';
  req.setEncoding('utf8');
  for await (const chunk of req) text += chunk as string;
  return text;
}

/** Virtual file system whose ETags change with every write (a counter, like Nextcloud's). */
class VersionedFileSystem extends webdav.VirtualFileSystem {
  private counter = 0;
  private readonly versions = new Map<string, number>();

  /** Whether a resource, a file or a collection, is at the path. */
  has(path: string): boolean {
    return this.resources[path] !== undefined;
  }

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
  const versioned = opts.etagHeaders || opts.conditional || opts.locks ? new VersionedFileSystem() : null;
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
  // option `locks`: the locks taken, by token
  const held = new Map<string, HeldLock>();
  const covering = (path: string): HeldLock[] =>
    [...held.values()].filter(
      (l) => l.root === path || (l.deep && (l.root === '/' || path.startsWith(`${l.root}/`))),
    );
  /** The path the request target or resource tag `ref` names on this server, or null for none of its own. */
  const pathOf = (ref: string): string | null => {
    try {
      const u = new URL(ref, `${origin}/`);
      return u.origin === origin ? decodeURIComponent(u.pathname).replace(/(.)\/+$/, '$1') : null;
    } catch {
      return null;
    }
  };
  // option `decimalLockTokens`: the token of the next lock taken
  let nextDecimalToken = FIRST_DECIMAL_TOKEN;
  /** Option `decimalLockTokens`: answers a LOCK or an UNLOCK as golang.org/x/net/webdav does. */
  const answerDecimalLock = async (
    req: http.IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
  ): Promise<void> => {
    const body = await readText(req);
    if (req.headers.authorization !== authorization) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="test"' }).end();
      return;
    }
    if (method === 'UNLOCK') {
      const value = String(req.headers['lock-token'] ?? '');
      if (value.length < 2 || !value.startsWith('<') || !value.endsWith('>')) res.writeHead(400).end();
      else res.writeHead(held.delete(value.slice(1, -1)) ? 204 : 409).end();
      return;
    }
    const timeout = String(req.headers.timeout ?? '');
    let lock: HeldLock | undefined;
    if (body.trim() === '') {
      // a refresh: the If header's one list holds one condition, the lock's token
      const sent = req.headers.if;
      const lists = parseIfLists(Array.isArray(sent) ? sent.join(', ') : (sent ?? '')) ?? [];
      const condition =
        lists.length === 1 && lists[0].conditions.length === 1 ? lists[0].conditions[0] : null;
      if (!condition?.token || condition.not) {
        res.writeHead(400).end();
        return;
      }
      const applies = (lists[0].tag === null ? path : pathOf(lists[0].tag)) === path;
      lock = applies ? covering(path).find((l) => l.token === condition.token) : undefined;
      if (!lock) {
        res.writeHead(412).end();
        return;
      }
    } else {
      if (!versioned?.has(path)) {
        res.writeHead(404).end();
        return;
      }
      const covered = covering(path)[0];
      if (covered) {
        res
          .writeHead(423, { 'content-type': 'application/xml; charset=utf-8' })
          .end(lockedBody(covered.root));
        return;
      }
      lock = { token: String(nextDecimalToken++), root: path, deep: req.headers.depth !== '0' };
      held.set(lock.token, lock);
      res.setHeader('lock-token', `<${lock.token}>`);
    }
    res
      .writeHead(200, { 'content-type': 'application/xml; charset=utf-8' })
      .end(lockInfoBody(lock, /^Second-\d+$/.test(timeout) ? timeout : 'Infinite'));
  };
  /**
   * Option `locks`: whether the request may go on, else answers it (400, 412 or 423); keeps the
   * locks taken up to date when it may.
   */
  const checkLocks = (
    req: http.IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
  ): boolean => {
    if (method === 'LOCK') {
      const deep = req.headers.depth !== '0';
      beforeEnd(res, () => {
        const token = res.getHeader('lock-token');
        if (res.statusCode < 300 && typeof token === 'string') {
          const bare = token.replace(/^<|>$/g, '');
          held.set(bare, { token: bare, root: path, deep });
        }
      });
      return true;
    }
    // several If lines, which Node joins with `, ` (an array only for a type's sake)
    const sent = req.headers.if;
    const header = Array.isArray(sent) ? sent.join(', ') : sent;
    delete req.headers.if;
    const lists = header === undefined ? [] : parseIfLists(header);
    const refuse = (status: number, body?: string) => {
      req.resume();
      if (body) res.writeHead(status, { 'content-type': 'application/xml; charset=utf-8' }).end(body);
      else res.writeHead(status).end();
      return false;
    };
    if (lists === null) return refuse(400);
    const tokens = covering(path).map((l) => l.token);
    const etag = versioned?.etagOf(path) ?? null;
    const applying = lists.filter((l) => (l.tag === null ? path : pathOf(l.tag)) === path);
    // a state token matches a lock that covers the path, an entity tag the path's (weakly)
    const holds = (l: IfList) =>
      l.conditions.every(
        (c) =>
          c.not !== (c.token !== undefined ? tokens.includes(c.token) : c.etag?.replace(/^W\//, '') === etag),
      );
    if (applying.length > 0 && !applying.some(holds)) return refuse(412);
    if (LOCKED_METHODS.has(method)) {
      const missing = covering(path).find(
        (lock) => !applying.some((l) => l.conditions.some((c) => !c.not && c.token === lock.token)),
      );
      if (missing) return refuse(423, lockedBody(missing.root));
    }
    beforeEnd(res, () => {
      if (res.statusCode >= 300) return;
      if (method === 'UNLOCK') {
        held.delete(String(req.headers['lock-token'] ?? '').replace(/^\s*<|>\s*$/g, ''));
      } else if (method === 'DELETE' || method === 'MOVE') {
        for (const [token, l] of held)
          if (l.root === path || l.root.startsWith(`${path}/`)) held.delete(token);
      }
    });
    return true;
  };
  let origin = '';
  const front = http.createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/(.)\/+$/, '$1');
      await opts.onRequest?.({ method, path, url: req.url ?? '/', headers: { ...req.headers } });
      if (opts.locks && opts.decimalLockTokens && (method === 'LOCK' || method === 'UNLOCK')) {
        await answerDecimalLock(req, res, method, path);
        return;
      }
      if (opts.locks && !checkLocks(req, res, method, path)) return;
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
  origin = `http://127.0.0.1:${port}`;
  return {
    origin,
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

/** Runs `fn` when the response is ended, before its last bytes are sent (its status is set by then). */
function beforeEnd(res: ServerResponse, fn: () => void): void {
  const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
  res.end = ((...args: unknown[]) => {
    fn();
    return end(...args);
  }) as ServerResponse['end'];
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
