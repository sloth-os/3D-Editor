import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_CATALOG,
  SceneDoc,
  createOperatorRegistry,
  estimateOperator,
  setOperatorMemoryCheck,
  type OperatorContext,
  type OperatorMemoryCheck,
  type OperatorMemoryRequest,
  type OperatorRegistry,
} from '@3d-editor/core';
import { ToolError } from '../../src/mcp/agent';
import { StorageUnavailableError } from '../../src/sync/room-manager';
import { ProjectMemoryError } from '../../src/sync/project-memory';
import {
  KHRONOS,
  KHRONOS_CHAIR_META,
  KHRONOS_INDEX,
  SKETCHFAB_API,
  SF_UID_1,
  bytes,
  cubeGlb,
  cubeGltf,
  fakeFetch,
  json,
  makeStore,
  sketchfabModel,
  type Route,
  type TestStore,
} from './store-fixtures';

/*
 * One model of the store: its details (and files once downloaded), the cached download proxy
 * (files route), the operator call an insert runs, and inserts through the REST path (a room's
 * document, the real core operators): a multi-file glTF passed as the files map, built-in models,
 * and the codes of what cannot be inserted.
 */

const lamp = cubeGltf('cube.bin', 'textures/wood.png');
const LAMP_META = {
  ...KHRONOS_CHAIR_META,
  legal: [
    {
      license: 'CC-BY 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/legalcode',
      artist: 'Cy Lamps',
      year: '2023',
      owner: 'Cy Lamps',
      what: 'Everything',
      text: 'Creative Commons Attribution 4.0 International',
      spdx: 'CC-BY-4.0',
    },
  ],
  name: 'Desk Lamp',
  summary: 'A desk lamp with a wooden base.',
};

/** The Khronos routes: the index, metadata, the chair (GLB) and the lamp (glTF + bin + texture). */
function khronosRoutes(over: Record<string, Route> = {}): Record<string, Route> {
  return {
    [`${KHRONOS}model-index.json`]: json(KHRONOS_INDEX),
    [`${KHRONOS}StudioChair/metadata.json`]: json(KHRONOS_CHAIR_META),
    [`${KHRONOS}StudioChair/glTF-Binary/StudioChair.glb`]: bytes(cubeGlb(), 'model/gltf-binary'),
    [`${KHRONOS}DeskLamp/metadata.json`]: json(LAMP_META),
    [`${KHRONOS}DeskLamp/glTF/DeskLamp.gltf`]: bytes(lamp.gltf, 'model/gltf+json'),
    [`${KHRONOS}DeskLamp/glTF/cube.bin`]: bytes(lamp.bin),
    [`${KHRONOS}DeskLamp/glTF/textures/wood.png`]: bytes(lamp.png, 'image/png'),
    ...over,
  };
}

/** Rooms with one project ('p1') whose document is `doc`. */
function roomsWith(doc: SceneDoc, opts: { fail?: Error } = {}) {
  let touched = 0;
  return {
    touched: () => touched,
    rooms: {
      open: async (id: string) => {
        if (opts.fail) throw opts.fail;
        return id === 'p1' ? { scene: doc, destroyed: false, touch: () => void touched++ } : null;
      },
    },
  };
}

const builtin = BUILTIN_CATALOG.find((e) => e.rig === null)!;

let t: TestStore | null = null;
afterEach(async () => {
  await t?.cleanup();
  t = null;
});

async function store(
  routes = khronosRoutes(),
  o: { registry?: OperatorRegistry; rooms?: unknown; env?: Record<string, string> } = {},
) {
  const f = fakeFetch(routes);
  t = await makeStore({ fetch: f.fetch, registry: o.registry, rooms: o.rooms, env: o.env });
  return { store: t.store, f };
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return err instanceof ToolError ? err.code : `not a ToolError: ${String(err)}`;
  }
  return 'resolved';
}

