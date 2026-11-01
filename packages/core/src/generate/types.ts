import type { Vec4 } from '../math/types';
import type { MeshData } from '../mesh/types';

/** Default material for one material slot of a generated mesh (Principled BSDF values, linear RGB). */
export interface GeneratedMaterial {
  name: string;
  base_color: Vec4;
  roughness: number;
  metallic?: number;
  transmission?: number;
  ior?: number;
}

/** Output of a generator: the mesh (object space, Z up, metres) and one material per slot index. */
export interface GeneratorResult {
  mesh: MeshData;
  /** Slot `i` is used by faces with material index `i`. */
  materials: GeneratedMaterial[];
  /**
   * Problems with the input that were worked around (ignored points, spheres too small for the
   * grid, …). When the mesh is empty they explain why nothing could be generated.
   */
  warnings?: string[];
}

/** Most faces (and vertices) one generated mesh may have. */
export const MAX_GENERATED_FACES = 1_000_000;

/**
 * Thrown by generators when the requested mesh would exceed `MAX_GENERATED_FACES` faces or
 * vertices (detected before or while building it, so huge requests fail fast).
 */
export class GeneratorLimitError extends Error {
  constructor(
    /** Estimated faces of the requested mesh, or null when the limit was hit while building it. */
    readonly estimate: number | null,
    readonly limit = MAX_GENERATED_FACES,
  ) {
    const n = (v: number) => Math.round(v).toLocaleString('en-US');
    super(
      `the mesh would have ${estimate === null ? `more than ${n(limit)}` : `about ${n(estimate)}`} faces ` +
        `(limit ${n(limit)})`,
    );
    this.name = 'GeneratorLimitError';
  }
}

/** Throws a GeneratorLimitError when an estimated face count exceeds the limit. */
export function checkFaceBudget(estimate: number, limit = MAX_GENERATED_FACES): void {
  if (estimate > limit) throw new GeneratorLimitError(estimate, limit);
}

const mat = (
  name: string,
  rgb: [number, number, number],
  roughness: number,
  metallic = 0,
): GeneratedMaterial => ({
  name,
  base_color: [rgb[0], rgb[1], rgb[2], 1],
  roughness,
  metallic,
});

/**
 * Shared default materials. Generators reuse names (e.g. 'Leaves', 'Steel') so objects made by
 * different generators share one material per name.
 */
export const MATERIALS = {
  bark: mat('Bark', [0.12, 0.07, 0.035], 0.9),
  leaves: mat('Leaves', [0.06, 0.24, 0.035], 0.7),
  needles: mat('Needles', [0.025, 0.11, 0.04], 0.75),
  palmLeaves: mat('Palm Leaves', [0.1, 0.3, 0.04], 0.6),
  grass: mat('Grass', [0.08, 0.3, 0.04], 0.7),
  stem: mat('Stem', [0.06, 0.22, 0.03], 0.65),
  petals: mat('Petals', [0.85, 0.12, 0.25], 0.5),
  flowerCenter: mat('Flower Center', [0.9, 0.55, 0.04], 0.6),
  ground: mat('Ground', [0.16, 0.22, 0.07], 0.9),
  rock: mat('Rock', [0.24, 0.23, 0.21], 0.85),
  snow: mat('Snow', [0.85, 0.87, 0.9], 0.5),
  wall: mat('Wall', [0.62, 0.48, 0.36], 0.85),
  glass: { ...mat('Window Glass', [0.04, 0.06, 0.08], 0.05), ior: 1.45 },
  frame: mat('Window Frame', [0.82, 0.82, 0.8], 0.5),
  roof: mat('Roof', [0.3, 0.08, 0.05], 0.75),
  door: mat('Door', [0.16, 0.08, 0.035], 0.6),
  concrete: mat('Concrete', [0.45, 0.45, 0.43], 0.85),
  metal: mat('Metal', [0.6, 0.6, 0.62], 0.35, 1),
  steel: mat('Steel', [0.56, 0.57, 0.6], 0.3, 1),
  iron: mat('Iron', [0.12, 0.12, 0.13], 0.55, 1),
  fence: mat('Fence Wood', [0.33, 0.22, 0.13], 0.85),
  wood: mat('Wood', [0.3, 0.16, 0.07], 0.55),
  woodDark: mat('Wood Dark', [0.12, 0.06, 0.03], 0.6),
  barrelWood: mat('Barrel Wood', [0.28, 0.15, 0.07], 0.7),
  marble: mat('Marble', [0.8, 0.78, 0.74], 0.35),
  marbleTrim: mat('Marble Trim', [0.72, 0.7, 0.66], 0.4),
  stone: mat('Stone', [0.45, 0.42, 0.38], 0.85),
  rubber: mat('Rubber', [0.02, 0.02, 0.02], 0.9),
  blob: mat('Blob', [0.75, 0.3, 0.18], 0.45),
  cloud: mat('Cloud', [0.95, 0.95, 0.97], 1),
} satisfies Record<string, GeneratedMaterial>;
