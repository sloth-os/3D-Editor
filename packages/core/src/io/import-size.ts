import { decodedMeshBytes } from '../mesh/memory';
import { latin1, utf8Decode } from './bytes';
import { CHUNK_JSON, GLB_MAGIC } from './glb';

/*
 * What importing a file decodes, counted from its header or JSON without decoding its geometry: an
 * upper bound of what the importers of this folder build, for the memory estimates of the server
 * (operators/memory.ts importEstimate). A glTF file is counted mesh by mesh as gltf-import.ts reads
 * it: every glTF mesh a node of the imported scene uses is decoded into a mesh of its own, so 40
 * meshes that all use the accessors of one grid decode 40 grids from the data of one. A PLY file
 * declares its element counts in its header; the corners of its faces are bounded by the bytes left
 * for them.
 */

/** A file to count: its size and a way to read a range of its bytes. */
export interface ImportReader {
  readonly byteLength: number;
  read(start: number, end: number): Uint8Array;
}

/** What an import builds. */
export interface ImportSize {
  /** Meshes it stores. */
  meshes: number;
  /** Their decoded size summed (mesh/memory.ts decodedMeshBytes). */
  decodedBytes: number;
  /**
   * Their decoded size as the project counts its stored meshes afterwards (operators/memory-objects.ts
   * storedMeshBytes: every mesh with a UV layer, without colors and loose edges).
   */
  storedBytes: number;
  /** Faces of all of them (triangles of glTF meshes). */
  faces: number;
  /** Face corners of the largest mesh: structures the importer builds for one mesh at a time. */
  largestCorners: number;
  /** Morph target vertices: every target's copy of its mesh's vertices (glTF shape keys). */
  morphVertices: number;
  /** Animation keyframes it stores (glTF: one per key of every channel component). */
  keyframes: number;
  /** Objects it adds. */
  objects: number;
  /** Other datablocks it adds. */
  materials: number;
  cameras: number;
  lights: number;
  /** Characters of the JSON text it parses (glTF; a .gltf file's whole text). */
  jsonChars: number;
  /**
   * Bytes of the embedded images it stores (glTF: those of the textures of the materials it imports,
   * from buffer views or data URIs; the importer keeps them as they are, without decoding them).
   */
  imageBytes: number;
  /**
   * Bytes of every image embedded in the file (glTF: in buffer views or data URIs), those the import
   * leaves out included: it holds the file while it runs.
   */
  fileImageBytes: number;
}

const empty = (): ImportSize => ({
  meshes: 0,
  decodedBytes: 0,
  storedBytes: 0,
  faces: 0,
  largestCorners: 0,
  morphVertices: 0,
  keyframes: 0,
  objects: 0,
  materials: 0,
  cameras: 0,
  lights: 0,
  jsonChars: 0,
  imageBytes: 0,
  fileImageBytes: 0,
});

/** Decoded bytes of a stored mesh as the project counts it (memory-objects.ts storedMeshBytes). */
const storedSize = (vertices: number, faces: number, corners: number): number =>
  decodedMeshBytes({ vertices, faces, corners, uvs: true, colors: false });

