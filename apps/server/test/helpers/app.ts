import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp, type AppHandle, type AppOptions } from '../../src/app';
import { loadConfig } from '../../src/config';

export interface TestServer {
  handle: AppHandle;
  /** http://127.0.0.1:<port> */
  url: string;
  port: number;
  dataDir: string;
  close(): Promise<void>;
  /** Removes the temporary data directory (after close). */
  cleanup(): Promise<void>;
}

export async function makeTempDir(prefix = '3d-editor-test-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/**
 * Starts the app on an ephemeral port with a temporary DATA_DIR. Defaults: silent logs, no PWA
 * (API only), 50 ms persistence debounce. `env` overrides any variable.
 */
export async function startServer(
  env: Record<string, string> = {},
  opts: AppOptions = {},
): Promise<TestServer> {
  const dataDir = env.DATA_DIR ?? (await makeTempDir());
  const config = loadConfig({
    LOG_LEVEL: 'silent',
    PERSIST_DEBOUNCE_MS: '50',
    PUBLIC_DIR: path.join(dataDir, '__no_public__'),
    ...env,
    DATA_DIR: dataDir,
  });
  const handle = await createApp(config, { defaultMetrics: false, ...opts });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    handle,
    url: `http://127.0.0.1:${port}`,
    port,
    dataDir,
    close: () => handle.close(),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

/** fetch + JSON helper. */
export async function api<T = any>(
  base: string,
  pathname: string,
  init: RequestInit & { json?: unknown; token?: string } = {},
): Promise<{ status: number; body: T; headers: Headers }> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: body as T, headers: res.headers };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Polls `fn` until it returns a truthy value (or throws after `timeoutMs`). */
export async function eventually<T>(
  fn: () => T | Promise<T>,
  timeoutMs = 5000,
  what = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what}${lastErr ? `: ${String(lastErr)}` : ''}`);
    await sleep(25);
  }
}
