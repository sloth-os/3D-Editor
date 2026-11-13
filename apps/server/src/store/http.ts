import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import { isIP } from 'node:net';
import { ToolError } from '../mcp/agent';

/*
 * Outbound requests of the model store (provider APIs, indexes, thumbnails and model files), with
 * the safety rules of `fetchLimited` and more: http(s) only; cloud metadata hosts refused on the
 * first URL and on every redirect (redirects are followed by hand, at most 5, and credentials are
 * dropped when one leads to another origin); the body size capped (Content-Length and while
 * streaming); a timeout until the response headers and again between two chunks of the body (a
 * slow but moving download is not cut off, a stalled one is); and the content type checked against
 * what the caller expects (an HTML error or login page is never taken for a model or a picture).
 *
 * The store's fetch is wrapped by guardedFetch (every request and every redirect passes it): hosts
 * on loopback, private (RFC 1918), link-local, CGNAT, unique-local and other non-public addresses
 * are refused, written as addresses or resolved by DNS, except the origins the administrator
 * configured (STORE_CATALOG_URLS: a team's catalog may live on its own network). A model catalog's
 * content is someone else's: it must not make the server fetch, and the files route hand back,
 * internal URLs. The check resolves the name before the request; the request resolves it again
 * (no pinning without an HTTP agent of our own), so a name whose DNS answer changes in between is
 * the one gap left — catalogs are further held to their own origin (providers/catalog.ts).
 */

/** User agent of every request (Poly Haven asks API clients to name themselves). */
export const STORE_USER_AGENT = '3D-Editor model store';

/** Most redirects followed. */
const MAX_REDIRECTS = 5;

/** What the body of a response must be. */
export type StoreFetchExpect = 'json' | 'image' | 'file';

export interface StoreFetchOptions {
  /** What is fetched, for messages ("the Khronos model index"). */
  what: string;
  /** Request headers. Headers other than accept and user-agent go to the first origin only. */
  headers?: Record<string, string>;
  /** Milliseconds to the response headers, and between two chunks of the body. */
  timeoutMs: number;
  /** Most bytes of the body. */
  maxBytes: number;
  expect: StoreFetchExpect;
  /** Stops the request (the caller went away). */
  signal?: AbortSignal;
  fetchImpl: typeof fetch;
}

export interface StoreFetched {
  data: Uint8Array;
  contentType: string | null;
  /** The final URL (after redirects). */
  url: string;
}

/**
 * An upstream (provider) failure: UPSTREAM, with the HTTP status when the provider answered one
 * (providers turn 401/403/404 into NEEDS_KEY, NOT_DOWNLOADABLE or NOT_FOUND where that is what it
 * means), and whether it was a timeout (search reports those per provider).
 */
export class StoreUpstreamError extends ToolError {
  readonly status: number | null;
  readonly timeout: boolean;
  /** The body was larger than allowed. */
  readonly tooLarge: boolean;

  constructor(message: string, opts: { status?: number | null; timeout?: boolean; tooLarge?: boolean } = {}) {
    super(message, 'UPSTREAM');
    this.name = 'StoreUpstreamError';
    this.status = opts.status ?? null;
    this.timeout = opts.timeout ?? false;
    this.tooLarge = opts.tooLarge ?? false;
  }
}

/** A request to a host the store may not fetch from (see guardedFetch). */
export class StoreHostRefusedError extends StoreUpstreamError {
  constructor(message: string) {
    super(message);
    this.name = 'StoreHostRefusedError';
  }
}

/** The request's caller went away (its signal aborted). */
export class StoreCancelledError extends Error {
  constructor(what: string) {
    super(`${what}: cancelled`);
    this.name = 'StoreCancelledError';
  }
}

