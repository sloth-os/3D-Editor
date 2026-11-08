import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ProjectFileStore, WebDAVClient, type ProjectInfo } from '../src';

/*
 * Several writers saving one project to a WebDAV server at once. The server below is an
 * in-memory WebDAV server behind a fetch function: each writer gets its own fetch (and client),
 * and a test runs another writer's save at an exact point between one writer's requests.
 */

interface DavOptions {
  /** ETag header with GET and HEAD responses (else: none, as when CORS does not expose it). */
  etagOnGet?: boolean;
  /** ETag header with PUT responses. */
  etagOnPut?: boolean;
  /** getetag in PROPFIND responses (default true). */
  propfindEtag?: boolean;
  /** Checks If-Match and If-None-Match on PUT (else ignores them, like nginx or rclone). */
  conditional?: boolean;
}

interface Request {
  who: string;
  method: string;
  path: string;
}

interface Hook {
  when: 'before' | 'after';
  match: (req: Request) => boolean;
  run: () => Promise<unknown> | unknown;
}

class MemoryDav {
  readonly files = new Map<string, { data: Uint8Array; etag: string }>();
  /** Every version ever stored, by ETag. */
  readonly versions = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>(['/']);
  readonly requests: Request[] = [];
  private hooks: Hook[] = [];
  private counter = 0;

  constructor(readonly opts: DavOptions) {}

  /** Runs `run` once, before (or after) the first request that matches. */
  once(when: Hook['when'], match: Hook['match'], run: Hook['run']): void {
    this.hooks.push({ when, match, run });
  }

  /** Stores a version directly (a writer that does not merge, e.g. one that read an older state). */
  put(path: string, data: Uint8Array): string {
    const etag = `"v${++this.counter}"`;
    this.files.set(path, { data: data.slice(), etag });
    this.versions.set(etag, data.slice());
    return etag;
  }

  private async runHooks(when: Hook['when'], req: Request): Promise<void> {
    const hook = this.hooks.find((h) => h.when === when && h.match(req));
    if (!hook) return;
    this.hooks.splice(this.hooks.indexOf(hook), 1);
    await hook.run();
  }

  /** The fetch function of one writer. */
  fetchFor(who: string): typeof fetch {
    return (async (input: string | URL | globalThis.Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const req: Request = { who, method: init.method ?? 'GET', path: decodeURIComponent(url.pathname) };
      this.requests.push(req);
      await this.runHooks('before', req);
      const res = this.handle(req, new Headers(init.headers), init.body as Uint8Array | string | undefined);
      await this.runHooks('after', req);
      return res;
    }) as typeof fetch;
  }

  private handle(req: Request, headers: Headers, body: Uint8Array | string | undefined): Response {
    const path = req.path.replace(/(.)\/$/, '$1');
    const file = this.files.get(path);
    switch (req.method) {
      case 'GET':
      case 'HEAD': {
        if (!file) return new Response(null, { status: 404 });
        const h = this.opts.etagOnGet ? { ETag: file.etag } : undefined;
        return new Response(req.method === 'GET' ? file.data.slice() : null, { status: 200, headers: h });
      }
      case 'PUT': {
        if (!this.dirs.has(path.slice(0, path.lastIndexOf('/')) || '/'))
          return new Response(null, { status: 409 });
        const ifMatch = headers.get('If-Match');
        const ifNoneMatch = headers.get('If-None-Match');
        if (this.opts.conditional && ((ifMatch && file?.etag !== ifMatch) || (ifNoneMatch === '*' && file)))
          return new Response(null, { status: 412 });
        const etag = this.put(path, typeof body === 'string' ? new TextEncoder().encode(body) : body!);
        return new Response(null, {
          status: file ? 204 : 201,
          headers: this.opts.etagOnPut ? { ETag: etag } : undefined,
        });
      }
      case 'PROPFIND': {
        if (!file && !this.dirs.has(path)) return new Response(null, { status: 404 });
        const etag = file && this.opts.propfindEtag !== false ? `<d:getetag>${file.etag}</d:getetag>` : '';
        const type = file ? '<d:resourcetype/>' : '<d:resourcetype><d:collection/></d:resourcetype>';
        const xml =
          `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${path}</d:href>` +
          `<d:propstat><d:prop>${type}${etag}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>` +
          `</d:response></d:multistatus>`;
        return new Response(xml, { status: 207, headers: { 'Content-Type': 'application/xml' } });
      }
      case 'MKCOL':
        if (this.dirs.has(path)) return new Response(null, { status: 405 });
        this.dirs.add(path);
        return new Response(null, { status: 201 });
      default:
        return new Response(null, { status: 405 });
    }
  }
}

