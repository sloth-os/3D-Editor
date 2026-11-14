import { SceneDoc, newShotId, setShots } from '@3d-editor/core';
import type { Renderer } from '../../src/render';
import type { RenderLease, RenderRequest, RenderThread } from '../../src/render/pool';
import {
  RenderCancelledError,
  RenderOutOfMemoryError,
  type DeskShotInfo,
  type DocRef,
  type EncodedResult,
  type FrameOptions,
  type ImageResult,
  type PassName,
  type ProcessMemory,
  type RawFrame,
} from '../../src/render/protocol';
import { silentLog } from '../../src/observability/log';
import type { ServiceContext } from '../../src/services';
import type { RoomManager } from '../../src/sync/room-manager';

/*
 * Fakes for unit tests of video exports: a renderer whose render threads answer desk-shot, image
 * and encode requests at once with small synthetic frames (and record what they were asked), and a
 * service context around it (config, rooms, log) for VideoExports. Its render processes can be made
 * to die on chosen requests (`kill`), like the system's out-of-memory killer ends one: the request
 * fails, the thread is dead from then on, and the next lease gets a new thread in its place (the
 * pool starts a replacement process). Like the real pool, it starts its processes with the first
 * long lease (`running` counts them from then on), and they answer `memory` with what `rss` says.
 */

export interface FakeRendererStats {
  /** Long leases taken and released. */
  leases: number;
  releases: number;
  /** Frames asked per long lease, in order. */
  leaseFrames: number[];
  /** Image requests: scene frame and camera per request, in the order sent. */
  images: { frame: number; camera: string | undefined; doc: string }[];
  deskShots: number;
  encodes: number;
  /** The tiles of the contact sheets encoded (in order). */
  contactTiles: RawFrame[];
  /** Documents registered with docRef: their object counts. */
  docs: { key: string; objects: number; names: string[] }[];
  /** Render processes that died (`kill`) and threads started in their place. */
  deaths: number;
  replacements: number;
  /** Image requests per thread id. */
  imagesByThread: Map<number, number>;
  /** `memory` requests (thread ids, in order). */
  memoryCalls: number[];
  /** releaseBuffers calls: thread id and whether the documents went too. */
  bufferReleases: { thread: number; documents: boolean }[];
}

