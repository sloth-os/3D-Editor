# Serving under a subpath

The editor server can live under a path of another site, behind Caddy, nginx or Apache httpd:
`https://example.com/3d/` serves the editor, `https://example.com/3d/desk.html` the embeddable
desk, and the API, the live sync, `/mcp`, `/dav`, `/otlp`, the service worker and the built files
under the same prefix, with the same build and the same Docker image as at the root.

Contents: [the base path](#the-base-path) · [what the server writes with the
base](#what-the-server-writes-with-the-base) · [the web app](#the-web-app) · [the
desk](#the-desk-under-a-subpath) · [proxy configurations](#proxy-configurations) ·
[caches and headers](#caches-and-headers-behind-a-proxy) · [tests](#tests)

## The base path

| Source                                                                      | Example | The base the server writes into pages and links | Removed from request paths                                                                                  |
| --------------------------------------------------------------------------- | ------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `X-Forwarded-Prefix` request header (set by a proxy that strips the prefix) | `/3d`   | per request, first                              | never: a request that carries the header with a value that is not blank, usable or not, has nothing removed |
| `BASE_PATH`                                                                 | `/3d`   | when a request has no usable header             | from a request without the header (or with a blank one), when its path starts with it                       |
| none                                                                        |         | the root (default)                              |                                                                                                             |

A base path is `/` followed by path segments of `A-Z a-z 0-9 . _ ~ -`, without a trailing slash
(`/3d/` is read as `/3d`; `/` or an empty value is the root), and at most 256 characters long as
given (spaces and trailing slashes count). No segment is `.` or `..`. The first segment of
`BASE_PATH` is none of the server's own top-level paths, `api`, `sync`, `mcp`, `dav`, `otlp`,
`metrics`, `healthz`, `readyz`, `assets`, `icons`, `desk`, and the build's files at the top
(`index.html`, `desk.html`, `sw.js`, `sw.js.map`, `manifest.webmanifest`, `favicon.svg`), since the
server removes `BASE_PATH` from request paths and a path under such a base could be read two ways
(with `BASE_PATH=/api`, `/api/config` would be the API's and `/config` under the base). The server
refuses a `BASE_PATH` it cannot use when it starts, with the reason
(`Invalid configuration: BASE_PATH: …`, such as `'…' is longer than 256 characters`).

The base in `X-Forwarded-Prefix` follows the same rules, but its first segment may be one of the
server's own paths: an editor at the root behind a stripping proxy at `/api/` or `/desk/` has the
base `/api` or `/desk`. The server never removes the header's value from a path (a request that
carries the header is routed as it came, [both proxy styles](#both-proxy-styles)), so no path is
read two ways: through a proxy at `/api/`, `/api/api/config` reaches the server as `/api/config`,
the API's, and `/api/` as `/`, the editor's page. The server writes no base from an
`X-Forwarded-Prefix` it cannot use (the request's base is then `BASE_PATH`), so the header can
never steer links off the site: a header with several comma-separated values counts by its first,
and one whose first value is longer than 256 characters is ignored before anything else reads it.

### Both proxy styles

A proxy either **strips** the prefix (nginx `proxy_pass http://127.0.0.1:8080/;` with its trailing
slash, Caddy `handle_path`, Traefik `StripPrefix`) or **keeps** it (nginx
`proxy_pass http://127.0.0.1:8080;`, Caddy `handle`), and the server tells them apart by
`X-Forwarded-Prefix`. Before anything routes a request (HTTP requests and WebSocket upgrades
alike), the server reads its target as the router does (an absolute-form `http://host/3d/x` by its
path, without a fragment, with percent-encoded letters, digits and `- . _ ~` decoded: `/%33d/x` is
`/3d/x`). Then:

- a request that carries `X-Forwarded-Prefix` with a value that is not empty (after trimming
  spaces and tabs; usable or not, in one header line or several) came through a proxy that
  stripped the prefix: it is routed as it came, and nothing is removed from its path;
- from a request without the header (a proxy that keeps the prefix, or none), the server removes
  `BASE_PATH` when its path starts with it.

The header's value never moves a route: the server never removes it from a path, nor a prefix
twice. A client cannot move the server's routes under a prefix of its choice (`/x/metrics` with
`X-Forwarded-Prefix: /x` is not `/metrics`), and a path a proxy stripped is not stripped again:
behind a stripping proxy at `/3d` with `BASE_PATH=/3d`, a client's `/3d/3d/metrics` reaches the
server as `/3d/metrics` with the header, which no route serves, never as `/metrics` past the
proxy's own path rules (`location /3d/metrics { deny all; }`). So:

- a stripping proxy must send `X-Forwarded-Prefix`, in place of a client's, and deliver it
  whatever the client sends, also when the client names the header in `Connection`
  ([below](#a-stripping-proxy-delivers-its-header); the [configurations](#proxy-configurations)
  do): without it, the server with `BASE_PATH` would remove the prefix a second time;
- a keeping proxy must not send the header, must drop a client's (nginx
  `proxy_set_header X-Forwarded-Prefix "";`, Caddy `header_up -X-Forwarded-Prefix`, Apache httpd
  `RequestHeader unset X-Forwarded-Prefix`, where it proxies the prefix), and needs `BASE_PATH`. A
  request that carries the header while its path starts with `BASE_PATH`, or with the header's own
  base when that is none of the server's own paths, reaches no route: it fails closed, with the
  editor's page for `GET` and `HEAD` (404 on a server without the web app) and 404 for WebSocket
  upgrades and other methods;
- on the server's own port, requests without the prefix keep working: the Docker health check
  (`/healthz`), Prometheus (`/metrics`) and the API. With `BASE_PATH=/3d`, an editor or desk page
  opened there (`http://host:8080/`, `/?project=…`, `/desk.html?embed=1#…`) is written with
  `<base href="/3d/">` and moves itself in the browser, before it starts, to the same page under
  the base (`/3d/`, `/3d/?project=…`, `/3d/desk.html?embed=1#…`), inside the service worker's
  scope ([the web app](#the-web-app)).

A request that carries `X-Forwarded-Prefix` while its path starts with `BASE_PATH` or with the
header's usable base makes the server say so in its log, at warn, at most once in 10 minutes:
`… if a proxy in front sends X-Forwarded-Prefix and keeps the prefix in request paths, it must not
send the header, and the server needs BASE_PATH=/3d …`. A header base whose first segment is one of
the server's own paths is no such sign: behind a stripping proxy at `/api/`, the editor's own
requests arrive with paths under it (`/api/api/config` as `/api/config`), so with such a header
only `BASE_PATH` counts. Clients can send the header too, so a client can make the server write
that line as well: it names the base the path starts with (the header's usable base or
`BASE_PATH`), never the header's text, and the request's URL with its token redacted, as the access
log gives it.

A request for `BASE_PATH` without its slash (`/3d`, also with a query) that carries no
`X-Forwarded-Prefix` is redirected to `/3d/` with status 308, so that the editor's pages are inside
the service worker's scope. The redirect is `BASE_PATH`'s: without `BASE_PATH` the server answers
`/3d` as any other path, and with a stripping proxy that request never reaches the server; the
[proxy configurations](#proxy-configurations) redirect it themselves.

Set `BASE_PATH` with either style where you can: the startup log then shows the editor's address
under the prefix, and pages opened on the server's own port move under it. With a stripping proxy
that sends the header this is safe: the server then removes nothing from the paths the proxy
stripped.

#### A stripping proxy delivers its header

A stripping proxy must deliver its `X-Forwarded-Prefix` whatever the client sends, also when the
client names the header in `Connection`. HTTP lets a client list there the headers that belong to
its own connection (hop by hop), and a proxy that follows it drops them before it passes the
request on; if it drops the `X-Forwarded-Prefix` it set itself, the request reaches the server as
a keeping proxy's would, and the server removes `BASE_PATH` from it: with `BASE_PATH=/3d`, a
client's `/3d/3d/metrics` with `Connection: X-Forwarded-Prefix` reaches `/metrics`, past the
proxy's rule for `/3d/metrics`. Tested with the [configurations](#proxy-configurations) below and a
rule that denies `/3d/metrics`, for `Connection` naming the header in any case, alone or in a list
(commas, `;`, a tab, several `Connection` lines, a folded line, with `close`, `keep-alive` or
`Upgrade`), with the client's own `X-Forwarded-Prefix`, and for HTTP/1.0 clients. Through Apache
httpd without the line below, each of them lost the prefix, and `/3d/3d/metrics` reached `/metrics`
(an upgrade got 404 there, as every upgrade outside the live sync does, and one to
`/3d/3d/sync/<id>` reached the live sync); through the others, none did (nginx refuses a folded
line with 400). `Proxy-Connection` naming the header made none of them drop it. HTTP/2 and HTTP/3
have no `Connection` header: RFC 9113 and RFC 9114 make a request that carries one malformed.

| Proxy (stripping the prefix) | Delivers its `X-Forwarded-Prefix` when a client names it in `Connection`                                                                                                                                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nginx 1.24.0                 | yes: `proxy_set_header Connection` replaces the client's `Connection`, and nginx drops no header it names                                                                                                                                                                                                        |
| Caddy v2.11.9, 2.6.2         | yes: Caddy drops the headers the client names first, then sets its `X-Forwarded-*` headers and those of `header_up`                                                                                                                                                                                              |
| Apache httpd 2.4.58          | only with `RequestHeader unset Connection "expr=req_novary('Connection') =~ /x-forwarded-prefix/i"`: mod_proxy_http drops the headers a client names in `Connection` after mod_headers has set `X-Forwarded-Prefix`, so the configuration first removes a `Connection` header that contains `x-forwarded-prefix` |

The Apache line removes the client's `Connection` when its value contains `x-forwarded-prefix`, in
any case and anywhere in it: so in every form mod_proxy_http would read as that name, and also
when it names a longer header that only contains the text (`X-Forwarded-Prefix-Old`,
`Old-X-Forwarded-Prefix`). The `close` or `keep-alive` of such a client goes with it, and the
other headers its `Connection` names reach the editor server, where mod_proxy_http would have
dropped them. A narrower expression, the name alone between the delimiters mod_proxy_http reads,
risks letting through a form that mod_proxy_http does read as the name; this one costs the few
clients that name such a longer header their connection handling. Removing `Connection` from
every request also works, but then Apache ignores an HTTP/1.1 client's `Connection: close` (it
keeps the connection open) and closes an HTTP/1.0 client's `keep-alive` connection after each
answer. With the line, clients whose `Connection` does not contain the text keep their
`keep-alive` and `close` as before, the live sync still upgrades with the prefix delivered, also
when the client's `Connection: Upgrade` names the header (`upgrade=websocket` follows the `Upgrade`
header), and request bodies arrive whole (64 MiB with `Content-Length` or chunked, also with
`Expect: 100-continue`).

## What the server writes with the base

| Output                                                                                                                                                                                       | With base `/3d`                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.html` and `desk.html`: the editor at `/` and at any other canonical page path (`//x`, `/./x` and `/x/../y` get 403 from the static file server), the desk at `/desk.html` and `/desk` | `<base href="/3d/">` as the first element of `<head>`, written per request; `Cache-Control: no-cache` and `Vary: X-Forwarded-Prefix`; the desk page keeps its [headers](embedding.md#headers)                                                                                                                                                                                                                            |
| the redirect of `BASE_PATH` without its slash (`BASE_PATH=/3d`, a request without `X-Forwarded-Prefix`)                                                                                      | `Location: /3d/`                                                                                                                                                                                                                                                                                                                                                                                                         |
| links in MCP results: `editor_url`, the download links of `export_scene`, renders and video exports, model store thumbnails                                                                  | `https://example.com/3d/?project=…`, `https://example.com/3d/api/…`: the scheme of the last value of `X-Forwarded-Proto` and the host of the last value of `X-Forwarded-Host` when a proxy sends usable ones, else `http` and the `Host` header, then the base; when no host is usable ([below](#caches-and-headers-behind-a-proxy)), the base alone: paths under it (`/3d/?project=…`), never from the root of the site |
| the WebDAV proxy's `<href>`s, `Location` and `Content-Location`                                                                                                                              | under `/3d/dav/`, so WebDAV clients (the editor's among them) can follow them; a `Destination` header and the resource tags of an `If` header are accepted with or without the request's base or `BASE_PATH`, spelled as a request target may be (`/%33d/dav/x` is `/3d/dav/x`)                                                                                                                                          |
| the startup log                                                                                                                                                                              | `http://localhost:8080/3d/` and `http://localhost:8080/3d/mcp` with `BASE_PATH=/3d`                                                                                                                                                                                                                                                                                                                                      |

The base is the request's `X-Forwarded-Prefix` when it has a usable one, else `BASE_PATH`. That is
all the header's value does: it sets what the server writes (this table) and a base a WebDAV
`Destination` or `If` resource tag may start with, never what a request is routed to; that a request
carries the header at all only keeps `BASE_PATH` on its path ([both proxy styles](#both-proxy-styles)).
A `Destination` or tag that starts with the request's base is read under it, also when the base is
one of the server's own paths: behind a proxy at `/dav/`, the site's `/dav/x.txt` is `/x.txt` under
the base, no WebDAV path, and the request is refused (502), while `/dav/dav/x.txt` is the WebDAV
`/x.txt`.

REST answers give the server's own routes as paths from its root, the same under every prefix:
`webdav.url` of `GET /api/config` (`/dav`), `files[].url` of a [video export](video-export.md#rest),
`thumbnail_url` of the [model store](model-store.md). A client puts its base in front of them
(`https://example.com/3d` + `/api/…`), as the web app does.

## The web app

The app is built with a relative base (Vite `base: './'`), so its pages load their scripts, styles,
workers, icons and the manifest relative to the document's base URL, which the server sets with
`<base href>`. At start the app reads its base from `document.baseURI`
(`apps/web/src/app/base-url.ts`) and derives everything from it:

| Use                                                 | URL                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST, model store, video exports, browser telemetry | `<base>api/…`, `<base>otlp/…`                                                                                                                                                                                                                                                                                 |
| live sync                                           | `ws(s)://<host><base>sync/<project>`                                                                                                                                                                                                                                                                          |
| WebDAV through the server                           | `<base>dav/`                                                                                                                                                                                                                                                                                                  |
| service worker                                      | `<base>sw.js` with scope `<base>`; from its precache it answers the editor's page (`<base>`, `<base>index.html`, with any query), the desk page and the built files, offline too, and it leaves every other page (navigation) in its scope to the network; it deletes only its own scope's outdated precaches |
| web app manifest                                    | `<base>manifest.webmanifest` with relative `start_url`, `scope`, icons and file handler, and no `id`: an installed editor is identified by its start URL (`https://example.com/3d/`), one per base                                                                                                            |
| project links                                       | `?project=<id>` on the page's own path                                                                                                                                                                                                                                                                        |

Offline, a page the service worker leaves to the network is the browser's offline page: a deeper
path of the base (`<base>x/y`, `<base>desk/`, `<base>desk.html/`), which the server answers with
the editor online, and a page outside the base, such as one of the server's own port without the
prefix. The editor never links to them.

**Preferences › Collaboration › Server URL**, when set, takes the place of the base for the
server's routes; it may carry a path (`https://example.com/3d`).

A page opened outside its base moves under it before anything of it runs. The server with
`BASE_PATH=/3d` writes `<base href="/3d/">` into its pages on its own port at `/` too, where the
editor would work online but outside its service worker's scope: `http://localhost:8080/` and
`http://localhost:8080/?project=x` move to `/3d/` and `/3d/?project=x`, `/desk.html?embed=1` to
`/3d/desk.html?embed=1` (in a host's frame too): the path from the root of the origin, under the
base, with the query and the fragment. A small inline script at the top of both pages does it
(`pageUnderBase` in `apps/web/src/app/base-url.ts`): it stops the page's loading, so that none of
the app's scripts runs (no service worker, no storage, no connection), and replaces the address. It
never moves a page at the root (`<base href="/">`), behind a proxy that serves the base (the page
is under it already) or on a static host (no `<base href>`). The pages' own
`Content-Security-Policy` (the desk's `frame-ancestors`) leaves scripts alone. A `script-src` added
in front of the server must allow that inline script, by its hash (`script-src 'self' 'sha256-…'`)
or with `'unsafe-inline'`: otherwise the browser refuses it at every load of either page, with a
console error that names the hash in Chromium, and a page opened outside its base stays where it
was opened. The hash is the same in both pages of a build and changes when the script does, which
a new version of the editor can bring: take it from that error, or compute it from the inline
script of the built `index.html`, again after each update.

One origin can hold several editor deployments of this version, each under a base of its own (`/`
and `/3d/`, `/a/` and `/b/`): each one's service worker answers only the pages of its own base
(the editor's and the desk's) and deletes only the outdated precaches of its own scope, so a
deployment at a parent path neither answers the pages of one under it nor deletes its precache.
Any other service worker whose scope covers the base can answer the base's navigations or delete
its caches: a site's own at `/`, or an editor of an earlier version at a parent path (it answers
every navigation in its scope with its own page, and deletes every precache whose name holds its
scope). Give the editor a host name of its own then.

Moving an editor from the root of a host to a path of the same host (`https://example.com/` to
`https://example.com/3d/`) leaves its service worker in the browsers that opened it at the root,
and it goes on answering there from its precache, whatever the site serves now: the editor at `/`
and `/index.html`, its built files, the desk at `/desk.html` and `/desk` unless the site answers
them with a redirect or a 4xx, and, for an editor of an earlier version, every other page of the
site outside the editor server's own paths. Until those browsers have been back, serve
at the root's `/sw.js` a service worker that retires it (the editor at its new path has its own,
`/3d/sw.js`): the next time such a browser opens a page of the site, it updates the earlier service
worker to this one, which deletes the earlier one's precache, unregisters itself and reloads the
pages it controlled, which then come from the site.

```js
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const scope = self.registration.scope;
      for (const name of await caches.keys())
        if (name.includes('-precache-') && name.endsWith(`-${scope}`)) await caches.delete(name);
      await self.registration.unregister();
      for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
    })(),
  );
});
```

The Vite dev server and `vite preview` run at the root (both proxy `/api`, `/sync`, `/mcp`, `/dav`
and `/otlp` to the server), and answer the editor's page at deeper paths with `<base href="/">`, as
the server writes it at the root: `vite preview` at every page path that names no built file (a
folder of the build such as `/icons` too, as the server does), the dev server at `/desk/` and
`/desk.html/` ([development](embedding.md#development)). Both read a request's path as the server
does and answer as it does a path with an empty or dot segment (`//desk.html`, `/desk.html//`,
`/./x`, `/x/../y`): 403 for a `GET` or `HEAD`, 404 for any other method but `OPTIONS`; any method
but `GET`, `HEAD` and `OPTIONS` gets 404 outside the proxied routes, and a path that Vite would read
another way (`/x%2f..%2fdesk`, `/%2fdesk.html`) is answered as one that names no file, so that no
path serves the desk page without its headers. An `OPTIONS` request to a path gets 204 with no body
from Vite's CORS middleware, which answers it first (the proxied routes too); the asterisk form
`OPTIONS *` reaches no middleware and gets 404. In development, a request target with a `#` gets
400 with no body, whatever its method, before any of these answers. A subpath is a deployment
concern, covered by the [tests](#tests) against the built app.

### Static hosts

`apps/web/dist` works under any folder of a static host, with no editor server: the pages at
`<folder>/` and `<folder>/desk.html` load everything relative to themselves. A static host writes no
`<base href>`, so it must not answer deeper paths with `index.html`: such a page would look for its
files in the wrong folder. The editor never links to deeper paths; answer them with 404 or a
redirect to `<folder>/` (the [nginx example](embedding.md#static-hosts) does). The service worker
leaves them to the host as well: once installed it answers `<folder>/` and `<folder>/index.html`
(the editor) and `<folder>/desk.html` from its precache, offline too, and of the other pages only
the desk's clean URL `<folder>/desk`, which without the editor server is the host's to map to
`desk.html`: there it passes the host's answer on (its 404, unless the host maps the path) and
answers with the precached desk offline, or when the host fails (no answer, or a 5xx) or takes
more than 4 s.

## The desk under a subpath

The desk is at `<base>desk.html` (also `<base>desk`) with the same
[headers](embedding.md#headers) (`DESK_EMBED_ORIGINS`, `DESK_EMBED_COEP`), and the base's service
worker serves it offline. Hosts frame `https://desk.example.com/3d/desk.html`; a frame of the
server's own port without the prefix (`http://desk-host:8080/desk.html` with `BASE_PATH=/3d`)
moves to `/3d/desk.html` before the desk starts ([the web app](#the-web-app)), but loads only while
the server answers: its address is outside the service worker's scope, so hosts frame the address
under the base for the desk to load offline too. The origin, not the path, is what browsers keep
apart: pages under other paths of the desk's origin share its storage (IndexedDB, Cache Storage,
cookies) and can script it. Give the desk a host name of its own, apart from the pages that frame
it and from anything you do not trust. `DESK_EMBED_ORIGINS` lists origins, never paths: a host at
`https://studio.example.com/rideo/` is `https://studio.example.com`.

## Proxy configurations

Copy-ready files are in `deploy/`: [`deploy/caddy/Caddyfile`](../deploy/caddy/Caddyfile),
[`deploy/nginx/3d-editor.conf`](../deploy/nginx/3d-editor.conf) and
[`deploy/httpd/3d-editor.conf`](../deploy/httpd/3d-editor.conf). Each serves `/3d/` from an editor
server on `127.0.0.1:8080`, redirects `/3d` to `/3d/`, strips `/3d` and sends
`X-Forwarded-Prefix: /3d` in place of a client's, whatever the client names in `Connection`
([a stripping proxy delivers its header](#a-stripping-proxy-delivers-its-header)), forwards
WebSocket upgrades (the live sync), passes the original host and scheme, buffers neither MCP
streams nor downloads, leaves request size limits to the server (10 MB for `/api`, 100 MB for
`/mcp`, 5 MB for `/otlp`; WebDAV bodies stream through) and allows long requests (MCP calls that
wait for renders, export downloads).

```caddy
# Caddy 2.9 or later ({?query}): handle_path strips /3d; the header tells the editor so and its base
example.com {
	redir /3d /3d/{?query} 308
	handle_path /3d/* {
		reverse_proxy 127.0.0.1:8080 {
			header_up X-Forwarded-Prefix /3d
			flush_interval -1
		}
	}
}
```

```nginx
# nginx (http context): the trailing slash of proxy_pass strips /3d; the header tells the editor so
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
server {
    # listen, server_name and TLS as for the rest of the site
    location = /3d { return 308 /3d/$is_args$args; }
    location /3d/ {
        proxy_pass http://127.0.0.1:8080/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Prefix /3d;
        proxy_buffering off;
        proxy_request_buffering off;
        client_max_body_size 0;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

```apache
# Apache httpd 2.4.47 or later (mod_proxy, mod_proxy_http, mod_headers, mod_rewrite), in the site's VirtualHost
# ProxyPass to the server's root strips /3d; the header tells the editor so
RewriteEngine On
RewriteRule ^/3d$ /3d/ [R=308,L,QSA]
ProxyPreserveHost On
<Location "/3d/">
    RequestHeader set X-Forwarded-Prefix "/3d"
    # mod_proxy_http drops the headers a client names in Connection: one containing x-forwarded-prefix goes first
    RequestHeader unset Connection "expr=req_novary('Connection') =~ /x-forwarded-prefix/i"
    RequestHeader set X-Forwarded-Proto expr=%{REQUEST_SCHEME}
    ProxyPass http://127.0.0.1:8080/ upgrade=websocket flushpackets=on timeout=3600
    ProxyPassReverse http://127.0.0.1:8080/
</Location>
```

A proxy that keeps the prefix instead (nginx `proxy_pass http://127.0.0.1:8080;` without the
trailing slash, Caddy `handle` in place of `handle_path`, httpd
`ProxyPass http://127.0.0.1:8080/3d/`) sends no `X-Forwarded-Prefix` and drops a client's in place
of setting one (nginx `proxy_set_header X-Forwarded-Prefix "";`, Caddy
`header_up -X-Forwarded-Prefix`, httpd `RequestHeader unset X-Forwarded-Prefix`). It needs
`BASE_PATH` on the server; with the configurations above, which strip the prefix, set it too, so
that the startup log shows the address under the prefix ([both proxy styles](#both-proxy-styles)):

```bash
docker run -d -p 127.0.0.1:8080:8080 -v editor-data:/data -e BASE_PATH=/3d ghcr.io/sloth-os/3d-editor:latest
```

## Caches and headers behind a proxy

- The proxy sets `X-Forwarded-Proto` and `X-Forwarded-Host` itself, in place of what clients send,
  and `X-Forwarded-Prefix` too when it strips the prefix (a proxy that keeps it drops a client's):
  the server writes the base of its pages and the scheme, host and base of its links from them, and
  cannot tell a client's value from the proxy's. It reads the first value of `X-Forwarded-Prefix`
  and the last of the other two, so a proxy that appends its own value to a client's, as httpd
  does with `X-Forwarded-Host`, is read right; a host (that of `X-Forwarded-Host` or of the `Host`
  header) goes into a link only when it is a name or address of letters, digits, `.`, `-` and `_`
  (Docker's service names, `docker_svc:8080`), or an IPv6 address in brackets, with an optional
  port; with neither usable, a link is a path under the base (`/3d/?project=…`). The three
  configurations above do this (Caddy sets `X-Forwarded-Proto` and `X-Forwarded-Host` without being
  told).
- A client that names `X-Forwarded-Proto` in `Connection` makes Apache httpd drop the one the
  configuration sets, as it would drop `X-Forwarded-Prefix` without its line
  ([a stripping proxy delivers its header](#a-stripping-proxy-delivers-its-header)); httpd adds
  `X-Forwarded-Host` after it drops such headers, and nginx and Caddy deliver all of theirs. The
  server reads `X-Forwarded-Proto` only for the links in MCP results, so that client's own links
  then start with `http://`, the scheme the server assumes without the header, where they would
  start with `https://` (measured through the Apache configuration over TLS; a `Connection` that
  names `X-Forwarded-Prefix` as well is removed whole, and both headers arrive). Nothing else
  changes, so the configuration guards `X-Forwarded-Prefix` only.
- The pages, the redirect of `BASE_PATH` without its slash (for requests without the header only)
  and the WebDAV proxy's responses (the base in their `<href>`s, `Location` and
  `Content-Location`) depend on `X-Forwarded-Prefix` and say so (`Vary: X-Forwarded-Prefix`, added
  to the WebDAV server's own `Vary`): a shared cache in front of the server keys them on it, or
  sits in front of the proxy that sets it.
- The WebDAV proxy's responses carry `Content-Security-Policy: sandbox`, in place of one the WebDAV
  server sends, and `X-Content-Type-Options: nosniff`: a page or an SVG image stored in the WebDAV
  folder and opened at its `/dav` URL runs no script with the editor's origin, which under a
  subpath is the rest of the site's too. The editor reads WebDAV with `fetch`, which these headers
  leave alone.
- The desk's `Cross-Origin-Embedder-Policy`, `Cross-Origin-Resource-Policy` and
  `Content-Security-Policy` must reach the browser unchanged, and nothing may add
  `X-Frame-Options` ([headers](embedding.md#headers)); the three configurations above pass the
  server's headers through.
- `sw.js`, the manifest and the pages are revalidated (`no-cache`), the built files under `assets/`
  are immutable: keep those headers as the server sends them.

## Tests

- `apps/server/test/unit/base-path.test.ts`: parsing of `BASE_PATH` and `X-Forwarded-Prefix`
  (with the 256-character limit), request targets read in origin form, the removal of `BASE_PATH`
  from requests without the header only (any value that is not blank, in any number of header
  lines, turns it off) and of nothing else, the base a kept prefix is reported with, the page's
  `<base href>`, the MCP links, the hosts they take (`docker_svc:8080` too) and the base alone
  without one, the build's top-level names (every entry of `apps/web/public`, and of
  `apps/web/dist` when it is built, is in the server's list), the project links agents are told to
  open, and time linear in the length of what requests send (200,000 slashes before an `x`).
  `auth.test.ts`, `cors.test.ts`, `dav-rewrite.test.ts` and `dav-if-header.test.ts` beside it: the
  scope a request is checked against comes from the route that serves it, the token is redacted
  from logged URLs in every spelling the server accepts (`?token=`, `?%74oken=`, `?to%6Ben=`), an
  `Origin` is compared with `CORS_ORIGINS` in linear time, and WebDAV paths and `Destination`s are
  decoded segment by segment (a segment with an ASCII control character, U+0000-U+001F, or DEL is
  refused, and so is one that is `.` or `..` up to a `;`, which servlet containers such as Tomcat
  cut off: `..;`; C1 controls, U+0080-U+009F, are characters of a name like any other and reach
  the WebDAV server as `%C2%80`-`%C2%9F`), checked against `WEBDAV_URL` as the URL parser reads
  them, and sent without their `token` query pairs, dropped from the query as the URL parser built
  it (a raw tab in a pair's name hides none), and with every other pair (`%74%6F%6B%65%6Es`, which
  is `tokens`, and those of an absolute `Destination`): they never leave `WEBDAV_URL` on a WebDAV
  server that decodes a path once and reads no other spelling as `.` or `..`. The resource tags of
  an `If` header are mapped as `Destination`s are, and the rest of it is kept as sent (no-tag
  lists, `Not`, state tokens of any form, digits alone among them as golang.org/x/net/webdav gives
  them out, and entity tags); a tag outside `WEBDAV_URL` is refused and named; a header is refused
  that does not parse or that a WebDAV server could read with other tags, lists or conditions (an
  entity tag that holds `<`, `>`, `(`, `)`, `[` or `]`, or a `\` before a control character; an
  empty `<>`, or a `<` in one; a state token that holds `)`; a list of two state tokens; `not` or
  `NOT`, or `Not` before one of two conditions; other spaces than Sabre/DAV reads, such as two
  between a tag and its list or one just inside a list's parentheses); and a header is read in
  time linear in its length.
- `apps/server/test/integration/subpath.test.ts`: a server with `BASE_PATH`, both proxy styles
  (prefix kept with `BASE_PATH` and no header, prefix stripped with `X-Forwarded-Prefix` and
  `BASE_PATH` set too), the pages, the redirect, sync over WebSocket, the WebDAV proxy's `href`s and
  the MCP links; an `X-Forwarded-Prefix` that never moves a route (`/x/metrics` and `POST /x/mcp`
  with `X-Forwarded-Prefix: /x`), a prefix never removed twice (`/3d/metrics`, `/3d/api/config`,
  `POST /3d/mcp`, a `/3d/sync/<id>` upgrade and `PROPFIND /3d/dav/`, each with
  `X-Forwarded-Prefix: /3d`, reach no route), a keeping proxy that passes a client's header on, and
  the warning at most once in 10 minutes; `AUTH_TOKEN` on every spelling of the API, `/mcp`, `/dav`,
  `/otlp` and sync upgrades (percent-encoded letters, absolute form, fragments), at the root and
  under `BASE_PATH`; and health checks answered promptly while clients send 15 KB
  `X-Forwarded-Prefix` or `Origin` headers of slashes. `dav-confinement.test.ts` beside it: WebDAV
  requests and `Destination`s that try to leave `WEBDAV_URL` (`..%2f`, `%2e%2e%2f`,
  `x%2f..%2f..%2f`, `%%%%`, `..;`, `%2e%2e%3b`, `.%09.`; in a `Destination` also a raw tab, the one
  ASCII control character Node lets into a header value, and a path that ends in a space before
  its fragment, which the URL parser trims) are refused and reach nothing outside it, and names
  with `%20`, `%C3%A9` and `;` still work (raw bytes 0x80-0x9F of a header arrive as the C1
  controls U+0080-U+009F, which go to the WebDAV server as `%C2%80`-`%C2%9F`, inside
  `WEBDAV_URL`). `dav-proxy.test.ts`: the proxy's `Content-Security-Policy`,
  `X-Content-Type-Options` and `Vary` on uploaded `.html` and `.svg` files and on every other
  answer, a token in the query (`?token=`, `?%74oken=`, `?to%6Ben=`) that lets GET, PUT,
  PROPFIND and COPY through but never reaches the WebDAV server, in a URL or in a `Destination`,
  and an `.xml` and an `.svg` stored with hrefs that name `WEBDAV_URL` that come back from GET and
  HEAD through `/3d/dav` as stored, byte for byte, with their `Content-Length` and `ETag` (the
  proxy maps the hrefs of the XML that WebDAV methods are answered with, never a stored file's).
  `dav-locks.test.ts`: through `/3d/dav` with `?token=` URLs, against a WebDAV server that holds
  locks by their tokens, and on purpose more strictly than Apache httpd and Sabre/DAV, which take
  a lock's token from any list (it counts only in a list that applies to the path, so that the test
  sees each tag arrive mapped): a LOCK (its answer's `lockroot` under `/3d/dav/`), then PUT,
  PROPPATCH and DELETE with tagged `If` lists that name the locked file in the editor's namespace
  succeed, the WebDAV server getting the tags as its own URLs without the token, while a write
  without the lock's token, or with it in a list tagged with another file, gets 423 (its
  `lock-token-submitted` href under `/3d/dav/`); no-tag lists, `Not`, entity tags and `Lock-Token`
  reach it as sent, and so do lock tokens that are bare numbers, as golang.org/x/net/webdav gives
  them out, in the forms Finder and Windows send (`(<1795880655>)` with PUT, PROPPATCH and a LOCK
  refresh, a tagged list, `Lock-Token` with UNLOCK); an `If` tag outside `WEBDAV_URL` gets 502
  with a message that names it, a header that does not parse or that a WebDAV server could read
  otherwise 400 (a tag outside hidden in an entity tag or in a list of two state tokens, or two
  spaces before its list, where Sabre/DAV reads on to a later tag; `not`; `Not` before two
  conditions; a tag with no space before its list), and neither reaches it.
  `sync-upgrades.test.ts`: the token, in each of its spellings, redacted from
  the access and upgrade logs. `mcp-links.test.ts`: through the MCP transport, `editor_url` is a
  path under the base (`/3d/?project=<id>`) when neither `Host` nor `X-Forwarded-Host` is a usable
  host (`a"b`, `example.com:0`), and a request without a `Host` is answered 400, over HTTP/1.1 and
  HTTP/1.0, before any tool runs.
- `apps/web/test/base-url.test.ts`: the app's URLs under a base, and a page opened outside its
  base (`pageUnderBase`, the inline script built from it, and its place in both pages: after
  `<meta charset>`, before any script or link). `pwa-sw.test.ts` and `pwa-sw-messages.test.ts`
  beside it: the service worker's routes under a base (the editor's page only at `<base>` and
  `<base>index.html`, with any query, at the root, under `/3d/` and under a dotted base, before the
  precache's route) and the outdated precaches it deletes, only its own scope's.
  `pwa-register.test.ts`: the editor registers the base's `sw.js` as an absolute URL, and offers
  an update only for a version that waits or that another page installed.
  `apps/server/test/unit/desk-embed.test.ts` and `apps/web/test/vite-config.test.ts`: what
  `npm run dev` and `npm run preview` answer: the editor's page with `<base href="/">` at `/desk/`
  and `/desk.html/` (Vite's in development, the built one in preview) and, in preview, at every
  other page path that names no built file (a folder such as `/icons`, a path that climbs out of
  the build once decoded such as `/..%2findex.html`, one with an empty or dot segment once decoded
  such as `/%2fdesk.html` and `/.%2fdesk.html`, one that does not decode); in development Vite's
  own page at the other deeper paths, also with a trailing slash (`/x/y`, `/x/y/`, `/3d/`); a
  missing file 404, never a page; a path with an empty or dot segment 403, any method but `GET`,
  `HEAD` and `OPTIONS` outside the proxied routes 404, as on the server, and at the paths Vite
  would read another way (`/x%2f..%2fdesk`, in development `/%2fdesk`, `/.%2fdesk`, `/dist/desk`
  and `/@fs/…/desk.html`) the editor's page or 404, never the desk page without its headers; and,
  from the dev and preview servers Vite starts with `apps/web/vite.config.ts`, 204 with no body
  for an `OPTIONS` to a path, the proxied routes too, 404 for the asterisk form `OPTIONS *`, and
  in development 400 for a request target with `#`, whatever its method.
  `apps/server/test/unit/static.test.ts`: the server's own answers there: a folder of the build
  without its slash (`/icons`, `/assets`, and `/3d/icons` with `BASE_PATH`) gets the editor's page
  for a `GET` or `HEAD`, as every other path that names no built file does (`/icons/` too), never
  an empty answer, and `/assets/` gets 404; the build's files, also through linked folders, come
  from the file server.
- `e2e/tests/subpath.spec.ts`: the built editor and desk under `/3d` with the prefix kept
  (`BASE_PATH`) and under `/editor` behind a stripping proxy (`e2e/fixtures/prefix-proxy.mjs`, which
  answers like the nginx configuration): the redirect of the bare prefix, every request of the
  pages, their workers and the service worker under the prefix, the live sync, a project created and
  reloaded and its `editor_url` from MCP, the desk page and its headers, the service worker's scope
  and precache, the manifest, and an unknown API path answered by the server, not the editor. A
  page opened outside its base (`/?project=abc`, `/desk.html`, `/desk`, and `/desk.html` in a
  host's frame, on the `BASE_PATH` server's own port) moves under it before any of its scripts
  runs, into its service worker's scope; root deployments, and proxies that serve the base, never
  move a page; the editor at a deeper path of its base (`/desk/`, `/x/y`) registers the base's
  service worker as its own and offers no update.
- `e2e/tests/static-host.spec.ts`: the build on a static host without an editor server
  (`e2e/fixtures/static-host.mjs`: files only, at `/` and under `/folder/` of one origin, its own
  404 for anything else). Once the service worker is installed, a deeper path is the host's 404,
  never an editor page, and the editor and the desk load offline; a root deployment's service
  worker answers no page of the deployment under `/folder/` and deletes none of its precaches.
- `apps/server/test/unit/subpath-docs.test.ts`: every directive of the [proxy
  configurations](#proxy-configurations) is in its file in `deploy/`, in the same order, and this
  page's links, files and list of the server's own paths are those of the repository.
