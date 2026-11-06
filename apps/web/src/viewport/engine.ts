import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { effect } from '@preact/signals';
import {
  SceneEvaluator,
  cameraFovY,
  meshBounds,
  orthoHalfExtents,
  transformPoint3,
  type EvaluatedScene,
  type MeshData,
  type RenderEngine,
  type Vec3,
} from '@3d-editor/core';
import type { ProjectSession } from '../project/session';
import {
  applyLensShift,
  finalRenderScene,
  pathTraceDocument,
  pixelsToDataUrl,
  renderOutputSize,
  renderViewFromCamera,
  sceneCameraView,
  viewportCamera,
  type PathTraceJob,
  type PathTraceOptions,
  type PixelImage,
} from '../render';
import { SceneObjects } from './scene-objects';
import { ViewportSky } from './sky';
import { ViewTransformPass } from './view-transform';
import { STUDIO_RIG, STUDIO_RIG_AMBIENT, WorldEnvironment, aimStudioRig, needsStudioRig } from './world-env';
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

/** Default sampling budget (seconds) of path traced `renderImage` calls (RPC renders time out at 15 s). */
export const RPC_PATH_TRACE_SECONDS = 10;

/** The evaluator of final renders is dropped after this long without renders (its caches can be big). */
const FINAL_EVALUATOR_IDLE_MS = 60_000;

/**
 * Divides colour by alpha (straight alpha) for transparent-film renders: a render over a clear
 * alpha of 0 holds coverage-weighted colours at edges and in blended surfaces.
 */
