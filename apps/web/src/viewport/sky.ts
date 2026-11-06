import * as THREE from 'three';
import {
  meshBounds,
  skyEquirect,
  skySun,
  type EvaluatedScene,
  type MeshData,
  type WorldSettings,
} from '@3d-editor/core';
import { setProceduralScene } from './materials';

/*
 * World sky and mist in the viewport.
 *
 * - environment SKY (Rendered shading): the analytic sky of @3d-editor/core is rendered into an
 *   equirectangular HalfFloat texture; without the sun disc it becomes the PMREM environment
 *   (image-based lighting), with the sun disc the background. The sun itself is a shadow-casting
 *   DirectionalLight with the irradiance of `skySun` (W/m², like SUN lamps). Sky radiance is
 *   scaled by world strength × environment_strength like in every other renderer; the sky ignores
 *   environment_rotation (sun_rotation orients it).
 * - mist (Material Preview and Rendered): three.js FogExp2 with the world mist density and colour,
 *   i.e. 1 − exp(−(density·depth)²) over the view depth, exactly what the CPU renderer applies.
 */

/** Largest finite half float. */
const HALF_MAX = 65504;

type Box = { min: number[]; max: number[] };
const boxes = new WeakMap<MeshData, Box | null>();

function skyKey(w: WorldSettings): string {
  return JSON.stringify([
    w.sky_zenith_color,
    w.sky_horizon_color,
    w.sky_ground_color,
    w.sun_elevation,
    w.sun_rotation,
    w.sun_intensity,
    w.sun_size,
    w.sun_color,
  ]);
}

