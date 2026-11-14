import type { DeskFraming, DeskMove } from '../../doc/types';
import { DESK_MOVES } from '../../doc/types';
import { BUILT_KINDS, type ActorKind } from '../characters';
import { HUMANOID_KINDS } from '../characters/types';
import { humanKindOf, plainText, speciesOf } from '../rideo/rules';
import { RIDEO_MOVEMENTS, type RideoMovement } from '../rideo/schema';
import type { TimeOfDay } from './schema';

/*
 * What a brief's words say for the staging (stage.ts): the sun of a time of day, whether the set is an
 * interior, what its ground is, the water it has and where, the framing a shot's words name, the
 * movement words of a shot as the desk's, and the actor kind of a cast member's hint. Pure functions,
 * tested alone.
 */

// ---------------------------------------------------------------- the sun

/**
 * The sun of each time of day: azimuth (degrees about the set, 0 the front, 90 its right, 180 its
 * back, as desk.set_build takes it) and elevation. The day's arc runs from the right of the set (the
 * east of a set seen from the south) over its back at noon to its left, so a front camera sees the
 * morning light come from its right and the evening's from its left; night is a high moon.
 */
export const TIME_OF_DAY_SUN: Readonly<Record<TimeOfDay, { azimuthDeg: number; elevationDeg: number }>> = {
  dawn: { azimuthDeg: 95, elevationDeg: 4 },
  morning: { azimuthDeg: 120, elevationDeg: 25 },
  noon: { azimuthDeg: 175, elevationDeg: 68 },
  afternoon: { azimuthDeg: 225, elevationDeg: 40 },
  golden_hour: { azimuthDeg: 255, elevationDeg: 10 },
  dusk: { azimuthDeg: 268, elevationDeg: 3 },
  night: { azimuthDeg: 200, elevationDeg: 35 },
};

/** The sun the desk lights a set with when the brief gives no time of day (desk.set_build's default). */
export const DEFAULT_SUN = { azimuthDeg: 135, elevationDeg: 40 } as const;

/** The sun of a time of day (null: the default sun). */
export function sunOf(time: TimeOfDay | null): { azimuthDeg: number; elevationDeg: number } {
  return time ? TIME_OF_DAY_SUN[time] : DEFAULT_SUN;
}

// ---------------------------------------------------------------- interiors

/** Words that say a place is indoors. */
const INDOORS =
  /\b(?:indoors?|inside|interior|room|bedroom|kitchen|bathroom|living room|lounge|hallway|hall|corridor|office|classroom|library|studio|attic|cellar|basement|garage|shop|store|cafe|caf|restaurant|bar|pub|church|chapel|museum|gallery|theatre|theater|cinema|gym|warehouse|factory|hospital|ward|lobby|apartment|flat|cabin interior|staircase|stairwell|elevator|lift|dining room|nursery|playroom|workshop|barn interior|tent interior)\b/;
/** Words that say a place is outdoors (they win over a room named as being nearby). */
const OUTDOORS =
  /\b(?:outdoors?|outside|exterior|open air|meadow|field|park|garden|yard|backyard|street|road|lane|beach|forest|woods?|jungle|desert|mountain|hill|valley|countryside|farm|paddock|pasture|lake|river|sea|ocean|shore|harbou?r|square|playground|courtyard|rooftop|sky|campsite|camp|clearing|orchard|vineyard|savanna|tundra|cliff|canyon|dunes?)\b/;

/**
 * Whether a place is an interior by its words: "indoors", "inside" or a room's name make it one unless
 * outdoor words come first ("a meadow behind the house's kitchen"); null when the words say neither.
 */
export function interiorFromWords(text: string): boolean | null {
  const t = plainText(text);
  const inside = INDOORS.exec(t);
  const outside = OUTDOORS.exec(t);
  if (inside && outside) return inside.index < outside.index;
  if (inside) return true;
  if (outside) return false;
  return null;
}

// ---------------------------------------------------------------- the ground

