import { defineConfig, type Connect, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBaseHref } from '../server/src/base-path.ts';
import { deskEmbedSettings, viteDeskRoute } from '../server/src/desk-embed.ts';
import { originForm } from '../server/src/request-base.ts';
import { withPageUnderBaseScript } from './src/app/base-url.ts';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const serverTarget = process.env.EDITOR_SERVER_URL ?? 'http://127.0.0.1:8080';

/**
 * Whether a decoded path has a segment that names nothing: an empty one (but the last, after a
 * trailing slash) or `.` or `..`, which a file lookup would read as another path or outside its
 * folder.
 */
function hasEmptyOrDotSegment(path: string): boolean {
  const segments = path.split('/');
  return segments.some(
    (segment, i) =>
      segment === '.' || segment === '..' || (segment === '' && i > 0 && i < segments.length - 1),
  );
}

/**
 * Whether a request path names a file in `outDir`, a file of the build, decoded as Vite's preview
 * server decodes it (`%2F` too): never a path that does not decode, one that ends with a slash
 * (`/index.html/` is a page path, as on the server), climbs or has an empty segment once decoded
 * (`/..%2findex.html`, `/%2fdesk.html`), or names a folder (`/icons`).
 */
function isBuiltFile(outDir: string, pathname: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (path.endsWith('/') || hasEmptyOrDotSegment(path)) return false;
  try {
    return statSync(join(outDir, path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether the dev server may answer a request path itself. Vite decodes a path, `%2F` too, before
 * it looks for a file, and serves every HTML file of its root as a page, whatever the method (and
 * `X` as `X.html` when that file exists): so not a path that does not decode (Vite stops with an
 * error at such an `.html` path), one with an empty or dot segment once decoded (`/x%2f..%2fdesk`
 * is the desk page), an HTML file other than the app's two pages (`/dist/desk.html`,
 * `/@fs/…/desk.html`) or a path in the build's folder `buildFolder` (`/dist/desk`), which would
 * serve a page without its headers.
 */
function isViteFile(pathname: string, buildFolder: string | null): boolean {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (hasEmptyOrDotSegment(path)) return false;
  if (path.endsWith('.html') && path !== '/index.html' && path !== '/desk.html') return false;
  return !buildFolder || (path !== buildFolder && !path.startsWith(`${buildFolder}/`));
}

/** The build's folder (`outDir`) as a path from the dev server's root (`/dist`), or null outside it. */
function buildFolderOf(root: string, outDir: string): string | null {
  const folder = relative(root, resolve(root, outDir));
  if (!folder || folder.startsWith('..') || isAbsolute(folder)) return null;
  return `/${folder.split(sep).join('/')}`;
}

/**
 * The embeddable desk's headers on the dev and preview servers, as the editor server sends them
 * (apps/server/src/desk-embed.ts viteDeskRoute, from DESK_EMBED_COEP and DESK_EMBED_ORIGINS), chosen
 * by path as the server chooses them by file: desk.html, also at /desk, with COEP, CORP and CSP
 * frame-ancestors; the built files under /assets/ (in dev also its modules and workers) with COEP
 * and CORP; the editor's pages, the service worker and the rest with none of them, whoever asks
 * (the service worker's precache fetches index.html like a script, not as a page).
 *
 * And the editor's page where the server's fallback answers it, with `<base href="/">` as the
 * server writes it at the root, so that the editor's base is the root (it reaches its server there,
 * through the proxied routes, and in preview loads its relative file URLs there) and not the path it
 * was opened at: in dev Vite's index.html at /desk/ and /desk.html/, in preview the built one there
 * and at every other page the browser opens at a path that names no built file. A file Vite may not
 * serve is 404, never a page (a script, a style or an image the page asks for).
 *
 * The request target is read as the server reads it (originForm: an absolute-form target by its
 * path, percent-encoded unreserved characters decoded), never as a URL, which would take `//x` for
 * another host's root and `/x/../y` for `/y`, and Vite gets it in that form (it would serve the
 * editor's page for an absolute-form `http://…/desk.html`). What Vite would read another way is
 * answered here, never passed on: a path with an empty or dot segment gets 403 (any other method
 * 404), as from the server, and a path that names no file Vite may serve (isBuiltFile, isViteFile)
 * is answered as one that names no built file, so that no path serves the desk page without its
 * headers, and none that does not decode stops the server.
 */
function deskEmbedHeaders(): Plugin {
  const settings = deskEmbedSettings(process.env);
  const middleware =
    (
      dev: boolean,
      servable: (pathname: string) => boolean,
      editorPage: (originalUrl: string) => Promise<string>,
    ): Connect.NextHandleFunction =>
    (req, res, next) => {
      const target = originForm(req.url ?? '/');
      const query = target.indexOf('?');
      const pathname = query === -1 ? target : target.slice(0, query);
      const read = req.method === 'GET' || req.method === 'HEAD';
      const route = viteDeskRoute(pathname, dev, settings, {
        read,
        html: /\btext\/html\b/i.test(req.headers.accept ?? ''),
        servable: read && servable(pathname),
      });
      for (const [k, v] of Object.entries(route.headers)) res.setHeader(k, v);
      const answer = (status: number, type: string, body: string) => {
        res.statusCode = status;
        res.setHeader('content-type', type);
        res.setHeader('cache-control', 'no-cache');
        res.setHeader('content-length', Buffer.byteLength(body));
        res.end(req.method === 'HEAD' ? undefined : body);
      };
      if (route.page) {
        editorPage(req.originalUrl ?? req.url ?? '/').then(
          (html) => answer(200, 'text/html; charset=utf-8', withBaseHref(html, '')),
          next,
        );
        return;
      }
      if (route.forbidden) {
        answer(403, 'text/plain; charset=utf-8', `forbidden: ${pathname}\n`);
        return;
      }
      if (route.notFound) {
        answer(404, 'text/plain; charset=utf-8', `not found: ${pathname}\n`);
        return;
      }
      // the target as it was read: Vite reads an absolute-form one another way
      req.url = route.rewrite ? `${route.rewrite}${query === -1 ? '' : target.slice(query)}` : target;
      next();
    };
  return {
    name: 'desk-embed-headers',
    configureServer: (server) => {
      const { root, build } = server.config;
      const buildFolder = buildFolderOf(root, build.outDir);
      server.middlewares.use(
        middleware(
          true,
          (pathname) => isViteFile(pathname, buildFolder),
          async (originalUrl) =>
            server.transformIndexHtml(
              '/index.html',
              await readFile(resolve(root, 'index.html'), 'utf8'),
              originalUrl,
            ),
        ),
      );
    },
    configurePreviewServer: (server) => {
      const outDir = resolve(server.config.root, server.config.build.outDir);
      server.middlewares.use(
        middleware(
          false,
          (pathname) => isBuiltFile(outDir, pathname),
          () => readFile(resolve(outDir, 'index.html'), 'utf8'),
        ),
      );
    },
  };
}

/**
 * The pages move under their base before anything of them runs (docs/subpath.md, "The web app";
 * src/app/base-url.ts pageUnderBase): index.html and desk.html carry the inline script that does
 * it right after their `<meta charset>`, in the build and on the dev server alike.
 */
function pagesUnderTheirBase(): Plugin {
  return {
    name: 'pages-under-their-base',
    transformIndexHtml: { order: 'post', handler: (html) => withPageUnderBaseScript(html) },
  };
}

/**
 * desk.html without the editor's web app manifest (vite-plugin-pwa links it from every page): the
 * desk is not the installable editor.
 */
function deskPageWithoutManifest(): Plugin {
  return {
    name: 'desk-page-without-manifest',
    enforce: 'post',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html, ctx) =>
        ctx.filename.endsWith('desk.html') ? html.replace(/\s*<link rel="manifest"[^>]*>/g, '') : html,
    },
  };
}

export default defineConfig({
  // a relative build: the pages load their files relative to the document's base URL, which the
  // editor server sets with <base href> under a subpath (docs/subpath.md); the dev and preview
  // servers serve it at the root
  base: './',
  plugins: [
    preact(),
    deskEmbedHeaders(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      // our own service worker (src/pwa/sw.ts, built with the precache list of the build): the
      // desk page needs routes a generated one cannot express (docs/embedding.md, "Offline")
      strategies: 'injectManifest',
      srcDir: 'src/pwa',
      filename: 'sw.ts',
      includeAssets: ['favicon.svg', 'icons/*.png', 'icons/*.svg'],
      // relative URLs, resolved against the manifest's own (<base>manifest.webmanifest), and no id:
      // an installed editor is identified by its start URL, one per base (docs/subpath.md)
      manifest: {
        name: '3D Editor',
        short_name: '3D Editor',
        description: 'Collaborative, offline-capable 3D modeling, animation and rendering in the browser.',
        start_url: './',
        scope: './',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        orientation: 'any',
        background_color: '#1d1d1d',
        theme_color: '#232323',
        categories: ['graphics', 'productivity', 'design'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
        file_handlers: [
          {
            action: './',
            accept: {
              'model/gltf-binary': ['.glb'],
              'model/gltf+json': ['.gltf'],
              'model/obj': ['.obj'],
              'model/stl': ['.stl'],
              'application/ply': ['.ply'],
            },
          },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // one classic script: the editor and the desk register it with type 'classic'
        rollupFormat: 'iife',
      },
      devOptions: { enabled: false },
    }),
    deskPageWithoutManifest(),
    pagesUnderTheirBase(),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat' },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': serverTarget,
      '/dav': serverTarget,
      '/otlp': serverTarget,
      '/mcp': serverTarget,
      '/sync': { target: serverTarget.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
    rolldownOptions: {
      // two pages: the editor and the embeddable director's desk (docs/embedding.md)
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        desk: fileURLToPath(new URL('./desk.html', import.meta.url)),
      },
    },
  },
});
