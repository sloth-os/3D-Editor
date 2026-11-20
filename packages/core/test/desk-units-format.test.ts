import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_UNIT_BODY_BYTES,
  MAX_UNIT_BYTES,
  MAX_UNIT_DEPTH,
  MAX_UNIT_HEADER_BYTES,
  MAX_UNIT_META_BYTES,
  MAX_UNIT_RECORDS,
  UNIT_CONTAINER_VERSION,
  UNIT_FORMAT,
  UNIT_KINDS,
  UNIT_VERSION,
  UnitError,
  decodeUnit,
  encodeUnit,
  encodeUnitBody,
  readUnitHeader,
  rigDigest,
  unitMeta,
  type UnitBody,
  type UnitCredit,
  type UnitHeaderInput,
} from '../src/desk/units';
import {
  CONTAINER_PREFIX_BYTES,
  UNIT_MAGIC,
  gzipDeterministic,
  sha256Hex,
  writeContainer,
} from '../src/desk/container';
import { SCHEMA_VERSION } from '../src/doc/types';

/*
 * The unit file (desk/units/format.ts): round trips, determinism, blob de-duplication, the header's
 * limits and every refusal with its code. Fixtures are hand-made bodies, independent of staging;
 * the contract's real unit file (fixtures/desk-embed/units, docs/embedding.md "The unit file") is
 * read as hosts read it.
 */

const enc = new TextEncoder();
const fill = (n: number, v: number) => new Uint8Array(n).fill(v);

/** A small prop body: a mesh with shape keys and vertex groups, a material with an image texture. */
function boxBody(): UnitBody {
  return {
    root: '@root',
    drivers: [],
    blocks: {
      objects: {
        '@root': {
          name: 'Crate',
          type: 'EMPTY',
          parent: null,
          collection: 'root',
          location: [0, 0, 0],
          rotation_euler: [0, 0, 0],
          scale: [1, 1, 1],
          material_slots: [],
          modifiers: [],
          constraints: [],
          custom_props: { store_id: 'builtin:crate', license: 'CC0-1.0' },
        },
        box0000000000000: {
          name: 'Crate Body',
          type: 'MESH',
          parent: '@root',
          data: 'mesh000000000000',
          collection: 'root',
          location: [0, 0, 0.5],
          rotation_euler: [0, 0, 0],
          scale: [1, 1, 1],
          material_slots: ['wood000000000000'],
          modifiers: [],
          constraints: [],
          custom_props: {},
        },
        lid0000000000000: {
          name: 'Crate Lid',
          type: 'MESH',
          parent: '@root',
          data: 'mesh000000000000',
          collection: 'root',
          location: [0, 0, 1],
          rotation_euler: [0, 0, 0],
          scale: [1, 1, 0.1],
          material_slots: ['wood000000000000'],
          modifiers: [],
          constraints: [],
          custom_props: {},
        },
      },
      meshes: {
        mesh000000000000: {
          name: 'Crate',
          data: fill(64, 7),
          shape_keys: [
            {
              name: 'Open',
              value: 0,
              slider_min: 0,
              slider_max: 1,
              mute: false,
              relative_key: '',
              data: fill(24, 9),
            },
          ],
          vertex_groups: [{ name: 'Top', weights: fill(8, 1) }],
        },
      },
      materials: {
        wood000000000000: {
          name: 'Wood',
          base_color: [0.4, 0.2, 0.1, 1],
          textures: { base_color: { image: 'grain00000000000', scale: [1, 1], offset: [0, 0] } },
        },
      },
      images: {
        grain00000000000: { name: 'Grain', mime: 'image/png', width: 2, height: 2, data: fill(32, 3) },
      },
    },
  };
}