/** Ground words, the first named winning, and the name the set's ground gets (set.ts GROUND_COLORS reads it). */
const GROUND_WORDS: readonly (readonly [RegExp, string])[] = [
  [/\bsnow(?:y|field)?\b/, 'snow'],
  [/\b(?:ice|icy|frozen)\b/, 'ice'],
  [/\b(?:sand|sandy|beach|dunes?|desert)\b/, 'sand'],
  [
    /\b(?:grass|grassy|lawn|meadow|field|park|pasture|paddock|garden|prairie|savanna|clearing|hillside)\b/,
    'grass',
  ],
  [/\b(?:wood(?:en)? floor|floorboards?|planks?|deck|decking|parquet|wooden)\b/, 'wood'],
  [/\b(?:carpet(?:ed)?|rug)\b/, 'carpet'],
  [/\b(?:dirt|soil|mud|muddy|earth|trail|path|track|farmyard|forest floor|woods?|forest)\b/, 'dirt'],
  [
    /\b(?:stone|rock|rocky|concrete|asphalt|road|street|tiles?|tiled|pavement|marble|cobbles?|cobbled|plaza|square|courtyard|car park|parking)\b/,
    'stone',
  ],
];

/**
 * The ground of a place by its words (the first ground word named: grass, sand, snow, wood, stone …),
 * else a wooden floor for an interior and plain ground outside. Water is never the ground: a pond or
 * the sea is a water landmark (waterFromWords).
 */
export function groundFromWords(text: string, interior: boolean): string {
  const t = plainText(text);
  let best: { at: number; name: string } | null = null;
  for (const [re, name] of GROUND_WORDS) {
    const m = re.exec(t);
    if (m && (!best || m.index < best.at)) best = { at: m.index, name };
  }
  return best?.name ?? (interior ? 'wood' : 'ground');
}

// ---------------------------------------------------------------- water

/** Open water a place may have, with the size of its landmark (width across × depth, m) and whether it is a strip. */
export const WATER_SIZES: Readonly<Record<string, { width: number; depth: number; strip: boolean }>> = {
  puddle: { width: 1.2, depth: 0.9, strip: false },
  pond: { width: 5, depth: 4, strip: false },
  pool: { width: 8, depth: 4, strip: false },
  fountain: { width: 3, depth: 3, strip: false },
  stream: { width: 16, depth: 1.5, strip: true },
  brook: { width: 16, depth: 1.5, strip: true },
  creek: { width: 16, depth: 2, strip: true },
  canal: { width: 30, depth: 3, strip: true },
  river: { width: 30, depth: 6, strip: true },
  lake: { width: 20, depth: 10, strip: false },
  lagoon: { width: 20, depth: 10, strip: false },
  loch: { width: 20, depth: 10, strip: false },
  reservoir: { width: 30, depth: 14, strip: false },
  bay: { width: 60, depth: 24, strip: true },
  harbour: { width: 40, depth: 16, strip: true },
  sea: { width: 80, depth: 30, strip: true },
  ocean: { width: 80, depth: 30, strip: true },
};

