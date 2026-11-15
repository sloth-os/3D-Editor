import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  SceneDoc,
  defaultRigidBody,
  documentSimulationBytes,
  newShotId,
  setDeskSettings,
  setShots,
} from '@3d-editor/core';
import {
  SEGMENT_FRAMES,
  keepAwake,
  runBrowserExport,
  type EngineOptions,
  type WakeLockEnv,
} from '../src/export/engine';
import type { VideoEncoderFactory, VideoEncoderLike, VideoFrameFactory } from '../src/export/encode';
import { exportsHeld, holdExportMemory, type HeldMemory } from '../src/export/held';
import { ENCODER_BYTES, WORKER_SLACK_BYTES, fewerWorkersWarning } from '../src/export/memory';
import { WORKER_BASE_BYTES } from '../src/render/memory';
import { tabMemoryWithRenders } from '../src/render/path-trace';
import { MemoryStore, type ExportStore, type StoredFile } from '../src/export/store';
import { BrowserExportError } from '../src/export/support';
import { inProcessWorkerFactory } from '../src/export/workers';
import type { ExportWorkerResponse } from '../src/export/protocol';
import { mp4Info, readPng, readZip } from './export-files';

/*
 * The browser export end to end, in process: render workers running the real worker engine (core
 * renders the frames), a stand-in for WebCodecs' VideoEncoder (one chunk per frame, its key frames
 * as asked), mediabunny muxing and the in-memory store. What it writes: the files, their names,
 * kinds, order and hashes, the sequences and clips (samples, sync samples, colour box, index before
 * the media), the PNG frame archives (palette and indices exactly the mask pass), padding, posters,
 * stills, the contact sheet and the manifest; and how it fails: cancelled, out of memory, bad
 * parameters, VP9 refused.
 */

/** The avcC of a 160×90 High profile stream made by Chromium's encoder (its decoder configuration). */
const AVCC = Uint8Array.from(
  '01640c0cffe1001267640c0cac18d051af24d40404041e1108d401000468ce3c80fdf8f800'
    .match(/../g)!
    .map((h) => parseInt(h, 16)),
);

interface Encoded {
  timestamp: number;
  duration: number;
  key: boolean;
  format: string;
  colorSpace: VideoColorSpaceInit;
  size: number;
  quantizer?: number;
}

/** A VideoEncoder stand-in: one chunk per frame (a 2-byte NAL unit), the decoder configuration with the first. */
class FakeEncoder implements VideoEncoderLike {
  encodeQueueSize = 0;
  state = 'unconfigured';
  config: VideoEncoderConfig | null = null;
  readonly encoded: Encoded[] = [];
  closed = false;

  constructor(private readonly init: VideoEncoderInit) {}

  configure(config: VideoEncoderConfig): void {
    this.config = config;
    this.state = 'configured';
  }

  encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions): void {
    const f = frame as unknown as {
      timestamp: number;
      duration: number;
      format: string;
      colorSpace: VideoColorSpaceInit;
      data: Uint8Array;
    };
    const key = !!options?.keyFrame;
    const index = this.encoded.length;
    this.encoded.push({
      timestamp: f.timestamp,
      duration: f.duration,
      key,
      format: f.format,
      colorSpace: f.colorSpace,
      size: f.data.length,
      quantizer: (options as { vp9?: { quantizer?: number } } | undefined)?.vp9?.quantizer,
    });
    const payload = new Uint8Array([0, 0, 0, 2, key ? 0x65 : 0x41, index & 0xff]);
    const chunk = {
      type: key ? 'key' : 'delta',
      timestamp: f.timestamp,
      duration: f.duration,
      byteLength: payload.length,
      copyTo: (dst: Uint8Array) => dst.set(payload),
    };
    const meta =
      index === 0
        ? {
            decoderConfig: {
              codec: this.config!.codec,
              codedWidth: this.config!.width,
              codedHeight: this.config!.height,
              description: AVCC,
            },
          }
        : undefined;
    this.init.output(chunk as unknown as EncodedVideoChunk, meta as EncodedVideoChunkMetadata);
  }

  async flush(): Promise<void> {}

  close(): void {
    this.closed = true;
    this.state = 'closed';
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function engine(extra: Partial<EngineOptions> = {}) {
  const encoders: FakeEncoder[] = [];
  const stores: (MemoryStore & { disposed?: boolean })[] = [];
  let started = 0;
  const workers = inProcessWorkerFactory(async () => JPEG);
  const opts: EngineOptions = {
    workers: (i) => {
      started++;
      return workers(i);
    },
    probe: async (c) => !c.codec.startsWith('vp09'),
    encoderFactory: ((init) => {
      const e = new FakeEncoder(init);
      encoders.push(e);
      return e;
    }) as VideoEncoderFactory,
    frameFactory: ((data, init) =>
      ({ ...init, data: data.slice(), close() {} }) as unknown as VideoFrame) as VideoFrameFactory,
    store: async () => {
      const s = new MemoryStore() as MemoryStore & { disposed?: boolean };
      const dispose = s.dispose.bind(s);
      s.dispose = async () => {
        s.disposed = true;
        await dispose();
      };
      stores.push(s);
      return s as ExportStore;
    },
    maxWorkers: 2,
    memory: () => ({
      budget: 4 * 1024 ** 3,
      heapLimit: 4 * 1024 ** 3,
      heapUsed: 0,
      deviceGB: 8,
      held: { total: 0, heap: 0 },
    }),
    now: () => new Date('2026-11-14T10:00:00Z'),
    ...extra,
  };
  return { opts, encoders, stores, started: () => started };
}

/**
 * A cube seen by a camera, two shots (7 and 2 frames); the video model's takes last at least 0.25 s.
 * With `rigid`, the cube is an active rigid body of the scene's rigid body world.
 */
function project(o: { rigid?: boolean } = {}): { update: Uint8Array; shots: string[]; doc: SceneDoc } {
  const doc = SceneDoc.create();
  const cube = doc.listObjects().find((o) => o.type === 'MESH')!.id;
  const shots = [newShotId(), newShotId()];
  doc.transact(() => {
    for (const o of doc.listObjects()) if (o.type === 'CAMERA') doc.removeObject(o.id);
    const cam = doc.addObject({
      type: 'CAMERA',
      name: 'Cam',
      data: doc.addCamera({ lens: 35 }),
      location: [0, -8, 1],
      rotation_euler: [Math.PI / 2, 0, 0],
    });
    doc.updateScene({ camera: cam, fps: 24 });
    doc.updateRender({ resolution_x: 32, resolution_y: 18, resolution_percentage: 100 });
    doc.updateObject(cube, { custom_props: { desk_role: 'prop' } });
    setShots(doc, [
      {
        id: shots[0],
        name: 'Wide',
        enabled: true,
        camera: cam,
        frame_start: 1,
        frame_end: 7,
        subjects: [cube],
      },
      {
        id: shots[1],
        name: 'Close',
        enabled: true,
        camera: cam,
        frame_start: 8,
        frame_end: 9,
        subjects: [cube],
      },
    ]);
    setDeskSettings(doc, { min_shot_s: 0.25 });
    if (o.rigid) doc.updateObject(cube, { rigid_body: defaultRigidBody('ACTIVE') });
  });
  return { update: Y.encodeStateAsUpdate(doc.ydoc), shots, doc };
}

const PARAMS = {
  shots: 'all',
  quality: 'draft',
  look: 'clay',
  passes: ['beauty', 'mask'],
  match_model_duration: true,
};

/**
 * A page's screen wake lock and visibility: the browser lets every lock go when the page is hidden
 * and refuses one to a hidden page.
 */
function wakeLockPage(visible = true) {
  const listeners = new Set<() => void>();
  const locks: { released: boolean; release(): Promise<void> }[] = [];
  let refusals = 0;
  const doc = {
    visibilityState: visible ? 'visible' : 'hidden',
    addEventListener: (_type: 'visibilitychange', l: () => void) => void listeners.add(l),
    removeEventListener: (_type: 'visibilitychange', l: () => void) => void listeners.delete(l),
  };
  const env: WakeLockEnv = {
    wakeLock: {
      request: async () => {
        if (doc.visibilityState !== 'visible') {
          refusals++;
          throw Object.assign(new Error('the page is not visible'), { name: 'NotAllowedError' });
        }
        const lock = {
          released: false,
          release: async () => {
            lock.released = true;
          },
        };
        locks.push(lock);
        return lock;
      },
    },
    document: doc,
  };
  const show = (on: boolean) => {
    doc.visibilityState = on ? 'visible' : 'hidden';
    if (!on) for (const l of locks) l.released = true;
    for (const l of [...listeners]) l();
  };
  const held = () => locks.filter((l) => !l.released).length;
  return { env, locks, show, held, listeners, refusals: () => refusals };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

const hex = (b: Uint8Array) => bytesToHex(sha256(b));
const bytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

describe('browser export (in process)', () => {
  it('writes the clips, sequences, frame archives, posters, stills, contact sheet and manifest', async () => {
    const { update, shots } = project();
    const digests = new Map<string, Record<string, string>>();
    const e = engine({ digests: (shot, k, d) => digests.set(`${shot}:${k}`, d) });
    const phases = new Set<string>();
    const r = await runBrowserExport(
      { update, params: PARAMS, stills: true, project: { id: 'p1', name: 'Kite Day' } },
      { onProgress: (p) => phases.add(p.phase) },
      e.opts,
    );
    expect([...phases]).toEqual(['prepare', 'render', 'encode', 'finish']);
    expect(r.shots.map((s) => [s.id, s.frames])).toEqual([
      [shots[0], 7],
      [shots[1], 6],
    ]);
    const [a, b] = r.shots.map((s) => s.slug);
    expect(r.files.map((f) => [f.name, f.kind, f.pass, f.shot])).toEqual([
      [`${a}.mp4`, 'clip', 'beauty', shots[0]],
      [`${a}.mask.mp4`, 'clip', 'mask', shots[0]],
      [`${b}.mp4`, 'clip', 'beauty', shots[1]],
      [`${b}.mask.mp4`, 'clip', 'mask', shots[1]],
      [`${a}.png`, 'poster', null, shots[0]],
      [`${a}.jpg`, 'poster', null, shots[0]],
      [`${b}.png`, 'poster', null, shots[1]],
      [`${b}.jpg`, 'poster', null, shots[1]],
      [`${a}.still.png`, 'still', null, shots[0]],
      [`${b}.still.png`, 'still', null, shots[1]],
      ['contact-sheet.png', 'contact_sheet', null, null],
      ['sequence.mp4', 'sequence', 'beauty', null],
      ['sequence.mask.mp4', 'sequence', 'mask', null],
      ['sequence.mask.zip', 'frames', 'mask', null],
      ['manifest.json', 'manifest', null, null],
    ]);
    expect(r.warnings.some((w) => w.startsWith(`duration_clamped: shot 'Close'`))).toBe(true);
    expect(r.stats.workers).toBe(2);

    // every file's size and SHA-256 are those of its bytes
    const data = new Map<string, Uint8Array>();
    for (const f of r.files) {
      const d = await bytes(await f.blob());
      data.set(f.name, d);
      expect(d.length, f.name).toBe(f.size);
      expect(hex(d), f.name).toBe(f.sha256);
    }

    // the encoders: one per video stream, every output frame once in order, BT.709 limited I420,
    // key frames at the shot starts only (2 s groups are longer than the export)
    expect(e.encoders).toHaveLength(2);
    for (const enc of e.encoders) {
      expect(enc.config).toMatchObject({
        codec: 'avc1.64001e',
        width: 32,
        height: 18,
        framerate: 24,
        latencyMode: 'quality',
      });
      expect(enc.encoded.map((x) => x.timestamp)).toEqual(
        Array.from({ length: 13 }, (_, i) => Math.round((i * 1e6) / 24)),
      );
      expect(enc.encoded.map((x, i) => (x.key ? i : -1)).filter((i) => i >= 0)).toEqual([0, 7]);
      for (const x of enc.encoded) {
        expect(x.format).toBe('I420');
        expect(x.colorSpace).toEqual({
          primaries: 'bt709',
          transfer: 'bt709',
          matrix: 'bt709',
          fullRange: false,
        });
        expect(x.size).toBe(32 * 18 * 1.5);
      }
      expect(enc.closed).toBe(true);
    }

    // clips and sequences: frame counts, a sync sample first, BT.709 limited colour box, index first
    const check = (name: string, frames: number, sync: number[]) => {
      const info = mp4Info(data.get(name)!);
      expect(info.order, name).toEqual(['ftyp', 'moov', 'mdat']);
      expect(info.samples, name).toBe(frames);
      expect(info.sync, name).toEqual(sync);
      expect(info.colr, name).toEqual({
        type: 'nclx',
        primaries: 1,
        transfer: 1,
        matrix: 1,
        fullRange: false,
      });
      expect(info.timescale, name).toBe(24);
      expect(info.durations, name).toEqual(Array(frames).fill(1));
      expect(info.avcC, name).toEqual(AVCC);
      expect([info.width, info.height], name).toEqual([32, 18]);
    };
    check(`${a}.mp4`, 7, [1]);
    check(`${a}.mask.mp4`, 7, [1]);
    check(`${b}.mp4`, 6, [1]);
    check(`${b}.mask.mp4`, 6, [1]);
    check('sequence.mp4', 13, [1, 8]);
    check('sequence.mask.mp4', 13, [1, 8]);

    // the mask frames: one indexed PNG per output frame, the palette the manifest lists, the
    // indices exactly the mask pass rendered (its SHA-256), the padding the last frame again
    const zip = readZip(data.get('sequence.mask.zip')!);
    expect(zip.map((z) => z.name)).toEqual(
      Array.from({ length: 13 }, (_, i) => `frame-${String(i + 1).padStart(6, '0')}.png`),
    );
    const manifest = JSON.parse(new TextDecoder().decode(data.get('manifest.json')!));
    const lut = new Uint8Array(768);
    for (const m of manifest.mask_palette as { index: number; color: string }[])
      lut.set(
        [1, 3, 5].map((o) => parseInt(m.color.slice(o, o + 2), 16)),
        m.index * 3,
      );
    zip.forEach((z, i) => {
      const png = readPng(z.data);
      expect([png.width, png.height, png.depth, png.colorType]).toEqual([32, 18, 8, 3]);
      expect(png.palette).toEqual(lut);
      const shot = i < 7 ? shots[0] : shots[1];
      const k = i < 7 ? i : Math.min(i - 7, 1);
      expect(hex(png.pixels), z.name).toBe(digests.get(`${shot}:${k}`)!.mask);
    });
    expect(new Set(zip.slice(8).map((z) => hex(z.data))).size).toBe(1);
    expect(digests.size).toBe(9);

    // posters (RGB PNG and the worker's JPEG), stills (the beauty image, RGB)
    for (const s of [a, b]) {
      const poster = readPng(data.get(`${s}.png`)!);
      expect([poster.width, poster.height, poster.colorType]).toEqual([32, 18, 2]);
      expect(data.get(`${s}.jpg`)).toEqual(JPEG);
      const still = readPng(data.get(`${s}.still.png`)!);
      expect([still.width, still.height, still.colorType]).toEqual([32, 18, 2]);
      expect(still.pixels).toEqual(poster.pixels);
    }
    expect(readPng(data.get('contact-sheet.png')!).width).toBeGreaterThan(32);

    // the manifest: the server's fields, the files as written, the browser's own block
    expect(manifest).toMatchObject({
      version: 2,
      project: { id: 'p1', name: 'Kite Day' },
      created_at: '2026-11-14T10:00:00.000Z',
      fps: 24,
      width: 32,
      height: 18,
      frames: 13,
      codec: 'h264',
      color: { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', range: 'limited' },
      look: 'clay',
      quality: 'draft',
      passes: ['beauty', 'mask'],
      // the codec of the videos as written (their avcC), not the string the encoder was asked for
      exporter: { kind: 'browser', video_codec: 'avc1.640c0c', render_workers: 2 },
    });
    expect(manifest.shots).toHaveLength(2);
    expect(manifest.files.map((f: { name: string }) => f.name)).toEqual(
      r.files.slice(0, -1).map((f) => f.name),
    );
    for (const f of manifest.files as {
      name: string;
      kind: string;
      bytes: number;
      sha256: string;
      pass?: string;
    }[]) {
      const file = r.files.find((x) => x.name === f.name)!;
      expect(f.bytes).toBe(file.size);
      expect(f.sha256).toBe(file.sha256);
    }
    const kinds = Object.fromEntries(
      (manifest.files as { name: string; kind: string; pass?: string }[]).map((f) => [
        f.name,
        [f.kind, f.pass],
      ]),
    );
    expect(kinds['sequence.mp4']).toEqual(['sequence', undefined]);
    expect(kinds['sequence.mask.mp4']).toEqual(['pass', 'mask']);
    expect(kinds['sequence.mask.zip']).toEqual(['frames', 'mask']);
    expect(kinds[`${b}.mask.mp4`]).toEqual(['clip', 'mask']);
    expect(kinds[`${a}.still.png`]).toEqual(['still', undefined]);
    expect(e.stores[0].disposed).toBeFalsy();
  });

  it('cancels: its workers stop at once, its encoders close and its files are deleted', async () => {
    const { update } = project();
    // the workers: stopped when, and asked anything after the cancel?
    let cancelledAt = false;
    const started: { terminated: boolean; askedAfterCancel: number }[] = [];
    const inProcess = inProcessWorkerFactory(async () => JPEG);
    // the store: every file written, and those still being written
    const written: StoredFile[] = [];
    const open = new Map<string, { aborted: boolean }>();
    const e = engine({
      workers: (i) => {
        const w = inProcess(i);
        const seen = { terminated: false, askedAfterCancel: 0 };
        started.push(seen);
        const terminate = w.terminate.bind(w);
        w.terminate = () => {
          seen.terminated = true;
          terminate();
        };
        const post = w.postMessage.bind(w);
        w.postMessage = (m, transfer) => {
          if (cancelledAt) seen.askedAfterCancel++;
          post(m, transfer);
        };
        return w;
      },
      store: async () => {
        const s = new MemoryStore();
        const bytes = s.bytes.bind(s);
        const sequential = s.sequential.bind(s);
        s.bytes = async (info, data) => {
          const f = await bytes(info, data);
          written.push(f);
          return f;
        };
        s.sequential = async (info) => {
          const f = await sequential(info);
          const state = { aborted: false };
          open.set(info.name, state);
          return {
            write: f.write,
            close: async () => {
              open.delete(info.name);
              const done = await f.close();
              written.push(done);
              return done;
            },
            abort: async () => {
              state.aborted = true;
              await f.abort();
            },
          };
        };
        return s as ExportStore;
      },
    });
    const ctrl = new AbortController();
    let terminatedAtCancel: boolean[] = [];
    const run = runBrowserExport(
      { update, params: PARAMS },
      {
        signal: ctrl.signal,
        onProgress: (p) => {
          if (p.phase !== 'render' || p.done !== 3 || cancelledAt) return;
          ctrl.abort();
          cancelledAt = true;
          terminatedAtCancel = started.map((w) => w.terminated);
        },
      },
      e.opts,
    );
    await expect(run).rejects.toMatchObject({ name: 'BrowserExportError', code: 'CANCELLED' });
    // every worker stopped as the export was cancelled, and none was asked anything afterwards
    expect(terminatedAtCancel).toEqual([true, true]);
    expect(started.map((w) => w.askedAfterCancel)).toEqual([0, 0]);
    expect(e.encoders.length).toBeGreaterThan(0);
    expect(e.encoders.every((x) => x.closed)).toBe(true);
    // the files written are deleted, and those being written (the mask frame archive) were aborted
    expect(written.length).toBeGreaterThan(0);
    for (const f of written) await expect(f.blob(), f.name).rejects.toThrow(/released with its export/);
    expect([...open.keys()]).toEqual(['sequence.mask.zip']);
    expect([...open.values()].every((f) => f.aborted)).toBe(true);
  });

  it('fails, rather than hangs, when a render worker cannot post a frame', async () => {
    const { update } = project();
    let frames = 0;
    const e = engine({
      workers: inProcessWorkerFactory(
        async () => JPEG,
        (r: ExportWorkerResponse) => {
          // the browser could not clone the third frame's answer (V8: out of memory)
          if (r.ok && 'video' in (r.result as object) && ++frames === 3)
            throw Object.assign(new Error('Data cannot be cloned, out of memory.'), {
              name: 'DataCloneError',
            });
        },
      ),
    });
    const err = (await runBrowserExport({ update, params: PARAMS }, {}, e.opts).catch(
      (x: unknown) => x,
    )) as BrowserExportError;
    expect(err).toBeInstanceOf(BrowserExportError);
    expect(err.code).toBe('FAILED');
    expect(err.message).toBe(
      'the render worker could not send its answer to the page (DataCloneError: Data cannot be cloned, out of memory.)',
    );
    expect(e.stores[0].disposed).toBe(true);
  });

  it('keeps the screen on while it runs: asked again when the page is shown after a tab switch, let go at the end', async () => {
    const { update } = project();
    const page = wakeLockPage();
    const e = engine({ wakeLock: page.env });
    let heldWhileHidden = -1;
    const heldAfter: number[] = [];
    await runBrowserExport(
      { update, params: PARAMS },
      {
        onProgress: (p) => {
          if (p.phase !== 'render') return;
          if (p.done === 3) {
            page.show(false);
            heldWhileHidden = page.held();
          }
          if (p.done === 6) page.show(true);
          if (p.done === 9) heldAfter.push(page.held());
        },
      },
      e.opts,
    );
    expect(heldWhileHidden).toBe(0);
    // the lock asked for again once the page was shown, and held until the export ended
    expect(page.locks).toHaveLength(2);
    expect(heldAfter).toEqual([1]);
    expect(page.held()).toBe(0);
    expect(page.listeners.size).toBe(0);
  });

  it('asks for the wake lock once a hidden page is shown, again after a refusal, and never after the release', async () => {
    const page = wakeLockPage(false);
    const release = keepAwake(page.env);
    await settle();
    expect(page.locks).toHaveLength(0);
    page.show(true);
    await settle();
    expect(page.held()).toBe(1);
    // shown again while the lock is held: no second one
    page.show(true);
    await settle();
    expect(page.locks).toHaveLength(1);
    release();
    await settle();
    expect(page.held()).toBe(0);
    page.show(false);
    page.show(true);
    await settle();
    expect(page.locks).toHaveLength(1);
    // without Screen Wake Lock: nothing to do
    expect(() => keepAwake({})()).not.toThrow();
  });

  it('refuses up front what the tab cannot hold, with the figures', async () => {
    const { update } = project();
    const e = engine({
      memory: () => ({
        budget: 64 * 1024 ** 2,
        heapLimit: 4 * 1024 ** 3,
        heapUsed: 0,
        deviceGB: 1,
        held: { total: 0, heap: 0 },
      }),
    });
    const err = (await runBrowserExport({ update, params: PARAMS }, {}, e.opts).catch(
      (x: unknown) => x,
    )) as BrowserExportError;
    expect(err).toBeInstanceOf(BrowserExportError);
    expect(err.code).toBe('OUT_OF_MEMORY');
    expect(err.message).toMatch(
      /^The export was not started: it needs about [\d.]+ GB of memory with one render worker, more than the 0\.1 GB a render may use in this tab \(half the device memory the browser reports, 1 GB/,
    );
    expect(e.started()).toBe(1);
    expect(e.encoders).toHaveLength(0);
    expect(e.stores[0].disposed).toBe(true);
  });

  it('plans with what the tab holds: the other exports and path traced renders running in it', async () => {
    const { update } = project();
    // another export of this tab holds all but 100 MB of the 4 GB a render may use in it (half the
    // 8 GB taken where the browser does not report its memory)
    const unhold = holdExportMemory('another export', { total: 3.9 * 1024 ** 3, heap: 0 });
    try {
      const e = engine({ memory: undefined });
      const err = (await runBrowserExport({ update, params: PARAMS }, {}, e.opts).catch(
        (x: unknown) => x,
      )) as BrowserExportError;
      expect(err).toBeInstanceOf(BrowserExportError);
      expect(err.code).toBe('OUT_OF_MEMORY');
      expect(err.message).toMatch(
        /, more than the 0\.1 GB a render may use in this tab \(half the device memory, taken as 8 GB where the browser does not report it, at most 4\.0 GB, less 3\.9 GB the other renders and exports running in it hold\)/,
      );
      expect(err.message).toContain(
        'kept in memory: wait for the other renders and exports running in this tab to end, or export fewer frames',
      );
      expect(e.encoders).toHaveLength(0);
    } finally {
      unhold();
    }
    // once it ends, the tab holds this one
    const r = await runBrowserExport({ update, params: PARAMS }, {}, engine({ memory: undefined }).opts);
    expect(r.stats.workers).toBe(2);
  });

  it('holds its plan while it runs, for the renders and exports that start meanwhile, and lets it go when it ends', async () => {
    const { update } = project();
    const seen: { exports: HeldMemory; tab: HeldMemory }[] = [];
    const look = () => seen.push({ exports: exportsHeld(), tab: tabMemoryWithRenders().held });
    const r = await runBrowserExport(
      { update, params: PARAMS },
      { onProgress: (p) => p.phase !== 'prepare' && look() },
      engine().opts,
    );
    expect(r.stats.workers).toBe(2);
    expect(seen.length).toBeGreaterThan(3);
    // two render workers and the page: two video encoders (beauty and mask), at the least
    const least = 2 * (WORKER_BASE_BYTES + WORKER_SLACK_BYTES) + 2 * ENCODER_BYTES.base;
    for (const s of seen) {
      expect(s.exports.total).toBeGreaterThan(least);
      expect(s.exports.heap).toBeGreaterThanOrEqual(2 * WORKER_BASE_BYTES);
      expect(s.exports.heap).toBeLessThan(s.exports.total);
      // a RASTER render or another export started now plans with it
      expect(s.tab).toEqual(s.exports);
      expect(s.exports).toEqual(seen[0].exports);
    }
    expect(exportsHeld()).toEqual({ total: 0, heap: 0 });

    // cancelled or failed, it lets it go as well
    const ctrl = new AbortController();
    let during: HeldMemory | null = null;
    await expect(
      runBrowserExport(
        { update, params: PARAMS },
        {
          signal: ctrl.signal,
          onProgress: (p) => {
            if (p.phase === 'render' && p.done === 3) {
              during = exportsHeld();
              ctrl.abort();
            }
          },
        },
        engine().opts,
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(during).toEqual(seen[0].exports);
    expect(exportsHeld()).toEqual({ total: 0, heap: 0 });
    const failing = engine({
      workers: inProcessWorkerFactory(
        async () => JPEG,
        (reply: ExportWorkerResponse) => {
          if (reply.ok && 'video' in (reply.result as object))
            throw Object.assign(new Error('Data cannot be cloned, out of memory.'), {
              name: 'DataCloneError',
            });
        },
      ),
    });
    await expect(runBrowserExport({ update, params: PARAMS }, {}, failing.opts)).rejects.toMatchObject({
      code: 'FAILED',
    });
    expect(exportsHeld()).toEqual({ total: 0, heap: 0 });
  });

  it('starts no more render workers than frames can be in flight at once, and warns of none', async () => {
    const { update } = project();
    // frames rendered ahead capped below one frame: one renders at a time
    const e = engine({ maxBytesAhead: 1, maxWorkers: 4 });
    const r = await runBrowserExport({ update, params: PARAMS }, {}, e.opts);
    expect(r.stats.workers).toBe(1);
    expect(e.started()).toBe(1);
    expect(r.warnings.filter((w) => w.includes('render workers'))).toEqual([]);
  });

  it("counts the rigid body simulation the first worker keeps, and a segment's matrices on the page", async () => {
    const held = async (rigid: boolean) => {
      const { update, doc } = project({ rigid });
      let h: HeldMemory | null = null;
      const r = await runBrowserExport(
        { update, params: PARAMS },
        { onProgress: (p) => void (p.phase === 'render' && (h ??= exportsHeld())) },
        engine().opts,
      );
      expect(r.stats.workers).toBe(2);
      return { held: h! as HeldMemory, doc };
    };
    const plain = await held(false);
    const rigid = await held(true);
    // the last scene frame rendered is the second shot's last (9), from the world's start (1)
    const simulation = documentSimulationBytes(rigid.doc, 9);
    expect(simulation).toBeGreaterThan(0);
    expect(documentSimulationBytes(plain.doc, 9)).toBe(0);
    expect(rigid.held.heap - plain.held.heap).toBe(simulation);
    // one body, a segment of SEGMENT_FRAMES frames of 4x4 doubles
    expect(rigid.held.total - plain.held.total).toBe(simulation + SEGMENT_FRAMES * 128);
  });

  it('plans what it then holds, the simulation included: a byte less and it starts a worker fewer', async () => {
    const { update } = project({ rigid: true });
    let h: HeldMemory | null = null;
    await runBrowserExport(
      { update, params: PARAMS },
      { onProgress: (p) => void (p.phase === 'render' && (h ??= exportsHeld())) },
      engine().opts,
    );
    const total = (h as HeldMemory | null)!.total;
    const budget = (bytes: number) => () => ({
      budget: bytes,
      heapLimit: 4 * 1024 ** 3,
      heapUsed: 0,
      deviceGB: 8,
      held: { total: 0, heap: 0 },
    });
    const fits = await runBrowserExport(
      { update, params: PARAMS },
      {},
      engine({ memory: budget(total) }).opts,
    );
    expect(fits.stats.workers).toBe(2);
    expect(fits.warnings.filter((w) => w.includes('render workers'))).toEqual([]);
    const less = await runBrowserExport(
      { update, params: PARAMS },
      {},
      engine({ memory: budget(total - 1) }).opts,
    );
    expect(less.stats.workers).toBe(1);
    expect(less.warnings).toContain(fewerWorkersWarning(1, 2));
  });

  it('reports invalid parameters and unknown shots with their codes', async () => {
    const { update } = project();
    const e = engine();
    await expect(
      runBrowserExport({ update, params: { ...PARAMS, quality: 'ultra' } }, {}, e.opts),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: expect.stringMatching(/^Invalid video export parameters: quality: /),
    });
    await expect(
      runBrowserExport({ update, params: { ...PARAMS, shots: ['Nope'] } }, {}, e.opts),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining("Shot 'Nope' not found"),
    });
    await expect(
      runBrowserExport({ update: new Uint8Array(0), params: PARAMS }, {}, e.opts),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it('encodes H.264 where the browser has no VP9 encoder, and says so', async () => {
    const { update } = project();
    const e = engine();
    const r = await runBrowserExport(
      {
        update,
        params: {
          ...PARAMS,
          passes: ['beauty'],
          codec: 'vp9',
          outputs: { clips: false, posters: false, contact_sheet: false },
        },
      },
      {},
      e.opts,
    );
    expect(r.files.map((f) => f.name)).toEqual(['sequence.mp4', 'manifest.json']);
    expect(r.warnings).toContain(
      'codec vp9: this browser cannot encode VP9 at 32×18, so the videos are H.264 MP4',
    );
    expect(r.manifest.codec).toBe('h264');
  });

  it('writes VP9 WebM in quantizer mode where the browser encodes VP9', async () => {
    const { update } = project();
    const e = engine({ probe: async () => true });
    const r = await runBrowserExport(
      {
        update,
        params: {
          ...PARAMS,
          passes: ['beauty'],
          codec: 'vp9',
          quality: 'high',
          outputs: { posters: false, contact_sheet: false },
        },
      },
      {},
      e.opts,
    );
    expect(r.files.map((f) => [f.name, f.mime])).toEqual([
      [`${r.shots[0].slug}.webm`, 'video/webm'],
      [`${r.shots[1].slug}.webm`, 'video/webm'],
      ['sequence.webm', 'video/webm'],
      ['manifest.json', 'application/json'],
    ]);
    expect(e.encoders[0].config).toMatchObject({ codec: 'vp09.00.10.08', bitrateMode: 'quantizer' });
    expect(e.encoders[0].encoded.every((x) => x.quantizer === 28)).toBe(true);
    // a WebM (Matroska) file: its EBML header first
    const seq = new Uint8Array(await (await r.files[2].blob()).arrayBuffer());
    expect([...seq.slice(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(r.manifest).toMatchObject({
      codec: 'vp9',
      exporter: { video_codec: 'vp09.00.10.08', bitrate: null, vp9_quantizer: 28 },
    });
  });

  it('starts no encoder when no video is written', async () => {
    const { update } = project();
    const e = engine();
    const r = await runBrowserExport(
      {
        update,
        params: {
          ...PARAMS,
          outputs: { sequence: false, clips: false, posters: true, contact_sheet: false },
        },
      },
      {},
      e.opts,
    );
    expect(e.encoders).toHaveLength(0);
    expect(r.files.map((f) => f.kind)).toEqual([
      'poster',
      'poster',
      'poster',
      'poster',
      'frames',
      'manifest',
    ]);
  });
});
