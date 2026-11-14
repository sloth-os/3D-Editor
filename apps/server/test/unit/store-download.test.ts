import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../../src/mcp/agent';
import {
  checkModelFile,
  contentTypeFor,
  downloadPlan,
  gltfReferences,
  mtlTextures,
  objLibraries,
  referencePath,
  type DownloadContext,
} from '../../src/store/download';
import type { DownloadPlan } from '../../src/store/providers/types';
import { bytes, cubeGlb, cubeGltf, fakeFetch, makeZip, md5, tempDir, type Route } from './store-fixtures';

/*
 * Downloading a model's files into a cache entry's directory: single files, glTF and OBJ files
 * with the files they name, announced sizes and checksums, the size cap per model, ZIP archives,
 * and paths that try to leave the model's folder.
 */

const H = 'https://files.example.org';
const enc = (s: string) => new TextEncoder().encode(s);

let dir: string;
beforeEach(async () => {
  dir = await tempDir('store-dl-');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A fresh, empty directory inside the test's directory. */
let subs = 0;
async function sub(): Promise<string> {
  const d = path.join(dir, `sub-${++subs}`);
  await mkdir(d);
  return d;
}

function ctxOf(routes: Record<string, Route>, over: Partial<DownloadContext> = {}) {
  const f = fakeFetch(routes);
  let counted = 0;
  const ctx: DownloadContext = {
    fetch: f.fetch,
    timeoutMs: 2000,
    signal: new AbortController().signal,
    what: 'test:model',
    onBytes: (n) => (counted += n),
    ...over,
  };
  return { ctx, f, counted: () => counted };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof ToolError ? `${err.code}: ${err.message}` : `other: ${String(err)}`;
  }
  return 'resolved';
}

async function listDir(d: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(d, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...(await listDir(path.join(d, e.name), `${prefix}${e.name}/`)));
    else out.push(`${prefix}${e.name}`);
  }
  return out.sort();
}

