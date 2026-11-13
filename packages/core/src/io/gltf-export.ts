import type { Mat4, Quat, Vec3, Vec4 } from '../math/types';
import { compose4, determinant4, multiply4 } from '../math/mat4';
import { normalizeQuat, quatFromEuler } from '../math/quat';
import type { SceneDoc } from '../doc/scene-doc';
import type {
  CameraData,
  LightData,
  MaterialData,
  ModifierData,
  ObjectData,
  ShapeKeyData,
  TextureSlot,
} from '../doc/types';
import { cameraFovY, orthoHalfExtents } from '../eval/camera';
import { SceneEvaluator, type EvaluatedObject, type EvaluatedScene } from '../eval/evaluate';
import { FrameState } from '../eval/frame-state';
import type { MeshData } from '../mesh/types';
import { buildRenderBuffers, type RenderBuffers } from '../mesh/render-buffers';
import { decodeFloat32 } from '../mesh/shape-keys';
import { smartProject } from '../mesh/uv';
import { emptySelection } from '../mesh/selection';
import { getModifierDef, isModifierEnabled, isModifierTimeDependent } from '../modifiers/registry';
import { boneEnvelopeWeight, deformBones } from '../armature/skinning';
import { quatFromRotationMatrix } from '../armature/bone-math';
import type { PoseBoneMatrix } from '../armature/types';
import { invertAffine } from '../instancing/matrix';
import { base64Encode, stableStringify } from '../util/json';
import { M_Y_TO_Z, M_Z_TO_Y, trsToYUp, type TRS } from './axes';
import { utf8Encode } from './bytes';
import { collectExport, type ExportItem } from './common';
import { writeGLB } from './glb';
import {
  GL,
  TYPE_COMPONENTS,
  type GltfAccessor,
  type GltfAnimation,
  type GltfCamera,
  type GltfLight,
  type GltfMaterial,
  type GltfMesh,
  type GltfNode,
  type GltfPrimitive,
  type GltfRoot,
  type GltfSkin,
  type GltfTextureInfo,
} from './gltf-types';
import { sniffImageMime } from './image-info';
import type { ExportOptions, ExportResult } from './types';
import {
  bakeGeometryKey,
  bakeMaterialTextures,
  proceduralBakeNeedsGeometry,
  uvOverlapFraction,
  type BakeGeometry,
} from './bake-procedural';
import { hasProceduralTextures, proceduralSurface } from '../material/surface';
import { evaluatedOrco } from '../material/orco';
import { meshBounds } from '../mesh/types';
import { encodePNG, type PNGImage } from '../render/png';

/*
 * glTF 2.0 export (.glb binary container or .gltf with an embedded base64 buffer).
 *
 * - Axes: Z-up → Y-up per node (see axes.ts); mesh data is converted with its node.
 * - Hierarchy: only exported objects become nodes; an exported object whose parent is not exported
 *   becomes a root node carrying its world transform. Armatures get a node per bone (children of the
 *   armature node, in the bone hierarchy) and BONE-parented objects are children of their bone's
 *   node. Node transforms are computed from the evaluated world matrices (parenting to bones,
 *   constraints, drivers, rigid body simulation), relative to the exported parent node; a local
 *   transform with shear (non-uniform parent scale) is written as a matrix.
 * - Meshes: one primitive per material group (shared vertex attributes), TEXCOORD_0 with V flipped,
 *   loose edges as an extra LINES primitive. Vertex data is shared by every glTF mesh that uses the
 *   same geometry (linked duplicates with different materials only differ in their primitives'
 *   materials).
 * - Deformation:
 *   - shape keys of a mesh without modifiers → morph targets (POSITION and NORMAL deltas) with the
 *     key values as default weights (extras.targetNames holds the key names);
 *   - a mesh whose only modifier is an Armature modifier on an exported armature (without Apply
 *     Modifiers: whose first enabled Armature modifier uses an exported armature; the other
 *     modifiers are left out like every modifier then) → a glTF skin:
 *     joints = the deform bones' nodes, inverse bind matrices from the rest pose, JOINTS_0 and
 *     WEIGHTS_0 from the vertex groups (or bone envelopes; at most 4 influences per vertex). The
 *     mesh node is a root node with an identity transform and its vertices are the rest-pose mesh
 *     in world space (glTF ignores the transform of skinned mesh nodes); shape keys become morph
 *     targets applied before the skin, as in Blender;
 *   - any other deformation that changes over the animation (modifier stacks, deformed curves …)
 *     is baked: one morph target per sampled frame, blended by an animated weights channel.
 * - Lights (KHR_lights_punctual): point/spot intensity in candela = W / (4π) (the "unitless"
 *   convention used by Blender's compatibility mode); sun intensity = strength (lux, W/m² as-is);
 *   spot cone angles from spot_size/spot_blend; area lights become point lights (with a warning).
 * - Animation: the evaluated scene is sampled once per frame over the scene frame range at the
 *   scene fps (LINEAR): node translation/rotation/scale wherever an object's or a bone's transform
 *   relative to its exported parent changes (keyframes, drivers, constraints, IK, physics …;
 *   rotations as normalized, sign-continuous quaternions) and morph target weights (shape key values,
 *   baked deformation). Where a node's motion bends between frames, so its linearly interpolated
 *   keys would cut chords (an object a constraint keeps on a fast orbit, keyed in world space), it
 *   gets keys between those frames (2 or 4 per frame): candidate intervals come from the per-frame
 *   keys (`chordErrors`), and the scene is sampled at their mid-frames to tell curves from motion
 *   that is straight between frames (LINEAR keys, rigid bodies), which keeps one key per frame; a
 *   warning names nodes still off by more than the tolerance. Animated camera, light and material
 *   properties and the world are not exported (they would need KHR_animation_pointer; glTF has no
 *   world): a warning names the properties whose values change over the frame range, and the file
 *   keeps the export frame's.
 * - Procedural texture slots are baked to PNG images in UV space (bake-procedural.ts), sized per
 *   mesh by its surface area (`bakeResolution` overrides); materials whose bake depends on the
 *   geometry (GENERATED/OBJECT mapping, bump) get one glTF material per distinct mesh content
 *   (identical meshes share one bake), named Name, Name.001 … with a warning. A mesh without UVs, or
 *   with overlapping UVs (`uvOverlapFraction`), whose material has GENERATED/OBJECT-mapped procedural
 *   textures gets generated UVs (Smart UV Project) to bake them into, unless image textures or
 *   UV-mapped procedurals need its UVs (then a warning says the bake is wrong where faces overlap).
 * - Materials: Principled values as pbrMetallicRoughness plus KHR_materials_emissive_strength,
 *   _transmission, _ior, _clearcoat and _sheen (colour = tint × weight, roughness 0.5).
 */

class BinBuilder {
  private parts: Uint8Array[] = [];
  length = 0;

  /** Appends bytes at a 4-byte aligned offset; returns the offset. */
  add(bytes: Uint8Array): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    const offset = this.length;
    this.parts.push(bytes);
    this.length += bytes.length;
    return offset;
  }

  finish(): Uint8Array {
    const total = (this.length + 3) & ~3;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

function isDefault(v: readonly number[], d: readonly number[], eps = 1e-9): boolean {
  return v.every((x, i) => Math.abs(x - d[i]) <= eps);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Cameras and lights keep their native local frame; everything else uses a converted frame. */
function convertedFrame(ev: EvaluatedObject): boolean {
  return !((ev.type === 'CAMERA' && ev.camera) || (ev.type === 'LIGHT' && ev.light));
}

function trsFromObject(o: Pick<ObjectData, 'location' | 'rotation_euler' | 'scale'>): TRS {
  return { t: [...o.location] as Vec3, q: quatFromEuler(o.rotation_euler), s: [...o.scale] as Vec3 };
}

/**
 * Node transform of a matrix: TRS, and whether TRS reproduces it (false with shear: then the
 * rotation is the one closest to the sheared axes, the best a TRS animation channel can do).
 */
function trsOfMatrix(m: Readonly<Mat4>): TRS & { exact: boolean } {
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  if (determinant4(m) < 0) sx = -sx;
  const r: Mat4 = [...IDENTITY];
  if (sx !== 0 && sy !== 0 && sz !== 0) {
    for (let k = 0; k < 3; k++) {
      r[k] = m[k] / sx;
      r[4 + k] = m[4 + k] / sy;
      r[8 + k] = m[8 + k] / sz;
    }
  }
  let q = quatFromRotationMatrix(r);
  const t: Vec3 = [m[12], m[13], m[14]];
  const s: Vec3 = [sx, sy, sz];
  const back = composeQuat(t, q, s);
  const tol = 1e-5 * Math.max(1, Math.abs(sx), Math.abs(sy), Math.abs(sz));
  let exact = q.every(Number.isFinite);
  for (let i = 0; i < 12 && exact; i++) if (Math.abs(back[i] - m[i]) > tol) exact = false;
  if (!exact) {
    const c = closestRotation(r);
    q = c ? normalizeQuat(quatFromRotationMatrix(c)) : [0, 0, 0, 1];
    if (!q.every(Number.isFinite)) q = [0, 0, 0, 1];
  }
  return { t, q, s, exact };
}

/**
 * The rotation closest to the (unit-column, positive-determinant) linear part of `r`: its polar
 * decomposition, by Newton iteration R ← (R + R⁻ᵀ) / 2. Null when `r` is singular.
 */
function closestRotation(r: Readonly<Mat4>): Mat4 | null {
  // column-major 3×3: a[col * 3 + row]
  let a = [r[0], r[1], r[2], r[4], r[5], r[6], r[8], r[9], r[10]];
  for (let it = 0; it < 30; it++) {
    const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a;
    // A⁻ᵀ = cofactor matrix / det, element (row i, col j) = C_ij at index j * 3 + i
    const c00 = a4 * a8 - a7 * a5;
    const c10 = a6 * a5 - a3 * a8;
    const c20 = a3 * a7 - a6 * a4;
    const det = a0 * c00 + a1 * c10 + a2 * c20;
    if (!(Math.abs(det) > 1e-12)) return null;
    const inv = 1 / det;
    const invT = [
      c00,
      c10,
      c20,
      a7 * a2 - a1 * a8, // C_01
      a0 * a8 - a6 * a2, // C_11
      a6 * a1 - a0 * a7, // C_21
      a1 * a5 - a4 * a2, // C_02
      a3 * a2 - a0 * a5, // C_12
      a0 * a4 - a3 * a1, // C_22
    ];
    let diff = 0;
    a = a.map((v, i) => {
      const n = (v + invT[i] * inv) / 2;
      diff = Math.max(diff, Math.abs(n - v));
      return n;
    });
    if (diff < 1e-12) break;
  }
  return [a[0], a[1], a[2], 0, a[3], a[4], a[5], 0, a[6], a[7], a[8], 0, 0, 0, 0, 1];
}

/** T · R(q) · S. */
function composeQuat(t: Readonly<Vec3>, q: Readonly<Quat>, s: Readonly<Vec3>): Mat4 {
  const [x, y, z, w] = q;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * s[0],
    2 * (xy + wz) * s[0],
    2 * (xz - wy) * s[0],
    0,
    2 * (xy - wz) * s[1],
    (1 - 2 * (xx + zz)) * s[1],
    2 * (yz + wx) * s[1],
    0,
    2 * (xz + wy) * s[2],
    2 * (yz - wx) * s[2],
    (1 - 2 * (xx + yy)) * s[2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}

function matricesClose(a: Readonly<Mat4>, b: Readonly<Mat4>, eps = 1e-7): boolean {
  for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > eps * (1 + Math.abs(a[i]))) return false;
  return true;
}

/** Z-up position → Y-up. */
const yUp = (x: number, y: number, z: number, out: Float32Array, o: number) => {
  out[o] = x;
  out[o + 1] = z;
  out[o + 2] = -y;
};

class GltfWriter {
  readonly json: GltfRoot = { asset: { version: '2.0', generator: '3D-Editor glTF exporter' } };
  readonly bin = new BinBuilder();
  readonly bufferViews: NonNullable<GltfRoot['bufferViews']> = [];
  readonly accessors: GltfAccessor[] = [];
  readonly extensionsUsed = new Set<string>();

  bufferView(bytes: Uint8Array, target?: number): number {
    const byteOffset = this.bin.add(bytes);
    this.bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length, ...(target ? { target } : {}) });
    return this.bufferViews.length - 1;
  }

  accessor(
    data: Float32Array | Uint16Array | Uint32Array | Uint8Array,
    type: GltfAccessor['type'],
    target?: number,
    minMax = false,
  ): number {
    const comps = TYPE_COMPONENTS[type];
    const componentType =
      data instanceof Float32Array
        ? GL.FLOAT
        : data instanceof Uint16Array
          ? GL.UNSIGNED_SHORT
          : data instanceof Uint8Array
            ? GL.UNSIGNED_BYTE
            : GL.UNSIGNED_INT;
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const acc: GltfAccessor = {
      bufferView: this.bufferView(bytes, target),
      componentType,
      count: data.length / comps,
      type,
    };
    if (minMax && data.length) {
      const min = new Array<number>(comps).fill(Infinity);
      const max = new Array<number>(comps).fill(-Infinity);
      for (let i = 0; i < data.length; i += comps)
        for (let c = 0; c < comps; c++) {
          const v = data[i + c];
          if (v < min[c]) min[c] = v;
          if (v > max[c]) max[c] = v;
        }
      acc.min = min;
      acc.max = max;
    }
    this.accessors.push(acc);
    return this.accessors.length - 1;
  }

  indices(idx: ArrayLike<number>, vertexCount: number): number {
    const arr = vertexCount < 65535 ? Uint16Array.from(idx) : Uint32Array.from(idx);
    return this.accessor(arr, 'SCALAR', GL.ELEMENT_ARRAY_BUFFER);
  }
}

