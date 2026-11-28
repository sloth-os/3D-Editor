import { defineConfig, type Connect, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBaseHref } from '../server/src/base-path.ts';
import { deskEmbedSettings, viteDeskRoute } from '../server/src/desk-embed.ts';
import { withPageUnderBaseScript } from './src/app/base-url.ts';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const serverTarget = process.env.EDITOR_SERVER_URL ?? 'http://127.0.0.1:8080';

/**
 * Whether a request path names a file in `outDir`, a file of the build: never a path that ends with a
 * slash (`/index.html/` is a page path, as on the server) or that climbs (`..`).
 */
function isBuiltFile(outDir: string, pathname: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (path.endsWith('/') || path.split('/').some((segment) => segment === '.' || segment === '..'))
    return false;
  try {
    return statSync(join(outDir, path)).isFile();
  } catch {
    return false;
  }
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
 * and at every other page the browser opens at a path that names no built file. In preview a file
 * the build does not have is 404, never a page (a script, a style or an image the page asks for).
 */
function deskEmbedHeaders(): Plugin {
  const settings = deskEmbedSettings(process.env);
  const middleware =
    (
      dev: boolean,
      outDir: string,
      editorPage: (originalUrl: string) => Promise<string>,
    ): Connect.NextHandleFunction =>
    (req, res, next) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const read = req.method === 'GET' || req.method === 'HEAD';
      const route = viteDeskRoute(url.pathname, dev, settings, {
        read,
        html: /\btext\/html\b/i.test(req.headers.accept ?? ''),
        builtFile: !dev && read && isBuiltFile(outDir, url.pathname),
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
      if (route.notFound) {
        answer(404, 'text/plain; charset=utf-8', `not found: ${url.pathname}\n`);
        return;
      }
      if (route.rewrite) req.url = `${route.rewrite}${url.search}`;
      next();
    };
  return {
    name: 'desk-embed-headers',
    configureServer: (server) =>
      void server.middlewares.use(
        middleware(true, '', async (originalUrl) =>
          server.transformIndexHtml(
            '/index.html',
            await readFile(resolve(server.config.root, 'index.html'), 'utf8'),
            originalUrl,
          ),
        ),
      ),
    configurePreviewServer: (server) => {
      const outDir = resolve(server.config.root, server.config.build.outDir);
      server.middlewares.use(
        middleware(false, outDir, () => readFile(resolve(outDir, 'index.html'), 'utf8')),
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