/** Hosts never fetched (cloud metadata services), as `fetchLimited` refuses them. */
export function isForbiddenHost(hostname: string): boolean {
  let h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h === 'metadata.google.internal' || h === 'metadata' || h === 'fd00:ec2::254') return true;
  // IPv4-mapped IPv6 (::ffff:169.254.169.254, also in its hex form)
  const mapped = /^::ffff:(.+)$/.exec(h)?.[1];
  if (mapped) {
    if (isIP(mapped) === 4) h = mapped;
    else {
      const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
      if (m) {
        const hi = parseInt(m[1], 16);
        const lo = parseInt(m[2], 16);
        h = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
      }
    }
  }
  return isIP(h) === 4 && h.startsWith('169.254.');
}

/** The four bytes of an IPv4 address, or null. */
function ipv4Bytes(ip: string): number[] | null {
  if (isIP(ip) !== 4) return null;
  return ip.split('.').map(Number);
}

/** The eight 16-bit groups of an IPv6 address (an IPv4 tail expanded), or null. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (isIP(text) !== 6) return null;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const b = ipv4Bytes(tail[1]);
    if (!b) return null;
    text = `${text.slice(0, -tail[1].length)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const [head, rest] = text.includes('::') ? text.split('::') : [text, null];
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const fill = rest === null ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array.from({ length: fill }, () => '0'), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

function privateIpv4(b: number[]): boolean {
  const [a, c] = [b[0], b[1]];
  return (
    a === 0 || // this network
    a === 10 ||
    a === 127 ||
    (a === 100 && c >= 64 && c <= 127) || // CGNAT
    (a === 169 && c === 254) || // link-local (cloud metadata)
    (a === 172 && c >= 16 && c <= 31) ||
    (a === 192 && c === 168) ||
    (a === 192 && c === 0 && b[2] === 0) || // IETF protocol assignments
    (a === 198 && (c === 18 || c === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

/**
 * Whether `ip` is an address the store never fetches from: loopback, private (RFC 1918), link-local,
 * CGNAT, unique-local, site-local, unspecified, multicast or reserved; IPv4 addresses inside IPv6
 * (mapped, compatible, NAT64, 6to4) by the IPv4 address. Host names are not addresses (false).
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ipv4Bytes(ip.replace(/^\[|\]$/g, ''));
  if (v4) return privateIpv4(v4);
  const g = ipv6Groups(ip.replace(/^\[|\]$/g, ''));
  if (!g) return false;
  const embedded = (hi: number, lo: number) => privateIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && g[5] === 0xffff) return embedded(g[6], g[7]); // ::ffff:a.b.c.d
  if (zeros(0, 6)) return g[6] === 0 ? g[7] <= 1 || embedded(g[6], g[7]) : embedded(g[6], g[7]); // ::, ::1, ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return embedded(g[6], g[7]); // NAT64
  if (g[0] === 0x2002) return embedded(g[1], g[2]); // 6to4
  return (
    (g[0] & 0xfe00) === 0xfc00 || // unique-local
    (g[0] & 0xffc0) === 0xfe80 || // link-local
    (g[0] & 0xffc0) === 0xfec0 || // site-local
    (g[0] & 0xff00) === 0xff00 // multicast
  );
}

/** Resolves a host name to its addresses. */
export type HostResolver = (hostname: string) => Promise<string[]>;

/**
 * The system resolver (DNS), its answers kept for a minute; a name that does not resolve within
 * `timeoutMs` counts as unresolved (the request then fails by itself, or a proxy resolves it).
 */