/** Most influences (joints) per vertex of a skinned mesh (JOINTS_0 / WEIGHTS_0). */
const MAX_INFLUENCES = 4;
/**
 * Budget of baked deformation morph targets: floats of their POSITION + NORMAL deltas, all meshes
 * (per written vertex: meshes are written with their vertices split at flat faces, sharp edges and
 * UV seams, so a flat-shaded grid has about four per mesh vertex).
 */
const MAX_BAKED_FLOATS = 12_000_000;
/** Most frames sampled for the animation. */
const MAX_FRAMES = 10000;
/**
 * Most extra scene evaluations for the sub-frame samples of nodes whose motion bends between frames
 * (see `chordErrors`); the most bent frame intervals are checked first.
 */
const SUBFRAME_EVALUATIONS = 3000;
/**
 * Automatic size of procedural bakes: about BAKE_TEXELS_PER_METRE texels per metre of the baked
 * surface (by its world-space area and the share of the UV square its layout covers), rounded up to
 * a power of two within [BAKE_MIN_SIZE, BAKE_MAX_SIZE]; all automatic bakes together stay within
 * BAKE_BUDGET texels (larger ones are halved down to BAKE_MIN_SIZE when the budget runs out).
 */
const BAKE_TEXELS_PER_METRE = 64;
const BAKE_MIN_SIZE = 512;
const BAKE_MAX_SIZE = 2048;
const BAKE_BUDGET = 3 * 2048 * 2048;
/** Share of a UV layout used twice above which position-dependent bakes do not use it. */
const UV_OVERLAP_LIMIT = 0.005;

/** How a mesh object's deformation is exported. */
type MeshMode = 'static' | 'morph' | 'skin';

interface SkinPlan {
  armature: ExportItem;
  params: {
    use_vertex_groups: boolean;
    use_bone_envelopes: boolean;
    use_deform_preserve_volume: boolean;
    vertex_group: string;
    invert_vertex_group: boolean;
  };
}

interface MeshPlan {
  mode: MeshMode;
  /** The mesh written: evaluated (static), basis (morph, skin). */
  mesh: MeshData;
  /** Shape keys exported as morph targets (vertex counts match the basis). */
  keys: ShapeKeyData[];
  meshId: string | null;
  skin?: SkinPlan;
  /** Why the deformation of this mesh cannot be exported as a skin or shape keys (for warnings). */
  why?: string;
}

/** An exported node: an object, or a bone of an exported armature. */
interface XNode {
  index: number;
  name: string;
  item: ExportItem | null;
  /** Bone nodes: the armature and the bone name. */
  armature: ExportItem | null;
  bone: string;
  parent: XNode | null;
  children: XNode[];
  /** Local axes re-expressed Y-up (meshes, empties, armatures) or kept (cameras, lights, bones). */
  converted: boolean;
  /** Skinned meshes: a root node with identity transform (the skin places the vertices). */
  identity: boolean;
  /** Instances: transform relative to the parent fixed at the export frame (not animated). */
  fixed: boolean;
}

