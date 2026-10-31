import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { effect } from '@preact/signals';
import {
  cameraFovY,
  meshBounds,
  orthoHalfExtents,
  transformPoint3,
  type EvaluatedScene,
  type MeshData,
  type Vec3,
} from '@3d-editor/core';
import type { ProjectSession } from '../project/session';
import { SceneObjects } from './scene-objects';
import { EditOverlay } from './edit-overlay';
import { createGrid, updateGrid } from './grid';
import {
  DEFAULT_POSE,
  applyPoseToCamera,
  clonePose,
  lerpPose,
  poseToPresence,
  presenceToPose,
  viewLabel,
  type ViewPose,
} from './navigation';
import { recordFrame, resetFrameClock } from '../telemetry/perf';
import { telemetry } from '../telemetry/telemetry';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const VIEWPORT_BG = new THREE.Color(0x393939);

function cursorTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    g.lineWidth = 3;
    for (let i = 0; i < 8; i++) {
      g.strokeStyle = i % 2 ? '#ffffff' : '#e8322e';
      g.beginPath();
      g.arc(32, 32, 20, (i / 8) * Math.PI * 2, ((i + 1) / 8) * Math.PI * 2);
      g.stroke();
    }
    g.strokeStyle = '#111';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(32, 2);
    g.lineTo(32, 20);
    g.moveTo(32, 44);
    g.lineTo(32, 62);
    g.moveTo(2, 32);
    g.lineTo(20, 32);
    g.moveTo(44, 32);
    g.lineTo(62, 32);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** WebGL viewport: owns the three.js renderer and mirrors the evaluated scene. */