describe('downloadPlan: files', () => {
  it('downloads a GLB and checks that it is one', async () => {
    const glb = cubeGlb();
    const { ctx, counted } = ctxOf({ [`${H}/m.glb`]: bytes(glb, 'model/gltf-binary') });
    const plan: DownloadPlan = {
      format: 'glb',
      main: 'Chair.glb',
      files: [{ path: 'Chair.glb', url: `${H}/m.glb` }],
    };
    const content = await downloadPlan(plan, dir, ctx);
    expect(content.files).toEqual([
      {
        path: 'Chair.glb',
        bytes: glb.length,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        type: 'model/gltf-binary',
      },
    ]);
    expect(content.meta).toEqual({ format: 'glb', main: 'Chair.glb' });
    expect(new Uint8Array(await readFile(path.join(dir, 'Chair.glb')))).toEqual(glb);
    expect(counted()).toBe(glb.length);

    const html = ctxOf({ [`${H}/m.glb`]: bytes(enc('Sorry, try later'), 'application/octet-stream') });
    expect(await codeOf(downloadPlan(plan, await sub(), html.ctx))).toMatch(
      /^UPSTREAM: .*not a glTF 2.0 binary/,
    );
  });

  it('fetches what a glTF names, relative to it (discover)', async () => {
    const cube = cubeGltf('cube.bin', 'textures/wood%20grain.png');
    const json = JSON.parse(new TextDecoder().decode(cube.gltf));
    // a second image outside the model's folder and an embedded one
    json.images.push({ uri: '../shared/rough.png' }, { uri: 'data:image/png;base64,AAAA' });
    const gltf = enc(JSON.stringify(json));
    const { ctx, f } = ctxOf({
      [`${H}/m/glTF/Lamp.gltf`]: bytes(gltf, 'model/gltf+json'),
      [`${H}/m/glTF/cube.bin`]: bytes(cube.bin),
      [`${H}/m/glTF/textures/wood%20grain.png`]: bytes(cube.png, 'image/png'),
      [`${H}/m/shared/rough.png`]: bytes(cube.png, 'image/png'),
    });
    const content = await downloadPlan(
      {
        format: 'gltf',
        main: 'Lamp.gltf',
        files: [{ path: 'Lamp.gltf', url: `${H}/m/glTF/Lamp.gltf` }],
        discover: true,
      },
      dir,
      ctx,
    );
    expect(content.files.map((x) => [x.path, x.type])).toEqual([
      ['Lamp.gltf', 'model/gltf+json'],
      ['cube.bin', 'application/octet-stream'],
      ['textures/wood grain.png', 'image/png'],
      // outside the folder: kept by its file name (core's import finds companions by name too)
      ['rough.png', 'image/png'],
    ]);
    expect(f.calls.map((c) => c.url)).not.toContain(expect.stringContaining('data:'));
    expect(await listDir(dir)).toEqual(['Lamp.gltf', 'cube.bin', 'rough.png', 'textures/wood grain.png']);
  });

  it('fetches the files a model names from its own server only', async () => {
    const cube = cubeGltf('cube.bin', 'textures/wood.png');
    const json = JSON.parse(new TextDecoder().decode(cube.gltf));
    json.buffers[0].uri = 'http://127.0.0.1:2375/containers/json';
    const routes: Record<string, Route> = {
      [`${H}/m/Lamp.gltf`]: bytes(enc(JSON.stringify(json)), 'model/gltf+json'),
      'http://127.0.0.1:2375/containers/json': bytes(enc('[{"Id": "secret"}]')),
      [`${H}/m/cube.bin`]: bytes(cube.bin),
      [`${H}/m/textures/wood.png`]: bytes(cube.png, 'image/png'),
    };
    const plan: DownloadPlan = {
      format: 'gltf',
      main: 'Lamp.gltf',
      files: [{ path: 'Lamp.gltf', url: `${H}/m/Lamp.gltf` }],
      discover: true,
    };
    const away = ctxOf(routes);
    expect(await codeOf(downloadPlan(plan, dir, away.ctx))).toBe(
      'UPSTREAM: test:model: Lamp.gltf names a file on another server (127.0.0.1:2375); only files next to it are downloaded',
    );
    expect(away.f.count('http://127.0.0.1')).toBe(0);
    // an absolute URL on the model's own server is one of its files
    json.buffers[0].uri = `${H}/m/cube.bin`;
    const own = ctxOf({
      ...routes,
      [`${H}/m/Lamp.gltf`]: bytes(enc(JSON.stringify(json)), 'model/gltf+json'),
    });
    expect((await downloadPlan(plan, await sub(), own.ctx)).files.map((x) => x.path)).toEqual([
      'Lamp.gltf',
      'cube.bin',
      'textures/wood.png',
    ]);
    // a material library naming a texture elsewhere
    const obj = ctxOf({
      [`${H}/o/box.obj`]: bytes(enc('mtllib box.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'), 'text/plain'),
      [`${H}/o/box.mtl`]: bytes(enc('newmtl Box\nmap_Kd http://10.0.0.8/admin.png\n'), 'text/plain'),
    });
    expect(
      await codeOf(
        downloadPlan(
          {
            format: 'obj',
            main: 'box.obj',
            files: [{ path: 'box.obj', url: `${H}/o/box.obj` }],
            discover: true,
          },
          await sub(),
          obj.ctx,
        ),
      ),
    ).toMatch(/^UPSTREAM: .*box\.mtl names a file on another server \(10\.0\.0\.8\)/);
    expect(obj.f.count('http://10.0.0.8')).toBe(0);
  });

  it('keeps only the listed files the model uses, and images only when they are images', async () => {
    const cube = cubeGltf('cube.bin', 'textures/wood.png');
    const routes: Record<string, Route> = {
      [`${H}/l/lamp.gltf`]: bytes(cube.gltf, 'model/gltf+json'),
      [`${H}/l/cube.bin`]: bytes(cube.bin),
      [`${H}/l/textures/wood.png`]: bytes(cube.png, 'image/png'),
      [`${H}/l/notes.txt`]: bytes(enc('not part of the model')),
    };
    const plan: DownloadPlan = {
      format: 'gltf',
      main: 'lamp.gltf',
      files: [
        { path: 'lamp.gltf', url: `${H}/l/lamp.gltf` },
        { path: 'notes.txt', url: `${H}/l/notes.txt` },
        { path: 'cube.bin', url: `${H}/l/cube.bin` },
        { path: 'textures/wood.png', url: `${H}/l/textures/wood.png` },
      ],
    };
    const content = await downloadPlan(plan, dir, ctxOf(routes).ctx);
    expect(content.files.map((x) => x.path)).toEqual(['lamp.gltf', 'cube.bin', 'textures/wood.png']);
    expect(await listDir(dir)).toEqual(['cube.bin', 'lamp.gltf', 'textures/wood.png']);
    // a "texture" that is something else (whatever its content type says)
    const other = ctxOf({
      ...routes,
      [`${H}/l/textures/wood.png`]: bytes(enc('{"admin": true}'), 'image/png'),
    });
    expect(await codeOf(downloadPlan(plan, await sub(), other.ctx))).toBe(
      'UPSTREAM: test:model: textures/wood.png is not an image',
    );
    // an OBJ keeps its material library and the textures that names
    const png = cube.png;
    const obj = ctxOf({
      [`${H}/o/box.obj`]: bytes(enc('mtllib box.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'), 'text/plain'),
      [`${H}/o/box.mtl`]: bytes(enc('newmtl Box\nmap_Kd tex/box.png\n'), 'text/plain'),
      [`${H}/o/tex/box.png`]: bytes(png, 'image/png'),
      [`${H}/o/tex/unused.png`]: bytes(png, 'image/png'),
    });
    const objContent = await downloadPlan(
      {
        format: 'obj',
        main: 'box.obj',
        files: ['box.obj', 'tex/box.png', 'tex/unused.png', 'box.mtl'].map((p) => ({
          path: p,
          url: `${H}/o/${p}`,
        })),
      },
      await sub(),
      obj.ctx,
    );
    expect(objContent.files.map((x) => x.path)).toEqual(['box.obj', 'tex/box.png', 'box.mtl']);
  });

  it('fetches an OBJ, its material library and the textures that names', async () => {
    const obj = enc('mtllib box.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    const mtl = enc('newmtl Box\nKd 1 1 1\nmap_Kd -s 1 1 1 tex/box.png\nbump tex/box_n.png\n');
    const png = cubeGltf().png;
    const { ctx } = ctxOf({
      [`${H}/o/box.obj`]: bytes(obj, 'text/plain'),
      [`${H}/o/box.mtl`]: bytes(mtl, 'text/plain'),
      [`${H}/o/tex/box.png`]: bytes(png, 'image/png'),
      [`${H}/o/tex/box_n.png`]: bytes(png, 'image/png'),
    });
    const content = await downloadPlan(
      { format: 'obj', main: 'box.obj', files: [{ path: 'box.obj', url: `${H}/o/box.obj` }], discover: true },
      dir,
      ctx,
    );
    expect(content.files.map((x) => x.path)).toEqual(['box.obj', 'box.mtl', 'tex/box.png', 'tex/box_n.png']);
  });

  it('checks the sizes and MD5s a provider lists', async () => {
    const cube = cubeGltf();
    const routes = {
      [`${H}/a.gltf`]: bytes(cube.gltf, 'model/gltf+json'),
      [`${H}/cube.bin`]: bytes(cube.bin),
    };
    const plan = (bin: { bytes?: number; md5?: string }): DownloadPlan => ({
      format: 'gltf',
      main: 'a.gltf',
      files: [
        { path: 'a.gltf', url: `${H}/a.gltf`, bytes: cube.gltf.length, md5: md5(cube.gltf).toUpperCase() },
        { path: 'cube.bin', url: `${H}/cube.bin`, ...bin },
      ],
    });
    expect(
      (await downloadPlan(plan({ bytes: cube.bin.length, md5: md5(cube.bin) }), dir, ctxOf(routes).ctx))
        .files,
    ).toHaveLength(2);
    expect(await codeOf(downloadPlan(plan({ md5: '0'.repeat(32) }), await sub(), ctxOf(routes).ctx))).toMatch(
      /^UPSTREAM: .*cube.bin does not match the checksum/,
    );
    expect(await codeOf(downloadPlan(plan({ bytes: 3 }), await sub(), ctxOf(routes).ctx))).toMatch(
      /^UPSTREAM: .*cube.bin is not the size/,
    );
  });

  it('refuses models over the size cap as NOT_DOWNLOADABLE (announced or while downloading)', async () => {
    const glb = cubeGlb();
    const routes = { [`${H}/m.glb`]: bytes(glb, 'model/gltf-binary') };
    const announced: DownloadPlan = {
      format: 'glb',
      main: 'm.glb',
      files: [{ path: 'm.glb', url: `${H}/m.glb`, bytes: 10_000_000 }],
    };
    const r1 = ctxOf(routes, { maxBytes: 1_000_000 });
    expect(await codeOf(downloadPlan(announced, dir, r1.ctx))).toBe(
      'NOT_DOWNLOADABLE: test:model is larger than the 976.6 KB the model store downloads per model',
    );
    expect(r1.f.calls).toHaveLength(0);
    const streamed: DownloadPlan = {
      format: 'glb',
      main: 'm.glb',
      files: [{ path: 'm.glb', url: `${H}/m.glb` }],
    };
    expect(
      await codeOf(downloadPlan(streamed, dir, ctxOf(routes, { maxBytes: glb.length - 1 }).ctx)),
    ).toMatch(/^NOT_DOWNLOADABLE: /);
  });

  it('never writes outside the model folder and sends headers to their host only', async () => {
    const glb = cubeGlb();
    const escaping: DownloadPlan = {
      format: 'glb',
      main: 'x.glb',
      files: [{ path: '../x.glb', url: `${H}/x.glb` }],
    };
    expect(await codeOf(downloadPlan(escaping, dir, ctxOf({}).ctx))).toMatch(
      /^UPSTREAM: .*leaves the model's folder/,
    );

    const { ctx, f } = ctxOf({
      [`${H}/a.glb`]: bytes(glb, 'model/gltf-binary'),
      'https://cdn.example.org/b.bin': bytes(new Uint8Array(4)),
    });
    await downloadPlan(
      {
        format: 'glb',
        main: 'a.glb',
        files: [
          { path: 'a.glb', url: `${H}/a.glb` },
          { path: 'b.bin', url: 'https://cdn.example.org/b.bin' },
        ],
        headers: { 'x-auth-token': 'k' },
        headersHost: 'files.example.org',
      },
      dir,
      ctx,
    );
    expect(f.calls.map((c) => c.headers['x-auth-token'] ?? null)).toEqual(['k', null]);
  });

  it('stops when the request goes away', async () => {
    const abort = new AbortController();
    abort.abort();
    const { ctx } = ctxOf({ [`${H}/m.glb`]: bytes(cubeGlb()) }, { signal: abort.signal });
    await expect(
      downloadPlan({ format: 'glb', main: 'm.glb', files: [{ path: 'm.glb', url: `${H}/m.glb` }] }, dir, ctx),
    ).rejects.toThrow(/cancelled/);
  });
});

describe('downloadPlan: files of announced size in parallel', () => {
  const glb = cubeGlb();
  const part = (n: number) => new Uint8Array(1000).fill(n);

  /** Routes whose bodies arrive after `delayMs`, counting the downloads under way. */
  function slowRoutes(files: Record<string, Uint8Array | number>, delayMs = 25) {
    const live = { active: 0, peak: 0, aborted: 0 };
    const routes: Record<string, Route> = { [`${H}/m.glb`]: bytes(glb, 'model/gltf-binary') };
    for (const [name, body] of Object.entries(files))
      routes[`${H}/${name}`] = ({ signal }) => {
        if (typeof body === 'number') return new Response('broken', { status: body });
        live.active++;
        live.peak = Math.max(live.peak, live.active);
        let done = false;
        const finish = () => {
          if (!done) live.active--;
          done = true;
        };
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              const timer = setTimeout(() => {
                finish();
                c.enqueue(body);
                c.close();
              }, delayMs);
              signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                if (!done) live.aborted++;
                finish();
                c.error(signal.reason);
              });
            },
          }),
          { headers: { 'content-type': 'application/octet-stream' } },
        );
      };
    return { routes, live };
  }

  const planOf = (names: string[], sizes: (name: string) => number): DownloadPlan => ({
    format: 'glb',
    main: 'm.glb',
    files: [
      { path: 'm.glb', url: `${H}/m.glb` },
      ...names.map((n) => ({ path: `parts/${n}`, url: `${H}/${n}`, bytes: sizes(n) })),
    ],
  });

  it('downloads at most four at a time and lists the files in plan order', async () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const { routes, live } = slowRoutes(Object.fromEntries(names.map((n, i) => [n, part(i)])));
    const content = await downloadPlan(
      planOf(names, () => 1000),
      dir,
      ctxOf(routes).ctx,
    );
    expect(live.peak).toBe(4);
    expect(content.files.map((f) => f.path)).toEqual(['m.glb', ...names.map((n) => `parts/${n}`)]);
    expect(new Uint8Array(await readFile(path.join(dir, 'parts', 'g')))).toEqual(part(6));
  });

  it('stops the other downloads when one fails, and returns once they stopped', async () => {
    const { routes, live } = slowRoutes({ a: part(1), b: part(2), c: 500, d: part(4) }, 200);
    const err = await codeOf(
      downloadPlan(
        planOf(['a', 'b', 'c', 'd'], () => 1000),
        dir,
        ctxOf(routes).ctx,
      ),
    );
    expect(err).toMatch(/^UPSTREAM: .*HTTP 500/);
    expect(live.active).toBe(0);
    expect(live.aborted).toBeGreaterThan(0);
  });

  it('reserves announced sizes against the cap and checks each against its size', async () => {
    const { routes, live } = slowRoutes({ a: part(1), b: part(2), c: part(3) });
    // the main file and two parts fit, the third does not: refused before it starts
    const cap = glb.length + 2500;
    expect(
      await codeOf(
        downloadPlan(
          planOf(['a', 'b', 'c'], () => 1000),
          dir,
          ctxOf(routes, { maxBytes: cap }).ctx,
        ),
      ),
    ).toMatch(/^NOT_DOWNLOADABLE: /);
    expect(live.active).toBe(0);
    // a part longer than announced is stopped at its announced size
    const long = slowRoutes({ a: part(1) });
    expect(
      await codeOf(
        downloadPlan(
          planOf(['a'], () => 999),
          await sub(),
          ctxOf(long.routes).ctx,
        ),
      ),
    ).toMatch(/^UPSTREAM: .*parts\/a is not the size its provider lists/);
  });
});

