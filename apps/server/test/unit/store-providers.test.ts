import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import type { CatalogEntry, StoreResult } from '@3d-editor/core';
import { ToolError } from '../../src/mcp/agent';
import { silentLog } from '../../src/observability/log';
import { ModelCache } from '../../src/store/cache';
import { BuiltinProvider } from '../../src/store/providers/builtin';
import { CatalogProvider, catalogSlug, parseCatalog } from '../../src/store/providers/catalog';
import {
  KhronosProvider,
  khronosLicense,
  parseKhronosIndex,
  parseKhronosMetadata,
} from '../../src/store/providers/khronos';
import { licenseNote } from '../../src/store/licenses';
import { PolyHavenProvider, polyhavenGltf } from '../../src/store/providers/polyhaven';
import { PolyPizzaProvider } from '../../src/store/providers/polypizza';
import { SketchfabProvider, sketchfabLicense } from '../../src/store/providers/sketchfab';
import type { ModelProvider, ProviderEnv, ProviderQuery } from '../../src/store/providers/types';
import { queryWords } from '../../src/store/relevance';
import {
  KHRONOS,
  KHRONOS_CHAIR_META,
  KHRONOS_INDEX,
  POLYHAVEN_API,
  POLYHAVEN_ASSETS,
  POLYPIZZA_API,
  SF_UID_1,
  SF_UID_2,
  SF_UID_AGE,
  SKETCHFAB_API,
  fakeFetch,
  json,
  polyhavenFiles,
  polypizzaModel,
  sketchfabModel,
  tempDir,
  type Route,
} from './store-fixtures';
import { KHRONOS_CAR_CONCEPT_META, KHRONOS_DRAGON_META, KHRONOS_REAL_INDEX } from './store-khronos-real';

/*
 * The provider adapters against answers shaped like the real APIs' (Khronos model-index.json and
 * metadata.json, Poly Haven /assets and /files, Sketchfab /v3/search, /v3/models and their
 * download, Poly Pizza /search and /model, a JSON catalog), through a fake fetch.
 */

let dir: string;
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function envOf(routes: Record<string, Route>, cacheDir = dir) {
  const f = fakeFetch(routes);
  const env: ProviderEnv = {
    fetch: f.fetch,
    timeoutMs: 2000,
    cache: new ModelCache({ dir: cacheDir, maxBytes: 1 << 30, log: silentLog }),
    log: silentLog,
  };
  return { env, f };
}

const query = (text: string, over: Partial<ProviderQuery> = {}): ProviderQuery => ({
  text,
  words: queryWords(text),
  category: null,
  offset: 0,
  limit: 20,
  ...over,
});

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return err instanceof ToolError ? (err.code ?? 'none') : `not a ToolError: ${String(err)}`;
  }
  return 'resolved';
}

