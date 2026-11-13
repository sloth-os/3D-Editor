import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_CATALOG,
  SceneDoc,
  createEditorState,
  createOperatorRegistry,
  decodePNG,
  type CatalogEntry,
} from '@3d-editor/core';
import type { RenderImageRequest, RenderImageResult } from '../../src/render';
import { ToolError } from '../../src/mcp/agent';
import {
  THUMBNAIL_LOOK,
  THUMBNAIL_SIZE,
  renderBuiltinThumbnail,
  threeQuarterView,
} from '../../src/store/thumbnails';
import {
  KHRONOS,
  KHRONOS_INDEX,
  POLYPIZZA_API,
  SKETCHFAB_API,
  bytes,
  fakeFetch,
  json,
  makeStore,
  polypizzaModel,
  sketchfabModel,
  tinyPng,
  type Route,
  type TestStore,
} from './store-fixtures';

/*
 * Thumbnails: the three-quarter framing of built-in models, their render through the server's
 * renderer (once, then from the cache), and external thumbnails fetched through the store's proxy
 * (once, then from the cache) with their type sniffed from the bytes.
 */

type Vec3 = [number, number, number];

/** The furniture model of the core catalog used here (any static one does). */
const MODEL: CatalogEntry =
  BUILTIN_CATALOG.find((e) => e.rig === null && e.category === 'furniture') ??
  BUILTIN_CATALOG.find((e) => e.rig === null)!;

/** A renderer answering a small PNG and recording what it was asked. */
function fakeRenderer(o: { fail?: Error; delayMs?: number } = {}) {
  const calls: { req: RenderImageRequest; objects: number }[] = [];
  return {
    calls,
    async renderImage(req: RenderImageRequest): Promise<RenderImageResult> {
      calls.push({ req, objects: req.scene.listObjects().length });
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if (o.fail) throw o.fail;
      return {
        png: tinyPng([90, 140, 200]),
        width: req.options.width ?? 0,
        height: req.options.height ?? 0,
        engine: 'RASTER',
        threads: 1,
        mode: 'main-thread',
        elapsedMs: 1,
        warnings: [],
      };
    },
  };
}

/** Where a world point lands on the image plane of a view (x, y in units of the half extent). */
function project(view: { position: Vec3; target: Vec3; fovY: number }, p: Vec3, aspect = 1) {
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a: Vec3): Vec3 => {
    const l = Math.hypot(...a);
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const fwd = norm(sub(view.target, view.position));
  const right = norm(cross(fwd, [0, 0, 1]));
  const up = cross(right, fwd);
  const r = sub(p, view.position);
  const depth = dot(r, fwd);
  const t = Math.tan(view.fovY / 2);
  return { x: dot(r, right) / depth / (t * aspect), y: dot(r, up) / depth / t, depth };
}

describe('threeQuarterView', () => {
  const corners = (min: Vec3, max: Vec3): Vec3[] =>
    Array.from({ length: 8 }, (_, i) => [
      i & 1 ? max[0] : min[0],
      i & 2 ? max[1] : min[1],
      i & 4 ? max[2] : min[2],
    ]);

  it('looks at the box centre from the front right and above, every corner in the frame', () => {
    for (const [min, max] of [
      [
        [-0.3, -0.3, 0],
        [0.3, 0.3, 0.9],
      ],
      [
        [-2, -0.8, 0],
        [2, 0.8, 1.4],
      ],
      [
        [-0.05, -0.05, 0],
        [0.05, 0.05, 3],
      ],
      [
        [0, 0, 0],
        [12, 6, 0.2],
      ],
    ] as [Vec3, Vec3][]) {
      const v = threeQuarterView({ min, max }) as { position: Vec3; target: Vec3; fovY: number; up: Vec3 };
      expect(v.target).toEqual([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]);
      // in front (−Y), to the right (+X), above
      expect(v.position[1]).toBeLessThan(v.target[1]);
      expect(v.position[0]).toBeGreaterThan(v.target[0]);
      expect(v.position[2]).toBeGreaterThan(v.target[2]);
      let widest = 0;
      for (const c of corners(min, max)) {
        const p = project(v, c);
        expect(p.depth).toBeGreaterThan(0);
        expect(Math.abs(p.x)).toBeLessThanOrEqual(0.87);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(0.87);
        widest = Math.max(widest, Math.abs(p.x), Math.abs(p.y));
      }
      // as close as the margin allows: the model fills the frame
      expect(widest).toBeGreaterThan(0.84);
    }
  });

  it('keeps a camera outside degenerate boxes', () => {
    const v = threeQuarterView({ min: [1, 1, 1], max: [1, 1, 1] }) as { position: Vec3; target: Vec3 };
    expect(Math.hypot(v.position[0] - 1, v.position[1] - 1, v.position[2] - 1)).toBeGreaterThan(0.04);
  });
});