describe('downloadPlan: archives', () => {
  const cube = cubeGltf('scene.bin', 'textures/base.png');
  const archive = (entries: { name: string; data: Uint8Array }[]) =>
    bytes(makeZip(entries), 'application/zip');
  const plan: DownloadPlan = { format: 'gltf', main: '', files: [], archive: { url: `${H}/m.zip` } };

  it('unpacks the main model and the files it names, relative to it', async () => {
    const { ctx } = ctxOf({
      [`${H}/m.zip`]: archive([
        { name: 'license.txt', data: enc('CC-BY') },
        { name: 'source/model.blend', data: new Uint8Array(100) },
        { name: 'scene/scene.gltf', data: cube.gltf },
        { name: 'scene/scene.bin', data: cube.bin },
        { name: 'scene/textures/base.png', data: cube.png },
        { name: 'scene/textures/unused.png', data: cube.png },
        { name: '__MACOSX/scene/._scene.gltf', data: enc('x') },
      ]),
    });
    const content = await downloadPlan(plan, dir, ctx);
    expect(content.meta).toEqual({ format: 'gltf', main: 'scene.gltf' });
    expect(content.files.map((x) => x.path)).toEqual(['scene.gltf', 'scene.bin', 'textures/base.png']);
    expect(await listDir(dir)).toEqual(['scene.bin', 'scene.gltf', 'textures/base.png']);
  });

  it('takes a GLB when the archive has no glTF, and refuses archives without a model', async () => {
    const glb = cubeGlb();
    const withGlb = ctxOf({
      [`${H}/m.zip`]: archive([
        { name: 'deep/a/b.glb', data: glb },
        { name: 'top.glb', data: glb },
      ]),
    });
    expect((await downloadPlan(plan, dir, withGlb.ctx)).meta).toEqual({ format: 'glb', main: 'top.glb' });
    const none = ctxOf({ [`${H}/m.zip`]: archive([{ name: 'readme.md', data: enc('#') }]) });
    expect(await codeOf(downloadPlan(plan, await sub(), none.ctx))).toMatch(
      /^NOT_DOWNLOADABLE: .*no glTF, GLB or OBJ/,
    );
  });

  it('maps damaged archives to UPSTREAM and oversized ones to NOT_DOWNLOADABLE', async () => {
    const damaged = ctxOf({
      [`${H}/m.zip`]: bytes(enc('PK not really a zip, just bytes that end here'), 'application/zip'),
    });
    expect(await codeOf(downloadPlan(plan, dir, damaged.ctx))).toMatch(/^UPSTREAM: test:model: ZIP archive/);
    const big = new Uint8Array(50_000).fill(65);
    const huge = ctxOf(
      {
        [`${H}/m.zip`]: archive([
          { name: 'a.gltf', data: cube.gltf },
          { name: 'scene.bin', data: big },
        ]),
      },
      { maxBytes: 20_000 },
    );
    const gltf = JSON.parse(new TextDecoder().decode(cube.gltf));
    expect(gltf.buffers[0].uri).toBe('scene.bin');
    expect(await codeOf(downloadPlan(plan, await sub(), huge.ctx))).toMatch(/^NOT_DOWNLOADABLE: /);
    const announced = ctxOf({}, { maxBytes: 100 });
    expect(
      await codeOf(downloadPlan({ ...plan, archive: { url: `${H}/m.zip`, bytes: 101 } }, dir, announced.ctx)),
    ).toMatch(/^NOT_DOWNLOADABLE: /);
    expect(announced.f.calls).toHaveLength(0);
    // the downloaded archive itself is never left in the model
    expect(existsSync(path.join(dir, '.download.zip'))).toBe(false);
  });
});

