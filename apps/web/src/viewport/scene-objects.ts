import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import {
  buildEdgeIndexList,
  buildRenderBuffers,
  type EvaluatedObject,
  type EvaluatedScene,
  type LightData,
  type MaterialData,
  type MeshData,
  type SceneDoc,
} from '@3d-editor/core';
import { buildMaterial, materialKey, TextureCache, type ShadingKind } from './materials';
import { boneLines, cameraLines, emptyLines, lightLines, linesObject } from './helpers';
import { fitSunShadow, SUN_SHADOW_MAP_SIZE } from './sun-shadow';
import { HIDDEN_LAYER, transmissionOf, transmissionThickness } from './transmission';

/**
 * The three.js material of one material slot of a mesh, with the key it was built for
 * ({@link slotMaterialKey}).
 */
export interface SlotMaterial {
  key: string;
  material: THREE.Material;
  /**
   * The draw contexts it was drawn in ({@link drawContext}): three.js holds a shader program of it
   * for each (see SceneObjects.replaceSlot).
   */
  drawnIn: Set<string>;
  /**
   * Materials the slot drew with before, kept for the draw contexts {@link material} has not been
   * drawn in yet: for each such context, the last one drawn there (see SceneObjects.replaceSlot).
   */
  kept: Map<string, THREE.Material>;
}

/**
 * The draw context of a material drawn after a sync with `opts` (see {@link SlotMaterial.drawnIn}):
 * what the viewport switches between that changes the shader program three.js gives a material for
 * a draw. The shading (Material Preview and Rendered light the scene in different ways: lights,
 * environment, shadows), X-ray in Solid shading (see-through materials have programs of their own)
 * and whether the object drawn is instanced (collection instances, particle scatters). Other
 * changes that give every material other programs (a light added, mist turned on) are not told
 * apart: going back after one links again the programs of the materials changed in between.
 */
export function drawContext(opts: Pick<SyncOptions, 'shading' | 'xray'>, instanced: boolean): string {
  const shading = opts.shading === 'SOLID' && opts.xray ? 'SOLID X-ray' : opts.shading;
  return instanced ? `${shading} instanced` : shading;
}

/** The materials of a mesh's slots in a shading kind, and the array the mesh draws with. */
export interface MaterialSet {
  slots: SlotMaterial[];
  materials: THREE.Material[];
}

/** three.js representation of one document object. */
export interface ObjectView {
  id: string;
  root: THREE.Group;
  overlayRoot: THREE.Group;
  mesh?: THREE.Mesh;
  meshKey?: string;
  /**
   * The mesh's materials by shading kind (Solid and Wireframe, or Material Preview and Rendered),
   * one per material slot: those the mesh draws with, and those it drew with before in the other
   * kind. Those are kept, not disposed, so drawing in their shading again (the viewport switching
   * back, a screenshot or render in another shading than the viewport's, and the viewport's next
   * frame after it) reuses them and the shader programs three.js compiled for them, which it keeps
   * until their materials are disposed. Building and compiling them again took 17–22 s for a scene
   * with 71 materials in software WebGL. Only the material of a slot whose key changed (its
   * material's values, the object colour) is built again, and the one it replaces is kept until the
   * new one has been drawn in each context it was drawn in ({@link drawContext}: the shading, X-ray
   * in Solid shading, instancing): three.js then gives the new one the shader programs of the old
   * one when their code is the same (the program cache key), instead of compiling them again.
   */
  materialSets?: Map<ShadingKind, MaterialSet>;
  wire?: THREE.LineSegments;
  wireKey?: string;
  helper?: THREE.LineSegments;
  helperKey?: string;
  light?: THREE.Light;
  lightKey?: string;
  pickProxy?: THREE.Mesh;
  /** Source polygon per triangle of `mesh` (for face picking). */
  triFace?: Uint32Array;
}

export const COLORS = {
  helper: new THREE.Color(0x000000),
  selected: new THREE.Color(0xf17e2a),
  active: new THREE.Color(0xffb359),
  wire: new THREE.Color(0x111111),
};

let rectInit = false;

/**
 * Budget of shadow-map work for point and spot lights, in triangles drawn per update: a point
 * light's cube map draws every caster six times. Over it, instanced meshes (collection instances,
 * particle scatters: grass, rocks, trees) cast no point or spot light shadows, only sun shadows
 * (lighthouse-cove's 2.5 M instance triangles times two point and two spot lights made 35 M
 * triangles of shadow maps per frame, minutes per frame in software WebGL).
 */
export const LOCAL_SHADOW_TRIANGLE_BUDGET = 4_000_000;
/** Layer of the point and spot lights for {@link SceneObjects.renderLocalShadows} (meshes are not on it). */
export const LOCAL_SHADOW_LAYER = 30;

