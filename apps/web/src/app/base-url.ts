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
