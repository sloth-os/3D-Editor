import type { FileEntry, FileStore, ReadOptions, WriteOptions } from './filestore';
import { MissingFolderError, PreconditionFailedError, joinPath } from './filestore';

export interface WebDAVConfig {
  /** Base URL of the WebDAV collection, e.g. https://dav.example.com/remote.php/dav/files/me */
  url: string;
  username?: string;
  password?: string;
  /** Bearer token (alternative to basic auth). */
  token?: string;
  headers?: Record<string, string>;
  /** Request timeout in milliseconds (default 30s). */
  timeoutMs?: number;
}

export class WebDAVError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'WebDAVError';
  }
}

function b64(s: string): string {
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(s)));
  return Buffer.from(s, 'utf8').toString('base64');
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

/** Extracts the text of the first `<prefix:tag>` element in an XML fragment (namespace agnostic). */
function tagText(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, 'i');
  const m = re.exec(xml);
  return m ? decodeXmlEntities(m[1].trim()) : undefined;
}

export interface DavResponse {
  href: string;
  isDir: boolean;
  size?: number;
  etag?: string;
  lastModified?: string;
  contentType?: string;
}

/** Parses a WebDAV multistatus PROPFIND response (namespace-prefix agnostic, no DOM needed). */
export function parseMultistatus(xml: string): DavResponse[] {
  const out: DavResponse[] = [];
  const re = /<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = m[1];
    const href = tagText(body, 'href');
    if (!href) continue;
    // only use propstat blocks with 200 status
    const propstats = [
      ...body.matchAll(/<(?:[\w.-]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?propstat>/gi),
    ].map((x) => x[1]);
    const ok = propstats.filter((p) => /\s200\s/.test(tagText(p, 'status') ?? ' 200 ')).join('\n') || body;
    const resType =
      /<(?:[\w.-]+:)?resourcetype\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?resourcetype>/i.exec(ok)?.[1] ?? '';
    const isDir = /<(?:[\w.-]+:)?collection\b/i.test(resType);
    const len = tagText(ok, 'getcontentlength');
    out.push({
      href,
      isDir,
      size: len !== undefined && len !== '' ? Number(len) : undefined,
      etag: tagText(ok, 'getetag'),
      lastModified: tagText(ok, 'getlastmodified'),
      contentType: tagText(ok, 'getcontenttype'),
    });
  }
  return out;
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getetag/><d:getlastmodified/><d:getcontenttype/></d:prop></d:propfind>`;

/**
 * How many times {@link WebDAVClient.read} reads a file whose ETag it can only learn from PROPFIND
 * when another write changes the file during each read, before it reports the ETag as unknown.
 */
const PAIRED_READ_ATTEMPTS = 3;

/** Small fetch-based WebDAV client (works in browsers, service workers and Node ≥ 18). */
export class WebDAVClient implements FileStore {
  private readonly base: URL;
  /**
   * Whether the server's GET responses carry an ETag the client can read (unknown until the first
   * read): some servers send none, and browsers hide it when CORS does not expose the header.
   */
  private getSendsEtag: boolean | undefined;

  constructor(
    readonly config: WebDAVConfig,
    private readonly fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {
    const u = config.url.endsWith('/') ? config.url : `${config.url}/`;
    this.base = new URL(u, typeof location !== 'undefined' ? location.href : 'http://localhost/');
  }

  /** Absolute URL for a store path. */
  urlFor(path: string): string {
    const rel = joinPath(path)
      .slice(1)
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
    return new URL(rel, this.base).toString();
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...(this.config.headers ?? {}), ...extra };
    if (this.config.token) h.Authorization = `Bearer ${this.config.token}`;
    else if (this.config.username)
      h.Authorization = `Basic ${b64(`${this.config.username}:${this.config.password ?? ''}`)}`;
    return h;
  }

  private async request(
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: BodyInit } = {},
  ): Promise<Response> {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.config.timeoutMs ?? 30000) : undefined;
    try {
      return await this.fetchImpl(this.urlFor(path), {
        method,
        headers: this.headers(init.headers),
        body: init.body,
        signal: ctrl?.signal,
        cache: 'no-store',
      } as RequestInit);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async propfind(path: string, depth: 0 | 1 = 1): Promise<DavResponse[]> {
    const res = await this.request('PROPFIND', path, {
      headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    });
    if (res.status === 404) return [];
    if (res.status !== 207 && !res.ok)
      throw new WebDAVError(`PROPFIND ${path} failed: ${res.status}`, res.status);
    return parseMultistatus(await res.text());
  }

  async list(dir: string): Promise<FileEntry[]> {
    const target = new URL(this.urlFor(dir).replace(/\/?$/, '/'));
    const entries = await this.propfind(dir, 1);
    const out: FileEntry[] = [];
    for (const e of entries) {
      const abs = new URL(e.href, target);
      const p = decodeURIComponent(abs.pathname).replace(/\/$/, '');
      if (p === decodeURIComponent(target.pathname).replace(/\/$/, '')) continue;
      const name = p.split('/').pop() ?? '';
      if (!name) continue;
      out.push({ name, isDir: e.isDir, size: e.size, etag: e.etag, lastModified: e.lastModified });
    }
    return out;
  }

  /**
   * Reads a file with the ETag of the content read: the one the GET response carries, or else
   * (servers that send none, browsers when CORS does not expose it) the one PROPFIND reports both
   * right before and right after the GET, which no write came between. While writes keep coming
   * between the two, it reads again, {@link PAIRED_READ_ATTEMPTS} times at most, and then reports
   * no ETag rather than the ETag of content it did not read. With `etag: false` it sends just the
   * GET (and reports the ETag only when the GET response carries one).
   */
  async read(path: string, opts: ReadOptions = {}): Promise<{ data: Uint8Array; etag?: string } | null> {
    for (let attempt = 1; ; attempt++) {
      const bracketed = opts.etag !== false && this.getSendsEtag !== true;
      const before = bracketed ? await this.propfindEtag(path) : undefined;
      const res = await this.request('GET', path);
      if (res.status === 404) return null;
      if (!res.ok) throw new WebDAVError(`GET ${path} failed: ${res.status}`, res.status);
      const data = new Uint8Array(await res.arrayBuffer());
      const etag = res.headers.get('ETag');
      if (etag) {
        this.getSendsEtag = true;
        return { data, etag };
      }
      this.getSendsEtag = false;
      if (opts.etag === false) return { data };
      if (bracketed) {
        // a server that reports no ETag at all: there is nothing to pair
        if (before === undefined) return { data };
        const after = await this.propfindEtag(path);
        if (typeof before === 'string' && after === before) return { data, etag: before };
        if (after === undefined) return { data };
      }
      // a write came between the two PROPFINDs (or this GET carried no ETag after all): read again
      if (attempt >= PAIRED_READ_ATTEMPTS) return { data };
    }
  }

  /**
   * The current ETag of a file in the form {@link read} reports it: from a HEAD request when the
   * server sends the ETag with GET, else from PROPFIND. Null when the file does not exist,
   * undefined when the server reports none.
   */
  async etag(path: string): Promise<string | null | undefined> {
    if (!this.getSendsEtag) return this.propfindEtag(path);
    const res = await this.request('HEAD', path);
    if (res.status === 404) return null;
    return res.ok ? (res.headers.get('ETag') ?? undefined) : undefined;
  }

  /** The getetag PROPFIND reports for a file: null when it does not exist, undefined when none. */
  private async propfindEtag(path: string): Promise<string | null | undefined> {
    let entries: DavResponse[];
    try {
      entries = await this.propfind(path, 0);
    } catch {
      return undefined;
    }
    return entries.length === 0 ? null : entries[0].etag || undefined;
  }

  async stat(path: string): Promise<DavResponse | null> {
    const r = await this.propfind(path, 0);
    return r[0] ?? null;
  }

  async write(path: string, data: Uint8Array, opts: WriteOptions = {}): Promise<{ etag?: string }> {
    const headers: Record<string, string> = {
      'Content-Type': opts.contentType ?? 'application/octet-stream',
    };
    if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
    if (opts.ifNoneMatch) headers['If-None-Match'] = opts.ifNoneMatch;
    const res = await this.request('PUT', path, { headers, body: data as unknown as BodyInit });
    if (res.status === 412) throw new PreconditionFailedError(path);
    if (res.status === 409) {
      // the folder does not exist (nginx answers 500, or creates it with create_full_put_path on)
      if (opts.createFolders === false) throw new MissingFolderError(path);
      await this.mkdirp(path.split('/').slice(0, -1).join('/'));
      return this.write(path, data, opts);
    }
    if (!res.ok) throw new WebDAVError(`PUT ${path} failed: ${res.status}`, res.status);
    // Only the PUT response's own ETag is known to belong to this content: a PROPFIND sent after it
    // can already report the ETag of another writer's write.
    return { etag: res.headers.get('ETag') ?? undefined };
  }

  async remove(path: string): Promise<void> {
    const res = await this.request('DELETE', path);
    if (!res.ok && res.status !== 404)
      throw new WebDAVError(`DELETE ${path} failed: ${res.status}`, res.status);
  }

  async mkcol(path: string): Promise<void> {
    const res = await this.request('MKCOL', path.endsWith('/') ? path : `${path}/`);
    // 405: already exists; 301: some servers redirect to the slash URL
    if (!res.ok && res.status !== 405 && res.status !== 301)
      throw new WebDAVError(`MKCOL ${path} failed: ${res.status}`, res.status);
  }

  async mkdirp(dir: string): Promise<void> {
    const parts = joinPath(dir).split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += `/${part}`;
      await this.mkcol(cur);
    }
  }

  /** Verifies connectivity and credentials. */
  async check(): Promise<{ ok: boolean; status?: number; message?: string }> {
    try {
      const res = await this.request('PROPFIND', '/', {
        headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
      });
      if (res.status === 207 || res.ok) return { ok: true, status: res.status };
      return { ok: false, status: res.status, message: res.statusText || `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