describe('helpers', () => {
  it('reads the references of glTF, OBJ and MTL files', () => {
    expect(gltfReferences(cubeGltf('a.bin', 'b.png').gltf)).toEqual(['a.bin', 'b.png']);
    expect(gltfReferences(enc('not json'))).toEqual([]);
    expect(objLibraries(enc('mtllib  a.mtl \r\nmtllib b.mtl\nv 1 2 3'))).toEqual(['a.mtl', 'b.mtl']);
    expect(mtlTextures(enc('map_Kd a.png\nmap_Bump -bm 0.5 n.png\nnorm n.png\nKd 1 1 1'))).toEqual([
      'a.png',
      'n.png',
    ]);
  });

  it('keeps referenced files inside the model', () => {
    expect(referencePath('textures/a%20b.png')).toBe('textures/a b.png');
    expect(referencePath('../../etc/passwd')).toBe('passwd');
    expect(referencePath('/abs/x.png')).toBe('x.png');
    expect(referencePath('..')).toBeNull();
    expect(referencePath('https://files.example.org/m/tex/wood%20grain.png')).toBe('wood grain.png');
  });

  it('checks main files and names content types', () => {
    expect(() => checkModelFile('gltf', enc('{"asset":{"version":"2.0"}}'), 'm')).not.toThrow();
    expect(() => checkModelFile('gltf', enc('{"no":"asset"}'), 'm')).toThrow(/not glTF JSON/);
    expect(() => checkModelFile('obj', new Uint8Array([0x76, 0, 1]), 'm')).toThrow(/not an OBJ/);
    expect(contentTypeFor('A.GLB')).toBe('model/gltf-binary');
    expect(contentTypeFor('t.jpeg')).toBe('image/jpeg');
    expect(contentTypeFor('x.bin')).toBe('application/octet-stream');
  });
});