function propHeader(over: Partial<UnitHeaderInput> = {}): UnitHeaderInput {
  return {
    kind: 'prop',
    name: 'Crate',
    schemaVersion: SCHEMA_VERSION,
    deskVersion: 'test',
    counts: {
      objects: 3,
      meshes: 1,
      materials: 1,
      images: 1,
      armatures: 0,
      curves: 0,
      lights: 0,
      cameras: 0,
      collections: 0,
      drivers: 0,
      vertices: 8,
      faces: 6,
      triangles: 12,
    },
    bounds: { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 1] },
    credits: [],
    prop: { label: 'Crate', dimensions: [1, 1, 1], base: 0, storeId: 'builtin:crate' },
    ...over,
  };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof UnitError ? err.code : `not a UnitError: ${String(err)}`;
  }
  return 'no error';
};

/** A file with this header object and this payload (gzipped unless `raw`). */
function file(header: unknown, body: Uint8Array, o: { raw?: boolean; version?: number } = {}) {
  return writeContainer({
    magic: UNIT_MAGIC,
    version: o.version ?? 1,
    codec: o.raw ? null : 'gzip',
    header: enc.encode(JSON.stringify(header)),
    payload: o.raw ? body : gzipDeterministic(body),
  });
}

/** The header encodeUnit would write for `body`, as a plain object (to be broken by a test). */
function fullHeader(body: UnitBody, over: Record<string, unknown> = {}) {
  const b = encodeUnitBody(body);
  return {
    ...propHeader(),
    counts: { ...propHeader().counts, blobBytes: b.blobBytes },
    format: UNIT_FORMAT,
    version: UNIT_VERSION,
    digest: sha256Hex(b.bytes),
    bodyBytes: b.bytes.length,
    ...over,
  };
}

describe('encodeUnit and decodeUnit', () => {
  it('round-trip records with nested byte arrays (mesh data, shape keys, vertex groups, images)', () => {
    const body = boxBody();
    const bytes = encodeUnit(body, propHeader());
    const back = decodeUnit(bytes);
    expect(back.body).toEqual(body);
    expect(back.header).toMatchObject({ format: UNIT_FORMAT, version: 1, kind: 'prop', name: 'Crate' });
    expect(back.header.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(back.bytes).toBe(bytes);
    const mesh = back.body.blocks.meshes!.mesh000000000000;
    expect(mesh.data).toBeInstanceOf(Uint8Array);
    expect((mesh.shape_keys as { data: Uint8Array }[])[0].data).toBeInstanceOf(Uint8Array);
    expect((mesh.vertex_groups as { weights: Uint8Array }[])[0].weights).toEqual(fill(8, 1));
  });

  it('gives the same bytes whatever order the records and their keys were built in', () => {
    const a = boxBody();
    const b = boxBody();
    // the same records built in another order
    const reorder = <T extends Record<string, unknown>>(o: T): T =>
      Object.fromEntries(Object.entries(o).reverse()) as T;
    b.blocks = reorder(b.blocks);
    b.blocks.objects = reorder(b.blocks.objects!);
    for (const [k, rec] of Object.entries(b.blocks.objects)) b.blocks.objects[k] = reorder(rec);
    expect(sha256Hex(encodeUnit(b, propHeader()))).toBe(sha256Hex(encodeUnit(a, propHeader())));
    // and so does a header given in another key order
    const h = propHeader();
    const hr = reorder(h) as UnitHeaderInput;
    expect(sha256Hex(encodeUnit(a, hr))).toBe(sha256Hex(encodeUnit(a, h)));
  });

  it('stores identical bytes once, writes a sorted header and a normalized gzip header', () => {
    const body = boxBody();
    body.blocks.images!.grain00000000000.data = fill(64, 7); // the same bytes as the mesh data
    const enc1 = encodeUnitBody(body);
    const len = new DataView(enc1.bytes.buffer).getUint32(0, true);
    const manifest = JSON.parse(new TextDecoder().decode(enc1.bytes.subarray(4, 4 + len)));
    expect(manifest.blobs).toEqual([64, 24, 8]);
    expect(enc1.blobs).toBe(3);
    expect(JSON.stringify(manifest.blocks.images.grain00000000000.data)).toBe('{"$blob":0}');
    const bytes = encodeUnit(body, propHeader());
    const hl = new DataView(bytes.buffer).getUint32(12, true);
    const headerText = new TextDecoder().decode(bytes.subarray(16, 16 + hl));
    const keys = Object.keys(JSON.parse(headerText));
    expect(keys).toEqual([...keys].sort());
    expect(readUnitHeader(bytes).counts.blobBytes).toBe(96);
    const gz = bytes.subarray(16 + hl);
    expect([...gz.subarray(0, 10)]).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]);
    expect([bytes[8], bytes[9]]).toEqual([1, 1]);
  });

  it('reads the header without unpacking the body', () => {
    const bytes = encodeUnit(boxBody(), propHeader());
    const hl = new DataView(bytes.buffer).getUint32(12, true);
    const garbage = bytes.slice();
    garbage.fill(0x5a, 16 + hl);
    expect(readUnitHeader(garbage).name).toBe('Crate');
    expect(code(() => decodeUnit(garbage))).toBe('UNIT_CORRUPT');
  });
});

