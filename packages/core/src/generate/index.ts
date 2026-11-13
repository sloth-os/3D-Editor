/*
 * Procedural generators (object.generate_* operators) and scene layout helpers.
 */
export * from './types';
export * from './random';
export * from './noise';
export * from './analysis';
export {
  MeshBuilder,
  addBox,
  addBoxBetween,
  addPrism,
  addRingSurface,
  addLathe,
  addTube,
  addBlade,
  addIcoSphere,
  pathFrames,
  boxProjectUV,
  markSharpEdges,
  placeMesh,
  type SurfaceOpts,
} from './builder';
export * from './isosurface';
export * from './terrain';
export * from './vegetation';
export * from './building';
export * from './architecture';
export * from './furniture';
export * from './mechanical';
export * from './blob';
export * from './layout';
export * from './spatial';
