// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { SceneDoc, decodePNG, getShots, listUnits, readUnitHeader } from '@3d-editor/core';
import { KITE, library, stagedDoc, withPins } from './desk-units-helpers';

/*
 * The desk's staging worker as the browser loads it (src/embed/stage.worker.ts): its own modules
 * (staging-engine.ts, state.ts with fflate, protocol.ts with zod), yjs, and what they import of
 * @3d-editor/core. The core's test (packages/core/test/desk-brief-worker.test.ts) bundles only the
 * core's exports; this one bundles the worker's entry as a browser bundle (esbuild, platform
 * browser: a Node built-in imported anywhere in the graph fails the build) and runs it in the same
 * realm, one with only what a worker has: Node's globals (process, Buffer, require …) and the page's
 * (window, document, localStorage …) are not defined there, so a read of one, at module load or
 * while the worker stages, throws as it would in the worker. Then it drives the worker as the page
 * does (staging.ts): a stage, an update, the shot results and a check, each a message carrying the
 * session's snapshot, each answered with postMessage; and the library units' work there: a staging
 * that places a unit from its file, a unit made of the scene with its thumbnail rendered in the
 * worker (the software renderer and the PNG encoder), and Make local.
 */

const WORKER = fileURLToPath(new URL('../src/embed/stage.worker.ts', import.meta.url));
const OPEN = new URL('../../../packages/core/test/fixtures/desk-embed/open.json', import.meta.url);

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

let built: Promise<{ code: string; inputs: string[] }> | null = null;
/** The worker's bundle (built once per file). */
function bundle(): Promise<{ code: string; inputs: string[] }> {
  built ??= buildBundle();
  return built;
}

