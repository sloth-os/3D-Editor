import type { DeskFraming, DeskMove } from '../../doc/types';
import { DESK_MOVES } from '../../doc/types';
import { BUILT_KINDS, type ActorKind } from '../characters';
import { HUMANOID_KINDS } from '../characters/types';
import {
  escapeRe,
  foldText,
  humanKindOf,
  isAgeText,
  plainText,
  sentenceBreak,
  sentencesOf,
  speciesOf,
} from '../rideo/rules';
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
/**
 * Words that describe playing cards, as a regular expression's source: those that may stand, up to
 * three of them, before "cards" in a deck of cards (OUTDOORS: "a deck of worn old playing cards",
 * "a deck of Bicycle playing cards").
 */
const CARD_WORDS =
  'playing|tarot|poker|bridge|trading|flash|old|new|brand|worn|well-worn|fresh|battered|tattered|dog-eared|greasy|grubby|dirty|marked|crisp|sticky|bent|torn|faded|shiny|plastic|paper|cheap|lucky|spare|unopened|blank|antique|vintage';

/**
 * Words that say a place is outdoors (they win over a room named as being nearby); a deck too (a
 * boat's or a house's), but not "below deck", nor a deck of cards ("of", at most one word of any kind,
 * then up to three CARD_WORDS and "cards": "a deck of cards", "the deck of his cards", "a deck of
 * worn old playing cards", "a deck of Bicycle playing cards"; not "on the deck of the ship cards are
 * dealt" nor "on the deck of the galleon sailors play cards"), a tape, cassette, DJ or skateboard
 * deck or a deck chair.
 */
const OUTDOORS = new RegExp(
  String.raw`\b(?:outdoors?|outside|exterior|open air|meadow|field|park|garden|yard|backyard|street|road|lane|beach|forest|woods?|jungle|desert|mountain|hill|valley|countryside|farm|paddock|pasture|lake|river|sea|ocean|shore|harbou?r|square|playground|courtyard|rooftop|sky|campsite|camp|clearing|orchard|vineyard|savanna|tundra|cliff|canyon|dunes?|terrace|patio|porch|veranda|(?<!below |under |tape |cassette |card |cards |record |mixing |tarot |dj |dj's |skateboard |skate )decks?(?!\s+(?:chairs?|shoes?)\b|\s+of\s+(?:[a-z0-9-]+\s+)?(?:(?:${CARD_WORDS})\s+){0,3}cards\b)|car park|parking lot)\b`,
  'g',
);

/**
 * Indoor words that may say where or whose an outdoor place is rather than name a room ("deep inside
 * the forest", "the cafe terrace", "the factory yard", "the museum garden"). A room's name ("kitchen",
 * "hall", "office", "lobby") always names a room.
 */
const QUALIFIERS = /^(?:inside|flat|bar|cafe|caf|factory|museum)$/;

/**
 * Buildings, and the shelters people are inside of as they are of a building (boats, sheds, tents,
 * caravans …), that an outdoor word before them says which of ("the lake house", "the mountain lodge",
 * "the river boat", "the garden shed", "the mountain tent"): the outdoor word then names the building,
 * not the place.
 */
const BUILDING =
  /^[\s-]+(?:house|home|cottage|cabin|lodge|hotel|motel|inn|hostel|chalet|villa|hut|bungalow|mansion|manor|castle|palace|barn|shed|shack|stable|greenhouse|lighthouse|windmill|mill|boat|houseboat|riverboat|ship|yacht|barge|ferry|steamer|tent|caravan|trailer|camper|motorhome|yurt|tipi|teepee|wigwam|igloo|bothy)s?\b/;

/** What comes before "inside" or "indoors" that opens a clause ("a cabin in the woods, inside by the fire"). */
const CLAUSE_OPENING = /(?:[,;:–—]|\s-)\s*(?:(?:and|but|then)\s+)?$/;

