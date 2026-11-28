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

| Source                                                  | Example | Precedence         |
| ------------------------------------------------------- | ------- | ------------------ |
| `X-Forwarded-Prefix` request header (sent by the proxy) | `/3d`   | per request, first |
| `BASE_PATH`                                             | `/3d`   |                    |
| none                                                    |         | the root (default) |

A base path is `/` followed by path segments of `A-Z a-z 0-9 . _ ~ -`, without a trailing slash
(`/3d/` is read as `/3d`; `/` or an empty value is the root). No segment is `.` or `..`, and the
first segment is none of the server's own top-level paths, since a path under it could then be
read two ways: `api`, `sync`, `mcp`, `dav`, `otlp`, `metrics`, `healthz`, `readyz`, `assets`,
`icons`, `desk`, and the build's files at the top (`index.html`, `desk.html`, `sw.js`,
`manifest.webmanifest`, `favicon.svg`). The server refuses a `BASE_PATH` it cannot use when it
starts, with the reason (`Invalid configuration: BASE_PATH: …`). It ignores an
`X-Forwarded-Prefix` it cannot use (a header with several comma-separated values counts by its
first), so the header can never steer links off the site.

### Both proxy styles

A proxy either **strips** the prefix (nginx `proxy_pass http://127.0.0.1:8080/;` with its trailing
slash, Caddy `handle_path`, Traefik `StripPrefix`) or **keeps** it (nginx
`proxy_pass http://127.0.0.1:8080;`, Caddy `handle`). The server accepts both: before anything
routes a request (HTTP requests and WebSocket upgrades alike), a path that starts with the
request's base, or with `BASE_PATH`, has it removed; any other path is served as it is. So:

