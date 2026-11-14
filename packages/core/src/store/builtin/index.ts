import type { CatalogEntry } from '../types';
import { ACTOR_MODELS } from './actors';
import { ARCHITECTURE_MODELS } from './architecture';
import { FOOD_MODELS } from './food';
import { FURNITURE_MODELS } from './furniture';
import { NATURE_MODELS } from './nature';
import { OUTDOOR_MODELS } from './outdoor';
import { PROPS_MODELS } from './props';
import { SPORTS_MODELS } from './sports';
import { STREET_MODELS } from './street';
import { VEHICLE_MODELS } from './vehicles';

/*
 * The built-in models, assembled (CATALOG-A owns this file, actors.ts, kit.ts, furniture.ts,
 * props.ts and food.ts; CATALOG-B the nature, architecture, street, outdoor, vehicles and sports
 * lists). Each list file exports `<NAME>_MODELS: CatalogEntry[]`; kit.ts (defineModel,
 * assembleModel) builds a model's root EMPTY and named parts the way spec §10 asks, for any list
 * that wants it. store/catalog.ts copies BUILTIN_MODELS into BUILTIN_CATALOG.
 */

/** Every built-in model in catalog order (by list, then as each list orders them). */
export const BUILTIN_MODELS: readonly CatalogEntry[] = [
  ...FURNITURE_MODELS,
  ...PROPS_MODELS,
  ...FOOD_MODELS,
  ...NATURE_MODELS,
  ...ARCHITECTURE_MODELS,
  ...STREET_MODELS,
  ...OUTDOOR_MODELS,
  ...VEHICLE_MODELS,
  ...SPORTS_MODELS,
  ...ACTOR_MODELS,
];

export { ACTOR_MODELS } from './actors';