describe('khronos', () => {
  const routes = (): Record<string, Route> => ({
    [`${KHRONOS}model-index.json`]: json(KHRONOS_INDEX),
    [`${KHRONOS}StudioChair/metadata.json`]: json(KHRONOS_CHAIR_META),
  });

  it('leaves out technical test scenes by name and models without a variant core imports', () => {
    const names = parseKhronosIndex(KHRONOS_INDEX).map((m) => m.name);
    // Avocado is tagged core and testing like the test scene: its name decides
    expect(names).toEqual(['StudioChair', 'ToyTruck', 'DeskLamp', 'Avocado']);
    expect(() => parseKhronosIndex({ not: 'a list' })).toThrow(ToolError);
  });

  it('keeps the real-world models of the real index and leaves out its test scenes', async () => {
    const kept = parseKhronosIndex(KHRONOS_REAL_INDEX).map((m) => m.name);
    // real props tagged core and testing (the tags of most test scenes too)
    for (const name of ['Avocado', 'Duck', 'Fox', 'Lantern', 'BoomBox', 'CesiumMilkTruck', 'BarramundiFish'])
      expect(kept, name).toContain(name);
    for (const name of [
      'AntiqueCamera',
      'Corset',
      'SciFiHelmet',
      'Sponza',
      'Suzanne',
      'SheenChair',
      'ToyCar',
    ])
      expect(kept, name).toContain(name);
    // test scenes, also those tagged extension or written
    for (const name of [
      'Triangle',
      'AnimatedTriangle',
      'SimpleMeshes',
      'Box',
      'BoxTextured',
      'CompareSheen',
      'TransmissionTest',
      'AnisotropyDiscTest',
      'IORTestGrid',
      'SheenTestGrid',
      'MetalRoughSpheres',
      'CubeVisibility',
      'MultipleScenes',
      'RiggedSimple',
      'PotOfCoalsAnimationPointer',
    ])
      expect(kept, name).not.toContain(name);
    expect(kept.length).toBeGreaterThan(40);
    expect(kept.length).toBeLessThan(60);
    // searches find the props, also by their one-word names, and no test scene
    const { env } = envOf({ [`${KHRONOS}model-index.json`]: json(KHRONOS_REAL_INDEX) });
    const p = new KhronosProvider();
    const ids = async (text: string) => (await p.search(query(text), env)).hits.map((h) => h.model.id);
    expect(await ids('fox')).toEqual(['khronos:Fox']);
    expect(await ids('boombox')).toEqual(['khronos:BoomBox']);
    expect(await ids('truck')).toEqual(['khronos:CesiumMilkTruck']);
    expect(await ids('triangle')).toEqual([]);
    expect(await ids('compare')).toEqual([]);
  });

  it('searches the index and reads the licences of the page (cached, also on disk)', async () => {
    const { env, f } = envOf(routes());
    const p = new KhronosProvider();
    const page = await p.search(query('chair'), env);
    expect(page.hits.map((h) => h.model.id)).toEqual(['khronos:StudioChair']);
    const chair = page.hits[0].model;
    expect(chair).toMatchObject({
      provider: 'khronos',
      name: 'Studio Chair',
      category: 'furniture',
      formats: ['glb'],
      downloadable: true,
      license: { spdx: 'CC-BY-NC-4.0', url: 'https://creativecommons.org/licenses/by-nc/4.0/' },
      author: 'Ada Modeler, Ben Texturer',
      thumbnail_url: `${KHRONOS}StudioChair/screenshot/screenshot.jpg`,
      source_url: 'https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/StudioChair',
    });
    expect(page.end).toBeNull();
    // a model whose metadata.json cannot be read shows no licence (the search still answers)
    const lamp = (await p.search(query('lamp'), env)).hits[0].model;
    expect(lamp.license).toEqual({ spdx: 'NOASSERTION', url: null, attribution: null });
    await p.search(query('chair'), env);
    expect(f.count(`${KHRONOS}model-index.json`)).toBe(1);
    expect(f.count(`${KHRONOS}StudioChair/metadata.json`)).toBe(1);
    // a new server reads the index and the licence from the disk cache
    const again = envOf({});
    const page2 = await new KhronosProvider().search(query('chair'), again.env);
    expect(page2.hits[0].model.license.spdx).toBe('CC-BY-NC-4.0');
    expect(again.f.calls).toHaveLength(0);
  });

  it('treats logos as trademark notices, not licences, and links licence texts on GitHub', async () => {
    const car = khronosLicense('Car Concept', parseKhronosMetadata(KHRONOS_CAR_CONCEPT_META, 'CarConcept'));
    expect(car.license.spdx).toBe('CC-BY-4.0');
    expect(car.license.url).toBe('https://creativecommons.org/licenses/by/4.0/');
    expect(car.author).toBe('Eric Chadwick');
    expect(car.license.attribution).toBe(
      '"Car Concept", Khronos glTF Sample Assets. Model and textures: Eric Chadwick (© 2024 Darmstadt ' +
        'Graphics Group GmbH), CC-BY-4.0. Contains trademarks: Khronos logo (Khronos Group), 3D ' +
        'Commerce logo (Khronos Group).',
    );
    expect(licenseNote(car.license.spdx)).toBe('licence CC-BY-4.0: credit the author');
    const dragon = khronosLicense(
      'Dragon Attenuation',
      parseKhronosMetadata(KHRONOS_DRAGON_META, 'DragonAttenuation'),
    );
    expect(dragon.license.spdx).toBe('LicenseRef-Stanford-Graphics');
    expect(dragon.license.url).toBe(
      'https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/LICENSES/LicenseRef-Stanford-Graphics.txt',
    );
    // the provider resolves them for the model it reads
    const { env } = envOf({
      [`${KHRONOS}model-index.json`]: json(KHRONOS_REAL_INDEX),
      [`${KHRONOS}CarConcept/metadata.json`]: json(KHRONOS_CAR_CONCEPT_META),
      [`${KHRONOS}DragonAttenuation/metadata.json`]: json(KHRONOS_DRAGON_META),
    });
    const d = await new KhronosProvider().details('CarConcept', env);
    expect(d.model).toMatchObject({ author: 'Eric Chadwick', license: { spdx: 'CC-BY-4.0' } });
    const dd = await new KhronosProvider().details('DragonAttenuation', env);
    expect(dd.model.license.url).toMatch(
      /^https:\/\/github\.com\/KhronosGroup\/glTF-Sample-Assets\/blob\/main\/LICENSES\//,
    );
  });

  it('filters by category and lists everything for an empty query', async () => {
    const { env } = envOf(routes());
    const p = new KhronosProvider();
    expect((await p.search(query('', { category: 'vehicles' }), env)).hits.map((h) => h.model.id)).toEqual([
      'khronos:ToyTruck',
    ]);
    const all = await p.search(query('', { limit: 2 }), env);
    expect(all.hits.map((h) => h.model.id)).toEqual(['khronos:StudioChair', 'khronos:ToyTruck']);
    expect(all.end).toBe(2);
    expect(all.hits.map((h) => h.next)).toEqual([1, 2]);
  });

  it('reads metadata.json for details: the most restrictive licence and every artist credited', async () => {
    const { env } = envOf(routes());
    const p = new KhronosProvider();
    const d = await p.details('StudioChair', env);
    expect(d.model.license.spdx).toBe('CC-BY-NC-4.0');
    expect(d.model.license.url).toBe('https://creativecommons.org/licenses/by-nc/4.0/');
    expect(d.model.license.attribution).toContain('"Studio Chair", Khronos glTF Sample Assets');
    expect(d.model.license.attribution).toContain(
      'Model: Ada Modeler (© 2021 Example Furniture Co), CC0-1.0',
    );
    expect(d.model.license.attribution).toContain('Textures: Ben Texturer, CC-BY-NC-4.0');
    expect(d.model.author).toBe('Ada Modeler, Ben Texturer');
    expect(d.description).toBe('A chair with fabric seat and wooden legs.');
    // read once, the licence shows in search results too
    const page = await p.search(query('chair'), env);
    expect(page.hits[0].model.license.spdx).toBe('CC-BY-NC-4.0');
  });

  it('downloads the glTF-Binary variant, or the multi-file glTF with discovery', async () => {
    const { env } = envOf(routes());
    const p = new KhronosProvider();
    expect(await p.plan('StudioChair', env)).toEqual({
      format: 'glb',
      main: 'StudioChair.glb',
      files: [{ path: 'StudioChair.glb', url: `${KHRONOS}StudioChair/glTF-Binary/StudioChair.glb` }],
      discover: false,
    });
    const lamp = await p.plan('DeskLamp', env);
    expect(lamp).toMatchObject({ format: 'gltf', main: 'DeskLamp.gltf', discover: true });
    expect(lamp.files[0].url).toBe(`${KHRONOS}DeskLamp/glTF/DeskLamp.gltf`);
    expect(await codeOf(p.details('AlphaBlendModeTest', env))).toBe('NOT_FOUND');
    expect(await p.thumbnail('ToyTruck', env)).toEqual({
      url: `${KHRONOS}ToyTruck/screenshot/screenshot.jpg`,
    });
  });
});