export function exportGLTF(doc: SceneDoc, opts: ExportOptions, binary: boolean): ExportResult {
  const warnings: string[] = [];
  const warn = (msg: string) => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };
  const w = new GltfWriter();
  const evaluator = new SceneEvaluator(doc);
  const { scene, items } = collectExport(doc, opts, evaluator);
  const json = w.json;
  const render = scene.render;
  const applyModifiers = opts.applyModifiers !== false;
  const aspect =
    render.resolution_x > 0 && render.resolution_y > 0 ? render.resolution_x / render.resolution_y : 16 / 9;
  const itemById = new Map(items.map((it) => [it.ev.id, it]));
  const exportFrameState = new FrameState(doc, scene.frame);

  // ---------------------------------------------------------------- deformation plans
  const plans = new Map<ExportItem, MeshPlan>();
  for (const it of items) {
    if (!it.mesh) continue;
    const plan = planMesh(doc, it, itemById, applyModifiers, exportFrameState);
    plans.set(it, plan);
  }

  // ---------------------------------------------------------------- hierarchy (DFS order)
  const objectNode = new Map<string, XNode>();
  const boneNodes = new Map<string, Map<string, XNode>>();
  const newNode = (init: Partial<XNode> & { name: string }): XNode => ({
    index: -1,
    item: null,
    armature: null,
    bone: '',
    parent: null,
    children: [],
    converted: true,
    identity: false,
    fixed: false,
    ...init,
  });
  for (const it of items) {
    objectNode.set(
      it.ev.id,
      newNode({
        name: it.ev.name,
        item: it,
        converted: convertedFrame(it.ev),
        identity: plans.get(it)?.mode === 'skin',
        fixed: !!it.instance,
      }),
    );
  }
  // bones of exported armatures
  for (const it of items) {
    const pose = it.ev.type === 'ARMATURE' ? it.ev.pose : undefined;
    if (!pose || it.instance) continue;
    const arm = objectNode.get(it.ev.id)!;
    const map = new Map<string, XNode>();
    for (const name of pose.order)
      map.set(name, newNode({ name, armature: it, bone: name, converted: false }));
    for (const name of pose.order) {
      const n = map.get(name)!;
      const p = pose.bones.get(name)?.parent;
      n.parent = (p && map.get(p)) || arm;
      n.parent.children.push(n);
    }
    boneNodes.set(it.ev.id, map);
  }
  // object parents (bone parenting attaches to the bone's node); skinned meshes stay at the root
  for (const it of items) {
    const n = objectNode.get(it.ev.id)!;
    if (n.identity) continue;
    const d = it.ev.data;
    const p = d.parent && d.parent !== it.ev.id ? objectNode.get(d.parent) : undefined;
    if (!p) continue;
    let parent = p;
    if (!it.instance && d.parent_type === 'BONE' && d.parent_bone) {
      const b = boneNodes.get(d.parent!)?.get(d.parent_bone);
      if (b) parent = b;
    }
    // parent cycles (corrupt data): such objects become roots
    let q: XNode | null = parent;
    let cyclic = false;
    while (q) {
      if (q === n) {
        cyclic = true;
        break;
      }
      q = q.parent;
    }
    if (cyclic) continue;
    n.parent = parent;
    parent.children.push(n);
  }
  const order: XNode[] = [];
  const visit = (n: XNode) => {
    n.index = order.length;
    order.push(n);
    for (const c of n.children) visit(c);
  };
  for (const it of items) {
    const n = objectNode.get(it.ev.id)!;
    if (!n.parent) visit(n);
  }

  // ---------------------------------------------------------------- transforms
  /** Editor-space world matrix of a node in an evaluated scene (null when missing). */
  const worldIn = (n: XNode, sc: EvaluatedScene): Mat4 | null => {
    if (n.identity) return IDENTITY;
    if (n.armature) {
      const arm = sc.byId.get(n.armature.ev.id);
      const b = arm?.pose?.bones.get(n.bone);
      return arm && b ? multiply4(arm.worldMatrix, b.matrix) : null;
    }
    const it = n.item!;
    if (it.instance) return it.ev.worldMatrix;
    return sc.byId.get(it.ev.id)?.worldMatrix ?? null;
  };
  /** glTF local matrix of a node (relative to its parent node, axes converted). */
  const gltfLocal = (n: XNode, sc: EvaluatedScene): Mat4 | null => {
    const wm = worldIn(n, sc);
    if (!wm) return null;
    let local = wm;
    if (n.parent) {
      const pw = worldIn(n.parent, sc);
      const inv = pw ? invertAffine(pw) : null;
      if (!inv) return null;
      local = multiply4(inv, wm);
    }
    let m = local;
    if (!n.parent || n.parent.converted) m = multiply4(M_Z_TO_Y, m);
    if (n.converted) m = multiply4(m, M_Y_TO_Z);
    return m;
  };
  /**
   * Export-frame TRS of a node. Objects parented the plain way keep their exact location/rotation/
   * scale; everything else (bones, bone parenting, constraints, physics) comes from the matrices.
   */
  const staticTRS = (n: XNode): (TRS & { exact: boolean; matrix?: Mat4 }) | null => {
    const it = n.item;
    if (it && !n.identity) {
      const d = it.ev.data;
      const plain = n.parent ? n.parent.item?.ev.id === d.parent : !d.parent;
      if (plain) {
        const local = n.parent
          ? (() => {
              const pw = worldIn(n.parent!, scene);
              const inv = pw ? invertAffine(pw) : null;
              return inv ? multiply4(inv, it.ev.worldMatrix) : null;
            })()
          : it.ev.worldMatrix;
        if (local && matricesClose(local, compose4(d.location, d.rotation_euler, d.scale)))
          return {
            ...trsToYUp(trsFromObject(d), !n.parent || n.parent.converted, n.converted),
            exact: true,
          };
      }
    }
    const m = gltfLocal(n, scene);
    if (!m) return null;
    const trs = trsOfMatrix(m);
    return trs.exact ? trs : { ...trs, matrix: m };
  };

  // ---------------------------------------------------------------- animation sampling
  const sceneSettings = doc.getScene();
  const fps = sceneSettings.fps > 0 ? sceneSettings.fps : 24;
  const start = Math.round(sceneSettings.frame_start);
  const end = Math.min(start + MAX_FRAMES - 1, Math.max(start, Math.round(sceneSettings.frame_end)));
  const animated = sceneMayAnimate(doc);
  const frames: number[] = [];
  if (animated) for (let f = start; f <= end; f++) frames.push(f);
  if (animated && Math.round(sceneSettings.frame_end) > end)
    warn(`Animation longer than ${MAX_FRAMES} frames: exported frames ${start}–${end} only`);
  interface Track {
    t: Float32Array;
    r: Float32Array;
    s: Float32Array;
  }
  const tracks = new Map<XNode, Track>();
  const sheared = new Set<XNode>();
  /** Shape key values per frame of morph/skin meshes (by item). */
  const weightTracks = new Map<ExportItem, Float32Array>();
  /** Per-frame evaluated meshes of statically planned meshes that deform (baking candidates). */
  const deformations = new Map<ExportItem, (MeshData | null)[]>();
  const bindRelation = new Map<ExportItem, Mat4>();
  /**
   * Datablocks with F-curves or drivers whose animation glTF cannot carry (without
   * KHR_animation_pointer): camera and light data, materials and the world, as 'type:id'.
   */
  const animatedData = new Set<string>();
  const unexportable = (type: string) =>
    type === 'camera' || type === 'light' || type === 'material' || type === 'world';
  for (const fc of doc.listFCurves())
    if (!fc.mute && fc.keyframes.length && unexportable(fc.target_type))
      animatedData.add(`${fc.target_type}:${fc.target_id}`);
  for (const d of doc.listDrivers())
    if (!d.mute && unexportable(d.target_type)) animatedData.add(`${d.target_type}:${d.target_id}`);
  /** Properties whose value at some frame differs from the export frame's, per datablock label. */
  const unexported = new Map<string, Set<string>>();
  const noteChanges = (label: string, at: object | null | undefined, now: object | null | undefined) => {
    if (!at || !now || at === now) return;
    const a = at as Record<string, unknown>;
    const b = now as Record<string, unknown>;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[k] === b[k] || stableStringify(a[k]) === stableStringify(b[k])) continue;
      let keys = unexported.get(label);
      if (!keys) unexported.set(label, (keys = new Set()));
      keys.add(k);
    }
  };
  /** Compares the animated cameras, lights, materials and world of an evaluated frame. */
  const noteUnexportedAnimation = (sc: EvaluatedScene) => {
    const seen = new Set<string>();
    for (const it of items) {
      if (it.instance) continue;
      const ev = sc.byId.get(it.ev.id);
      if (!ev) continue;
      const dataId = it.ev.data.data;
      if (dataId && it.ev.camera && animatedData.has(`camera:${dataId}`))
        noteChanges(`Camera '${it.ev.name}'`, it.ev.camera, ev.camera);
      if (dataId && it.ev.light && animatedData.has(`light:${dataId}`))
        noteChanges(`Light '${it.ev.name}'`, it.ev.light, ev.light);
      it.ev.materials.forEach((m, slot) => {
        if (!m || seen.has(m.id) || !animatedData.has(`material:${m.id}`)) return;
        seen.add(m.id);
        noteChanges(`Material '${m.name}'`, m, ev.materials[slot]);
      });
    }
    if ([...animatedData].some((k) => k.startsWith('world:'))) noteChanges('World', scene.world, sc.world);
  };
  if (frames.length) {
    for (const n of order) {
      if (n.identity || n.fixed) continue;
      tracks.set(n, {
        t: new Float32Array(frames.length * 3),
        r: new Float32Array(frames.length * 4),
        s: new Float32Array(frames.length * 3),
      });
    }
    for (const [it, plan] of plans) {
      if (plan.keys.length) weightTracks.set(it, new Float32Array(frames.length * plan.keys.length));
      if (plan.mode === 'skin') {
        const arm = plan.skin!.armature.ev.worldMatrix;
        const inv = invertAffine(arm);
        if (inv) bindRelation.set(it, multiply4(inv, it.ev.worldMatrix));
      }
    }
    const prevQ = new Map<XNode, Quat>();
    frames.forEach((f, fi) => {
      const sc = f === scene.frame ? scene : evaluator.evaluate(f, { forRender: true });
      if (animatedData.size) noteUnexportedAnimation(sc);
      for (const [n, tr] of tracks) {
        const m = gltfLocal(n, sc) ?? gltfLocal(n, scene);
        const trs = m
          ? trsOfMatrix(m)
          : { t: [0, 0, 0] as Vec3, q: [0, 0, 0, 1] as Quat, s: [1, 1, 1] as Vec3, exact: true };
        if (!trs.exact) sheared.add(n);
        let q = normalizeQuat(trs.q);
        const prev = prevQ.get(n);
        if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0)
          q = [-q[0], -q[1], -q[2], -q[3]];
        prevQ.set(n, q);
        tr.t.set(trs.t, fi * 3);
        tr.r.set(q, fi * 4);
        tr.s.set(trs.s, fi * 3);
      }
      const fs = weightTracks.size ? new FrameState(doc, f) : null;
      for (const [it, wt] of weightTracks) {
        const plan = plans.get(it)!;
        const vals = shapeKeyWeights(fs!, plan);
        wt.set(vals, fi * plan.keys.length);
      }
      for (const [it, plan] of plans) {
        if (plan.mode === 'skin') {
          // the skin assumes a fixed mesh-to-armature placement (mesh parented to the armature)
          const rel = bindRelation.get(it);
          const ev = sc.byId.get(it.ev.id);
          const arm = sc.byId.get(plan.skin!.armature.ev.id);
          const inv = arm ? invertAffine(arm.worldMatrix) : null;
          if (rel && ev && inv && !matricesClose(multiply4(inv, ev.worldMatrix), rel, 1e-5))
            warn(
              `Skinned mesh '${it.ev.name}' moves relative to its armature '${plan.skin!.armature.ev.name}' during the animation; glTF skins keep the placement of frame ${scene.frame} (parent the mesh to the armature)`,
            );
          continue;
        }
        if (plan.mode !== 'static' || it.instance) continue;
        const ev = sc.byId.get(it.ev.id);
        const mesh = ev ? (applyModifiers ? ev.mesh : (ev.baseMesh ?? ev.mesh)) : undefined;
        let list = deformations.get(it);
        if (!mesh || mesh === plan.mesh || samePositions(mesh, plan.mesh)) {
          if (list) list[fi] = null;
          continue;
        }
        if (!sameTopology(mesh, plan.mesh)) {
          warn(
            `Mesh '${it.ev.name}' changes its topology during the animation; exported as at frame ${scene.frame} only`,
          );
          deformations.delete(it);
          plans.set(it, { ...plan, why: 'topology' });
          continue;
        }
        if (plan.why === 'topology') continue;
        if (!list) {
          list = new Array<MeshData | null>(frames.length).fill(null);
          deformations.set(it, list);
        }
        list[fi] = mesh;
      }
    });
  }
  for (const [label, keys] of unexported) {
    const props = [...keys].join(', ');
    warn(
      label === 'World'
        ? `World: the animation of ${props} is not exported (glTF has no world or environment)`
        : `${label}: the animation of ${props} is not exported (glTF animates node transforms, morph target weights and skins; camera, light and material properties would need KHR_animation_pointer, which is not written), so the file keeps their values at frame ${scene.frame}`,
    );
  }
  /** Nodes whose transform changes over the animation (get channels; others are static). */
  const moving = new Set<XNode>();
  for (const [n, tr] of tracks) if (varies(tr.t, 3) || varies(tr.r, 4) || varies(tr.s, 3)) moving.add(n);
  for (const n of sheared)
    if (moving.has(n))
      warn(
        `'${n.name}' has a sheared transform (non-uniform parent scale); glTF animation cannot represent it exactly`,
      );
  // glTF players interpolate translations linearly between keys, so where an object's motion bends
  // between two frames (a constraint keeping it on a fast orbit, a driver on sin(frame), Bezier keys
  // far apart …) per-frame keys cut chords. The per-frame keys show where a path bends
  // (`chordErrors`); there the scene is evaluated at the mid-frame, and only where that sample lies
  // off the straight line between the two frame keys by more than the tolerance does the node get
  // keys between those frames (1, or 3 where the mid-frame offset calls for them). Motion that is
  // straight between frames (LINEAR keyframes, rigid bodies, whose simulation is interpolated
  // linearly between frames) keeps one key per frame, however sharply it turns at a frame.
  /** Sub-frame tracks (key times in frames) of nodes whose motion bends between frames. */
  const fineTracks = new Map<XNode, Track & { frames: Float64Array; sig: string }>();
  if (frames.length > 2) {
    type Sample = { t: Vec3; q: Quat; s: Vec3 };
    /** Moving nodes whose per-frame keys bend: chord error estimate per frame interval. */
    const candidates = new Map<XNode, { tol: number; est: Float64Array }>();
    for (const n of moving) {
      const tr = tracks.get(n)!;
      if (!varies(tr.t, 3)) continue;
      const tol = chordTolerance(tr.t);
      const est = chordErrors(tr.t);
      if (est.some((e) => e > tol)) candidates.set(n, { tol, est });
    }
    // frame intervals (frame i → i + 1) to check, the most bent first
    const score = new Float64Array(frames.length - 1);
    for (const { tol, est } of candidates.values())
      est.forEach((e, i) => {
        if (e > tol) score[i] = Math.max(score[i], e / tol);
      });
    const flagged: number[] = [];
    score.forEach((s, i) => {
      if (s > 0) flagged.push(i);
    });
    flagged.sort((a, b) => score[b] - score[a] || a - b);
    const sampleOf = (sc: EvaluatedScene, n: XNode): Sample => {
      const m = gltfLocal(n, sc) ?? gltfLocal(n, scene);
      const trs = m ? trsOfMatrix(m) : null;
      return trs
        ? { t: trs.t, q: normalizeQuat(trs.q), s: trs.s }
        : { t: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] };
    };
    const keyAt = (n: XNode, fi: number): Vec3 => {
      const t = tracks.get(n)!.t;
      return [t[fi * 3], t[fi * 3 + 1], t[fi * 3 + 2]];
    };
    /** Distance of p from the midpoint of a and b (the offset of p from the chord a–b at its middle). */
    const offMid = (p: Vec3, a: Vec3, b: Vec3) =>
      Math.hypot(p[0] - (a[0] + b[0]) / 2, p[1] - (a[1] + b[1]) / 2, p[2] - (a[2] + b[2]) / 2);
    /** Per node: the samples between frame i and i + 1 it gets keys for (mid, or quarter-mid-quarter). */
    const between = new Map<XNode, Map<number, Sample[]>>();
    /** Per node: the largest chord error left (estimated), with the keys per frame there. */
    const left = new Map<XNode, { err: number; k: number }>();
    let budget = SUBFRAME_EVALUATIONS;
    let checked = 0;
    for (const i of flagged) {
      if (budget < 1) break;
      budget--;
      checked++;
      const mid = evaluator.evaluate(frames[i] + 0.5, { forRender: true });
      const off: { n: XNode; m: Sample; d: number; tol: number }[] = [];
      for (const [n, c] of candidates) {
        const m = sampleOf(mid, n);
        const d = offMid(m.t, keyAt(n, i), keyAt(n, i + 1));
        if (d > c.tol) off.push({ n, m, d, tol: c.tol });
      }
      if (!off.length) continue;
      // a chord of half the length has about a quarter of the offset: 4 keys per frame where a
      // mid-frame key alone leaves more than the tolerance
      let quarter: [EvaluatedScene, EvaluatedScene] | null = null;
      if (budget >= 2 && off.some(({ d, tol }) => d / 4 > tol)) {
        budget -= 2;
        quarter = [
          evaluator.evaluate(frames[i] + 0.25, { forRender: true }),
          evaluator.evaluate(frames[i] + 0.75, { forRender: true }),
        ];
      }
      for (const { n, m, d, tol } of off) {
        let samples = [m];
        let err = d / 4;
        if (quarter && d / 4 > tol) {
          const a = sampleOf(quarter[0], n);
          const b = sampleOf(quarter[1], n);
          samples = [a, m, b];
          err = Math.max(offMid(a.t, keyAt(n, i), m.t), offMid(b.t, m.t, keyAt(n, i + 1))) / 4;
        }
        let per = between.get(n);
        if (!per) between.set(n, (per = new Map()));
        per.set(i, samples);
        const was = left.get(n);
        if (err > tol && (!was || err > was.err)) left.set(n, { err, k: samples.length + 1 });
      }
    }
    for (const [n, per] of between) {
      const tr = tracks.get(n)!;
      const ivs = [...per.keys()].sort((a, b) => a - b);
      let count = frames.length;
      for (const i of ivs) count += per.get(i)!.length;
      const ft = {
        frames: new Float64Array(count),
        t: new Float32Array(count * 3),
        r: new Float32Array(count * 4),
        s: new Float32Array(count * 3),
        sig: ivs.map((i) => `${i}:${per.get(i)!.length}`).join(','),
      };
      let o = 0;
      let prev: Quat | null = null;
      const push = (f: number, smp: Sample) => {
        let q = smp.q;
        if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0)
          q = [-q[0], -q[1], -q[2], -q[3]];
        prev = q;
        ft.frames[o] = f;
        ft.t.set(smp.t, o * 3);
        ft.r.set(q, o * 4);
        ft.s.set(smp.s, o * 3);
        o++;
      };
      for (let fi = 0; fi < frames.length; fi++) {
        push(frames[fi], {
          t: keyAt(n, fi),
          q: [tr.r[fi * 4], tr.r[fi * 4 + 1], tr.r[fi * 4 + 2], tr.r[fi * 4 + 3]],
          s: [tr.s[fi * 3], tr.s[fi * 3 + 1], tr.s[fi * 3 + 2]],
        });
        const smp = per.get(fi);
        if (smp) smp.forEach((sm, j) => push(frames[fi] + (j + 1) / (smp.length + 1), sm));
      }
      fineTracks.set(n, ft);
    }
    for (const [n, { err, k }] of left)
      warn(
        `'${n.name}' moves on a strongly curved path: with ${k} keys per frame${k < 4 ? ' (the budget of sub-frame samples ran out)' : ''} its linearly interpolated glTF keys still cut chords of about ${(err * 1000).toFixed(1)} mm (parent it to the rotating object, or use a higher frame rate, for a closer path)`,
      );
    if (checked < flagged.length) {
      const rest = flagged.slice(checked);
      const names = [...candidates]
        .filter(([, c]) => rest.some((i) => c.est[i] > c.tol))
        .map(([n]) => `'${n.name}'`);
      warn(
        `Curved paths: ${rest.length} of the ${flagged.length} frame intervals where the per-frame keys of ${names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')} bend were not checked between frames (budget of ${SUBFRAME_EVALUATIONS} sub-frame scene evaluations), so they keep one key per frame there; where the motion curves between frames, their linearly interpolated keys cut chords`,
      );
    }
  }

  // ---------------------------------------------------------------- images / textures / materials
  const textures: NonNullable<GltfRoot['textures']> = [];
  const images: NonNullable<GltfRoot['images']> = [];
  const textureOf = new Map<string, number>();
  const sampler = () => {
    if (!json.samplers)
      json.samplers = [
        { magFilter: GL.LINEAR, minFilter: GL.LINEAR_MIPMAP_LINEAR, wrapS: GL.REPEAT, wrapT: GL.REPEAT },
      ];
  };
  const textureIndex = (imageId: string): number => {
    const cached = textureOf.get(imageId);
    if (cached !== undefined) return cached;
    let index = -1;
    const img = doc.getImage(imageId);
    const bytes = doc.getImageBytes(imageId);
    if (img && bytes && bytes.length) {
      const sniffed = sniffImageMime(bytes);
      const mime = sniffed ?? img.mime;
      if (mime === 'image/png' || mime === 'image/jpeg') {
        sampler();
        images.push({ name: img.name, mimeType: mime, bufferView: w.bufferView(bytes) });
        textures.push({ sampler: 0, source: images.length - 1 });
        index = textures.length - 1;
      } else warn(`Image '${img.name}' (${mime}) is not PNG/JPEG and was not exported`);
    } else warn(`Image ${imageId} has no data and was not exported`);
    textureOf.set(imageId, index);
    return index;
  };
  /** Embeds a baked RGBA8 image as a PNG texture; returns the texture index. */
  const pngTexture = (img: PNGImage, name: string): number => {
    sampler();
    images.push({ name, mimeType: 'image/png', bufferView: w.bufferView(encodePNG(img)) });
    textures.push({ sampler: 0, source: images.length - 1 });
    return textures.length - 1;
  };
  const textureInfo = (slot: TextureSlot | null | undefined): GltfTextureInfo | undefined => {
    // procedural slots are baked separately (see materialIndex)
    if (!slot || !slot.image || slot.procedural) return undefined;
    const index = textureIndex(slot.image);
    if (index < 0) return undefined;
    const info: GltfTextureInfo = { index };
    const sc = slot.scale ?? [1, 1];
    const of = slot.offset ?? [0, 0];
    if (!isDefault(sc, [1, 1]) || !isDefault(of, [0, 0])) {
      // editor UVs have V up; glTF flips V, so the offset is mirrored accordingly
      info.extensions = {
        KHR_texture_transform: { offset: [of[0], 1 - sc[1] - of[1]], scale: [sc[0], sc[1]] },
      };
      w.extensionsUsed.add('KHR_texture_transform');
    }
    return info;
  };

  const materials: GltfMaterial[] = [];
  const materialOf = new Map<string, number>();
  /** Texture indices and factors of one procedural bake, shared by equal materials on equal geometry. */
  interface BakeResult {
    baseColor?: number;
    baseColorFactor?: Vec4;
    metallicRoughness?: number;
    metallicFactor?: number;
    roughnessFactor?: number;
    normal?: number;
    emissive?: number;
    emissiveColor?: Vec3;
  }
  const bakes = new Map<string, BakeResult>();
  /** What a material is drawn on: the exported mesh (its UVs) and the item for GENERATED space. */
  interface Surface {
    mesh: MeshData;
    it: ExportItem;
    generatedUvs: boolean;
  }
  let bakeTexels = 0;
  const explicitBakeSize =
    opts.bakeResolution !== undefined && Number.isFinite(opts.bakeResolution)
      ? Math.max(64, Math.min(4096, Math.round(opts.bakeResolution)))
      : null;
  /** Automatic image size for a bake onto `mesh` of item `it` (before the budget). */
  const wantedSize = (mesh: MeshData, it: ExportItem): number => {
    let area = 0;
    let uvArea = 0;
    const P = mesh.positions;
    mesh.faces.forEach((f, fi) => {
      const uv = mesh.uvs?.[fi];
      for (let i = 1; i + 1 < f.length; i++) {
        const a = f[0] * 3;
        const b = f[i] * 3;
        const c = f[i + 1] * 3;
        const ux = P[b] - P[a];
        const uy = P[b + 1] - P[a + 1];
        const uz = P[b + 2] - P[a + 2];
        const vx = P[c] - P[a];
        const vy = P[c + 1] - P[a + 1];
        const vz = P[c + 2] - P[a + 2];
        area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
        if (uv)
          uvArea +=
            Math.abs(
              (uv[i * 2] - uv[0]) * (uv[i * 2 + 3] - uv[1]) -
                (uv[i * 2 + 2] - uv[0]) * (uv[i * 2 + 1] - uv[1]),
            ) / 2;
      }
    });
    // world scale of the surface: area grows with |det|^(2/3) of the object's matrix
    const det = Math.abs(determinant4(it.ev.worldMatrix));
    const worldArea = area * (Number.isFinite(det) && det > 0 ? Math.pow(det, 2 / 3) : 1);
    const coverage = Math.min(1, Math.max(0.05, uvArea));
    let size = BAKE_MIN_SIZE;
    const want = Math.sqrt(worldArea / coverage) * BAKE_TEXELS_PER_METRE;
    while (size < BAKE_MAX_SIZE && size < want) size *= 2;
    return size;
  };
  /** UV-mapped bakes are shared by every mesh of a material: sized for the largest of them. */
  const sharedSizes = new Map<string, number>();
  /**
   * Image size of a bake of `m` onto `surf`: explicit, else from the surface's size (geometry
   * dependent bakes) or the largest surface using the material (UV-mapped bakes), within the budget.
   */
  const bakeSize = (m: MaterialData, surf: Surface, perMesh: boolean): number => {
    if (explicitBakeSize !== null) return explicitBakeSize;
    const budgeted = (size: number) => {
      while (size > BAKE_MIN_SIZE && bakeTexels + size * size > BAKE_BUDGET) size /= 2;
      return size;
    };
    if (perMesh) return budgeted(wantedSize(surf.mesh, surf.it));
    let shared = sharedSizes.get(m.id);
    if (shared === undefined) {
      shared = BAKE_MIN_SIZE;
      for (const it of items)
        if (plans.has(it) && it.materials.some((x) => x?.id === m.id))
          shared = Math.max(shared, wantedSize(plans.get(it)!.mesh, it));
      // one size for every mesh of the material, so they keep sharing one bake
      sharedSizes.set(m.id, (shared = budgeted(shared)));
    }
    return shared;
  };
  /** Name of a material in glTF: its name, with .001, .002 … for further exported copies of it. */
  const bakedNames = new Map<string, string[]>();
  const nameFor = (m: MaterialData): string => {
    let names = bakedNames.get(m.id);
    if (!names) bakedNames.set(m.id, (names = []));
    const name = names.length ? `${m.name}.${String(names.length).padStart(3, '0')}` : m.name;
    names.push(name);
    return name;
  };
  const bake = (
    m: MaterialData,
    surf: Surface,
    hasUv: boolean,
    name: () => string,
  ): { result: BakeResult; key: string } => {
    // the bake depends on the geometry for GENERATED/OBJECT mappings and bumps: key it by content so
    // identical meshes (e.g. many copies of a cube) share one bake and one material
    const it = surf.it;
    let geometry: BakeGeometry = { mesh: surf.mesh, generatedUvs: surf.generatedUvs };
    let geoKey = '';
    if (proceduralBakeNeedsGeometry(m) || surf.generatedUvs) {
      const tex = it.ev.baseMesh ? meshBounds(it.ev.baseMesh) : null;
      const orco =
        it.mesh === it.ev.mesh && proceduralSurface(m)?.usesGenerated && !it.instance
          ? evaluatedOrco(doc, scene, it.ev, true)
          : null;
      geometry = {
        mesh: surf.mesh,
        texMin: tex?.min,
        texMax: tex?.max,
        orco: orco && orco.length === surf.mesh.positions.length ? orco : null,
        generatedUvs: surf.generatedUvs,
      };
      geoKey = bakeGeometryKey(geometry);
    }
    const size = hasUv ? bakeSize(m, surf, geoKey !== '') : 0;
    const key = `${hasUv ? 'uv' : 'nouv'}|${geoKey}|${size}`;
    const bakeKey = `${stableStringify([
      m.textures,
      m.base_color,
      m.alpha,
      m.metallic,
      m.roughness,
      m.emission_strength,
      m.normal_strength,
    ])}|${key}`;
    let result = bakes.get(bakeKey);
    if (!result) {
      const baked = bakeMaterialTextures(m, geometry, size ? { width: size } : {});
      for (const msg of baked.warnings) warn(msg);
      const images = [baked.baseColor, baked.metallicRoughness, baked.normal, baked.emissive].filter(
        (x) => !!x,
      );
      if (explicitBakeSize === null) bakeTexels += images.length ? size * size : 0;
      const n = name();
      result = {
        baseColor: baked.baseColor && pngTexture(baked.baseColor, `${n} base color`),
        baseColorFactor: baked.baseColorFactor,
        metallicRoughness:
          baked.metallicRoughness && pngTexture(baked.metallicRoughness, `${n} metallic roughness`),
        metallicFactor: baked.metallicFactor,
        roughnessFactor: baked.roughnessFactor,
        normal: baked.normal && pngTexture(baked.normal, `${n} normal`),
        emissive: baked.emissive && pngTexture(baked.emissive, `${n} emission`),
        emissiveColor: baked.emissiveColor,
      };
      bakes.set(bakeKey, result);
    }
    return { result, key };
  };
  const materialIndex = (m: MaterialData, surf: Surface): number => {
    // glTF texture bindings need TEXCOORD_0: primitives without UVs get texture-less materials
    const hasUv = !!surf.mesh.uvs && surf.mesh.faces.length > 0;
    // a material exported more than once (a bake per mesh, with and without image textures) gets
    // distinct names: Beech, Beech.001 … (images named after them)
    let glName: string | null = null;
    const name = () => (glName ??= nameFor(m));
    const baked = hasProceduralTextures(m) ? bake(m, surf, hasUv, name) : null;
    const t = m.textures ?? {};
    // whether UVs change the exported material: only image textures (procedurals: `baked.key`),
    // which are dropped on meshes without UVs and on generated UVs (made for procedural bakes only)
    const imageSlots = Object.values(t).some((slot) => !!slot && !!slot.image && !slot.procedural);
    const imagesKept = hasUv && !surf.generatedUvs;
    const key = `${m.id}|${baked ? baked.key : imageSlots ? (imagesKept ? 'uv' : 'nouv') : '-'}`;
    const cached = materialOf.get(key);
    if (cached !== undefined) return cached;
    const b = baked?.result ?? null;
    const out: GltfMaterial = { name: name() };
    const pbr: NonNullable<GltfMaterial['pbrMetallicRoughness']> = {};
    const bc = [
      clamp01(m.base_color[0]),
      clamp01(m.base_color[1]),
      clamp01(m.base_color[2]),
      clamp01((m.base_color[3] ?? 1) * m.alpha),
    ];
    if (!isDefault(bc, [1, 1, 1, 1])) pbr.baseColorFactor = bc;
    if (m.metallic !== 1) pbr.metallicFactor = clamp01(m.metallic);
    if (m.roughness !== 1) pbr.roughnessFactor = clamp01(m.roughness);
    // image textures (procedural slots are baked, see `bake`)
    let skippedImages = false;
    const imageTexture = (slot: TextureSlot | null | undefined): GltfTextureInfo | undefined => {
      if (!slot || !slot.image || slot.procedural) return undefined;
      if (!hasUv || surf.generatedUvs) {
        skippedImages = true;
        return undefined;
      }
      return textureInfo(slot);
    };
    const base = imageTexture(t.base_color);
    if (base) pbr.baseColorTexture = base;
    if (b?.baseColor !== undefined) pbr.baseColorTexture = { index: b.baseColor };
    if (b?.baseColorFactor) {
      const f = b.baseColorFactor.map(clamp01);
      if (isDefault(f, [1, 1, 1, 1])) delete pbr.baseColorFactor;
      else pbr.baseColorFactor = f;
    }
    const imageSlot = (slot: TextureSlot | null | undefined) =>
      slot?.image && !slot.procedural ? slot : undefined;
    const roughImage = imageSlot(t.roughness);
    const metalImage = imageSlot(t.metallic);
    if (roughImage && metalImage && roughImage.image !== metalImage.image)
      warn(
        `Material '${m.name}': metallic and roughness textures must share one image in glTF; using the roughness texture`,
      );
    const mrInfo = imageTexture(roughImage ?? metalImage);
    if (mrInfo) pbr.metallicRoughnessTexture = mrInfo;
    if (b?.metallicRoughness !== undefined) {
      // absolute values in the texture (G = roughness, B = metallic), factors 1
      pbr.metallicRoughnessTexture = { index: b.metallicRoughness };
      delete pbr.metallicFactor;
      delete pbr.roughnessFactor;
    }
    // constant procedural channels (mesh without UVs)
    if (b?.metallicFactor !== undefined) pbr.metallicFactor = clamp01(b.metallicFactor);
    if (b?.roughnessFactor !== undefined) pbr.roughnessFactor = clamp01(b.roughnessFactor);
    if (pbr.metallicFactor === 1) delete pbr.metallicFactor;
    if (pbr.roughnessFactor === 1) delete pbr.roughnessFactor;
    out.pbrMetallicRoughness = pbr;
    const normal = imageTexture(t.normal);
    if (normal) {
      if (m.normal_strength !== 1) normal.scale = m.normal_strength;
      out.normalTexture = normal;
    }
    if (b?.normal !== undefined) out.normalTexture = { index: b.normal };
    // emission: factor in [0, 1], anything brighter goes to KHR_materials_emissive_strength
    // an emission texture replaces the emission color (like a texture plugged into Emission Color)
    const es = Math.max(0, m.emission_strength);
    const emissiveTex =
      es > 0 ? (b?.emissive !== undefined ? { index: b.emissive } : imageTexture(t.emission)) : undefined;
    const ec: Vec3 = emissiveTex
      ? [1, 1, 1]
      : (b?.emissiveColor ?? [m.emission_color[0], m.emission_color[1], m.emission_color[2]]);
    if (skippedImages)
      warn(
        `Material '${m.name}': image textures need UVs, but mesh '${surf.it.ev.name}' has none; exported without them`,
      );
    const f: Vec3 = [Math.max(0, ec[0] * es), Math.max(0, ec[1] * es), Math.max(0, ec[2] * es)];
    const fmax = Math.max(f[0], f[1], f[2]);
    if (fmax > 0) {
      if (fmax <= 1) out.emissiveFactor = f;
      else {
        const cmax = Math.max(ec[0], ec[1], ec[2]);
        let strength: number;
        if (es > 1 && cmax <= 1) {
          out.emissiveFactor = [ec[0], ec[1], ec[2]];
          strength = es;
        } else {
          out.emissiveFactor = [f[0] / fmax, f[1] / fmax, f[2] / fmax];
          strength = fmax;
        }
        out.extensions = {
          ...out.extensions,
          KHR_materials_emissive_strength: { emissiveStrength: strength },
        };
        w.extensionsUsed.add('KHR_materials_emissive_strength');
      }
      if (emissiveTex) out.emissiveTexture = emissiveTex;
    }
    if (m.blend_method === 'CLIP') {
      out.alphaMode = 'MASK';
      if (m.alpha_threshold !== 0.5) out.alphaCutoff = Math.max(0, m.alpha_threshold);
    } else if (m.blend_method === 'BLEND') out.alphaMode = 'BLEND';
    if (!m.use_backface_culling) out.doubleSided = true;
    if (m.transmission > 0) {
      out.extensions = {
        ...out.extensions,
        KHR_materials_transmission: { transmissionFactor: clamp01(m.transmission) },
      };
      w.extensionsUsed.add('KHR_materials_transmission');
    }
    if (Math.abs(m.ior - 1.5) > 1e-6) {
      out.extensions = { ...out.extensions, KHR_materials_ior: { ior: Math.max(1, m.ior) } };
      w.extensionsUsed.add('KHR_materials_ior');
    }
    if (m.coat_weight > 0) {
      out.extensions = {
        ...out.extensions,
        KHR_materials_clearcoat: {
          clearcoatFactor: clamp01(m.coat_weight),
          clearcoatRoughnessFactor: clamp01(m.coat_roughness),
        },
      };
      w.extensionsUsed.add('KHR_materials_clearcoat');
    }
    if (m.sheen_weight > 0) {
      // sheen colour = tint × weight; the renderers' sheen lobe has a fixed roughness of 0.5
      const tint = m.sheen_tint ?? [1, 1, 1];
      const sw = clamp01(m.sheen_weight);
      out.extensions = {
        ...out.extensions,
        KHR_materials_sheen: {
          sheenColorFactor: [clamp01(tint[0] * sw), clamp01(tint[1] * sw), clamp01(tint[2] * sw)],
          sheenRoughnessFactor: 0.5,
        },
      };
      w.extensionsUsed.add('KHR_materials_sheen');
    }
    materials.push(out);
    materialOf.set(key, materials.length - 1);
    return materials.length - 1;
  };

  // ---------------------------------------------------------------- geometry (shared accessors)
  /** Vertex data of one exported geometry, shared by every glTF mesh drawing it. */
  interface Geometry {
    rb: RenderBuffers | null;
    attributes: Record<string, number>;
    /** Index accessor per material slot group. */
    groups: { materialIndex: number; indices: number }[];
    lines: { attributes: Record<string, number>; indices: number } | null;
    targets: Record<string, number>[];
    targetNames: string[];
  }
  const geometries = new Map<unknown, Map<string, Geometry>>();
  const geometryOf = (key: unknown, variant: string, build: () => Geometry): Geometry => {
    let m = geometries.get(key);
    if (!m) geometries.set(key, (m = new Map()));
    let g = m.get(variant);
    if (!g) m.set(variant, (g = build()));
    return g;
  };
  /** Render buffers (the vertices written: split at flat faces, sharp edges and UV seams) per mesh. */
  const renderBuffers = new Map<MeshData, RenderBuffers>();
  const renderBuffersOf = (mesh: MeshData): RenderBuffers => {
    let rb = renderBuffers.get(mesh);
    if (!rb) renderBuffers.set(mesh, (rb = buildRenderBuffers(mesh)));
    return rb;
  };
  /**
   * Writes the vertex attributes and per-material indices of a mesh. `xf`: matrix applied to the
   * positions (and its normal matrix to the normals) before the Y-up conversion (skins: to world).
   */
  const writeGeometry = (mesh: MeshData, xf: Mat4 | null, withLines: boolean): Geometry => {
    const rb = mesh.faces.length ? renderBuffersOf(mesh) : null;
    const g: Geometry = { rb, attributes: {}, groups: [], lines: null, targets: [], targetNames: [] };
    if (rb && rb.indices.length) {
      const nv = rb.positions.length / 3;
      const pos = new Float32Array(nv * 3);
      const nrm = new Float32Array(nv * 3);
      transformInto(rb.positions, xf, false, pos);
      transformInto(rb.normals, xf, true, nrm);
      g.attributes.POSITION = w.accessor(pos, 'VEC3', GL.ARRAY_BUFFER, true);
      g.attributes.NORMAL = w.accessor(nrm, 'VEC3', GL.ARRAY_BUFFER);
      if (rb.uvs) {
        const uv = new Float32Array(nv * 2);
        for (let i = 0; i < nv; i++) {
          uv[i * 2] = rb.uvs[i * 2];
          uv[i * 2 + 1] = 1 - rb.uvs[i * 2 + 1];
        }
        g.attributes.TEXCOORD_0 = w.accessor(uv, 'VEC2', GL.ARRAY_BUFFER);
      }
      if (rb.colors) g.attributes.COLOR_0 = w.accessor(Float32Array.from(rb.colors), 'VEC4', GL.ARRAY_BUFFER);
      // mirroring transforms reverse the triangles' winding
      const flip = xf ? determinant4(xf) < 0 : false;
      for (const grp of rb.groups) {
        let idx: ArrayLike<number> = rb.indices.subarray(grp.start, grp.start + grp.count);
        if (flip) {
          const f = new Uint32Array(idx.length);
          for (let i = 0; i < idx.length; i += 3) {
            f[i] = idx[i];
            f[i + 1] = idx[i + 2];
            f[i + 2] = idx[i + 1];
          }
          idx = f;
        }
        g.groups.push({ materialIndex: grp.materialIndex, indices: w.indices(idx, nv) });
      }
    }
    if (withLines && mesh.looseEdges.length) {
      const remap = new Map<number, number>();
      const lp: number[] = [];
      const li: number[] = [];
      for (const v of mesh.looseEdges) {
        let i = remap.get(v);
        if (i === undefined) {
          i = remap.size;
          remap.set(v, i);
          lp.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
        }
        li.push(i);
      }
      const p = new Float32Array(lp.length);
      transformInto(lp, xf, false, p);
      g.lines = {
        attributes: { POSITION: w.accessor(p, 'VEC3', GL.ARRAY_BUFFER, true) },
        indices: w.indices(li, remap.size),
      };
    }
    return g;
  };
  /**
   * Morph targets: POSITION (and NORMAL when the render vertex layout matches) deltas of `shapes`
   * (full position arrays of the mesh's vertices) relative to `base`, both transformed by `xf`.
   */
  const writeTargets = (
    g: Geometry,
    base: MeshData,
    shapes: (ArrayLike<number> | null)[],
    xf: Mat4 | null,
  ): void => {
    const rb = g.rb;
    if (!rb) return;
    const nv = rb.positions.length / 3;
    const src = rb.vertexSource;
    const basePos = new Float32Array(nv * 3);
    const baseNrm = new Float32Array(nv * 3);
    transformInto(rb.positions, xf, false, basePos);
    transformInto(rb.normals, xf, true, baseNrm);
    const shapePos = new Float64Array(nv * 3);
    const tp = new Float32Array(nv * 3);
    const tn = new Float32Array(nv * 3);
    let normals = true;
    for (const shape of shapes) {
      const dp = new Float32Array(nv * 3);
      const dn = new Float32Array(nv * 3);
      if (shape) {
        for (let i = 0; i < nv; i++) {
          const s = src[i] * 3;
          shapePos[i * 3] = shape[s];
          shapePos[i * 3 + 1] = shape[s + 1];
          shapePos[i * 3 + 2] = shape[s + 2];
        }
        transformInto(shapePos, xf, false, tp);
        for (let i = 0; i < nv * 3; i++) dp[i] = tp[i] - basePos[i];
        // normals of the shape (same topology, so the same render vertex layout)
        const rk = buildRenderBuffers({ ...base, positions: Array.from(shape) });
        if (rk.normals.length === rb.normals.length && sameIndices(rk.vertexSource, src)) {
          transformInto(rk.normals, xf, true, tn);
          for (let i = 0; i < nv * 3; i++) dn[i] = tn[i] - baseNrm[i];
        } else normals = false;
      }
      const target: Record<string, number> = { POSITION: w.accessor(dp, 'VEC3', GL.ARRAY_BUFFER, true) };
      target.NORMAL = w.accessor(dn, 'VEC3', GL.ARRAY_BUFFER);
      g.targets.push(target);
    }
    // every target needs the same attributes
    if (!normals) for (const t of g.targets) delete t.NORMAL;
  };

  // ---------------------------------------------------------------- meshes
  const meshes: GltfMesh[] = [];
  const meshOf = new Map<Geometry, Map<string, number>>();
  const skins: GltfSkin[] = [];
  const weightsByNode = new Map<
    XNode,
    { item: ExportItem; count: number; values: Float32Array; baked: boolean }
  >();
  /** Generated UVs per source mesh (procedural textures on meshes without UVs). */
  const generatedUv = new Map<MeshData, MeshData>();
  const withGeneratedUvs = (mesh: MeshData): MeshData => {
    let g = generatedUv.get(mesh);
    if (!g) {
      g = smartProject(mesh, emptySelection(), { islandMargin: 0.02 }).mesh;
      generatedUv.set(mesh, g);
    }
    return g;
  };
  const overlaps = new Map<MeshData, number>();
  const overlapOf = (mesh: MeshData): number => {
    let o = overlaps.get(mesh);
    if (o === undefined) overlaps.set(mesh, (o = uvOverlapFraction(mesh)));
    return o;
  };
  /**
   * The mesh written for an item, and the materials it generated UVs for: position-dependent
   * (GENERATED/OBJECT) procedural textures need UVs to be baked into, so a mesh without UVs gets
   * them (Smart UV Project); UV-mapped ones show a constant on a mesh without UVs, like in the
   * renderers, and need none. UVs that overlap (mirrored or stacked islands) would bake several
   * surfaces into the same texels: they are replaced by generated ones too, unless a material of
   * the mesh needs them (image textures, UV-mapped procedurals), which leaves `overlap` set.
   */
  const writtenMesh = (
    it: ExportItem,
  ): { mesh: MeshData; needing: (MaterialData | null)[]; overlap: number; kept: boolean } => {
    const mesh = plans.get(it)!.mesh;
    const positional = mesh.faces.length
      ? it.materials.filter((m) => !!proceduralSurface(m)?.usesObject)
      : [];
    if (!positional.length) return { mesh, needing: [], overlap: 0, kept: false };
    if (!mesh.uvs) return { mesh: withGeneratedUvs(mesh), needing: positional, overlap: 0, kept: false };
    const overlap = overlapOf(mesh);
    if (overlap <= UV_OVERLAP_LIMIT) return { mesh, needing: [], overlap: 0, kept: false };
    const needsUvs = it.materials.some(
      (m) =>
        !!m &&
        (!!proceduralSurface(m)?.usesUv ||
          Object.values(m.textures ?? {}).some((slot) => !!slot && !!slot.image && !slot.procedural)),
    );
    if (needsUvs) return { mesh, needing: positional, overlap, kept: true };
    return { mesh: withGeneratedUvs(mesh), needing: positional, overlap, kept: false };
  };
  const bakedPlan = planBakes(deformations, frames, plans, warn, (it) => {
    const { mesh } = writtenMesh(it);
    return mesh.faces.length ? renderBuffersOf(mesh).positions.length / 3 : 0;
  });
  const exportMesh = (n: XNode): number | undefined => {
    const it = n.item!;
    const plan = plans.get(it)!;
    const { mesh, needing, overlap, kept } = writtenMesh(it);
    const generatedUvs = needing.length > 0 && !kept;
    const mats = needing.map((m) => `'${m!.name}'`).join(', ');
    const share = `${Math.max(1, Math.round(overlap * 100))}% of the UV layout is used by more than one face`;
    if (kept)
      warn(
        `Mesh '${it.ev.name}': its UVs overlap (${share}), so the baked procedural textures of ${mats} (GENERATED/OBJECT mapping) are wrong where faces share texels; its UVs are kept for its image textures / UV-mapped procedurals (unwrap it without overlaps, e.g. uv.smart_project)`,
      );
    else if (generatedUvs && overlap > 0)
      warn(
        `Mesh '${it.ev.name}': its UVs overlap (${share}): generated UVs (Smart UV Project) replace them to bake the procedural textures of ${mats}`,
      );
    else if (generatedUvs)
      warn(
        `Mesh '${it.ev.name}' has no UVs: generated UVs (Smart UV Project) to bake the procedural textures of ${mats}`,
      );
    const baked = bakedPlan.get(it);
    let g: Geometry;
    if (plan.mode === 'skin') {
      const xf = it.ev.worldMatrix;
      g = geometryOf(it, `skin|${generatedUvs}`, () => {
        const geo = writeGeometry(mesh, xf, false);
        if (plan.keys.length) {
          writeTargets(geo, mesh, keyShapes(plan), xf);
          geo.targetNames = plan.keys.map((k) => k.name);
        }
        return geo;
      });
    } else if (plan.mode === 'morph') {
      g = geometryOf(plan.mesh, `morph|${generatedUvs}`, () => {
        const geo = writeGeometry(mesh, null, false);
        writeTargets(geo, mesh, keyShapes(plan), null);
        geo.targetNames = plan.keys.map((k) => k.name);
        return geo;
      });
    } else if (baked) {
      g = geometryOf(it, `baked|${generatedUvs}`, () => {
        const geo = writeGeometry(mesh, null, false);
        writeTargets(
          geo,
          mesh,
          baked.frames.map((fi) => deformations.get(it)![fi]?.positions ?? mesh.positions),
          null,
        );
        geo.targetNames = baked.frames.map((fi) => `frame ${frames[fi]}`);
        return geo;
      });
    } else g = geometryOf(plan.mesh, `static|${generatedUvs}`, () => writeGeometry(mesh, null, true));
    const surface: Surface = { mesh, it, generatedUvs };
    const primitives: GltfPrimitive[] = [];
    const skinAttrs = plan.mode === 'skin' ? skinAttributes(n, g) : null;
    for (const grp of g.groups) {
      const prim: GltfPrimitive = {
        attributes: skinAttrs ? { ...g.attributes, ...skinAttrs } : g.attributes,
        indices: grp.indices,
      };
      const mat = it.materials[grp.materialIndex];
      if (mat) prim.material = materialIndex(mat, surface);
      if (g.targets.length) prim.targets = g.targets;
      primitives.push(prim);
    }
    if (g.lines) primitives.push({ attributes: g.lines.attributes, indices: g.lines.indices, mode: 1 });
    if (!primitives.length) return undefined;
    // one glTF mesh per geometry and material assignment (vertex data shared, see `geometryOf`)
    const key = primitives.map((p) => `${p.material ?? '-'}`).join(',') + (skinAttrs ? `|${n.index}` : '');
    let byMats = meshOf.get(g);
    const cached = byMats?.get(key);
    if (cached !== undefined) return cached;
    const dataName = it.ev.data.data ? doc.getMeshBlock(it.ev.data.data)?.name : undefined;
    const out: GltfMesh = { name: dataName ?? it.ev.name, primitives };
    if (g.targets.length) {
      out.extras = { targetNames: g.targetNames };
      out.weights = baked
        ? new Array<number>(g.targets.length).fill(0)
        : Array.from(shapeKeyWeights(exportFrameState, plan));
    }
    meshes.push(out);
    if (!byMats) meshOf.set(g, (byMats = new Map()));
    byMats.set(key, meshes.length - 1);
    return meshes.length - 1;
  };

  /** JOINTS_0 / WEIGHTS_0 of a skinned mesh node and its skin (created once per node). */
  const skinOfNode = new Map<XNode, number>();
  const skinAttributes = (n: XNode, g: Geometry): Record<string, number> | null => {
    const it = n.item!;
    const plan = plans.get(it)!;
    const sp = plan.skin!;
    const armItem = sp.armature;
    const pose = armItem.ev.pose!;
    const bonesMap = boneNodes.get(armItem.ev.id)!;
    const armNode = objectNode.get(armItem.ev.id)!;
    const bones = deformBones(pose);
    const rb = g.rb;
    if (!rb) return null;
    const nv = rb.positions.length / 3;
    const base = plan.mesh;
    const vcount = base.positions.length / 3;
    // per mesh vertex: (bone index, weight) influences (Armature modifier semantics)
    const groups = new Map(
      (plan.meshId ? doc.getVertexGroups(plan.meshId) : []).map((grp) => [grp.name, grp]),
    );
    const perBone: (Float32Array | null)[] = bones.map(() => null);
    if (sp.params.use_vertex_groups)
      bones.forEach((b, i) => {
        const grp = groups.get(b.name);
        if (!grp) return;
        const wts = decodeFloat32(grp.weights);
        if (wts.length === vcount) perBone[i] = wts;
      });
    const armWorld = armItem.ev.worldMatrix;
    const toArm = (() => {
      const inv = invertAffine(armWorld);
      return inv ? multiply4(inv, it.ev.worldMatrix) : IDENTITY;
    })();
    if (sp.params.use_bone_envelopes) {
      const has = new Uint8Array(vcount);
      for (const wts of perBone) if (wts) for (let v = 0; v < vcount; v++) if (wts[v] > 0) has[v] = 1;
      const p = base.positions;
      bones.forEach((b, i) => {
        let env: Float32Array | null = null;
        for (let v = 0; v < vcount; v++) {
          if (has[v]) continue;
          const x = p[v * 3];
          const y = p[v * 3 + 1];
          const z = p[v * 3 + 2];
          const q: Vec3 = [
            toArm[0] * x + toArm[4] * y + toArm[8] * z + toArm[12],
            toArm[1] * x + toArm[5] * y + toArm[9] * z + toArm[13],
            toArm[2] * x + toArm[6] * y + toArm[10] * z + toArm[14],
          ];
          const wv = boneEnvelopeWeight(b, q);
          if (!(wv > 0)) continue;
          if (!env) env = perBone[i] ? Float32Array.from(perBone[i]!) : new Float32Array(vcount);
          env[v] = wv;
        }
        if (env) perBone[i] = env;
      });
    }
    let mask: Float32Array | null = null;
    const mg = sp.params.vertex_group ? groups.get(sp.params.vertex_group) : undefined;
    if (mg) {
      const wts = decodeFloat32(mg.weights);
      if (wts.length === vcount)
        mask = wts.map((x) => {
          const c = Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
          return sp.params.invert_vertex_group ? 1 - c : c;
        });
    }
    // joints: the deform bones, plus the armature node itself for vertices that do not move with
    // any bone (no weights, or the Armature modifier's vertex group mask)
    const joints = bones.map((b) => bonesMap.get(b.name)!.index);
    const staticJoint = joints.length;
    let usesStatic = false;
    let truncated = 0;
    const J = new Uint16Array(nv * 4);
    const W = new Float32Array(nv * 4);
    const infl: { j: number; w: number }[] = [];
    for (let i = 0; i < nv; i++) {
      const v = rb.vertexSource[i];
      infl.length = 0;
      let total = 0;
      perBone.forEach((wts, j) => {
        const x = wts ? wts[v] : 0;
        if (x > 0 && Number.isFinite(x)) {
          infl.push({ j, w: x });
          total += x;
        }
      });
      const m = mask ? mask[v] : 1;
      if (!(total > 1e-4) || m <= 0) {
        infl.length = 0;
        infl.push({ j: staticJoint, w: 1 });
        usesStatic = true;
      } else {
        for (const e of infl) e.w = (e.w / total) * m;
        if (m < 1) {
          infl.push({ j: staticJoint, w: 1 - m });
          usesStatic = true;
        }
      }
      if (infl.length > MAX_INFLUENCES) {
        infl.sort((a, b) => b.w - a.w);
        truncated++;
        infl.length = MAX_INFLUENCES;
      }
      let s = 0;
      for (const e of infl) s += e.w;
      for (let k = 0; k < infl.length; k++) {
        J[i * 4 + k] = infl[k].j;
        W[i * 4 + k] = infl[k].w / s;
      }
    }
    if (truncated)
      warn(
        `Skinned mesh '${it.ev.name}': ${truncated} vertices have more than ${MAX_INFLUENCES} bone influences; the ${MAX_INFLUENCES} strongest are exported`,
      );
    if (sp.params.use_deform_preserve_volume)
      warn(
        `Skinned mesh '${it.ev.name}': Preserve Volume (dual quaternion skinning) is exported as linear blend skinning (glTF)`,
      );
    let skin = skinOfNode.get(n);
    if (skin === undefined) {
      const jointNodes = usesStatic ? [...joints, armNode.index] : joints;
      // inverse bind matrices: glTF world (Y-up) → joint space at rest; vertices are the rest mesh
      // in world space, so a joint posed at rest leaves them in place
      const ibm = new Float32Array(jointNodes.length * 16);
      const restWorld = (b: PoseBoneMatrix) => multiply4(M_Z_TO_Y, multiply4(armWorld, b.rest));
      bones.forEach((b, k) => ibm.set(invertAffine(restWorld(b)) ?? IDENTITY, k * 16));
      if (usesStatic) {
        const armGltf = multiply4(M_Z_TO_Y, multiply4(armWorld, M_Y_TO_Z));
        ibm.set(invertAffine(armGltf) ?? IDENTITY, bones.length * 16);
      }
      skins.push({
        name: `${it.ev.name} (${armItem.ev.name})`,
        inverseBindMatrices: w.accessor(ibm, 'MAT4'),
        skeleton: armNode.index,
        joints: jointNodes,
      });
      skin = skins.length - 1;
      skinOfNode.set(n, skin);
    }
    const jointsData = skins[skin].joints.length <= 256 ? Uint8Array.from(J) : J;
    return {
      JOINTS_0: w.accessor(jointsData, 'VEC4', GL.ARRAY_BUFFER),
      WEIGHTS_0: w.accessor(W, 'VEC4', GL.ARRAY_BUFFER),
    };
  };

  // ---------------------------------------------------------------- cameras / lights
  const cameras: GltfCamera[] = [];
  const cameraOf = new Map<string, number>();
  const cameraIndex = (cam: CameraData): number => {
    const cached = cameraOf.get(cam.id);
    if (cached !== undefined) return cached;
    const znear = Math.max(1e-6, cam.clip_start);
    const zfar = Math.max(znear * 1.0001, cam.clip_end);
    if (cam.shift_x || cam.shift_y) warn(`Camera '${cam.name}': lens shift cannot be exported to glTF`);
    if (cam.type === 'ORTHO') {
      const { halfW, halfH } = orthoHalfExtents(cam, aspect);
      cameras.push({
        name: cam.name,
        type: 'orthographic',
        orthographic: { xmag: halfW, ymag: halfH, znear, zfar },
      });
    } else
      cameras.push({
        name: cam.name,
        type: 'perspective',
        perspective: { aspectRatio: aspect, yfov: cameraFovY(cam, aspect), znear, zfar },
      });
    cameraOf.set(cam.id, cameras.length - 1);
    return cameras.length - 1;
  };

  const lights: GltfLight[] = [];
  const lightOf = new Map<string, number>();
  const lightIndex = (l: LightData): number => {
    const cached = lightOf.get(l.id);
    if (cached !== undefined) return cached;
    const color = [Math.max(0, l.color[0]), Math.max(0, l.color[1]), Math.max(0, l.color[2])];
    let out: GltfLight;
    if (l.type === 'SUN')
      out = { name: l.name, type: 'directional', color, intensity: Math.max(0, l.energy) };
    else {
      const candela = Math.max(0, l.energy) / (4 * Math.PI);
      if (l.type === 'SPOT') {
        const outer = Math.min(Math.PI / 2, Math.max(1e-4, l.spot_size / 2));
        const inner = Math.max(0, Math.min(outer * (1 - clamp01(l.spot_blend)), outer * 0.9999));
        out = {
          name: l.name,
          type: 'spot',
          color,
          intensity: candela,
          spot: { innerConeAngle: inner, outerConeAngle: outer },
        };
      } else {
        if (l.type === 'AREA') warn(`Area light '${l.name}' exported as a point light`);
        out = { name: l.name, type: 'point', color, intensity: candela };
      }
    }
    lights.push(out);
    w.extensionsUsed.add('KHR_lights_punctual');
    lightOf.set(l.id, lights.length - 1);
    return lights.length - 1;
  };

  // ---------------------------------------------------------------- nodes
  const nodes: GltfNode[] = [];
  for (const n of order) {
    const node: GltfNode = { name: n.name };
    const trs = staticTRS(n);
    if (trs?.matrix && !moving.has(n)) node.matrix = [...trs.matrix];
    else if (trs) {
      if (!isDefault(trs.t, [0, 0, 0])) node.translation = [...trs.t];
      const q = normalizeQuat(trs.q);
      if (!isDefault(q, [0, 0, 0, 1])) node.rotation = q;
      if (!isDefault(trs.s, [1, 1, 1])) node.scale = [...trs.s];
    }
    if (n.children.length) node.children = n.children.map((c) => c.index);
    nodes.push(node);
  }
  for (const n of order) {
    const it = n.item;
    if (!it) continue;
    const node = nodes[n.index];
    const ev = it.ev;
    if (it.mesh && (it.mesh.faces.length || it.mesh.looseEdges.length)) {
      const mi = exportMesh(n);
      if (mi !== undefined) {
        node.mesh = mi;
        const skin = skinOfNode.get(n);
        if (skin !== undefined) node.skin = skin;
        const plan = plans.get(it)!;
        const baked = bakedPlan.get(it);
        if (frames.length && baked)
          weightsByNode.set(n, { item: it, count: baked.frames.length, values: baked.weights, baked: true });
        else if (frames.length && plan.keys.length && meshes[mi].primitives.some((p) => p.targets)) {
          const values = weightTracks.get(it);
          if (values && varies(values, plan.keys.length))
            weightsByNode.set(n, { item: it, count: plan.keys.length, values, baked: false });
        }
      }
    } else if (ev.type === 'CAMERA' && ev.camera) node.camera = cameraIndex(ev.camera);
    else if (ev.type === 'LIGHT' && ev.light)
      node.extensions = { KHR_lights_punctual: { light: lightIndex(ev.light) } };
    if (ev.data.custom_props && Object.keys(ev.data.custom_props).length && !it.instance)
      node.extras = { ...ev.data.custom_props };
  }
  for (const [it, plan] of plans)
    if (plan.why && plan.why !== 'topology' && deformations.has(it) && !bakedPlan.has(it))
      warn(
        `Mesh '${it.ev.name}' deforms during the animation (${plan.why}) but was exported as at frame ${scene.frame}`,
      );

  // ---------------------------------------------------------------- animation
  if (frames.length) {
    const anim: GltfAnimation = { name: sceneSettings.name || 'Animation', channels: [], samplers: [] };
    const times = new Float32Array(frames.length);
    for (let i = 0; i < frames.length; i++) times[i] = (frames[i] - start) / fps;
    let input = -1;
    const timeInput = () => (input >= 0 ? input : (input = w.accessor(times, 'SCALAR', undefined, true)));
    const channel = (
      node: number,
      path: string,
      data: Float32Array,
      type: 'VEC3' | 'VEC4' | 'SCALAR',
      inp: number,
    ) => {
      anim.samplers.push({ input: inp, output: w.accessor(data, type), interpolation: 'LINEAR' });
      anim.channels.push({ sampler: anim.samplers.length - 1, target: { node, path } });
    };
    /** Time accessors of sub-frame tracks, shared by tracks with the same key times. */
    const fineInputs = new Map<string, number>();
    for (const n of order) {
      const coarse = tracks.get(n);
      if (!coarse || !moving.has(n)) continue;
      const fine = fineTracks.get(n);
      const tr = fine ?? coarse;
      const inp = () => {
        if (!fine) return timeInput();
        let index = fineInputs.get(fine.sig);
        if (index === undefined) {
          const t = new Float32Array(fine.frames.length);
          for (let i = 0; i < t.length; i++) t[i] = (fine.frames[i] - start) / fps;
          index = w.accessor(t, 'SCALAR', undefined, true);
          fineInputs.set(fine.sig, index);
        }
        return index;
      };
      if (varies(tr.t, 3)) channel(n.index, 'translation', tr.t, 'VEC3', inp());
      if (varies(tr.r, 4)) channel(n.index, 'rotation', tr.r, 'VEC4', inp());
      if (varies(tr.s, 3)) channel(n.index, 'scale', tr.s, 'VEC3', inp());
    }
    for (const [n, wt] of weightsByNode) {
      if (wt.baked) {
        const b = bakedPlan.get(wt.item)!;
        const t = new Float32Array(b.frames.length);
        b.frames.forEach((fi, k) => (t[k] = times[fi]));
        channel(n.index, 'weights', wt.values, 'SCALAR', w.accessor(t, 'SCALAR', undefined, true));
      } else channel(n.index, 'weights', wt.values, 'SCALAR', timeInput());
    }
    if (anim.channels.length) json.animations = [anim];
  }

  // ---------------------------------------------------------------- assemble
  for (const [id, names] of bakedNames) {
    if (names.length < 2) continue;
    const m = doc.getMaterial(id);
    const list =
      names.length > 3 ? `${names[0]}, ${names[1]} … ${names[names.length - 1]}` : names.join(', ');
    const why =
      m && proceduralBakeNeedsGeometry(m)
        ? 'its procedural textures depend on the surface (GENERATED/OBJECT mapping or a bump), so they are baked for each mesh'
        : m && hasProceduralTextures(m)
          ? 'meshes without UVs get its UV-mapped procedural textures as constant values (as the renderers show them), the others baked images'
          : 'meshes without UVs cannot use its image textures';
    warn(`Material '${m?.name ?? names[0]}' is exported as ${names.length} glTF materials (${list}): ${why}`);
  }
  if (!nodes.length) warn('No objects to export');
  const rootNodes = order.filter((n) => !n.parent).map((n) => n.index);
  json.scene = 0;
  json.scenes = [
    rootNodes.length ? { name: scene.scene.name, nodes: rootNodes } : { name: scene.scene.name },
  ];
  if (nodes.length) json.nodes = nodes;
  if (meshes.length) json.meshes = meshes;
  if (materials.length) json.materials = materials;
  if (textures.length) json.textures = textures;
  if (images.length) json.images = images;
  if (cameras.length) json.cameras = cameras;
  if (skins.length) json.skins = skins;
  if (lights.length) json.extensions = { KHR_lights_punctual: { lights } };
  if (w.accessors.length) json.accessors = w.accessors;
  if (w.bufferViews.length) json.bufferViews = w.bufferViews;
  if (w.extensionsUsed.size) json.extensionsUsed = [...w.extensionsUsed].sort();
  const bin = w.bin.length ? w.bin.finish() : null;
  if (binary) {
    if (bin) json.buffers = [{ byteLength: bin.length }];
    return { data: writeGLB(json, bin), mime: 'model/gltf-binary', extension: 'glb', warnings };
  }
  if (bin)
    json.buffers = [
      { byteLength: bin.length, uri: `data:application/octet-stream;base64,${base64Encode(bin)}` },
    ];
  return { data: utf8Encode(JSON.stringify(json)), mime: 'model/gltf+json', extension: 'gltf', warnings };
}

