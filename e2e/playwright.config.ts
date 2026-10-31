import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const serverMain = resolve(root, 'apps/server/dist/main.js');
const publicDir = resolve(root, 'apps/web/dist');

export const PORTS = { plain: 4180, webdavServer: 4181, webdav: 4199 };
export const WEBDAV = { url: `http://127.0.0.1:${PORTS.webdav}`, username: 'editor', password: 'secret' };

const common = { PUBLIC_DIR: publicDir, LOG_LEVEL: 'warn', HOST: '127.0.0.1' };

/**
 * Real end-to-end setup: the production builds of the web app and server, a real WebDAV
 * server, and real Chromium (WebGL via SwiftShader in headless mode).
 *  - :4180 editor server, in-memory sync rooms, no server-side WebDAV
 *  - :4181 editor server persisting to the WebDAV server and exposing the /dav proxy
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
    viewport: { width: 1400, height: 860 },
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 860 } } }],
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
      env: { ...common, PORT: String(PORTS.plain), SYNC_PERSISTENCE: 'memory', DATA_DIR: mkdtempSync(resolve(tmpdir(), 'e2e-plain-')) },
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
  ],
});
