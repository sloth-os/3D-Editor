import type { DatablockKind } from '../../doc/types';

/** The kinds of library unit: a set (the place), a prop (one object tree), a figure (an actor's look). */
export const UNIT_KINDS = ['set', 'prop', 'figure'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/** The datablock kinds a unit carries, in the order they are written and inserted. */
export const UNIT_BLOCK_KINDS = [
  'images',
  'materials',
  'meshes',
  'curves',
  'armatures',
  'lights',
  'cameras',
  'collections',
  'objects',
] as const satisfies readonly DatablockKind[];
export type UnitBlockKind = (typeof UNIT_BLOCK_KINDS)[number];