const UNPREMULTIPLY_SHADER = {
  name: 'UnpremultiplyShader',
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      gl_FragColor = c.a > 0.0 ? vec4(c.rgb / c.a, c.a) : vec4(0.0);
    }`,
};

/** Options of {@link ViewportEngine.renderImage} and the other render entry points. */
export interface RenderImageOptions {
  width?: number;
  height?: number;
  cameraId?: string;
  /**
   * Show what the viewport shows (a capture): its own view, orthographic or perspective like the
   * viewport, or the scene camera while the viewport looks through it.
   */
  useViewport?: boolean;
  /** Explicit viewpoint (world space, Z up); fov in degrees. */
  view?: { position: number[]; target: number[]; up?: number[]; fov_degrees?: number } | null;
  /** Viewport shading for the image (default RENDERED). */
  shading?: 'WIREFRAME' | 'SOLID' | 'MATERIAL' | 'RENDERED' | null;
  /** Evaluate the scene at this frame. */
  frame?: number | null;
  /** Render engine (default: the render settings; viewport captures rasterize). */
  engine?: RenderEngine | null;
  /** PATHTRACER: samples per pixel (default: render settings). */
  samples?: number;
  /** PATHTRACER: maximum bounces (default: render settings). */
  max_bounces?: number;
  /** PATHTRACER: denoise (default: render settings). */
  denoise?: boolean;
  /** PATHTRACER: sampling budget in seconds (0 = none). */
  time_limit?: number;
  /** PATHTRACER: noise seed (default 0). */
  seed?: number;
}

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
  /** Exposure, view transform and sRGB encoding of the viewport (see view-transform.ts). */
  private outputPass = new ViewTransformPass();
  /** The view transform and exposure (stops) the last `applyShading` chose. */
  private colorManagement: { view: string; exposure: number } = { view: 'STANDARD', exposure: 0 };
  private grid = createGrid();
  private cursor: THREE.Sprite;
  private originDots: THREE.Points;
  private peerBoxes = new THREE.Group();
  private ambient = new THREE.AmbientLight(0xffffff, 0);
  private envTexture: THREE.Texture | null = null;
  private pmrem: THREE.PMREMGenerator;
  /** The STUDIO / IMAGE world environment of Rendered shading and final renders. */
  private worldEnv: WorldEnvironment;
  /** World sky (environment SKY) and mist. */
  private sky: ViewportSky;
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
    this.sky = new ViewportSky(this.pmrem);
    this.worldEnv = new WorldEnvironment(this.pmrem);
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
    this.composer.addPass(this.outputPass);

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

  /** Lighting, background and colour management of `shading` (default: the viewport's) for `ev`. */
  private applyShading(ev: EvaluatedScene = this.ev!, shading = this.session.view.shading.value): void {
    const world = ev.world;
    const r = this.renderer;
    // Colour management (exposure, view transform, sRGB) is the output pass's, with the core
    // renderers' curves; three.js's own tone mapping stays off. Solid / wireframe: Standard.
    r.toneMapping = THREE.NoToneMapping;
    r.toneMappingExposure = 1;
    this.colorManagement =
      shading === 'RENDERED' || shading === 'MATERIAL'
        ? { view: ev.render.view_transform ?? 'AGX', exposure: ev.render.exposure ?? 0 }
        : { view: 'STANDARD', exposure: 0 };
    this.outputPass.setTransform(this.colorManagement.view, this.colorManagement.exposure);
    r.shadowMap.enabled = shading === 'RENDERED' && ev.render.use_shadows;
    // Material Preview: three.js's studio room as a look-dev HDRI, whatever the world (like
    // Blender's). Rendered: the world as the core renderers light it: a STUDIO / IMAGE environment
    // (world-env.ts), the procedural sky (sky.ts, below) or the flat world colour.
    if (shading === 'MATERIAL' && !this.envTexture)
      this.envTexture = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    const env = shading === 'RENDERED' ? this.worldEnv.maps(this.session.doc, world) : null;
    const ws = Number.isFinite(world.strength) ? Math.max(0, world.strength) : 1;
    this.scene.environment = shading === 'MATERIAL' ? this.envTexture : (env?.lighting ?? null);
    this.scene.environmentIntensity = env ? env.scale : 1;
    // equirect layouts are Y up; the scene is Z up
    this.scene.environmentRotation.set(Math.PI / 2, 0, 0);
    this.scene.backgroundRotation.set(Math.PI / 2, 0, 0);
    this.scene.backgroundIntensity = 1;
    this.scene.backgroundBlurriness = 0;
    // the core renderers' studio rig lights a scene without any light (aimed per render)
    this.rigNeeded =
      shading === 'RENDERED' && needsStudioRig(ev, !!env || world.environment === 'SKY', this.finalShading);
    for (const l of this.studioRig) l.visible = this.rigNeeded;
    if (shading === 'RENDERED') {
      if (env && world.show_environment_background) {
        this.scene.background = env.background();
        this.scene.backgroundIntensity = env.scale;
      } else
        this.scene.background = new THREE.Color(
          world.color[0] * ws,
          world.color[1] * ws,
          world.color[2] * ws,
        );
      // the flat world colour lights the scene (radiance colour × strength: irradiance π × that),
      // unless an environment or the sky does
      const boost = this.rigNeeded ? STUDIO_RIG_AMBIENT : 0;
      this.ambient.color.setRGB(
        world.color[0] * ws + boost,
        world.color[1] * ws + boost,
        world.color[2] * ws + boost,
      );
      this.ambient.intensity = env || world.environment === 'SKY' ? 0 : Math.PI;
    } else if (shading === 'MATERIAL') {
      this.scene.background = this.envTexture;
      this.scene.backgroundBlurriness = 0.6;
      this.ambient.intensity = 0;
    } else {
      this.scene.background = VIEWPORT_BG;
      this.ambient.intensity = 0;
    }
    // procedural sky (Rendered) and mist (Material Preview / Rendered) override the above
    this.sky.apply(this.scene, ev, shading, r.shadowMap.enabled);
  }

  /** Whether the studio rig lights the scene (see `needsStudioRig`), set by `applyShading`. */
  private rigNeeded = false;
  /** Whether `applyShading` runs for a final render (render visibility) rather than the viewport. */
  private finalShading = false;
  /** The key, fill and rim suns of the studio rig (world-env.ts). */
  private studioRig = STUDIO_RIG.map(() => {
    const l = new THREE.DirectionalLight(0xffffff, 0);
    l.visible = false;
    this.scene.add(l, l.target);
    return l;
  });

  /** Points the studio rig at a camera when it is on. */
  private aimRig(camera: THREE.Camera): void {
    if (this.rigNeeded) aimStudioRig(this.studioRig, camera);
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
    // lens shift moves the image inside the centred camera frame (see cameraFrameRect), as in renders:
    // the frame's half size in viewport NDC scales the render's shift
    const shiftX = cam.shift_x * (renderAspect / (viewAspect * fitScale));
    const shiftY = cam.shift_y / fitScale;
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
      applyLensShift(oc, shiftX, shiftY, renderAspect);
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
    applyLensShift(c, shiftX, shiftY, renderAspect);
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
    this.aimRig(cam);
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

  /**
   * Renders the scene from the active camera into a PNG data URL at a given size (F12 / RPC).
   * When the engine (option, else the render settings) is PATHTRACER the image is path traced on
   * the render workers, except SOLID / WIREFRAME shading and viewport captures (`useViewport`
   * without an explicit engine), which rasterize; path traced renders stop sampling after
   * `time_limit` seconds (default {@link RPC_PATH_TRACE_SECONDS}, within the server's RPC timeout).
   */
  async renderImage(
    opts: RenderImageOptions = {},
  ): Promise<{ dataUrl: string; width: number; height: number }> {
    const span = telemetry.startSpan('render.image');
    try {
      let img: PixelImage;
      if (this.pathTraces(opts)) {
        span.setAttribute('render.engine', 'PATHTRACER');
        const r = await this.startPathTrace({
          ...opts,
          time_limit: opts.time_limit ?? RPC_PATH_TRACE_SECONDS,
        }).result;
        span.setAttribute('render.samples', r.samples);
        img = r;
      } else img = this.renderPixels(opts);
      span.setAttribute('render.width', img.width).setAttribute('render.height', img.height).setOk();
      return { dataUrl: pixelsToDataUrl(img), width: img.width, height: img.height };
    } catch (err) {
      span.setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      telemetry.histogram('editor.render_ms', span.end());
    }
  }

  /** Whether {@link renderImage} path traces with these options. */
  pathTraces(opts: RenderImageOptions = {}): boolean {
    const engine = opts.engine ?? (opts.useViewport ? 'RASTER' : this.session.doc.getRender().engine);
    return engine === 'PATHTRACER' && opts.shading !== 'SOLID' && opts.shading !== 'WIREFRAME';
  }

  /**
   * Output size of a render: the options (a missing side follows the output's aspect ratio), else
   * the output settings (resolution × %). Larger than 4096 px on a side, both sides are scaled by
   * the same factor, so the image keeps the camera's framing (see {@link renderOutputSize}).
   */
  private renderSize(opts: RenderImageOptions): { width: number; height: number } {
    const render = this.session.doc.getRender();
    const aspect = render.resolution_x / Math.max(1, render.resolution_y);
    const size =
      opts.width === undefined && opts.height === undefined
        ? renderOutputSize(render.resolution_x, render.resolution_y, render.resolution_percentage)
        : renderOutputSize(opts.width ?? opts.height! * aspect, opts.height ?? opts.width! / aspect, 100);
    return { width: size.width, height: size.height };
  }

  /**
   * Starts a progressive path traced render on the render workers with {@link renderImage}'s view
   * choice: the explicit view, else the camera (option or scene camera), else the viewport's view.
   * The document is captured now; the render settings give samples, bounces and denoising unless
   * the options override them.
   */
  startPathTrace(opts: RenderImageOptions = {}): PathTraceJob {
    const { width, height } = this.renderSize(opts);
    const frame =
      typeof opts.frame === 'number' && Number.isFinite(opts.frame) ? opts.frame : this.session.state.frame;
    const o: PathTraceOptions = { width, height, frame };
    if (opts.samples !== undefined) o.samples = opts.samples;
    if (opts.max_bounces !== undefined) o.max_bounces = opts.max_bounces;
    if (opts.denoise !== undefined) o.denoise = opts.denoise;
    if (opts.seed !== undefined) o.seed = opts.seed;
    if (opts.time_limit !== undefined) o.timeLimit = opts.time_limit;
    // the workers evaluate the camera at `frame` (`cameraId`); whether there is one is read from
    // the document as it is now (the viewport's last evaluation can be stale, e.g. in a hidden tab)
    const cameraId = opts.view ? null : this.renderCameraId(opts);
    if (opts.view) {
      const v = opts.view;
      o.viewSpec = {
        position: [v.position[0], v.position[1], v.position[2]],
        target: [v.target[0], v.target[1], v.target[2]],
        up: v.up ? [v.up[0], v.up[1], v.up[2]] : [0, 0, 1],
        fovY: THREE.MathUtils.degToRad(v.fov_degrees ?? 50),
      };
    } else if (cameraId) o.cameraId = cameraId;
    // the viewport's view (orthographic when the viewport is), like the rasterized render
    else o.view = renderViewFromCamera(viewportCamera(this.pose, width / height, true));
    return pathTraceDocument(this.session.doc, o);
  }

  /**
   * Whether a render without an explicit view shows the camera (option or scene camera): always,
   * except viewport captures (`useViewport`) while the viewport is not looking through the camera.
   */
  private rendersCamera(opts: RenderImageOptions): boolean {
    return !opts.useViewport || this.session.view.cameraView.value;
  }

  /**
   * The camera object a render without an explicit view shows (see {@link rendersCamera}): the
   * requested camera, else the scene camera; null when it shows the viewport's view. Read from the
   * document as it is now, not from the viewport's last evaluation. A requested object that is not a
   * camera is an error.
   */
  private renderCameraId(opts: RenderImageOptions): string | null {
    if (!this.rendersCamera(opts)) return null;
    const doc = this.session.doc;
    const isCamera = (id: string | null | undefined) => {
      const o = id ? doc.getObject(id) : null;
      return !!o && o.type === 'CAMERA' && !!o.data && !!doc.getCamera(o.data);
    };
    if (opts.cameraId) {
      if (!isCamera(opts.cameraId)) {
        const o = doc.getObject(opts.cameraId);
        throw new Error(
          o ? `'${o.name}' is a ${o.type} object, not a camera` : `Camera '${opts.cameraId}' not found`,
        );
      }
      return opts.cameraId;
    }
    const sceneCamera = doc.getScene().camera;
    return isCamera(sceneCamera) ? sceneCamera : null;
  }

  /**
   * Rasterizes the scene (WebGL, Rendered shading unless `shading` says otherwise) with
   * {@link renderImage}'s camera choice and returns RGBA8 pixels (top row first).
   *
   * A final render (F12, Render Animation, MCP renders) shows the document as it is now, evaluated
   * for rendering like the path tracer and the server's renderers: objects visible in renders
   * (`hide_render`, not `hide_viewport`), modifiers with their render settings (Subdivision render
   * levels, `show_render`), curve render resolution and render particle amounts, shape keys also
   * while the viewport is in Edit Mode, and none of the viewport's display settings (X-ray, Display
   * As Wire / Bounds, live transform previews). A capture (`useViewport`) shows the viewport as it
   * is, with `shading` and without overlays.
   */
  renderPixels(opts: RenderImageOptions = {}): PixelImage {
    const { width, height } = this.renderSize(opts);
    const aspect = width / height;
    const view = this.session.view;
    const state = this.session.state;
    const shading = opts.shading ?? 'RENDERED';
    const frame = typeof opts.frame === 'number' && Number.isFinite(opts.frame) ? opts.frame : state.frame;
    const prevShading = view.shading.value;
    const prevOverlays = view.overlays.value;
    const prevFrame = state.frame;
    const prevBg = this.scene.background;
    const disposables: { dispose(): void }[] = [];
    try {
      // The camera comes from this evaluation too: the viewport's own one is from its last animation
      // frame (stale in hidden tabs, which get none) and at the viewport's frame.
      let ev: EvaluatedScene;
      if (opts.useViewport) {
        state.frame = frame;
        view.shading.value = shading;
        view.overlays.value = false;
        this.sync();
        ev = this.ev!;
      } else ev = this.syncFinalRender(frame, shading);
      const cam = this.renderCamera(ev, opts, aspect);
      this.aimRig(cam);
      const target = new THREE.WebGLRenderTarget(width, height, { samples: 8, type: THREE.HalfFloatType });
      // The composer output is already tone mapped and sRGB encoded, so copy it raw (linear target).
      const out = new THREE.WebGLRenderTarget(width, height, { type: THREE.UnsignedByteType });
      const comp = new EffectComposer(this.renderer, target);
      disposables.push(target, out, comp);
      comp.renderToScreen = false;
      comp.setPixelRatio(1);
      comp.setSize(width, height);
      // Film > Transparent: no world background and a clear alpha of 0, so the background stays
      // transparent; the coverage-weighted (premultiplied) colours are divided by alpha before tone
      // mapping, so the PNG has straight alpha without dark fringes, like the path tracer's film.
      const transparent = ev.render.film_transparent;
      if (transparent) this.scene.background = null;
      comp.addPass(
        new RenderPass(
          this.scene,
          cam,
          null,
          transparent ? new THREE.Color(0, 0, 0) : null,
          transparent ? 0 : null,
        ),
      );
      if (transparent) {
        const unpremultiply = new ShaderPass(UNPREMULTIPLY_SHADER);
        disposables.push(unpremultiply);
        comp.addPass(unpremultiply);
      }
      // exposure, view transform and sRGB encoding like the path tracer's film (view-transform.ts)
      const output = new ViewTransformPass();
      output.setTransform(this.colorManagement.view, this.colorManagement.exposure);
      disposables.push(output);
      comp.addPass(output);
      comp.render();
      // copy result (composer read buffer) into a byte target via a fullscreen quad, unblended
      const quad = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.MeshBasicMaterial({
          map: comp.readBuffer.texture,
          blending: THREE.NoBlending,
          toneMapped: false,
          depthTest: false,
        }),
      );
      disposables.push(quad.geometry, quad.material);
      const qs = new THREE.Scene();
      qs.add(quad);
      const qc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const prevTm = this.renderer.toneMapping;
      const prevClear = this.renderer.getClearColor(new THREE.Color());
      const prevAlpha = this.renderer.getClearAlpha();
      const pixels = new Uint8Array(width * height * 4);
      try {
        this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.setRenderTarget(out);
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.clear();
        this.renderer.render(qs, qc);
        this.renderer.readRenderTargetPixels(out, 0, 0, width, height, pixels);
      } finally {
        this.renderer.setRenderTarget(null);
        this.renderer.toneMapping = prevTm;
        this.renderer.setClearColor(prevClear, prevAlpha);
      }
      // flip rows (WebGL origin is bottom-left)
      const data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++)
        data.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
      for (let i = 3; i < data.length; i += 4)
        if (!transparent) data[i] = 255;
        else if (data[i] === 0) data[i - 3] = data[i - 2] = data[i - 1] = 0;
      return { width, height, data };
    } finally {
      for (const d of disposables) d.dispose();
      this.scene.background = prevBg;
      view.shading.value = prevShading;
      view.overlays.value = prevOverlays;
      state.frame = prevFrame;
      this.invalidate();
    }
  }

  /** Evaluator of final renders (see {@link finalEvaluator}) and the timer that drops it. */
  private finalEval: SceneEvaluator | null = null;
  private finalEvalTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The evaluator of final renders. It is not the viewport's: its caches keep the geometry evaluated
   * with the render settings, the viewport's with the viewport settings, so neither recomputes the
   * other's. Dropped after {@link FINAL_EVALUATOR_IDLE_MS} without renders.
   */
  private finalEvaluator(): SceneEvaluator {
    this.finalEval ??= new SceneEvaluator(this.session.doc);
    if (this.finalEvalTimer) clearTimeout(this.finalEvalTimer);
    this.finalEvalTimer = setTimeout(() => {
      this.finalEval = null;
      this.finalEvalTimer = null;
    }, FINAL_EVALUATOR_IDLE_MS);
    return this.finalEval;
  }

  /**
   * Mirrors the scene as a final render shows it (see {@link renderPixels}) into the three.js scene
   * with `shading`, and returns that evaluation. The viewport shows its own state again from its
   * next frame. Clay shading (SOLID) has the world colour behind it, like the server's renderer,
   * instead of the viewport's grey.
   */
  private syncFinalRender(
    frame: number,
    shading: NonNullable<RenderImageOptions['shading']>,
  ): EvaluatedScene {
    const s = this.session;
    const ev = finalRenderScene(this.finalEvaluator().evaluate(frame, { forRender: true }));
    const render = ev.render;
    this.objects.sync(s.doc, ev, {
      shading,
      showWireOverlay: false,
      xray: false,
      selected: new Set(s.state.selectedIds),
      activeId: s.state.activeId,
      editObjectId: null,
      renderAspect: render.resolution_x / Math.max(1, render.resolution_y),
      castShadows: shading === 'RENDERED' && render.use_shadows,
      imagesRevision: this.imagesRevision,
    });
    this.finalShading = true;
    try {
      this.applyShading(ev, shading);
    } finally {
      this.finalShading = false;
    }
    if (shading === 'SOLID' || shading === 'WIREFRAME') {
      const w = ev.world;
      const k = Number.isFinite(w.strength) ? Math.max(0, w.strength) : 1;
      this.scene.background = new THREE.Color(w.color[0] * k, w.color[1] * k, w.color[2] * k);
    }
    this.needsSync = true;
    return ev;
  }

  /**
   * The camera of a rasterized render with {@link renderImage}'s camera choice, taken from `ev` (the
   * scene evaluated for this render): the explicit view, else the camera (option or scene camera)
   * with its field of view, clipping and lens shift, else the viewport's view.
   */
  private renderCamera(
    ev: EvaluatedScene,
    opts: RenderImageOptions,
    aspect: number,
  ): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    if (opts.view) {
      const v = opts.view;
      const pc = new THREE.PerspectiveCamera(v.fov_degrees ?? 50, aspect, 0.01, 10000);
      pc.up.set(...((v.up ?? [0, 0, 1]) as [number, number, number]));
      pc.position.set(...(v.position as [number, number, number]));
      pc.lookAt(new THREE.Vector3(...(v.target as [number, number, number])));
      pc.updateMatrixWorld(true);
      pc.updateProjectionMatrix();
      return pc;
    }
    const cameraId = this.renderCameraId(opts);
    const camObj = cameraId ? ev.byId.get(cameraId) : null;
    if (camObj?.camera) return sceneCameraView(camObj.camera, camObj.worldMatrix, aspect);
    const vc = viewportCamera(this.pose, aspect);
    vc.updateMatrixWorld(true);
    vc.updateProjectionMatrix();
    return vc;
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
    this.worldEnv.dispose();
    if (this.finalEvalTimer) clearTimeout(this.finalEvalTimer);
    this.finalEval = null;
    this.resizeObserver.disconnect();
    for (const d of this.disposers) d();
    this.objects.dispose();
    this.edit.dispose();
    this.composer.dispose();
    this.sky.dispose();
    this.pmrem.dispose();
    this.envTexture?.dispose();
    this.renderer.dispose();
  }
}