export interface FakeRenderer {
  renderer: Renderer;
  stats: FakeRendererStats;
  /** Milliseconds each image takes (changeable while running). */
  delayMs: number;
  /** Makes image requests of these scene frames fail with this error. */
  failFrame: { frame: number; error: Error } | null;
  /**
   * Ends the render process of the thread a request is sent to when this answers true (its call
   * fails like one of a process killed by the system) or an error (its call fails with it); later
   * calls to the thread fail at once.
   */
  kill: ((req: RenderRequest, thread: number) => boolean | Error) | null;
  /** Resident memory a thread reports (`memory`; default 128 MiB, a render process's base). */
  rss: (thread: number) => number;
  /** The threads started and alive (the pool's `running`; none before the first long lease). */
  started(): RenderThread[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The error of a call whose render process was killed (as ProcessThread reports it). */
export function killedError(): RenderOutOfMemoryError {
  return new RenderOutOfMemoryError(
    'out of memory: the render process was killed (SIGKILL), most likely by the system because the machine ran out of memory; the server keeps running and starts a new render process for the next render',
    undefined,
    'killed',
  );
}

/** A synthetic frame: beauty grey by frame, the requested passes, the camera and subject boxes. */
function fakeImage(o: FrameOptions): ImageResult {
  const { width: w, height: h } = o;
  const n = w * h;
  const data = new Uint8ClampedArray(n * 4).fill(Math.round(o.frame) % 256);
  const passes: Partial<Record<PassName, Uint8Array>> = {};
  for (const p of o.desk?.passes ?? []) {
    if (p === 'beauty') continue;
    passes[p] = new Uint8Array(p === 'normal' || p === 'pose' ? n * 3 : n).fill(p === 'mask' ? 1 : 128);
  }
  return {
    width: w,
    height: h,
    data,
    passes,
    meta: {
      camera: { matrix: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, -10, 1, 1], fovY: 0.6 },
      subjects: Object.fromEntries(
        (o.desk?.subjects ?? []).map((id) => [id, { x: 1, y: 2, w: 3, h: 4, visible: true }]),
      ),
    },
    ...(o.desk?.passes.includes('pose') ? { warnings: ['pose pass: fake warning'] } : {}),
  };
}

/** A fake renderer with `threads` render processes (mode 'main-thread' to test the refusal). */
export function makeFakeRenderer(
  opts: { threads?: number; mode?: 'processes' | 'main-thread' } = {},
): FakeRenderer {
  const stats: FakeRendererStats = {
    leases: 0,
    releases: 0,
    leaseFrames: [],
    images: [],
    deskShots: 0,
    encodes: 0,
    contactTiles: [],
    docs: [],
    deaths: 0,
    replacements: 0,
    imagesByThread: new Map(),
    memoryCalls: [],
    bufferReleases: [],
  };
  const fake: FakeRenderer = {
    renderer: null as unknown as Renderer,
    stats,
    delayMs: 0,
    failFrame: null,
    kill: null,
    rss: () => 128 * 1024 * 1024,
    started: () => (started ? threads.filter((t) => t.alive) : []),
  };
  let current = -1;
  /** The pool started its processes (the first long lease). */
  let started = false;
  /** Long leases not released yet. */
  let longLeases = 0;
  const answer = async (req: RenderRequest, thread: number): Promise<unknown> => {
    if (req.type === 'desk-shot') {
      stats.deskShots++;
      const info: DeskShotInfo = { depthRange: [1, 20], shadowFit: null, ms: 1 };
      return info;
    }
    if (req.type === 'memory') {
      stats.memoryCalls.push(thread);
      const m: ProcessMemory = { rss: fake.rss(thread), heapUsed: 0, external: 0, arrayBuffers: 0 };
      return m;
    }
    if (req.type === 'image') {
      const o = req.options;
      stats.images.push({ frame: o.frame ?? 0, camera: o.cameraId, doc: req.doc.key });
      stats.imagesByThread.set(thread, (stats.imagesByThread.get(thread) ?? 0) + 1);
      if (current >= 0) stats.leaseFrames[current]++;
      if (fake.delayMs) await sleep(fake.delayMs);
      if (fake.failFrame && fake.failFrame.frame === o.frame) throw fake.failFrame.error;
      return fakeImage(o);
    }
    if (req.type === 'encode') {
      stats.encodes++;
      stats.contactTiles.push(...req.frames);
      const res: EncodedResult = { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) };
      return res;
    }
    throw new Error(`fake renderer: unexpected request ${req.type}`);
  };
  let nextId = 1;
  const thread = (): RenderThread & { alive: boolean } => {
    const t = {
      id: nextId++,
      kind: (opts.mode === 'main-thread' ? 'main' : 'process') as RenderThread['kind'],
      alive: true,
      pending: 0,
      release() {},
      releaseBuffers(o: { documents?: boolean } = {}) {
        stats.bufferReleases.push({ thread: t.id, documents: !!o.documents });
      },
      async call(req: RenderRequest): Promise<unknown> {
        if (!t.alive) throw killedError();
        const killed = fake.kill?.(req, t.id);
        if (killed) {
          t.alive = false;
          stats.deaths++;
          throw killed instanceof Error ? killed : killedError();
        }
        return answer(req, t.id);
      },
    };
    return t as unknown as RenderThread & { alive: boolean };
  };
  let threads = Array.from({ length: opts.threads ?? 2 }, thread);
  const renderer = {
    pool: {
      mode: opts.mode ?? 'processes',
      capacity: threads.length,
      /** Live render processes (started by the first long lease, as the real pool does). */
      get running() {
        return fake.started().length;
      },
      /** Long leases held now. */
      get activeLongRenders() {
        return longLeases;
      },
      async lease(
        max = Infinity,
        signal?: AbortSignal,
        o: { interactive?: boolean } = {},
      ): Promise<RenderLease> {
        if (signal?.aborted) throw new RenderCancelledError();
        await sleep(0);
        // processes that died are replaced (the pool starts new ones)
        threads = threads.map((t) => {
          if (t.alive) return t;
          stats.replacements++;
          return thread();
        });
        if (!o.interactive) {
          started = true;
          longLeases++;
          stats.leases++;
          stats.leaseFrames.push(0);
          current = stats.leaseFrames.length - 1;
        }
        let released = false;
        return {
          threads: o.interactive ? threads.slice(0, 1) : threads.slice(0, Math.min(threads.length, max)),
          release() {
            if (released) return;
            released = true;
            if (!o.interactive) {
              longLeases--;
              stats.releases++;
              current = -1;
            }
          },
        };
      },
    },
    docRef(projectId: string, doc: SceneDoc): DocRef {
      const key = `${projectId}:${doc.ydoc.guid}`;
      const objects = doc.listObjects();
      stats.docs.push({ key, objects: objects.length, names: objects.map((x) => x.name).sort() });
      return { key, version: 1 };
    },
    async physics() {
      return null;
    },
  };
  fake.renderer = renderer as unknown as Renderer;
  return fake;
}

