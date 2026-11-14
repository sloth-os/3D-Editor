import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { encodePNG, type OperatorRegistry } from '@3d-editor/core';
import { loadConfig, type ServerConfig } from '../../src/config';
import { silentLog } from '../../src/observability/log';
import { ServerMetrics } from '../../src/observability/metrics';
import { ModelStore, type ModelStoreOptions } from '../../src/store';
import { LOCAL_FETCH } from '../../src/store/http';
import type { ServerServices, ServiceContext } from '../../src/services';

/*
 * Fixtures of the model store tests: a fake fetch with routes and a request log, small but valid
 * model files (a textured cube as .gltf + .bin + .png, and as .glb), a ZIP writer, provider
 * answers that mirror the real APIs' shapes (synthetic names and people), and a store factory
 * with a temporary cache directory. Nothing here touches the network.
 */

// ------------------------------------------------------------------ fake fetch

export interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

export type Route = (req: {
  url: URL;
  headers: Headers;
  signal?: AbortSignal;
}) => Response | Promise<Response>;

export interface FakeFetch {
  fetch: typeof fetch;
  calls: FetchCall[];
  /** Calls to URLs starting with `prefix`. */
  count(prefix: string): number;
}

/**
 * A fetch answering from `routes` (exact URL first, then the URL without its query); anything
 * else answers 404. Every call is logged with its headers. Marked LOCAL_FETCH: a store using it
 * resolves no host names (they would mean nothing), unless a test gives it a resolver.
 */
export function fakeFetch(routes: Record<string, Route>): FakeFetch {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const h: Record<string, string> = {};
    headers.forEach((v, k) => (h[k] = v));
    calls.push({ url: url.href, headers: h });
    if (init?.signal?.aborted) throw init.signal.reason ?? new Error('aborted');
    const route = routes[url.href] ?? routes[`${url.origin}${url.pathname}`];
    if (!route) return new Response('not found', { status: 404 });
    return route({ url, headers, signal: init?.signal ?? undefined });
  }) as typeof fetch;
  Object.defineProperty(fetchImpl, LOCAL_FETCH, { value: true });
  return { fetch: fetchImpl, calls, count: (prefix) => calls.filter((c) => c.url.startsWith(prefix)).length };
}

export const json =
  (value: unknown, status = 200): Route =>
  () =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

export const bytes =
  (data: Uint8Array, type = 'application/octet-stream'): Route =>
  () =>
    new Response(new Uint8Array(data), {
      headers: { 'content-type': type, 'content-length': String(data.length) },
    });

/** A route that never answers (until the request is aborted). */
export const hang: Route = ({ signal }) =>
  new Promise<Response>((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
  });

// ------------------------------------------------------------------ model files

/** A 2×2 PNG. */
export function tinyPng(rgb: [number, number, number] = [200, 120, 40]): Uint8Array {
  const data = new Uint8ClampedArray(16);
  for (let i = 0; i < 4; i++) data.set([...rgb, 255], i * 4);
  return encodePNG({ width: 2, height: 2, data } as Parameters<typeof encodePNG>[0]);
}