- a stripping proxy that sends `X-Forwarded-Prefix` needs no setting on the server (it needs the
  header, or `BASE_PATH`, to write the [links](#what-the-server-writes-with-the-base));
- a keeping proxy needs `BASE_PATH` (or the header);
- requests to the server's own port without the prefix keep working: the Docker health check
  (`/healthz`), Prometheus (`/metrics`), and the editor opened on the machine itself.

A request for the base without its slash (`/3d`, also with a query) is redirected to `/3d/` with
status 308, so the editor's pages are always inside the service worker's scope. With a stripping
proxy that request never reaches the server; the [proxy configurations](#proxy-configurations)
redirect it themselves.

Set `BASE_PATH` with either style where you can: the startup log then shows the editor's address
under the prefix, and pages opened on the server's own port load their files under it too (the
server accepts both).

## What the server writes with the base

| Output                                                                                                                      | With base `/3d`                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html` and `desk.html`: the editor at `/` and at any other page path, the desk at `/desk.html` and `/desk`            | `<base href="/3d/">` as the first element of `<head>`, written per request; `Cache-Control: no-cache` and `Vary: X-Forwarded-Prefix`; the desk page keeps its [headers](embedding.md#headers) |
| the redirect of the bare base                                                                                               | `Location: /3d/`                                                                                                                                                                              |
| links in MCP results: `editor_url`, the download links of `export_scene`, renders and video exports, model store thumbnails | `https://example.com/3d/?project=…`, `https://example.com/3d/api/…`: the scheme and host the client used (`X-Forwarded-Proto` and `X-Forwarded-Host` when a proxy sends them), then the base  |
| the WebDAV proxy's `<href>`s, `Location` and `Content-Location`                                                             | under `/3d/dav/`, so WebDAV clients (the editor's among them) can follow them; a `Destination` header is accepted with or without the base                                                    |
| the startup log                                                                                                             | `http://localhost:8080/3d/` and `http://localhost:8080/3d/mcp` with `BASE_PATH=/3d`                                                                                                           |

REST answers give the server's own routes as paths from its root, the same under every prefix:
`webdav.url` of `GET /api/config` (`/dav`), `files[].url` of a [video export](video-export.md#rest),
`thumbnail_url` of the [model store](model-store.md). A client puts its base in front of them
(`https://example.com/3d` + `/api/…`), as the web app does.

## The web app

The app is built with a relative base (Vite `base: './'`), so its pages load their scripts, styles,
workers, icons and the manifest relative to the document's base URL, which the server sets with
`<base href>`. At start the app reads its base from `document.baseURI`
(`apps/web/src/app/base-url.ts`) and derives everything from it:

| Use                                                 | URL                                                                                                                                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST, model store, video exports, browser telemetry | `<base>api/…`, `<base>otlp/…`                                                                                                                                                                      |
| live sync                                           | `ws(s)://<host><base>sync/<project>`                                                                                                                                                               |
| WebDAV through the server                           | `<base>dav/`                                                                                                                                                                                       |
| service worker                                      | `<base>sw.js` with scope `<base>`; its routes (the desk page, the editor's page for navigations, the server paths it leaves to the network) are paths relative to its scope                        |
| web app manifest                                    | `<base>manifest.webmanifest` with relative `start_url`, `scope`, icons and file handler, and no `id`: an installed editor is identified by its start URL (`https://example.com/3d/`), one per base |
| project links                                       | `?project=<id>` on the page's own path                                                                                                                                                             |

**Preferences › Collaboration › Server URL**, when set, takes the place of the base for the
server's routes; it may carry a path (`https://example.com/3d`).

The Vite dev server and `vite preview` run at the root (`npm run dev` proxies `/api`, `/sync`,
`/mcp`, `/dav` and `/otlp` to the server); a subpath is a deployment concern, covered by the
[tests](#tests) against the built app.

### Static hosts

`apps/web/dist` works under any folder of a static host, with no editor server: the pages at
`<folder>/` and `<folder>/desk.html` load everything relative to themselves. A static host writes no
`<base href>`, so it must not answer deeper paths with `index.html`: such a page would look for its
files in the wrong folder. The editor never links to deeper paths; answer them with 404 or a
redirect to `<folder>/` (the [nginx example](embedding.md#static-hosts) does). Without the editor
server, the clean URL `<folder>/desk` is the host's to map to `desk.html`.

## The desk under a subpath

The desk is at `<base>desk.html` (also `<base>desk`) with the same
[headers](embedding.md#headers) (`DESK_EMBED_ORIGINS`, `DESK_EMBED_COEP`), and the base's service
worker serves it offline. Hosts frame `https://desk.example.com/3d/desk.html`. The origin, not the
path, is what browsers keep apart: pages under other paths of the desk's origin share its storage
(IndexedDB, Cache Storage, cookies) and can script it. Give the desk a host name of its own, apart
from the pages that frame it and from anything you do not trust. `DESK_EMBED_ORIGINS` lists
origins, never paths: a host at `https://studio.example.com/rideo/` is
`https://studio.example.com`.

## Proxy configurations

Copy-ready files are in `deploy/`: [`deploy/caddy/Caddyfile`](../deploy/caddy/Caddyfile),
[`deploy/nginx/3d-editor.conf`](../deploy/nginx/3d-editor.conf) and
[`deploy/httpd/3d-editor.conf`](../deploy/httpd/3d-editor.conf). Each serves `/3d/` from an editor
server on `127.0.0.1:8080`, redirects `/3d` to `/3d/`, forwards WebSocket upgrades (the live sync),
passes the original host and scheme, buffers neither MCP streams nor downloads, leaves request size
limits to the server (10 MB for JSON; WebDAV bodies stream through) and allows long requests (MCP
calls that wait for renders, export downloads).

```caddy
# Caddy 2.9 or later ({?query}): handle_path strips /3d; the header tells the editor where it lives
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
# nginx (http context): the trailing slash of proxy_pass strips /3d
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
RewriteEngine On
RewriteRule ^/3d$ /3d/ [R=308,L,QSA]
ProxyPreserveHost On
<Location "/3d/">
    RequestHeader set X-Forwarded-Prefix "/3d"
    RequestHeader set X-Forwarded-Proto expr=%{REQUEST_SCHEME}
    LimitRequestBody 0
    ProxyPass http://127.0.0.1:8080/ upgrade=websocket flushpackets=on timeout=3600
    ProxyPassReverse http://127.0.0.1:8080/
</Location>
```

Behind a proxy that keeps the prefix, or to have the startup log show the address under it:

```bash
docker run -d -p 127.0.0.1:8080:8080 -v editor-data:/data -e BASE_PATH=/3d ghcr.io/sloth-os/3d-editor:latest
```

## Caches and headers behind a proxy

- The pages depend on `X-Forwarded-Prefix` and say so (`Vary: X-Forwarded-Prefix`): a shared cache
  in front of the server keys them on it, or sits in front of the proxy that sets it.
- The desk's `Cross-Origin-Embedder-Policy`, `Cross-Origin-Resource-Policy` and
  `Content-Security-Policy` must reach the browser unchanged, and nothing may add
  `X-Frame-Options` ([headers](embedding.md#headers)); the three configurations above pass the
  server's headers through.
- `sw.js`, the manifest and the pages are revalidated (`no-cache`), the built files under `assets/`
  are immutable: keep those headers as the server sends them.

## Tests

- `apps/server/test/unit/base-path.test.ts`: parsing of `BASE_PATH` and `X-Forwarded-Prefix`,
  the prefix removal, the page's `<base href>` and the MCP links.
- `apps/server/test/integration/subpath.test.ts`: a server with `BASE_PATH`, both proxy styles
  (prefix kept, prefix stripped with `X-Forwarded-Prefix`), the pages, the redirect, sync over
  WebSocket, the WebDAV proxy's `href`s and the MCP links.
- `apps/web/test/base-url.test.ts` and the service worker's tests: the app's URLs and the service
  worker's routes under a base.
- `e2e/tests/subpath.spec.ts`: the built editor and desk under `/3d` with the prefix kept
  (`BASE_PATH`) and under `/editor` behind a stripping proxy (`e2e/fixtures/prefix-proxy.mjs`, which
  answers like the nginx configuration): the redirect of the bare prefix, every request of the
  pages, their workers and the service worker under the prefix, the live sync, a project created and
  reloaded and its `editor_url` from MCP, the desk page and its headers, the service worker's scope
  and precache, the manifest, and an unknown API path answered by the server, not the editor.
- `apps/server/test/unit/subpath-docs.test.ts`: every directive of the [proxy
  configurations](#proxy-configurations) is in its file in `deploy/`, in the same order, and this
  page's links, files and list of the server's own paths are those of the repository.