describe('what a unit file is refused for', () => {
  const good = () => encodeUnit(boxBody(), propHeader());

  it('another magic or format: UNIT_NOT_A_UNIT; another container or header version: UNIT_VERSION', () => {
    const b = good();
    b[0] = 0x34;
    expect(code(() => readUnitHeader(b))).toBe('UNIT_NOT_A_UNIT');
    expect(code(() => readUnitHeader(new Uint8Array(4)))).toBe('UNIT_NOT_A_UNIT');
    const v2 = good();
    v2[8] = 2;
    expect(code(() => readUnitHeader(v2))).toBe('UNIT_VERSION');
    const body = boxBody();
    const raw = encodeUnitBody(body).bytes;
    expect(code(() => readUnitHeader(file(fullHeader(body, { format: '3d-editor.desk-state' }), raw)))).toBe(
      'UNIT_NOT_A_UNIT',
    );
    expect(code(() => readUnitHeader(file(fullHeader(body, { version: 2 }), raw)))).toBe('UNIT_VERSION');
  });

  it('a header over 64 KiB, a body over 128 MiB or a file over 32 MiB: UNIT_TOO_LARGE', () => {
    const body = boxBody();
    const raw = encodeUnitBody(body).bytes;
    const big = file({ ...fullHeader(body), pad: 'x'.repeat(MAX_UNIT_HEADER_BYTES) }, raw);
    expect(code(() => readUnitHeader(big))).toBe('UNIT_TOO_LARGE');
    expect(
      code(() => readUnitHeader(file(fullHeader(body, { bodyBytes: MAX_UNIT_BODY_BYTES + 1 }), raw))),
    ).toBe('UNIT_TOO_LARGE');
    const huge = new Uint8Array(MAX_UNIT_BYTES + 1);
    huge.set(good(), 0);
    expect(code(() => readUnitHeader(huge))).toBe('UNIT_TOO_LARGE');
    expect(code(() => decodeUnit(huge))).toBe('UNIT_TOO_LARGE');
  });

  it('a body that unpacks to more than it says, fails its digest, has two gzip members or bytes after its blobs: UNIT_CORRUPT', () => {
    const body = boxBody();
    const raw = encodeUnitBody(body).bytes;
    expect(code(() => decodeUnit(file(fullHeader(body, { bodyBytes: raw.length - 1 }), raw)))).toBe(
      'UNIT_CORRUPT',
    );
    expect(code(() => decodeUnit(file(fullHeader(body, { digest: 'b'.repeat(64) }), raw)))).toBe(
      'UNIT_CORRUPT',
    );
    const gz = gzipDeterministic(raw);
    const two = new Uint8Array(gz.length * 2);
    two.set(gz);
    two.set(gz, gz.length);
    const twoFile = writeContainer({
      magic: UNIT_MAGIC,
      version: 1,
      codec: 'gzip',
      header: enc.encode(JSON.stringify(fullHeader(body))),
      payload: two,
    });
    expect(code(() => decodeUnit(twoFile))).toBe('UNIT_CORRUPT');
    const trailing = new Uint8Array(raw.length + 3);
    trailing.set(raw);
    const h = fullHeader(body, { bodyBytes: trailing.length, digest: sha256Hex(trailing) });
    expect(code(() => decodeUnit(file(h, trailing)))).toBe('UNIT_CORRUPT');
    // cut short
    const g = good();
    expect(code(() => decodeUnit(g.subarray(0, g.length - 10)))).toBe('UNIT_CORRUPT');
    expect(code(() => decodeUnit(g.subarray(0, 20)))).toBe('UNIT_CORRUPT');
  });

  it('unknown block kinds or a newer schema: UNIT_SCHEMA_NEWER; a dangling reference: UNIT_BAD_RECORD', () => {
    const body = boxBody() as UnitBody & { blocks: Record<string, unknown> };
    (body.blocks as Record<string, unknown>).particles = { p0000000000000a: { name: 'P' } };
    const raw = encodeUnitBody(body).bytes;
    const h = fullHeader(body, { digest: sha256Hex(raw), bodyBytes: raw.length });
    expect(code(() => decodeUnit(file(h, raw)))).toBe('UNIT_SCHEMA_NEWER');
    expect(code(() => encodeUnit(body, propHeader()))).toBe('UNIT_BAD_RECORD');
    const ok = boxBody();
    const okRaw = encodeUnitBody(ok).bytes;
    expect(
      code(() => readUnitHeader(file(fullHeader(ok, { schemaVersion: SCHEMA_VERSION + 1 }), okRaw))),
    ).toBe('UNIT_SCHEMA_NEWER');
    const dangling = boxBody();
    dangling.blocks.objects!.box0000000000000.material_slots = ['gone000000000000'];
    expect(code(() => encodeUnit(dangling, propHeader()))).toBe('UNIT_BAD_RECORD');
    const dRaw = encodeUnitBody(dangling).bytes;
    const dh = fullHeader(dangling, { digest: sha256Hex(dRaw), bodyBytes: dRaw.length });
    expect(code(() => decodeUnit(file(dh, dRaw)))).toBe('UNIT_BAD_RECORD');
    // a value shaped like a blob reference cannot be written (it would read back as bytes)
    const shaped = boxBody();
    shaped.blocks.objects!['@root'].modifiers = [{ id: 'm', type: 'ARRAY', params: { $blob: 0 } }];
    expect(code(() => encodeUnit(shaped, propHeader()))).toBe('UNIT_BAD_RECORD');
    // a non-finite number cannot either
    const nan = boxBody();
    nan.blocks.objects!['@root'].location = [0, Number.NaN, 0];
    expect(code(() => encodeUnit(nan, propHeader()))).toBe('UNIT_BAD_RECORD');
  });

  it('a root that does not fit the kind: UNIT_BAD_RECORD', () => {
    const body = boxBody();
    expect(
      code(() => encodeUnit(body, { ...propHeader(), kind: 'figure', prop: undefined, figure: undefined })),
    ).toBe('UNIT_BAD_RECORD');
    delete body.blocks.objects!['@root'];
    expect(code(() => encodeUnit(body, propHeader()))).toBe('UNIT_BAD_RECORD');
  });
});