/** Triangles a mesh draws (instanced meshes: per instance times instances). */
function trianglesOf(m: THREE.Mesh): number {
  const g = m.geometry;
  const n = g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0);
  const count = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
  return (n / 3) * count;
}

/**
 * The three.js intensity of a lamp in Blender's units, exactly as the CPU rasterizer and the path
 * tracer light the scene (core render/index.ts `buildLights`, render/pathtrace/lights.ts), so the
 * WebGL renders (Rendered viewport, F12, Render Animation, MCP renders in a browser) are as bright
 * as theirs:
 * - POINT / SPOT: power P (W) → radiant intensity P / 4π (W/sr); the three.js intensity (candela)
 *   with inverse-square decay gives the same irradiance;
 * - SUN: `energy` is the irradiance (W/m²) of a surface facing it, the three.js directional
 *   intensity;
 * - AREA: a one-sided Lambertian emitter of power P and area A has radiance P / (π·A), the
 *   RectAreaLight intensity; `area` is the world area of the drawn rectangle (scale included), so
 *   the emitted power stays P also for disc and ellipse shapes.
 */
export function lightIntensity(l: Pick<LightData, 'type' | 'energy'>, area = 1): number {
  const p = Number.isFinite(l.energy) ? Math.max(0, l.energy) : 0;
  if (l.type === 'SUN') return p;
  if (l.type === 'AREA') return p / (Math.PI * Math.max(1e-6, area));
  return p / (4 * Math.PI);
}

/**
 * three.js SpotLight `angle` and `penumbra` of a Blender spot cone (full angle `spotSize`, edge
 * softness `blend`): the core renderers fade the light in with a smoothstep from the cone edge
 * (cos ½·size) to cos ½·size + (1 − cos ½·size)·blend, three.js from cos(angle) to
 * cos(angle·(1 − penumbra)).
 */
export function spotCone(spotSize: number, blend: number): { angle: number; penumbra: number } {
  const half = Math.min(Math.PI / 2, Math.max(1e-4, (Number.isFinite(spotSize) ? spotSize : 0) / 2));
  const b = Math.min(1, Math.max(0, Number.isFinite(blend) ? blend : 0));
  const cosHalf = Math.cos(half);
  const inner = Math.acos(Math.min(1, cosHalf + (1 - cosHalf) * b));
  return { angle: half, penumbra: Math.min(1, Math.max(0, 1 - inner / half)) };
}

export function geometryFromMesh(mesh: MeshData): { geometry: THREE.BufferGeometry; triFace: Uint32Array } {
  const rb = buildRenderBuffers(mesh);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(rb.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(rb.normals, 3));
  if (rb.uvs) g.setAttribute('uv', new THREE.BufferAttribute(rb.uvs, 2));
  if (rb.colors) g.setAttribute('color', new THREE.BufferAttribute(rb.colors, 4));
  g.setIndex(new THREE.BufferAttribute(rb.indices, 1));
  for (const grp of rb.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return { geometry: g, triFace: rb.triFace };
}

export function wireGeometry(mesh: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
  g.setIndex(new THREE.BufferAttribute(buildEdgeIndexList(mesh), 1));
  return g;
}

function disposeObject(o: THREE.Object3D): void {
  o.traverse((c) => {
    const any = c as THREE.Mesh;
    any.geometry?.dispose?.();
    const m = any.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(m)) m.forEach((x) => x.dispose());
    else m?.dispose?.();
  });
}

/**
 * The key a slot's material is built for: the material's values, the shading kind, vertex colours,
 * the images and, for a slot without a material, the object colour (Solid shading draws it).
 */
export function slotMaterialKey(
  m: MaterialData | null,
  kind: ShadingKind,
  vertexColors: boolean,
  imagesRevision: number,
  objectColor: readonly number[],
): string {
  return `${materialKey(m, kind, vertexColors, imagesRevision)}${m ? '' : `|${objectColor.join(',')}`}`;
}

/** Opacity of objects in X-ray (Solid shading). */
export const XRAY_OPACITY = 0.45;

/** What X-ray changes on a material, as built (see {@link setXray}). */
const XRAY_BASE = 'pfxXrayBase';

/**
 * Makes a material see-through for X-ray, or as built again. three.js compiles another shader
 * program for a material that turns transparent (its program cache key has `opaque`), and keeps
 * both until the material is disposed: turning X-ray on and off again reuses them.
 */
