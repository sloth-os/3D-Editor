// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { bundle } from './vite-bundle';

/*
 * The bundler of the worker tests (vite-bundle.ts) leaves `process.env` as the dev server serves
 * it, so that a worker module that throws in the dev server's worker throws in the realm
 * desk-stage-worker-safety.test.ts runs the bundle in: NODE_ENV is the dev server's mode, and every
 * other read of `process.env` is left for the realm, which has no `process`, where Vite's build
 * would read it from `{}` and go on.
 */

const dir = mkdtempSync(join(tmpdir(), 'vite-bundle-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** An entry that reads `process.env` in each way a module may, and keeps what each read gave. */
const READS = `
const reads = {
  nodeEnv: () => process.env.NODE_ENV,
  globalThisNodeEnv: () => globalThis.process.env.NODE_ENV,
  name: () => process.env.DESK_DEBUG,
  globalThisName: () => globalThis.process.env.DESK_DEBUG,
  whole: () => process.env,
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
  it('leaves process.env as the dev server serves it: NODE_ENV as its mode, any other read left to the realm, where a worker has no process', async () => {
    const entry = join(dir, 'reads-process-env.js');
    writeFileSync(entry, READS);
    const { code } = await bundle(entry);
    // a realm with no Node global, as a worker has none
    const realm = vm.createContext({});
    vm.runInContext(code, realm);
    expect(JSON.parse(vm.runInContext('JSON.stringify(outcomes)', realm) as string)).toEqual({
      nodeEnv: 'development',
      globalThisNodeEnv: 'development',
      name: 'ReferenceError',
      globalThisName: 'TypeError',
      whole: 'ReferenceError',
    });
  }, 60_000);
});