// ------------------------------------------------------------------ helpers

/**
 * Chord error estimate of each interval between consecutive keys of a per-frame translation track
 * (xyz per key): the sagitta of the circular arc through the interval's keys and a neighbouring
 * key (the larger of the two neighbours). A path that turns at a key (a collision, LINEAR
 * keyframes) looks bent here too: the exporter samples the scene between the frames to tell.
 */
function chordErrors(t: Float32Array): Float64Array {
  const n = t.length / 3;
  const est = new Float64Array(Math.max(0, n - 1));
  const p = (i: number, k: number) => t[i * 3 + k];
  for (let i = 0; i + 2 < n; i++) {
    const ux = p(i + 1, 0) - p(i, 0);
    const uy = p(i + 1, 1) - p(i, 1);
    const uz = p(i + 1, 2) - p(i, 2);
    const vx = p(i + 2, 0) - p(i, 0);
    const vy = p(i + 2, 1) - p(i, 1);
    const vz = p(i + 2, 2) - p(i, 2);
    const a = Math.hypot(ux, uy, uz);
    const b = Math.hypot(p(i + 2, 0) - p(i + 1, 0), p(i + 2, 1) - p(i + 1, 1), p(i + 2, 2) - p(i + 1, 2));
    const c = Math.hypot(vx, vy, vz);
    const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    if (!(area > 1e-12 * (a * b + 1e-30))) continue;
    // circumradius R = abc / (4 · area); the sagitta of a chord of length L is R − √(R² − L²/4),
    // written as (L²/4) / (R + √(R² − L²/4)) to stay exact for nearly straight paths
    const R = (a * b * c) / (4 * area);
    const sagitta = (L: number) => (L * L) / 4 / (R + Math.sqrt(Math.max(0, R * R - (L * L) / 4)));
    est[i] = Math.max(est[i], sagitta(a));
    est[i + 1] = Math.max(est[i + 1], sagitta(b));
  }
  return est;
}