/**
 * Whether a place is an interior by its words: "indoors", "inside" or a room's name make it one unless
 * outdoor words come first ("a meadow behind the house's kitchen"), or "inside" or "indoors" opens a
 * clause after them ("a cabin in the woods, inside by the fire"); null when the words say neither.
 * "inside", "flat", "bar", "cafe", "factory" or "museum" with an outdoor place right after it says
 * where or whose that place is ("deep inside the forest", "the cafe terrace", "the factory yard"),
 * nothing of a room; a room's name always names one ("the kitchen of the farm"). An outdoor word that
 * names a building or a shelter ("the lake house", "the forest hotel", "the river boat", "the garden
 * shed", "the mountain tent") or owns a room or building ("the park's cafe") says which building, not
 * that the place is outdoors.
 */
export function interiorFromWords(text: string): boolean | null {
  const t = plainText(text);
  const indoors = [...t.matchAll(INDOORS)];
  const building = (at: number) => BUILDING.test(` ${t.slice(at)}`) || indoors.some((m) => m.index === at);
  const namesBuilding = (end: number) => {
    if (BUILDING.test(t.slice(end))) return true;
    const own = /^'s\s+/.exec(t.slice(end));
    if (!own) return false;
    // the word after "'s", or the one after that ("the park's old cafe")
    const at = end + own[0].length;
    const next = /^[a-z'-]+\s+/.exec(t.slice(at));
    return building(at) || (next !== null && building(at + next[0].length));
  };
  const places = [...t.matchAll(OUTDOORS)].filter((o) => !namesBuilding(o.index + o[0].length));
  const qualifies = (m: RegExpExecArray) => {
    const end = m.index + m[0].length;
    return (
      QUALIFIERS.test(m[0]) &&
      places.some(
        (o) =>
          o.index >= end &&
          /^\W*(?:(?:the|a|an|of|its|their)\W+)?(?:[a-z'-]+\W+)?$/.test(t.slice(end, o.index)),
      )
    );
  };
  // "inside" or "indoors" opening a clause says where the scene is, whatever outdoor words came
  // before: on its own ("inside by the fire") or of a room or a building ("inside the barn"), not of
  // anything else ("inside the gate")
  const insideClause = (m: RegExpExecArray) => {
    if (!/^(?:inside|indoors?)$/.test(m[0]) || qualifies(m) || !CLAUSE_OPENING.test(t.slice(0, m.index)))
      return false;
    const end = m.index + m[0].length;
    const object =
      /^\s+(?:the|an?|his|her|their|its|our|my|your|this|that)\s+(?:[a-z'-]+\s+){0,2}[a-z'-]+/.exec(
        t.slice(end),
      );
    if (!object) return true;
    const objectEnd = end + object[0].length;
    return (
      indoors.some((x) => x.index > end && x.index < objectEnd) ||
      (t.slice(end, objectEnd).match(/[a-z'-]+/g) ?? []).some((w) => BUILDING.test(` ${w}`))
    );
  };
  const inside = indoors.find((m) => !qualifies(m));
  const outside = places[0];
  if (indoors.some(insideClause)) return true;
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

/**
 * Words after which the word before is not what the member is: a possessive names whose something
 * is ("crow's feet", "the farmer's duck"), "-like" what it resembles ("a crow-like old woman"), a
 * hyphened "-ed" word a feature ("bull-necked", "doe-eyed", "pigeon-toed"), and "of a man" (or a
 * woman …) a figure of speech ("a bear of a man").
 */
const OWNED_OR_LIKE =
  /^(?:'s\b|-like\b|-[a-z]+ed\b|\s+of\s+an?\s+(?:m[ae]n|wom[ae]n|boy|girl|guy|fellow|lad|lass|lady|gentleman)\b)/;

/** `text` with the words a modifier makes something else (see MODIFIED, OWNED_OR_LIKE, TOY_BEFORE) blanked, same length. */
function blankModifiers(text: string): string {
  return text.replace(/[a-z]+/g, (w, at: number) => {
    const after = text.slice(at + w.length);
    return MODIFIED.test(after) || OWNED_OR_LIKE.test(after) || TOY_BEFORE.test(text.slice(0, at))
      ? ' '.repeat(w.length)
      : w;
  });
}

/**
 * Words after an animal word that keep it the animal: its young ("a bear cub", "a retriever
 * puppy", "a goat kid"), its sex ("a pony mare", "a rabbit doe") and breed words ("a terrier mix",
 * "a Labrador cross", "a collie mixed breed").
 */
const KEEPS_ANIMAL =
  /^(?:cubs?|pups?|pupp(?:y|ies)|kittens?|kits?|foals?|colts?|fill(?:y|ies)|calf|calves|lambs?|kids?|piglets?|fawns?|chicks?|ducklings?|goslings?|joeys?|mares?|stallions?|geldings?|stags?|bucks?|does?|hens?|roosters?|cocks?|drakes?|bulls?|cows?|heifers?|sows?|boars?|ewes?|rams?|mix(?:es)?|mixed|cross(?:es)?|crossbreeds?|breeds?|hybrids?|mongrels?|mutts?)$/;

/** Whether a word alone names an animal (rideo/rules.ts speciesOf's words, or STAND_INS). */
const isAnimalWord = (w: string): boolean =>
  speciesOf({ name: w, summary: '', identity: undefined }) !== null || standInKind(w) !== null;

/** Whether a word alone names a dog of any size ("retriever", "husky", "poodle", "puppy"). */
const isDogWord = (w: string): boolean =>
  /^(?:dog|small_dog)$/.test(speciesOf({ name: w, summary: '', identity: undefined }) ?? '');

/** Body parts and looks that make the animal word before them a person's feature ("bull neck", "doe eyes", "a pony tail"). */
const FEATURE_NOUNS =
  /^(?:neck|eyes?|face|nose|legs?|arms?|shoulders?|chest|jaw|jowls|lips|mouth|teeth|ears?|hands?|feet|foot|toes|hair|head|brows?|lashes|cheeks|chin|belly|gut|back|hips|thighs|skin|grin|smile|gaze|stare|glare|walk|gait|stance|posture|tail)$/;

/**
 * Stems of the hyphened "-ed" words that say what a member has or is like (a body part, a look or a
 * nature: "thick-necked", "broad-shouldered", "wide-eyed", "cold-blooded", "quick-witted",
 * "good-natured"), as a regular expression's source: before "as a(n)" such a word makes a likeness
 * (LIKENESS), where any other hyphened "-ed" word is a past participle that gives a role
 * ("hand-reared", "bottle-fed", "home-bred").
 */
const HAS_ED =
  'neck|shoulder|chest|legg|ey|ear|foot|head|heart|hair|skinn|bon|bodi|lipp|jaw|back|nos|fac|to|arm|hand|brow|cheek|chinn|hipp|thigh|belli|blood|witt|sight|tongu|skull|limb|mouth|voic|tooth|waist|muscl|temper|natur|manner|will|mind|spirit|fram|fist|tail|lash|lidd|throat|colou?r';

/**
 * Words before "as" that give the member a role (LIKENESS), as a regular expression's source: past
 * participles that do not end in "-ed" (bred, kept, bought, sold, born, brought, caught, found, got,
 * given, held, known, taken, won, shown, proven, spoilt), began and begun, and forms of work, use,
 * breed, train, serve, act, double and live ("works", "using", "doubles", "lives").
 */
const ROLE_WORDS =
  'work(?:s|ing)?|use|uses|using|breed(?:s|ing)?|bred|train(?:s|ing)?|serves?|serving|act(?:s|ing)?|doubles?|doubling|lives?|living|kept|bought|sold|born|brought|caught|found|got|given|held|known|taken|won|shown|proven|spoilt|began|begun';

/**
 * An animal word's likeness in an item of rideo's identity line, read on the words before it
 * (blankFeatures): "as a(n)" or "like a(n)" with at most two words between ("strong as an ox", "as
 * strong as a big old bull", "fierce as a tiger" or "sleek as an otter", whose article MODIFIED
 * blanked before an -er word, "built like a bear"), but not "as" after a word that gives the member
 * a role: a word ending in "-ed" ("retired", "adopted"), one after a hyphen too ("hand-reared",
 * "bottle-fed") unless it says what the member has or is like (HAS_ED: "thick-necked as a bull" is a
 * likeness), a word of ROLE_WORDS ("bred", "farm-born", "works", "doubles"), or "home", "life",
 * "up", "out", "years" or "family" after such a word ("brought home as a puppy", "began life as a
 * race horse", "grew up as a farm dog"): "worked as a plough horse", "retired as a race horse" and
 * "hand-reared as a foal" are the animal.
 */
const LIKENESS = new RegExp(
  String.raw`\b(?:(?<!(?:(?:^|[^a-z-])(?:[a-z]+ed|home|life|up|out|years|family)|(?:^|[^a-z])(?:${ROLE_WORDS})|-(?!(?:${HAS_ED})ed\b)[a-z]+ed)\s+)as|like)\s+(?:an?|\s{1,2})\s+(?:[a-z-]+\s+){0,2}$`,
);

/**
 * The words an item of rideo's identity line is read by for an animal (sentenceKind: those before
 * any person and any word of NOT_ITSELF) with the animal words that are a person's feature or
 * likeness, or another animal's modifier, blanked, same length: one whose next word (after spaces or
 * a hyphen) is a body part or a look (FEATURE_NOUNS: "bull neck", "doe eyes", "horse face", "chicken
 * legs", "pony tail"), a likeness (LIKENESS: "strong as an ox", "fierce as a tiger", "built like a
 * bear"; not a role, "retired as a race horse"), and one whose next word is another animal word,
 * not its young, its sex or a breed word (KEEPS_ANIMAL): the later word is the animal ("Australian
 * cattle dog", "bird dog" and "bull terrier" are dogs, but "Shetland pony mare" is a pony and "bear
 * cub" a bear), unless it names a dog and is not a young one (isDogWord): a breed of dog names the
 * dog, the first breed of a cross as in a sentence ("golden retriever-poodle mix" is a retriever,
 * "Labrador poodle mix" a Labrador; "puppy-dog eyes" stay a feature). Any other animal word is read
 * as in a sentence ("sturdy pony build", "golden retriever type", "donkey jack", and "bear build" or
 * "ox frame" whatever the line's ethnicity and marks: a person's clothes make such a member a
 * person, castKinds).
 */
function blankFeatures(head: string): string {
  return head.replace(/[a-z]+/g, (w, at: number) => {
    if (!isAnimalWord(w)) return w;
    const next = /^[\s-]+([a-z]+)/.exec(head.slice(at + w.length))?.[1] ?? '';
    const feature =
      FEATURE_NOUNS.test(next) ||
      LIKENESS.test(head.slice(0, at)) ||
      (isAnimalWord(next) && !KEEPS_ANIMAL.test(next) && !(isDogWord(w) && !KEEPS_ANIMAL.test(w)));
    return feature ? ' '.repeat(w.length) : w;
  });
}

/**
 * What one sentence of a cast member's own words makes it: an animal (a built kind, or a stand-in for
 * one the desk has no figure for) named before any person and before any word that makes the animal
 * something the member has, does or wears; 'person' when a person is named first; null when it says
 * neither. In an `item` of rideo's identity line an animal word that is a person's feature or
 * likeness, or another animal's modifier, does not count (blankFeatures: "bull neck", "strong as an
 * ox", "cattle dog").
 */
function sentenceKind(sentence: string, item = false): AnimalWords | 'person' | null {
  const t = blankModifiers(plainText(sentence));
  const person = PERSON_NOUN.exec(t);
  const breaker = NOT_ITSELF.exec(t);
  const before = t.slice(0, Math.min(person?.index ?? t.length, breaker?.index ?? t.length));
  const head = item ? blankFeatures(before) : before;
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

/** A gender rideo's identity line gives ("<age> <gender>"). */
const IDENTITY_GENDER = /^(?:male|female|non-?binary|man|woman|boy|girl)$/;

/**
 * The line a cast member's description opens with after the member's name and a colon, as rideo
 * writes its identity line ("Name: <age> <gender>, <ethnicity>, <build>; <marks>; wearing …." —
 * rideo's compactIdentity, followed by its summary), and the text after it (accents folded, case
 * kept). The line runs to its first sentence end (rideo/rules.ts sentenceBreak): a period inside a
 * number ("1.85 m"), after a title ("Dr.", "Mr.", "Mrs.", "Ms.", "St.") or an initial
 * ("Dr. Okafor", "St. Ives", "J. Smith") unless a capitalised word that opens a sentence follows,
 * or after an abbreviation no capital follows ("approx. 160 cm", "e.g. a scar") does not end it, so
 * whatever follows such a period is still the line, not the summary. Null when the description does
 * not open with the name and a colon.
 */
export function identityLine(name: string, description: string): { line: string; rest: string } | null {
  const own = foldText(name).trim().split(/\s+/).filter(Boolean);
  if (!own.length) return null;
  const text = foldText(description);
  const opening = new RegExp(`^\\s*${own.map(escapeRe).join('\\s+')}\\s*:`, 'i').exec(text);
  if (!opening) return null;
  const after = text.slice(opening[0].length);
  const end = sentenceBreak(after);
  return { line: after.slice(0, end.end).trim(), rest: after.slice(end.next).trim() };
}

/**
 * The age and gender a cast member's description opens with as rideo writes them: the first item of
 * its identity line (identityLine), "<age> <gender>" ("45 male", "early 30s female", "8 girl", "6",
 * "male", "early twenties female", "30-ish female", "puppy male"). A gender word last in it (male,
 * female, man, woman, boy, girl, non-binary) makes it an identity line whatever the age says; without
 * one, the item must be an age alone ("8", "thirty", "6 years old"). Null otherwise. Whether the
 * member is a person or an animal is animalOf's: an animal the line names before its marks wins over
 * the gender word.
 */
export function identityOf(name: string, description: string): { age: string; gender: string } | null {
  const id = identityLine(name, description);
  if (!id) return null;
  const words = plainText(id.line.split(/[,;]/)[0]).trim().split(/\s+/).filter(Boolean);
  const gender = IDENTITY_GENDER.test(words.at(-1) ?? '') ? words.pop()! : '';
  const age = words.join(' ');
  if (!gender && !isAgeText(age)) return null;
  return { age, gender };
}

/**
 * The animal the first part of rideo's identity line (before its first ";": the age and gender, the
 * ethnicity and the build items) names as what the member is, each item read alone, as a sentence
 * but for the animal words that are a person's feature or likeness or another animal's modifier
 * (blankFeatures) — "Pip: 3 male, golden retriever, small", "Bella: adult female, chestnut mare",
 * "Clover: 7 female, chestnut, sturdy pony build", "Bruno: 6 male, brown, hulking bear build" (a
 * bear, as "Rob: 35 male, White, bear build" is: a person's clothes make such a member a person,
 * castKinds), "Cub: 2 male, bear cub", "Blue: 3 male, Australian cattle dog" (a dog). The words read
 * end before a word that makes it something the member has, does or is with ("golden retriever with
 * a white chest"), and in the first item only the age, before the gender, can name it ("Kit: kitten
 * female", "Pip: puppy male"). Null when it names none, or names one only as a feature: before a
 * body part or a look ("Tom: 45 male, stocky, bull neck", "Dee: 25 female, Latina, petite, doe
 * eyes", "Ken: 40 male, Asian, horse face"), after "as a(n)" ("strong as an ox") or "like" ("built
 * like a bear"), before a hyphened "-ed" word ("bull-necked") or as a figure of speech ("a bear of a
 * man"); the marks after the ";" ("bull neck", "doe eyes") are never read here as what the member is.
 */
function identityAnimal(line: string): AnimalWords | null {
  const [first, ...others] = line.split(';')[0].split(',');
  // "<age> <gender>": the gender is no animal's head ("puppy male")
  const age = first.trim().split(/\s+/);
  if (IDENTITY_GENDER.test(plainText(age.at(-1) ?? ''))) age.pop();
  for (const item of [age.join(' '), ...others]) {
    const k = sentenceKind(item, true);
    if (k && k !== 'person') return k;
  }
  return null;
}

/**
 * The animal a cast member is by its own words, or null for a person (the actor kind of a member
 * without a kind hint, before what the shots say: who rides and holds what). The words read are the
 * description's first sentence (after rideo's "Name:" its identity line: identityLine) and, when that
 * says neither a person nor an animal, the next sentence; then the name ("Duck"). Sentences end as
 * rideo/rules.ts sentencesOf reads them: not at a period inside a number, after a title or an
 * abbreviation. In each, an animal counts only when named before any person and before any word that
 * makes it something the member has, does, wears, is with or resembles: "A white duck" and "Pip: 3
 * male, small; golden fur. A golden retriever puppy." are animals; "A farmer with a goat", "Mira: 8
 * girl, slim; a small bird tattoo …", "A girl in a rabbit costume", "wearing a fox-fur hat", "Jo:
 * tall, thin; crow's feet.", "A crow-like old woman", "A bull-necked farmer" and "Deep in love with
 * birds" are not. An identity line that gives a gender (identityOf: "Tom: 45 male, stocky; bull neck,
 * broken nose", "Dee: early twenties female; doe eyes") is a person's unless its first part names an
 * animal as what the member is, not as a feature (identityAnimal: "Pip: puppy male, small", "Rex:
 * young male, golden retriever", "Kit: kitten female"; not "Tom: 45 male, stocky, bull neck"): an
 * animal word among its marks is a feature ("bull neck", "doe eyes", "a parrot on his shoulder"),
 * and neither it nor the name ("Wolf: 40 male, tall.") makes the member an animal; only the sentence
 * after it (rideo's summary: "Quackers: 2 female, small; white feathers. A curious white duck.")
 * still can.
 */
export function animalOf(name: string, description: string): AnimalWords | null {
  const own = plainText(name).trim();
  const id = identityLine(name, description);
  const sentences = (id ? [id.line, ...sentencesOf(id.rest)] : sentencesOf(description))
    .filter(Boolean)
    .slice(0, 2);
  if (id && identityOf(name, description)?.gender) {
    const named = identityAnimal(id.line);
    if (named) return named;
    const next = id.rest ? sentenceKind(sentencesOf(id.rest)[0] ?? '') : null;
    return next && next !== 'person' ? next : null;
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

/**
 * The words humanKindOf and the other reading rules read of a cast member: its name, its description,
 * and the age and gender of rideo's identity line (identityOf) as rideo's identity fields.
 */
export function castWords(
  name: string,
  description: string,
): { name: string; summary: string; identity: { age: string; gender: string } | undefined } {
  return { name, summary: description, identity: identityOf(name, description) ?? undefined };
}

/**
 * A person's kind from a cast member's words (an age, child or elder words, a gender: rideo's identity
 * line gives both, "Bo: 6 male" a child, "Tom: 72 male" an elder, "Ana: early 30s female" a woman, by
 * humanKindOf's thresholds), adult when they say none.
 */
export function personKind(name: string, description: string): ActorKind {
  return humanKindOf(castWords(name, description));
}

export const isPersonKind = (kind: ActorKind): boolean => HUMANOID_KINDS.includes(kind);