const ID = 'p1';
const DOC = `/projects/${ID}/document.ybin`;
const info = (): ProjectInfo => ({
  id: ID,
  name: 'Project',
  created_at: '2026-11-07T00:00:00.000Z',
  updated_at: '2026-11-07T00:00:00.000Z',
  schema_version: 1,
});

function writer(dav: MemoryDav, who: string) {
  const store = new ProjectFileStore(new WebDAVClient({ url: 'http://dav.test/' }, dav.fetchFor(who)), '/');
  const doc = new Y.Doc();
  return {
    store,
    doc,
    set: (key: string) => doc.getMap('m').set(key, true),
    sync: (opts: { lastEtag?: string; info?: () => ProjectInfo } = {}) => store.syncDocument(ID, doc, opts),
  };
}

/** The keys of the stored document. */
function stored(dav: MemoryDav): string[] {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, dav.files.get(DOC)!.data);
  return [...doc.getMap('m').keys()].sort();
}

const keys = (doc: Y.Doc) => [...doc.getMap('m').keys()].sort();
const is =
  (who: string, method: string, path = DOC) =>
  (r: Request) =>
    r.who === who && r.method === method && r.path === path;

describe('WebDAV client: ETags only with their own content', () => {
  it('reads again when a write comes between the GET and the PROPFIND that asks for its ETag', async () => {
    // the server sends no ETag with GET: the client learns it from PROPFIND
    const dav = new MemoryDav({ conditional: true });
    dav.dirs.add('/d');
    dav.put('/d/f', new Uint8Array([1]));
    dav.once('after', is('reader', 'GET', '/d/f'), () => dav.put('/d/f', new Uint8Array([2])));
    const client = new WebDAVClient({ url: 'http://dav.test/' }, dav.fetchFor('reader'));
    const r = (await client.read('/d/f'))!;
    expect([...r.data]).toEqual([2]);
    // the ETag names exactly the content read (it used to be the ETag of [2] with the content [1])
    expect([...dav.versions.get(r.etag!)!]).toEqual([...r.data]);
  });

  it('reports no ETag when writes keep coming between its requests', async () => {
    const dav = new MemoryDav({ conditional: true });
    dav.dirs.add('/d');
    dav.put('/d/f', new Uint8Array([0]));
    for (let i = 1; i <= 3; i++)
      dav.once('after', is('reader', 'GET', '/d/f'), () => dav.put('/d/f', new Uint8Array([i])));
    const client = new WebDAVClient({ url: 'http://dav.test/' }, dav.fetchFor('reader'));
    const r = (await client.read('/d/f'))!;
    expect(r.etag).toBeUndefined();
    expect(dav.requests.filter((q) => q.method === 'GET')).toHaveLength(3);
  });

  it("reports a write's ETag only from the PUT response, never a later write's", async () => {
    const dav = new MemoryDav({ conditional: true });
    dav.dirs.add('/d');
    dav.once('after', is('w', 'PUT', '/d/f'), () => dav.put('/d/f', new Uint8Array([9])));
    const client = new WebDAVClient({ url: 'http://dav.test/' }, dav.fetchFor('w'));
    expect((await client.write('/d/f', new Uint8Array([1]))).etag).toBeUndefined();
    // a server that sends it: the ETag of this write, also when another write follows at once
    const withEtag = new MemoryDav({ conditional: true, etagOnPut: true });
    withEtag.dirs.add('/d');
    withEtag.once('after', is('w', 'PUT', '/d/f'), () => withEtag.put('/d/f', new Uint8Array([9])));
    const w = new WebDAVClient({ url: 'http://dav.test/' }, withEtag.fetchFor('w'));
    const { etag } = await w.write('/d/f', new Uint8Array([1]));
    expect([...withEtag.versions.get(etag!)!]).toEqual([1]);
  });
});

describe('ProjectFileStore.syncDocument with several writers on WebDAV', () => {
  it('merges a write that came between reading the document and its ETag (lastEtag)', async () => {
    const dav = new MemoryDav({ conditional: true });
    const a = writer(dav, 'A');
    const b = writer(dav, 'B');
    a.set('base');
    await a.sync();
    // B reads the document, then A saves its change before B asks for the ETag
    a.set('a');
    dav.once('after', is('B', 'GET'), () => a.sync());
    const first = await b.sync();
    // B's next sync, given the ETag of its last one, must not skip A's change as known
    await b.sync({ lastEtag: first.etag });
    expect(keys(b.doc)).toEqual(['a', 'base']);
  });

  it('merges a write that came between its own write and that ETag (lastEtag)', async () => {
    const dav = new MemoryDav({ conditional: true });
    const a = writer(dav, 'A');
    const b = writer(dav, 'B');
    a.set('base');
    await a.sync();
    await b.sync();
    // B saves; A saves its change (merging B's) before B could ask for its write's ETag
    b.set('b');
    a.set('a');
    dav.once('after', is('B', 'PUT'), () => a.sync());
    const first = await b.sync();
    await b.sync({ lastEtag: first.etag });
    expect(keys(b.doc)).toEqual(['a', 'b', 'base']);
  });

  it('never replaces a write with If-Match the ETag of that write, based on older content', async () => {
    const dav = new MemoryDav({ conditional: true });
    const a = writer(dav, 'A');
    const b = writer(dav, 'B');
    a.set('base');
    await a.sync();
    await b.sync();
    a.set('a');
    b.set('b');
    // B reads the document; A saves before B asks for the ETag, and A's writer goes away
    dav.once('after', is('B', 'GET'), async () => {
      await a.sync();
      a.doc.destroy();
    });
    await b.sync();
    // B's write with If-Match that ETag used to be accepted, and replaced A's change for good
    expect(stored(dav)).toEqual(['a', 'b', 'base']);
  });
});

