import type { OperatorRegistry } from './registry';

/**
 * Edit-mode mesh operators (mesh.select_*, mesh.extrude_*, mesh.inset, mesh.bevel, ...).
 * Implemented on top of the pure functions in `../mesh/ops`.
 */
export function registerMeshEditOperators(_reg: OperatorRegistry): void {}
