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
}

const empty = (): ImportSize => ({
  meshes: 0,
  decodedBytes: 0,
  faces: 0,
  largestCorners: 0,
  morphVertices: 0,
  keyframes: 0,
  objects: 0,
  materials: 0,
  cameras: 0,
  lights: 0,
  jsonChars: 0,
});

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
    out.largestCorners = Math.max(out.largestCorners, 3 * triangles);
    out.morphVertices += targets * vertices;
  }
  out.materials = materials.size;
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

/**
 * The JSON of a glTF file (GLB: its JSON chunk) and its characters, read without the rest of the
 * file; null when it is not one (the import then fails by itself). Data URIs of a .gltf file are
 * dropped while it is parsed: the counts do not need them.
 */
export function readGltfJson(file: ImportReader): { json: unknown; chars: number } | null {
  const parse = (text: string) => {
    try {
      return {
        json: JSON.parse(text, (key, value) =>
          key === 'uri' && typeof value === 'string' && value.startsWith('data:') ? '' : value,
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

/** Property names of a PLY vertex that ply.ts imports as texture coordinates or colors. */
const PLY_UV = new Set(['s', 't', 'u', 'v', 'texture_u', 'texture_v', 'texture_s', 'texture_t']);
const PLY_COLOR = new Set([
  'red',
  'green',
  'blue',
  'r',
  'g',
  'b',
  'diffuse_red',
  'diffuse_green',
  'diffuse_blue',
]);
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

/**
 * What ply.ts builds from a PLY file, from the element counts its header declares: one object with
 * one mesh of the declared vertices, faces and edges; texture coordinates and colors when the
 * vertices (or faces) have them. The corners of the faces are bounded by the bytes after the header:
 * in a binary file every corner takes an index, in an ASCII file at least two characters, after the
 * vertices and the face's own count. Null when the header has no end.
 */
export function plyImportSize(file: ImportReader): ImportSize | null {
  const head = latin1(
    file.read(0, Math.min(file.byteLength, 64 * 1024)),
    0,
    Math.min(file.byteLength, 64 * 1024),
  );
  const end = /end_header\r?\n/.exec(head);
  if (!end) return null;
  const headerBytes = end.index + end[0].length;
  const ascii = /^format\s+ascii/m.test(head);
  let vertices = 0;
  let faces = 0;
  let edges = 0;
  let uvs = false;
  let colors = false;
  let element = '';
  let vertexBytes = 0;
  let vertexProps = 0;
  let countBytes = 1;
  let indexBytes = 4;
  for (const line of head.slice(0, end.index).split(/\r?\n/)) {
    const w = line.trim().split(/\s+/);
    if (w[0] === 'element') {
      element = w[1] ?? '';
      const n = Math.max(0, Number(w[2]) || 0);
      if (element === 'vertex') vertices = n;
      else if (element === 'face') faces = n;
      else if (element === 'edge') edges = n;
    } else if (w[0] === 'property') {
      if (element === 'vertex' && w[1] !== 'list') {
        vertexBytes += PLY_SIZE[w[1] ?? ''] ?? 4;
        vertexProps++;
        if (PLY_UV.has(w[2] ?? '')) uvs = true;
        if (PLY_COLOR.has(w[2] ?? '')) colors = true;
      } else if (element === 'face' && w[1] === 'list') {
        if (w[4] === 'vertex_indices' || w[4] === 'vertex_index') {
          countBytes = PLY_SIZE[w[2] ?? ''] ?? 1;
          indexBytes = PLY_SIZE[w[3] ?? ''] ?? 4;
        } else if (/tex/.test(w[4] ?? '')) uvs = true;
      }
    }
  }
  const body = Math.max(0, file.byteLength - headerBytes);
  const corners = ascii
    ? Math.max(0, Math.floor((body - 2 * vertexProps * vertices) / 2) - faces)
    : Math.max(0, Math.floor((body - vertexBytes * vertices - countBytes * faces) / indexBytes));
  const out = empty();
  out.meshes = 1;
  out.objects = 1;
  out.faces = faces;
  out.largestCorners = corners;
  out.decodedBytes = decodedMeshBytes({ vertices, faces, corners, uvs, colors, looseEdges: edges });
  return out;
}

/**
 * Objects obj.ts makes of an OBJ file at most: one per `o` or `g` line (each starts a block of its
 * own), and one for geometry before the first; read in pieces of 1 MB.
 */
export function objObjects(file: ImportReader): number {
  let objects = 1;
  let prev = 0x0a;
  let prev2 = 0x0a;
  const STEP = 1 << 20;
  for (let start = 0; start < file.byteLength; start += STEP) {
    const bytes = file.read(start, Math.min(file.byteLength, start + STEP));
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      // a line `o name` or `g name`: the letter after a line break, then a space or tab
      if (
        (c === 0x20 || c === 0x09) &&
        (prev === 0x6f || prev === 0x67) &&
        (prev2 === 0x0a || prev2 === 0x0d)
      )
        objects++;
      prev2 = prev;
      prev = c;
    }
  }
  return objects;
}
