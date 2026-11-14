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

/**
 * Words that say a place is indoors. "flat" counts only as a noun (a flat in town, not a flat field),
 * "bar" not after "sand" or "candy"; "lift" and "store" are left out (a ski lift, a store front).
 */
const INDOORS =
  /\b(?:indoors?|inside|interior|room|bedroom|kitchen|bathroom|living room|lounge|hallway|hall|corridor|office|classroom|library|studio|attic|cellar|basement|garage|shop|cafe|caf|restaurant|(?<!sand |candy |chocolate |crow)bar|pub|church|chapel|museum|gallery|theatre|theater|cinema|gym|warehouse|factory|hospital|ward|lobby|apartment|flat(?=\s*(?:$|[,.;:!?)]|(?:in|on|at|of|with|where|above|below|near|by|and|that|which)\b))|cabin interior|staircase|stairwell|elevator|dining room|nursery|playroom|workshop|barn interior|tent interior)\b/g;
/** Words that say a place is outdoors (they win over a room named as being nearby). */
const OUTDOORS =
  /\b(?:outdoors?|outside|exterior|open air|meadow|field|park|garden|yard|backyard|street|road|lane|beach|forest|woods?|jungle|desert|mountain|hill|valley|countryside|farm|paddock|pasture|lake|river|sea|ocean|shore|harbou?r|square|playground|courtyard|rooftop|sky|campsite|camp|clearing|orchard|vineyard|savanna|tundra|cliff|canyon|dunes?|terrace|patio|porch|veranda|car park|parking lot)\b/g;

/**
 * Whether a place is an interior by its words: "indoors", "inside" or a room's name make it one unless
 * outdoor words come first ("a meadow behind the house's kitchen"); null when the words say neither.
 * An indoor word with an outdoor one right after it names where that outdoor place is or whose it is
 * ("deep inside the forest", "the cafe terrace", "the factory yard"): it says nothing of a room.
 */