/** A cube 2 × 1 × 0.5 m (x, y, z) with UVs: positions, uvs and indices as one buffer. */
function cubeBuffer(): {
  bin: Uint8Array;
  views: { offset: number; length: number }[];
  count: number;
  indices: number;
} {
  const [hx, hy, hz] = [1, 0.5, 0.25];
  const p: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const faces: [number, number, number][][] = [
    [
      [-hx, -hy, -hz],
      [hx, -hy, -hz],
      [hx, -hy, hz],
      [-hx, -hy, hz],
    ],
    [
      [hx, hy, -hz],
      [-hx, hy, -hz],
      [-hx, hy, hz],
      [hx, hy, hz],
    ],
    [
      [-hx, hy, -hz],
      [-hx, -hy, -hz],
      [-hx, -hy, hz],
      [-hx, hy, hz],
    ],
    [
      [hx, -hy, -hz],
      [hx, hy, -hz],
      [hx, hy, hz],
      [hx, -hy, hz],
    ],
    [
      [-hx, -hy, hz],
      [hx, -hy, hz],
      [hx, hy, hz],
      [-hx, hy, hz],
    ],
    [
      [-hx, hy, -hz],
      [hx, hy, -hz],
      [hx, -hy, -hz],
      [-hx, -hy, -hz],
    ],
  ];
  for (const f of faces) {
    const base = p.length / 3;
    for (const v of f) p.push(...v);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const pos = new Float32Array(p);
  const tex = new Float32Array(uv);
  const ind = new Uint16Array(idx);
  const bin = new Uint8Array(pos.byteLength + tex.byteLength + ind.byteLength);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(tex.buffer), pos.byteLength);
  bin.set(new Uint8Array(ind.buffer), pos.byteLength + tex.byteLength);
  return {
    bin,
    views: [
      { offset: 0, length: pos.byteLength },
      { offset: pos.byteLength, length: tex.byteLength },
      { offset: pos.byteLength + tex.byteLength, length: ind.byteLength },
    ],
    count: p.length / 3,
    indices: idx.length,
  };
}

function cubeJson(
  c: ReturnType<typeof cubeBuffer>,
  buffer: Record<string, unknown>,
  image: Record<string, unknown>,
) {
  return {
    asset: { version: '2.0', generator: 'store test' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Cube' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [{ name: 'Wood', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [image],
    buffers: [buffer],
    bufferViews: [
      { buffer: 0, byteOffset: c.views[0].offset, byteLength: c.views[0].length },
      { buffer: 0, byteOffset: c.views[1].offset, byteLength: c.views[1].length },
      { buffer: 0, byteOffset: c.views[2].offset, byteLength: c.views[2].length },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: c.count,
        type: 'VEC3',
        min: [-1, -0.5, -0.25],
        max: [1, 0.5, 0.25],
      },
      { bufferView: 1, componentType: 5126, count: c.count, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: c.indices, type: 'SCALAR' },
    ],
  };
}

/** A textured cube as a .gltf naming `binUri` and `imageUri`, with those files. */
export function cubeGltf(binUri = 'cube.bin', imageUri = 'textures/wood.png') {
  const c = cubeBuffer();
  const png = tinyPng();
  const gltf = new TextEncoder().encode(
    JSON.stringify(cubeJson(c, { uri: binUri, byteLength: c.bin.byteLength }, { uri: imageUri })),
  );
  return { gltf, bin: c.bin, png };
}