describe('ProjectFileStore.syncDocument on a server like Nextcloud', () => {
  it('takes ETags from GET and PUT, and confirms a write with a HEAD request', async () => {
    const dav = new MemoryDav({ conditional: true, etagOnGet: true, etagOnPut: true });
    const a = writer(dav, 'A');
    const b = writer(dav, 'B');
    a.set('base');
    await a.sync();
    await b.sync();
    a.set('a');
    b.set('b');
    // A saves right after B's check before writing: B's If-Match fails (412), it reads again
    dav.once('after', is('B', 'HEAD'), () => a.sync());
    const from = dav.requests.length;
    const res = await b.sync();
    expect(res).toMatchObject({ pulled: true, pushed: true });
    expect(stored(dav)).toEqual(['a', 'b', 'base']);
    expect(res.etag).toBe(dav.files.get(DOC)!.etag);
    const docRequests = dav.requests
      .slice(from)
      .filter((r) => r.who === 'B' && r.path === DOC)
      .map((r) => r.method);
    // read, check, write (412), read, check, write, confirm (no GET of its own write)
    expect(docRequests).toEqual(['GET', 'HEAD', 'PUT', 'GET', 'HEAD', 'PUT', 'HEAD']);
  });
});

describe('ProjectFileStore.syncDocument on servers that ignore If-Match', () => {
  it('reads its write back and writes again when another write replaced it', async () => {
    // like the tests' webdav-server: no ETag with GET or PUT, If-Match ignored
    const dav = new MemoryDav({ conditional: false });
    const a = writer(dav, 'A');
    a.set('base');
    await a.sync();
    const old = dav.files.get(DOC)!.data;
    const other = new Y.Doc();
    Y.applyUpdate(other, old);
    other.getMap('m').set('c', true);
    // another writer that read the document before A's save writes right after it
    a.set('a');
    dav.once('after', is('A', 'PUT'), () => dav.put(DOC, Y.encodeStateAsUpdate(other)));
    const res = await a.sync();
    expect(res.pushed).toBe(true);
    expect(stored(dav)).toEqual(['a', 'base', 'c']);
    expect(keys(a.doc)).toEqual(['a', 'base', 'c']);
  });

  it.each([false, true])(
    'does not write over a write that came after its read (ETag with GET: %s)',
    async (etagOnGet) => {
      const dav = new MemoryDav({ conditional: false, etagOnGet });
      const a = writer(dav, 'A');
      const b = writer(dav, 'B');
      a.set('base');
      await a.sync();
      await b.sync();
      a.set('a');
      b.set('b');
      // A saves after B has read the document and its ETag (the GET, or the PROPFIND after it),
      // before B writes; then A goes away
      let propfinds = 0;
      dav.once(
        'after',
        (r) =>
          r.who === 'B' &&
          r.path === DOC &&
          (etagOnGet ? r.method === 'GET' : r.method === 'PROPFIND' && ++propfinds === 2),
        async () => {
          await a.sync();
          a.doc.destroy();
        },
      );
      await b.sync();
      expect(stored(dav)).toEqual(['a', 'b', 'base']);
    },
  );

  it('does not read again when the write that replaced its own already holds its changes', async () => {
    const dav = new MemoryDav({ conditional: false });
    const a = writer(dav, 'A');
    const b = writer(dav, 'B');
    a.set('base');
    await a.sync();
    await b.sync();
    a.set('a');
    b.set('b');
    // A saves right after B's write: it merges B's change and replaces B's write with both
    dav.once('after', is('B', 'PUT'), () => a.sync());
    const from = dav.requests.length;
    await b.sync();
    expect(stored(dav)).toEqual(['a', 'b', 'base']);
    expect(keys(b.doc)).toEqual(['a', 'b', 'base']);
    const own = dav.requests.slice(from).filter((r) => r.who === 'B');
    // after its write, one GET (the read-back) shows that nothing is left to write
    expect(own.slice(own.findIndex((r) => r.method === 'PUT')).map((r) => r.method)).toEqual(['PUT', 'GET']);
  });

  it('keeps both changes on a server that reports no ETag at all', async () => {
    const dav = new MemoryDav({ conditional: false, propfindEtag: false });
    const a = writer(dav, 'A');
    const b = writer(dav, 'B');
    a.set('base');
    await a.sync();
    expect((await b.store.loadDocument(ID))!.etag).toBeUndefined();
    await b.sync();
    a.set('a');
    b.set('b');
    // A's save lands between B's write and B's read-back
    dav.once('after', is('B', 'PUT'), async () => {
      const other = new Y.Doc();
      Y.applyUpdate(other, Y.encodeStateAsUpdate(a.doc));
      dav.put(DOC, Y.encodeStateAsUpdate(other));
    });
    await b.sync();
    expect(stored(dav)).toEqual(['a', 'b', 'base']);
  });
});