/** A project for exports: the default scene, a second camera and `shots` shots of `frames` frames. */
export function exportScene(opts: { shots?: number; frames?: number } = {}): {
  doc: SceneDoc;
  cams: string[];
  cube: string;
  shotIds: string[];
} {
  const doc = SceneDoc.create({ name: 'Demo' });
  const cam = doc.listObjects().find((o) => o.type === 'CAMERA')!.id;
  const cube = doc.listObjects().find((o) => o.type === 'MESH')!.id;
  const cam2 = doc.addObject({
    type: 'CAMERA',
    name: 'Close',
    data: doc.addCamera({ lens: 85 }),
    location: [0, -5, 1.5],
    rotation_euler: [1.4, 0, 0],
  });
  const frames = opts.frames ?? 12;
  const count = opts.shots ?? 2;
  doc.transact(() => {
    doc.updateScene({ fps: 24, frame_start: 1, frame_end: Math.max(1, frames * count), camera: cam });
    doc.updateRender({ resolution_x: 32, resolution_y: 18, resolution_percentage: 100 });
    doc.updateObject(cube, { custom_props: { desk_role: 'prop' } });
  });
  const shots = setShots(
    doc,
    Array.from({ length: count }, (_, i) => ({
      id: newShotId(),
      name: i === 0 ? 'Wide' : `Shot ${i + 1}`,
      enabled: true,
      camera: i % 2 ? cam2 : cam,
      frame_start: 1 + i * frames,
      frame_end: (i + 1) * frames,
      subjects: [cube],
    })),
  );
  return { doc, cams: [cam, cam2], cube, shotIds: shots.map((s) => s.id) };
}

export interface FakeContextOptions {
  exportDir: string;
  ffmpegPath: string;
  renderer: Renderer;
  /** Projects by id. */
  projects?: Record<string, SceneDoc>;
  exportMaxQueued?: number;
  exportTtlMs?: number;
  exportMaxBytes?: number;
  log?: ServiceContext['log'];
}

/** A service context for VideoExports: the export settings, the given projects as rooms, the renderer. */
export function fakeContext(o: FakeContextOptions): ServiceContext {
  const rooms = new Map(Object.entries(o.projects ?? {}).map(([id, scene]) => [id, { id, scene }]));
  const roomManager = {
    async open(id: string) {
      const r = rooms.get(id);
      if (!r) throw new Error(`no project ${id}`);
      return r;
    },
    loadedNamed(name: string) {
      return [...rooms.values()].filter((r) => r.scene.name === name);
    },
  };
  return {
    config: {
      exportDir: o.exportDir,
      ffmpegPath: o.ffmpegPath,
      exportMaxQueued: o.exportMaxQueued ?? 4,
      exportTtlMs: o.exportTtlMs ?? 24 * 3_600_000,
      exportMaxBytes: o.exportMaxBytes ?? 1024 * 1024 * 1024,
    },
    log: o.log ?? silentLog,
    metrics: undefined,
    rooms: roomManager as unknown as RoomManager,
    services: { renderer: o.renderer },
    fetch: globalThis.fetch,
  } as unknown as ServiceContext;
}