export function interiorFromWords(text: string): boolean | null {
  const t = plainText(text);
  const outdoors = [...t.matchAll(OUTDOORS)];
  const nearOutdoor = (end: number) =>
    outdoors.some(
      (o) =>
        o.index >= end &&
        /^\W*(?:(?:the|a|an|of|its|their)\W+)?(?:[a-z'-]+\W+)?$/.test(t.slice(end, o.index)),
    );
  const inside = [...t.matchAll(INDOORS)].find((m) => !nearOutdoor(m.index + m[0].length));
  const outside = outdoors[0];
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

/** A plural or singular animal word as one animal ("ducks" → "duck", "geese" → "goose", "foxes" → "fox"). */
export function singularAnimal(word: string): string {
  const w = word.toLowerCase();
  const irregular: Readonly<Record<string, string>> = {
    geese: 'goose',
    mice: 'mouse',
    wolves: 'wolf',
    bunnies: 'bunny',
    hippopotami: 'hippopotamus',
    'guinea pigs': 'guinea pig',
  };
  if (irregular[w]) return irregular[w];
  if (/(?:ss|us)$/.test(w)) return w;
  if (/(?:x|ch|ss)es$/.test(w) || /(?:buffalo|rhinoceros|lioness|ostrich)es$/.test(w)) return w.slice(0, -2);
  if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
  return w.endsWith('s') ? w.slice(0, -1) : w;
}

/**
 * Nouns that name a person: named before any animal, they make a cast member one ("A farmer with a
 * goat", rideo's "Mira: 8 girl, slim; …"). Not before "'s" ("the farmer's duck" is a duck).
 */
const PERSON_NOUN =
  /\b(?:girls?|boys?|m[ae]n|wom[ae]n|lad(?:y|ies)|gentlem[ae]n|child(?:ren)?|bab(?:y|ies)|toddlers?|teen(?:ager)?s?|persons?|people|adults?|guys?|kings?|queens?|princes?|princess(?:es)?|knights?|witch(?:es)?|wizards?|pirates?|cowboys?|cowgirls?|mother|father|mum|mom|dad|grand(?:ma|pa|mother|father)|granny|aunt|uncle|sister|brother|son|daughter|wife|husband|farmers?|(?:zoo|shop|inn|bee|game)?keepers?|shepherd(?:ess)?s?|hunters?|vets?|veterinarians?|owners?|trainers?|riders?|jockeys?|teachers?|students?|pupils?|doctors?|nurses?|chefs?|cooks?|bakers?|pilots?|sailors?|soldiers?|officers?|police|detectives?|scientists?|explorers?|rangers?|gardeners?|builders?|drivers?|captains?|miners?|clowns?|guards?|servants?|maids?|butlers?|waiters?|waitress(?:es)?|singers?|dancers?|artists?|painters?|writers?|poets?|musicians?|mayors?|priests?|nuns?|monks?|[a-z]+(?:man|woman|men|women))\b(?!'s\b)/;

/** Words after which an animal is something a member has, does, wears or is with, not what it is. */
const NOT_ITSELF =
  /\b(?:who|whom|whose|which|that|with|without|in|on|at|by|for|from|to|of|near|like|after|behind|beside|under|wearing|wears?|dressed|carr(?:y|ies|ying)|hold(?:s|ing)?|feed(?:s|ing)?|loves?|likes?|has|have|keeps?|owns?|tends?|watch(?:es|ing)?|chas(?:es|ing)|rides?|riding|his|her|their|its|my|your|our)\b/;

/**
 * Words that make the word before them a modifier: a thing it is the shape or print of ("a bird
 * tattoo", "rabbit ears", "a fox-fur hat") or a person or thing it names ("a horse trainer", "a dog
 * walker", "a duck feather").
 */
const MODIFIED =
  /^[\s-]+(?!(?:under|over|after|ever|never|other|rather|either|neither|whether|together|for|nor|near|deer)\b)(?:[a-z]+(?:er|or|ist|man|woman|men|women)s?|costumes?|tattoos?|prints?|patterns?|ears|tails?|masks?|hats?|onesies?|suits?|slippers?|toys?|plush(?:ies)?|shaped|logos?|badges?|fur|pendants?|kites?|t-?shirts?|shirts?|pyjamas|pajamas|puppets?|figurines?|statues?|drawings?|lady|ladies|boys?|girls?)\b/;

/** Words that make the next word a toy or an image ("a teddy bear", "a wooden horse"). */
const TOY_BEFORE =
  /\b(?:teddy|toy|rocking|stuffed|plush|hobby|cuddly|wooden|paper|cardboard|origami|inflatable|plastic|china|porcelain)\s+$/;

/** `text` with the words a modifier makes something else (see MODIFIED, TOY_BEFORE) blanked, same length. */
function blankModifiers(text: string): string {
  return text.replace(/[a-z]+/g, (w, at: number) =>
    MODIFIED.test(text.slice(at + w.length)) || TOY_BEFORE.test(text.slice(0, at)) ? ' '.repeat(w.length) : w,
  );
}

/**
 * What one sentence of a cast member's own words makes it: an animal (a built kind, or a stand-in for
 * one the desk has no figure for) named before any person and before any word that makes the animal
 * something the member has, does or wears; 'person' when a person is named first; null when it says
 * neither.
 */
function sentenceKind(sentence: string): AnimalWords | 'person' | null {
  const t = blankModifiers(plainText(sentence));
  const person = PERSON_NOUN.exec(t);
  const breaker = NOT_ITSELF.exec(t);
  const head = t.slice(0, Math.min(person?.index ?? t.length, breaker?.index ?? t.length));
  let stand: { at: number; kind: ActorKind; word: string } | null = null;
  for (const [re, kind] of STAND_INS) {
    const m = re.exec(head);
    if (m && (!stand || m.index < stand.at)) stand = { at: m.index, kind, word: m[0] };
  }
  const built = speciesOf({ name: stand ? head.slice(0, stand.at) : head, summary: '', identity: undefined });
  if (built) return { kind: built, builtIn: true, word: built.replace(/_/g, ' ') };
  if (stand) return { kind: stand.kind, builtIn: false, word: singularAnimal(stand.word) };
  return person ? 'person' : null;
}

/** An animal a cast member's words make it: a built kind, or the built kind standing in for one the desk has no figure of. */
export interface AnimalWords {
  kind: ActorKind;
  /** Whether the desk has a figure of it (else `kind` stands in for `word`). */
  builtIn: boolean;
  /** The animal as the words name it, singular ("duck"). */
  word: string;
}

/**
 * The animal a cast member is by its own words, or null for a person (the actor kind of a member
 * without a kind hint, before what the shots say: who rides and holds what). The words read are the
 * description's first sentence (after rideo's "Name:" opening its identity line) and, when that says
 * neither a person nor an animal, the next sentence; then the name ("Duck"). In each, an animal counts
 * only when named before any person and before any word that makes it something the member has, does,
 * wears or is with: "A white duck" and "Pip: 3 male, small; golden fur. A golden retriever puppy." are
 * animals; "A farmer with a goat", "Mira: 8 girl, slim; a small bird tattoo …", "A girl in a rabbit
 * costume", "wearing a fox-fur hat" and "Deep in love with birds" are not.
 */
export function animalOf(name: string, description: string): AnimalWords | null {
  const own = plainText(name).trim();
  const sentences = description
    .split(/[.!?\n]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 2);
  if (sentences.length && own) {
    const first = plainText(sentences[0]);
    if (first.startsWith(own) && /^\s*:/.test(first.slice(own.length)))
      sentences[0] = first.slice(own.length).replace(/^\s*:\s*/, '');
  }
  for (const sentence of sentences) {
    const k = sentenceKind(sentence);
    if (k === 'person') return null;
    if (k) return k;
  }
  const k = own ? sentenceKind(own) : null;
  return k && k !== 'person' ? k : null;
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
