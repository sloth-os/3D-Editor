import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

/*
 * The desk's staging worker (apps/web/src/embed/stage.worker.ts, through staging-engine.ts) loads
 * what it imports of @3d-editor/core and runs brief staging, updates, shot results and checks there:
 * no DOM and no Node API. This bundles those imports from the package's entry as a browser bundle
 * (esbuild, platform browser: a Node built-in imported anywhere in the graph fails the build) and runs
 * it in a realm with only what a worker has: Node's globals (process, Buffer, require …) and the
 * page's (window, document, localStorage …) are not defined there, so a read of one, at module load
 * or later, throws as it would in the worker (a guarded `typeof process` check reads nothing). The
 * worker's own modules (stage.worker.ts, staging-engine.ts, state.ts, protocol.ts) and the libraries
 * they add are not in this graph: apps/web/test/desk-stage-worker-safety.test.ts bundles the worker's
 * entry in the same realm.
 */

const CORE = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = new URL('./fixtures/desk-embed/', import.meta.url);

/** What the staging engine imports of @3d-editor/core (and briefChanges, briefRecord: the page's). */
const WORKER_IMPORTS = [
  'SCHEMA_VERSION',
  'SceneDoc',
  'briefChanges',
  'briefRecord',
  'checkShots',
  'getShots',
  'shotResults',
  'stageBrief',
  'updateFromBrief',
];

/** Globals a worker does not have: Node's and the page's (DOM). */
const NODE = [
  'process',
  'Buffer',
  'global',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'setImmediate',
];
const DOM = ['window', 'document', 'localStorage', 'sessionStorage', 'XMLHttpRequest', 'HTMLElement'];

async function bundle(): Promise<{ code: string; inputs: string[] }> {
  const r = await build({
    stdin: {
      contents: `export { ${WORKER_IMPORTS.join(', ')} } from './src/index';`,
      resolveDir: CORE,
      loader: 'ts',
      sourcefile: 'worker-imports.ts',
    },
    bundle: true,
    format: 'iife',
    globalName: 'Core',
    platform: 'browser',
    target: 'es2022',
    // every module whole, as the worker loads them unbundled in development: a module-level read
    // must not hide behind an unused export
    treeShaking: false,
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  return { code: r.outputFiles[0].text, inputs: Object.keys(r.metafile.inputs) };
}

/** A realm with a worker's globals only (its global scope is `self`). */
function workerRealm(): vm.Context {
  const realm = vm.createContext({
    console,
    TextEncoder,
    TextDecoder,
    URL,
    crypto: globalThis.crypto,
    performance,
    structuredClone,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    atob,
    btoa,
    navigator: { userAgent: 'worker', language: 'en', hardwareConcurrency: 4 },
  });
  vm.runInContext('globalThis.self = globalThis;', realm);
  return realm;
}

describe('the staging worker’s import graph', () => {
  it('bundles for the browser and loads, stages, updates, reports and checks without a Node or DOM global', async () => {
    const { code, inputs } = await bundle();
    // the whole graph: the brief, the staging engine it drives, the camera solver, the checks, the
    // library units and their container (desk-units-worker.test.ts runs those in this realm)
    for (const f of [
      'desk/brief/stage.ts',
      'desk/rideo/import.ts',
      'operators/desk-shots.ts',
      'desk/checks.ts',
      'desk/container/gzip.ts',
      'desk/units/extract.ts',
      'desk/units/insert.ts',
      'desk/units/update.ts',
    ])
      expect(
        inputs.some((i) => i.endsWith(f)),
        f,
      ).toBe(true);
    expect(inputs.length).toBeGreaterThan(200);

    const realm = workerRealm();
    // none of Node's or the page's globals is there
    for (const name of [...NODE, ...DOM])
      expect(vm.runInContext(`typeof ${name}`, realm), name).toBe('undefined');
    // every module loads (a read of a missing global at module load throws here)
    vm.runInContext(code, realm, { filename: 'worker-imports.js' });

    realm.OPEN = readFileSync(new URL('open.json', FIXTURES), 'utf8');
    const out = JSON.parse(
      vm.runInContext(
        `(() => {
          const brief = JSON.parse(OPEN).scene;
          const doc = Core.SceneDoc.create({ empty: true });
          const staged = Core.stageBrief(doc, brief);
          const next = JSON.parse(OPEN).scene;
          next.shots[1].durationSec = 3.5;
          const changes = Core.briefChanges(doc, next);
          const updated = Core.updateFromBrief(doc, next);
          const results = Core.shotResults(doc);
          const checks = Core.checkShots(doc, {});
          return JSON.stringify({
            staged: staged.shots.map((s) => s.frames),
            retimed: changes && changes.retimed,
            updated: updated.shots.map((s) => s.frames),
            results: results.map((r) => r.shotId),
            record: Core.briefRecord(doc) !== null,
            checks: Array.isArray(checks.issues),
          });
        })()`,
        realm,
      ) as string,
    );
    expect(out).toEqual({
      staged: [72, 60],
      retimed: ['sht_0123456789bbbb'],
      updated: [72, 84],
      results: ['sht_0123456789aaaa', 'sht_0123456789bbbb'],
      record: true,
      checks: true,
    });
  });
});