/** Acceptable chord error of a translation track: 0.5 mm, or 0.1% of the path's extent. */
function chordTolerance(t: Float32Array): number {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], t[i]);
    hi[i % 3] = Math.max(hi[i % 3], t[i]);
  }
  return Math.max(0.0005, 0.001 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
}

/** Whether any value of a per-frame track (stride values per frame) differs from the first frame. */
function varies(data: Float32Array, stride: number): boolean {
  for (let i = stride; i < data.length; i++) {
    const a = data[i % stride];
    if (Math.abs(data[i] - a) > 1e-6 * (1 + Math.abs(a))) return true;
  }
  return false;
}

/**
 * Whether the scene can change over its frame range: F-curves with keys, drivers, a rigid body
 * world or time-dependent modifiers. Without any of them no animation is sampled.
 */
function sceneMayAnimate(doc: SceneDoc): boolean {
  if (doc.listFCurves().some((fc) => !fc.mute && fc.keyframes.length > 0)) return true;
  if (doc.listDrivers().some((d) => !d.mute)) return true;
  const objects = doc.listObjects();
  if (doc.getScene().rigidbody_world?.enabled && objects.some((o) => o.rigid_body?.enabled)) return true;
  return objects.some((o) => o.modifiers.some((m) => isModifierTimeDependent(m)));
}

