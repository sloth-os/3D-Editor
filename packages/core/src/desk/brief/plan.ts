import { z } from 'zod';
import type { ActorKind } from '../characters/types';
import {
  flyerKind,
  isHumanoid,
  isRideable,
  holdersByText,
  inferActorKind,
  modelFor,
  plainText,
  ridersByText,
  speciesOf,
} from '../rideo/rules';
import { openingMarks } from '../rideo/import';
import {
  RideoBlockingLandmarkSchema,
  RideoBlockingPropSchema,
  RideoImportInputSchema,
  type RideoBlockingMark,
} from '../rideo/schema';
import type { BriefShot, SceneBrief } from './schema';
import {
  WATER_SIZES,
  framingFromWords,
  groundFromWords,
  interiorFromWords,
  movementOf,
  personKind,
  readKindHint,
  standInKind,
  sunOf,
  waterFromWords,
} from './words';

/*
 * A brief as the desk stages it (stage.ts hands the result to the SceneBlocking import, its staging
 * engine): each cast member's actor kind, who holds which prop, where the props stand, the set (its
 * size, ground, interior, sun and water) and the import's input, with the warnings of what the desk
 * read differently from the brief's words. Pure: the same brief, the same plan.
 *
 * - Kinds: the hint when it names a kind the desk builds ("child", "dog", "golden retriever"), a
 *   person's kind from the words when it says "person"; without a hint, the words (an animal is a
 *   person when it rides, holds a prop or acts as one, as SceneBlocking imports read rideo's cast).
 *   An animal the desk has no figure for (a duck, a bird) stands in as the built kind nearest its
 *   size, with a warning; an unknown hint falls back to the words, with a warning.
 * - Props: elements of kind 'prop' (and 'other' ones whose name names a built-in model: a style is
 *   not staged), each held by the first cast member a shot's words say holds it ("runs with the
 *   kite"; a held kite or balloon flies on its string), else standing beside the first cast member
 *   of the first shot that lists it, on the side away from the others.
 * - The set: interior from the brief, else from the words; its ground from the places' words; the
 *   sun from the time of day; a pond, a lake, a river or the sea named by the set or a location is a
 *   water landmark on the side the words give it (behind the cast when they give none), clear of the
 *   cast; the set grows to hold the cast, the props and the water.
 */

/** How far beside its first cast member a prop stands (m), and the clearance it keeps from the others. */
export const PROP_OFFSET_M = 0.7;
export const PROP_CLEARANCE_M = 0.6;
/** How far the water keeps from the cast (m). */
export const WATER_CLEARANCE_M = 1.5;
/** The smallest set (m) and the margin around what stands on it. */
export const MIN_SET_WIDTH_M = 12;
export const MIN_SET_DEPTH_M = 10;
const SET_MARGIN_M = 2;
const MAX_SET_M = 200;

/** Colours a prop's words may name (sRGB). */
const COLOR_WORDS: Readonly<Record<string, string>> = {
  red: '#c8322d',
  crimson: '#a51d2d',
  orange: '#e8772e',
  yellow: '#f2c230',
  gold: '#d4a017',
  golden: '#d4a017',
  green: '#3d9a4f',
  blue: '#2f6fd0',
  navy: '#1f3466',
  purple: '#7b3fbf',
  violet: '#7b3fbf',
  pink: '#ee6fa5',
  white: '#f2f0ea',
  black: '#222222',
  grey: '#8d9096',
  gray: '#8d9096',
  silver: '#b8bcc2',
  brown: '#7b5236',
  tan: '#c8a77e',
};

/** The default colour of a SceneBlocking prop (the import keeps a model's own colours for it). */
const DEFAULT_PROP_COLOR = '#c9a227';

export interface BriefCastPlan {
  kind: ActorKind;
  /** Why it is that kind, in words. */
  reason: string;
}