async function buildBundle(): Promise<{ code: string; inputs: string[] }> {
  const r = await build({
    entryPoints: [WORKER],
    bundle: true,
    format: 'iife',
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

/**
 * A realm with a worker's globals only (its global scope is `self`), as the core's test makes it,
 * and the worker's postMessage, which keeps what the worker answers.
 */
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
  vm.runInContext(
    `globalThis.self = globalThis;
     globalThis.answers = [];
     globalThis.postMessage = (message, transfer) => answers.push({ message, transfer });`,
    realm,
  );
  return realm;
}

interface Answer {
  id: number;
  reply: {
    ok: boolean;
    kind?: string;
    error?: string;
    diff?: Uint8Array;
    summary?: { shots: number; warnings: string[] };
    results?: { shotId: string }[];
    check?: { issues: unknown[]; summary: string };
  };
  /** How many buffers the answer transferred. */
  transferred: number;
}

describe('the staging worker as the browser loads it', () => {
  it('bundles for the browser with its own modules, loads, stages, updates, reports and checks without a Node or DOM global', async () => {
    const { code, inputs } = await bundle();
    // the worker's own modules, the libraries they use and the core's staging graph
    for (const f of [
      'apps/web/src/embed/stage.worker.ts',
      'apps/web/src/embed/staging-engine.ts',
      'apps/web/src/embed/state.ts',
      'apps/web/src/embed/protocol.ts',
      'node_modules/fflate/',
      'node_modules/yjs/',
      'node_modules/zod/',
      'packages/core/src/desk/brief/stage.ts',
      'packages/core/src/desk/checks.ts',
    ])
      expect(
        inputs.some((i) => i.includes(f)),
        f,
      ).toBe(true);

    const realm = workerRealm();
    // none of Node's or the page's globals is there
    for (const name of [...NODE, ...DOM])
      expect(vm.runInContext(`typeof ${name}`, realm), name).toBe('undefined');
    // every module loads (a read of a missing global at module load throws here), and the worker
    // listens for the page's messages
    vm.runInContext(code, realm, { filename: 'stage.worker.js' });
    expect(vm.runInContext('typeof self.onmessage', realm)).toBe('function');

    /** Sends one request as the page does (the snapshot's bytes made in the worker's realm). */
    const send = (id: number, request: Record<string, unknown>, snapshot: Uint8Array): Answer => {
      realm.REQUEST = JSON.stringify({ id, request, update: [...snapshot] });
      const out = vm.runInContext(
        `(() => {
          const { id, request, update } = JSON.parse(REQUEST);
          self.onmessage({ data: { id, request: { ...request, update: new Uint8Array(update) } } });
          const { message, transfer } = answers.pop();
          const { diff, ...reply } = message.reply;
          return JSON.stringify({
            id: message.id,
            reply: diff ? { ...reply, diff: [...diff] } : reply,
            transferred: transfer.length,
          });
        })()`,
        realm,
      ) as string;
      const answer = JSON.parse(out) as Answer & { reply: { diff?: number[] } };
      expect(answer.id).toBe(id);
      expect(answer.reply.ok, answer.reply.error).toBe(true);
      return {
        ...answer,
        reply: { ...answer.reply, diff: answer.reply.diff && Uint8Array.from(answer.reply.diff) },
      };
    };

    // the session's document, as the page keeps it: each change the worker answers applied to it
    const session = new Y.Doc();
    const snapshot = () => Y.encodeStateAsUpdate(session);
    const frames = () =>
      getShots(SceneDoc.fromUpdate(snapshot())).map((s) => s.frame_end - s.frame_start + 1);
    const brief = JSON.parse(readFileSync(OPEN, 'utf8')).scene;

    const staged = send(1, { kind: 'stage', brief, lineage: 'test-lineage', generator: 'test' }, snapshot());
    expect(staged.reply).toMatchObject({ kind: 'stage', summary: { shots: 2 } });
    expect(staged.transferred).toBe(1);
    Y.applyUpdate(session, staged.reply.diff!);
    expect(frames()).toEqual([72, 60]);

    const next = structuredClone(brief);
    next.shots[1].durationSec = 3.5;
    const updated = send(2, { kind: 'update', brief: next }, snapshot());
    expect(updated.reply).toMatchObject({ kind: 'update', summary: { shots: 2 } });
    Y.applyUpdate(session, updated.reply.diff!);
    expect(frames()).toEqual([72, 84]);

    const results = send(3, { kind: 'results' }, snapshot());
    expect(results.reply.results!.map((r) => r.shotId)).toEqual(['sht_0123456789aaaa', 'sht_0123456789bbbb']);
    expect(results.transferred).toBe(0);

    const check = send(4, { kind: 'check' }, snapshot());
    expect(Array.isArray(check.reply.check!.issues)).toBe(true);
    expect(check.reply.check!.summary).toMatch(/^2 shots checked/);
  }, 120_000);

  it("places a library unit from its file, makes a unit of the scene with its thumbnail and makes it local, in the worker's realm", async () => {
    const { code, inputs } = await bundle();
    for (const f of [
      'packages/core/src/desk/units/format.ts',
      'packages/core/src/desk/units/extract.ts',
      'packages/core/src/desk/brief/library.ts',
      'packages/core/src/render/png.ts',
    ])
      expect(
        inputs.some((i) => i.includes(f)),
        f,
      ).toBe(true);
    const realm = workerRealm();
    vm.runInContext(code, realm, { filename: 'stage.worker.js' });

    /**
     * Sends one request as the page does, its bytes (the snapshot, the units' files) made in the
     * worker's realm and handed over; the answer with its bytes, and how many buffers it handed back.
     */
    const send = (id: number, request: Record<string, unknown>) => {
      realm.REQUEST = JSON.stringify({ id, request }, (_k, v) =>
        v instanceof Uint8Array ? { $u8: Array.from(v) } : v,
      );
      const out = vm.runInContext(
        `(() => {
          const { id, request } = JSON.parse(REQUEST, (_k, v) => (v && v.$u8 ? new Uint8Array(v.$u8) : v));
          self.onmessage({ data: { id, request } });
          const { message, transfer } = answers.pop();
          return JSON.stringify({ id: message.id, reply: message.reply, transferred: transfer.length }, (_k, v) =>
            v instanceof Uint8Array ? { $u8: Array.from(v) } : v,
          );
        })()`,
        realm,
      ) as string;
      const answer = JSON.parse(out, (_k, v) => (v && v.$u8 ? Uint8Array.from(v.$u8) : v));
      expect(answer.id).toBe(id);
      expect(answer.reply.ok, answer.reply.error).toBe(true);
      return answer as { reply: Record<string, any>; transferred: number };
    };

    // a staging that places the kite from its file
    const lib = library();
    const brief = withPins(JSON.parse(readFileSync(OPEN, 'utf8')).scene, { elements: { [KITE]: lib.kite } });
    const session = new Y.Doc();
    const staged = send(1, {
      kind: 'stage',
      update: Y.encodeStateAsUpdate(session),
      brief,
      lineage: 'test-lineage',
      generator: 'test',
      units: { units: [{ ...lib.kite.pin, data: lib.kite.data }], problems: [] },
    });
    expect(staged.reply.summary.units).toEqual([
      expect.objectContaining({ slot: `el:${KITE}`, staged: 'unit' }),
    ]);
    expect(staged.transferred).toBe(1);
    Y.applyUpdate(session, staged.reply.diff);
    const doc = SceneDoc.fromUpdate(Y.encodeStateAsUpdate(session));
    const [instance] = listUnits(doc);
    expect(instance).toMatchObject({ key: `el:${KITE}`, ref: lib.kite.pin.ref, version: 1 });

    // a unit of an actor of a plain staging, with its thumbnail rendered here
    const plain = stagedDoc();
    const mira = plain
      .listObjects()
      .find(
        (o) =>
          o.custom_props?.desk_role === 'actor' && o.custom_props?.desk_character_id === 'chr_0123456789mira',
      )!;
    const made = send(2, {
      kind: 'unit-extract',
      update: Y.encodeStateAsUpdate(plain.ydoc),
      what: { root: mira.id },
      name: 'Mira',
      deskVersion: 'test',
    });
    expect(readUnitHeader(made.reply.data)).toMatchObject({ kind: 'figure', name: 'Mira' });
    expect(made.reply.thumbnail).toBeInstanceOf(Uint8Array);
    expect(made.reply.thumbnail.byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(decodePNG(made.reply.thumbnail).width).toBe(256);
    expect(made.transferred).toBe(2);

    // Make local of the kite placed above
    const local = send(3, {
      kind: 'unit-local',
      update: Y.encodeStateAsUpdate(session),
      root: instance.root,
    });
    Y.applyUpdate(session, local.reply.diff);
    expect(listUnits(SceneDoc.fromUpdate(Y.encodeStateAsUpdate(session)))).toEqual([]);
  }, 120_000);
});