/** The textured cube as one .glb. */
export function cubeGlb(): Uint8Array {
  const c = cubeBuffer();
  const png = tinyPng();
  const pad = (n: number) => (4 - (n % 4)) % 4;
  const binLength = c.bin.byteLength + pad(c.bin.byteLength) + png.byteLength;
  const json = cubeJson(
    c,
    { byteLength: binLength + pad(binLength) },
    { bufferView: 3, mimeType: 'image/png' },
  );
  (json.bufferViews as unknown[]).push({
    buffer: 0,
    byteOffset: c.bin.byteLength + pad(c.bin.byteLength),
    byteLength: png.byteLength,
  });
  let jsonBytes: Uint8Array = new TextEncoder().encode(JSON.stringify(json));
  jsonBytes = concat([jsonBytes, new Uint8Array(pad(jsonBytes.length)).fill(0x20)]);
  const binChunk = new Uint8Array(binLength + pad(binLength));
  binChunk.set(c.bin, 0);
  binChunk.set(png, c.bin.byteLength + pad(c.bin.byteLength));
  const total = 12 + 8 + jsonBytes.length + 8 + binChunk.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  const at = 20 + jsonBytes.length;
  dv.setUint32(at, binChunk.length, true);
  dv.setUint32(at + 4, 0x004e4942, true);
  out.set(binChunk, at + 8);
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const md5 = (data: Uint8Array) => createHash('md5').update(data).digest('hex');

// ------------------------------------------------------------------ ZIP writer

export interface ZipInput {
  name: string;
  data: Uint8Array;
  /** 8 (deflate, default) or 0 (stored). */
  method?: 0 | 8;
  /** Sets the encryption flag (the data stays plain). */
  encrypted?: boolean;
  /** Overrides the CRC written (a damaged entry). */
  crc?: number;
  /** Overrides the uncompressed size written (a lying entry). */
  size?: number;
}

/** A ZIP archive of `entries` (with ZIP64 end records when `zip64`). */
export function makeZip(entries: ZipInput[], opts: { zip64?: boolean } = {}): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    const method = e.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(e.data)) : e.data;
    const crc = e.crc ?? crc32(e.data) >>> 0;
    const size = e.size ?? e.data.length;
    const flags = (e.encrypted ? 1 : 0) | 0x800;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const cd = concat(centrals);
  const tail: Uint8Array[] = [];
  if (opts.zip64) {
    const rec = new Uint8Array(56);
    const rv = new DataView(rec.buffer);
    rv.setUint32(0, 0x06064b50, true);
    rv.setBigUint64(4, 44n, true);
    rv.setUint16(12, 45, true);
    rv.setUint16(14, 45, true);
    rv.setBigUint64(24, BigInt(entries.length), true);
    rv.setBigUint64(32, BigInt(entries.length), true);
    rv.setBigUint64(40, BigInt(cd.length), true);
    rv.setBigUint64(48, BigInt(offset), true);
    const loc = new Uint8Array(20);
    const lv = new DataView(loc.buffer);
    lv.setUint32(0, 0x07064b50, true);
    lv.setBigUint64(8, BigInt(offset + cd.length), true);
    lv.setUint32(16, 1, true);
    tail.push(rec, loc);
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, opts.zip64 ? 0xffff : entries.length, true);
  ev.setUint16(10, opts.zip64 ? 0xffff : entries.length, true);
  ev.setUint32(12, opts.zip64 ? 0xffffffff : cd.length, true);
  ev.setUint32(16, opts.zip64 ? 0xffffffff : offset, true);
  tail.push(end);
  return concat([...locals, cd, ...tail]);
}

// ------------------------------------------------------------------ provider answers (real shapes)

export const KHRONOS = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/';

/**
 * model-index.json: label, name, screenshot, tags, variants (as the real index lists them; its tags
 * do not tell test scenes from real-world models: both are tagged core and testing).
 */
export const KHRONOS_INDEX = [
  {
    label: 'Studio Chair',
    name: 'StudioChair',
    screenshot: 'screenshot/screenshot.jpg',
    tags: ['showcase', 'video', 'extension'],
    variants: { glTF: 'StudioChair.gltf', 'glTF-Binary': 'StudioChair.glb' },
  },
  {
    label: 'Alpha Blend Mode Test',
    name: 'AlphaBlendModeTest',
    screenshot: 'screenshot/screenshot.jpg',
    tags: ['core', 'testing'],
    variants: { glTF: 'AlphaBlendModeTest.gltf', 'glTF-Binary': 'AlphaBlendModeTest.glb' },
  },
  {
    label: 'Compressed Lantern',
    name: 'CompressedLantern',
    screenshot: 'screenshot/screenshot.jpg',
    tags: ['showcase'],
    variants: { 'glTF-Draco': 'CompressedLantern.gltf', 'glTF-KTX-BasisU': 'CompressedLantern.gltf' },
  },
  {
    label: 'Toy Truck',
    name: 'ToyTruck',
    screenshot: 'screenshot/screenshot.jpg',
    tags: ['showcase', 'extension'],
    variants: { 'glTF-Binary': 'ToyTruck.glb' },
  },
  {
    label: 'Desk Lamp',
    name: 'DeskLamp',
    screenshot: 'screenshot/screenshot.jpg',
    tags: ['extension'],
    variants: { glTF: 'DeskLamp.gltf' },
  },
  {
    label: 'Avocado',
    name: 'Avocado',
    screenshot: 'screenshot/screenshot.jpg',
    tags: ['core', 'testing'],
    variants: { glTF: 'Avocado.gltf', 'glTF-Binary': 'Avocado.glb' },
  },
];

