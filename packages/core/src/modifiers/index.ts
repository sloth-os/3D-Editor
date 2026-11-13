/*
 * Modifier stack. Individual modifiers register themselves via `registerModifier` in their
 * module; `registerBuiltinModifiers` is idempotent and is called by the evaluator.
 */
export * from './registry';
export {
  registerBuiltinModifiers,
  defaultModifierName,
  describeModifierTypes,
  modifierObjectParams,
  type ModifierTypeInfo,
} from './builtin';
export { csgMeshBoolean, type CsgOperation } from './csg';