export interface BriefPlan {
  /** The SceneBlocking import's input (a blocking of the set and props only, state 'missing'). */
  input: z.input<typeof RideoImportInputSchema>;
  /** Kind of each cast member staged, by cast id. */
  cast: Map<string, BriefCastPlan>;
  /** Cast members in the order the import stages them (first shot first), and those in no shot. */
  order: string[];
  unstaged: string[];
  /** The cast member holding each held prop, by element id. */
  holders: Map<string, string>;
  /** Elements staged as props (in brief order), and those left out with why. */
  props: string[];
  skipped: { id: string; why: string }[];
  /** The opening marks the import gives the cast, by cast id. */
  marks: Map<string, RideoBlockingMark>;
  /** The set as planned (the blocking's set in the import's input). */
  set: BriefPlannedSet;
  warnings: string[];
}

/** The set a plan stages: its size, ground, interior, sun and landmarks (the water). */
export interface BriefPlannedSet {
  width: number;
  depth: number;
  ground: string;
  interior: boolean;
  sun: { azimuthDeg: number; elevationDeg: number };
  landmarks: z.input<typeof RideoBlockingLandmarkSchema>[];
}

/** A shot's cast as the desk stages it: its castIds, then the members its planned layout names besides (each once). */
export function shotCast(s: Pick<BriefShot, 'castIds' | 'layout'>): string[] {
  const out: string[] = [];
  for (const id of [...s.castIds, ...s.layout.map((e) => e.castId)]) if (!out.includes(id)) out.push(id);
  return out;
}

/** The words of a shot: description and action. */
const shotWords = (s: Pick<BriefShot, 'description' | 'action'>) =>
  [s.description, s.action].filter(Boolean).join('. ');

/** What an animal carries in its mouth (holding it does not make it a person; as the import reads it). */
const MOUTH_ITEM = /\b(balls?|sticks?|bones?|frisbees?|newspapers?|slippers?|leash(es)?|toys?)\b/;

/** The head noun of a name ("Red kite" → "kite"): the words a shot may call the prop by. */
function nameWords(name: string): string[] {
  const words = plainText(name).match(/[a-z]+/g) ?? [];
  const head = words.at(-1);
  return head && head.length >= 3 ? [head] : [];
}

/** The colour a prop's words name (its name first), else the default. */
function colorOf(name: string, description: string): string {
  for (const text of [name, description.split(/[.!?\n]/)[0] ?? '']) {
    const words = plainText(text).match(/[a-z]+/g) ?? [];
    for (const w of words) if (COLOR_WORDS[w]) return COLOR_WORDS[w];
  }
  return DEFAULT_PROP_COLOR;
}

/**
 * The actor kind of each cast member (see the module comment), with the warnings of hints the desk
 * cannot follow as they are.
 */