/** A reader of bytes in memory. */
export function bytesReader(data: Uint8Array): ImportReader {
  return { byteLength: data.byteLength, read: (start, end) => data.subarray(start, end) };
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** A non-negative integer index or count (null otherwise). */
const index = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

/** Geometry extensions gltf-import.ts skips primitives with. */
const GEOMETRY_COMPRESSION = [
  'KHR_draco_mesh_compression',
  'EXT_meshopt_compression',
  'KHR_meshopt_compression',
];

/**
 * What gltf-import.ts builds from glTF `json` (`jsonChars`: the characters of the JSON text it
 * parses): the nodes of the imported scene as objects (a camera or a light on a node with a mesh one
 * more), every glTF mesh one of them uses once, each primitive with the vertices of its POSITION
 * accessor (once per set of attribute accessors in a mesh, as the importer shares them) and the
 * triangles, lines and points of its indices; the morph targets as copies of the mesh's vertices;
 * the materials of these primitives; the keyframes of the animation channels.
 */
export function gltfImportSize(json: unknown, jsonChars: number): ImportSize {
  const out = empty();
  out.jsonChars = jsonChars;
  if (!isObject(json)) return out;
  const nodes = list(json.nodes);
  const meshes = list(json.meshes);
  const accessors = list(json.accessors);
  const count = (i: unknown): number => {
    const a = index(i) !== null ? accessors[i as number] : null;
    return isObject(a) ? (index(a.count) ?? 0) : 0;
  };
  // the roots of the imported scene, as gltf-import.ts picks them
  let roots: unknown[];
  const scenes = list(json.scenes);
  if (scenes.length) {
    const s = scenes[index(json.scene) ?? 0];
    roots = list(isObject(s) ? s.nodes : undefined);
    if (!roots.length && isObject(scenes[0])) roots = list(scenes[0].nodes);
  } else {
    const child = new Set<unknown>();
    for (const n of nodes) if (isObject(n)) for (const c of list(n.children)) child.add(c);
    roots = nodes.map((_, i) => i).filter((i) => !child.has(i));
  }
  const lights = list(
    isObject(json.extensions) && isObject(json.extensions.KHR_lights_punctual)
      ? json.extensions.KHR_lights_punctual.lights
      : undefined,
  );
  const cameras = list(json.cameras);
  const used = new Set<number>();
  const cameraSet = new Set<number>();
  const lightSet = new Set<number>();
  const seen = new Set<number>();
  const stack = [...roots];
  while (stack.length) {
    const ni = index(stack.pop());
    if (ni === null || seen.has(ni) || !isObject(nodes[ni])) continue;
    seen.add(ni);
    const n = nodes[ni] as Json;
    out.objects++;
    const mesh = index(n.mesh);
    const hasMesh = mesh !== null && isObject(meshes[mesh]);
    if (hasMesh) used.add(mesh);
    const camera = index(n.camera);
    const ext = isObject(n.extensions) ? n.extensions.KHR_lights_punctual : undefined;
    const light = isObject(ext) ? index(ext.light) : null;
    if (camera !== null && isObject(cameras[camera])) {
      cameraSet.add(camera);
      if (hasMesh) out.objects++;
    }
    if (light !== null && isObject(lights[light])) {
      lightSet.add(light);
      if (hasMesh || camera !== null) out.objects++;
    }
    stack.push(...list(n.children));
  }
  out.cameras = cameraSet.size;
  out.lights = lightSet.size;
  const materials = new Set<number>();
  for (const mi of used) {
    const gm = meshes[mi] as Json;
    let vertices = 0;
    let triangles = 0;
    let lines = 0;
    let uvs = false;
    let colors = false;
    let targets = 0;
    const blocks = new Set<string>();
    for (const prim of list(gm.primitives)) {
      if (!isObject(prim)) continue;
      if (isObject(prim.extensions) && GEOMETRY_COMPRESSION.some((e) => e in (prim.extensions as Json)))
        continue;
      const attrs = isObject(prim.attributes) ? prim.attributes : {};
      if (attrs.POSITION === undefined) continue;
      targets = Math.max(targets, list(prim.targets).length);
      const key = [attrs.POSITION, attrs.NORMAL, attrs.TEXCOORD_0, attrs.COLOR_0].join(':');
      const positions = count(attrs.POSITION);
      if (!blocks.has(key)) {
        blocks.add(key);
        vertices += positions;
        uvs ||= attrs.TEXCOORD_0 !== undefined;
        colors ||= attrs.COLOR_0 !== undefined;
      }
      const n = prim.indices !== undefined ? count(prim.indices) : positions;
      const mode = index(prim.mode) ?? 4;
      if (mode === 4) triangles += Math.floor(n / 3);
      else if (mode === 5 || mode === 6) triangles += Math.max(0, n - 2);
      else if (mode === 1) lines += Math.floor(n / 2);
      else if (mode === 2 || mode === 3) lines += n;
      const material = index(prim.material);
      if (material !== null) materials.add(material);
    }
    out.meshes++;
    out.faces += triangles;
    out.decodedBytes += decodedMeshBytes({
      vertices,
      faces: triangles,
      corners: 3 * triangles,
      uvs,
      colors,
      looseEdges: lines,
    });
    out.storedBytes += storedSize(vertices, triangles, 3 * triangles);
    out.largestCorners = Math.max(out.largestCorners, 3 * triangles);
    out.morphVertices += targets * vertices;
  }
  out.materials = materials.size;
  // embedded images of the textures of these materials, as gltf-import.ts reads them (each once):
  // base color, metallic-roughness, normal, emission (with an emission color) and, without
  // pbrMetallicRoughness, the specular-glossiness diffuse texture
  const textures = list(json.textures);
  const imageSet = new Set<number>();
  for (const mi of materials) {
    const m = list(json.materials)[mi];
    if (!isObject(m)) continue;
    const pbr = isObject(m.pbrMetallicRoughness) ? m.pbrMetallicRoughness : {};
    const ext = isObject(m.extensions) ? m.extensions : {};
    const sg = isObject(ext.KHR_materials_pbrSpecularGlossiness)
      ? ext.KHR_materials_pbrSpecularGlossiness
      : null;
    const emissive = list(m.emissiveFactor).some((v) => typeof v === 'number' && v > 0);
    for (const ref of [
      pbr.baseColorTexture,
      pbr.metallicRoughnessTexture,
      m.normalTexture,
      emissive ? m.emissiveTexture : undefined,
      sg && !m.pbrMetallicRoughness ? sg.diffuseTexture : undefined,
    ]) {
      const t = isObject(ref) ? index(ref.index) : null;
      const tex = t !== null ? textures[t] : undefined;
      if (!isObject(tex)) continue;
      const te = isObject(tex.extensions) ? tex.extensions : {};
      const src = [
        tex.source,
        isObject(te.EXT_texture_webp) ? te.EXT_texture_webp.source : undefined,
        isObject(te.KHR_texture_basisu) ? te.KHR_texture_basisu.source : undefined,
      ]
        .map(index)
        .find((i) => i !== null);
      if (src !== undefined && src !== null) imageSet.add(src);
    }
  }
  const images = list(json.images);
  const views = list(json.bufferViews);
  const embedded = (im: unknown): number => {
    if (!isObject(im)) return 0;
    const bv = index(im.bufferView);
    if (bv !== null) {
      const view = views[bv];
      return isObject(view) ? (index(view.byteLength) ?? 0) : 0;
    }
    return typeof im.uri === 'string' ? dataUriBytes(im.uri) : 0;
  };
  for (const ii of imageSet) out.imageBytes += embedded(images[ii]);
  for (const im of images) out.fileImageBytes += embedded(im);
  // keyframes: one per key and component of every channel targeting an imported node (weights:
  // one per morph target, as the output holds them)
  for (const anim of list(json.animations)) {
    if (!isObject(anim)) continue;
    const samplers = list(anim.samplers);
    for (const ch of list(anim.channels)) {
      if (!isObject(ch) || !isObject(ch.target) || !seen.has(index(ch.target.node) ?? -1)) continue;
      const sampler = samplers[index(ch.sampler) ?? -1];
      if (!isObject(sampler)) continue;
      const keys = count(sampler.input);
      const path = ch.target.path;
      out.keyframes +=
        path === 'weights'
          ? count(sampler.output)
          : path === 'rotation' || path === 'translation' || path === 'scale'
            ? 3 * keys
            : 0;
    }
  }
  return out;
}

/** What a data URI that {@link readGltfJson} read stands for: `data:;bytes=` and its decoded bytes. */
const DATA_URI_BYTES = 'data:;bytes=';

/**
 * Bytes a data URI decodes to: base64 (padding and whitespace aside) or percent-encoded text; a URI
 * {@link readGltfJson} replaced by its size gives that size. 0 for other URIs.
 */
export function dataUriBytes(uri: string): number {
  if (uri.startsWith(DATA_URI_BYTES)) return Number(uri.slice(DATA_URI_BYTES.length)) || 0;
  if (!uri.startsWith('data:')) return 0;
  const comma = uri.indexOf(',');
  if (comma < 0) return 0;
  if (/;base64$/i.test(uri.slice(0, comma))) {
    let chars = 0;
    for (let i = comma + 1; i < uri.length; i++) {
      const c = uri.charCodeAt(i);
      if (c > 32 && c !== 61) chars++;
    }
    return Math.floor((chars * 3) / 4);
  }
  let bytes = 0;
  for (let i = comma + 1; i < uri.length; i++, bytes++) if (uri.charCodeAt(i) === 37) i += 2;
  return bytes;
}

/**
 * The JSON of a glTF file (GLB: its JSON chunk) and its characters, read without the rest of the
 * file; null when it is not one (the import then fails by itself). Data URIs of a .gltf file are
 * replaced by their decoded size while it is parsed (`data:;bytes=` and the size): the counts need no
 * more of them.
 */
export function readGltfJson(file: ImportReader): { json: unknown; chars: number } | null {
  const parse = (text: string) => {
    try {
      return {
        json: JSON.parse(text, (key, value) =>
          key === 'uri' && typeof value === 'string' && value.startsWith('data:')
            ? `${DATA_URI_BYTES}${dataUriBytes(value)}`
            : value,
        ) as unknown,
        chars: text.length,
      };
    } catch {
      return null;
    }
  };
  const head = file.byteLength >= 20 ? file.read(0, 20) : null;
  if (head && head.byteLength >= 20) {
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (dv.getUint32(0, true) === GLB_MAGIC) {
      const length = dv.getUint32(12, true);
      if (dv.getUint32(16, true) !== CHUNK_JSON || 20 + length > file.byteLength) return null;
      return parse(utf8Decode(file.read(20, 20 + length)));
    }
  }
  return parse(utf8Decode(file.read(0, file.byteLength)));
}

/** Pieces files are read in (bytes). */
const READ_STEP = 1 << 20;

/**
 * Vertices of an OBJ file {@link objImportSize} tells apart per object (an Int32Array of 64 MB at
 * most for the scan itself; the import of a file with more takes far more than that).
 */
const OBJ_STAMPED_VERTICES = 1 << 24;

/** Bytes of a file read at increasing offsets, in pieces of 1 MB. */
class ForwardReader {
  private buf: Uint8Array = new Uint8Array(0);
  private base = 0;
  constructor(private readonly file: ImportReader) {}
  /** The byte at `offset` (-1 past the end of the file). */
  byte(offset: number): number {
    if (offset < this.base || offset >= this.base + this.buf.length) {
      if (offset >= this.file.byteLength) return -1;
      this.base = offset;
      this.buf = this.file.read(offset, Math.min(this.file.byteLength, offset + READ_STEP));
    }
    return this.buf[offset - this.base];
  }
}

/** Whitespace-separated tokens of a file from `start`, as ply.ts reads an ASCII body. */
class TokenReader {
  private buf: Uint8Array = new Uint8Array(0);
  private i = 0;
  constructor(
    private readonly file: ImportReader,
    private at: number,
  ) {}
  private byte(): number {
    if (this.i >= this.buf.length) {
      if (this.at >= this.file.byteLength) return -1;
      this.buf = this.file.read(this.at, Math.min(this.file.byteLength, this.at + READ_STEP));
      this.at += this.buf.length;
      this.i = 0;
    }
    return this.buf[this.i++];
  }
  /** The next token (null at the end of the file); `keep`: its text, else ''. */
  next(keep: boolean): string | null {
    let c = this.byte();
    while (c === 32 || c === 9 || c === 10 || c === 13) c = this.byte();
    if (c < 0) return null;
    let s = '';
    while (c >= 0 && c !== 32 && c !== 9 && c !== 10 && c !== 13) {
      if (keep) s += String.fromCharCode(c);
      c = this.byte();
    }
    return s;
  }
}

/**
 * Distinct values among those added, estimated from their 32-bit hashes (HyperLogLog with 2^14
 * registers: a standard error of 0.8 %; linear counting, nearly exact, below 40,000 values).
 */
class DistinctCount {
  private readonly registers = new Uint8Array(1 << 14);
  add(hash: number): void {
    const i = hash >>> 18;
    const rank = Math.clz32((hash << 14) | 0x2000) + 1;
    if (rank > this.registers[i]) this.registers[i] = rank;
  }
  get count(): number {
    const m = this.registers.length;
    let sum = 0;
    let zeros = 0;
    for (const r of this.registers) {
      sum += 2 ** -r;
      if (r === 0) zeros++;
    }
    const raw = ((0.7213 / (1 + 1.079 / m)) * m * m) / sum;
    return Math.round(raw <= 2.5 * m && zeros > 0 ? m * Math.log(m / zeros) : raw);
  }
}

/** One 32-bit word into a MurmurHash3 state. */
function mixWord(h: number, k: number): number {
  k = Math.imul(k, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

/** The MurmurHash3 of the words mixed into `h` (`bytes` of them). */
function finishHash(h: number, bytes: number): number {
  h ^= bytes;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Bits of a float32 as stl.ts keys it (a JavaScript number: −0 is 0, every NaN the same). */
function float32Key(bits: number): number {
  if (bits === 0x80000000) return 0;
  return (bits & 0x7f800000) === 0x7f800000 && bits & 0x7fffff ? 0x7fc00000 : bits;
}

/** What stl.ts builds of an STL file: one mesh of the file's distinct positions and its faces. */
export interface StlSize {
  /** Triangles of a binary file as stl.ts reads them (null: an ASCII file). */
  triangles: number | null;
  /** Distinct positions: the vertices of the welded mesh (estimated within about 2 %). */
  vertices: number;
  faces: number;
  corners: number;
}

/**
 * The counts of the mesh stl.ts builds of an STL file, read in pieces of 1 MB: binary or ASCII as
 * stl.ts tells them apart; the faces (binary: the triangles whose three corners differ; ASCII: the
 * loops, and stray vertices by threes) and the distinct positions the importer welds them to (the
 * positions as numbers, counted by their hashes). Positions mergeByDistance joins afterwards (closer
 * than a millionth of the model's size) are counted apart.
 */
export function stlImportSize(file: ImportReader): StlSize {
  const len = file.byteLength;
  const head = file.read(0, Math.min(len, 4096));
  let binary = len >= 84;
  if (len >= 84 && 84 + 50 * new DataView(head.buffer, head.byteOffset, 84).getUint32(80, true) !== len) {
    const text = latin1(head, 0, Math.min(head.length, 512)).trimStart();
    if (text.toLowerCase().startsWith('solid')) {
      const sample = latin1(head).toLowerCase();
      if (sample.includes('facet') || sample.includes('endsolid')) binary = false;
    }
  }
  const distinct = new DistinctCount();
  if (binary) {
    const declared = new DataView(head.buffer, head.byteOffset, 84).getUint32(80, true);
    const triangles = Math.min(declared, Math.floor((len - 84) / 50));
    const per = Math.floor(READ_STEP / 50);
    let faces = 0;
    const key = [0, 0, 0];
    for (let t0 = 0; t0 < triangles; t0 += per) {
      const n = Math.min(per, triangles - t0);
      const bytes = file.read(84 + 50 * t0, 84 + 50 * (t0 + n));
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let t = 0; t < n; t++) {
        for (let k = 0; k < 3; k++) {
          const o = 50 * t + 12 + 12 * k;
          const x = float32Key(dv.getUint32(o, true));
          const y = float32Key(dv.getUint32(o + 4, true));
          const z = float32Key(dv.getUint32(o + 8, true));
          distinct.add(finishHash(mixWord(mixWord(mixWord(0, x), y), z), 12));
          key[k] = finishHash(mixWord(mixWord(mixWord(0x9747b28c, x), y), z), 12);
        }
        if (key[0] !== key[1] && key[1] !== key[2] && key[0] !== key[2]) faces++;
      }
    }
    return { triangles, vertices: Math.min(distinct.count, 3 * faces), faces, corners: 3 * faces };
  }
  // ASCII: byte by byte, the first word of every line (`vertex`, `outer`, `endloop`, `endfacet`) and
  // the text of a vertex line's three numbers, hashed (files write equal positions alike)
  let faces = 0;
  let corners = 0;
  let loop = -1;
  let stray = 0;
  let vertices = 0;
  const first = new Uint8Array(8);
  let fl = 0;
  // 0 line start or blanks before the first word, 1 the first word, 2 blanks of a vertex line,
  // 3 a number of a vertex line, 4 the rest of another line
  let state = 0;
  let numbers = 0;
  let h = 0;
  const blank = (c: number) => c === 32 || c === 9 || c === 13 || c === 11 || c === 12;
  const is = (word: string) => {
    if (fl !== word.length) return false;
    for (let k = 0; k < fl; k++) if ((first[k] | 0x20) !== word.charCodeAt(k)) return false;
    return true;
  };
  const wordEnd = () => {
    if (is('vertex')) {
      numbers = 0;
      h = 0;
      return 2;
    }
    if (is('outer')) loop = 0;
    else if (is('endloop') || is('endfacet')) {
      if (loop > 0) {
        faces++;
        corners += loop;
      }
      loop = -1;
    }
    return 4;
  };
  const lineEnd = () => {
    if (state === 1) wordEnd();
    else if ((state === 2 || state === 3) && numbers >= 3) {
      distinct.add(finishHash(h, numbers));
      vertices++;
      if (loop >= 0) loop++;
      else stray++;
    }
    state = 0;
    fl = 0;
  };
  for (let at = 0; at < len; at += READ_STEP) {
    const bytes = file.read(at, Math.min(len, at + READ_STEP));
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      if (c === 10) {
        lineEnd();
        continue;
      }
      switch (state) {
        case 0:
          if (!blank(c)) {
            state = 1;
            first[0] = c;
            fl = 1;
          }
          break;
        case 1:
          if (blank(c)) state = wordEnd();
          else if (fl < 8) first[fl++] = c;
          else fl = 9;
          break;
        case 2:
          if (!blank(c) && numbers < 3) {
            state = 3;
            numbers++;
            h = Math.imul(h ^ 0x20, 0x01000193);
            h = Math.imul(h ^ c, 0x01000193);
          }
          break;
        case 3:
          if (blank(c)) state = 2;
          else h = Math.imul(h ^ c, 0x01000193);
          break;
      }
    }
  }
  lineEnd();
  faces += Math.floor(stray / 3);
  corners += 3 * Math.floor(stray / 3);
  return { triangles: null, vertices: Math.min(distinct.count, vertices), faces, corners };
}

/** Sizes of the PLY types (ply.ts TYPES). */
const PLY_SIZE: Readonly<Record<string, number>> = {
  char: 1,
  int8: 1,
  uchar: 1,
  uint8: 1,
  short: 2,
  int16: 2,
  ushort: 2,
  uint16: 2,
  int: 4,
  int32: 4,
  uint: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
};

interface PlyProperty {
  name: string;
  /** Bytes of the value (of every item of a list). */
  size: number;
  /** A list: the type of its count. */
  countType?: string;
}

const scratch = new DataView(new ArrayBuffer(8));

/** A number of PLY type `type` at `offset` of a binary body. */
function plyNumber(r: ForwardReader, offset: number, type: string, le: boolean): number {
  if (type === 'uchar' || type === 'uint8') return Math.max(0, r.byte(offset));
  const size = PLY_SIZE[type] ?? 4;
  const dv = scratch;
  for (let k = 0; k < size; k++) {
    const b = r.byte(offset + k);
    if (b < 0) return 0;
    dv.setUint8(k, b);
  }
  switch (type) {
    case 'char':
    case 'int8':
      return dv.getInt8(0);
    case 'uchar':
    case 'uint8':
      return dv.getUint8(0);
    case 'short':
    case 'int16':
      return dv.getInt16(0, le);
    case 'ushort':
    case 'uint16':
      return dv.getUint16(0, le);
    case 'int':
    case 'int32':
      return dv.getInt32(0, le);
    case 'float':
    case 'float32':
      return dv.getFloat32(0, le);
    case 'double':
    case 'float64':
      return dv.getFloat64(0, le);
    default:
      return dv.getUint32(0, le);
  }
}

/**
 * What ply.ts builds from a PLY file: one object with one mesh of the vertices, faces (and their
 * corners) and edges the importer reads, counted by walking the body as it does (binary: the count
 * of every list, a step over its items; ASCII: its tokens), in pieces of 1 MB; texture coordinates
 * and colors when the vertices (or faces) have them as the importer takes them. An element the body
 * ends inside counts the items before; the import then fails as truncated (a header that declares
 * 100,000,000 vertices over a body of three counts three). Null when the header has no end.
 */
export function plyImportSize(file: ImportReader): ImportSize | null {
  const probe = latin1(file.read(0, Math.min(file.byteLength, 64 * 1024)));
  const end = /end_header[ \t]*\r?\n/.exec(probe);
  if (!end) return null;
  const format = /^format\s+(\S+)/m.exec(probe.slice(0, end.index))?.[1] ?? '';
  const elements: { name: string; count: number; props: PlyProperty[] }[] = [];
  for (const line of probe.slice(0, end.index).split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'element')
      elements.push({ name: t[1] ?? '', count: Math.max(0, parseInt(t[2] ?? '', 10) || 0), props: [] });
    else if (t[0] === 'property' && elements.length) {
      const props = elements[elements.length - 1].props;
      if (t[1] === 'list')
        props.push({ name: t[4] ?? '', size: PLY_SIZE[t[3] ?? ''] ?? 4, countType: t[2] ?? '' });
      else props.push({ name: t[2] ?? '', size: PLY_SIZE[t[1] ?? ''] ?? 4 });
    }
  }
  const items = new Map<string, number>();
  let corners = 0;
  const indices = (props: PlyProperty[]) =>
    props.find((p) => p.countType && p.name === 'vertex_indices') ??
    props.find((p) => p.countType && p.name === 'vertex_index');
  const len = file.byteLength;
  if (format === 'ascii') {
    const tokens = new TokenReader(file, end.index + end[0].length);
    walk: for (const el of elements) {
      const corner = el.name === 'face' ? indices(el.props) : undefined;
      let n = 0;
      for (; n < el.count; n++) {
        let c = 0;
        for (const p of el.props) {
          const t = tokens.next(!!p.countType);
          if (t === null) break walk;
          if (!p.countType) continue;
          const v = Number(t);
          const k = Number.isFinite(v) && v > 0 ? Math.ceil(v) : 0;
          for (let j = 0; j < k; j++) if (tokens.next(false) === null) break walk;
          if (p === corner) c = k;
        }
        corners += c;
        items.set(el.name, n + 1);
      }
      if (!items.has(el.name)) items.set(el.name, 0);
    }
  } else {
    const le = format !== 'binary_big_endian';
    const r = new ForwardReader(file);
    let o = end.index + end[0].length;
    walk: for (const el of elements) {
      const corner = el.name === 'face' ? indices(el.props) : undefined;
      let n = 0;
      if (!el.props.some((p) => p.countType)) {
        const size = el.props.reduce((a, p) => a + p.size, 0);
        n = size ? Math.min(el.count, Math.floor(Math.max(0, len - o) / size)) : el.count;
        o += n * size;
      } else
        for (; n < el.count; n++) {
          // the item's properties as ply.ts reads them; the body ending inside one ends the walk
          let at = o;
          let c = 0;
          for (const p of el.props) {
            if (p.countType) {
              const cs = PLY_SIZE[p.countType] ?? 4;
              if (at + cs > len) break walk;
              const v = plyNumber(r, at, p.countType, le);
              at += cs;
              const k = v > 0 ? Math.ceil(v) : 0;
              if (at + k * p.size > len) break walk;
              at += k * p.size;
              if (p === corner) c = k;
            } else {
              if (at + p.size > len) break walk;
              at += p.size;
            }
          }
          o = at;
          corners += c;
          items.set(el.name, n + 1);
        }
      if (!items.has(el.name)) items.set(el.name, n);
      if (n < el.count) break walk;
    }
  }
  const has = (el: string, names: string[], list = false) =>
    elements.some(
      (e) => e.name === el && e.props.some((p) => !!p.countType === list && names.includes(p.name)),
    );
  const vertices = items.get('vertex') ?? 0;
  const faces = items.get('face') ?? 0;
  const edges = has('edge', ['vertex1']) && has('edge', ['vertex2']) ? (items.get('edge') ?? 0) : 0;
  const uvs =
    (has('vertex', ['s', 'u', 'texture_u', 'texture_s']) &&
      has('vertex', ['t', 'v', 'texture_v', 'texture_t'])) ||
    has('face', ['texcoord', 'texcoords'], true);
  const colors =
    has('vertex', ['red', 'r', 'diffuse_red']) &&
    has('vertex', ['green', 'g', 'diffuse_green']) &&
    has('vertex', ['blue', 'b', 'diffuse_blue']);
  const out = empty();
  out.meshes = 1;
  out.objects = 1;
  out.faces = faces;
  out.largestCorners = corners;
  out.decodedBytes = decodedMeshBytes({ vertices, faces, corners, uvs, colors, looseEdges: edges });
  out.storedBytes = storedSize(vertices, faces, corners);
  return out;
}

/** What obj.ts builds of an OBJ file, at most (see {@link objImportSize}). */
export interface ObjSize {
  /** Objects: one per `o` or `g` line, and one for geometry before the first. */
  objects: number;
  /**
   * The vertices of the meshes: per object, the `v` lines its faces, lines and points use (obj.ts gives
   * every object a copy of the vertices it uses, so one used by several objects counts for each).
   */
  vertices: number;
  /** `f` (and `fo`) lines of three corners or more, and their corners. */
  faces: number;
  corners: number;
}

/**
 * What obj.ts makes of an OBJ file, read byte by byte in pieces of 1 MB: an object for every `o` or
 * `g` line (each starts a block of its own) and one for geometry before the first, the vertices each
 * object uses (the indices of its `f`, `fo`, `l` and `p` lines, negative ones counted back from the
 * `v` lines before them, as obj.ts resolves them: a vertex used by several objects counts for each),
 * and the faces with their corners (the words of an `f` line after its first, as obj.ts splits it).
 * At most: elements obj.ts drops (faces with a bad index) count too.
 */
export function objImportSize(file: ImportReader): ObjSize {
  const out: ObjSize = { objects: 1, vertices: 0, faces: 0, corners: 0 };
  // where the scan is in the line: 0 its start, 1 blanks before its first word, 2 the first word,
  // 3 blanks of an element line, 4 a word of an element line, 5 the rest of another line
  let state = 0;
  // the first word's first two characters and length; whether blanks came before it
  let w0 = 0;
  let w1 = 0;
  let wl = 0;
  let indented = false;
  let words = 0;
  // an element line: a face (`f`, `fo`) or another (`l`, `p`)
  let face = false;
  // `v` lines so far, and the object (block) whose vertices are being counted: a vertex counts
  // for it when its stamp is not the object's number yet (vertices past OBJ_STAMPED_VERTICES count
  // at every use, more than obj.ts makes of them)
  let positions = 0;
  let object = 1;
  let stamp = new Int32Array(1024);
  // the vertex index a word of an element line starts with (parseInt's reading of it): its sign,
  // value, number of digits and whether digits may still follow
  let negative = false;
  let index = 0;
  let digits = 0;
  let reading = false;
  const blank = (c: number) => c === 32 || c === 9 || c === 13 || c === 11 || c === 12;
  /** An element word ended: the vertex it names counts for the object, once. */
  const used = () => {
    if (!digits || index === 0) return;
    const v = negative ? positions - index : index - 1;
    if (v < 0 || v >= positions) return;
    if (v < stamp.length) {
      if (stamp[v] === object) return;
      stamp[v] = object;
    }
    out.vertices++;
  };
  /** A character of an element word (the first when `first`). */
  const indexChar = (c: number, first: boolean) => {
    if (!reading) return;
    if (c >= 0x30 && c <= 0x39) {
      // past any vertex count: invalid, as obj.ts finds it
      index = Math.min(index * 10 + (c - 0x30), 2 ** 40);
      digits++;
    } else if (first && (c === 0x2d || c === 0x2b)) negative = c === 0x2d;
    else reading = false;
  };
  /** The first word ended (`c`: the character after it). */
  const word = (c: number) => {
    if (wl === 1 && w0 === 0x76) {
      if (positions === stamp.length && stamp.length < OBJ_STAMPED_VERTICES) {
        const grown = new Int32Array(stamp.length * 2);
        grown.set(stamp);
        stamp = grown;
      }
      positions++;
    }
    const f = (wl === 1 && w0 === 0x66) || (wl === 2 && w0 === 0x66 && w1 === 0x6f);
    if (f || (wl === 1 && (w0 === 0x6c || w0 === 0x70))) {
      face = f;
      words = 0;
      return 3;
    }
    if (wl === 1 && (w0 === 0x6f || w0 === 0x67)) {
      // a block of its own: the vertices count again for it
      object++;
      // `o name` or `g name`: the letter at the line's start, then a space or tab
      if (!indented && (c === 32 || c === 9)) out.objects++;
    }
    return 5;
  };
  const lineEnd = () => {
    if (state === 2) word(10);
    else if (state === 4) used();
    if ((state === 3 || state === 4) && face && words >= 3) {
      out.faces++;
      out.corners += words;
    }
    state = 0;
    wl = 0;
    indented = false;
  };
  for (let at = 0; at < file.byteLength; at += READ_STEP) {
    const bytes = file.read(at, Math.min(file.byteLength, at + READ_STEP));
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      if (c === 10) {
        lineEnd();
        continue;
      }
      switch (state) {
        case 0:
        case 1:
          if (blank(c)) {
            state = 1;
            indented = true;
          } else {
            state = 2;
            w0 = c;
            wl = 1;
          }
          break;
        case 2:
          if (blank(c)) state = word(c);
          else {
            if (wl === 1) w1 = c;
            wl++;
          }
          break;
        case 3:
          if (!blank(c)) {
            state = 4;
            words++;
            negative = false;
            index = 0;
            digits = 0;
            reading = true;
            indexChar(c, true);
          }
          break;
        case 4:
          if (blank(c)) {
            used();
            state = 3;
          } else indexChar(c, false);
          break;
      }
    }
  }
  lineEnd();
  return out;
}

/**
 * Objects obj.ts makes of an OBJ file at most: one per `o` or `g` line (each starts a block of its
 * own), and one for geometry before the first.
 */
export function objObjects(file: ImportReader): number {
  return objImportSize(file).objects;
}
