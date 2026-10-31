import { OperatorRegistry } from './registry';
import { registerObjectOperators } from './object';
import { registerTransformOperators } from './transform';
import { registerAnimOperators } from './anim';
import { registerMaterialOperators } from './material';
import { registerViewOperators } from './view';
import { registerDataOperators } from './data';
import { registerMeshEditOperators } from './mesh-edit';
import { registerModifierOperators } from './modifier';
import { registerIOOperators } from './io';
import { registerSculptOperators } from './sculpt';

export * from './context';
export * from './registry';
export * from './helpers';
export * from './transform';
export * from './anim';
export { addObjectAndSelect, enterEditMode, evaluatedMesh } from './object';

/** Creates a registry with every built-in (headless-capable) operator registered. */
export function createOperatorRegistry(): OperatorRegistry {
  const reg = new OperatorRegistry();
  registerObjectOperators(reg);
  registerTransformOperators(reg);
  registerAnimOperators(reg);
  registerMaterialOperators(reg);
  registerViewOperators(reg);
  registerDataOperators(reg);
  registerMeshEditOperators(reg);
  registerModifierOperators(reg);
  registerIOOperators(reg);
  registerSculptOperators(reg);
  return reg;
}
