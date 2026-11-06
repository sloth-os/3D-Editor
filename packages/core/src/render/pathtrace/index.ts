/*
 * CPU path tracer (Cycles-like): two-level BVH, principled BSDF, Blender light units, next-event
 * estimation with MIS, procedural/image textures, environment lighting, an à-trous denoiser and
 * Blender's view transforms for display.
 * Pure TypeScript, no DOM; all scene and film data are plain typed arrays so the work can be split
 * over worker threads with `PathTracer.renderRows`.
 */

export { buildBVH, bvhStats, type BVH } from './bvh';
export { meshGeometry, type MeshGeometry } from './geometry';
export { SceneIntersector, type SceneInstances } from './intersect';
export { Sampler, sobol2, owenScramble, hash32, filterOffset, FILTER_WIDTH } from './sampler';
export { PrincipledBSDF, fresnelDielectric, thinTransmittance, SPECULAR_ALPHA, type BSDFInputs } from './bsdf';
export {
  studioRadiance,
  ENV_UNIFORM,
  ENV_STUDIO,
  ENV_SKY,
  ENV_IMAGE,
  type EnvironmentData,
} from './environment';
export { DEFAULT_SUN_ANGLE, type LampData, type EmitterGroup } from './lights';
export { compileMaterial, type PTMaterial } from './material';
export { buildCamera, CameraRays, type CameraModel } from './camera';
export { compileScene, type CompiledScene, type CompileInput, type SceneLight } from './compile';
export { PathFilm, createPathTile, pathTileTransferables, type PathTile, type FilmImage } from './film';
export { denoiseFilm, type DenoiseOptions } from './denoise';
export {
  PathTracer,
  pathTracerSettings,
  type PathTracerSettings,
  type PathTraceProgress,
  type PathTraceStats,
} from './tracer';
export {
  filmToRGBA8,
  applyViewTransform,
  viewTransformOf,
  VIEW_TRANSFORMS,
  type DisplayBackground,
} from './display';
export {
  renderPathTracedImage,
  preparePathTrace,
  viewCameraData,
  sceneLights,
  type PreparedPathTrace,
  type PathTraceRenderInput,
  type PathTraceRenderOptions,
  type PathTracedImage,
} from './render';