describe('decoding is the gate: what decodes, inserts', () => {
  const dec = new TextDecoder();
  /** The box's manifest text and the blob bytes after it, to break by hand. */
  function boxManifest(): { text: string; blobs: Uint8Array } {
    const raw = encodeUnitBody(boxBody()).bytes;
    const n = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true);
    return { text: dec.decode(raw.subarray(4, 4 + n)), blobs: raw.subarray(4 + n) };
  }
  /** A file whose body is manifest `text` (as given, no checks) and `blobs`, with the box's header. */
  function fromManifest(text: string, blobs: Uint8Array): Uint8Array {
    const t = enc.encode(text);
    const raw = new Uint8Array(4 + t.length + blobs.length);
    new DataView(raw.buffer).setUint32(0, t.length, true);
    raw.set(t, 4);
    raw.set(blobs, 4 + t.length);
    return file(fullHeader(boxBody(), { digest: sha256Hex(raw), bodyBytes: raw.length }), raw);
  }
  /** The box's file with the first `from` of its manifest written as `to`. */
  function edited(from: string, to: string): Uint8Array {
    const { text, blobs } = boxManifest();
    expect(text).toContain(from);
    return fromManifest(text.replace(from, to), blobs);
  }

  it('reads the box as written (the edits below are what is refused)', () => {
    const { text, blobs } = boxManifest();
    expect(code(() => decodeUnit(fromManifest(text, blobs)))).toBe('no error');
  });

  it('a number that is not finite (1e400 reads as Infinity): UNIT_BAD_RECORD', () => {
    expect(code(() => decodeUnit(edited('"location":[0,0,0.5]', '"location":[0,0,1e400]')))).toBe(
      'UNIT_BAD_RECORD',
    );
  });

  it("a record with the key '__proto__', 'constructor' or 'prototype': UNIT_BAD_RECORD", () => {
    for (const k of ['__proto__', 'constructor', 'prototype'])
      expect(
        code(() =>
          decodeUnit(edited('"custom_props":{"license"', `"custom_props":{"${k}":{"x":1},"license"`)),
        ),
        k,
      ).toBe('UNIT_BAD_RECORD');
  });

  it(`nesting deeper than ${MAX_UNIT_DEPTH}: UNIT_CORRUPT (not a stack overflow), however deep`, () => {
    const nest = (n: number) => '['.repeat(n) + ']'.repeat(n);
    const at = (n: number) =>
      edited('"custom_props":{"license"', `"custom_props":{"deep":${nest(n)},"license"`);
    expect(code(() => decodeUnit(at(10)))).toBe('no error');
    expect(code(() => decodeUnit(at(MAX_UNIT_DEPTH)))).toBe('UNIT_CORRUPT');
    expect(code(() => decodeUnit(at(10_000)))).toBe('UNIT_CORRUPT');
  });

  /** A driver's JSON: on the box's root, its location z, unless `o` says otherwise. */
  const drv = (o: Record<string, unknown> = {}) =>
    JSON.stringify({
      expression: '1',
      index: 2,
      mute: false,
      path: 'location',
      target_id: '@root',
      target_type: 'object',
      variables: [],
      ...o,
    });

  it("a driver that drives the world or the scene: UNIT_BAD_RECORD; one that only reads them is the unit's", () => {
    const one = (d: string) => code(() => decodeUnit(edited('"drivers":[]', `"drivers":[${d}]`)));
    expect(one(drv({ target_type: 'world', target_id: '', path: 'strength', index: 0 }))).toBe(
      'UNIT_BAD_RECORD',
    );
    expect(one(drv({ target_type: 'scene', target_id: '', path: 'frame_end', index: 0 }))).toBe(
      'UNIT_BAD_RECORD',
    );
    const reads = { name: 'f', target_type: 'scene', target_id: '', path: 'frame_end', index: 0 };
    expect(one(drv({ variables: [reads] }))).toBe('no error');
    // a target outside the unit is refused as before
    expect(one(drv({ target_id: 'elsewhere0000000' }))).toBe('UNIT_BAD_RECORD');
  });

  it(`drivers count toward the ${MAX_UNIT_RECORDS} records: one over is UNIT_TOO_LARGE`, () => {
    const body = boxBody();
    const records = Object.values(body.blocks).reduce((n, m) => n + Object.keys(m ?? {}).length, 0);
    const many = (n: number) =>
      edited(
        '"drivers":[]',
        `"drivers":[${Array.from({ length: n }, (_, i) => drv({ index: i })).join(',')}]`,
      );
    expect(code(() => decodeUnit(many(MAX_UNIT_RECORDS - records)))).toBe('no error');
    expect(code(() => decodeUnit(many(MAX_UNIT_RECORDS - records + 1)))).toBe('UNIT_TOO_LARGE');
  });

  it('counts blob references as written out: a 1 MiB blob referred to 200 times is UNIT_TOO_LARGE', () => {
    const big = fill(2 ** 20, 5);
    /** The box with a 1 MiB blob that its root's custom prop `big` refers to `n` times. */
    const referred = (n: number) => {
      const { text, blobs } = boxManifest();
      const table = /"blobs":\[([0-9,]+)\]/.exec(text)!;
      const k = table[1].split(',').length;
      const refs = Array.from({ length: n }, () => `{"$blob":${k}}`).join(',');
      const all = new Uint8Array(blobs.length + big.length);
      all.set(blobs);
      all.set(big, blobs.length);
      const t = text
        .replace(table[0], `"blobs":[${table[1]},${big.length}]`)
        .replace('"custom_props":{"license"', `"custom_props":{"big":[${refs}],"license"`);
      return fromManifest(t, all);
    };
    // each blob referred to once: what inserting it copies is its body
    const once = decodeUnit(referred(1));
    expect(once.expandedBytes).toBe(once.header.bodyBytes);
    const many = decodeUnit(referred(100));
    expect(many.expandedBytes).toBe(many.header.bodyBytes + 99 * big.length);
    expect(code(() => decodeUnit(referred(200)))).toBe('UNIT_TOO_LARGE');
  });

  it('writes no unit whose blob references written out pass the body limit (UNIT_TOO_LARGE)', () => {
    const body = boxBody();
    const big = fill(2 ** 20, 5);
    const root = body.blocks.objects!['@root'];
    root.custom_props = { ...(root.custom_props as object), big: Array.from({ length: 129 }, () => big) };
    expect(code(() => encodeUnit(body, propHeader()))).toBe('UNIT_TOO_LARGE');
    root.custom_props = { ...(root.custom_props as object), big: Array.from({ length: 3 }, () => big) };
    const u = decodeUnit(encodeUnit(body, propHeader()));
    expect(u.expandedBytes).toBe(u.header.bodyBytes + 2 * big.length);
    // 2.5 s beside core's suite; under coverage, as CI runs the suites, 19 s, and 36 s beside core's
    // suite: past the project's 30 s
  }, 120_000);

  it("an id named like a member of Object.prototype ('valueOf', 'constructor') names nothing: UNIT_BAD_RECORD", () => {
    expect(code(() => decodeUnit(edited('"parent":"@root"', '"parent":"valueOf"')))).toBe('UNIT_BAD_RECORD');
    expect(
      code(() =>
        decodeUnit(
          edited('"constraints":[]', '"constraints":[{"target":"constructor","type":"COPY_LOCATION"}]'),
        ),
      ),
    ).toBe('UNIT_BAD_RECORD');
  });
});

