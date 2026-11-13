import type { z } from 'zod';
import type { Vec3 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import type { ActorKind } from '../desk/characters';

/*
 * The model store's contract (spec §10): built-in procedural models (CATALOG, store/catalog.ts and
 * store/builtin/*.ts) and the search results every provider returns (the server's builtin,
 * khronos, polyhaven, sketchfab, polypizza and catalog providers).
 */

/** The store's fixed categories. */
export const STORE_CATEGORIES = [
  'people',
  'animals',
  'furniture',
  'props',
  'food',
  'vehicles',
  'nature',
  'architecture',
  'street',
  'sports',
] as const;
export type StoreCategory = (typeof STORE_CATEGORIES)[number];

/** File formats a store model comes in ('builtin': built by code, nothing to download). */
export const STORE_FORMATS = ['builtin', 'glb', 'gltf', 'obj'] as const;
export type StoreFormat = (typeof STORE_FORMATS)[number];

/** How store.add places and sizes a built-in model (sizes in metres; the largest given wins over scale). */
export interface BuiltinBuildOptions {
  /** Where the model's base centre stands. */
  location?: Vec3;
  /** Turn about +Z, degrees (0: the model's front faces −Y). */
  rotation_deg?: number;
  height_m?: number;
  width_m?: number;
  depth_m?: number;
  scale?: number;
  /** '#rrggbb' main colour. */
  color?: string;
  name?: string;
  /** Model-specific parameters, checked by the entry's `params` schema. */
  params?: Record<string, unknown>;
}

/** What a built-in model's build made: its EMPTY root and every object under it. */
export interface BuiltinBuildResult {
  root: string;
  objects: string[];
}

/**
 * A built-in model: origin at the base centre, front −Y, real-world size, an EMPTY root with named
 * parts. Vehicles (rig 'vehicle'): `body`, `wheel.FL/FR/BL/BR` (origin at the hub, spinning about
 * local X; the front wheels under `steer.FL/FR` pivots) and `saddle` empties for riders. People and
 * animals (rig 'actor') build through createActor (desk/characters).
 */
export interface CatalogEntry {
  /** Unique id, lowercase words joined by underscores (store ids are 'builtin:<id>'). */
  id: string;
  name: string;
  category: StoreCategory;
  tags: string[];
  synonyms: string[];
  description: string;
  /** Width (X), depth (Y), height (Z) in metres at the default size. */
  dimensions_m: [number, number, number];
  triangles: number;
  rig: null | 'vehicle' | 'actor';
  actor_kind?: ActorKind;
  params?: z.ZodObject<z.ZodRawShape>;
  build(doc: SceneDoc, o: BuiltinBuildOptions): BuiltinBuildResult;
}

/** One model of a store search, from any provider. */
export interface StoreResult {
  /** '<provider>:<id>', e.g. 'builtin:oak_tree'. */
  id: string;
  provider: string;
  name: string;
  category: StoreCategory | null;
  tags: string[];
  thumbnail_url: string | null;
  license: { spdx: string; url: string | null; attribution: string | null };
  author: string | null;
  source_url: string | null;
  dimensions_m: [number, number, number] | null;
  triangles: number | null;
  formats: StoreFormat[];
  /** False when the licence or the provider forbids downloads (store_add refuses NOT_DOWNLOADABLE). */
  downloadable: boolean;
  /** Environment variable of the key a download needs when it is not set (store_add refuses NEEDS_KEY). */
  needs_key?: string;
}