describe('polyhaven', () => {
  const files = polyhavenFiles();
  const routes = (): Record<string, Route> => ({
    [`${POLYHAVEN_API}/assets`]: json(POLYHAVEN_ASSETS),
    [`${POLYHAVEN_API}/files/Wooden_Chair_01`]: json(files.files),
  });

  it('maps the asset list: CC0, authors, metres, categories, Poly Haven attribution', async () => {
    const { env, f } = envOf(routes());
    const page = await new PolyHavenProvider().search(query('chair'), env);
    expect(page.hits.map((h) => h.model.id)).toEqual(['polyhaven:Wooden_Chair_01']);
    expect(page.hits[0].model).toMatchObject({
      name: 'Wooden Chair 01',
      category: 'furniture',
      license: { spdx: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
      author: 'Ann Example',
      source_url: 'https://polyhaven.com/a/Wooden_Chair_01',
      dimensions_m: [0.5, 0.52, 0.9],
      triangles: 1200,
      formats: ['gltf'],
    });
    expect(page.hits[0].model.license.attribution).toBe(
      '"Wooden Chair 01" by Ann Example, Poly Haven (polyhaven.com), CC0',
    );
    // the API asks clients to name themselves
    expect(f.calls[0].url).toBe(`${POLYHAVEN_API}/assets?t=models`);
    expect(f.calls[0].headers['user-agent']).toBe('3D-Editor model store');
  });

  it('orders by downloads for empty queries and maps lighting to props', async () => {
    const { env } = envOf(routes());
    const p = new PolyHavenProvider();
    expect((await p.search(query(''), env)).hits.map((h) => h.model.id)).toEqual([
      'polyhaven:Rock_Pile_02',
      'polyhaven:Wooden_Chair_01',
      'polyhaven:Brass_Lamp_01',
    ]);
    expect((await p.search(query('', { category: 'props' }), env)).hits.map((h) => h.model.id)).toEqual([
      'polyhaven:Brass_Lamp_01',
    ]);
  });

  it('plans the 1k glTF with its includes (sizes and MD5s)', async () => {
    const { env } = envOf(routes());
    const plan = await new PolyHavenProvider().plan('Wooden_Chair_01', env);
    expect(plan.format).toBe('gltf');
    expect(plan.main).toBe('Wooden_Chair_01_1k.gltf');
    expect(plan.files.map((f) => f.path)).toEqual([
      'Wooden_Chair_01_1k.gltf',
      'Wooden_Chair_01.bin',
      'textures/wooden_chair_diff_1k.png',
    ]);
    expect(plan.files[1]).toMatchObject({
      bytes: files.cube.bin.length,
      md5: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(() => polyhavenGltf({ blend: {} }, 'x')).toThrow(/no glTF/);
  });
});

describe('sketchfab', () => {
  const SF_UID_3 = 'cccccccccccccccccccccccccccccccc';
  // the API's cursor is the offset of the next page: the first page lists 3 models, then 1
  const search =
    (): Route =>
    ({ url }) => {
      if (url.searchParams.get('cursor') === '3')
        return json({
          results: [sketchfabModel(SF_UID_3)],
          cursors: { next: null, previous: '0' },
          next: null,
        })({
          url,
          headers: new Headers(),
        });
      return json({
        results: [
          sketchfabModel(SF_UID_1),
          sketchfabModel(SF_UID_AGE, { isAgeRestricted: true }),
          sketchfabModel(SF_UID_2, {
            name: 'Retro Radio',
            categories: [{ name: 'electronics-gadgets' }],
            license: {
              uid: '34b725081a6a4184957efaec2cb84ed3',
              label: 'CC Attribution-NonCommercial-NoDerivs',
            },
          }),
        ],
        cursors: { next: '3', previous: null },
      })({ url, headers: new Headers() });
    };

  it('searches without a token: per-model licences, needs_key, the 256 px thumbnail', async () => {
    const { env, f } = envOf({ [`${SKETCHFAB_API}/search`]: search() });
    const page = await new SketchfabProvider(null).search(query('chair', { limit: 5 }), env);
    expect(page.hits.map((h) => h.model.id)).toEqual([
      `sketchfab:${SF_UID_1}`,
      `sketchfab:${SF_UID_2}`,
      `sketchfab:${SF_UID_3}`,
    ]);
    const m = page.hits[0].model;
    expect(m).toMatchObject({
      license: { spdx: 'CC-BY-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
      author: 'Evan Example',
      category: 'furniture',
      formats: ['glb'],
      needs_key: 'SKETCHFAB_TOKEN',
      triangles: 2400,
      thumbnail_url: `https://media.sketchfab.com/${SF_UID_1}/256.jpeg`,
    });
    expect(m.license.attribution).toContain('by Evan Example');
    expect(page.hits[1].model.license.spdx).toBe('CC-BY-NC-ND-4.0');
    const url = new URL(f.calls[0].url);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      type: 'models',
      downloadable: 'true',
      q: 'chair',
      count: '24',
    });
    expect(f.calls[0].headers.authorization).toBeUndefined();
    // the age-restricted model is skipped; the second request starts at the API's cursor
    expect(page.hits.map((h) => h.next)).toEqual([1, 3, 4]);
    expect(new URL(f.calls[1].url).searchParams.get('cursor')).toBe('3');
    expect(page.end).toBeNull();
  });

  it('pages with the API cursor and stops at its end', async () => {
    const { env } = envOf({ [`${SKETCHFAB_API}/search`]: search() });
    const p = new SketchfabProvider('tok');
    const first = await p.search(query('chair', { limit: 1 }), env);
    expect(first.hits.map((h) => h.model.id)).toEqual([`sketchfab:${SF_UID_1}`]);
    expect(first.end).toBe(1);
    expect(first.hits[0].model.needs_key).toBeUndefined();
    const second = await p.search(query('chair', { offset: 3, limit: 5 }), env);
    expect(second.hits.map((h) => h.model.id)).toEqual([`sketchfab:${SF_UID_3}`]);
    expect(second.end).toBeNull();
  });

  it('filters categories the API cannot (props) from the models own categories', async () => {
    const { env, f } = envOf({ [`${SKETCHFAB_API}/search`]: search() });
    const page = await new SketchfabProvider(null).search(
      query('radio', { category: 'props', limit: 1 }),
      env,
    );
    expect(page.hits.map((h) => h.model.name)).toEqual(['Retro Radio']);
    expect(new URL(f.calls[0].url).searchParams.has('categories')).toBe(false);
    const { env: env2, f: f2 } = envOf({ [`${SKETCHFAB_API}/search`]: search() });
    await new SketchfabProvider(null).search(query('chair', { category: 'furniture' }), env2);
    expect(new URL(f2.calls[0].url).searchParams.get('categories')).toBe('furniture-home');
  });

  it('downloads only with a token: the glb link, else the glTF archive; 401/403 mapped', async () => {
    const model: Route = json({ ...sketchfabModel(SF_UID_1), updatedAt: '2024-01-01T00:00:00' });
    const glb = `https://cdn.example.org/${SF_UID_1}.glb?sig=1`;
    const zip = `https://cdn.example.org/${SF_UID_1}.zip?sig=1`;
    const { env } = envOf({ [`${SKETCHFAB_API}/models/${SF_UID_1}`]: model });
    expect(await codeOf(new SketchfabProvider(null).plan(SF_UID_1, env))).toBe('NEEDS_KEY');

    const ok = envOf({
      [`${SKETCHFAB_API}/models/${SF_UID_1}`]: model,
      [`${SKETCHFAB_API}/models/${SF_UID_1}/download`]: json({
        glb: { url: glb, size: 1000, expires: 300 },
        gltf: { url: zip },
      }),
    });
    const plan = await new SketchfabProvider('tok').plan(SF_UID_1, ok.env);
    expect(plan).toMatchObject({ format: 'glb', files: [{ url: glb, bytes: 1000 }] });
    const dl = ok.f.calls.find((c) => c.url.endsWith('/download'))!;
    expect(dl.headers.authorization).toBe('Token tok');

    const zipOnly = envOf({
      [`${SKETCHFAB_API}/models/${SF_UID_1}`]: model,
      [`${SKETCHFAB_API}/models/${SF_UID_1}/download`]: json({ gltf: { url: zip, size: 900 } }),
    });
    expect(await new SketchfabProvider('tok').plan(SF_UID_1, zipOnly.env)).toMatchObject({
      format: 'gltf',
      archive: { url: zip, bytes: 900 },
      files: [],
    });

    for (const [status, code] of [
      [401, 'NEEDS_KEY'],
      [403, 'NOT_DOWNLOADABLE'],
      [500, 'UPSTREAM'],
    ] as const) {
      const e = envOf({
        [`${SKETCHFAB_API}/models/${SF_UID_1}`]: model,
        [`${SKETCHFAB_API}/models/${SF_UID_1}/download`]: () => new Response('{}', { status }),
      });
      expect(await codeOf(new SketchfabProvider('tok').plan(SF_UID_1, e.env)), String(status)).toBe(code);
    }
  });

  it('maps licence labels and slugs to SPDX ids', () => {
    expect(sketchfabLicense({ label: 'CC0 Public Domain' })).toEqual({
      spdx: 'CC0-1.0',
      url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    });
    expect(sketchfabLicense({ slug: 'by-sa', label: 'whatever' }).spdx).toBe('CC-BY-SA-4.0');
    expect(sketchfabLicense({ slug: 'st', label: 'Standard' })).toEqual({
      spdx: 'LicenseRef-Sketchfab-Standard',
      url: 'https://sketchfab.com/licenses',
    });
  });
});

describe('polypizza', () => {
  it('needs its key for everything', async () => {
    const p = new PolyPizzaProvider(null);
    expect(p.missingKey()).toBe('POLYPIZZA_API_KEY');
    expect(p.searchesWithoutKey()).toBe(false);
    const { env, f } = envOf({});
    expect(await codeOf(p.search(query('stool'), env))).toBe('NEEDS_KEY');
    expect(f.calls).toHaveLength(0);
  });

  it('searches with x-auth-token and maps licence, attribution, category and triangles', async () => {
    const { env, f } = envOf({
      [`${POLYPIZZA_API}/search/stool`]: json({
        total: 2,
        results: [polypizzaModel('abc1'), polypizzaModel('abc2')],
      }),
    });
    const page = await new PolyPizzaProvider('key1').search(query('stool'), env);
    expect(page.hits.map((h) => h.model.id)).toEqual(['polypizza:abc1', 'polypizza:abc2']);
    expect(page.hits[0].model).toMatchObject({
      category: 'furniture',
      license: { spdx: 'CC-BY-3.0', url: 'https://creativecommons.org/licenses/by/3.0/' },
      author: 'Fay Example',
      triangles: 320,
      formats: ['glb'],
      source_url: 'https://poly.pizza/m/abc1',
    });
    expect(page.hits[0].model.license.attribution).toBe(
      'Low Poly Stool abc1 by Fay Example [CC-BY] via Poly Pizza',
    );
    expect(page.end).toBeNull();
    expect(f.calls[0].headers['x-auth-token']).toBe('key1');
    expect(new URL(f.calls[0].url).searchParams.get('Limit')).toBe('24');
  });

  it('pages in pages of 24 and sends the key with downloads from its own hosts only', async () => {
    const page1 = Array.from({ length: 24 }, (_, i) => polypizzaModel(`p1x${i}`));
    const { env, f } = envOf({
      [`${POLYPIZZA_API}/search/stool`]: ({ url }) =>
        json({ total: 30, results: url.searchParams.get('Page') === '1' ? [polypizzaModel('p2a')] : page1 })({
          url,
          headers: new Headers(),
        }),
      [`${POLYPIZZA_API}/model/abc1`]: json(polypizzaModel('abc1')),
      [`${POLYPIZZA_API}/model/ext1`]: json(
        polypizzaModel('ext1', { Download: 'https://elsewhere.example.org/ext1.glb' }),
      ),
    });
    const p = new PolyPizzaProvider('key1');
    const tail = await p.search(query('stool', { offset: 22, limit: 5 }), env);
    expect(tail.hits.map((h) => h.model.id)).toEqual(['polypizza:p1x22', 'polypizza:p1x23', 'polypizza:p2a']);
    expect(tail.end).toBeNull();
    expect(f.calls.map((c) => new URL(c.url).searchParams.get('Page'))).toEqual([null, '1']);
    expect(await p.plan('abc1', env)).toMatchObject({
      format: 'glb',
      headers: { 'x-auth-token': 'key1' },
      headersHost: 'static.poly.pizza',
    });
    const ext = await p.plan('ext1', env);
    expect(ext.headers).toBeUndefined();
  });

  it('answers NEEDS_KEY when the key is refused', async () => {
    const { env } = envOf({
      [`${POLYPIZZA_API}/search/stool`]: () => new Response('{"error":"no"}', { status: 401 }),
    });
    expect(await codeOf(new PolyPizzaProvider('bad').search(query('stool'), env))).toBe('NEEDS_KEY');
  });
});

describe('catalog', () => {
  const A = 'https://models.example.org/team/catalog.json';
  const B = 'https://other.example.org/b.json';
  const catalogA = {
    version: 1,
    name: 'Studio Props',
    models: [
      {
        id: 'red-chair',
        name: 'Red chair',
        category: 'furniture',
        tags: ['chair', 'red'],
        thumbnail: 'thumbs/red-chair.png',
        license: { spdx: 'CC-BY-4.0', url: null, attribution: 'Red chair by Gil Example' },
        author: 'Gil Example',
        source_url: 'https://example.org/red-chair',
        dimensions_m: [0.5, 0.5, 0.9],
        files: { glb: 'models/red-chair.glb' },
      },
      {
        id: 'lamp',
        name: 'Paper lamp',
        files: { gltf: 'models/lamp/lamp.gltf', parts: ['lamp.bin', 'textures/paper.png'] },
      },
      {
        id: 'mapped',
        name: 'Mapped crate',
        files: { gltf: 'crate.gltf', parts: { 'crate.bin': 'https://cdn.example.org/c.bin' } },
      },
      { id: 'loose', name: 'Loose box', files: { obj: 'box/box.obj' } },
      { id: 'listed', name: 'Listed tree', downloadable: false, files: { glb: 'tree.glb' } },
      { id: 'escape', name: 'Escaping part', files: { gltf: 'e.gltf', parts: ['../secret.bin'] } },
      { id: 'bad id!', name: 'Invalid', files: { glb: 'x.glb' } },
      { id: 'nofiles', name: 'No files' },
    ],
  };

  it('parses version 1 catalogs and skips invalid models', () => {
    const c = parseCatalog(catalogA, A);
    expect(c.models.map((m) => m.model.id)).toEqual([
      'red-chair',
      'lamp',
      'mapped',
      'loose',
      'listed',
      'escape',
    ]);
    expect(c.skipped).toHaveLength(2);
    expect(() => parseCatalog({ version: 2, name: 'x', models: [] }, A)).toThrow(/version 1/);
    expect(catalogSlug('Studio Props!')).toBe('studio-props');
  });

  it('searches every catalog, resolves relative URLs and reports a failing catalog', async () => {
    const { env } = envOf({
      [A]: json(catalogA),
      [B]: () => new Response('gone', { status: 404 }),
    });
    const p = new CatalogProvider([A, B]);
    const page = await p.search(query('chair'), env);
    expect(page.hits.map((h) => h.model.id)).toEqual(['catalog:studio-props.red-chair']);
    expect(page.hits[0].model).toMatchObject({
      thumbnail_url: 'https://models.example.org/team/thumbs/red-chair.png',
      license: {
        spdx: 'CC-BY-4.0',
        url: 'https://creativecommons.org/licenses/by/4.0/',
        attribution: 'Red chair by Gil Example',
      },
      dimensions_m: [0.5, 0.5, 0.9],
      formats: ['glb'],
    });
    expect(page.note).toContain(B);
    expect(page.note).toContain('2 invalid model(s) skipped');
    const lamp = (await p.search(query('lamp'), env)).hits[0].model;
    expect(lamp.category).toBe('furniture');
    expect(lamp.license.spdx).toBe('NOASSERTION');
  });

  it('plans files relative to the catalog and the glTF, refuses listed-only models and escaping parts', async () => {
    const { env } = envOf({ [A]: json(catalogA) });
    const p = new CatalogProvider([A]);
    expect(await p.plan('studio-props.red-chair', env)).toEqual({
      format: 'glb',
      main: 'red-chair.glb',
      files: [{ path: 'red-chair.glb', url: 'https://models.example.org/team/models/red-chair.glb' }],
      discover: false,
      // the catalog's own origin: reached whatever its address, other hosts must be public
      trustedOrigin: 'https://models.example.org',
    });
    const lamp = await p.plan('studio-props.lamp', env);
    expect(lamp.files.map((f) => [f.path, f.url])).toEqual([
      ['lamp.gltf', 'https://models.example.org/team/models/lamp/lamp.gltf'],
      ['lamp.bin', 'https://models.example.org/team/models/lamp/lamp.bin'],
      ['textures/paper.png', 'https://models.example.org/team/models/lamp/textures/paper.png'],
    ]);
    expect(lamp.discover).toBe(false);
    expect((await p.plan('studio-props.mapped', env)).files[1]).toEqual({
      path: 'crate.bin',
      url: 'https://cdn.example.org/c.bin',
    });
    expect(await p.plan('studio-props.loose', env)).toMatchObject({ format: 'obj', discover: true });
    expect(await codeOf(p.plan('studio-props.listed', env))).toBe('NOT_DOWNLOADABLE');
    expect(await codeOf(p.plan('studio-props.escape', env))).toBe('UPSTREAM');
    expect(await codeOf(p.details('studio-props.nothing', env))).toBe('NOT_FOUND');
  });

  it('writes the credit a licence asks for when the catalog gives none', async () => {
    const { env } = envOf({
      [A]: json({
        version: 1,
        name: 'Studio Props',
        models: [
          {
            id: 'stool',
            name: 'Oak stool',
            author: ' Ann Example ',
            source_url: 'https://example.org/oak-stool',
            license: { spdx: 'CC BY 4.0' },
            files: { glb: 'stool.glb' },
          },
          { id: 'bare', name: 'Bare crate', files: { glb: 'crate.glb' } },
          {
            id: 'odd',
            name: 'Odd links',
            source_url: 'javascript:alert(1)',
            license: { spdx: 'CC-BY-SA-4.0', url: 'javascript:alert(2)', attribution: ' ' },
            files: { glb: 'odd.glb' },
          },
          {
            id: 'given',
            name: 'Given credit',
            license: { spdx: 'CC-BY-4.0', attribution: 'Photo scan by the Example Museum' },
            files: { glb: 'given.glb' },
          },
        ],
      }),
    });
    const p = new CatalogProvider([A]);
    const license = async (id: string) => (await p.details(`studio-props.${id}`, env)).model;
    expect((await license('stool')).license).toEqual({
      spdx: 'CC-BY-4.0',
      url: 'https://creativecommons.org/licenses/by/4.0/',
      attribution: '"Oak stool" by Ann Example (https://example.org/oak-stool), licensed under CC-BY-4.0',
    });
    expect((await license('stool')).author).toBe('Ann Example');
    expect((await license('bare')).license.attribution).toBe('"Bare crate" (model catalog Studio Props)');
    const odd = await license('odd');
    expect(odd.source_url).toBeNull();
    expect(odd.license).toEqual({
      spdx: 'CC-BY-SA-4.0',
      url: 'https://creativecommons.org/licenses/by-sa/4.0/',
      attribution: '"Odd links" (model catalog Studio Props), licensed under CC-BY-SA-4.0',
    });
    expect((await license('given')).license.attribution).toBe('Photo scan by the Example Museum');
  });

  it('fails as UPSTREAM when no catalog loads', async () => {
    const { env } = envOf({
      [A]: () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    });
    expect(await codeOf(new CatalogProvider([A]).search(query('x'), env))).toBe('UPSTREAM');
  });
});

describe('builtin', () => {
  const entry = (id: string, name: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
    id,
    name,
    category: 'furniture',
    tags: ['seat'],
    synonyms: [],
    description: `${name} for tests`,
    dimensions_m: [1, 1, 1],
    triangles: 12,
    rig: null,
    build: () => ({ root: 'r', objects: [] }),
    ...extra,
  });
  const entries = [
    entry('chair-a', 'Chair A', { params: z.object({ legs: z.number().int().describe('Legs') }) }),
    entry('chair-b', 'Chair B'),
    entry('chair-c', 'Chair C'),
  ];
  const result = (e: CatalogEntry): StoreResult => ({
    id: `builtin:${e.id}`,
    provider: 'builtin',
    name: e.name,
    category: e.category,
    tags: e.tags,
    thumbnail_url: null,
    license: { spdx: 'CC0-1.0', url: null, attribution: '3D Editor built-in' },
    author: '3D Editor built-in',
    source_url: null,
    dimensions_m: e.dimensions_m,
    triangles: e.triangles,
    formats: ['builtin'],
    downloadable: true,
  });
  const asked: unknown[] = [];
  const catalog = {
    search: (q: string, o: { offset?: number; limit?: number }) => {
      asked.push({ q, ...o });
      return entries.slice(o.offset ?? 0, (o.offset ?? 0) + (o.limit ?? 20)).map(result);
    },
    get: (id: string) => entries.find((e) => `builtin:${e.id}` === id || e.id === id) ?? null,
  };

  it('pages the core catalog (one more asked than shown tells whether a page follows)', async () => {
    const { env } = envOf({});
    const p: ModelProvider = new BuiltinProvider(catalog);
    const page = await p.search(query('chair', { limit: 2 }), env);
    expect(page.hits.map((h) => h.model.id)).toEqual(['builtin:chair-a', 'builtin:chair-b']);
    expect(page.end).toBe(2);
    expect(asked.at(-1)).toMatchObject({ q: 'chair', limit: 3, offset: 0 });
    const last = await p.search(query('chair', { offset: 2, limit: 2 }), env);
    expect(last.hits.map((h) => h.model.id)).toEqual(['builtin:chair-c']);
    expect(last.end).toBeNull();
    expect(page.hits[0].score).toBeGreaterThan(0);
  });

  it('describes a model with its parameters; nothing is downloaded', async () => {
    const { env } = envOf({});
    const p: ModelProvider = new BuiltinProvider(catalog);
    const d = await p.details('chair-a', env);
    expect(d.model.id).toBe('builtin:chair-a');
    expect(d.params).toMatchObject({ legs: { type: 'integer', description: 'Legs' } });
    expect(await codeOf(p.details('nope', env))).toBe('NOT_FOUND');
    expect(await codeOf(p.plan('chair-a', env))).toBe('INVALID_PARAMS');
    expect(await p.thumbnail('chair-a', env)).toBeNull();
  });

  it('lists the parameters of the models that take any in their search results', async () => {
    const { env } = envOf({});
    const p: ModelProvider = new BuiltinProvider(catalog);
    const page = await p.search(query('chair', { limit: 3 }), env);
    expect(page.hits[0].model.params).toMatchObject({ legs: { type: 'integer', description: 'Legs' } });
    expect(page.hits[1].model).not.toHaveProperty('params');
  });

  it("checks a model's own parameters by its schema (strict), naming what it takes", () => {
    const p = new BuiltinProvider(catalog);
    const refusal = (id: string, params: Record<string, unknown>) => {
      try {
        p.checkParams(id, params);
      } catch (err) {
        expect(err).toBeInstanceOf(ToolError);
        expect((err as ToolError).code).toBe('INVALID_PARAMS');
        return (err as ToolError).message;
      }
      return null;
    };
    expect(refusal('chair-a', { legs: 3 })).toBeNull();
    // the schema decides what is required (the catalog's models give every parameter a default)
    expect(refusal('chair-a', {})).toMatch(/^Invalid params for builtin:chair-a: legs: /);
    expect(refusal('chair-a', { legs: 2.5 })).toMatch(
      /^Invalid params for builtin:chair-a: legs: .+\. It takes: legs \(integer\): Legs$/,
    );
    expect(refusal('chair-a', { legs: 3, colour: 'red' })).toMatch(/colour/);
    expect(refusal('chair-b', { legs: 3 })).toBe('builtin:chair-b takes no params (got legs)');
    expect(refusal('chair-b', {})).toBeNull();
    expect(() => p.checkParams('nope', {})).toThrow(/No built-in model 'nope'/);
  });
});
