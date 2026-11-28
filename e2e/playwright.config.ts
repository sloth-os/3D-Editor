import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const serverMain = resolve(root, 'apps/server/dist/main.js');
const publicDir = resolve(root, 'apps/web/dist');

export const PORTS = {
  plain: 4180,
  webdavServer: 4181,
  subpath: 4182,
  prefixProxy: 4183,
  staticHost: 4184,
  ownPathProxy: 4185,
  webdav: 4199,
};
export const WEBDAV = { url: `http://127.0.0.1:${PORTS.webdav}`, username: 'editor', password: 'secret' };
/**
 * The prefixes of tests/subpath.spec.ts (docs/subpath.md): the server's own BASE_PATH on
 * PORTS.subpath, the path under which the prefix proxy serves the plain server, and the path, one
 * of the server's own, under which the second prefix proxy (PORTS.ownPathProxy) serves it.
 */
export const PREFIXES = { subpath: '/3d', prefixProxy: '/editor', ownPathProxy: '/api' };
/** The folder of the static host (PORTS.staticHost) that serves the build besides its root. */
export const STATIC_FOLDER = '/folder/';

const common = { PUBLIC_DIR: publicDir, LOG_LEVEL: 'warn', HOST: '127.0.0.1' };

/** Software WebGL in headless Chromium. */
const GL_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];
const VIEWPORT = { width: 1400, height: 860 };

/**
 * The features Playwright 1.63 turns off in Chromium by default (its chromiumSwitches.ts), one of
 * them third-party storage partitioning, which every browser applies in use: a framed page's
 * storage, service worker and caches are kept per top-level site. The desk's specs need it as in
 * production, so their project drops this default switch and passes the same list without
 * ThirdPartyStoragePartitioning (desk-partition.spec.ts fails if partitioning is off, e.g. once a
 * Playwright upgrade changes this list).
 */
const PLAYWRIGHT_DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'BlockOriginHeaderModificationOnRedirect',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
  'msForceBrowserSignIn',
  'msEdgeUpdateLaunchServicesPreferredVersion',
];
const disableFeatures = (features: string[]) => `--disable-features=${features.join(',')}`;
/** The desk's specs (desk-*.spec.ts): their own project, with storage partitioning on. */
const DESK_SPECS = /[\\/]desk-[^\\/]*\.spec\.ts$/;

/**
 * Real end-to-end setup: the production builds of the web app and server, a real WebDAV
 * server, and real Chromium (WebGL via SwiftShader in headless mode).
 *  - :4180 editor server, in-memory sync rooms, no server-side WebDAV
 *  - :4181 editor server persisting to the WebDAV server and exposing the /dav proxy
 *  - :4182 editor server with BASE_PATH=/3d, in-memory sync rooms: the editor at /3d/ (a proxy
 *    that keeps the prefix passes requests on like this)
 *  - :4183 a proxy that serves :4180 under /editor/, stripping the prefix and sending
 *    X-Forwarded-Prefix, as the nginx configuration of docs/subpath.md does
 *    (fixtures/prefix-proxy.mjs)
 *  - :4185 the same proxy serving :4180 under /api/, one of the editor server's own paths, which
 *    X-Forwarded-Prefix may name (BASE_PATH may not)
 *  - :4184 a static host without an editor server, serving the web app's build at / and under
 *    /folder/, files only (fixtures/static-host.mjs, as the nginx example of docs/embedding.md)
 *  - :4199 WebDAV server (basic auth editor/secret, CORS enabled)
 */
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: VIEWPORT,
    launchOptions: { args: GL_ARGS },
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: DESK_SPECS,
      use: { ...devices['Desktop Chrome'], viewport: VIEWPORT },
    },
    {
      name: 'desk',
      testMatch: DESK_SPECS,
      use: {
        ...devices['Desktop Chrome'],
        viewport: VIEWPORT,
        launchOptions: {
          ignoreDefaultArgs: [disableFeatures(PLAYWRIGHT_DISABLED_FEATURES)],
          args: [
            ...GL_ARGS,
            disableFeatures(
              PLAYWRIGHT_DISABLED_FEATURES.filter((f) => f !== 'ThirdPartyStoragePartitioning'),
            ),
          ],
        },
      },
    },
  ],
  webServer: [
    {
      command: `node fixtures/webdav-server.mjs ${PORTS.webdav}`,
      url: `http://127.0.0.1:${PORTS.webdav}/`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 30_000,
      // basic-auth protected root answers 401, which still proves the server is up
      stdout: 'pipe',
    },
    {
      command: `node ${serverMain}`,
      url: `http://127.0.0.1:${PORTS.plain}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...common,
        PORT: String(PORTS.plain),
        SYNC_PERSISTENCE: 'memory',
        DATA_DIR: mkdtempSync(resolve(tmpdir(), 'e2e-plain-')),
      },
    },
    {
      command: `node ${serverMain}`,
      url: `http://127.0.0.1:${PORTS.webdavServer}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...common,
        PORT: String(PORTS.webdavServer),
        WEBDAV_URL: WEBDAV.url,
        WEBDAV_USERNAME: WEBDAV.username,
        WEBDAV_PASSWORD: WEBDAV.password,
        WEBDAV_BASE_PATH: '/3d-editor',
        PERSIST_DEBOUNCE_MS: '300',
        DATA_DIR: mkdtempSync(resolve(tmpdir(), 'e2e-dav-')),
      },
    },
    {
      command: `node ${serverMain}`,
      // through the prefix: the server answers there (and at its root)
      url: `http://127.0.0.1:${PORTS.subpath}${PREFIXES.subpath}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...common,
        PORT: String(PORTS.subpath),
        BASE_PATH: PREFIXES.subpath,
        SYNC_PERSISTENCE: 'memory',
        DATA_DIR: mkdtempSync(resolve(tmpdir(), 'e2e-subpath-')),
      },
    },
    {
      // after the plain server it serves; ready once the plain server answers through it
      command: `node fixtures/prefix-proxy.mjs ${PORTS.prefixProxy} ${PREFIXES.prefixProxy} ${PORTS.plain}`,
      url: `http://127.0.0.1:${PORTS.prefixProxy}${PREFIXES.prefixProxy}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // the editor under one of its own paths: /api/api/config is its API, /api/ its page
      command: `node fixtures/prefix-proxy.mjs ${PORTS.ownPathProxy} ${PREFIXES.ownPathProxy} ${PORTS.plain}`,
      url: `http://127.0.0.1:${PORTS.ownPathProxy}${PREFIXES.ownPathProxy}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `node fixtures/static-host.mjs ${PORTS.staticHost} ${publicDir} ${STATIC_FOLDER}`,
      url: `http://127.0.0.1:${PORTS.staticHost}${STATIC_FOLDER}`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