describe("the header's limits", () => {
  const credit = (i: number, n = 10): UnitCredit => ({
    name: `Model ${i} ${'n'.repeat(n)}`.slice(0, 120),
    storeId: `store:${i}`,
    source: 'store',
    license: 'CC-BY-4.0',
    author: `Author ${i}`,
    sourceUrl: null,
    objects: 1,
  });

  it('a name of at most 120 characters and at most 64 credits (UNIT_BAD_SPEC)', () => {
    expect(code(() => encodeUnit(boxBody(), propHeader({ name: 'x'.repeat(120) })))).toBe('no error');
    expect(code(() => encodeUnit(boxBody(), propHeader({ name: 'x'.repeat(121) })))).toBe('UNIT_BAD_SPEC');
    expect(code(() => encodeUnit(boxBody(), propHeader({ name: '' })))).toBe('UNIT_BAD_SPEC');
    const c64 = Array.from({ length: 64 }, (_, i) => credit(i));
    expect(code(() => encodeUnit(boxBody(), propHeader({ credits: c64 })))).toBe('no error');
    expect(code(() => encodeUnit(boxBody(), propHeader({ credits: [...c64, credit(64)] })))).toBe(
      'UNIT_BAD_SPEC',
    );
    expect(code(() => encodeUnit(boxBody(), { ...propHeader(), extra: 1 } as UnitHeaderInput))).toBe(
      'UNIT_BAD_SPEC',
    );
  });

  it('a header over 64 KiB is refused with UNIT_TOO_LARGE before anything is written', () => {
    const long = Array.from({ length: 64 }, (_, i) => ({
      ...credit(i, 110),
      storeId: `store:${i}:${'s'.repeat(190)}`.slice(0, 200),
      author: 'a'.repeat(200),
      sourceUrl: `https://example.org/${'u'.repeat(480)}`,
    }));
    const landmarks = Array.from({ length: 128 }, (_, i) => ({
      label: `${i} ${'l'.repeat(95)}`.slice(0, 100),
      role: 'dressing' as const,
      x: i,
      y: i,
      width: 1,
      depth: 1,
      height: 1,
      rotationDeg: 0,
      water: false,
    }));
    const body = boxBody();
    body.blocks.objects!['@root'].type = 'EMPTY';
    const header = propHeader({ credits: long });
    expect(code(() => encodeUnit(body, header))).toBe('UNIT_TOO_LARGE');
    const setBody = boxBody();
    const setHeader: UnitHeaderInput = {
      ...propHeader({ kind: 'set', prop: undefined, credits: long }),
      set: { width: 20, depth: 10, interior: false, hasGround: false, groundZ: 0, lights: 0, landmarks },
    };
    expect(code(() => encodeUnit(setBody, setHeader))).toBe('UNIT_TOO_LARGE');
  });
});

