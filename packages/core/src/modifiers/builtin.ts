import { z } from 'zod';
import type { ModifierCategory, ModifierDef } from './registry';
import { getModifierDef, listModifierDefs, registerModifier } from './registry';
import { subsurfModifier } from './subsurf';
import { mirrorModifier } from './mirror';
import { arrayModifier } from './array';
import { solidifyModifier } from './solidify';
import { booleanModifier } from './boolean';
import { triangulateModifier } from './triangulate';
import { weldModifier } from './weld';
import { smoothByAngleModifier, smoothModifier } from './smooth';
import { displaceModifier } from './displace';
import { castModifier, simpleDeformModifier, waveModifier } from './deform';
import { decimateModifier } from './decimate';
import { wireframeModifier } from './wireframe';
import { screwModifier } from './screw';
import { buildModifier, edgeSplitModifier } from './edge-split';
import { shrinkwrapModifier } from './shrinkwrap';
import { bevelModifier } from './bevel';

/** All built-in modifier types, in "Add Modifier" menu order. */
const BUILTIN: ModifierDef<any>[] = [
  // Generate
  arrayModifier,
  bevelModifier,
  booleanModifier,
  buildModifier,
  decimateModifier,
  edgeSplitModifier,
  mirrorModifier,
  screwModifier,
  solidifyModifier,
  subsurfModifier,
  triangulateModifier,
  weldModifier,
  wireframeModifier,
  // Deform
  castModifier,
  displaceModifier,
  shrinkwrapModifier,
  simpleDeformModifier,
  smoothModifier,
  waveModifier,
  // Normals
  smoothByAngleModifier,
];

/** Default modifier names (Blender's), used when adding a modifier without an explicit name. */
const DEFAULT_NAMES: Record<string, string> = {
  SUBSURF: 'Subdivision',
  SIMPLE_DEFORM: 'SimpleDeform',
  EDGE_SPLIT: 'EdgeSplit',
  SMOOTH_BY_ANGLE: 'Smooth by Angle',
};

/** Parameters that reference other objects (stored as object ids), per modifier type. */
const OBJECT_PARAMS: Record<string, string[]> = {
  ARRAY: ['offset_object', 'start_cap', 'end_cap'],
  BOOLEAN: ['object'],
  CAST: ['object'],
  MIRROR: ['mirror_object'],
  SCREW: ['object'],
  SHRINKWRAP: ['target'],
  SIMPLE_DEFORM: ['origin'],
  WAVE: ['start_position_object'],
};

/** Names of the parameters of `type` that hold object ids (e.g. ['object'] for BOOLEAN). */
export function modifierObjectParams(type: string): string[] {
  return OBJECT_PARAMS[type] ?? [];
}

/** Registers all built-in modifier types (idempotent). Modifier modules are added here. */
let registered = false;

export function registerBuiltinModifiers(): void {
  if (registered) return;
  registered = true;
  for (const def of BUILTIN) registerModifier(def);
}

/** Default name for a new modifier of `type` ("Subdivision", "Mirror", ...). */
export function defaultModifierName(type: string): string {
  return DEFAULT_NAMES[type] ?? getModifierDef(type)?.label ?? type;
}

export interface ModifierTypeInfo {
  type: string;
  label: string;
  category: ModifierCategory;
  description: string;
  timeDependent: boolean;
  /** Parameter defaults (`schema.parse({})`). */
  defaults: Record<string, unknown>;
  /** JSON schema of the parameters (for UIs, scripting and MCP tools). */
  parameters: unknown;
}

/** Describes every registered modifier type (registers the built-ins first). */
export function describeModifierTypes(): ModifierTypeInfo[] {
  registerBuiltinModifiers();
  return listModifierDefs().map((d) => {
    let parameters: unknown;
    try {
      parameters = z.toJSONSchema(d.schema, { unrepresentable: 'any', io: 'input' });
    } catch {
      parameters = { type: 'object' };
    }
    return {
      type: d.type,
      label: d.label,
      category: d.category,
      description: d.description,
      timeDependent: d.timeDependent === true || typeof d.timeDependent === 'function',
      defaults: d.schema.parse({}) as Record<string, unknown>,
      parameters,
    };
  });
}