export function castKinds(
  brief: SceneBrief,
  evidence: { holders: ReadonlySet<string> } = { holders: new Set() },
): { kinds: Map<string, BriefCastPlan>; warnings: string[] } {
  const warnings: string[] = [];
  const kinds = new Map<string, BriefCastPlan>();
  const fixed = new Map<string, BriefCastPlan>();
  const words = (c: SceneBrief['cast'][number]) => ({
    name: c.name,
    summary: c.description,
    identity: undefined,
  });
  for (const c of brief.cast) {
    if (c.kind === null) continue;
    const h = readKindHint(c.kind);
    if (h.type === 'kind') fixed.set(c.id, { kind: h.kind, reason: `the brief's kind '${c.kind}'` });
    else if (h.type === 'person')
      fixed.set(c.id, {
        kind: personKind(c.name, c.description),
        reason: `a person (the brief's kind '${c.kind}'), from the words`,
      });
    else if (h.type === 'stand_in') {
      fixed.set(c.id, { kind: h.kind, reason: `a ${h.word} staged as a ${h.kind} (no ${h.word} figure)` });
      warnings.push(
        `${c.name} is a ${h.word}: the desk has no ${h.word} figure, so a ${h.kind} of its size stands in (the brief's kind '${c.kind}')`,
      );
    } else
      warnings.push(
        `${c.name}'s kind '${c.kind}' is not one the desk builds: the kind is read from the words instead`,
      );
  }
  // who rides whom by the shots' words, before the kinds (as the SceneBlocking import reads them):
  // a ridden animal stays one, an animal that rides is a person
  const firstPass = (c: SceneBrief['cast'][number]): ActorKind =>
    fixed.get(c.id)?.kind ??
    inferActorKind(words(c), { holds: false, personPose: false, ridden: true, rides: false }).kind;
  const byId = new Map(brief.cast.map((c) => [c.id, c]));
  const riders = new Set<string>();
  const ridden = new Set<string>();
  for (const s of brief.shots) {
    const ids = shotCast(s).filter((id) => byId.has(id));
    const kindOf = new Map(ids.map((id) => [id, firstPass(byId.get(id)!)]));
    const steeds = ids.filter((id) => isRideable(kindOf.get(id)!));
    const people = ids.filter(
      (id) => !steeds.includes(id) && (!fixed.has(id) || isHumanoid(fixed.get(id)!.kind)),
    );
    for (const p of ridersByText(
      shotWords(s),
      people.map((id) => ({ id, name: byId.get(id)!.name })),
      steeds.map((id) => ({ id, name: byId.get(id)!.name, kind: kindOf.get(id)! })),
    )) {
      riders.add(p.rider);
      ridden.add(p.mount);
    }
  }
  for (const c of brief.cast) {
    const f = fixed.get(c.id);
    if (f) {
      kinds.set(c.id, f);
      continue;
    }
    const ev = {
      holds: evidence.holders.has(c.id),
      personPose: false,
      ridden: ridden.has(c.id),
      rides: riders.has(c.id),
    };
    if (speciesOf(words(c))) {
      kinds.set(c.id, inferActorKind(words(c), ev));
      continue;
    }
    // an animal the desk has no figure for, unless its words make it a person
    const stand = standInKind(`${c.name}. ${c.description.split(/[.!?\n]/)[0] ?? ''}`);
    const asPerson = inferActorKind(words(c), ev);
    if (stand && !ev.holds && !ev.rides) {
      kinds.set(c.id, {
        kind: stand.kind,
        reason: `a ${stand.word} staged as a ${stand.kind} (no ${stand.word} figure)`,
      });
      warnings.push(
        `${c.name} is a ${stand.word}: the desk has no ${stand.word} figure, so a ${stand.kind} of its size stands in`,
      );
    } else kinds.set(c.id, asPerson);
  }
  return { kinds, warnings };
}