describe('unitMeta', () => {
  it('is exactly the protocol meta, with the figure, counts and size', () => {
    const bytes = encodeUnit(
      boxBody(),
      propHeader({
        credits: [
          {
            name: 'Crate',
            storeId: 'builtin:crate',
            source: 'builtin',
            license: 'CC0-1.0',
            author: null,
            sourceUrl: null,
            objects: 1,
          },
        ],
      }),
    );
    const h = readUnitHeader(bytes);
    const meta = unitMeta(h, bytes);
    expect(Object.keys(meta).sort()).toEqual([
      'actor',
      'credits',
      'deskVersion',
      'digest',
      'dimensionsM',
      'objects',
      'triangles',
    ]);
    expect(meta).toEqual({
      dimensionsM: [1, 1, 1],
      objects: 3,
      triangles: 12,
      actor: null,
      credits: [{ name: 'Crate', author: null, license: 'CC0-1.0' }],
      deskVersion: 'test',
      digest: h.digest,
    });
    const other = encodeUnit(boxBody(), propHeader({ name: 'Other' }));
    expect(code(() => unitMeta(h, other))).toBe('UNIT_BAD_SPEC');
  });

  it("gives a set's size as its stage and the height of its bounds, whatever stands beyond the stage", () => {
    const setMeta = (bounds: UnitHeaderInput['bounds']) => {
      const bytes = encodeUnit(boxBody(), {
        ...propHeader({ kind: 'set', prop: undefined, bounds }),
        set: { width: 12, depth: 10, interior: true, hasGround: true, groundZ: 0, lights: 0, landmarks: [] },
      });
      return unitMeta(readUnitHeader(bytes), bytes).dimensionsM;
    };
    expect(setMeta({ min: [-6, -5, 0], max: [6, 5, 3.2] })).toEqual([12, 10, 3.2]);
    // a lighthouse beyond the stage's edge and a pit below its floor
    expect(setMeta({ min: [-6, -5, -1.5], max: [21, 5, 18.25] })).toEqual([12, 10, 19.75]);
    expect(setMeta(null)).toEqual([12, 10, 0]);
  });

  it('keeps at most 32 credits in at most 16 KiB, leaving out the longest first, with a warning', () => {
    const credits: UnitCredit[] = Array.from({ length: 64 }, (_, i) => ({
      name: `Model ${String(i).padStart(2, '0')} ${'n'.repeat(i % 7 === 0 ? 100 : 5)}`.slice(0, 120),
      storeId: `store:${i}`,
      source: 'store',
      license: 'CC-BY-4.0',
      author: i % 3 === 0 ? 'a'.repeat(200) : 'b',
      sourceUrl: null,
      objects: 1,
    }));
    const bytes = encodeUnit(boxBody(), propHeader({ credits }));
    const warnings: string[] = [];
    const meta = unitMeta(readUnitHeader(bytes), bytes, warnings);
    expect(meta.credits.length).toBe(32);
    expect(new TextEncoder().encode(JSON.stringify(meta)).length).toBeLessThanOrEqual(MAX_UNIT_META_BYTES);
    // the 32 kept are the shortest: none of the long-author ones survives while a short one was dropped
    const kept = new Set(meta.credits.map((c) => c.name));
    const len = (c: UnitCredit) =>
      JSON.stringify({ name: c.name, author: c.author, license: c.license }).length;
    const keptMax = Math.max(...credits.filter((c) => kept.has(c.name)).map(len));
    const droppedMin = Math.min(...credits.filter((c) => !kept.has(c.name)).map(len));
    expect(keptMax).toBeLessThanOrEqual(droppedMin);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^32 of the unit's 64 credits were left out/);
    // within the limits nothing is dropped or said
    const few = encodeUnit(boxBody(), propHeader({ credits: credits.slice(1, 5) }));
    const quiet: string[] = [];
    expect(unitMeta(readUnitHeader(few), few, quiet).credits).toHaveLength(4);
    expect(quiet).toEqual([]);
  });
});