export function dnsResolver(timeoutMs = 2000, ttlMs = 60_000): HostResolver {
  const answers = new Map<string, { until: number; addresses: string[] }>();
  return async (hostname) => {
    const now = Date.now();
    const held = answers.get(hostname);
    if (held && held.until > now) return held.addresses;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const addresses = await Promise.race([
        lookup(hostname, { all: true, verbatim: true }).then((r) => r.map((a) => a.address)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`resolving ${hostname} timed out`)), timeoutMs);
        }),
      ]);
      answers.delete(hostname);
      answers.set(hostname, { until: now + ttlMs, addresses });
      if (answers.size > 1000) answers.delete(answers.keys().next().value as string);
      return addresses;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Marks a fetch that answers without the network (a test's fake fetch): the hosts it is asked for
 * are not resolved (their addresses would mean nothing).
 */
export const LOCAL_FETCH: unique symbol = Symbol.for('3d-editor.store.local-fetch');

/** Whether `fetchImpl` is marked with {@link LOCAL_FETCH}. */
export function isLocalFetch(fetchImpl: typeof fetch): boolean {
  return !!(fetchImpl as typeof fetch & { [LOCAL_FETCH]?: boolean })[LOCAL_FETCH];
}

/** Which hosts the store's fetch may reach (see guardedFetch). */
export interface HostPolicy {
  /** Resolves names (null: names are not resolved, only addresses and local names are checked). */
  resolve: HostResolver | null;
  /** Origins trusted whatever their address (the configured catalogs). */
  trusted?: ReadonlySet<string>;
}

/** Throws StoreHostRefusedError (UPSTREAM) when the store may not fetch `url` under `policy`. */
export async function checkPublicHost(url: URL, policy: HostPolicy): Promise<void> {
  if (policy.trusted?.has(url.origin)) return;
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  const refuse = (why: string) =>
    new StoreHostRefusedError(
      `fetching from ${url.host} is not allowed: ${why} (the model store fetches only from public servers)`,
    );
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw refuse('it is a private or local address');
    return;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) throw refuse('it is this machine');
  if (!policy.resolve) return;
  let addresses: string[];
  try {
    addresses = await policy.resolve(host);
  } catch {
    // not resolved here: the request fails by itself (or goes through a proxy that resolves it)
    return;
  }
  const inside = addresses.find((a) => isPrivateAddress(a));
  if (inside) throw refuse(`it resolves to ${inside}, a private or local address`);
}

/** `fetchImpl` refusing hosts `policy` does not allow, on every request (each redirect too). */
export function guardedFetch(fetchImpl: typeof fetch, policy: HostPolicy): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    await checkPublicHost(url, policy);
    return fetchImpl(input, init);
  }) as typeof fetch;
}

