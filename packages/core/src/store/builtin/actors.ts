import { z } from 'zod';
import type { Vec3 } from '../../math/types';
import { SceneDoc } from '../../doc/scene-doc';
import { OperatorError } from '../../operators/context';
import {
  ANIMAL_POSES,
  BUILT_KINDS,
  HUMAN_POSES,
  HUMANOID_KINDS,
  MAX_ACTOR_HEIGHT,
  MIN_ACTOR_HEIGHT,
  createActor,
  defaultActorHeight,
  type ActorKind,
} from '../../desk/characters';
import type { BuiltinBuildOptions, CatalogEntry } from '../types';
import { meshWorldBounds, parseModelParams, type BuiltModel, type SizeOptions } from './kit';

/*
 * People and animals of the catalog (CATALOG-A): rigged actors of the director's desk. Their build
 * is createActor (desk/characters, CHARACTERS): an armature root at the feet facing −Y with a mesh
 * part per bone; rotation_deg is the actor's facing.
 *
 * - Only the kinds CHARACTERS builds (desk/characters BUILT_KINDS) are in the catalog: the others
 *   are defined here and join it once their kind is built.
 * - An entry's dimensions_m and triangles are those of its default actor, measured from a real
 *   build (standing, in a scratch document, once per kind): never a guess, whatever CHARACTERS
 *   changes in the bodies.
 * - Sizes are those of the standing actor's bounds, as for every other model (height_m is the
 *   overall height: the top of the head, an animal's ears, not the withers of desk.actor_add), and
 *   whatever pose it is added in. An actor keeps its proportions: the first of height_m, width_m and
 *   depth_m given sets its size (the others are reported as ignored), else scale multiplies it.
 */

interface ActorDef {
  id: string;
  name: string;
  kind: ActorKind;
  tags: string[];
  synonyms: string[];
  description: string;
  /** Rough standing width, depth and height (metres), shown only if the kind cannot be measured. */
  approx: [number, number, number];
}

const humanParams = z.object({
  pose: z.enum(HUMAN_POSES).optional().describe('Pose to start in (default: standing)'),
});
const animalParams = z.object({
  pose: z.enum(ANIMAL_POSES).optional().describe('Pose to start in (default: standing)'),
});

/** A kind's default actor as built: its createActor height, standing size and triangles. */
export interface ActorMeasure {
  /** height_m createActor builds it at (people: to the top of the head; animals: at the withers). */
  height: number;
  /** Width (X), depth (Y) and height (Z) of the standing actor's bounds, metres. */
  size: Vec3;
  triangles: number;
}

const measured = new Map<ActorKind, ActorMeasure>();

/**
 * The default actor of `kind` measured from a real build (standing, facing −Y, in a scratch
 * document; cached). The bodies scale with the height createActor is given, so this measure sizes
 * every other build too. Throws what createActor throws (a kind not built yet).
 */
export function measureActorKind(kind: ActorKind): ActorMeasure {
  const done = measured.get(kind);
  if (done) return done;
  const doc = SceneDoc.create({ empty: true });
  try {
    const height = defaultActorHeight(kind);
    const r = createActor(doc, { kind, height_m: height, location: [0, 0, 0], facing_deg: 0, pose: 'stand' });
    const b = meshWorldBounds(doc, [r.actor, ...r.parts], doc.getScene().frame_start);
    if (!b) throw new OperatorError(`The ${kind} actor has no geometry to measure`, 'FAILED');
    const m: ActorMeasure = { height, size: b.size, triangles: b.triangles };
    measured.set(kind, m);
    return m;
  } finally {
    doc.destroy();
  }
}

/** The measure of `kind`, or null when it cannot be built (for the catalog fields only). */
function measureOrNull(kind: ActorKind): ActorMeasure | null {
  try {
    return measureActorKind(kind);
  } catch {
    return null;
  }
}

const SIZES = [
  ['height_m', 2],
  ['width_m', 0],
  ['depth_m', 1],
] as const;

