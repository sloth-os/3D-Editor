import type { Vec3, Vec4 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';

/*
 * CPU software renderer used when no browser (WebGL) is available — e.g. MCP agents asking the
 * server for a picture of the scene. Z-buffered triangle rasterization with simple PBR-ish
 * shading from scene lights.
 */

export interface SoftwareRenderOptions {
  width: number;
  height: number;
  /** Frame to evaluate (default: scene frame_start). */
  frame?: number;
  /** Camera object id. Default: scene camera, or an automatic view framing all objects. */
  cameraId?: string;
  /** Explicit view (overrides camera). fovY in radians. */
  view?: { position: Vec3; target: Vec3; up?: Vec3; fovY?: number };
  /** RGBA background in 0..1 (default: world color). */
  background?: Vec4;
  shading?: 'SOLID' | 'MATERIAL';
  /** Overlay wireframe edges. */
  wireframe?: boolean;
  /** Supersampling factor for anti-aliasing (1, 2 or 4). */
  samples?: 1 | 2 | 4;
}

export interface RenderedImage {
  width: number;
  height: number;
  /** RGBA8 pixels, row-major, top row first. */
  data: Uint8ClampedArray;
}

export function renderSceneSoftware(_doc: SceneDoc, _opts: SoftwareRenderOptions): RenderedImage {
  throw new Error('renderSceneSoftware not implemented yet');
}

/** Encodes RGBA pixels as a PNG file. */
export function encodePNG(_img: RenderedImage): Uint8Array {
  throw new Error('encodePNG not implemented yet');
}
