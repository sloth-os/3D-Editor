import * as THREE from 'three';
import {
  TextureCache as ImageCache,
  environmentLighting,
  renderItems,
  sampleEnvironmentBackground,
  type EnvironmentLighting,
  type EvaluatedScene,
  type SceneDoc,
  type WorldSettings,
} from '@3d-editor/core';

/*
 * The world lighting of WebGL renders (Rendered shading, F12, Render Animation, MCP renders made by
 * a browser), matching the core renderers (the path tracer and the CPU rasterizer):
 *
 * - STUDIO and IMAGE environments: the core's own environment (`sampleEnvironmentBackground`: the
 *   procedural photo studio, or the equirectangular PNG) sampled into equirectangular half-float
 *   textures, rotated by environment_rotation, lit with three.js image-based lighting (PMREM) and
 *   shown as the background with `show_environment_background`, × world strength ×
 *   environment_strength. Before, the viewport used three.js's RoomEnvironment at a guessed 0.35
 *   scale (and the room for IMAGE worlds as well).
 * - The studio rig of scenes without any light (see {@link needsStudioRig}).
 */

/** Largest finite half float. */
const HALF_MAX = 65504;
/** Width of the equirect the image-based lighting is prefiltered from. */
const LIGHTING_WIDTH = 256;
/** Width of the background of the (smooth) procedural studio. */
const STUDIO_BACKGROUND_WIDTH = 1024;
/** Largest background width of an image environment (its own width below that). */
const MAX_BACKGROUND_WIDTH = 4096;

