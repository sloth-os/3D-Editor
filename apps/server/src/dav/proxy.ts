import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebDAVSettings } from '../config';
import type { Log } from '../observability/log';
import { errorMessage } from '../observability/tracing';
import {
  DAV_PREFIX,
  parseUpstream,
  rewriteDestination,
  rewriteMultistatus,
  toLocalHref,
  upstreamUrlFor,
  type DavUpstream,
} from './rewrite';

/** WebDAV methods Fastify does not know by default. */
export const WEBDAV_EXTRA_METHODS = [
  'PROPFIND',
  'PROPPATCH',
  'MKCOL',
  'MOVE',
  'COPY',
  'LOCK',
  'UNLOCK',
] as const;
const PROXIED_METHODS = ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', ...WEBDAV_EXTRA_METHODS];

/** Request headers forwarded upstream (everything else, incl. cookies and credentials, is dropped). */
const FORWARD_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'content-length',
  'content-language',
  'depth',
  'overwrite',
  'if',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
  'if-range',
  'range',
  'lock-token',
  'timeout',
  'translate',
];

/** Response headers passed back to the browser. */
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'cache-control',
  'expires',
  'dav',
  'allow',
  'lock-token',
  'ms-author-via',
];

/** Largest multistatus body buffered for href rewriting. */
const MAX_REWRITE_BYTES = 32 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 60_000;

/** Registers the extra WebDAV HTTP methods (must run before routes are added). */
export function registerWebDAVMethods(app: FastifyInstance): void {
  for (const method of WEBDAV_EXTRA_METHODS) {
    if (!app.supportedMethods.includes(method)) app.addHttpMethod(method, { hasBody: true });
  }
}

function sendUpstream(
  url: URL,
  method: string,
  headers: OutgoingHttpHeaders,
  body: Readable | null,
  clientClosed: Promise<void>,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method, headers, timeout: UPSTREAM_TIMEOUT_MS }, resolve);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('upstream WebDAV server timed out')));
    void clientClosed.then(() => req.destroy());
    if (body) pipeline(body, req).catch((err) => req.destroy(err));
    else req.end();
  });
}

async function readBody(res: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('upstream response too large');
    chunks.push(chunk as Buffer);
  }
  let buf = Buffer.concat(chunks);
  const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') buf = zlib.gunzipSync(buf);
  else if (enc === 'deflate') buf = zlib.inflateSync(buf);
  else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
  return buf;
}

function upstreamHeaders(incoming: IncomingHttpHeaders, settings: WebDAVSettings): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = incoming[name];
    if (v !== undefined) out[name] = v;
  }
  out['user-agent'] = '3d-editor-server (webdav proxy)';
  if (settings.username !== undefined) {
    out.authorization = `Basic ${Buffer.from(`${settings.username}:${settings.password ?? ''}`, 'utf8').toString('base64')}`;
  }
  return out;
}

function isXml(contentType: string | undefined): boolean {
  return !!contentType && /[/+]xml\b/i.test(contentType);
}

/**
 * Same-origin WebDAV access for browsers: `/dav/*` is forwarded to WEBDAV_URL with the server's
 * credentials. Paths are confined to the upstream base URL (never an open proxy), and URLs in
 * `Destination`, `Location` and PROPFIND multistatus bodies are translated between the two
 * namespaces.
 */
export async function registerDavProxy(
  app: FastifyInstance,
  settings: WebDAVSettings,
  log: Log,
): Promise<void> {
  const upstream: DavUpstream = parseUpstream(settings.url);

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const target = upstreamUrlFor(upstream, request.url);
    if (!target) return reply.code(400).send({ error: 'invalid WebDAV path' });
    const method = request.method;
    const headers = upstreamHeaders(request.headers, settings);
    const destination = request.headers.destination;
    if (typeof destination === 'string') {
      const mapped = rewriteDestination(upstream, destination);
      // RFC 4918: a destination on another server is refused with 502.
      if (!mapped) return reply.code(502).send({ error: `Destination must be inside ${DAV_PREFIX}/` });
      headers.destination = mapped;
    }
    const body =
      request.body instanceof Readable && method !== 'GET' && method !== 'HEAD' ? request.body : null;
    // Resolves when the browser goes away before the response was sent (aborts the upstream call).
    const clientClosed = new Promise<void>((resolve) => {
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) resolve();
      });
    });

    let res: IncomingMessage;
    try {
      res = await sendUpstream(target, method, headers, body, clientClosed);
    } catch (err) {
      log.warn({ err: errorMessage(err), method, url: target.pathname }, 'WebDAV upstream request failed');
      return reply.code(502).send({ error: `WebDAV server unreachable: ${errorMessage(err)}` });
    }
    const status = res.statusCode ?? 502;
    if (status === 401 || status === 407) {
      res.resume();
      log.warn({ status }, 'WebDAV upstream rejected the server credentials');
      return reply.code(502).send({
        error: 'the WebDAV server rejected the configured credentials (WEBDAV_USERNAME / WEBDAV_PASSWORD)',
      });
    }
    reply.code(status);
    for (const name of FORWARD_RESPONSE_HEADERS) {
      const v = res.headers[name];
      if (v !== undefined) reply.header(name, v);
    }
    for (const name of ['location', 'content-location']) {
      const v = res.headers[name];
      if (typeof v !== 'string') continue;
      reply.header(name, toLocalHref(upstream, v) ?? v);
    }

    const contentType = res.headers['content-type'];
    if (method !== 'HEAD' && status === 207 && isXml(contentType)) {
      let xml: string;
      try {
        xml = (await readBody(res, MAX_REWRITE_BYTES)).toString('utf8');
      } catch (err) {
        return reply.code(502).send({ error: `invalid WebDAV response: ${errorMessage(err)}` });
      }
      reply.removeHeader('content-length');
      reply.removeHeader('content-encoding');
      return reply.send(rewriteMultistatus(xml, upstream));
    }
    if (method === 'HEAD' || status === 204 || status === 304) {
      res.resume();
      return reply.send();
    }
    return reply.send(res);
  };

  await app.register(async (scope) => {
    // Bodies are streamed to the upstream server untouched (no parsing, no size limit here).
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
    for (const url of [DAV_PREFIX, `${DAV_PREFIX}/*`]) {
      scope.route({ method: PROXIED_METHODS, url, handler });
    }
  });
}
