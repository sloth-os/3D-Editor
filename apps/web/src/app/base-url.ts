/*
 * The web app's base URL and the URLs of the editor server's routes (docs/subpath.md, "The web
 * app"). The app is built with a relative base (vite.config.ts `base: './'`): its pages load their
 * files relative to the document's base URL, which the editor server sets with `<base href>` (the
 * base path of the request: '/3d/' for the editor at https://example.com/3d/). The server's own
 * routes ('/api/…', '/sync/<project>', '/dav', '/otlp') are paths from the server's root, the same
 * under every prefix, so the app puts its base in front of them, or the Server URL preference when
 * it is set (it may carry a path too), and never resolves them against the root of the origin.
 *
 * Pure (no imports, nothing read at module load): only the default arguments read the document,
 * when they are called. Without a document (a Web Worker) a caller passes the base itself, or
 * appBaseUrl throws: a worker has no base of its own (its location is its script's, under assets/).
 * No worker of the app imports this module or server-config.ts (test/base-url.test.ts checks their
 * import graphs).
 *
 * A page opened outside its base moves under it before it starts (pageUnderBase): the build puts
 * the inline script that does it into both pages (vite.config.ts, withPageUnderBaseScript).
 */

/** The document's base URL; throws where there is no document (a Web Worker). */
function documentBaseURI(): string {
  if (typeof document === 'undefined')
    throw new Error("The app's base URL is its page's (document.baseURI): a worker has no document");
  return document.baseURI;
}

/**
 * The app's base URL, with its trailing slash: the directory of `baseURI`, which is the document's
 * base URL (the `<base href>` the editor server writes, else the page's own URL on a static host or
 * the Vite dev server). 'https://example.com/3d/' for the editor at
 * https://example.com/3d/?project=x and for the desk at https://example.com/3d/desk.html or
 * https://example.com/3d/desk alike.
 */
export function appBaseUrl(baseURI: string = documentBaseURI()): string {
  return new URL('./', baseURI).href;
}

/**
 * The app's base as a path on its own origin, with its trailing slash ('/3d/', '/' at the root): the
 * address of the editor that its pages link to.
 */
export function appBasePath(baseURI: string = documentBaseURI()): string {
  return new URL(appBaseUrl(baseURI)).pathname;
}

/**
 * The URL the editor server's routes are under, with its trailing slash: the Server URL preference
 * (Preferences › Collaboration) when it is set, with its path ('https://example.com/3d' and
 * 'https://example.com/3d/' are both 'https://example.com/3d/'; a query or a fragment is dropped,
 * and a ws: or wss: URL counts as its http: or https: one), else the app's base `appBase`. A
 * preference that is no http(s) or ws(s) URL counts as unset.
 */
export function serverBaseUrl(serverUrl: string, appBase: string = appBaseUrl()): string {
  const preference = serverUrl.trim();
  if (!preference) return appBase;
  let url: URL;
  try {
    url = new URL(preference, appBase);
  } catch {
    return appBase;
  }
  if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return appBase;
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url.href;
}

/**
 * The URL of a route of the editor server given as a path from the server's root, with its query:
 * '/api/config', '/sync/<project>', '/dav', '/otlp', and the '/api/…' paths REST answers give (a
 * video export's files[].url, the model store's thumbnail_url). It is resolved under `serverBase`
 * (serverBaseUrl), never against the root of the origin: '/api/config' under
 * 'https://example.com/3d/' is 'https://example.com/3d/api/config'. Dot segments resolve within the
 * server's root as they would on a server at the root of its origin ('/../x' is
 * 'https://example.com/3d/x'), and leading slashes count as one ('//x' is not another host).
 */
export function serverRouteUrl(path: string, serverBase: string): URL {
  const route = new URL(path.replace(/^[/\\]*/, '/'), 'http://route.invalid');
  return new URL(`.${route.pathname}${route.search}${route.hash}`, serverBase);
}