const MODIFIER_FLAGS = { forRender: true, editMode: false } as const;

/** How a mesh item's deformation is exported (see the file comment). */
function planMesh(
  doc: SceneDoc,
  it: ExportItem,
  itemById: Map<string, ExportItem>,
  applyModifiers: boolean,
  fs: FrameState,
): MeshPlan {
  const ev = it.ev;
  const fallback: MeshPlan = { mode: 'static', mesh: it.mesh!, keys: [], meshId: null };
  if (it.instance || ev.type !== 'MESH' || !ev.data.data || !ev.baseMesh) return fallback;
  const meshId = ev.data.data;
  const basis = ev.baseMesh;
  const n = basis.positions.length;
  const keys = (fs.get<{ shape_keys: ShapeKeyData[] }>('mesh', meshId)?.shape_keys ?? []).filter(
    (k) => decodeFloat32(k.data).length === n,
  );
  if (!applyModifiers) {
    // the modifiers are not applied (the base mesh is written), but an Armature modifier is a
    // skin, not geometry: like Blender's exporter, the mesh keeps it (the first enabled Armature
    // modifier whose armature is exported)
    for (const m of ev.data.modifiers) {
      if (m.type !== 'ARMATURE' || !isModifierEnabled(m, MODIFIER_FLAGS)) continue;
      const arm = armaturePlan(doc, m, itemById);
      if (arm) return { mode: 'skin', mesh: basis, keys, meshId, skin: arm };
    }
  }
  const mods = applyModifiers ? ev.data.modifiers.filter((m) => isModifierEnabled(m, MODIFIER_FLAGS)) : [];
  if (!mods.length) {
    if (keys.length) return { mode: 'morph', mesh: basis, keys, meshId };
    return { ...fallback, meshId };
  }
  const last = mods[mods.length - 1];
  const arm = last.type === 'ARMATURE' ? armaturePlan(doc, last, itemById) : null;
  if (arm && mods.length === 1) return { mode: 'skin', mesh: basis, keys, meshId, skin: arm };
  let why = 'modifiers';
  if (mods.some((m) => m.type === 'ARMATURE')) {
    const target = mods.find((m) => m.type === 'ARMATURE')!;
    why = armaturePlan(doc, target, itemById)
      ? 'its Armature modifier is not the only modifier: glTF skins need the Armature modifier alone'
      : 'its armature is not exported';
  } else if (keys.length) why = 'shape keys under modifiers';
  return { ...fallback, meshId, keys: [], why };
}

