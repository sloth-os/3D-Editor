import { defineConfig, type Connect, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deskEmbedSettings, deskHeadersFor, isDeskPagePath } from '../server/src/desk-embed';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const serverTarget = process.env.EDITOR_SERVER_URL ?? 'http://127.0.0.1:8080';
/** Paths the dev server passes to the editor server. */
const PROXIED = ['/api', '/dav', '/otlp', '/mcp', '/sync'];
const NAVIGATIONS = new Set(['document', 'iframe', 'frame', 'embed', 'object']);

/**
 * The embeddable desk's headers on the dev and preview servers, as the editor server sends them
 * (apps/server/src/desk-embed.ts, from DESK_EMBED_COEP and DESK_EMBED_ORIGINS): desk.html, also at
 * /desk, with COEP, CORP and CSP frame-ancestors; the scripts and other subresources (the dev
 * server's modules and workers, the preview's assets) with COEP and CORP; the editor's own pages
 * with none of them.
 */
function deskEmbedHeaders(): Plugin {
  const settings = deskEmbedSettings(process.env);
  const page = deskHeadersFor('desk.html', settings);
  const asset = deskHeadersFor('assets/', settings);
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (isDeskPagePath(url.pathname)) {
      for (const [k, v] of Object.entries(page)) res.setHeader(k, v);
      if (url.pathname !== '/desk.html') req.url = `/desk.html${url.search}`;
    } else if (
      !NAVIGATIONS.has(String(req.headers['sec-fetch-dest'] ?? '')) &&
      !PROXIED.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))
    ) {
      for (const [k, v] of Object.entries(asset)) res.setHeader(k, v);
    }
    next();
  };
  return {
    name: 'desk-embed-headers',
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
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
  plugins: [
    preact(),
    deskEmbedHeaders(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icons/*.png', 'icons/*.svg'],
      manifest: {
        id: '/',
        name: '3D Editor',
        short_name: '3D Editor',
        description: 'Collaborative, offline-capable 3D modeling, animation and rendering in the browser.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        orientation: 'any',
        background_color: '#1d1d1d',
        theme_color: '#232323',
        categories: ['graphics', 'productivity', 'design'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
        file_handlers: [
          {
            action: '/',
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
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: '/index.html',
        // the desk (desk.html, also at /desk, with any query) comes from the precache; were it
        // missing there, from the network, never as the editor's index.html
        ignoreURLParametersMatching: [/.*/],
        navigateFallbackDenylist: [
          /^\/desk(\.html)?\/?(\?|$)/,
          /^\/api\//,
          /^\/sync\//,
          /^\/mcp/,
          /^\/dav\//,
          /^\/otlp\//,
          /^\/metrics/,
          /^\/healthz/,
          /^\/readyz/,
        ],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
      },
      devOptions: { enabled: false },
    }),
    deskPageWithoutManifest(),
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