const WATER_NOUN = new RegExp(`\\b(${[...Object.keys(WATER_SIZES), 'harbor'].join('|')})s?\\b`);
const SIDE_WORDS: readonly (readonly [RegExp, 'left' | 'right' | 'behind' | 'front'])[] = [
  [/\b(?:on|to|at) the left\b|\bleft of\b|\bon (?:our|the camera's) left\b|\bleft side\b/, 'left'],
  [/\b(?:on|to|at) the right\b|\bright of\b|\bon (?:our|the camera's) right\b|\bright side\b/, 'right'],
  [
    /\b(?:in front|in the foreground|foreground|before them|nearby in front|at the front|downstage)\b/,
    'front',
  ],
  [
    /\b(?:behind|in the background|background|at the back|beyond|in the distance|far side|upstage)\b/,
    'behind',
  ],
];

/** The water a place has by its words: its noun (pond, lake, river, sea …) and the side it lies on (null: unsaid). */
export function waterFromWords(
  text: string,
): { noun: string; side: 'left' | 'right' | 'behind' | 'front' | null } | null {
  const t = plainText(text);
  for (const sentence of t.split(/[.!?;\n]+/)) {
    const m = WATER_NOUN.exec(sentence);
    if (!m) continue;
    // "no pond", "without water": nothing
    if (/\b(?:no|without|never|not)\s+(?:\w+\s+)?$/.test(sentence.slice(0, m.index))) continue;
    const noun = m[1] === 'harbor' ? 'harbour' : m[1];
    // the side the clause naming the water gives it ("a pond on the left, an oak tree behind")
    const clause = sentence.slice(m.index).split(/,|\band\b|\bwhile\b/)[0];
    const lead =
      sentence
        .slice(0, m.index)
        .split(/,|\band\b|\bwhile\b/)
        .pop() ?? '';
    let side: 'left' | 'right' | 'behind' | 'front' | null = null;
    for (const [re, s] of SIDE_WORDS)
      if (re.test(clause) || re.test(lead)) {
        side = s;
        break;
      }
    return { noun, side };
  }
  return null;
}

// ---------------------------------------------------------------- shots

/** Framing words, the more precise first. */
const FRAMING_WORDS: readonly (readonly [RegExp, DeskFraming])[] = [
  [/\b(?:extreme close[- ]?up|extreme closeup|ecu|macro)\b/, 'extreme_close_up'],
  [/\b(?:medium close[- ]?up|medium closeup|mcu)\b/, 'medium_close'],
  [/\b(?:close[- ]?up|closeup|cu|tight shot)\b/, 'close_up'],
  [/\b(?:extreme wide|extreme long shot|establishing(?: shot)?|ews|els|aerial)\b/, 'extreme_wide'],
  [/\b(?:over[- ]the[- ]shoulder|ots)\b/, 'over_shoulder'],
  [/\b(?:pov|point[- ]of[- ]view)\b/, 'pov'],
  [/\b(?:insert(?: shot)?|cutaway)\b/, 'insert'],
  [/\b(?:wide(?: shot)?|long shot|full shot|ws|ls)\b/, 'wide'],
  [/\b(?:medium(?: shot)?|mid[- ]shot|ms|cowboy shot)\b/, 'medium'],
];

/** The framing a shot's words name (its description's first sentence, else its action's), or null. */
export function framingFromWords(description: string, action = ''): DeskFraming | null {
  for (const text of [description, action]) {
    const first = plainText(text).split(/[.!?\n]+/)[0] ?? '';
    for (const [re, framing] of FRAMING_WORDS) if (re.test(first)) return framing;
  }
  return null;
}

/** Movement words a host may use, read as the desk's movement (the import's) or as a named move. */
const MOVEMENT_SYNONYMS: Readonly<Record<string, RideoMovement | DeskMove>> = {
  locked: 'static',
  still: 'static',
  fixed: 'static',
  none: 'static',
  tripod: 'static',
  push: 'dolly_in',
  push_in: 'push_in',
  dolly_forward: 'dolly_in',
  track_in: 'dolly_in',
  truck_in: 'dolly_in',
  pull: 'dolly_out',
  pull_back: 'pull_out',
  pull_out: 'pull_out',
  dolly_back: 'dolly_out',
  track_out: 'dolly_out',
  track: 'tracking',
  tracking_shot: 'tracking',
  follow: 'tracking',
  following: 'tracking',
  truck: 'tracking',
  trucking: 'tracking',
  hand_held: 'handheld',
  shaky: 'handheld',
  jib: 'crane',
  boom: 'crane',
  zoom_in: 'zoom',
  zoom_out: 'zoom',
  arc: 'orbit',
  circle: 'orbit',
  circling: 'orbit',
  steadicam: 'steadicam_walk',
  gimbal: 'steadicam_walk',
  drone: 'drone_flyover',
  aerial: 'drone_flyover',
  flyover: 'drone_flyover',
  vertigo: 'dolly_zoom',
};

/**
 * A shot's movement words (the brief's `movement`) as the desk reads them: one of the ten planned
 * movements (static, pan, tilt, dolly_in, dolly_out, tracking, handheld, crane, zoom, orbit; the text
 * then gives a pan or an orbit its direction), or a named move of the 20 when the words are one
 * ("orbit_left", "steadicam"). Unknown words: static, `known` false.
 */
export function movementOf(words: string | null): {
  movement: RideoMovement;
  move: DeskMove | null;
  known: boolean;
} {
  if (!words?.trim()) return { movement: 'static', move: null, known: true };
  const key = plainText(words)
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const read = (k: string): RideoMovement | DeskMove | null =>
    (RIDEO_MOVEMENTS as readonly string[]).includes(k)
      ? (k as RideoMovement)
      : (DESK_MOVES as readonly string[]).includes(k)
        ? (k as DeskMove)
        : (MOVEMENT_SYNONYMS[k] ?? null);
  const v = read(key) ?? read(key.split('_')[0]);
  if (!v) return { movement: 'static', move: null, known: false };
  if ((RIDEO_MOVEMENTS as readonly string[]).includes(v)) {
    // a movement whose words name a move of the library ("zoom_out", "crane_down") keeps it
    const named = (DESK_MOVES as readonly string[]).includes(key) ? (key as DeskMove) : null;
    return { movement: v as RideoMovement, move: named, known: true };
  }
  return { movement: 'static', move: v as DeskMove, known: true };
}

// ---------------------------------------------------------------- actor kinds

/** Hints that name a person without saying which: the kind comes from the words (age, gender). */
const PERSON_HINTS = /^(?:person|people|human|humanoid|character|figure|someone|individual|actor|npc)$/;

/** Hints (and words) for people's kinds the desk builds. */
const HUMAN_HINTS: readonly (readonly [RegExp, ActorKind])[] = [
  [/^(?:baby|infant|toddler)$/, 'toddler'],
  [/^(?:child|kid|boy|girl|teen|teenager|schoolboy|schoolgirl)$/, 'child'],
  [/^(?:elder|elderly|senior|old man|old woman|grandma|grandpa|grandmother|grandfather)$/, 'elder'],
  [/^(?:man|male|gentleman|father|dad)$/, 'man'],
  [/^(?:woman|female|lady|mother|mum|mom)$/, 'woman'],
  [/^(?:adult|grown[- ]up)$/, 'adult'],
];

/**
 * Animals the desk has no figure for, staged as the built kind nearest their size and gait: birds
 * and small animals as a cat, wild dogs as a dog, goats as a sheep, big cats as a bear's bulk, big
 * grazers as a cow or a horse.
 */
const STAND_INS: readonly (readonly [RegExp, ActorKind])[] = [
  [
    /\b(?:ducks?|ducklings?|geese|goose|goslings?|swans?|hens?|chickens?|chicks?|roosters?|cockerels?|turkeys?|birds?|parrots?|owls?|pigeons?|doves?|crows?|ravens?|seagulls?|gulls?|penguins?|ostrich(?:es)?|emus?|rabbits?|bunn(?:y|ies)|hares?|squirrels?|hedgehogs?|mice|mouse|rats?|hamsters?|guinea pigs?|ferrets?|frogs?|toads?|turtles?|tortoises?|raccoons?|otters?|beavers?|badgers?|skunks?|possums?|monkeys?|lizards?)\b/,
    'cat',
  ],
  [/\b(?:fox(?:es)?|wolf|wolves|coyotes?|jackals?|dingos?|hyenas?)\b/, 'dog'],
  [/\b(?:goats?|kids? goat|llamas?|alpacas?)\b/, 'sheep'],
  [/\b(?:lions?|lioness(?:es)?|tigers?|leopards?|jaguars?|panthers?|cheetahs?|gorillas?)\b/, 'bear'],
  [
    /\b(?:buffalo(?:es)?|bison|yaks?|moose|elks?|rhinos?|rhinoceros(?:es)?|hippos?|hippopotam(?:us|i)|elephants?)\b/,
    'cow',
  ],
  [/\b(?:camels?|zebras?|giraffes?|unicorns?)\b/, 'horse'],
];

/** The built kind standing in for an animal the desk has no figure of, by its words (null: none named). */
export function standInKind(text: string): { kind: ActorKind; word: string } | null {
  const t = plainText(text);
  let best: { at: number; kind: ActorKind; word: string } | null = null;
  for (const [re, kind] of STAND_INS) {
    const m = re.exec(t);
    if (m && (!best || m.index < best.at)) best = { at: m.index, kind, word: m[0] };
  }
  return best && { kind: best.kind, word: best.word };
}

/** What a cast member's kind hint says: a built kind, "a person" (the words say which), or nothing the desk knows. */
export type KindHint =
  | { type: 'kind'; kind: ActorKind }
  | { type: 'person' }
  | { type: 'stand_in'; kind: ActorKind; word: string }
  | { type: 'unknown'; hint: string };

/** Reads a cast member's kind hint ("child", "dog", "person", "golden retriever", "duck" …). */
export function readKindHint(hint: string): KindHint {
  const h = plainText(hint).trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  const asKind = h.replace(/ /g, '_');
  if ((BUILT_KINDS as readonly string[]).includes(asKind)) return { type: 'kind', kind: asKind as ActorKind };
  if (PERSON_HINTS.test(h)) return { type: 'person' };
  for (const [re, kind] of HUMAN_HINTS) if (re.test(h)) return { type: 'kind', kind };
  const species = speciesOf({ name: h, summary: '', identity: undefined });
  if (species) return { type: 'kind', kind: species };
  const stand = standInKind(h);
  if (stand) return { type: 'stand_in', ...stand };
  return { type: 'unknown', hint: hint.trim() };
}

/** A person's kind from a cast member's words (age, child or elder words, gender), adult when they say none. */
export function personKind(name: string, description: string): ActorKind {
  return humanKindOf({ name, summary: description, identity: undefined });
}

export const isPersonKind = (kind: ActorKind): boolean => HUMANOID_KINDS.includes(kind);
