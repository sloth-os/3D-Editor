import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import { stageBrief } from '../src/desk/brief';
import { extractUnit } from '../src/desk/units';

/*
 * Library units run in the desk's staging worker (no DOM, no Node API) and must give the same bytes
 * there as in Node: this bundles the units API (with SceneDoc and stageBrief) from the package's entry
 * as a browser bundle (a Node built-in anywhere in the graph fails the build), runs it in a realm with
 * a worker's globals only (as desk-brief-worker.test.ts does for staging) and extracts, decodes,
 * inserts, updates and adopts there. The same scene extracted in Node and in the realm gives the same
 * file, byte for byte.
 */

const CORE = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = new URL('./fixtures/desk-embed/', import.meta.url);

const IMPORTS = [
  'SceneDoc',
  'stageBrief',
  'extractUnit',
  'decodeUnit',
  'encodeUnit',
  'readUnitHeader',
  'unitMeta',
  'insertUnit',
  'updateUnit',
  'adoptUnit',
  'makeLocal',
  'listUnits',
  'unitsInUse',
  'unitStatus',
  'unitOf',
  'docHasUnitInstances',
  'slotKey',
  'deriveUnitId',
  'rigDigest',
  'sha256Hex',
  'gunzipBounded',
];

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
      contents: `export { ${IMPORTS.join(', ')} } from './src/index';`,
      resolveDir: CORE,
      loader: 'ts',
      sourcefile: 'units-imports.ts',
    },
    bundle: true,
    format: 'iife',
    globalName: 'Core',
    platform: 'browser',
    target: 'es2022',
    treeShaking: false,
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  return { code: r.outputFiles[0].text, inputs: Object.keys(r.metafile.inputs) };
}

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

describe('library units in a worker', () => {
  it('bundle for the browser and extract, decode, insert, update and adopt without a Node or DOM global', async () => {
    const { code, inputs } = await bundle();
    for (const f of [
      'desk/container/framing.ts',
      'desk/container/gzip.ts',
      'desk/container/digest.ts',
      'desk/units/format.ts',
      'desk/units/extract.ts',
      'desk/units/insert.ts',
      'desk/units/update.ts',
      'desk/units/adopt.ts',
      'desk/units/list.ts',
      '@noble/hashes/sha2.js',
    ])
      expect(
        inputs.some((i) => i.endsWith(f) || i.includes(f)),
        f,
      ).toBe(true);
    const realm = workerRealm();
    for (const name of [...NODE, ...DOM])
      expect(vm.runInContext(`typeof ${name}`, realm), name).toBe('undefined');
    vm.runInContext(code, realm, { filename: 'units-imports.js' });

    // the same scene in Node and in the realm: the same file
    const doc = SceneDoc.create({ empty: true });
    stageBrief(doc, JSON.parse(readFileSync(new URL('open.json', FIXTURES), 'utf8')).scene);
    const mira = doc.listObjects().find((o) => o.custom_props.desk_character_id === 'chr_0123456789mira')!.id;
    const kite = doc.listObjects().find((o) => o.custom_props.desk_element_id === 'ele_0123456789kite')!.id;
    const inNode = extractUnit(doc, { kind: 'figure', actor: mira }, { deskVersion: 'test' });
    realm.STATE = doc.encodeState();
    realm.MIRA = mira;
    realm.KITE = kite;
    const out = JSON.parse(
      vm.runInContext(
        `(() => {
          const doc = Core.SceneDoc.fromUpdate(STATE);
          const fig = Core.extractUnit(doc, { kind: 'figure', actor: MIRA }, { deskVersion: 'test' });
          const prop = Core.extractUnit(doc, { kind: 'prop', root: KITE }, { deskVersion: 'test' });
          const set = Core.extractUnit(doc, { kind: 'set', name: 'Meadow' }, { deskVersion: 'test' });
          const unit = Core.decodeUnit(fig.data);
          const dst = Core.SceneDoc.create({ empty: true });
          const pin = { ref: 'lib_1', version: 1, sha256: fig.sha256 };
          const ins = Core.insertUnit(dst, unit, { ...pin, key: Core.slotKey({ castId: 'chr_x' }) });
          const body = unit.body;
          const mat = Object.keys(body.blocks.materials)[0];
          const next = { ...body, blocks: { ...body.blocks, materials: { ...body.blocks.materials, [mat]: { ...body.blocks.materials[mat], roughness: 0.123 } } } };
          const { format, version, digest, bodyBytes, ...header } = unit.header;
          const v2 = Core.decodeUnit(Core.encodeUnit(next, header));
          const rep = Core.updateUnit(dst, ins.root, v2, { ref: 'lib_1', version: 2, sha256: Core.sha256Hex(v2.bytes) });
          const adopted = Core.adoptUnit(doc, set.link, { ref: 'lib_set', version: 1, sha256: set.sha256 });
          return JSON.stringify({
            fig: fig.sha256,
            same: Core.extractUnit(doc, { kind: 'figure', actor: MIRA }, { deskVersion: 'test' }).header.digest === fig.header.digest,
            propKey: prop.link.key,
            root: ins.root === Core.deriveUnitId('cast:chr_x', '@root'),
            updated: rep.updated.map((p) => p.kind),
            status: Core.unitStatus(dst, ins.root),
            listed: Core.listUnits(dst).map((u) => [u.key, u.version]),
            inUse: Core.unitsInUse(doc).map((u) => u.ref),
            adopted: adopted.root,
            has: Core.docHasUnitInstances(doc),
            meta: fig.meta.actor,
          });
        })()`,
        realm,
      ) as string,
    );
    expect(out).toEqual({
      fig: inNode.sha256,
      same: true,
      propKey: 'el:ele_0123456789kite',
      root: true,
      updated: ['materials'],
      status: { edited: [], missing: [] },
      listed: [['cast:chr_x', 2]],
      inUse: ['lib_set'],
      adopted: 'SIqO3S2CV5o0gCvB',
      has: true,
      meta: { kind: 'child', heightM: 1.28 },
    });
  });
});