/** The Armature modifier's armature (an exported armature with a pose) and parameters, or null. */
function armaturePlan(doc: SceneDoc, mod: ModifierData, itemById: Map<string, ExportItem>): SkinPlan | null {
  const def = getModifierDef('ARMATURE');
  const parsed = def?.schema.safeParse(mod.params ?? {});
  if (!parsed?.success) return null;
  const p = parsed.data as SkinPlan['params'] & { object?: string | null };
  if (!p.object || (!p.use_vertex_groups && !p.use_bone_envelopes)) return null;
  const target = doc.resolveObject(p.object);
  const armature = target ? itemById.get(target.id) : undefined;
  if (!armature || armature.instance || armature.ev.type !== 'ARMATURE' || !armature.ev.pose) return null;
  return {
    armature,
    params: {
      use_vertex_groups: p.use_vertex_groups,
      use_bone_envelopes: p.use_bone_envelopes,
      use_deform_preserve_volume: p.use_deform_preserve_volume,
      vertex_group: p.vertex_group,
      invert_vertex_group: p.invert_vertex_group,
    },
  };
}

/** Morph target weights of a plan's shape keys at the frame of a frame state (muted keys: 0). */
function shapeKeyWeights(fs: FrameState, plan: MeshPlan): Float32Array {
  const out = new Float32Array(plan.keys.length);
  const current = plan.meshId
    ? (fs.get<{ shape_keys: ShapeKeyData[] }>('mesh', plan.meshId)?.shape_keys ?? [])
    : [];
  plan.keys.forEach((k, i) => {
    const c = current.find((x) => x.name === k.name) ?? k;
    out[i] = c.mute
      ? 0
      : Math.min(c.slider_max, Math.max(c.slider_min, Number.isFinite(c.value) ? c.value : 0));
  });
  return out;
}