describe('details', () => {
  it('describes a model with its licence; files only once downloaded', async () => {
    const { store: s, f } = await store();
    const d = await s.details('khronos:DeskLamp');
    expect(d).toMatchObject({
      id: 'khronos:DeskLamp',
      name: 'Desk Lamp',
      description: 'A desk lamp with a wooden base.',
      license: { spdx: 'CC-BY-4.0' },
      thumbnail_url: '/api/store/models/khronos:DeskLamp/thumbnail',
      files: null,
      format: null,
      main: null,
    });
    expect(d.license_note).toMatch(/credit/i);
    expect(f.count(`${KHRONOS}DeskLamp/glTF/`)).toBe(0);
    const dl = await s.details('khronos:DeskLamp', { download: true });
    expect(dl.files).toEqual([
      { path: 'DeskLamp.gltf', bytes: lamp.gltf.length },
      { path: 'cube.bin', bytes: lamp.bin.length },
      { path: 'textures/wood.png', bytes: lamp.png.length },
    ]);
    expect(dl).toMatchObject({ format: 'gltf', main: 'DeskLamp.gltf' });
    // known from the cache afterwards, without asking for the download
    expect((await s.details('khronos:DeskLamp')).files).toHaveLength(3);
    expect(f.count(`${KHRONOS}DeskLamp/glTF/DeskLamp.gltf`)).toBe(1);
  });

  it('describes built-in models with their parameters and never lists files', async () => {
    const { store: s } = await store();
    const d = await s.details(`builtin:${builtin.id}`, { download: true });
    expect(d).toMatchObject({ provider: 'builtin', files: null, format: null, license: { spdx: 'CC0-1.0' } });
    expect(d.license_note).toBeNull();
  });

  it('answers NOT_FOUND for unknown models and providers, UNAVAILABLE for disabled ones', async () => {
    const { store: s } = await store(khronosRoutes(), { env: { STORE_PROVIDERS: 'builtin,khronos' } });
    expect(await codeOf(s.details('khronos:Nope'))).toBe('NOT_FOUND');
    expect(await codeOf(s.details('builtin:nope_nope'))).toBe('NOT_FOUND');
    expect(await codeOf(s.details('martian:x'))).toBe('NOT_FOUND');
    expect(await codeOf(s.details('polyhaven:Wooden_Chair_01'))).toBe('UNAVAILABLE');
    expect(await codeOf(s.details('khronos:'))).toBe('NOT_FOUND');
  });
});

describe('files (the download proxy)', () => {
  it('serves the main file and the files it names, downloading once for concurrent requests', async () => {
    const { store: s, f } = await store();
    const [main, again, tex] = await Promise.all([
      s.files('khronos:DeskLamp', ''),
      s.files('khronos:DeskLamp', 'DeskLamp.gltf'),
      s.files('khronos:DeskLamp', 'textures/wood.png'),
    ]);
    expect(main.contentType).toBe('model/gltf+json');
    expect(main.data).toEqual(lamp.gltf);
    expect(again.etag).toBe(main.etag);
    expect(tex.contentType).toBe('image/png');
    expect(f.count(`${KHRONOS}DeskLamp/glTF/DeskLamp.gltf`)).toBe(1);
    expect(f.count(`${KHRONOS}DeskLamp/glTF/textures/wood.png`)).toBe(1);
    expect(await codeOf(s.files('khronos:DeskLamp', 'missing.png'))).toBe('NOT_FOUND');
    expect(await codeOf(s.files('khronos:DeskLamp', '../../etc/passwd'))).toBe('NOT_FOUND');
    expect(await codeOf(s.files(`builtin:${builtin.id}`, ''))).toBe('INVALID_PARAMS');
  });

  it('reports a failed download as UPSTREAM and downloads again next time', async () => {
    let fail = true;
    const { store: s, f } = await store(
      khronosRoutes({
        [`${KHRONOS}DeskLamp/glTF/cube.bin`]: (req) =>
          fail ? new Response('oops', { status: 500 }) : bytes(lamp.bin)(req),
      }),
    );
    expect(await codeOf(s.files('khronos:DeskLamp', ''))).toBe('UPSTREAM');
    fail = false;
    expect((await s.files('khronos:DeskLamp', 'cube.bin')).data).toEqual(lamp.bin);
    expect(f.count(`${KHRONOS}DeskLamp/glTF/DeskLamp.gltf`)).toBe(2);
  });

  it('refuses what cannot be downloaded: NEEDS_KEY without the provider key', async () => {
    const { store: s, f } = await store({
      [`${SKETCHFAB_API}/models/${SF_UID_1}`]: json(sketchfabModel(SF_UID_1)),
    });
    expect(await codeOf(s.files(`sketchfab:${SF_UID_1}`, ''))).toBe('NEEDS_KEY');
    expect(f.calls.filter((c) => c.url.includes('/download'))).toHaveLength(0);
  });
});

