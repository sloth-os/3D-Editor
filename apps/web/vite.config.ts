import { defineConfig, type Connect, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deskEmbedSettings, viteDeskRoute } from '../server/src/desk-embed.ts';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const serverTarget = process.env.EDITOR_SERVER_URL ?? 'http://127.0.0.1:8080';

/**
 * The embeddable desk's headers on the dev and preview servers, as the editor server sends them
 * (apps/server/src/desk-embed.ts viteDeskRoute, from DESK_EMBED_COEP and DESK_EMBED_ORIGINS), chosen
 * by path as the server chooses them by file: desk.html, also at /desk, with COEP, CORP and CSP
 * frame-ancestors; the built files under /assets/ (in dev also its modules and workers) with COEP
 * and CORP; the editor's pages, the service worker and the rest with none of them, whoever asks
 * (the service worker's precache fetches index.html like a script, not as a page).
 */
function deskEmbedHeaders(): Plugin {
  const settings = deskEmbedSettings(process.env);
  const middleware =
    (dev: boolean): Connect.NextHandleFunction =>
    (req, res, next) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = viteDeskRoute(url.pathname, dev, settings);
      for (const [k, v] of Object.entries(route.headers)) res.setHeader(k, v);
      if (route.rewrite) req.url = `${route.rewrite}${url.search}`;
      next();
    };
  return {
    name: 'desk-embed-headers',
    configureServer: (server) => void server.middlewares.use(middleware(true)),
    configurePreviewServer: (server) => void server.middlewares.use(middleware(false)),
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
      // our own service worker (src/pwa/sw.ts, built with the precache list of the build): the
      // desk page needs routes a generated one cannot express (docs/embedding.md, "Offline")
      strategies: 'injectManifest',
      srcDir: 'src/pwa',
      filename: 'sw.ts',
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
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // one classic script: the editor and the desk register it with type 'classic'
        rollupFormat: 'iife',
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