export function setXray(m: THREE.Material, on: boolean): void {
  const base = (m.userData[XRAY_BASE] ??= {
    transparent: m.transparent,
    opacity: m.opacity,
    depthWrite: m.depthWrite,
  }) as { transparent: boolean; opacity: number; depthWrite: boolean };
  const transparent = on || base.transparent;
  if (m.transparent !== transparent) {
    m.transparent = transparent;
    m.needsUpdate = true;
  }
  m.opacity = on ? Math.min(base.opacity, XRAY_OPACITY) : base.opacity;
  m.depthWrite = on ? false : base.depthWrite;
}

export interface SyncOptions {
  shading: 'WIREFRAME' | 'SOLID' | 'MATERIAL' | 'RENDERED';
  showWireOverlay: boolean;
  xray: boolean;
  selected: Set<string>;
  activeId: string | null;
  editObjectId: string | null;
  renderAspect: number;
  castShadows: boolean;
  imagesRevision: number;
  /**
   * Whether the viewport's overlays are on. Off, the object helpers (cameras, lights, empties,
   * bones, curves without a surface) and the wireframe overlays (Wireframe toggle, `show_wire`,
   * Display As Wire) are hidden and cannot be clicked, like in Blender; Wireframe shading stays.
   */
  overlays: boolean;
}