describe('rigDigest', () => {
  it('is the SHA-256 of the bone names in order', () => {
    const a = rigDigest(['root', 'spine', 'head']);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(rigDigest(['root', 'spine', 'head'])).toBe(a);
    expect(rigDigest(['root', 'head', 'spine'])).not.toBe(a);
    expect(a).toBe(sha256Hex(enc.encode('["root","spine","head"]')));
  });

  it('kinds and format are the protocol constants', () => {
    expect([...UNIT_KINDS]).toEqual(['set', 'prop', 'figure']);
    expect(UNIT_FORMAT).toBe('3d-editor.desk-unit');
    expect(UNIT_VERSION).toBe(1);
    expect(MAX_UNIT_BYTES).toBe(33554432);
  });
});

describe("the contract's unit file (fixtures/desk-embed/units/unit-file-prop.json)", () => {
  /** A unit file core wrote (the example brief's red kite), as hosts keep it: {"$bytes": base64}. */
  const file = (): Uint8Array => {
    const json = readFileSync(resolve(__dirname, 'fixtures/desk-embed/units/unit-file-prop.json'), 'utf8');
    return new Uint8Array(Buffer.from((JSON.parse(json) as { $bytes: string }).$bytes, 'base64'));
  };

  it('is laid out as docs/embedding.md says: the prefix, then a JSON header a host reads alone', () => {
    const bytes = file();
    expect(bytes.subarray(0, 8)).toEqual(UNIT_MAGIC);
    expect(bytes[8]).toBe(UNIT_CONTAINER_VERSION);
    expect([0, 1]).toContain(bytes[9]);
    expect([bytes[10], bytes[11]]).toEqual([0, 0]);
    const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true);
    expect(n).toBeLessThanOrEqual(MAX_UNIT_HEADER_BYTES);
    const header = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(CONTAINER_PREFIX_BYTES, CONTAINER_PREFIX_BYTES + n),
      ),
    );
    expect(header).toMatchObject({
      format: UNIT_FORMAT,
      version: UNIT_VERSION,
      kind: 'prop',
      name: 'Red kite',
    });
  });

  it('reads and decodes in core: its header and body agree', () => {
    const bytes = file();
    const header = readUnitHeader(bytes);
    expect(header).toMatchObject({ format: UNIT_FORMAT, version: 1, kind: 'prop', name: 'Red kite' });
    const unit = decodeUnit(bytes);
    expect(unit.header).toEqual(header);
    expect(Object.keys(unit.body.blocks.objects!)).toHaveLength(header.counts.objects);
    expect(unit.body.blocks.objects!['@root']).toMatchObject({ name: 'Red kite' });
  });
});