describe('prepareInsert', () => {
  it('calls store.add for a built-in model with its placement and colour', async () => {
    const { store: s } = await store();
    const call = await s.prepareInsert(`builtin:${builtin.id}`, {
      location: [1, 2, 0],
      rotation_deg: 90,
      height_m: 1.2,
      color: '#aa3300',
    });
    expect(call).toMatchObject({
      operator: 'store.add',
      params: {
        model: `builtin:${builtin.id}`,
        location: [1, 2, 0],
        rotation_deg: 90,
        height_m: 1.2,
        color: '#aa3300',
      },
      warnings: [],
    });
    expect(call.entry.thumbnail_url).toBe(`/api/store/models/builtin:${builtin.id}/thumbnail`);
  });

  it('calls store.insert_files with the downloaded files as base64, the entry and notes', async () => {
    const { store: s } = await store();
    const call = await s.prepareInsert('khronos:DeskLamp', { name: 'Lamp', color: '#ffffff' });
    expect(call.operator).toBe('store.insert_files');
    const p = call.params as {
      entry: Record<string, unknown>;
      format: string;
      main: string;
      files: Record<string, string>;
      name: string;
    };
    expect(p.format).toBe('gltf');
    expect(p.main).toBe('DeskLamp.gltf');
    expect(Object.keys(p.files).sort()).toEqual(['DeskLamp.gltf', 'cube.bin', 'textures/wood.png']);
    expect(Buffer.from(p.files['cube.bin'], 'base64')).toEqual(Buffer.from(lamp.bin));
    expect(p.name).toBe('Lamp');
    expect(p.entry).toMatchObject({
      id: 'khronos:DeskLamp',
      provider: 'khronos',
      license: { spdx: 'CC-BY-4.0' },
    });
    expect(call.warnings).toEqual([
      expect.stringMatching(/^khronos:DeskLamp: .*credit/i),
      'color applies to built-in models only: the model keeps its materials',
    ]);
  });
});

