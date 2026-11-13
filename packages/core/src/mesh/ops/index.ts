/*
 * Edit-mode mesh operations (extrude, inset, bevel, loop cut, ...).
 * Each operation is a pure function: (mesh, selection, params) -> { mesh, selection }.
 */
export * from './types';
// Internal helpers stay private (generic names would collide in the package root); only a few are public.
export { completeSelection, usedVertices, type FaceRec } from './util';
export * from './validate';
export * from './select';
export * from './extrude';
export * from './inset';
export * from './loopcut';
export * from './subdivide';
export * from './delete';
export * from './merge';
export * from './fill';
export * from './tris';
export * from './orientation';
export * from './smooth';
export * from './duplicate';
export * from './edge-data';
export * from './solidify';
export * from './spin';
export * from './symmetrize';
export * from './bridge';
export * from './bevel';
export * from '../uv';
