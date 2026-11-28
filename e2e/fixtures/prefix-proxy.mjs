// A reverse proxy that serves an editor server under a path of its own, as the nginx configuration
// of docs/subpath.md does (deploy/nginx/3d-editor.conf), for the end-to-end tests.
// Usage: node fixtures/prefix-proxy.mjs <port> <prefix> <upstream port>
//
//  - <prefix>/… goes to the editor server at 127.0.0.1:<upstream port> without the prefix (nginx's
//    proxy_pass with a trailing slash), with the Host header the client sent, and with
//    X-Forwarded-Prefix: <prefix>, X-Forwarded-Proto: http and X-Forwarded-Host: the client's Host
//    header, each in place of any the client sent (never appended to it)
//  - <prefix> alone, also with a query, is redirected to <prefix>/ (308), the query kept
//  - any other path is answered with 404: nothing outside the prefix reaches the editor server
//  - bodies stream both ways as they come (no buffering, no size limit), and WebSocket upgrades
//    (the live sync) are passed on with the path without the prefix
import http from 'node:http';

const [port, rawPrefix = '', upstreamPort] = process.argv.slice(2);
const prefix = rawPrefix.replace(/\/+$/, '');
if (!port || !upstreamPort || !/^(\/[A-Za-z0-9._~-]+)+$/.test(prefix)) {
  console.error('usage: node prefix-proxy.mjs <port> <prefix such as /editor> <upstream port>');
  process.exit(2);
}
const UPSTREAM = { host: '127.0.0.1', port: Number(upstreamPort) };

/** Headers that belong to one connection, never passed on (RFC 9110, section 7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // answered here already (Node sends 100 Continue itself)
  'expect',
]);

/** What a request target gets: a redirect of the bare prefix, the editor without the prefix, or 404. */
function route(url) {
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  // nginx's $is_args$args: '?' only before a query that is not empty
  const query = q < 0 || q === url.length - 1 ? '' : url.slice(q);
  if (path === prefix) return { kind: 'redirect', location: `${prefix}/${query}` };
  if (path.startsWith(`${prefix}/`)) return { kind: 'proxy', path: url.slice(prefix.length) };
  return { kind: 'missing' };
}

/** The request's headers for the editor server: the client's, then those the proxy sets. */
function upstreamHeaders(req) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers))
    if (!HOP_BY_HOP.has(name) && value !== undefined) headers[name] = value;
  // as nginx's proxy_set_header: they replace whatever the client sent, and an empty value
  // ($http_host of a request without Host) sends no header
  headers['x-forwarded-prefix'] = prefix;
  headers['x-forwarded-proto'] = 'http';
  if (req.headers.host) headers['x-forwarded-host'] = req.headers.host;
  else delete headers['x-forwarded-host'];
  return headers;
}

/** The editor server's response headers for the client, without those of the connection. */
function clientHeaders(answer) {
  const headers = {};
  for (const [name, value] of Object.entries(answer.headers))
    if (!HOP_BY_HOP.has(name) && value !== undefined) headers[name] = value;
  return headers;
}

/** A response's status line and raw headers (name, value pairs), for a socket that left HTTP. */
function rawHead(statusCode, statusMessage, pairs) {
  const lines = [
    `HTTP/1.1 ${statusCode} ${statusMessage}`,
    ...pairs.map(([name, value]) => `${name}: ${value}`),
  ];
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/** The name, value pairs of an IncomingMessage's rawHeaders. */
function pairsOf(rawHeaders) {
  const pairs = [];
  for (let i = 0; i < rawHeaders.length; i += 2) pairs.push([rawHeaders[i], rawHeaders[i + 1]]);
  return pairs;
}

const server = http.createServer((req, res) => {
  const target = route(req.url ?? '/');
  if (target.kind === 'redirect') {
    res.writeHead(308, { location: target.location, 'content-length': '0' }).end();
    return;
  }
  if (target.kind === 'missing') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`not under ${prefix}/\n`);
    return;
  }
  const upstream = http.request(
    { ...UPSTREAM, method: req.method, path: target.path, headers: upstreamHeaders(req) },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, clientHeaders(answer));
      // the headers go out at once, not with the first chunk of a stream (an MCP event stream)
      res.flushHeaders();
      answer.on('error', () => res.destroy());
      answer.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (res.headersSent) res.destroy();
    else
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(`upstream: ${err.message}\n`);
  });
  // a client that goes away ends its request upstream too (an MCP event stream, a download)
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
});

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  const target = route(req.url ?? '/');
  if (target.kind !== 'proxy') {
    const [status, extra] =
      target.kind === 'redirect'
        ? ['308 Permanent Redirect', `Location: ${target.location}\r\n`]
        : ['404 Not Found', ''];
    socket.end(`HTTP/1.1 ${status}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
    return;
  }
  const headers = { ...upstreamHeaders(req), connection: 'Upgrade', upgrade: req.headers.upgrade ?? '' };
  const upstream = http.request({ ...UPSTREAM, method: req.method, path: target.path, headers });
  socket.on('close', () => upstream.destroy());
  upstream.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
    upstreamSocket.on('error', () => socket.destroy());
    upstreamSocket.on('close', () => socket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
    // the 101 answer as the editor server gave it, its Connection and Upgrade headers included
    socket.write(rawHead(answer.statusCode, answer.statusMessage, pairsOf(answer.rawHeaders)));
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  // the editor server refused the upgrade (an unknown project, a missing token): its answer, whole
  upstream.on('response', (answer) => {
    const chunks = [];
    answer.on('data', (chunk) => chunks.push(chunk));
    answer.on('end', () => {
      const body = Buffer.concat(chunks);
      const pairs = pairsOf(answer.rawHeaders).filter(
        ([name]) => !HOP_BY_HOP.has(name.toLowerCase()) && name.toLowerCase() !== 'content-length',
      );
      pairs.push(['Content-Length', String(body.length)], ['Connection', 'close']);
      socket.end(Buffer.concat([Buffer.from(rawHead(answer.statusCode, answer.statusMessage, pairs)), body]));
    });
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
});

// long requests (MCP calls that wait for renders, downloads) are the editor server's to end
server.requestTimeout = 0;
server.listen(Number(port), '127.0.0.1', () => {
  console.log(`prefix proxy: http://127.0.0.1:${port}${prefix}/ -> http://127.0.0.1:${UPSTREAM.port}/`);
});