/** The texture of an environment in three.js's equirect layout (row 0 = nadir), unit strength. */
function equirectTexture(env: EnvironmentLighting, width: number): THREE.DataTexture {
  const w = Math.max(4, Math.round(width));
  const h = Math.max(2, Math.round(w / 2));
  const data = new Uint16Array(w * h * 4);
  const px = new Float64Array(3);
  const one = THREE.DataUtils.toHalfFloat(1);
  for (let row = 0; row < h; row++) {
    // the core's layout (skyEquirect): row 0 is the zenith; column x has azimuth
    // π − 2π(x + ½)/w from +X towards +Y — three.js's once the environment is rotated Z-up
    const y = h - 1 - row;
    const el = Math.PI / 2 - ((y + 0.5) / h) * Math.PI;
    const ce = Math.cos(el);
    const se = Math.sin(el);
    for (let x = 0; x < w; x++) {
      const phi = Math.PI - (2 * Math.PI * (x + 0.5)) / w;
      sampleEnvironmentBackground(env, ce * Math.cos(phi), ce * Math.sin(phi), se, px);
      const o = (row * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        const v = px[k];
        data[o + k] = THREE.DataUtils.toHalfFloat(v > 0 ? (v < HALF_MAX ? v : HALF_MAX) : 0);
      }
      data[o + 3] = one;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** A STUDIO / IMAGE world environment for three.js (see {@link WorldEnvironment.maps}). */
export interface WorldEnvironmentMaps {
  /** Prefiltered environment (PMREM) for image-based lighting, at unit strength. */
  lighting: THREE.Texture;
  /** The environment as the camera sees it, at unit strength (built on first use). */
  background(): THREE.Texture;
  /** Radiance scale: world strength × environment_strength. */
  scale: number;
}

const finiteNonNeg = (v: unknown, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : d;

/** The STUDIO / IMAGE environment textures of a document's world, rebuilt when it changes. */
export class WorldEnvironment {
  private key = '';
  private imageBytes: Uint8Array | null = null;
  private env: EnvironmentLighting | null = null;
  private lighting: THREE.WebGLRenderTarget | null = null;
  private backgroundTexture: THREE.DataTexture | null = null;

  constructor(private readonly pmrem: THREE.PMREMGenerator) {}

  /**
   * The environment of `world` when it is STUDIO or IMAGE, else null; null also when the image is
   * missing or cannot be decoded (only PNG, like the core renderers) or the strength is 0: the
   * renderers then light the scene with the flat world colour.
   */
  maps(doc: SceneDoc, world: WorldSettings): WorldEnvironmentMaps | null {
    if (world.environment !== 'STUDIO' && world.environment !== 'IMAGE') return null;
    const scale = finiteNonNeg(world.strength, 1) * finiteNonNeg(world.environment_strength, 1);
    if (!(scale > 0)) return null;
    const imageId = world.environment === 'IMAGE' ? (world.environment_image ?? '') : '';
    const bytes = imageId ? doc.getImageBytes(imageId) : null;
    if (world.environment === 'IMAGE' && !bytes) return null;
    const rotation = Number.isFinite(world.environment_rotation) ? world.environment_rotation : 0;
    // the content: the studio, or the image (by its bytes); strength is applied at render time
    const key = `${world.environment}|${imageId}|${rotation}`;
    if (key !== this.key || bytes !== this.imageBytes) {
      this.key = key;
      this.imageBytes = bytes;
      this.dispose();
      // decoded afresh (the core's image cache keys by image id, not by content)
      const image = imageId ? new ImageCache(doc).get(imageId) : null;
      this.env = environmentLighting(
        { ...world, strength: 1, environment_strength: 1, environment_rotation: rotation },
        image,
      );
      if (this.env) {
        const tex = equirectTexture(this.env, LIGHTING_WIDTH);
        this.lighting = this.pmrem.fromEquirectangular(tex);
        tex.dispose();
      }
    }
    const env = this.env;
    const lighting = this.lighting;
    if (!env || !lighting) return null;
    return {
      lighting: lighting.texture,
      scale,
      background: () => {
        if (!this.backgroundTexture) {
          const src = env.source;
          const width =
            src && 'image' in src
              ? Math.min(MAX_BACKGROUND_WIDTH, Math.max(256, src.image.width))
              : STUDIO_BACKGROUND_WIDTH;
          this.backgroundTexture = equirectTexture(env, width);
        }
        return this.backgroundTexture;
      },
    };
  }

  dispose(): void {
    this.lighting?.dispose();
    this.backgroundTexture?.dispose();
    this.lighting = null;
    this.backgroundTexture = null;
    this.env = null;
  }
}

/**
 * Camera-relative key, fill and rim suns of the core renderers' studio rig: view-space direction
 * towards the light (x right, y up, z towards the viewer) and irradiance (W/m²).
 */
export const STUDIO_RIG: readonly (readonly [number, number, number, number])[] = [
  [-0.45, 0.6, 0.65, 2.0],
  [0.75, 0.05, 0.6, 0.5],
  [0.15, 0.7, -0.7, 1.0],
];
/** Ambient radiance the rig adds to the world colour. */
export const STUDIO_RIG_AMBIENT = 0.03;

/**
 * Whether the core renderers light `ev` with their camera-relative studio rig (core render/index.ts
 * `buildLights`, pathtrace/compile.ts), so it is never just black: no visible lamps, no world
 * lighting (`worldLit`: a procedural sky, or a STUDIO / IMAGE environment) and no other light (an
 * emissive material, or a world colour × strength of luminance 0.1 or more).
 */
export function needsStudioRig(ev: EvaluatedScene, worldLit: boolean, forRender: boolean): boolean {
  if (worldLit) return false;
  if (ev.objects.some((o) => o.type === 'LIGHT' && !!o.light && o.visible)) return false;
  const w = ev.world;
  const ws = finiteNonNeg(w.strength, 1);
  const c = w.color;
  if ((0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) * ws >= 0.1) return false;
  const emissive = renderItems(ev, { forRender }).some(
    (item) =>
      item.mesh.faces.length > 0 &&
      item.materials.some(
        (m) =>
          !!m &&
          (m.emission_strength ?? 0) > 0 &&
          (m.emission_color.some((x) => x > 0) || !!m.textures?.emission?.procedural),
      ),
  );
  return !emissive;
}

/** Points the rig lights (one DirectionalLight per {@link STUDIO_RIG} entry) for a camera. */
export function aimStudioRig(lights: THREE.DirectionalLight[], camera: THREE.Camera): void {
  camera.updateMatrixWorld();
  const e = camera.matrixWorld.elements;
  // camera basis in world space: right (+X), up (+Y), backwards (+Z: towards the viewer)
  const right = new THREE.Vector3(e[0], e[1], e[2]).normalize();
  const up = new THREE.Vector3(e[4], e[5], e[6]).normalize();
  const back = new THREE.Vector3(e[8], e[9], e[10]).normalize();
  STUDIO_RIG.forEach(([x, y, z, irradiance], i) => {
    const l = lights[i];
    if (!l) return;
    const toLight = new THREE.Vector3()
      .addScaledVector(right, x)
      .addScaledVector(up, y)
      .addScaledVector(back, z)
      .normalize();
    l.position.copy(toLight);
    l.target.position.set(0, 0, 0);
    l.intensity = irradiance;
    l.updateMatrixWorld();
    l.target.updateMatrixWorld();
  });
}