describe('renderBuiltinThumbnail', () => {
  it('renders the model alone, 256 px square, clay look, transparent, three-quarter view', async () => {
    const renderer = fakeRenderer();
    const png = await renderBuiltinThumbnail({ id: MODEL.id, registry: createOperatorRegistry(), renderer });
    expect(decodePNG(png).width).toBe(2);
    expect(renderer.calls).toHaveLength(1);
    const { req, objects } = renderer.calls[0];
    // the model's root and its parts, nothing else (no camera, no lights of the default scene)
    expect(objects).toBeGreaterThan(0);
    expect(req.options).toMatchObject({
      width: THUMBNAIL_SIZE,
      height: THUMBNAIL_SIZE,
      engine: 'RASTER',
      background: [0, 0, 0, 0],
      desk: THUMBNAIL_LOOK,
    });
    expect(THUMBNAIL_LOOK.look).toBe('clay');
    const view = req.options.view as { position: Vec3; target: Vec3 };
    // the model stands on the ground at the origin: the camera looks at its middle from above
    expect(view.target[2]).toBeGreaterThan(0);
    expect(view.position[2]).toBeGreaterThan(view.target[2]);
  });

  it('answers NOT_FOUND for unknown models and FAILED when the render fails', async () => {
    const renderer = fakeRenderer();
    await expect(
      renderBuiltinThumbnail({ id: 'no_such_model', registry: createOperatorRegistry(), renderer }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(renderer.calls).toHaveLength(0);
    await expect(
      renderBuiltinThumbnail({
        id: MODEL.id,
        registry: createOperatorRegistry(),
        renderer: fakeRenderer({ fail: new ToolError('render process crashed', 'FAILED') }),
      }),
    ).rejects.toThrow('render process crashed');
  });
});

describe('ModelStore.thumbnail', () => {
  let t: TestStore | null = null;
  afterEach(async () => {
    await t?.cleanup();
    t = null;
  });

  it('renders a built-in thumbnail once (also for concurrent requests), then serves it from the cache', async () => {
    const renderer = fakeRenderer({ delayMs: 30 });
    t = await makeStore({ services: { renderer: renderer as never, registry: createOperatorRegistry() } });
    const [a, b] = await Promise.all([
      t.store.thumbnail(`builtin:${MODEL.id}`),
      t.store.thumbnail(`builtin:${MODEL.id}`),
    ]);
    expect(renderer.calls).toHaveLength(1);
    expect(a.contentType).toBe('image/png');
    expect(a.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(b.data).toEqual(a.data);
    // a bare id is a built-in one
    const c = await t.store.thumbnail(MODEL.id);
    expect(c.etag).toBe(a.etag);
    expect(renderer.calls).toHaveLength(1);
    // a new server finds the PNG on disk
    const again = await makeStore({
      dir: t.dir,
      services: { renderer: renderer as never, registry: createOperatorRegistry() },
    });
    try {
      expect((await again.store.thumbnail(`builtin:${MODEL.id}`)).etag).toBe(a.etag);
      expect(renderer.calls).toHaveLength(1);
    } finally {
      await again.cleanup();
    }
  });

  it('renders built-in thumbnails one at a time in one document, holding only the model rendered', async () => {
    const renderer = fakeRenderer({ delayMs: 5 });
    const seen: { guid: string; names: string[] }[] = [];
    const render = renderer.renderImage.bind(renderer);
    renderer.renderImage = (req) => {
      seen.push({ guid: req.scene.ydoc.guid, names: req.scene.listObjects().map((o) => o.name) });
      return render(req);
    };
    t = await makeStore({ services: { renderer: renderer as never, registry: createOperatorRegistry() } });
    const models = BUILTIN_CATALOG.filter((e) => e.rig === null && e.id !== MODEL.id).slice(0, 3);
    await Promise.all(models.map((m) => t!.store.thumbnail(`builtin:${m.id}`)));
    await t.store.thumbnail(`builtin:${MODEL.id}`);
    // one document for the render processes to keep, whatever the number of thumbnails
    expect(seen).toHaveLength(4);
    expect(new Set(seen.map((x) => x.guid)).size).toBe(1);
    // each render saw its model alone, as store.add builds it in an empty document
    const alone = (id: string) => {
      const doc = SceneDoc.create({ empty: true });
      const res = createOperatorRegistry().run(
        { doc, state: createEditorState(), origin: { type: 'test' }, source: 'api', report: () => undefined },
        'store.add',
        { model: `builtin:${id}`, location: [0, 0, 0] },
      );
      expect(res.ok).toBe(true);
      return doc.listObjects().map((o) => o.name);
    };
    const key = (names: string[]) => JSON.stringify([...names].sort());
    expect(seen.map((x) => key(x.names)).sort()).toEqual(
      [...models.map((m) => m.id), MODEL.id].map((id) => key(alone(id))).sort(),
    );
  });

  it('keeps nothing when the render fails and tries again next time', async () => {
    const failing = fakeRenderer({ fail: new Error('no render process') });
    t = await makeStore({ services: { renderer: failing as never, registry: createOperatorRegistry() } });
    await expect(t.store.thumbnail(`builtin:${MODEL.id}`)).rejects.toThrow('no render process');
    await expect(t.store.thumbnail(`builtin:${MODEL.id}`)).rejects.toThrow('no render process');
    expect(failing.calls).toHaveLength(2);
    await expect(t.store.thumbnail('builtin:no_such_model')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('proxies external thumbnails once and sniffs their type', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
    const f = fakeFetch({
      [`${KHRONOS}model-index.json`]: json(KHRONOS_INDEX),
      // served as octet-stream: the bytes say JPEG
      [`${KHRONOS}StudioChair/screenshot/screenshot.jpg`]: bytes(jpeg),
      [`${KHRONOS}ToyTruck/screenshot/screenshot.jpg`]: bytes(
        new TextEncoder().encode('{"error":"rate limited"}'),
        'application/json',
      ),
    });
    t = await makeStore({ fetch: f.fetch });
    const a = await t.store.thumbnail('khronos:StudioChair');
    expect(a.contentType).toBe('image/jpeg');
    expect(a.data).toEqual(jpeg);
    await t.store.thumbnail('khronos:StudioChair');
    expect(f.count(`${KHRONOS}StudioChair/screenshot`)).toBe(1);
    await expect(t.store.thumbnail('khronos:ToyTruck')).rejects.toMatchObject({ code: 'UPSTREAM' });
    await expect(t.store.thumbnail('khronos:AlphaBlendModeTest')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(t.store.thumbnail('nope:x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('serves the thumbnails of a page of Sketchfab and Poly Pizza results without a model request each', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
    ]);
    const uids = Array.from({ length: 24 }, (_, i) => (i + 1).toString(16).padStart(32, '0'));
    const ids = Array.from({ length: 24 }, (_, i) => `stool${i}`);
    const unlisted = 'f'.repeat(32);
    const routes: Record<string, Route> = {
      [`${SKETCHFAB_API}/search`]: json({
        results: uids.map((u) => sketchfabModel(u)),
        cursors: { next: null },
      }),
      [`${SKETCHFAB_API}/models/${unlisted}`]: json(sketchfabModel(unlisted)),
      [`${POLYPIZZA_API}/search/stool`]: json({ total: 24, results: ids.map((id) => polypizzaModel(id)) }),
    };
    for (const u of [...uids, unlisted]) routes[`https://media.sketchfab.com/${u}/256.jpeg`] = bytes(jpeg);
    for (const id of ids) routes[`https://static.poly.pizza/${id}.webp`] = bytes(webp, 'image/webp');
    const f = fakeFetch(routes);
    t = await makeStore({
      fetch: f.fetch,
      env: { STORE_PROVIDERS: 'sketchfab,polypizza', POLYPIZZA_API_KEY: 'pp-key' },
    });
    for (const [query, provider] of [
      ['chair', 'sketchfab'],
      ['stool', 'polypizza'],
    ] as const) {
      const page = await t.store.search({ query, providers: [provider], limit: 24 });
      expect(page.results).toHaveLength(24);
      const thumbs = await Promise.all(page.results.map((r) => t!.store.thumbnail(r.id)));
      expect(
        thumbs.every((x) => x.contentType === (provider === 'sketchfab' ? 'image/jpeg' : 'image/webp')),
      ).toBe(true);
    }
    // the search answers had the thumbnails: no model was looked up for them
    expect(f.count(`${SKETCHFAB_API}/models/`)).toBe(0);
    expect(f.count(`${POLYPIZZA_API}/model/`)).toBe(0);
    // a model no search listed is looked up once
    expect((await t.store.thumbnail(`sketchfab:${unlisted}`)).contentType).toBe('image/jpeg');
    expect(f.count(`${SKETCHFAB_API}/models/${unlisted}`)).toBe(1);
    // Poly Pizza's own files get its key; others never do
    expect(f.calls.find((c) => c.url.startsWith('https://static.poly.pizza/'))?.headers['x-auth-token']).toBe(
      'pp-key',
    );
    expect(
      f.calls.find((c) => c.url.startsWith('https://media.sketchfab.com/'))?.headers['x-auth-token'],
    ).toBe(undefined);
  });
});
