// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { bundle } from './vite-bundle';

/*
 * The bundler of the worker tests (vite-bundle.ts) builds in the dev server's mode and leaves what
 * a module reads of `process.env`, `import.meta.env` and `import.meta.hot` as the dev server serves
 * it, so that a worker module that throws in the dev server's worker throws in the realm
 * desk-stage-worker-safety.test.ts runs the bundle in: NODE_ENV and MODE are the dev server's mode,
 * DEV and PROD are true and false, `import.meta.hot` is a hot context whose methods run, and every
 * other read of `process.env` is left for the realm, which has no `process`, where Vite's build
 * would read it from `{}` and go on.
 */

const dir = mkdtempSync(join(tmpdir(), 'vite-bundle-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * An entry that reads `process.env`, `import.meta.env` and `import.meta.hot` in each way a module
 * may, and keeps what each read gave.
 */
const READS = `
const reads = {
  nodeEnv: () => process.env.NODE_ENV,
  globalNodeEnv: () => global.process.env.NODE_ENV,
  globalThisNodeEnv: () => globalThis.process.env.NODE_ENV,
  name: () => process.env.DESK_DEBUG,
  globalThisName: () => globalThis.process.env.DESK_DEBUG,
  whole: () => process.env,
  mode: () => import.meta.env.MODE,
  dev: () => import.meta.env.DEV,
  prod: () => import.meta.env.PROD,
  env: () => {
    const env = import.meta.env;
    return [env.MODE, env.DEV, env.PROD].join();
  },
  hot: () => typeof import.meta.hot,
  hmr: () => {
    const hot = import.meta.hot;
    hot.accept();
    hot.accept(() => {});
    hot.accept('./other.js', () => {});
    hot.acceptExports(['reads']);
    hot.dispose((data) => {});
    hot.prune(() => {});
    hot.decline();
    hot.on('vite:beforeUpdate', () => {});
    hot.off('vite:beforeUpdate', () => {});
    hot.send('desk:event', {});
    hot.invalidate('desk');
    import.meta.hot.data.kept = 'kept';
    return import.meta.hot.data.kept;
  },
};
globalThis.outcomes = {};
for (const [key, read] of Object.entries(reads)) {
  try {
    globalThis.outcomes[key] = String(read());
  } catch (error) {
    globalThis.outcomes[key] = error.name;
  }
}
`;

describe('bundle (vite-bundle.ts) with every package bundled', () => {
  it('reads as the dev server serves a module: NODE_ENV and MODE its mode, DEV, a hot context whose methods run, any other read of process.env left to the realm, where a worker has no process', async () => {
    const entry = join(dir, 'reads-process-env.js');
    writeFileSync(entry, READS);
    const { code } = await bundle(entry);
    // a realm with no Node global, as a worker has none
    const realm = vm.createContext({});
    vm.runInContext(code, realm);
    expect(JSON.parse(vm.runInContext('JSON.stringify(outcomes)', realm) as string)).toEqual({
      nodeEnv: 'development',
      globalNodeEnv: 'development',
      globalThisNodeEnv: 'development',
      name: 'ReferenceError',
      globalThisName: 'TypeError',
      whole: 'ReferenceError',
      mode: 'development',
      dev: 'true',
      prod: 'false',
      env: 'development,true,false',
      hot: 'object',
      hmr: 'kept',
    });
  }, 60_000);
});