/**
 * `url` as the app's pages ask for it: a path with its query ('/3d/api/config') when it is on the
 * app's own origin (that of `appBase`), so that what a page at the root asks for stays
 * '/api/config'; else the absolute URL (a Server URL on another origin).
 */
export function pageUrl(url: URL, appBase: string = appBaseUrl()): string {
  return url.origin === new URL(appBase).origin ? `${url.pathname}${url.search}${url.hash}` : url.href;
}

/**
 * Where a page that is not under its base belongs, or null when it is (docs/subpath.md, "The web
 * app"): `page` is the page's address (location.href), `baseURI` the document's base URL. A page
 * whose path is outside the path of its base (the directory of `baseURI`) on the same origin moves
 * to the same page under the base: its path from the root of the origin, resolved against the
 * base, with its query and fragment. That is the editor server with BASE_PATH=/3d opened on its own
 * port without the prefix, where the server writes `<base href="/3d/">` into its pages: '/' and
 * '/?project=x' belong at '/3d/' and '/3d/?project=x', '/desk.html?embed=1#x' at
 * '/3d/desk.html?embed=1#x', and the base without its slash ('/3d') at the base. Under its base the
 * page is in its service worker's scope. Never anywhere else: not without a `<base href>` (a static
 * host, the Vite dev server: the base is the page's own directory), not at the root
 * (`<base href="/">`), not behind a proxy that serves the base (the page is under it already), and
 * never to another origin.
 *
 * Self-contained, without imports or anything else of this module: pageUnderBaseScript runs its
 * source in the pages.
 */
export function pageUnderBase(page: string, baseURI: string): string | null {
  const here = new URL(page);
  const base = new URL('./', baseURI);
  if (here.origin !== base.origin || here.pathname.startsWith(base.pathname)) return null;
  // './' and the path from the root: a first segment with a colon stays a path ('/a:b')
  const moved = new URL(`${here.pathname}/` === base.pathname ? './' : `.${here.pathname}`, base);
  moved.search = here.search;
  moved.hash = here.hash;
  return moved.href;
}

/**
 * The classic script that moves a page under its base (pageUnderBase) before anything of it runs:
 * it runs as the parser reaches it, after the `<base href>` the server writes first into the
 * `<head>` and before the page's module scripts, which run only once the parser is done. When the
 * page belongs elsewhere it stops the page's loading (window.stop(), which aborts the parser, so
 * that none of its module scripts ever runs: the page registers no service worker, opens no
 * storage, connects to nothing and renders nothing) and replaces it with the page under the base
 * (location.replace: no history entry for the address it left). In a frame too: only the frame's
 * page moves.
 */
export function pageUnderBaseScript(): string {
  return `(function () {
  var to = (${pageUnderBase.toString()})(location.href, document.baseURI);
  if (to) {
    window.stop();
    location.replace(to);
  }
})();`;
}

/** A page's `<meta charset>`: pageUnderBaseScript goes right after it. */
const CHARSET_META = /<meta\s+charset=[^>]*>/i;

/**
 * A page (index.html, desk.html) with pageUnderBaseScript as an inline script right after its
 * `<meta charset>`: in its `<head>`, before every script and stylesheet of the page (a stylesheet
 * before it would hold it until loaded), after the `<base href>` the server writes as the first
 * element of the `<head>`. Throws for a page without a `<meta charset>`, which every page of the
 * app has.
 */
export function withPageUnderBaseScript(html: string): string {
  const meta = CHARSET_META.exec(html);
  if (!meta)
    throw new Error('the page has no <meta charset>: the script that moves it under its base goes after it');
  const script = pageUnderBaseScript();
  // what would end the inline script early (never in a script made from pageUnderBase's source)
  if (/<\/script|<!--/i.test(script))
    throw new Error('the script that moves a page under its base cannot be inline');
  const at = meta.index + meta[0].length;
  return `${html.slice(0, at)}\n    <script>${script}</script>${html.slice(at)}`;
}
