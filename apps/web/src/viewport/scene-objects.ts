import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import {
  buildEdgeIndexList,
  buildRenderBuffers,
  type EvaluatedObject,
  type EvaluatedScene,
  type LightData,
  type MeshData,
  type SceneDoc,
} from '@3d-editor/core';
import { buildMaterial, materialKey, TextureCache, type ShadingKind } from './materials';
import { boneLines, cameraLines, emptyLines, lightLines, linesObject } from './helpers';
import { fitSunShadow, SUN_SHADOW_MAP_SIZE } from './sun-shadow';

/** three.js representation of one document object. */
export interface ObjectView {
  id: string;
  root: THREE.Group;
  overlayRoot: THREE.Group;
  mesh?: THREE.Mesh;
  meshKey?: string;
  matKey?: string;
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
}

/** Keeps three.js objects in sync with an evaluated scene (incremental, cached by keys). */
export class SceneObjects {
  readonly views = new Map<string, ObjectView>();
  /** Instanced meshes keyed by `${ownerId}|${sourceId}`. */
  private readonly instanced = new Map<string, THREE.InstancedMesh>();
  readonly textures: TextureCache;

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
      disposeObject(v.root);
      disposeObject(v.overlayRoot);
      this.views.delete(id);
    }
    this.syncInstances(ev, opts);
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
      disposeObject(v.mesh);
      v.mesh = undefined;
      v.meshKey = undefined;
      v.matKey = undefined;
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
    const mk =
      `${opts.xray ? 'x' : ''}|${o.data.color.join(',')}|` +
      Array.from({ length: usedSlots }, (_, i) =>
        materialKey(slots[i] ?? null, kind, hasColors, opts.imagesRevision),
      ).join('#');
    if (v.matKey !== mk) {
      const old = v.mesh.material;
      if (Array.isArray(old)) old.forEach((m) => m.dispose());
      else old.dispose();
      const mats = Array.from({ length: usedSlots }, (_, i) => {
        const m = buildMaterial(slots[i] ?? null, kind, doc, this.textures, {
          objectColor: o.data.color,
          vertexColors: hasColors,
        });
        if (opts.xray) {
          m.transparent = true;
          m.opacity = Math.min(m.opacity, 0.45);
          m.depthWrite = false;
        }
        return m;
      });
      v.mesh.material = mats;
      v.matKey = mk;
    }
    const isEdit = opts.editObjectId === o.id;
    v.mesh.visible =
      opts.shading !== 'WIREFRAME' && o.data.display_type !== 'WIRE' && o.data.display_type !== 'BOUNDS';
    v.mesh.castShadow = opts.castShadows;
    v.mesh.receiveShadow = opts.castShadows;
    // wireframe overlay
    const showWire =
      !isEdit &&
      (opts.shading === 'WIREFRAME' ||
        opts.showWireOverlay ||
        o.data.show_wire ||
        o.data.display_type === 'WIRE');
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
      const sel = opts.selected.has(o.id);
      const mat = v.wire.material as THREE.LineBasicMaterial;
      mat.color.copy(
        o.id === opts.activeId
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
    }
  }

  private syncLight(
    v: ObjectView,
    l: LightData,
    world: number[],
    opts: SyncOptions,
  ): void {
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
      }
    }
    light.visible = opts.shading === 'RENDERED';
  }

  /** {@link shadowBoxes} of the last sync (null: not computed yet). */
  private boxes: THREE.Box3[] | null = null;

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

  /** Meshes that can be picked, plus helper pick proxies. */
  pickables(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const v of this.views.values()) {
      if (!v.root.visible) continue;
      if (v.mesh?.visible) out.push(v.mesh);
      else if (v.wire?.visible) out.push(v.wire);
      if (v.pickProxy) out.push(v.pickProxy);
    }
    for (const im of this.instanced.values()) if (im.visible) out.push(im);
    return out;
  }

  dispose(): void {
    for (const im of this.instanced.values()) {
      this.scene.remove(im);
      im.dispose();
    }
    this.instanced.clear();
    for (const v of this.views.values()) {
      disposeObject(v.root);
      disposeObject(v.overlayRoot);
    }
    this.views.clear();
    this.textures.dispose();
  }
}