const valid = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v) && v > 0;

/** Relative tolerance of the height range (the measures carry rounding errors of about 1e-9). */
const TOLERANCE = 1e-6;

/** `v` to three significant digits, rounded up (`up`) or down so that the printed bound is allowed. */
function bound(v: number, up: boolean): number {
  const step = 10 ** (Math.floor(Math.log10(v)) - 2);
  const r = (up ? Math.ceil(v / step - TOLERANCE) : Math.floor(v / step + TOLERANCE)) * step;
  return Number(r.toPrecision(3));
}

/**
 * The createActor height_m that gives an actor measured `m` the size `o` asks for (undefined: its
 * default): the first of height_m, width_m and depth_m given (sizes of its standing bounds) sets it,
 * the others are ignored with a warning; else scale multiplies the default size. Refuses
 * INVALID_PARAMS, naming the option given and the range it allows, a size outside the heights
 * createActor builds.
 */
export function actorBuildHeight(
  id: string,
  m: ActorMeasure,
  o: SizeOptions,
  warnings?: string[],
): number | undefined {
  const given = SIZES.filter(([k]) => valid(o[k]));
  let option: string;
  let value: number;
  /** The option's value for the default actor (a size of its bounds; 1 for scale). */
  let unit: number;
  if (given.length) {
    const [k, axis] = given[0];
    option = k;
    value = o[k] as number;
    unit = m.size[axis];
    if (given.length > 1)
      warnings?.push(
        `'${id}' keeps its proportions: ${k} sets its size, ${given
          .slice(1)
          .map(([g]) => g)
          .join(' and ')} ignored`,
      );
  } else if (valid(o.scale) && o.scale !== 1) {
    option = 'scale';
    value = o.scale;
    unit = 1;
  } else return undefined;
  const height = (m.height * value) / unit;
  if (!(height >= MIN_ACTOR_HEIGHT * (1 - TOLERANCE) && height <= MAX_ACTOR_HEIGHT * (1 + TOLERANCE))) {
    const lo = bound((MIN_ACTOR_HEIGHT * unit) / m.height, true);
    const hi = bound((MAX_ACTOR_HEIGHT * unit) / m.height, false);
    throw new OperatorError(
      `${option} must be between ${lo} and ${hi} for '${id}' (got ${value})`,
      'INVALID_PARAMS',
    );
  }
  return Math.min(MAX_ACTOR_HEIGHT, Math.max(MIN_ACTOR_HEIGHT, height));
}

function defineActor(def: ActorDef): CatalogEntry {
  const human = HUMANOID_KINDS.includes(def.kind);
  const params = (human ? humanParams : animalParams) as unknown as z.ZodObject<z.ZodRawShape>;
  return {
    id: def.id,
    name: def.name,
    category: human ? 'people' : 'animals',
    tags: def.tags,
    synonyms: def.synonyms,
    description: def.description,
    /** The standing default actor's bounds (measured from a real build). */
    get dimensions_m(): [number, number, number] {
      const m = measureOrNull(def.kind);
      return m ? [m.size[0], m.size[1], m.size[2]] : [...def.approx];
    },
    /** The default actor's triangles (measured from a real build). */
    get triangles(): number {
      return measureOrNull(def.kind)?.triangles ?? 4000;
    },
    rig: 'actor',
    actor_kind: def.kind,
    params,
    build(doc: SceneDoc, o: BuiltinBuildOptions): BuiltModel {
      const p = parseModelParams({ id: def.id, params }, o.params) as { pose?: string };
      const warnings: string[] = [];
      const height = actorBuildHeight(def.id, measureActorKind(def.kind), o, warnings);
      const r = createActor(doc, {
        kind: def.kind,
        name: o.name?.trim() || undefined,
        color: o.color,
        height_m: height,
        location: o.location,
        facing_deg: Number.isFinite(o.rotation_deg) ? o.rotation_deg : undefined,
        pose: p.pose,
      });
      return { root: r.actor, objects: [r.actor, ...r.parts], warnings };
    },
  };
}