/** `raw` as a URL the store may fetch, else a ToolError (INVALID_PARAMS for a bad URL). */
export function checkStoreUrl(raw: string | URL, what: string): URL {
  let url: URL;
  try {
    url = typeof raw === 'string' ? new URL(raw) : new URL(raw.href);
  } catch {
    throw new StoreUpstreamError(`${what}: invalid URL '${String(raw).slice(0, 200)}'`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new StoreUpstreamError(`${what}: only http and https URLs are fetched (got ${url.protocol})`);
  if (isForbiddenHost(url.hostname))
    throw new StoreUpstreamError(`${what}: fetching from ${url.hostname} is not allowed`);
  return url;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** Headers kept when a redirect leads to another origin. */
const PUBLIC_HEADERS = new Set(['accept', 'user-agent', 'accept-language']);

function mediaType(contentType: string | null): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

/** Whether `bytes` start like an image the store serves (PNG, JPEG, GIF, WebP, KTX2). */
export function sniffImage(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return 'image/webp';
  if (b.length >= 12 && b[0] === 0xab && b[1] === 0x4b && b[2] === 0x54 && b[3] === 0x58) return 'image/ktx2';
  return null;
}

/** Throws when a response of type `contentType` cannot be what `expect` asks for. */
function checkContentType(contentType: string | null, expect: StoreFetchExpect, what: string): void {
  const type = mediaType(contentType);
  // an HTML page is an error, a captive portal or a login wall, never a model, index or picture
  if (type === 'text/html' || type === 'application/xhtml+xml')
    throw new StoreUpstreamError(`${what}: the server answered with an HTML page instead of the file`);
  if (expect === 'image' && type && !type.startsWith('image/') && !/octet-stream$/.test(type))
    throw new StoreUpstreamError(`${what}: expected an image, got ${type}`);
}

/** Combines the caller's signal with the store's own abort (timeouts). */
function linked(signal: AbortSignal | undefined): AbortController {
  const c = new AbortController();
  if (signal) {
    if (signal.aborted) c.abort(signal.reason);
    else signal.addEventListener('abort', () => c.abort(signal.reason), { once: true });
  }
  return c;
}

/** Headers for a request to `url` (credentials only to `origin`, the first request's origin). */
function headersFor(url: URL, origin: string, headers: Record<string, string> | undefined): Headers {
  const out = new Headers({ 'user-agent': STORE_USER_AGENT });
  for (const [k, v] of Object.entries(headers ?? {}))
    if (url.origin === origin || PUBLIC_HEADERS.has(k.toLowerCase())) out.set(k, v);
  return out;
}

interface Opened {
  res: Response;
  url: URL;
  controller: AbortController;
  /** Restarts the idle timeout (each chunk); `stop` ends it. */
  touch(): void;
  stop(): void;
  timedOut(): boolean;
}

/** Sends the request, following redirects by hand; resolves with the final response's headers. */
async function open(rawUrl: string | URL, o: StoreFetchOptions): Promise<Opened> {
  let url = checkStoreUrl(rawUrl, o.what);
  const origin = url.origin;
  const controller = linked(o.signal);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let expired = false;
  const touch = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      expired = true;
      controller.abort(new Error('timeout'));
    }, o.timeoutMs);
  };
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const fail = (err: unknown): never => {
    stop();
    if (o.signal?.aborted) throw new StoreCancelledError(o.what);
    if (expired)
      throw new StoreUpstreamError(`${o.what}: no answer within ${Math.round(o.timeoutMs / 100) / 10} s`, {
        timeout: true,
      });
    if (err instanceof StoreHostRefusedError) throw new StoreHostRefusedError(`${o.what}: ${err.message}`);
    if (err instanceof ToolError) throw err;
    const cause =
      err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
    throw new StoreUpstreamError(`${o.what}: request failed (${cause})`);
  };
  touch();
  try {
    for (let hop = 0; ; hop++) {
      const res = await o.fetchImpl(url, {
        headers: headersFor(url, origin, o.headers),
        redirect: 'manual',
        signal: controller.signal,
      });
      const location = REDIRECTS.has(res.status) ? res.headers.get('location') : null;
      if (location === null) {
        // a fetch that followed redirects itself reports where it ended
        if (res.url) url = checkStoreUrl(res.url, o.what);
        return { res, url, controller, touch, stop, timedOut: () => expired };
      }
      await res.body?.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECTS) throw new StoreUpstreamError(`${o.what}: too many redirects`);
      url = checkStoreUrl(new URL(location, url), o.what);
    }
  } catch (err) {
    return fail(err);
  }
}

/** Reads `res`'s body into memory (size capped, idle timeout per chunk). */
async function readBody(
  op: Opened,
  o: StoreFetchOptions,
  sink?: (chunk: Uint8Array) => void | Promise<void>,
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const body = op.res.body;
  if (!body) return chunks;
  const reader = body.getReader();
  try {
    for (;;) {
      op.touch();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > o.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new StoreUpstreamError(`${o.what}: larger than ${formatBytes(o.maxBytes)}`, { tooLarge: true });
      }
      if (sink) await sink(value);
      else chunks.push(value);
    }
  } catch (err) {
    if (err instanceof ToolError) throw err;
    if (o.signal?.aborted) throw new StoreCancelledError(o.what);
    if (op.timedOut())
      throw new StoreUpstreamError(
        `${o.what}: the download stalled for ${Math.round(o.timeoutMs / 100) / 10} s`,
        {
          timeout: true,
        },
      );
    throw new StoreUpstreamError(
      `${o.what}: download failed (${err instanceof Error ? err.message : String(err)})`,
    );
  } finally {
    op.stop();
  }
  return chunks;
}

