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
import { cameraLines, emptyLines, lightLines, linesObject } from './helpers';

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
 * Converts Blender-style watts (W / 4π ≈ candela) into three.js intensities. The factor is
 * calibrated so the default 1000 W lamp lights the default scene like Blender's EEVEE.
 */
const LIGHT_SCALE = 12;

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
      if (o.type === 'MESH') this.syncMesh(doc, v, o, opts);
      else this.syncHelper(v, o, opts);
      if (o.type === 'LIGHT' && o.light) this.syncLight(v, o.light, opts);
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

  private syncLight(v: ObjectView, l: LightData, opts: SyncOptions): void {
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
        d.shadow.camera.left = d.shadow.camera.bottom = -15;
        d.shadow.camera.right = d.shadow.camera.top = 15;
        d.shadow.camera.near = -50;
        d.shadow.camera.far = 50;
        light = d;
      } else if (l.type === 'SPOT') {
        const s = new THREE.SpotLight();
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
      light.intensity = l.energy * 2.5;
      light.castShadow = shadows;
    } else if (light instanceof THREE.SpotLight) {
      light.intensity = (l.energy / (4 * Math.PI)) * LIGHT_SCALE;
      light.angle = Math.min(Math.PI / 2, l.spot_size / 2);
      light.penumbra = Math.min(1, l.spot_blend);
      light.decay = 2;
      light.castShadow = shadows;
    } else if (light instanceof THREE.RectAreaLight) {
      const w = l.size;
      const h = l.shape === 'RECTANGLE' || l.shape === 'ELLIPSE' ? l.size_y : l.size;
      light.width = w;
      light.height = h;
      light.intensity = (l.energy / (4 * Math.PI * Math.max(0.01, w * h))) * LIGHT_SCALE;
    } else if (light instanceof THREE.PointLight) {
      light.intensity = (l.energy / (4 * Math.PI)) * LIGHT_SCALE;
      light.decay = 2;
      light.castShadow = shadows;
    }
    if ('shadow' in light && light.castShadow) {
      const sh = (light as THREE.PointLight).shadow;
      sh.mapSize.set(1024, 1024);
      sh.bias = -0.0005;
      sh.normalBias = 0.02;
      sh.radius = 3;
    }
    light.visible = opts.shading === 'RENDERED';
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
    return out;
  }

  dispose(): void {
    for (const v of this.views.values()) {
      disposeObject(v.root);
      disposeObject(v.overlayRoot);
    }
    this.views.clear();
    this.textures.dispose();
  }
}