const PERSON = ['person', 'people', 'human', 'figure', 'mannequin', 'character', 'actor', 'cast'];

/** At the withers, from the kind's default (desk.actor_add's height_m of an animal). */
const withers = (kind: ActorKind) => `${defaultActorHeight(kind)} m at the withers`;

/** Every person and animal the spec names (§8 kinds), built or not yet. */
export const ACTOR_DEFS: readonly ActorDef[] = [
  {
    id: 'person',
    name: 'Person',
    kind: 'adult',
    tags: [...PERSON, 'adult'],
    synonyms: ['adult', 'somebody', 'someone', 'pedestrian', 'extra', 'bystander', 'people'],
    description: 'An adult mannequin (1.7 m) that can pose, walk, run, sit, hold props and ride.',
    approx: [0.6, 0.32, 1.7],
  },
  {
    id: 'man',
    name: 'Man',
    kind: 'man',
    tags: [...PERSON, 'adult', 'male'],
    synonyms: ['male', 'guy', 'gentleman', 'father', 'dad', 'boyfriend', 'husband'],
    description: 'An adult man mannequin (1.76 m) that can pose, walk, run, sit, hold props and ride.',
    approx: [0.65, 0.33, 1.76],
  },
  {
    id: 'woman',
    name: 'Woman',
    kind: 'woman',
    tags: [...PERSON, 'adult', 'female'],
    synonyms: ['female', 'lady', 'mother', 'mum', 'mom', 'girlfriend', 'wife'],
    description: 'An adult woman mannequin (1.64 m) that can pose, walk, run, sit, hold props and ride.',
    approx: [0.54, 0.34, 1.64],
  },
  {
    id: 'child',
    name: 'Child',
    kind: 'child',
    tags: [...PERSON, 'child', 'young'],
    synonyms: ['kid', 'boy', 'girl', 'son', 'daughter', 'youngster', 'pupil'],
    description: 'A child mannequin (1.2 m, larger head) that can pose, walk, run, sit and hold props.',
    approx: [0.43, 0.24, 1.2],
  },
  {
    id: 'toddler',
    name: 'Toddler',
    kind: 'toddler',
    tags: [...PERSON, 'child', 'young', 'small'],
    synonyms: ['baby', 'infant', 'tot', 'little kid'],
    description: 'A toddler mannequin (0.9 m).',
    approx: [0.34, 0.2, 0.9],
  },
  {
    id: 'elderly_person',
    name: 'Elderly person',
    kind: 'elder',
    tags: [...PERSON, 'adult', 'old'],
    synonyms: ['elder', 'senior', 'old man', 'old woman', 'grandparent', 'grandma', 'grandpa', 'pensioner'],
    description: 'An elderly mannequin (1.65 m tall upright, a slight stoop).',
    approx: [0.57, 0.35, 1.63],
  },
  {
    id: 'horse',
    name: 'Horse',
    kind: 'horse',
    tags: ['animal', 'horse', 'mount', 'farm', 'ride', 'equine'],
    synonyms: ['stallion', 'mare', 'steed', 'colt', 'mustang'],
    description: `A rideable horse (${withers('horse')}) with a saddle bone; walks, trots and gallops.`,
    approx: [0.72, 2.92, 2.26],
  },
  {
    id: 'pony',
    name: 'Pony',
    kind: 'pony',
    tags: ['animal', 'pony', 'horse', 'mount', 'farm', 'ride', 'equine'],
    synonyms: ['shetland pony', 'foal', 'small horse'],
    description: `A rideable pony (${withers('pony')}) with a saddle bone.`,
    approx: [0.61, 2.19, 1.61],
  },
  {
    id: 'donkey',
    name: 'Donkey',
    kind: 'donkey',
    tags: ['animal', 'donkey', 'mount', 'farm', 'ride', 'equine'],
    synonyms: ['mule', 'burro', 'ass'],
    description: 'A rideable donkey with a saddle bone.',
    approx: [0.45, 1.8, 1.6],
  },
  {
    id: 'cow',
    name: 'Cow',
    kind: 'cow',
    tags: ['animal', 'cow', 'cattle', 'farm', 'livestock'],
    synonyms: ['bull', 'ox', 'calf', 'heifer', 'cattle'],
    description: 'A cow.',
    approx: [0.7, 2.4, 1.6],
  },
  {
    id: 'dog',
    name: 'Dog',
    kind: 'dog',
    tags: ['animal', 'dog', 'pet'],
    // 'puppy' too while the small dog is not built
    synonyms: ['hound', 'doggy', 'pup', 'puppy', 'retriever', 'labrador', 'shepherd dog'],
    description: `A medium dog (${withers('dog')}) that walks, trots, sits and lies down.`,
    approx: [0.24, 1.07, 0.69],
  },
  {
    id: 'small_dog',
    name: 'Small dog',
    kind: 'small_dog',
    tags: ['animal', 'dog', 'pet', 'small'],
    synonyms: ['puppy', 'terrier', 'chihuahua', 'dachshund', 'lapdog'],
    description: 'A small dog.',
    approx: [0.18, 0.5, 0.42],
  },
  {
    id: 'cat',
    name: 'Cat',
    kind: 'cat',
    tags: ['animal', 'cat', 'pet'],
    synonyms: ['kitten', 'kitty', 'tomcat', 'feline'],
    description: 'A cat.',
    approx: [0.16, 0.5, 0.35],
  },
  {
    id: 'sheep',
    name: 'Sheep',
    kind: 'sheep',
    tags: ['animal', 'sheep', 'farm', 'livestock'],
    synonyms: ['lamb', 'ram', 'ewe', 'flock'],
    description: 'A sheep.',
    approx: [0.45, 1.2, 1.0],
  },
  {
    id: 'pig',
    name: 'Pig',
    kind: 'pig',
    tags: ['animal', 'pig', 'farm', 'livestock'],
    synonyms: ['hog', 'swine', 'piglet', 'boar', 'sow'],
    description: 'A pig.',
    approx: [0.45, 1.3, 0.8],
  },
  {
    id: 'deer',
    name: 'Deer',
    kind: 'deer',
    tags: ['animal', 'deer', 'wild', 'forest'],
    synonyms: ['stag', 'doe', 'fawn', 'buck', 'reindeer', 'elk'],
    description: 'A deer.',
    approx: [0.4, 1.5, 1.6],
  },
  {
    id: 'bear',
    name: 'Bear',
    kind: 'bear',
    tags: ['animal', 'bear', 'wild', 'forest'],
    synonyms: ['grizzly', 'brown bear', 'black bear'],
    description: 'A brown bear on all fours.',
    approx: [0.8, 2.0, 1.2],
  },
  {
    id: 'duck',
    name: 'Duck',
    kind: 'duck',
    tags: ['animal', 'bird', 'duck', 'pond', 'farm'],
    synonyms: ['duckling', 'mallard', 'goose', 'drake'],
    description: 'A duck.',
    approx: [0.25, 0.45, 0.4],
  },
  {
    id: 'bird',
    name: 'Bird',
    kind: 'bird',
    tags: ['animal', 'bird'],
    synonyms: ['pigeon', 'sparrow', 'seagull', 'gull', 'crow', 'robin', 'dove'],
    description: 'A small bird.',
    approx: [0.15, 0.3, 0.25],
  },
];

/**
 * The people and animals in the catalog: those whose kind CHARACTERS builds (BUILT_KINDS); the
 * others join when their kind is built, so search never lists a model store.add cannot add.
 */
export const ACTOR_MODELS: CatalogEntry[] = ACTOR_DEFS.filter((d) => BUILT_KINDS.includes(d.kind)).map(
  defineActor,
);