/*
 * The requests of one save. On servers that ignore If-Match, a save that lands between a writer's
 * ETag check and its write is replaced by that write: no other request may come between the two
 * (the MKCOL requests that create the project's folders used to). Reads whose ETag is not used
 * (project.json, the read-back of a write) are a single GET.
 */
describe('ProjectFileStore.syncDocument: the requests of a save', () => {
  const servers: [string, DavOptions][] = [
    ["the tests' webdav-server (no ETag with GET or PUT)", { conditional: false }],
    ['nginx (ETag with GET, not with PUT)', { conditional: false, etagOnGet: true }],
    [
      'Nextcloud (ETags with GET and PUT, If-Match checked)',
      { conditional: true, etagOnGet: true, etagOnPut: true },
    ],
  ];
  const sent = (dav: MemoryDav, from: number) =>
    dav.requests.slice(from).map((r) => `${r.method} ${r.path.replace(`/projects/${ID}`, '~')}`);

  it.each(servers)('of an existing project: check, then write at once (%s)', async (_, opts) => {
    const dav = new MemoryDav(opts);
    const a = writer(dav, 'A');
    const b = writer(dav, 'B');
    a.set('base');
    await a.sync({ info });
    await b.sync();
    b.set('b');
    const from = dav.requests.length;
    // what a server room does: project.json, then the document with the info
    await b.store.loadInfo(ID);
    await b.sync({ info });
    const read = opts.etagOnGet
      ? ['GET ~/document.ybin']
      : ['PROPFIND ~/document.ybin', 'GET ~/document.ybin', 'PROPFIND ~/document.ybin'];
    const check = opts.etagOnGet ? 'HEAD ~/document.ybin' : 'PROPFIND ~/document.ybin';
    const confirm = opts.etagOnPut ? 'HEAD ~/document.ybin' : 'GET ~/document.ybin';
    expect(sent(dav, from)).toEqual([
      'GET ~/project.json',
      ...read,
      check,
      'PUT ~/document.ybin',
      confirm,
      'PUT ~/project.json',
    ]);
    expect(stored(dav)).toEqual(['b', 'base']);
  });

  it.each(servers)('of a new project: folders, then check, then write at once (%s)', async (_, opts) => {
    const dav = new MemoryDav(opts);
    const a = writer(dav, 'A');
    a.set('a');
    await a.sync({ info });
    // a new client does not know yet whether GET responses carry an ETag: PROPFIND
    expect(sent(dav, 0)).toEqual([
      'PROPFIND ~/document.ybin',
      'GET ~/document.ybin',
      'MKCOL /projects/',
      'MKCOL ~/',
      'PROPFIND ~/document.ybin',
      'PUT ~/document.ybin',
      opts.etagOnPut ? 'PROPFIND ~/document.ybin' : 'GET ~/document.ybin',
      'PUT ~/project.json',
    ]);
  });

  it.each([
    [false, true],
    [true, true],
    // nginx: PROPFIND reports no getetag, so the check before writing cannot see the new file's ETag
    [false, false],
    [true, false],
  ])(
    'keeps a project another writer creates while it creates the folders (ETag with GET: %s, in PROPFIND: %s)',
    async (etagOnGet, propfindEtag) => {
      const dav = new MemoryDav({ conditional: false, etagOnGet, propfindEtag });
      const a = writer(dav, 'A');
      const b = writer(dav, 'B');
      a.set('a');
      b.set('b');
      // B found no document; A creates it while B creates the folders, then A goes away
      dav.once(
        'before',
        (r) => r.who === 'B' && r.method === 'MKCOL',
        async () => {
          await a.sync();
          a.doc.destroy();
        },
      );
      await b.sync();
      expect(stored(dav)).toEqual(['a', 'b']);
      expect(keys(b.doc)).toEqual(['a', 'b']);
    },
  );
});