/** metadata.json of StudioChair: two parts, CC0 and CC-BY-NC (the stricter wins). */
export const KHRONOS_CHAIR_META = {
  version: 2,
  legal: [
    {
      license: 'CC0-1.0',
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/legalcode',
      artist: 'Ada Modeler',
      year: '2021',
      owner: 'Example Furniture Co',
      what: 'Model',
      text: 'Creative Commons Zero v1.0 Universal',
      spdx: 'CC0-1.0',
    },
    {
      license: 'CC-BY-NC-4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/legalcode',
      artist: 'Ben Texturer',
      year: '2022',
      owner: 'Ben Texturer',
      what: 'Textures',
      text: 'Creative Commons Attribution Non Commercial 4.0 International',
      spdx: 'CC-BY-NC-4.0',
    },
  ],
  tags: ['showcase', 'video', 'extension'],
  screenshot: 'screenshot/screenshot.jpg',
  name: 'Studio Chair',
  path: './Models/StudioChair',
  summary: 'A chair with fabric seat and wooden legs.',
};

export const POLYHAVEN_API = 'https://api.polyhaven.com';
const PH_DL = 'https://dl.polyhaven.org/file/ph-assets/Models';

/** /assets?t=models (keyed by asset id, dimensions in millimetres). */
export const POLYHAVEN_ASSETS = {
  Wooden_Chair_01: {
    name: 'Wooden Chair 01',
    type: 2,
    categories: ['furniture', 'seating'],
    tags: ['chair', 'wood', 'kitchen'],
    authors: { 'Ann Example': 'All' },
    polycount: 1200,
    dimensions: [500, 520, 900],
    files_hash: 'abc123',
    download_count: 50,
    thumbnail_url: 'https://cdn.polyhaven.com/asset_img/thumbs/Wooden_Chair_01.png?width=256&height=256',
  },
  Rock_Pile_02: {
    name: 'Rock Pile 02',
    type: 2,
    categories: ['nature', 'rocks'],
    tags: ['stones', 'boulder'],
    authors: { 'Cy Example': 'All', 'Di Example': 'Photogrammetry' },
    polycount: 30000,
    dimensions: [2000, 1500, 600],
    files_hash: 'def456',
    download_count: 80,
    thumbnail_url: 'https://cdn.polyhaven.com/asset_img/thumbs/Rock_Pile_02.png?width=256&height=256',
  },
  Brass_Lamp_01: {
    name: 'Brass Lamp 01',
    type: 2,
    categories: ['lighting', 'decorative'],
    tags: ['lamp', 'brass'],
    authors: { 'Ann Example': 'All' },
    polycount: 4000,
    dimensions: [200, 200, 450],
    download_count: 20,
    thumbnail_url: 'https://cdn.polyhaven.com/asset_img/thumbs/Brass_Lamp_01.png?width=256&height=256',
  },
};

/** /files/Wooden_Chair_01 for the cube: the glTF at 1k with its includes (url, size, md5). */
export function polyhavenFiles(cube = cubeGltf('Wooden_Chair_01.bin', 'textures/wooden_chair_diff_1k.png')) {
  const entry = (url: string, data: Uint8Array) => ({ url, size: data.length, md5: md5(data) });
  return {
    files: {
      gltf: {
        '1k': {
          gltf: {
            ...entry(`${PH_DL}/gltf/1k/Wooden_Chair_01/Wooden_Chair_01_1k.gltf`, cube.gltf),
            include: {
              'Wooden_Chair_01.bin': entry(`${PH_DL}/gltf/1k/Wooden_Chair_01/Wooden_Chair_01.bin`, cube.bin),
              'textures/wooden_chair_diff_1k.png': entry(
                `${PH_DL}/jpg/1k/Wooden_Chair_01/wooden_chair_diff_1k.png`,
                cube.png,
              ),
            },
          },
        },
        '2k': {
          gltf: {
            url: `${PH_DL}/gltf/2k/Wooden_Chair_01/Wooden_Chair_01_2k.gltf`,
            size: 1,
            md5: '0',
            include: {},
          },
        },
      },
      blend: { '1k': { blend: { url: `${PH_DL}/blend/1k/x.blend`, size: 1, md5: '0' } } },
    },
    cube,
  };
}