/** Equirect texture (three.js layout: row 0 = nadir) from the core image (row 0 = zenith). */
function equirectTexture(
  world: WorldSettings,
  width: number,
  height: number,
  sun: boolean,
): THREE.DataTexture {
  const src = skyEquirect(world, width, height, { sun });
  const data = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = (height - 1 - y) * width;
    for (let x = 0; x < width; x++) {
      const i = (from + x) * 3;
      const o = (y * width + x) * 4;
      for (let k = 0; k < 3; k++) {
        const v = src[i + k];
        data[o + k] = THREE.DataUtils.toHalfFloat(v > 0 ? (v < HALF_MAX ? v : HALF_MAX) : 0);
      }
      data[o + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** World-space bounding sphere of the visible meshes (null when there are none). */
function sceneBounds(ev: EvaluatedScene): THREE.Sphere | null {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  for (const o of ev.objects) {
    if (!o.mesh || !o.visible) continue;
    let b = boxes.get(o.mesh);
    if (b === undefined) boxes.set(o.mesh, (b = meshBounds(o.mesh)));
    if (!b) continue;
    m.fromArray(o.worldMatrix);
    for (let i = 0; i < 8; i++)
      box.expandByPoint(
        v
          .set(i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2])
          .applyMatrix4(m),
      );
  }
  return box.isEmpty() ? null : box.getBoundingSphere(new THREE.Sphere());
}

/** Applies the world's procedural sky and mist to a three.js scene (see the module comment). */
export class ViewportSky {
  readonly sun = new THREE.DirectionalLight();
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private background: THREE.DataTexture | null = null;
  private envKey = '';
  private backgroundKey = '';
  private readonly fog = new THREE.FogExp2(0xffffff, 0);

  constructor(private readonly pmrem: THREE.PMREMGenerator) {
    this.sun.name = 'Sky Sun';
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 2;
  }

  /**
   * Updates environment, background, sun light and fog for a shading mode. Call after the engine
   * set its own environment/background (on every sync): the sky overrides them in Rendered shading.
   * Also publishes the evaluated scene for the procedural materials (`setProceduralScene`).
   */
  apply(scene: THREE.Scene, ev: EvaluatedScene, shading: string, castShadows: boolean): void {
    setProceduralScene(scene, ev);
    const world = ev.world;
    this.applyMist(scene, world, shading === 'MATERIAL' || shading === 'RENDERED');
    if (shading !== 'RENDERED' || world.environment !== 'SKY') {
      this.detachSun(scene);
      return;
    }
    // lighting: a small sun-less equirect is plenty for PMREM; the sharp background (with the sun
    // disc) is only built while it is shown, so animated skies stay cheap
    const key = skyKey(world);
    if (key !== this.envKey || !this.envTarget) {
      this.envKey = key;
      const env = equirectTexture(world, 256, 128, false);
      this.envTarget?.dispose();
      this.envTarget = this.pmrem.fromEquirectangular(env);
      env.dispose();
    }
    const strength = Number.isFinite(world.strength) ? Math.max(0, world.strength) : 1;
    const envStrength = Number.isFinite(world.environment_strength)
      ? Math.max(0, world.environment_strength)
      : 1;
    const scale = strength * envStrength;
    scene.environment = this.envTarget.texture;
    scene.environmentIntensity = scale;
    scene.environmentRotation.set(Math.PI / 2, 0, 0);
    if (world.show_environment_background) {
      if (key !== this.backgroundKey || !this.background) {
        this.backgroundKey = key;
        this.background?.dispose();
        this.background = equirectTexture(world, 1024, 512, true);
      }
      scene.background = this.background;
      scene.backgroundIntensity = scale;
      scene.backgroundBlurriness = 0;
      scene.backgroundRotation.set(Math.PI / 2, 0, 0);
    }
    this.applySun(scene, ev, world, scale, castShadows);
  }

  private applyMist(scene: THREE.Scene, world: WorldSettings, enabled: boolean): void {
    const density = world.mist_density;
    if (enabled && typeof density === 'number' && Number.isFinite(density) && density > 0) {
      const c = world.mist_color ?? [0, 0, 0];
      this.fog.color.setRGB(Math.max(0, c[0] || 0), Math.max(0, c[1] || 0), Math.max(0, c[2] || 0));
      this.fog.density = density;
      scene.fog = this.fog;
    } else if (scene.fog === this.fog) scene.fog = null;
  }

  private applySun(
    scene: THREE.Scene,
    ev: EvaluatedScene,
    world: WorldSettings,
    scale: number,
    castShadows: boolean,
  ): void {
    const sun = skySun(world);
    const e = sun.irradiance;
    const peak = Math.max(e[0], e[1], e[2]);
    if (!sun.visible || !(peak > 0) || !(scale > 0)) {
      this.detachSun(scene);
      return;
    }
    const light = this.sun;
    if (light.parent !== scene) {
      scene.add(light);
      scene.add(light.target);
    }
    light.color.setRGB(e[0] / peak, e[1] / peak, e[2] / peak);
    // the sun's irradiance (W/m²), like SUN lamps and the core renderers' sky sun
    light.intensity = peak * scale;
    // place the light (and its shadow frustum) around the visible geometry
    const sphere = sceneBounds(ev) ?? new THREE.Sphere(new THREE.Vector3(), 10);
    const r = Math.max(sphere.radius, 0.5);
    const d = sun.direction;
    light.target.position.copy(sphere.center);
    light.position.set(
      sphere.center.x + d[0] * (r + 1),
      sphere.center.y + d[1] * (r + 1),
      sphere.center.z + d[2] * (r + 1),
    );
    light.target.updateMatrixWorld();
    light.updateMatrixWorld();
    light.castShadow = castShadows;
    const cam = light.shadow.camera;
    cam.left = cam.bottom = -r;
    cam.right = cam.top = r;
    cam.near = 0.01;
    cam.far = 2 * r + 2;
    cam.updateProjectionMatrix();
  }

  private detachSun(scene: THREE.Scene): void {
    if (this.sun.parent === scene) {
      scene.remove(this.sun);
      scene.remove(this.sun.target);
    }
  }

  dispose(): void {
    this.envTarget?.dispose();
    this.background?.dispose();
    this.envTarget = null;
    this.background = null;
    this.sun.dispose();
  }
}