export class ViewportEngine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly overlay = new THREE.Scene();
  readonly perspCam = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  readonly orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  readonly sceneCam = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  readonly objects: SceneObjects;
  readonly edit = new EditOverlay();
  pose: ViewPose = DEFAULT_POSE();
  width = 1;
  height = 1;
  ev: EvaluatedScene | null = null;
  /** Live mesh overrides (interactive edit-mode transforms). */
  readonly meshOverrides = new Map<string, MeshData>();
  /** Live world-matrix overrides (interactive object transforms). */
  readonly matrixOverrides = new Map<string, number[]>();
  readonly onAfterRender = new Set<() => void>();
  private composer: EffectComposer;
  private outlineSel: OutlinePass;
  private outlineActive: OutlinePass;
  private overlayPass: RenderPass;
  private renderPass: RenderPass;
  private grid = createGrid();
  private cursor: THREE.Sprite;
  private originDots: THREE.Points;
  private peerBoxes = new THREE.Group();
  private ambient = new THREE.AmbientLight(0xffffff, 0);
  private envTexture: THREE.Texture | null = null;
  private pmrem: THREE.PMREMGenerator;
  private dirty = true;
  private needsSync = true;
  private raf = 0;
  private animating: { from: ViewPose; to: ViewPose; start: number; dur: number } | null = null;
  private disposers: (() => void)[] = [];
  private resizeObserver: ResizeObserver;
  private lastFrameTime = 0;
  imagesRevision = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly session: ProjectSession,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.objects = new SceneObjects(this.scene, this.overlay, () => this.requestRender());
    this.scene.add(this.ambient);
    this.overlay.add(this.grid, this.edit.group, this.peerBoxes);
    this.cursor = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: cursorTexture(),
        depthTest: false,
        sizeAttenuation: false,
        transparent: true,
      }),
    );
    this.cursor.scale.set(0.045, 0.045, 1);
    this.cursor.renderOrder = 20;
    this.overlay.add(this.cursor);
    this.originDots = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, color: 0xf17e2a, depthTest: false }),
    );
    this.originDots.renderOrder = 19;
    this.overlay.add(this.originDots);

    const rt = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
    this.composer = new EffectComposer(this.renderer, rt);
    this.renderPass = new RenderPass(this.scene, this.perspCam);
    this.overlayPass = new RenderPass(this.overlay, this.perspCam);
    this.overlayPass.clear = false;
    this.overlayPass.clearDepth = false;
    this.outlineSel = new OutlinePass(new THREE.Vector2(1, 1), this.scene, this.perspCam);
    this.outlineActive = new OutlinePass(new THREE.Vector2(1, 1), this.scene, this.perspCam);
    for (const [p, c] of [
      [this.outlineSel, 0xf17e2a],
      [this.outlineActive, 0xffb359],
    ] as const) {
      p.visibleEdgeColor.set(c);
      p.hiddenEdgeColor.set(c);
      p.edgeStrength = 4;
      p.edgeThickness = 1;
      p.edgeGlow = 0;
    }
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.overlayPass);
    this.composer.addPass(this.outlineSel);
    this.composer.addPass(this.outlineActive);
    this.composer.addPass(new OutputPass());

    this.restorePose();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();

    const s = session;
    const st = s.state;
    const v = s.view;
    // Any of these changes requires a re-sync of three objects.
    this.disposers.push(
      effect(() => {
        void s.revision.value;
        void st.$frame.value;
        void st.$selectedIds.value;
        void st.$activeId.value;
        void st.$mode.value;
        void st.$meshSelection.value;
        void st.$selectMode.value;
        void v.shading.value;
        void v.xray.value;
        void v.showWireframe.value;
        void v.overlays.value;
        void v.showGrid.value;
        void v.tool.value;
        void v.snapping.value;
        void s.peers.value;
        this.invalidate();
      }),
      effect(() => {
        void st.$cursorLocation.value;
        void v.cameraView.value;
        this.requestRender();
      }),
      effect(() => {
        const follow = v.following.value;
        if (follow === null) return;
        const peer = s.peers.value.find((p) => p.clientId === follow);
        if (peer?.state.view) {
          this.pose = presenceToPose(peer.state.view);
          this.requestRender();
        } else if (!peer) v.following.value = null;
      }),
    );
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------------ frame loop

  invalidate(): void {
    this.needsSync = true;
    this.dirty = true;
  }

  requestRender(): void {
    this.dirty = true;
  }

  private loop(now: number): void {
    this.raf = requestAnimationFrame(this.loop);
    const v = this.session.view;
    if (v.playing.value) {
      const fps = this.ev?.scene.fps ?? this.session.doc.getScene().fps;
      if (!this.lastFrameTime) this.lastFrameTime = now;
      const step = 1000 / Math.max(1, fps);
      if (now - this.lastFrameTime >= step) {
        const sc = this.session.doc.getScene();
        const frames = Math.floor((now - this.lastFrameTime) / step);
        this.lastFrameTime += frames * step;
        let f = this.session.state.frame + frames;
        if (f > sc.frame_end)
          f = sc.frame_start + ((f - sc.frame_start) % Math.max(1, sc.frame_end - sc.frame_start + 1));
        this.session.state.frame = f;
      }
    } else this.lastFrameTime = 0;
    if (this.animating) {
      const t = Math.min(1, (now - this.animating.start) / this.animating.dur);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this.pose = lerpPose(this.animating.from, this.animating.to, e);
      if (t >= 1) {
        this.pose = this.animating.to;
        this.animating = null;
        this.persistPose();
      }
      this.dirty = true;
    }
    if (!this.dirty && !this.needsSync) {
      resetFrameClock();
      return;
    }
    if (this.needsSync) this.sync();
    this.dirty = false;
    this.render();
    recordFrame(now);
  }

  // ------------------------------------------------------------------ scene sync

  sync(): void {
    this.needsSync = false;
    const s = this.session;
    const st = s.state;
    const v = s.view;
    const span = telemetry.startSpan('viewport.sync');
    const editId = st.mode === 'EDIT' ? st.activeId : null;
    this.ev = s.evaluator.evaluate(st.frame, { editObjectId: editId, meshOverrides: this.meshOverrides });
    for (const [id, m] of this.matrixOverrides) {
      const o = this.ev.byId.get(id);
      if (o) o.worldMatrix = m;
    }
    const render = this.ev.render;
    const shading = v.shading.value;
    this.objects.sync(s.doc, this.ev, {
      shading,
      showWireOverlay: v.showWireframe.value,
      xray: v.xray.value || shading === 'WIREFRAME',
      selected: new Set(st.selectedIds),
      activeId: st.activeId,
      editObjectId: editId,
      renderAspect: render.resolution_x / Math.max(1, render.resolution_y),
      castShadows: shading === 'RENDERED' && render.use_shadows,
      imagesRevision: this.imagesRevision,
    });
    this.applyShading();
    // edit overlay
    if (editId) {
      const o = this.ev.byId.get(editId);
      const base = this.meshOverrides.get(editId) ?? o?.baseMesh;
      if (o && base) {
        const token = this.meshOverrides.has(editId)
          ? `live${this.overrideToken}`
          : `doc${s.doc.meshVersion(o.data.data ?? '')}`;
        this.edit.update(base, st.meshSelection, st.selectMode, o.worldMatrix, v.xray.value, token);
      } else this.edit.hide();
    } else this.edit.hide();
    // outlines
    const sel = new Set(st.selectedIds);
    const selMeshes: THREE.Object3D[] = [];
    const activeMeshes: THREE.Object3D[] = [];
    if (st.mode === 'OBJECT' && v.overlays.value)
      for (const id of sel) {
        const view = this.objects.views.get(id);
        if (!view?.mesh?.visible || !view.root.visible) continue;
        (id === st.activeId ? activeMeshes : selMeshes).push(view.mesh);
      }
    this.outlineSel.selectedObjects = selMeshes;
    this.outlineActive.selectedObjects = activeMeshes;
    this.outlineSel.enabled = selMeshes.length > 0;
    this.outlineActive.enabled = activeMeshes.length > 0;
    // origin dots
    const dots: number[] = [];
    if (st.mode === 'OBJECT' && v.overlays.value)
      for (const id of sel) {
        const o = this.ev.byId.get(id);
        if (o?.visible) dots.push(o.worldMatrix[12], o.worldMatrix[13], o.worldMatrix[14]);
      }
    this.originDots.geometry.dispose();
    this.originDots.geometry = new THREE.BufferGeometry();
    this.originDots.geometry.setAttribute('position', new THREE.Float32BufferAttribute(dots, 3));
    this.syncPeers();
    this.grid.visible = v.overlays.value && v.showGrid.value;
    this.cursor.visible = v.overlays.value;
    span.setAttribute('scene.objects', this.ev.objects.length).end();
  }

  private overrideToken = 0;
  setMeshOverride(id: string, mesh: MeshData | null): void {
    if (mesh) this.meshOverrides.set(id, mesh);
    else this.meshOverrides.delete(id);
    this.overrideToken++;
    this.invalidate();
  }

  setMatrixOverrides(m: Map<string, number[]> | null): void {
    this.matrixOverrides.clear();
    if (m) for (const [k, v] of m) this.matrixOverrides.set(k, v);
    this.invalidate();
  }

  private syncPeers(): void {
    for (const c of [...this.peerBoxes.children]) {
      this.peerBoxes.remove(c);
      (c as THREE.Box3Helper).geometry?.dispose();
    }
    if (!this.ev || !this.session.view.overlays.value) return;
    for (const peer of this.session.peers.value) {
      for (const id of peer.state.selection ?? []) {
        const o = this.ev.byId.get(id);
        if (!o?.visible) continue;
        const box = new THREE.Box3();
        if (o.mesh) {
          const b = meshBounds(o.mesh);
          if (!b) continue;
          for (const x of [b.min[0], b.max[0]])
            for (const y of [b.min[1], b.max[1]])
              for (const z of [b.min[2], b.max[2]])
                box.expandByPoint(new THREE.Vector3(...transformPoint3(o.worldMatrix, [x, y, z])));
        } else {
          const p = new THREE.Vector3(o.worldMatrix[12], o.worldMatrix[13], o.worldMatrix[14]);
          box.setFromCenterAndSize(p, new THREE.Vector3(0.6, 0.6, 0.6));
        }
        box.expandByScalar(0.03);
        const helper = new THREE.Box3Helper(box, new THREE.Color(peer.state.user.color));
        (helper.material as THREE.LineBasicMaterial).depthTest = false;
        this.peerBoxes.add(helper);
      }
    }
  }

  private envKey = '';
  private applyShading(): void {
    const v = this.session.view;
    const shading = v.shading.value;
    const ev = this.ev!;
    const world = ev.world;
    const r = this.renderer;
    const tm: Record<string, THREE.ToneMapping> = {
      STANDARD: THREE.NoToneMapping,
      AGX: THREE.AgXToneMapping,
      FILMIC: THREE.ACESFilmicToneMapping,
      ACES: THREE.ACESFilmicToneMapping,
      NEUTRAL: THREE.NeutralToneMapping,
    };
    if (shading === 'RENDERED' || shading === 'MATERIAL') {
      r.toneMapping = tm[ev.render.view_transform] ?? THREE.AgXToneMapping;
      r.toneMappingExposure = Math.pow(2, ev.render.exposure);
    } else {
      r.toneMapping = THREE.NoToneMapping;
      r.toneMappingExposure = 1;
    }
    r.shadowMap.enabled = shading === 'RENDERED' && ev.render.use_shadows;
    const wantEnv = shading === 'MATERIAL' || (shading === 'RENDERED' && world.environment !== 'NONE');
    const key = wantEnv ? `room` : '';
    if (key !== this.envKey) {
      this.envKey = key;
      if (wantEnv && !this.envTexture) {
        const room = new RoomEnvironment();
        this.envTexture = this.pmrem.fromScene(room, 0.04).texture;
      }
    }
    this.scene.environment = wantEnv ? this.envTexture : null;
    // In Rendered mode the studio environment acts as soft fill light; lamps provide the key light.
    this.scene.environmentIntensity =
      shading === 'RENDERED' ? world.environment_strength * world.strength * 0.35 : 1;
    const envRot = shading === 'RENDERED' ? world.environment_rotation : 0;
    this.scene.environmentRotation.set(Math.PI / 2, 0, envRot);
    this.scene.backgroundRotation.set(Math.PI / 2, 0, envRot);
    if (shading === 'RENDERED') {
      if (world.show_environment_background && wantEnv) {
        this.scene.background = this.envTexture;
        this.scene.backgroundBlurriness = 0.3;
      } else
        this.scene.background = new THREE.Color(
          world.color[0] * world.strength,
          world.color[1] * world.strength,
          world.color[2] * world.strength,
        );
      this.ambient.color.setRGB(world.color[0], world.color[1], world.color[2]);
      this.ambient.intensity = world.environment === 'NONE' ? world.strength * Math.PI : 0;
    } else if (shading === 'MATERIAL') {
      this.scene.background = this.envTexture;
      this.scene.backgroundBlurriness = 0.6;
      this.ambient.intensity = 0;
    } else {
      this.scene.background = VIEWPORT_BG;
      this.ambient.intensity = 0;
    }
  }

  // ------------------------------------------------------------------ cameras & render

  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    if (this.session.view.cameraView.value && this.ev?.activeCamera?.camera) return this.updateSceneCamera();
    return this.pose.ortho ? this.orthoCam : this.perspCam;
  }

  /** Viewport camera matching the active scene camera (frame fitted into the viewport). */
  private updateSceneCamera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    const camObj = this.ev!.activeCamera!;
    const cam = camObj.camera!;
    const render = this.ev!.render;
    const renderAspect = render.resolution_x / Math.max(1, render.resolution_y);
    const viewAspect = this.width / Math.max(1, this.height);
    const margin = 0.88;
    const fitScale = Math.max(1, renderAspect / viewAspect) / margin;
    const m = new THREE.Matrix4().fromArray(camObj.worldMatrix);
    if (cam.type === 'ORTHO') {
      const e = orthoHalfExtents(cam, renderAspect);
      const hh = e.halfH * fitScale;
      const oc = this.orthoCam;
      oc.top = hh;
      oc.bottom = -hh;
      oc.left = -hh * viewAspect;
      oc.right = hh * viewAspect;
      oc.near = cam.clip_start;
      oc.far = cam.clip_end;
      m.decompose(oc.position, oc.quaternion, new THREE.Vector3());
      oc.updateProjectionMatrix();
      oc.updateMatrixWorld(true);
      return oc;
    }
    const fov = cameraFovY(cam, renderAspect);
    const c = this.sceneCam;
    c.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(fov / 2) * fitScale));
    c.aspect = viewAspect;
    c.near = cam.clip_start;
    c.far = cam.clip_end;
    m.decompose(c.position, c.quaternion, new THREE.Vector3());
    c.updateProjectionMatrix();
    c.updateMatrixWorld(true);
    return c;
  }

  /** Rectangle of the camera frame in CSS pixels (for the passepartout overlay). */
  cameraFrameRect(): { x: number; y: number; w: number; h: number } | null {
    if (!this.session.view.cameraView.value || !this.ev?.render) return null;
    const render = this.ev.render;
    const renderAspect = render.resolution_x / Math.max(1, render.resolution_y);
    const viewAspect = this.width / Math.max(1, this.height);
    const fitScale = Math.max(1, renderAspect / viewAspect) / 0.88;
    const h = this.height / fitScale;
    const w = h * renderAspect;
    return { x: (this.width - w) / 2, y: (this.height - h) / 2, w, h };
  }

  private render(): void {
    const v = this.session.view;
    const aspect = this.width / Math.max(1, this.height);
    if (!(v.cameraView.value && this.ev?.activeCamera?.camera)) {
      applyPoseToCamera(this.pose, this.pose.ortho ? this.orthoCam : this.perspCam, aspect);
    }
    const cam = this.camera;
    updateGrid(this.grid, this.pose.distance, this.pose.ortho);
    const cl = this.session.state.cursorLocation;
    this.cursor.position.set(cl[0], cl[1], cl[2]);
    this.renderPass.camera = cam;
    this.overlayPass.camera = cam;
    this.outlineSel.renderCamera = cam;
    this.outlineActive.renderCamera = cam;
    this.composer.render();
    v.viewLabel.value = v.cameraView.value ? 'Camera Perspective' : viewLabel(this.pose);
    for (const cb of this.onAfterRender) cb();
  }

  resize(): void {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    const pr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.requestRender();
  }

  // ------------------------------------------------------------------ view manipulation

  setPose(p: ViewPose, animate = false): void {
    this.session.view.following.value = null;
    if (animate) this.animating = { from: clonePose(this.pose), to: p, start: performance.now(), dur: 220 };
    else {
      this.pose = p;
      this.persistPose();
    }
    this.requestRender();
  }

  /** Called after interactive navigation; publishes the view for "follow" and saves it locally. */
  persistPose(): void {
    this.session.schedulePresence(poseToPresence(this.pose));
    try {
      localStorage.setItem(
        `3d-editor:view:${this.session.id}`,
        JSON.stringify({ ...this.pose, target: this.pose.target.toArray() }),
      );
    } catch {
      /* ignore */
    }
  }

  private restorePose(): void {
    try {
      const raw = localStorage.getItem(`3d-editor:view:${this.session.id}`);
      if (!raw) return;
      const p = JSON.parse(raw);
      this.pose = { ...DEFAULT_POSE(), ...p, target: new THREE.Vector3().fromArray(p.target) };
    } catch {
      /* ignore */
    }
  }

  /** World-space bounding sphere of objects (all visible when ids omitted). */
  boundsOf(ids?: string[]): THREE.Sphere | null {
    if (!this.ev) this.sync();
    const box = new THREE.Box3();
    const list = ids
      ? ids.map((id) => this.ev!.byId.get(id)).filter(Boolean)
      : this.ev!.objects.filter((o) => o.visible);
    for (const o of list) {
      if (!o) continue;
      if (o.mesh) {
        const b = meshBounds(o.mesh);
        if (b)
          for (const x of [b.min[0], b.max[0]])
            for (const y of [b.min[1], b.max[1]])
              for (const z of [b.min[2], b.max[2]])
                box.expandByPoint(new THREE.Vector3(...transformPoint3(o.worldMatrix, [x, y, z])));
      } else box.expandByPoint(new THREE.Vector3(o.worldMatrix[12], o.worldMatrix[13], o.worldMatrix[14]));
    }
    if (box.isEmpty()) return null;
    return box.getBoundingSphere(new THREE.Sphere());
  }

  frameSphere(sphere: THREE.Sphere | null, animate = true): void {
    if (!sphere) return;
    const p = clonePose(this.pose);
    p.target.copy(sphere.center);
    const r = Math.max(sphere.radius, 0.1);
    p.distance = (r / Math.sin(p.fovY / 2)) * 1.1;
    this.session.view.cameraView.value = false;
    this.setPose(p, animate);
  }

  /** Projects a world point to CSS pixel coordinates (x right, y down) and NDC depth. */
  project(p: Vec3 | THREE.Vector3): { x: number; y: number; z: number } {
    const v = p instanceof THREE.Vector3 ? p.clone() : new THREE.Vector3(p[0], p[1], p[2]);
    v.project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.width, y: (-v.y * 0.5 + 0.5) * this.height, z: v.z };
  }

  /** Ray through a CSS pixel. */
  rayAt(x: number, y: number): THREE.Raycaster {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1), this.camera);
    rc.params.Line = { threshold: 0.05 * (this.pose.distance / 10) };
    rc.params.Points = { threshold: 0.1 };
    return rc;
  }

  /** Point on the plane through `origin` facing the camera, under the mouse. */
  viewPlanePoint(x: number, y: number, origin: THREE.Vector3): THREE.Vector3 | null {
    const rc = this.rayAt(x, y);
    const n = new THREE.Vector3();
    this.camera.getWorldDirection(n);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, origin);
    return rc.ray.intersectPlane(plane, new THREE.Vector3());
  }

  /** Renders the scene from the active camera into a PNG data URL at a given size (F12 / RPC). */
  async renderImage(
    opts: { width?: number; height?: number; cameraId?: string; useViewport?: boolean } = {},
  ): Promise<{ dataUrl: string; width: number; height: number }> {
    const span = telemetry.startSpan('render.image');
    try {
      if (!this.ev) this.sync();
      const ev = this.ev!;
      const render = ev.render;
      const scale = render.resolution_percentage / 100;
      const width = Math.max(16, Math.min(4096, Math.round(opts.width ?? render.resolution_x * scale)));
      const height = Math.max(16, Math.min(4096, Math.round(opts.height ?? render.resolution_y * scale)));
      const aspect = width / height;
      let cam: THREE.Camera;
      const camObj = opts.cameraId ? ev.byId.get(opts.cameraId) : ev.activeCamera;
      if (!opts.useViewport && camObj?.camera) {
        const cd = camObj.camera;
        const m = new THREE.Matrix4().fromArray(camObj.worldMatrix);
        if (cd.type === 'ORTHO') {
          const e = orthoHalfExtents(cd, aspect);
          const oc = new THREE.OrthographicCamera(
            -e.halfW,
            e.halfW,
            e.halfH,
            -e.halfH,
            cd.clip_start,
            cd.clip_end,
          );
          m.decompose(oc.position, oc.quaternion, new THREE.Vector3());
          cam = oc;
        } else {
          const pc = new THREE.PerspectiveCamera(
            THREE.MathUtils.radToDeg(cameraFovY(cd, aspect)),
            aspect,
            cd.clip_start,
            cd.clip_end,
          );
          m.decompose(pc.position, pc.quaternion, new THREE.Vector3());
          cam = pc;
        }
      } else {
        const pc = new THREE.PerspectiveCamera(40, aspect, 0.01, 10000);
        applyPoseToCamera(this.pose, pc, aspect);
        cam = pc;
      }
      cam.updateMatrixWorld(true);
      (cam as THREE.PerspectiveCamera).updateProjectionMatrix?.();
      // final render: rendered shading, no overlays
      const prevShading = this.session.view.shading.value;
      const prevOverlays = this.session.view.overlays.value;
      this.session.view.shading.value = 'RENDERED';
      this.session.view.overlays.value = false;
      this.sync();
      const target = new THREE.WebGLRenderTarget(width, height, { samples: 8, type: THREE.HalfFloatType });
      // The composer output is already tone mapped and sRGB encoded, so copy it raw (linear target).
      const out = new THREE.WebGLRenderTarget(width, height, { type: THREE.UnsignedByteType });
      const comp = new EffectComposer(this.renderer, target);
      comp.renderToScreen = false;
      comp.setPixelRatio(1);
      comp.setSize(width, height);
      const transparent = render.film_transparent;
      const prevBg = this.scene.background;
      if (transparent) this.scene.background = null;
      comp.addPass(new RenderPass(this.scene, cam));
      comp.addPass(new OutputPass());
      comp.render();
      // copy result (composer read buffer) into a byte target via a fullscreen quad
      const readTarget = comp.readBuffer;
      const quad = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.MeshBasicMaterial({
          map: readTarget.texture,
          transparent: true,
          toneMapped: false,
          depthTest: false,
        }),
      );
      const qs = new THREE.Scene();
      qs.add(quad);
      const qc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const prevTm = this.renderer.toneMapping;
      const prevClear = this.renderer.getClearColor(new THREE.Color());
      const prevAlpha = this.renderer.getClearAlpha();
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.renderer.setRenderTarget(out);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear();
      this.renderer.render(qs, qc);
      const pixels = new Uint8Array(width * height * 4);
      this.renderer.readRenderTargetPixels(out, 0, 0, width, height, pixels);
      this.renderer.setRenderTarget(null);
      this.renderer.toneMapping = prevTm;
      this.renderer.setClearColor(prevClear, prevAlpha);
      this.scene.background = prevBg;
      target.dispose();
      out.dispose();
      comp.dispose();
      quad.geometry.dispose();
      (quad.material as THREE.Material).dispose();
      this.session.view.shading.value = prevShading;
      this.session.view.overlays.value = prevOverlays;
      this.invalidate();
      // flip rows (WebGL origin is bottom-left)
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      const img = ctx.createImageData(width, height);
      for (let y = 0; y < height; y++)
        img.data.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
      if (!transparent) for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
      ctx.putImageData(img, 0, 0);
      span.setAttribute('render.width', width).setAttribute('render.height', height).setOk();
      return { dataUrl: canvas.toDataURL('image/png'), width, height };
    } catch (err) {
      span.setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      telemetry.histogram('editor.render_ms', span.end());
    }
  }

  /** Small JPEG of the current viewport for project thumbnails. */
  thumbnail(maxW = 320): string | null {
    try {
      this.render();
      const src = this.renderer.domElement;
      const scale = maxW / Math.max(1, src.width);
      const c = document.createElement('canvas');
      c.width = Math.round(src.width * scale);
      c.height = Math.round(src.height * scale);
      c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.7);
    } catch {
      return null;
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    for (const d of this.disposers) d();
    this.objects.dispose();
    this.edit.dispose();
    this.composer.dispose();
    this.pmrem.dispose();
    this.envTexture?.dispose();
    this.renderer.dispose();
  }
}