/** A spot beside `mark` at distance `d` on the side `k` tries (right, left, behind, front), and the next ring out. */
function besideSpots(mark: RideoBlockingMark): { x: number; z: number }[] {
  const f = (mark.facingDeg * Math.PI) / 180;
  const fwd = { x: Math.sin(f), z: Math.cos(f) };
  // the figure's right hand: forward × up (x right, y up, z towards the audience)
  const right = { x: -Math.cos(f), z: Math.sin(f) };
  const out: { x: number; z: number }[] = [];
  for (const d of [PROP_OFFSET_M, PROP_OFFSET_M + 0.5, PROP_OFFSET_M + 1])
    for (const dir of [right, { x: -right.x, z: -right.z }, { x: -fwd.x, z: -fwd.z }, fwd])
      out.push({ x: mark.x + dir.x * d, z: mark.z + dir.z * d });
  return out;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Plans a validated brief (see the module comment). */
export function planBrief(brief: SceneBrief, o: { preRollFrames?: number } = {}): BriefPlan {
  const warnings: string[] = [];
  const castById = new Map(brief.cast.map((c) => [c.id, c]));
  const elementById = new Map(brief.elements.map((e) => [e.id, e]));

  // ------------------------------------------------------------ props and who holds them
  const props: string[] = [];
  const skipped: { id: string; why: string }[] = [];
  for (const e of brief.elements) {
    if (e.kind === 'location') continue;
    if (e.kind === 'other' && !modelFor([e.name], { exclude: brief.cast.map((c) => c.name) })) {
      skipped.push({
        id: e.id,
        why: 'names no built-in model (not staged: a style, or something the desk has no model of)',
      });
      continue;
    }
    props.push(e.id);
  }
  const holders = new Map<string, string>();
  for (const s of brief.shots) {
    const here = s.elementIds.filter((id) => props.includes(id) && !holders.has(id));
    if (!here.length) continue;
    const cast = shotCast(s).filter((id) => castById.has(id));
    for (const h of holdersByText(
      shotWords(s),
      cast.map((id) => ({ id, name: castById.get(id)!.name })),
      here.map((id) => ({
        id,
        name: elementById.get(id)!.name,
        words: nameWords(elementById.get(id)!.name),
      })),
    ))
      if (!holders.has(h.prop)) holders.set(h.prop, h.holder);
  }
  // holding a prop makes an animal a person, unless it carries it in its mouth
  const personHolders = new Set(
    [...holders].filter(([e]) => !MOUTH_ITEM.test(plainText(elementById.get(e)!.name))).map(([, c]) => c),
  );

  // ------------------------------------------------------------ the cast
  const { kinds, warnings: kindWarnings } = castKinds(brief, { holders: personHolders });
  warnings.push(...kindWarnings);
  const order: string[] = [];
  for (const s of brief.shots)
    for (const id of shotCast(s)) if (castById.has(id) && !order.includes(id)) order.push(id);
  const unstaged = brief.cast.filter((c) => !order.includes(c.id)).map((c) => c.id);
  for (const id of unstaged) warnings.push(`${castById.get(id)!.name} is in no shot: not staged`);
  for (const s of brief.shots) {
    const extra = s.layout
      .map((e) => e.castId)
      .filter((id, i, all) => !s.castIds.includes(id) && all.indexOf(id) === i);
    if (extra.length)
      warnings.push(
        `shot ${s.id} plans ${extra.map((id) => castById.get(id)!.name).join(' and ')} in its layout but not in its cast: staged in it`,
      );
  }
  const shotsIn = brief.shots.map((s) => ({
    layout: s.layout.map((e) => ({ characterId: e.castId, side: e.side, facing: e.facing })),
  }));
  const marks = openingMarks(shotsIn, order);

  // ------------------------------------------------------------ where the props stand
  const taken: { x: number; z: number }[] = [...marks.values()].map((m) => ({ x: m.x, z: m.z }));
  const blockingProps: z.input<typeof RideoBlockingPropSchema>[] = [];
  props.forEach((id, i) => {
    const e = elementById.get(id)!;
    const holder = holders.get(id) ?? null;
    const flies = holder ? flyerKind(`${e.name} ${e.description}`) : null;
    const found = modelFor(flies ? [flies] : [e.name], { exclude: brief.cast.map((c) => c.name) });
    const size = found ? Math.max(...found.entry.dimensions_m) : 0.4;
    let at: { x: number; z: number };
    if (holder) {
      const m = marks.get(holder)!;
      at = { x: m.x, z: m.z };
    } else {
      const first = brief.shots.find((s) => s.elementIds.includes(id));
      const owner = first ? shotCast(first).find((c) => marks.has(c)) : undefined;
      const anchor: RideoBlockingMark = owner
        ? marks.get(owner)!
        : { x: 0, z: -1.5, facingDeg: 0, pose: 'stand', toX: null, toZ: null };
      const free = (p: { x: number; z: number }) =>
        taken.every((t) => Math.hypot(t.x - p.x, t.z - p.z) >= PROP_CLEARANCE_M);
      at = besideSpots(anchor).find(free) ?? { x: anchor.x + PROP_OFFSET_M * (i + 1), z: anchor.z };
      taken.push(at);
    }
    blockingProps.push({
      id: `p${i + 1}`,
      elementId: id,
      label: e.name.slice(0, 80),
      x: round3(at.x),
      z: round3(at.z),
      size: Math.min(20, Math.max(0.05, round3(size))),
      color: colorOf(e.name, e.description),
      heldBy: holder,
    });
  });

  // ------------------------------------------------------------ the set
  const locations = brief.elements.filter((e) => e.kind === 'location');
  const placeWords = [...locations.map((e) => `${e.name}. ${e.description}`), brief.set.description].join(
    '. ',
  );
  const interior = brief.set.interior ?? interiorFromWords(placeWords) ?? false;
  const ground = groundFromWords(placeWords, interior);
  const sun = sunOf(brief.set.timeOfDay);
  const landmarks: z.input<typeof RideoBlockingLandmarkSchema>[] = [];
  let water: { noun: string; side: 'left' | 'right' | 'behind' | 'front' | null } | null = null;
  let waterElement: string | null = null;
  for (const [text, element] of [
    [brief.set.description, null] as const,
    ...locations.map((e) => [`${e.name}. ${e.description}`, e.id] as const),
  ]) {
    water = waterFromWords(text);
    if (water) {
      waterElement = element;
      break;
    }
  }
  const xs = taken.map((t) => t.x);
  const zs = taken.map((t) => t.z);
  const minX = Math.min(0, ...xs);
  const maxX = Math.max(0, ...xs);
  const minZ = Math.min(0, ...zs);
  const maxZ = Math.max(0, ...zs);
  let extent = { x: Math.max(Math.abs(minX), Math.abs(maxX)), z: Math.max(Math.abs(minZ), Math.abs(maxZ)) };
  if (water) {
    const size = WATER_SIZES[water.noun] ?? WATER_SIZES.pond;
    const side = water.side ?? 'behind';
    // a strip (a river, the sea) runs across the view behind or in front, along it on a side
    const along = size.strip && (side === 'left' || side === 'right');
    const w = along ? size.depth : size.width;
    const d = along ? size.width : size.depth;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const at =
      side === 'left'
        ? { x: minX - WATER_CLEARANCE_M - w / 2, z: cz }
        : side === 'right'
          ? { x: maxX + WATER_CLEARANCE_M + w / 2, z: cz }
          : side === 'front'
            ? { x: cx, z: maxZ + WATER_CLEARANCE_M + d / 2 }
            : { x: cx, z: minZ - WATER_CLEARANCE_M - d / 2 };
    landmarks.push({
      id: 'l1',
      label: water.noun,
      shape: 'water',
      x: round3(at.x),
      z: round3(at.z),
      width: w,
      depth: d,
      height: 0.5,
      elementId: waterElement,
    });
    extent = {
      x: Math.max(extent.x, Math.abs(at.x) + w / 2),
      z: Math.max(extent.z, Math.abs(at.z) + d / 2),
    };
  }
  const width = Math.min(MAX_SET_M, Math.max(MIN_SET_WIDTH_M, Math.ceil(2 * (extent.x + SET_MARGIN_M))));
  const depth = Math.min(MAX_SET_M, Math.max(MIN_SET_DEPTH_M, Math.ceil(2 * (extent.z + SET_MARGIN_M))));

  // ------------------------------------------------------------ the shots
  const shots = brief.shots.map((s) => {
    const m = movementOf(s.movement);
    if (!m.known)
      warnings.push(`shot ${s.id}: movement '${s.movement}' is not one the desk knows: read as static`);
    const framing = s.framing ?? framingFromWords(s.description, s.action) ?? 'medium';
    return {
      id: s.id,
      index: s.index,
      durationSec: s.durationSec,
      name: `Shot ${s.index + 1}`.slice(0, 64),
      description: s.description,
      action: s.action,
      camera: { framing, movement: m.movement, lensMm: s.lensMm, move: s.move ?? m.move },
      characterIds: shotCast(s).filter((id) => castById.has(id)),
      elementIds: s.elementIds,
      layout: s.layout.map((e) => ({ characterId: e.castId, side: e.side, facing: e.facing })),
      continuity: s.continuity,
    };
  });
  const castOverrides = Object.fromEntries(
    [...kinds].filter(([id]) => order.includes(id)).map(([id, k]) => [id, k.kind]),
  );
  const set: BriefPlannedSet = {
    width,
    depth,
    ground,
    interior,
    sun: { azimuthDeg: sun.azimuthDeg, elevationDeg: Math.max(2, sun.elevationDeg) },
    landmarks,
  };
  const input: z.input<typeof RideoImportInputSchema> = {
    blocking: { set, props: blockingProps },
    state: 'missing',
    shots,
    characters: brief.cast
      .filter((c) => order.includes(c.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        summary: c.description,
        heightM: c.heightM,
        kind: castOverrides[c.id],
      })),
    elements: brief.elements.map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind === 'other' ? null : e.kind,
      description: e.description,
    })),
    settings: { fps: brief.fps, width: brief.width, height: brief.height },
    castOverrides,
    clip: brief.id,
    preRollFrames: o.preRollFrames ?? 12,
    update: false,
    source: 'host',
  };
  return { input, cast: kinds, order, unstaged, holders, props, skipped, marks, set, warnings };
}