describe('the memory an insert takes (asked before the files are read)', () => {
  let installed: OperatorMemoryCheck | null = null;
  afterEach(() => {
    setOperatorMemoryCheck(installed);
    installed = null;
  });

  it("asks the server's check with core's store.insert_files estimate, from the cached files", async () => {
    const asked: OperatorMemoryRequest[] = [];
    installed = setOperatorMemoryCheck((req) => {
      asked.push(req);
      return null;
    });
    const { store: s } = await store();
    const doc = SceneDoc.create({ empty: true });
    // a glTF with a buffer and a texture, and a GLB
    for (const model of ['khronos:DeskLamp', 'khronos:StudioChair']) {
      asked.length = 0;
      const call = await s.prepareInsert(model, {}, { doc });
      expect(asked, model).toHaveLength(1);
      expect(asked[0]).toMatchObject({ operator: 'store.insert_files', doc });
      // what the registry asks when it runs the call: the same estimate, before any file was read
      expect(asked[0].estimate, model).toEqual(
        estimateOperator('store.insert_files', {} as OperatorContext, call.params),
      );
      expect(asked[0].estimate.bytes).toBeGreaterThan(0);
    }
  });

  it('refuses an insert the server cannot hold before reading its files', async () => {
    installed = setOperatorMemoryCheck(() => 'the insert needs 900 MB and 300 MB are free');
    const { store: s } = await store();
    await s.details('khronos:DeskLamp', { download: true });
    const read = s.cache.filesRead;
    const err = await s
      .prepareInsert('khronos:DeskLamp', {}, { doc: SceneDoc.create({ empty: true }) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err).toMatchObject({
      code: 'OUT_OF_MEMORY',
      message: 'the insert needs 900 MB and 300 MB are free',
    });
    expect(s.cache.filesRead).toBe(read);
    // without a document (the browser runs the operator itself) the call is prepared
    expect((await s.prepareInsert('khronos:DeskLamp', {})).operator).toBe('store.insert_files');
    expect(s.cache.filesRead).toBe(read + 3);
  });
});

describe('insert (REST path, real core operators)', () => {
  it('inserts a multi-file glTF through the files map into the project', async () => {
    const doc = SceneDoc.create({ empty: true });
    const r = roomsWith(doc);
    const { store: s } = await store(khronosRoutes(), { registry: createOperatorRegistry(), rooms: r.rooms });
    const res = await s.insert('p1', 'khronos:DeskLamp', { location: [2, 0, 0], height_m: 0.5 });
    const result = res.result as { root: string; objects: string[]; dimensions_m: number[] };
    const root = doc.getObject(result.root)!;
    expect(root.type).toBe('EMPTY');
    expect(root.location).toEqual([2, 0, 0]);
    expect(result.objects.length).toBeGreaterThan(0);
    // scaled to the height asked for
    expect(result.dimensions_m[2]).toBeCloseTo(0.5, 3);
    // the licence travels with the model
    expect(JSON.stringify(root)).toContain('CC-BY-4.0');
    expect(res.entry.id).toBe('khronos:DeskLamp');
    expect(r.touched()).toBe(1);
    // the textured cube kept its texture
    const mesh = doc.listObjects().find((o) => o.type === 'MESH')!;
    expect(mesh).toBeTruthy();
    expect(doc.listImages().length).toBe(1);
  });

  it('inserts a GLB and a built-in model', async () => {
    const doc = SceneDoc.create({ empty: true });
    const { store: s } = await store(khronosRoutes(), {
      registry: createOperatorRegistry(),
      rooms: roomsWith(doc).rooms,
    });
    const chair = await s.insert('p1', 'khronos:StudioChair', {});
    expect(doc.getObject((chair.result as { root: string }).root)?.type).toBe('EMPTY');
    expect(chair.warnings.join(' ')).toMatch(/non-?commercial/i);
    const b = await s.insert('p1', `builtin:${builtin.id}`, { name: 'Mine' });
    expect(doc.getObject((b.result as { root: string }).root)?.name).toBe('Mine');
  });

  it('answers NOT_FOUND, UNAVAILABLE and OUT_OF_MEMORY for projects it cannot open', async () => {
    const doc = SceneDoc.create({ empty: true });
    const ok = await store(khronosRoutes(), {
      registry: createOperatorRegistry(),
      rooms: roomsWith(doc).rooms,
    });
    expect(await codeOf(ok.store.insert('p2', `builtin:${builtin.id}`, {}))).toBe('NOT_FOUND');
    await t!.cleanup();
    const down = await store(khronosRoutes(), {
      registry: createOperatorRegistry(),
      rooms: roomsWith(doc, { fail: new StorageUnavailableError('WebDAV storage is not answering') }).rooms,
    });
    expect(await codeOf(down.store.insert('p1', `builtin:${builtin.id}`, {}))).toBe('UNAVAILABLE');
    await t!.cleanup();
    const full = await store(khronosRoutes(), {
      registry: createOperatorRegistry(),
      rooms: roomsWith(doc, { fail: new ProjectMemoryError('the project is too large to load') }).rooms,
    });
    expect(await codeOf(full.store.insert('p1', `builtin:${builtin.id}`, {}))).toBe('OUT_OF_MEMORY');
    // nothing was downloaded for a project that does not exist
    expect(ok.f.calls).toHaveLength(0);
  });

  it('passes operator failures on with their code', async () => {
    const doc = SceneDoc.create({ empty: true });
    const { store: s } = await store(
      khronosRoutes({
        [`${KHRONOS}StudioChair/glTF-Binary/StudioChair.glb`]: bytes(
          cubeGlb().slice(0, 40),
          'model/gltf-binary',
        ),
      }),
      { registry: createOperatorRegistry(), rooms: roomsWith(doc).rooms },
    );
    const err = await s.insert('p1', 'khronos:StudioChair', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toMatch(/^store.insert_files failed: /);
    expect(doc.listObjects()).toHaveLength(0);
  });
});

describe('public servers only (what a catalog lists cannot reach the server network)', () => {
  const PUBLIC = 'https://models.example.org/team/catalog.json';
  const LAN = 'http://catalog.lan:8080/catalog.json';
  const ADDRESSES: Record<string, string[]> = {
    'models.example.org': ['93.184.216.34'],
    'cdn.example.org': ['93.184.216.35'],
    'intranet.example.org': ['10.1.2.3'],
    'catalog.lan': ['192.168.1.20'],
  };
  const glb = cubeGlb();
  const png = cubeGltf().png;
  const secret = new TextEncoder().encode('[{"Id": "internal"}]');
  const lampGltf = cubeGltf('cube.bin', 'wood.png');
  const routes: Record<string, Route> = {
    [PUBLIC]: json({
      version: 1,
      name: 'Public',
      models: [
        {
          id: 'fine',
          name: 'Fine crate',
          thumbnail: 'https://cdn.example.org/fine.png',
          files: { glb: 'https://cdn.example.org/fine.glb' },
        },
        {
          id: 'loopback',
          name: 'Loopback part',
          files: {
            gltf: 'lamp/lamp.gltf',
            parts: { 'cube.bin': 'http://127.0.0.1:2375/containers/json', 'wood.png': 'wood.png' },
          },
        },
        { id: 'redirected', name: 'Redirected', files: { glb: 'redirect.glb' } },
        { id: 'named', name: 'Named host', files: { glb: 'https://intranet.example.org/x.glb' } },
        { id: 'lan', name: 'LAN file', files: { glb: 'http://catalog.lan:8080/models/own.glb' } },
        {
          id: 'thumb',
          name: 'Inside thumbnail',
          thumbnail: 'http://10.0.0.7/secret.png',
          files: { glb: 'https://cdn.example.org/fine.glb' },
        },
      ],
    }),
    [LAN]: json({
      version: 1,
      name: 'Team LAN',
      models: [
        { id: 'own', name: 'Own model', thumbnail: 'thumbs/own.png', files: { glb: 'models/own.glb' } },
        { id: 'other', name: 'Other host', files: { glb: 'http://10.0.0.5/admin.glb' } },
      ],
    }),
    'https://cdn.example.org/fine.glb': bytes(glb, 'model/gltf-binary'),
    'https://cdn.example.org/fine.png': bytes(png, 'image/png'),
    'https://models.example.org/team/lamp/lamp.gltf': bytes(lampGltf.gltf, 'model/gltf+json'),
    'https://models.example.org/team/lamp/wood.png': bytes(png, 'image/png'),
    'http://127.0.0.1:2375/containers/json': bytes(secret),
    'https://models.example.org/team/redirect.glb': () =>
      new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/admin.glb' } }),
    'http://10.0.0.5/admin.glb': bytes(glb, 'model/gltf-binary'),
    'https://intranet.example.org/x.glb': bytes(glb, 'model/gltf-binary'),
    'http://catalog.lan:8080/models/own.glb': bytes(glb, 'model/gltf-binary'),
    'http://catalog.lan:8080/thumbs/own.png': bytes(png, 'image/png'),
    'http://10.0.0.7/secret.png': bytes(png, 'image/png'),
  };

  async function refusal(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (err) {
      return err instanceof ToolError ? `${err.code}: ${err.message}` : `not a ToolError: ${String(err)}`;
    }
    return 'resolved';
  }

  it('downloads and proxies public files and the configured catalog, nothing else', async () => {
    const f = fakeFetch(routes);
    t = await makeStore({
      fetch: f.fetch,
      env: { STORE_PROVIDERS: 'catalog', STORE_CATALOG_URLS: `${PUBLIC},${LAN}` },
      options: { resolveHost: async (h) => ADDRESSES[h] ?? [] },
    });
    const s = t.store;
    // public servers, and the team's own catalog on its network (configured), work
    expect((await s.files('catalog:public.fine', '')).data).toEqual(glb);
    expect((await s.thumbnail('catalog:public.fine')).contentType).toBe('image/png');
    expect((await s.files('catalog:team-lan.own', '')).data).toEqual(glb);
    expect((await s.thumbnail('catalog:team-lan.own')).contentType).toBe('image/png');
    // what a catalog lists on loopback, private or named-private hosts, directly or by a redirect
    expect(await refusal(s.files('catalog:public.loopback', 'cube.bin'))).toMatch(
      /^UPSTREAM: catalog:public\.loopback: cube\.bin: fetching from 127\.0\.0\.1:2375 is not allowed/,
    );
    expect(await refusal(s.files('catalog:public.redirected', ''))).toMatch(
      /^UPSTREAM: .*fetching from 10\.0\.0\.5 is not allowed: it is a private or local address/,
    );
    expect(await refusal(s.files('catalog:public.named', ''))).toMatch(
      /^UPSTREAM: .*intranet\.example\.org is not allowed: it resolves to 10\.1\.2\.3/,
    );
    expect(await refusal(s.thumbnail('catalog:public.thumb'))).toMatch(
      /^UPSTREAM: .*10\.0\.0\.7 is not allowed/,
    );
    // the LAN catalog's origin is reached for its own models only
    expect(await refusal(s.files('catalog:public.lan', ''))).toMatch(
      /^UPSTREAM: .*catalog\.lan:8080 is not allowed: it resolves to 192\.168\.1\.20/,
    );
    expect(await refusal(s.files('catalog:team-lan.other', ''))).toMatch(
      /^UPSTREAM: .*10\.0\.0\.5 is not allowed/,
    );
    // nothing of the server's network was asked anything
    for (const inside of ['http://127.0.0.1', 'http://10.', 'https://intranet.example.org'])
      expect(f.count(inside), inside).toBe(0);
    expect(f.calls.filter((c) => c.url.startsWith('http://catalog.lan:8080/models/'))).toHaveLength(1);
  });
});