/** Checks the status, size and type of an opened response. */
async function checkResponse(op: Opened, o: StoreFetchOptions): Promise<void> {
  const res = op.res;
  if (!res.ok) {
    op.stop();
    await res.body?.cancel().catch(() => undefined);
    throw new StoreUpstreamError(`${o.what}: HTTP ${res.status}`, { status: res.status });
  }
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > o.maxBytes) {
    op.stop();
    await res.body?.cancel().catch(() => undefined);
    throw new StoreUpstreamError(
      `${o.what}: ${formatBytes(declared)} is more than ${formatBytes(o.maxBytes)}`,
      {
        tooLarge: true,
      },
    );
  }
  try {
    checkContentType(res.headers.get('content-type'), o.expect, o.what);
  } catch (err) {
    op.stop();
    await res.body?.cancel().catch(() => undefined);
    throw err;
  }
}

/** Fetches `url` into memory (see the module comment for the rules). */
export async function storeFetch(url: string | URL, o: StoreFetchOptions): Promise<StoreFetched> {
  const op = await open(url, o);
  await checkResponse(op, o);
  const chunks = await readBody(op, o);
  const data = concat(chunks);
  const contentType = op.res.headers.get('content-type');
  if (o.expect === 'image' && !sniffImage(data))
    throw new StoreUpstreamError(`${o.what}: not an image (PNG, JPEG, GIF or WebP)`);
  return { data, contentType, url: op.url.href };
}

/** Fetches JSON (UPSTREAM when the body is not JSON). */
export async function storeFetchJson<T = unknown>(
  url: string | URL,
  o: Omit<StoreFetchOptions, 'expect'>,
): Promise<T> {
  const r = await storeFetch(url, {
    ...o,
    expect: 'json',
    headers: { accept: 'application/json', ...o.headers },
  });
  try {
    return JSON.parse(new TextDecoder().decode(r.data)) as T;
  } catch {
    throw new StoreUpstreamError(`${o.what}: the answer is not JSON`);
  }
}

/** A file written by {@link storeFetchToFile}. */
export interface StoreDownloaded {
  bytes: number;
  sha256: string;
  md5: string;
  contentType: string | null;
  url: string;
  /** The first bytes of the file (for format checks). */
  head: Uint8Array;
}

/**
 * Streams `url` into the file `path` (created or truncated; the caller writes into a temporary
 * directory and renames it into place), with the size cap, the idle timeout and hashes.
 */
export async function storeFetchToFile(
  url: string | URL,
  path: string,
  o: StoreFetchOptions,
): Promise<StoreDownloaded> {
  const op = await open(url, o);
  await checkResponse(op, o);
  const out = createWriteStream(path);
  const sha = createHash('sha256');
  const md5 = createHash('md5');
  const headParts: Uint8Array[] = [];
  let headSize = 0;
  let bytes = 0;
  const write = { error: null as Error | null };
  out.on('error', (err) => (write.error ??= err));
  const writeFailed = () =>
    new StoreUpstreamError(`${o.what}: writing the cache failed (${write.error?.message ?? 'closed'})`);
  try {
    await readBody(op, o, async (chunk) => {
      if (write.error) throw writeFailed();
      sha.update(chunk);
      md5.update(chunk);
      bytes += chunk.byteLength;
      if (headSize < 64) {
        headParts.push(chunk.subarray(0, 64 - headSize));
        headSize += Math.min(chunk.byteLength, 64 - headSize);
      }
      // respect the disk's backpressure (a fast network must not pile the file up in memory)
      if (!out.write(chunk))
        await new Promise<void>((resolve) => {
          const done = () => {
            out.off('drain', done);
            out.off('error', done);
            resolve();
          };
          out.on('drain', done);
          out.on('error', done);
        });
    });
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }
  if (write.error) throw writeFailed();
  const head = concat(headParts);
  if (o.expect === 'image' && !sniffImage(head))
    throw new StoreUpstreamError(`${o.what}: not an image (PNG, JPEG, GIF or WebP)`);
  return {
    bytes,
    sha256: sha.digest('hex'),
    md5: md5.digest('hex'),
    contentType: op.res.headers.get('content-type'),
    url: op.url.href,
    head,
  };
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let size = 0;
  for (const c of chunks) size += c.byteLength;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** "12.3 MB" */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / (1024 * 102.4)) / 10} MB`;
}