/** Keeps three.js objects in sync with an evaluated scene (incremental, cached by keys). */
export class SceneObjects {
  readonly views = new Map<string, ObjectView>();
  /** Instanced meshes keyed by `${ownerId}|${sourceId}`. */
  private readonly instanced = new Map<string, THREE.InstancedMesh>();
  readonly textures: TextureCache;
  /** {@link SceneObjects.shadowBoxes} of the last sync (null: not computed yet). */
  private boxes: THREE.Box3[] | null = null;
  /**
   * Whether the shadow maps of point and spot lights must be drawn again: they do not depend on the
   * view, so they are kept while the view moves and drawn after each sync (scene changes, frames).
   */
  private localShadowsDirty = true;
  /** Whether the last {@link renderLocalShadows} left the instanced meshes out (over the budget). */
  localShadowsSkipInstances = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly overlay: THREE.Scene,
    onTextureLoaded: () => void,
  ) {
    this.textures = new TextureCache(onTextureLoaded);
  }

  sync(doc: SceneDoc, ev: EvaluatedScene, opts: SyncOptions): void {
    const seen = new Set<string>();
    this.boxes = null;
    this.localShadowsDirty = true;
    this.context.mesh = drawContext(opts, false);
    this.context.instanced = drawContext(opts, true);
    for (const o of ev.objects) {
      seen.add(o.id);
      let v = this.views.get(o.id);
      if (!v) {
        v = { id: o.id, root: new THREE.Group(), overlayRoot: new THREE.Group() };
        v.root.matrixAutoUpdate = false;
        v.overlayRoot.matrixAutoUpdate = false;
        v.root.userData.objectId = o.id;
        v.overlayRoot.userData.objectId = o.id;
        this.scene.add(v.root);
        this.overlay.add(v.overlayRoot);
        this.views.set(o.id, v);
      }
      v.root.matrix.fromArray(o.worldMatrix);
      v.overlayRoot.matrix.fromArray(o.worldMatrix);
      v.root.matrixWorldNeedsUpdate = true;
      v.overlayRoot.matrixWorldNeedsUpdate = true;
      v.root.visible = o.visible;
      v.overlayRoot.visible = o.visible;
      // Meshes, and curves/text with a surface, draw geometry; everything else draws helpers.
      if (o.mesh) this.syncMesh(doc, v, o, opts);
      else this.clearMesh(v);
      if (o.type !== 'MESH') this.syncHelper(v, o, opts);
      if (o.type === 'LIGHT' && o.light) this.syncLight(v, o.light, o.worldMatrix, opts);
      else if (v.light) {
        v.root.remove(v.light);
        v.light.dispose();
        v.light = undefined;
        v.lightKey = undefined;
      }
    }
    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      this.scene.remove(v.root);
      this.overlay.remove(v.overlayRoot);
      this.retireMaterials(v);
      disposeObject(v.root);
      disposeObject(v.overlayRoot);
      this.views.delete(id);
    }
    this.syncInstances(ev, opts);
  }

  /** Materials no slot uses any more (objects, meshes or slots removed): disposed after the next render. */
  private orphans: THREE.Material[] = [];
  /** Slot materials that keep others (see {@link replaceSlot}). */
  private pending = new Set<SlotMaterial>();
  /** The draw contexts of the renders after the last sync, of meshes and of instanced meshes. */
  private readonly context = { mesh: '', instanced: '' };

  /**
   * Builds the entry of a slot whose key changed, for its new material. three.js gives a material a
   * shader program for each draw context it is drawn in ({@link drawContext}) and keeps it until the
   * last material holding it is disposed. The material replaced is therefore kept, for each context
   * it was drawn in, until the new one has been drawn there too ({@link disposeReplaced}): three.js
   * then gives the new one the old one's program when their program cache keys are the same (a
   * change of values that are uniforms: colours, roughness, the parameters of a procedural texture),
   * instead of linking it again (seconds per program in software WebGL; a program only one material
   * holds, e.g. a procedural one's, would go with it). Per context the last material drawn there is
   * kept, no older one; a material never drawn holds no program: it is disposed at once.
   */
  private replaceSlot(old: SlotMaterial | undefined, key: string, material: THREE.Material): SlotMaterial {
    const next: SlotMaterial = { key, material, drawnIn: new Set(), kept: old?.kept ?? new Map() };
    // three.js calls a material's onBeforeRender right before it draws with it (and gives it its
    // program for the draw)
    const context = this.context;
    const draw = material.onBeforeRender;
    material.onBeforeRender = function (...args: Parameters<THREE.Material['onBeforeRender']>) {
      next.drawnIn.add((args[4] as THREE.InstancedMesh).isInstancedMesh ? context.instanced : context.mesh);
      draw.apply(this, args);
    };
    if (old) {
      this.pending.delete(old);
      const before = new Set<THREE.Material>();
      for (const c of old.drawnIn) {
        const k = next.kept.get(c);
        if (k) before.add(k);
        next.kept.set(c, old.material);
      }
      for (const k of before) this.release(next, k);
      if (!old.drawnIn.size) old.material.dispose();
    }
    if (next.kept.size) this.pending.add(next);
    return next;
  }

  /** Disposes a material a slot kept, once it keeps it for no context. */
  private release(slot: SlotMaterial, m: THREE.Material): void {
    for (const k of slot.kept.values()) if (k === m) return;
    m.dispose();
  }

  /** Disposes slot materials with those they keep (none: after the next render). */
  private retireSlots(set: SlotMaterial[]): void {
    for (const e of set) {
      this.pending.delete(e);
      this.orphans.push(e.material, ...new Set(e.kept.values()));
    }
    set.length = 0;
  }

  /** Retires every material of a view's mesh (see {@link retireSlots}); its mesh no longer holds them. */
  private retireMaterials(v: ObjectView): void {
    for (const set of v.materialSets?.values() ?? []) this.retireSlots(set.slots);
    v.materialSets = undefined;
    if (v.mesh) v.mesh.material = [];
  }

  /**
   * Disposes the materials kept for draw contexts the materials that replaced them have been drawn
   * in since, and those no slot uses any more: call it after each render of the scene (the frame's,
   * a picture's).
   */
  disposeReplaced(): void {
    for (const e of this.pending) {
      for (const c of e.drawnIn) {
        const k = e.kept.get(c);
        if (!k) continue;
        e.kept.delete(c);
        this.release(e, k);
      }
      if (!e.kept.size) this.pending.delete(e);
    }
    for (const m of this.orphans.splice(0)) m.dispose();
  }

  /** Materials disposed once others have been drawn (see {@link replaceSlot}). */
  waitingMaterials(): number {
    let n = this.orphans.length;
    for (const e of this.pending) n += new Set(e.kept.values()).size;
    return n;
  }

  /** Collection/particle instances: one InstancedMesh per (owner, source) sharing the source's buffers. */
  private syncInstances(ev: EvaluatedScene, opts: SyncOptions): void {
    const groups = new Map<string, { owner: string; source: string; matrices: number[][] }>();
    for (const inst of ev.instances) {
      const key = `${inst.ownerId}|${inst.sourceId}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { owner: inst.ownerId, source: inst.sourceId, matrices: [] }));
      g.matrices.push(inst.matrix);
    }
    const tmp = new THREE.Matrix4();
    for (const [key, g] of groups) {
      const src = this.views.get(g.source)?.mesh;
      const owner = ev.byId.get(g.owner);
      let im = this.instanced.get(key);
      if (!src || !owner) {
        if (im) im.visible = false;
        continue;
      }
      if (!im || im.instanceMatrix.count < g.matrices.length) {
        if (im) {
          this.scene.remove(im);
          im.dispose();
        }
        im = new THREE.InstancedMesh(src.geometry, src.material, Math.max(16, g.matrices.length));
        im.userData.objectId = g.owner;
        im.userData.instanceOf = g.source;
        im.frustumCulled = false;
        this.scene.add(im);
        this.instanced.set(key, im);
      }
      im.geometry = src.geometry;
      im.material = src.material;
      im.count = g.matrices.length;
      g.matrices.forEach((m, i) => im.setMatrixAt(i, tmp.fromArray(m)));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.computeBoundingBox();
      im.visible = owner.visible && src.visible;
      im.castShadow = opts.castShadows;
      im.receiveShadow = opts.castShadows;
    }
    for (const [key, im] of this.instanced) {
      if (groups.has(key)) continue;
      // geometry and material belong to the source object's view
      this.scene.remove(im);
      im.dispose();
      this.instanced.delete(key);
    }
  }

  private clearMesh(v: ObjectView): void {
    if (v.mesh) {
      v.root.remove(v.mesh);
      this.retireMaterials(v);
      disposeObject(v.mesh);
      v.mesh = undefined;
      v.meshKey = undefined;
      v.triFace = undefined;
    }
    if (v.wire) {
      v.overlayRoot.remove(v.wire);
      disposeObject(v.wire);
      v.wire = undefined;
      v.wireKey = undefined;
    }
  }

  private syncMesh(doc: SceneDoc, v: ObjectView, o: EvaluatedObject, opts: SyncOptions): void {
    if (!o.mesh) return;
    const key = o.meshKey ?? '';
    if (v.meshKey !== key || !v.mesh) {
      const { geometry, triFace } = geometryFromMesh(o.mesh);
      if (v.mesh) {
        v.mesh.geometry.dispose();
        v.mesh.geometry = geometry;
      } else {
        v.mesh = new THREE.Mesh(geometry, []);
        v.mesh.userData.objectId = o.id;
        v.root.add(v.mesh);
      }
      v.triFace = triFace;
      v.meshKey = key;
      v.wireKey = undefined;
    }
    const kind: ShadingKind = opts.shading === 'SOLID' || opts.shading === 'WIREFRAME' ? 'SOLID' : 'PBR';
    const hasColors = !!v.mesh.geometry.getAttribute('color');
    const slots = o.materials.length ? o.materials : [null];
    const usedSlots = Math.max(
      slots.length,
      ...v.mesh.geometry.groups.map((g) => (g.materialIndex ?? 0) + 1),
    );
    // the materials of this shading kind (see ObjectView.materialSets): kept from when they were
    // last drawn, a slot's built again when its key changed
    const sets = (v.materialSets ??= new Map<ShadingKind, MaterialSet>());
    let set = sets.get(kind);
    if (!set) sets.set(kind, (set = { slots: [], materials: [] }));
    const { slots: built } = set;
    let changed = built.length !== usedSlots;
    for (let i = 0; i < usedSlots; i++) {
      const m = slots[i] ?? null;
      const key = slotMaterialKey(m, kind, hasColors, opts.imagesRevision, o.data.color);
      if (built[i]?.key === key) continue;
      const material = buildMaterial(m, kind, doc, this.textures, {
        objectColor: o.data.color,
        vertexColors: hasColors,
      });
      built[i] = this.replaceSlot(built[i], key, material);
      changed = true;
    }
    if (built.length > usedSlots) this.retireSlots(built.splice(usedSlots));
    // X-ray: see-through in Solid (and Wireframe) shading only, like Blender's, whose Material
    // Preview and Rendered shading draw objects as they are with X-ray on (a material turned
    // transparent needs shader programs of its own: tens of seconds for a scene's materials in
    // Rendered shading in software WebGL)
    for (const e of built) setXray(e.material, opts.xray && kind === 'SOLID');
    if (changed) set.materials = built.map((e) => e.material);
    v.mesh.material = set.materials;
    // how far light travels inside glass: the object's size, not a fixed 0.5 m (transmission.ts)
    const thickness = transmissionThickness(v.mesh.geometry);
    for (const m of v.mesh.material as THREE.Material[]) {
      const t = transmissionOf(m);
      if (t) t.thickness.value = thickness;
    }
    const isEdit = opts.editObjectId === o.id;
    v.mesh.visible =
      opts.shading !== 'WIREFRAME' && o.data.display_type !== 'WIRE' && o.data.display_type !== 'BOUNDS';
    v.mesh.castShadow = opts.castShadows;
    v.mesh.receiveShadow = opts.castShadows;
    // wireframe overlay (the wires of Wireframe shading are the shading, not an overlay). The object
    // being edited shows its edges in the edit-mode cage, an overlay: its wires are drawn for
    // Wireframe shading while the overlays are off (also in screenshots, which have none), so that
    // Wireframe shading still shows it, and never as a wireframe overlay.
    const showWire = isEdit
      ? opts.shading === 'WIREFRAME' && !opts.overlays
      : opts.shading === 'WIREFRAME' ||
        (opts.overlays && (opts.showWireOverlay || o.data.show_wire || o.data.display_type === 'WIRE'));
    if (showWire) {
      const wk = `${v.meshKey}`;
      if (!v.wire || v.wireKey !== wk) {
        if (v.wire) {
          v.overlayRoot.remove(v.wire);
          disposeObject(v.wire);
        }
        v.wire = new THREE.LineSegments(
          wireGeometry(o.mesh),
          new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 }),
        );
        v.wire.userData.objectId = o.id;
        v.overlayRoot.add(v.wire);
        v.wireKey = wk;
      }
      // in Edit Mode the edited object is not highlighted as selected (no outline either): its
      // selected elements are, in the cage
      const sel = !isEdit && opts.selected.has(o.id);
      const mat = v.wire.material as THREE.LineBasicMaterial;
      mat.color.copy(
        !isEdit && o.id === opts.activeId
          ? COLORS.active
          : sel
            ? COLORS.selected
            : opts.shading === 'WIREFRAME'
              ? new THREE.Color(0xbbbbbb)
              : COLORS.wire,
      );
      mat.opacity = sel || opts.shading === 'WIREFRAME' ? 0.9 : 0.5;
      mat.depthTest = !opts.xray && opts.shading !== 'WIREFRAME';
      v.wire.visible = true;
    } else if (v.wire) v.wire.visible = false;
  }

  private syncHelper(v: ObjectView, o: EvaluatedObject, opts: SyncOptions): void {
    let positions: number[] | null = null;
    let key = '';
    if (o.type === 'EMPTY') {
      key = `E${o.data.empty_display_type}${o.data.empty_display_size}`;
      if (v.helperKey !== key) positions = emptyLines(o.data.empty_display_type, o.data.empty_display_size);
    } else if (o.type === 'LIGHT' && o.light) {
      key = `L${JSON.stringify(o.light)}`;
      if (v.helperKey !== key) positions = lightLines(o.light);
    } else if (o.type === 'CAMERA' && o.camera) {
      key = `C${JSON.stringify(o.camera)}${opts.renderAspect.toFixed(4)}`;
      if (v.helperKey !== key) positions = cameraLines(o.camera, opts.renderAspect, 1);
    } else if ((o.type === 'CURVE' || o.type === 'FONT') && o.lines && !o.mesh) {
      key = `K${o.linesKey ?? ''}`;
      if (v.helperKey !== key) positions = Array.from(o.lines);
    } else if (o.type === 'ARMATURE' && o.pose) {
      const pose = o.pose;
      key = `A${pose.order
        .map((n) =>
          pose.bones
            .get(n)!
            .matrix.map((x) => x.toFixed(4))
            .join(','),
        )
        .join('|')}`;
      if (v.helperKey !== key) positions = boneLines(pose);
    }
    if (!key && v.helper) {
      v.overlayRoot.remove(v.helper);
      disposeObject(v.helper);
      v.helper = undefined;
      v.helperKey = undefined;
    }
    if (positions) {
      if (v.helper) {
        v.overlayRoot.remove(v.helper);
        disposeObject(v.helper);
      }
      v.helper = linesObject(positions, COLORS.helper);
      v.helper.userData.objectId = o.id;
      v.overlayRoot.add(v.helper);
      v.helperKey = key;
      // invisible pick proxy (raycasting lines is unreliable on touch devices)
      if (!v.pickProxy) {
        v.pickProxy = new THREE.Mesh(
          new THREE.SphereGeometry(o.type === 'CAMERA' ? 0.6 : 0.3, 8, 6),
          new THREE.MeshBasicMaterial({ visible: false }),
        );
        v.pickProxy.userData.objectId = o.id;
        v.pickProxy.userData.pickProxy = true;
        v.overlayRoot.add(v.pickProxy);
      }
      if (o.type === 'CAMERA') v.pickProxy.position.set(0, 0, -0.5);
    }
    if (v.helper) {
      const mat = v.helper.material as THREE.LineBasicMaterial;
      const sel = opts.selected.has(o.id);
      mat.color.copy(o.id === opts.activeId ? COLORS.active : sel ? COLORS.selected : COLORS.helper);
      mat.depthTest = !opts.xray;
      v.helper.visible = opts.overlays;
    }
  }

  private syncLight(v: ObjectView, l: LightData, world: number[], opts: SyncOptions): void {
    const key = `${l.type}|${l.shape}`;
    if (v.lightKey !== key || !v.light) {
      if (v.light) {
        v.root.remove(v.light);
        v.light.dispose();
      }
      let light: THREE.Light;
      if (l.type === 'SUN') {
        const d = new THREE.DirectionalLight();
        d.position.set(0, 0, 0);
        d.target.position.set(0, 0, -1);
        d.add(d.target);
        light = d;
      } else if (l.type === 'SPOT') {
        const s = new THREE.SpotLight();
        // three.js puts a new spot light at Object3D.DEFAULT_UP (1 m behind the lamp here, where
        // that is +Z); the lamp shines from its object's origin
        s.position.set(0, 0, 0);
        s.target.position.set(0, 0, -1);
        s.add(s.target);
        light = s;
      } else if (l.type === 'AREA') {
        if (!rectInit) {
          RectAreaLightUniformsLib.init();
          rectInit = true;
        }
        const a = new THREE.RectAreaLight();
        // RectAreaLight emits along its local -Z, like Blender area lights
        light = a;
      } else light = new THREE.PointLight();
      light.userData.objectId = v.id;
      v.root.add(light);
      v.light = light;
      v.lightKey = key;
    }
    const light = v.light;
    light.color.setRGB(l.color[0], l.color[1], l.color[2]);
    const shadows = opts.castShadows && l.use_shadow;
    if (light instanceof THREE.DirectionalLight) {
      light.intensity = lightIntensity(l);
      light.castShadow = shadows;
    } else if (light instanceof THREE.SpotLight) {
      light.intensity = lightIntensity(l);
      const cone = spotCone(l.spot_size, l.spot_blend);
      light.angle = cone.angle;
      light.penumbra = cone.penumbra;
      light.decay = 2;
      light.castShadow = shadows;
    } else if (light instanceof THREE.RectAreaLight) {
      const w = Math.max(1e-4, l.size);
      const h = Math.max(1e-4, l.shape === 'RECTANGLE' || l.shape === 'ELLIPSE' ? l.size_y : l.size);
      light.width = w;
      light.height = h;
      // the rectangle is scaled by the object's X and Y axes
      const sx = Math.hypot(world[0], world[1], world[2]);
      const sy = Math.hypot(world[4], world[5], world[6]);
      light.intensity = lightIntensity(l, w * h * sx * sy);
    } else if (light instanceof THREE.PointLight) {
      light.intensity = lightIntensity(l);
      light.decay = 2;
      light.castShadow = shadows;
    }
    if ('shadow' in light && light.castShadow) {
      const sh = (light as THREE.PointLight).shadow;
      // (three.js resizes the map when the size changes)
      const size = light instanceof THREE.DirectionalLight ? SUN_SHADOW_MAP_SIZE : 1024;
      sh.mapSize.set(size, size);
      sh.radius = 3;
      // a sun's frustum and biases are fitted to each render's camera (fitSunShadows)
      if (!(light instanceof THREE.DirectionalLight)) {
        sh.bias = -0.0005;
        sh.normalBias = 0.02;
        // drawn by renderLocalShadows when the scene changed, not on every frame
        sh.autoUpdate = false;
        light.layers.enable(LOCAL_SHADOW_LAYER);
      }
      // shadow cameras draw what is on their own layers (also the transmission pictures' hidden
      // layer), whatever the layers of the camera rendering the scene
      sh.camera.layers.enable(HIDDEN_LAYER);
    }
    light.visible = opts.shading === 'RENDERED';
  }

  /**
   * World-space bounding boxes of the visible geometry that casts and receives shadows: one per
   * mesh (meshes, curve and text surfaces) and one per group of instances, as last synced.
   */
  shadowBoxes(): THREE.Box3[] {
    if (this.boxes) return this.boxes;
    const out: THREE.Box3[] = [];
    for (const v of this.views.values()) {
      const m = v.mesh;
      if (!m || !v.root.visible || !m.visible || !m.castShadow) continue;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox;
      // the mesh sits at the origin of its root, whose matrix is the object's world matrix
      if (b && !b.isEmpty()) out.push(b.clone().applyMatrix4(v.root.matrix));
    }
    for (const im of this.instanced.values()) {
      if (!im.visible || !im.castShadow || im.count === 0) continue;
      if (!im.boundingBox) im.computeBoundingBox();
      if (im.boundingBox && !im.boundingBox.isEmpty()) out.push(im.boundingBox.clone());
    }
    return (this.boxes = out);
  }

  /** Camera of the shadow-only render of {@link renderLocalShadows}: it sees the local lights, no mesh. */
  private readonly shadowPassCamera = (() => {
    const c = new THREE.PerspectiveCamera();
    c.layers.set(LOCAL_SHADOW_LAYER);
    return c;
  })();
  /** The 1 × 1 target of that render (it draws nothing but the shadow maps). */
  private shadowPassTarget: THREE.WebGLRenderTarget | null = null;

  /**
   * Draws the shadow maps of the shadow-casting point and spot lights when the scene changed since
   * they were last drawn (they do not depend on the view): call it before a frame's renders, with
   * shadow maps on. Over {@link LOCAL_SHADOW_TRIANGLE_BUDGET}, the instanced meshes are left out of
   * them (they keep casting sun shadows). It renders the scene with a camera that sees only these
   * lights (no mesh), with the suns' maps held, so three.js draws just these maps. Returns whether
   * it drew anything.
   */
  renderLocalShadows(renderer: THREE.WebGLRenderer): boolean {
    if (!this.localShadowsDirty) return false;
    this.localShadowsDirty = false;
    const lights: THREE.Light[] = [];
    let faces = 0;
    for (const v of this.views.values()) {
      const l = v.light;
      if (!l || !l.castShadow || !l.visible || !v.root.visible) continue;
      if (l instanceof THREE.PointLight) faces += 6;
      else if (l instanceof THREE.SpotLight) faces += 1;
      else continue;
      lights.push(l);
    }
    if (!lights.length) return false;
    const instances = [...this.instanced.values()].filter((im) => im.visible && im.castShadow);
    const instanceTriangles = instances.reduce((n, im) => n + trianglesOf(im), 0);
    this.localShadowsSkipInstances = instanceTriangles * faces > LOCAL_SHADOW_TRIANGLE_BUDGET;
    // the suns' maps are drawn with the frame's first render of the scene (fitted to its camera)
    const suns: { shadow: THREE.LightShadow; autoUpdate: boolean }[] = [];
    this.scene.traverse((o) => {
      const d = o as THREE.DirectionalLight;
      if (d.isDirectionalLight && d.castShadow) {
        suns.push({ shadow: d.shadow, autoUpdate: d.shadow.autoUpdate });
        d.shadow.autoUpdate = false;
        d.shadow.needsUpdate = false;
      }
    });
    if (this.localShadowsSkipInstances) for (const im of instances) im.castShadow = false;
    this.shadowPassTarget ??= new THREE.WebGLRenderTarget(1, 1);
    const prevTarget = renderer.getRenderTarget();
    try {
      for (const l of lights) (l as THREE.PointLight).shadow.needsUpdate = true;
      renderer.shadowMap.needsUpdate = true;
      renderer.setRenderTarget(this.shadowPassTarget);
      renderer.render(this.scene, this.shadowPassCamera);
    } finally {
      renderer.setRenderTarget(prevTarget);
      if (this.localShadowsSkipInstances) for (const im of instances) im.castShadow = true;
      for (const sun of suns) sun.shadow.autoUpdate = sun.autoUpdate;
    }
    return true;
  }

  /** Draws the point and spot light shadow maps again before the next frame (e.g. after a final render). */
  invalidateLocalShadows(): void {
    this.localShadowsDirty = true;
  }

  /** Triangles the visible meshes and instances draw, as last synced. */
  drawnTriangles(): number {
    let n = 0;
    for (const v of this.views.values()) if (v.mesh?.visible && v.root.visible) n += trianglesOf(v.mesh);
    for (const im of this.instanced.values()) if (im.visible) n += trianglesOf(im);
    return n;
  }

  /**
   * Fits the shadow maps of the shadow-casting sun lamps to what `camera` sees ({@link fitSunShadow});
   * call it before every render, with that render's camera.
   */
  fitSunShadows(camera: THREE.Camera): void {
    for (const v of this.views.values()) {
      const l = v.light;
      if (l instanceof THREE.DirectionalLight && l.castShadow && l.visible && v.root.visible)
        fitSunShadow(l, camera, this.shadowBoxes());
    }
  }

  /**
   * Meshes that can be picked, plus the pick proxies of the helpers on screen (none while the
   * overlays are off, and none for an object that no longer draws a helper, e.g. a curve that got
   * a surface).
   */
  pickables(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const v of this.views.values()) {
      if (!v.root.visible) continue;
      if (v.mesh?.visible) out.push(v.mesh);
      else if (v.wire?.visible) out.push(v.wire);
      if (v.pickProxy && v.helper?.visible) out.push(v.pickProxy);
    }
    for (const im of this.instanced.values()) if (im.visible) out.push(im);
    return out;
  }

  dispose(): void {
    this.shadowPassTarget?.dispose();
    for (const im of this.instanced.values()) {
      this.scene.remove(im);
      im.dispose();
    }
    this.instanced.clear();
    for (const v of this.views.values()) {
      this.retireMaterials(v);
      disposeObject(v.root);
      disposeObject(v.overlayRoot);
    }
    this.views.clear();
    this.disposeReplaced();
    this.textures.dispose();
  }
}