/** Full positions of every shape key of a plan (relative keys resolved: basis + (key − reference)). */
function keyShapes(plan: MeshPlan): Float64Array[] {
  const basis = plan.mesh.positions;
  const decoded = new Map(plan.keys.map((k) => [k.name, decodeFloat32(k.data)]));
  return plan.keys.map((k) => {
    const d = decoded.get(k.name)!;
    const ref = k.relative_key && k.relative_key !== k.name ? decoded.get(k.relative_key) : undefined;
    const out = new Float64Array(basis.length);
    for (let i = 0; i < basis.length; i++) out[i] = basis[i] + d[i] - (ref ? ref[i] : basis[i]);
    return out;
  });
}

/** Frames (indices) and one-hot weights of a baked deformation. */
interface BakePlan {
  frames: number[];
  /** Per keyframe: one weight per target. */
  weights: Float32Array;
}

/**
 * Which frames of the deforming meshes become morph targets: every frame within the budget (one
 * target per frame), else every k-th frame. Weights: target i is 1 at its frame. `writtenVertices`:
 * the number of vertices written for an item's mesh (the size of each of its targets).
 */
function planBakes(
  deformations: Map<ExportItem, (MeshData | null)[]>,
  frames: number[],
  plans: Map<ExportItem, MeshPlan>,
  warn: (msg: string) => void,
  writtenVertices: (it: ExportItem) => number,
): Map<ExportItem, BakePlan> {
  const out = new Map<ExportItem, BakePlan>();
  // POSITION + NORMAL deltas (3 floats each) per written vertex, of one frame of every mesh
  let perFrame = 0;
  for (const [it] of deformations) perFrame += writtenVertices(it) * 6;
  // every step-th frame and the last one: at most `maxTargets` targets (at least the first and last)
  const maxTargets = Math.max(2, Math.floor(MAX_BAKED_FLOATS / Math.max(1, perFrame)));
  const step = frames.length <= maxTargets ? 1 : Math.ceil((frames.length - 1) / (maxTargets - 1));
  for (const [it] of deformations) {
    const plan = plans.get(it)!;
    if (plan.why === 'topology') continue;
    const picked: number[] = [];
    for (let fi = 0; fi < frames.length; fi += step) picked.push(fi);
    if (picked[picked.length - 1] !== frames.length - 1) picked.push(frames.length - 1);
    const k = picked.length;
    const weights = new Float32Array(k * k);
    for (let i = 0; i < k; i++) weights[i * k + i] = 1;
    out.set(it, { frames: picked, weights });
    warn(
      `Mesh '${it.ev.name}' deforms during the animation (${plan.why ?? 'modifiers'}): baked as ${k} morph targets` +
        (step > 1 ? ` (every ${ordinal(step)} frame, to keep the file small)` : ''),
    );
  }
  return out;
}

/** 2 → '2nd', 11 → '11th', 23 → '23rd'. */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix =
    tens >= 11 && tens <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

function samePositions(a: MeshData, b: MeshData): boolean {
  if (a.positions === b.positions) return true;
  if (a.positions.length !== b.positions.length) return false;
  for (let i = 0; i < a.positions.length; i++)
    if (Math.abs(a.positions[i] - b.positions[i]) > 1e-7 * (1 + Math.abs(b.positions[i]))) return false;
  return true;
}

function sameTopology(a: MeshData, b: MeshData): boolean {
  if (a.positions.length !== b.positions.length || a.faces.length !== b.faces.length) return false;
  if (a.faces === b.faces) return true;
  for (let f = 0; f < a.faces.length; f++) {
    const x = a.faces[f];
    const y = b.faces[f];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}

function sameIndices(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Linear (3×3) part of an affine matrix, as a 4×4 without translation. */
function linearPart(m: Readonly<Mat4>): Mat4 {
  return [m[0], m[1], m[2], 0, m[4], m[5], m[6], 0, m[8], m[9], m[10], 0, 0, 0, 0, 1];
}

/** Inverse transpose of the linear part (transforms normals). */
function normalPart(m: Readonly<Mat4>): Mat4 {
  const inv = invertAffine(linearPart(m)) ?? IDENTITY;
  return [inv[0], inv[4], inv[8], 0, inv[1], inv[5], inv[9], 0, inv[2], inv[6], inv[10], 0, 0, 0, 0, 1];
}

/**
 * Transforms xyz triples (positions, or normals with `normals`: by the inverse transpose and
 * renormalized unless `renormalize` is false) by `m` (null: as they are) and converts them to Y-up.
 */
function transformInto(
  src: ArrayLike<number>,
  m: Readonly<Mat4> | null,
  normals: boolean,
  out: Float32Array,
  renormalize = true,
): void {
  const M = m ? (normals ? normalPart(m) : m) : null;
  const n = Math.floor(src.length / 3);
  for (let i = 0; i < n; i++) {
    let x = src[i * 3];
    let y = src[i * 3 + 1];
    let z = src[i * 3 + 2];
    if (M) {
      const tx = M[0] * x + M[4] * y + M[8] * z + (normals ? 0 : M[12]);
      const ty = M[1] * x + M[5] * y + M[9] * z + (normals ? 0 : M[13]);
      const tz = M[2] * x + M[6] * y + M[10] * z + (normals ? 0 : M[14]);
      x = tx;
      y = ty;
      z = tz;
      if (normals && renormalize) {
        const l = Math.hypot(x, y, z) || 1;
        x /= l;
        y /= l;
        z /= l;
      }
    }
    yUp(x, y, z, out, i * 3);
  }
}