export const SKETCHFAB_API = 'https://api.sketchfab.com/v3';
export const SF_UID_1 = '0123456789abcdef0123456789abcdef';
export const SF_UID_2 = 'fedcba9876543210fedcba9876543210';
export const SF_UID_AGE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** A Sketchfab model as /v3/search lists it. */
export function sketchfabModel(uid: string, over: Record<string, unknown> = {}) {
  return {
    uri: `${SKETCHFAB_API}/models/${uid}`,
    uid,
    name: `Model ${uid.slice(0, 4)}`,
    viewerUrl: `https://sketchfab.com/3d-models/none-${uid}`,
    isDownloadable: true,
    isAgeRestricted: false,
    tags: [{ name: 'chair', slug: 'chair' }],
    categories: [{ name: 'furniture-home' }],
    faceCount: 2400,
    thumbnails: {
      images: [
        {
          uid: 't1',
          size: 200000,
          width: 1920,
          height: 1080,
          url: `https://media.sketchfab.com/${uid}/1920.jpeg`,
        },
        {
          uid: 't2',
          size: 20000,
          width: 256,
          height: 144,
          url: `https://media.sketchfab.com/${uid}/256.jpeg`,
        },
        { uid: 't3', size: 2000, width: 64, height: 36, url: `https://media.sketchfab.com/${uid}/64.jpeg` },
      ],
    },
    user: { uid: 'u1', username: 'evan_example', displayName: 'Evan Example' },
    archives: { glb: { size: 1000, type: 'glb' }, gltf: { size: 900, type: 'gltf' } },
    license: { uid: '322a749bcfa841b29dff1e8a1bb74b0b', label: 'CC Attribution' },
    ...over,
  };
}

export const POLYPIZZA_API = 'https://api.poly.pizza/v1.1';

/** A Poly Pizza model as /search and /model answer it. */
export function polypizzaModel(id: string, over: Record<string, unknown> = {}) {
  return {
    ID: id,
    Title: `Low Poly Stool ${id}`,
    Attribution: `Low Poly Stool ${id} by Fay Example [CC-BY] via Poly Pizza`,
    Thumbnail: `https://static.poly.pizza/${id}.webp`,
    Download: `https://static.poly.pizza/${id}.glb`,
    'Tri Count': 320,
    Creator: { Username: 'Fay Example', DPURL: 'https://static.poly.pizza/u/fay.webp' },
    Category: 'Furniture & Decor',
    Tags: ['stool', 'seat'],
    Licence: 'CC-BY 3.0',
    Animated: false,
    ...over,
  };
}

// ------------------------------------------------------------------ store factory

export async function tempDir(prefix = 'store-test-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export interface TestStore {
  store: ModelStore;
  config: ServerConfig;
  dir: string;
  ctx: ServiceContext;
  cleanup(): Promise<void>;
}

/** A store with a temporary cache directory, silent logs and the given fetch and providers. */
export async function makeStore(
  o: {
    env?: Record<string, string>;
    fetch?: typeof fetch;
    options?: ModelStoreOptions;
    services?: Partial<ServerServices>;
    registry?: OperatorRegistry;
    rooms?: unknown;
    dir?: string;
  } = {},
): Promise<TestStore> {
  const dir = o.dir ?? (await tempDir());
  const config = loadConfig({
    DATA_DIR: dir,
    LOG_LEVEL: 'silent',
    STORE_PROVIDERS: 'builtin,khronos,polyhaven,sketchfab,polypizza',
    STORE_FETCH_TIMEOUT_MS: '2000',
    ...o.env,
  });
  const ctx = {
    config,
    log: silentLog,
    metrics: new ServerMetrics({ defaultMetrics: false }),
    rooms: o.rooms,
    services: { ...(o.registry ? { registry: o.registry } : {}), ...o.services },
    fetch: o.fetch ?? fakeFetch({}).fetch,
  } as unknown as ServiceContext;
  const store = new ModelStore(ctx, o.options);
  return {
    store,
    config,
    dir,
    ctx,
    cleanup: async () => {
      await store.close();
      if (!o.dir) await rm(dir, { recursive: true, force: true });
    },
  };
}
