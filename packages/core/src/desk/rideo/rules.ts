import type { DeskMove } from '../../doc/types';
import { HUMANOID_KINDS, RIDEABLE_KINDS, type ActorKind } from '../characters/types';
import { rankCatalog } from '../../store/search';
import type { CatalogEntry } from '../../store/types';
import type { RideoBlockingPose, RideoCharacterInput, RideoMovement, RideoShotInput } from './schema';

/*
 * The reading rules of the rideo import (spec §11), pure functions over rideo's data so that they can
 * be tested alone: which actor kind a character is (people by default; quadrupeds only for the
 * animals rideo's cast rides or keeps as pets, never for one that talks or holds things), who rides
 * whom in a shot, which camera move a shot asks for, which built-in model a prop or landmark is, and
 * how rideo's ten poses and the editor's poses map onto each other.
 */

// ---------------------------------------------------------------- text

/** Text with accents folded and apostrophes made plain, in its own case. */
export function foldText(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[‘’ʼ]/g, "'");
}

/** Lower-case text with accents folded and apostrophes made plain. */
export function plainText(text: string): string {
  return foldText(text).toLowerCase();
}

/** The text of a character: its name, summary and identity (rideo's identity fields, or one string). */
export function characterText(c: Pick<RideoCharacterInput, 'name' | 'summary' | 'identity'>): string {
  const identity =
    typeof c.identity === 'string'
      ? c.identity
      : c.identity
        ? Object.values(c.identity)
            .filter((v): v is string => typeof v === 'string')
            .join('. ')
        : '';
  return plainText([c.name, c.summary ?? '', identity].join('. '));
}

export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Titles before a name: a period after one never ends a sentence ("Dr. Okafor", "St. Ives"). */
const TITLES = new Set([
  'dr',
  'mr',
  'mrs',
  'ms',
  'mx',
  'st',
  'prof',
  'rev',
  'fr',
  'capt',
  'col',
  'gen',
  'lt',
  'sgt',
  'cpl',
  'maj',
  'adm',
  'cmdr',
  'det',
  'insp',
  'supt',
  'sen',
  'gov',
  'hon',
  'pres',
  'mt',
  'mme',
  'mlle',
]);

/**
 * Abbreviations: a period after one ends a sentence only when a capital comes next ("approx. 160 cm",
 * "e.g. a scar", but "scars, tattoos etc. A retired boxer.").
 */
const ABBREVIATIONS = new Set([
  'approx',
  'appr',
  'ca',
  'cf',
  'eg',
  'ie',
  'etc',
  'esp',
  'incl',
  'no',
  'nos',
  'nr',
  'vs',
  'viz',
  'al',
  'jr',
  'sr',
  'ft',
  'in',
  'lb',
  'lbs',
  'oz',
  'cm',
  'mm',
  'km',
  'kg',
  'yrs',
  'yr',
  'yo',
  'mos',
  'mo',
  'wks',
  'wk',
  'hrs',
  'hr',
  'min',
  'max',
  'avg',
  'est',
  'dept',
  'ave',
  'rd',
]);

/**
 * Whether the period at `at` (its marks end at `next`) ends a sentence: not after a title, an initial
 * ("J.", "U.S.") or an abbreviation that no capital follows. A period inside a number ("1.85 m") is
 * never seen here: no space follows it.
 */
function periodEnds(text: string, at: number, next: number): boolean {
  const word = /(\p{L}+(?:\.\p{L}+)*|\p{N}+(?:[.,]\p{N}+)*)$/u.exec(
    text.slice(Math.max(0, at - 40), at),
  )?.[1];
  // after a number ("aged 45. A boxer."), or after other marks: an end
  if (!word || /^\p{N}/u.test(word)) return true;
  const parts = word.split('.');
  if (parts.every((p) => p.length === 1 && p !== p.toLowerCase())) return false;
  const w = parts.join('').toLowerCase();
  if (TITLES.has(w)) return false;
  if (ABBREVIATIONS.has(w) || parts.length > 1 || word.length === 1)
    return /^\s+["“'‘(]*\p{Lu}/u.test(text.slice(next));
  return true;
}

/**
 * Where the first sentence of `text` ends: `end`, where its end mark starts (the text's length when it
 * has none), and `next`, where the text after it starts. A sentence ends at a line break, at ".", "!",
 * "?" or "…" followed by a space or the end of the text (closing quotes or brackets between), and
 * with `semicolons` at ";"; a period inside a number, after a title ("Dr.", "Mrs.", "St."), an initial
 * or an abbreviation ("approx.", "e.g.") does not end it, unless a capital follows the abbreviation.
 */
export function sentenceBreak(text: string, semicolons = false): { end: number; next: number } {
  const re = semicolons ? /[.!?…]+["”'’)\]]*(?=\s|$)|[\n;]/g : /[.!?…]+["”'’)\]]*(?=\s|$)|\n/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const next = m.index + m[0].length;
    if (/^\.+["”'’)\]]*$/.test(m[0]) && !periodEnds(text, m.index, next)) continue;
    return { end: m.index, next };
  }
  return { end: text.length, next: text.length };
}

/** The sentences of a text, trimmed, without their end marks (see sentenceBreak). */
export function sentencesOf(text: string, semicolons = false): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.trim()) {
    const b = sentenceBreak(rest, semicolons);
    const s = rest.slice(0, b.end).trim();
    if (s) out.push(s);
    rest = rest.slice(b.next);
  }
  return out;
}

/** Sentences of a text (split at . ! ? ; and line breaks as sentenceBreak reads them). */
const sentences = (text: string): string[] => sentencesOf(text, true);

// ---------------------------------------------------------------- actor kinds

/** Words that name a quadruped species, with the kind they make (whole words, plurals included). */
const ANIMAL_WORDS: readonly (readonly [RegExp, ActorKind])[] = [
  [/\b(ponies|pony|shetlands?)\b/, 'pony'],
  [/\b(horses?|stallions?|mares?|foals?|colts?|filly|fillies|steeds?|mustangs?|geldings?)\b/, 'horse'],
  [/\b(donkeys?|mules?|burros?)\b/, 'donkey'],
  [/\b(cows?|bulls?|calf|calves|oxen|ox|cattle|heifers?)\b/, 'cow'],
  [/\b(puppy|puppies|pups?|chihuahuas?|pugs?|dachshunds?|terriers?|corgis?|poodles?)\b/, 'small_dog'],
  [/\b(dogs?|hounds?|retrievers?|labradors?|collies?|spaniels?|huskies|husky|beagles?|sheepdogs?)\b/, 'dog'],
  [/\b(cats?|kittens?|kitty|kitties|tabby|tomcats?)\b/, 'cat'],
  [/\b(sheep|lambs?|ewes?|rams?)\b/, 'sheep'],
  [/\b(pigs?|piglets?|hogs?|boars?)\b/, 'pig'],
  [/\b(deer|fawns?|stags?|doe|reindeer)\b/, 'deer'],
  [/\b(bears?|grizzly|grizzlies)\b/, 'bear'],
];

/**
 * Words that say a character is a person, whatever animal it also is: it talks, dresses, is a toy or
 * a panda (holding things is read from the blocking: a character holding a prop is a person).
 */
const PERSON_CUES =
  /\b(talks?|talking|speaks?|speaking|sings?|singing|voice|chatty|narrates?|tells jokes|wears?|wearing|dressed|outfit|shirt|t-shirt|dress|jacket|overalls|trousers|sweater|jumper|hoodie|backpack|glasses|spectacles|scarf|hat|apron|uniform|bipedal|upright|on two legs|anthropomorphic|cartoon|mascot|plush|teddy|toy|robot|puppet|panda)\b/;

/** Animal gear: wearing it does not make an animal a person. */
const GEAR =
  /\b(saddles?|bridles?|halters?|harness(es)?|reins|collars?|leash(es)?|blankets?|bells?|horseshoes?)\b/;

/** Words before a word that make it something the character has or does, not what it is ("her pony"). */
const NOT_SELF =
  /\b(her|his|their|its|my|your|our|owns?|with|rides?|riding|feeds?|walks?|loves?|likes?|has|have|of|and|than|chases?|pets?|brushes?|grooms?)\s+(?:[a-z'-]+\s+){0,2}$/;

/** A character's own words: its name, its identity and the first sentence of its summary. */
function ownTexts(c: Pick<RideoCharacterInput, 'name' | 'summary' | 'identity'>): string[] {
  const identity =
    typeof c.identity === 'string'
      ? c.identity
      : c.identity
        ? Object.values(c.identity)
            .filter((v): v is string => typeof v === 'string')
            .join('. ')
        : '';
  return [c.name, identity, sentences(c.summary ?? '')[0] ?? ''].map(plainText).filter(Boolean);
}

/** Whether `re` names what the character is in its own words (not what it has or does: "her pony"). */
function describes(texts: readonly string[], re: RegExp): boolean {
  for (const text of texts) {
    const all = new RegExp(re.source, 'g');
    for (let m = all.exec(text); m; m = all.exec(text))
      if (!NOT_SELF.test(text.slice(0, m.index))) return true;
  }
  return false;
}

/** A toy's word before an animal's: a teddy bear or a toy horse is a toy (which acts as a person). */
const TOY = /\b(teddy|toy|rocking|stuffed|plush|hobby)\s+$/;

/**
 * The quadruped kind a character's own words make it (its name, its identity, its summary's first
 * sentence, in that order; in one of them the animal named first), or null.
 */
export function speciesOf(c: Pick<RideoCharacterInput, 'name' | 'summary' | 'identity'>): ActorKind | null {
  for (const text of ownTexts(c)) {
    let first: { at: number; kind: ActorKind } | null = null;
    for (const [re, kind] of ANIMAL_WORDS) {
      const all = new RegExp(re.source, 'g');
      for (let m = all.exec(text); m && (!first || m.index < first.at); m = all.exec(text)) {
        const before = text.slice(0, m.index);
        if (NOT_SELF.test(before) || TOY.test(before)) continue;
        first = { at: m.index, kind };
        break;
      }
    }
    if (first) return first.kind;
  }
  return null;
}

/** Whether a character's words say it acts as a person (talks, holds things, dresses, is a toy or a panda). */
export function actsAsPerson(c: Pick<RideoCharacterInput, 'name' | 'summary' | 'identity'>): boolean {
  const text = characterText(c);
  for (const s of sentences(text)) {
    const m = PERSON_CUES.exec(s);
    if (!m) continue;
    // "wears a bridle", "a red saddle blanket": animal gear
    if (/^(wears?|wearing)$/.test(m[1] ?? m[0]) && GEAR.test(s)) continue;
    return true;
  }
  return false;
}

/** Numbers written out ("an eight-year-old girl", "forty-five", "thirty"). */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** Decades written out ("in her twenties", "late sixties"). */
const DECADE_WORDS: Readonly<Record<string, number>> = {
  twenties: 20,
  thirties: 30,
  forties: 40,
  fifties: 50,
  sixties: 60,
  seventies: 70,
  eighties: 80,
  nineties: 90,
};

/** Where in a decade "early", "mid" and "late" put an age ("late 60s": 68), and "-something" (35). */
const DECADE_PART: Readonly<Record<string, number>> = { early: 2, mid: 5, late: 8, something: 5 };

/** Units of a baby's age, in years ("18 months": 1). */
const SMALL_UNITS: readonly (readonly [RegExp, number])[] = [
  [/^months?$|^mos?$/, 12],
  [/^weeks?$|^wks?$/, 52],
  [/^days?$/, 365],
];

/**
 * The age a text gives, in years, or null: a number ("45", "about 30", "30-ish", "45 years old"), a
 * decade ("30s", "early 30s", "mid-forties", "late sixties": early, mid and late put it 2, 5 and 8
 * years in), a number written out ("forty-five", "thirty-something") or a baby's months, weeks or
 * days ("18 months": 1). Teens ("teenage", "late teens") and words such as "elderly" or "young" are
 * not read as an age: what they say is read from the words (humanKindOf).
 */
export function ageOf(text: string): number | null {
  const words = plainText(text)
    .replace(/(\d)\s*'?s\b/g, '$1 decade')
    .replace(/(\w)-?ish\b/g, '$1')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const part = words.map((w) => DECADE_PART[w]).find((v) => v !== undefined) ?? 0;
  for (const [i, w] of words.entries()) {
    let n: number | null = null;
    let decade = false;
    if (/^\d{1,3}$/.test(w)) {
      n = Number(w);
      decade = words[i + 1] === 'decade' || words[i + 1] === 'something';
    } else if (DECADE_WORDS[w] !== undefined) {
      n = DECADE_WORDS[w];
      decade = true;
    } else if (NUMBER_WORDS[w] !== undefined) {
      n = NUMBER_WORDS[w];
      const unit = NUMBER_WORDS[words[i + 1]];
      // "forty-five", "thirty-something"
      if (n >= 20 && unit !== undefined && unit < 10) n += unit;
      else if (n >= 20 && words[i + 1] === 'something') decade = true;
    }
    if (n === null) continue;
    const small = SMALL_UNITS.find(([re]) => words.slice(i + 1, i + 3).some((x) => re.test(x)));
    if (small) return Math.floor(n / small[1]);
    return decade ? n + part : n;
  }
  return null;
}

/** Words an age may have besides its number ("about 30", "early 30s", "45 years old"). */
const AGE_FILLER =
  /^(?:decade|early|mid|late|something|about|around|roughly|nearly|almost|just|over|under|past|approx|approximately|circa|ca|c|aged?|in|his|her|their|years?|yrs?|y|o|old|months?|mos?|weeks?|wks?|days?|and|a|half)$/;

/** Whether a text is an age and nothing else ("8", "early 30s", "thirty", "6 years old"; not "two dogs"). */
export function isAgeText(text: string): boolean {
  const words = plainText(text)
    .replace(/(\d)\s*'?s\b/g, '$1 decade')
    .replace(/(\w)-?ish\b/g, '$1')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return (
    ageOf(text) !== null &&
    words.every(
      (w) =>
        /^\d{1,3}$/.test(w) ||
        NUMBER_WORDS[w] !== undefined ||
        DECADE_WORDS[w] !== undefined ||
        AGE_FILLER.test(w),
    )
  );
}

/**
 * A person's kind from its words: its age (identity.age, else "<n>-year-old"; ageOf reads numbers,
 * decades and ages written out), else what its own words call it (toddler, child, elder), else its
 * gender (identity.gender, else its words), else adult.
 */
export function humanKindOf(c: Pick<RideoCharacterInput, 'name' | 'summary' | 'identity'>): ActorKind {
  const own = ownTexts(c);
  const fields = c.identity && typeof c.identity === 'object' ? c.identity : null;
  const ageField = typeof fields?.age === 'string' ? fields.age : '';
  let age = ageOf(ageField);
  for (const t of own) {
    if (age !== null) break;
    // "an eight-year-old", "a forty-five-year-old"
    const said = /\b(\d{1,3}|[a-z]+(?:-[a-z]+)?)[- ]?(?:years?|yrs?)[- ]?old\b/.exec(t);
    if (said) age = ageOf(said[1]);
  }
  if (age !== null) {
    if (age <= 3) return 'toddler';
    if (age <= 12) return 'child';
    if (age >= 65) return 'elder';
  } else {
    if (describes(own, /\b(toddler|baby|infant)\b/)) return 'toddler';
    if (describes(own, /\b(child|kid|girl|boy|schoolgirl|schoolboy|cub)\b/)) return 'child';
    if (
      describes(
        own,
        /\b(elderly|grandma|grandmother|grandpa|grandfather|granny|old (man|woman|lady)|senior)\b/,
      )
    )
      return 'elder';
  }
  const gender = typeof fields?.gender === 'string' ? plainText(fields.gender) : '';
  if (/\b(female|woman|she)\b/.test(gender)) return 'woman';
  if (/\b(male|man|he)\b/.test(gender)) return 'man';
  if (describes(own, /\b(woman|lady|girl|mother|mum|mom|aunt|sister|queen)\b/)) return 'woman';
  if (describes(own, /\b(man|gentleman|boy|father|dad|uncle|brother|king)\b/)) return 'man';
  return 'adult';
}

export interface KindEvidence {
  /** The character holds a prop in the blocking (heldBy). */
  holds: boolean;
  /** One of its marks uses a pose only people take (reach, point, wave: PERSON_POSES). */
  personPose: boolean;
  /** Another character rides it (said by a shot's text). */
  ridden: boolean;
  /** It rides another character (said by a shot's text): a rider is a person, whatever animal it is. */
  rides: boolean;
}

/**
 * The actor kind of a character (spec §11): its override, else a quadruped when its own words make it
 * an animal and it is ridden, or does not act as a person (talk, hold things, dress, ride) nor hold
 * props or take a person's pose in the blocking; else a person (toddler, child, elder, man, woman or
 * adult). rideo's leads are often animals acting as people (pandas that fly kites, bear cubs that
 * ride ponies): they are people here.
 */
export function inferActorKind(
  c: Pick<RideoCharacterInput, 'name' | 'summary' | 'identity' | 'kind'>,
  evidence: KindEvidence,
  override?: ActorKind | null,
): { kind: ActorKind; reason: string } {
  if (override) return { kind: override, reason: 'cast override' };
  if (c.kind) return { kind: c.kind, reason: "the character's kind" };
  const species = speciesOf(c);
  if (species) {
    if (evidence.ridden) return { kind: species, reason: `a ${species} another character rides` };
    if (evidence.rides) return { kind: humanKindOf(c), reason: `a ${species} that rides: a person` };
    if (evidence.holds) return { kind: humanKindOf(c), reason: `a ${species} that holds a prop: a person` };
    if (evidence.personPose)
      return { kind: humanKindOf(c), reason: `a ${species} in a person's pose: a person` };
    if (actsAsPerson(c)) return { kind: humanKindOf(c), reason: `a ${species} that acts as a person` };
    return { kind: species, reason: `a ${species}` };
  }
  return { kind: humanKindOf(c), reason: 'a person' };
}

export const isHumanoid = (kind: ActorKind): boolean => HUMANOID_KINDS.includes(kind);
export const isRideable = (kind: ActorKind): boolean => RIDEABLE_KINDS.includes(kind);

// ---------------------------------------------------------------- riding

/*
 * Who rides whom is read from a shot's words, never from an animal's gait: "Clover trots over to
 * Rosie" or "Rosie watches Clover gallop" say nothing of a rider. A rider is the subject of a rider
 * verb ("rides", "riding", "on horseback"), of a getting-on phrase whose object is the mount
 * ("climbs onto Pepper", "sits astride the pony"), or of a gait whose rider sits "on" the mount ("Rosie
 * gallops off on her pony"); "Pepper, ridden by Rosie" names it after the mount. A verb that is
 * denied or not yet done ("never rides", "wants to ride", "after the ride") says nothing, and one
 * whose subject is busy with something else ("Rosie watches the farmer ride by") says nobody of the
 * cast rides.
 */

/** Rider verbs: their subject rides, the mount their object when one is named. */
const RIDES = /\b(?:rides?|riding|rode|on horseback|in the saddle|bareback)\b/g;
/** Getting-on and sitting phrases: their subject rides the mount they name (or "him", "her", "it"). */
const RIDES_ON =
  /\b(?:astride|mounted (?:on|upon)|mounts|mounting|on (?:the )?back of|(?:sits?|sitting|sat|seated|perched) (?:up )?(?:on|upon|astride)|(?:climbs?|climbing|climbed|clambers?|clambering|clambered|gets?|getting|got|hops?|hopping|hopped|jumps?|jumping|jumped|swings?|swinging|swung|lifted|lifts?) (?:back )?(?:up )?(?:onto|on to|on|upon))\b/g;
/** The passive: the rider follows "by". */
const RIDDEN_BY = /\bridden by\b/g;
/** Gaits and goings whose subject rides when they go "on" a mount ("trots along on her pony"). */
const GOES =
  /\b(?:gallop\w*|trot\w*|canter\w*|walk\w*|ambl\w*|plod\w*|head(?:s|ed|ing)?|arriv\w*|cross(?:es|ed|ing)?|com(?:e|es|ing)|go(?:es|ing)?|went|rac(?:e|es|ed|ing)|charg\w*|leap\w*|splash\w*|wad(?:e|es|ed|ing)|return\w*|wander\w*|parad\w*|circl\w*|sets? off|setting off)\b/g;
/** Words just before a rider verb that deny it or put it outside the shot ("never rides", "wants to ride"). */
const NOT_NOW =
  /(?:n't|\b(?:not|never|no longer|cannot|wants? to|wanted to|loves? to|loved to|likes? to|liked to|hopes? to|hoped to|learns? to|learning to|learned to|ready to|about to|going to|afraid to|scared to|refuses? to|refused to|asks? to|asked to|begs? to|begged to|dreams? of|dreaming of|instead of|without|before|after|stops?|stopped))\s+(?:\w+\s+)?$/;
/** Words before "ride(s)" that make it a noun ("after the ride", "pony rides"). */
const RIDE_NOUN =
  /\b(?:a|an|the|her|his|their|its|my|our|your|this|that|first|next|last|long|short|bumpy|whole|pony|horse|donkey)\s+$/;
/**
 * Words that say a person is busy with someone otherwise than riding (watching, feeding, brushing,
 * leading, beside them): between a person and a rider verb, the rider is someone else; in a sentence
 * naming a person and a mount, the person does not ride it (whatever their marks say).
 */
const BUSY =
  /\b(?:watch(?:es|ing|ed)?|looks? (?:at|on)|looking (?:at|on)|looked (?:at|on)|sees?|seeing|saw|feeds?|feeding|fed|brush(?:es|ing|ed)?|grooms?|grooming|groomed|leads?|leading|led|pats?|patting|patted|strokes?|stroking|stroked|hugs?|hugging|hugged|holds? out|holding out|held out|offers?|offering|offered|gives?|giving|gave|chases?|chasing|chased|follows?|following|followed|calls?|calling|called|waves? (?:at|to)|waving (?:at|to)|waved (?:at|to)|waits? for|waiting for|waited for|beside|next to|alongside|behind|in front of|saddles?|saddling|saddled|unsaddles?|ties?|tying|tied|washes|washing|washed|cheers?|cheering|cheered|claps?|clapping|clapped|helps?|helping|helped|teaches|teaching|taught|tells?|telling|told|puts?|putting|places?|placing|placed|lays?|laying|laid|leans?|leaning|leaned)\b/;
/** Where a clause ends: what comes after is about something else. */
const CLAUSE_END =
  /,|\band\b|\bbut\b|\bwhile\b|\bas\b|\bthen\b|\bwho\b|\bwhich\b|\bwhen\b|\bwhere\b|\bbefore\b|\bafter\b/;
/** Words between a rider verb and a mount that make the mount something else than what is ridden ("rides past Pepper"). */
const NOT_OBJECT =
  /^(?:past|to|towards?|toward|around|round|beside|alongside|next|near|nearby|behind|after|away|from|by|into|through|across|over|under|along|with|without|up|down|off|out|at|for|of|in|is|are|was|were|than|like)$/;
/** A pronoun object: the mount is the one named before ("walks up to Pepper and climbs onto him"). */
const PRONOUN = /^\s*(?:him|her|it|them)\b(?!\s*'s)/;

interface Mention {
  id: string;
  at: number;
  end: number;
  /** "Rosie's pony": a possessive, not the one who does anything. */
  possessive: boolean;
}

const nameRe = (n: string) => new RegExp(`\\b${escapeRe(plainText(n).trim())}\\b`, 'g');
const kindWord = (k: ActorKind) =>
  k === 'horse'
    ? /\b(?:horses?|stallions?|mares?|mount|steed)\b/g
    : k === 'pony'
      ? /\b(?:pony|ponies|mount)\b/g
      : k === 'donkey'
        ? /\b(?:donkeys?|mules?|mount)\b/g
        : /\b(?:cows?|bulls?|ox|mount)\b/g;

/** Where the words of a sentence name a character (by name, or a mount by its kind's word), in order. */
function mentions(s: string, chars: readonly { id: string; name: string; kind?: ActorKind }[]): Mention[] {
  const out: Mention[] = [];
  for (const c of chars) {
    const res = [c.name.trim() ? nameRe(c.name) : null, c.kind ? kindWord(c.kind) : null];
    for (const re of res) {
      if (!re) continue;
      for (let m = re.exec(s); m; m = re.exec(s))
        out.push({
          id: c.id,
          at: m.index,
          end: m.index + m[0].length,
          possessive: /^'s\b/.test(s.slice(m.index + m[0].length)),
        });
    }
  }
  return out.sort((a, b) => a.at - b.at || b.end - a.end);
}

/** A rider word of a sentence: where it is, and which way it names its rider and mount. */
interface RiderWord {
  at: number;
  end: number;
  /** 'rides': object optional; 'on': object required; 'by': the rider follows; 'goes': "on" a mount follows. */
  form: 'rides' | 'on' | 'by' | 'goes';
}

function riderWords(s: string): RiderWord[] {
  const out: RiderWord[] = [];
  const add = (re: RegExp, form: RiderWord['form']) => {
    re.lastIndex = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) out.push({ at: m.index, end: m.index + m[0].length, form });
  };
  add(RIDDEN_BY, 'by');
  add(RIDES_ON, 'on');
  add(RIDES, 'rides');
  add(GOES, 'goes');
  // "ride" as a noun says nothing ("after the ride"), but "a ride on Pepper" does
  return out
    .flatMap((w): RiderWord[] => {
      if (w.form !== 'rides' || !/^rides?$/.test(s.slice(w.at, w.end))) return [w];
      if (!RIDE_NOUN.test(s.slice(0, w.at))) return [w];
      return /^\s+on\b/.test(s.slice(w.end)) ? [{ ...w, form: 'on' }] : [];
    })
    .sort((a, b) => a.at - b.at);
}

/** Words before a mount that make it what is ridden: "on", "onto", "the back of" and up to two words more. */
const ON_IT = /\b(?:on|upon|onto|atop|back of)\s+(?:\S+\s+){0,2}$/;

/** Whether a mention names the mount itself ("Pepper", "Pepper's back"), not a part of it ("Pepper's neck"). */
const itself = (s: string, m: Mention) => !m.possessive || /^'s back\b/.test(s.slice(m.end));

/**
 * The mount a rider word names as its object: the first mount named right after it, through
 * determiners and adjectives only, or after "on", "onto" or "the back of" in its clause ("him", "her",
 * "it": the mount named last before it). 'other' when the mount named after it is not what is ridden
 * ("rides past Pepper"), null when it names none. A going ("trots along") names one only "on" it.
 */
function objectOf(s: string, w: RiderWord, mounts: readonly Mention[]): string | 'other' | null {
  const rest = s.slice(w.end);
  const stop = CLAUSE_END.exec(rest);
  const clauseEnd = w.end + (stop ? stop.index : rest.length);
  const after = mounts.filter((m) => m.at >= w.end && m.at < clauseEnd);
  for (const m of after) {
    const gap = s.slice(w.end, m.at);
    if (ON_IT.test(gap)) return itself(s, m) ? m.id : 'other';
    if (w.form === 'goes') continue;
    if (/^\s*$/.test(gap)) return itself(s, m) ? m.id : 'other';
    const words = gap.trim().split(/\s+/);
    if (words.length <= 3 && !words.some((x) => NOT_OBJECT.test(x))) return itself(s, m) ? m.id : 'other';
  }
  if (w.form !== 'goes' && PRONOUN.test(rest)) {
    const before = mounts.filter((m) => m.end <= w.at);
    if (before.length) return before[before.length - 1].id;
  }
  return after.length && w.form !== 'goes' ? 'other' : null;
}

/** A subject that names nobody: a pronoun, or none ("They ride away", "Riding along the fence"). */
const NO_SUBJECT = /^\s*(?:(?:they|she|he|both|together|then|now|soon|finally|\w+ly)\s+)*$/;

/**
 * Who rides whom by a shot's text (its description and action): the subject of a rider word (a
 * person of the shot named before it, or after it when it opens the sentence) on the mount it names
 * (by name, or its kind's word: "her pony"), or on the shot's only mount when it names none; with a
 * single person and a single mount in the shot, a rider word whose subject is a pronoun or none
 * ("They ride away") seats the one on the other. Gaits alone never seat anyone (see above).
 */
export function ridersByText(
  text: string,
  people: readonly { id: string; name: string }[],
  mounts: readonly { id: string; name: string; kind: ActorKind }[],
): { rider: string; mount: string }[] {
  const out: { rider: string; mount: string }[] = [];
  if (!people.length || !mounts.length) return out;
  const taken = new Set<string>();
  const pair = (rider: string | null, mount: string | null) => {
    if (!rider || !mount || taken.has(rider) || taken.has(mount)) return;
    out.push({ rider, mount });
    taken.add(rider);
    taken.add(mount);
  };
  const onlyMount = () => {
    const free = mounts.filter((m) => !taken.has(m.id));
    return free.length === 1 ? free[0].id : null;
  };
  for (const s of sentences(plainText(text))) {
    const who = mentions(s, people);
    const steeds = mentions(s, mounts);
    for (const w of riderWords(s)) {
      if (w.form === 'by') {
        const rider = who.find((m) => m.at >= w.end && !m.possessive)?.id ?? null;
        const before = steeds.filter((m) => m.end <= w.at);
        pair(rider, before.length ? before[before.length - 1].id : onlyMount());
        continue;
      }
      const lead = s.slice(0, w.at);
      if (NOT_NOW.test(lead)) continue;
      const object = objectOf(s, w, steeds);
      if (object === 'other') continue;
      // a going, or getting on, rides only the mount it names
      if ((w.form === 'goes' || w.form === 'on') && !object && !PRONOUN.test(s.slice(w.end))) continue;
      const mount = object ?? onlyMount();
      // the subject: the person named last before the word (after it when it opens the sentence)
      const before = who.filter((m) => m.end <= w.at);
      let subject: Mention | null = before.length ? before[before.length - 1] : null;
      if (!subject && /^\s*(?:\w+ly\s+)?$/.test(lead))
        subject = who.find((m) => m.at >= w.end && !m.possessive) ?? null;
      if (subject) {
        // someone's relative, or a person busy with something else, is not the rider
        if (subject.possessive) continue;
        const clauses = s.slice(subject.end, w.at).split(CLAUSE_END);
        if (BUSY.test(clauses[clauses.length - 1])) continue;
        pair(subject.id, mount);
      } else {
        const clauses = lead.split(CLAUSE_END);
        if (people.length === 1 && mounts.length === 1 && NO_SUBJECT.test(clauses[clauses.length - 1]))
          pair(people[0].id, mount);
      }
    }
  }
  return out;
}

/**
 * Whether a shot's words say a person is busy with a mount otherwise than riding it ("Rosie brushes
 * Pepper", "stands next to her pony"): a sentence that names both and says so, with no rider word.
 */
export function ridingDenied(
  text: string,
  person: { name: string },
  mount: { name: string; kind: ActorKind },
): boolean {
  if (!person.name.trim()) return false;
  const p = { id: 'p', name: person.name };
  const m = { id: 'm', name: mount.name, kind: mount.kind };
  for (const s of sentences(plainText(text))) {
    if (!nameRe(person.name).test(s)) continue;
    const named = (mount.name.trim() && nameRe(mount.name).test(s)) || kindWord(mount.kind).test(s);
    if (!named || ridersByText(s, [p], [m]).length) continue;
    if (BUSY.test(s)) return true;
  }
  return false;
}

/** A person's mark this close to a mount's (m) seats them on it (rideo's riders stand beside their ponies). */
export const MOUNT_DISTANCE_M = 0.6;

// ---------------------------------------------------------------- holding

/*
 * Who holds what by a shot's words, read like riding: the subject of a holding word (a character of
 * the shot named before it, or after it when it opens the sentence: "Holding the kite, Mira runs")
 * holds the prop it names right after it, through determiners and adjectives only ("carries the big
 * red box", "runs across the meadow with the kite", "a girl with a balloon"). A word that is denied
 * or not yet done ("never carries", "wants to hold") says nothing, nor does one whose object is not a
 * prop of the shot ("walks with Pip").
 */

/** Holding words: their subject holds the prop they name. */
const HOLDS =
  /\b(?:holds?|holding|held|carr(?:y|ies|ying|ied)|grips?|gripping|gripped|clutch(?:es|ing|ed)?|cradl(?:e|es|ing|ed)|brandish(?:es|ing|ed)?|wields?|wielding|wielded|flies|flying|flew|fly|tows?|towing|towed|tugs? (?:at|on)|tugging (?:at|on)|picks? up|picking up|picked up|lifts?|lifting|lifted|raises?|raising|raised|grabs?|grabbing|grabbed|takes?|taking|took|swings?|swinging|swung|waves?|waving|waved|with)\b/g;

/**
 * Who holds which prop by a shot's text (see above): pairs of a character of `cast` and a prop of
 * `props` (named by its name or one of its `words`, plurals included), each prop held by the first
 * character the text says holds it.
 */
export function holdersByText(
  text: string,
  cast: readonly { id: string; name: string }[],
  props: readonly { id: string; name: string; words?: readonly string[] }[],
): { holder: string; prop: string }[] {
  const out: { holder: string; prop: string }[] = [];
  if (!cast.length || !props.length) return out;
  const named = (p: (typeof props)[number]) =>
    [p.name, ...(p.words ?? [])].map((w) => plainText(w).trim()).filter((w) => w.length >= 2);
  const held = new Set<string>();
  for (const s of sentences(plainText(text))) {
    const who = mentions(s, cast);
    const things: Mention[] = [];
    for (const p of props)
      for (const w of named(p)) {
        const re = new RegExp(`\\b${escapeRe(w)}(?:s|es)?\\b`, 'g');
        for (let m = re.exec(s); m; m = re.exec(s))
          things.push({ id: p.id, at: m.index, end: m.index + m[0].length, possessive: false });
      }
    things.sort((a, b) => a.at - b.at || b.end - a.end);
    HOLDS.lastIndex = 0;
    for (let v = HOLDS.exec(s); v; v = HOLDS.exec(s)) {
      const lead = s.slice(0, v.index);
      if (NOT_NOW.test(lead)) continue;
      const end = v.index + v[0].length;
      // the prop it names: the first one after it in its clause, through two words at most that are
      // not prepositions ("the big red box", not "past the box")
      const rest = s.slice(end);
      const stop = CLAUSE_END.exec(rest);
      const clauseEnd = end + (stop ? stop.index : rest.length);
      const object = things.find((t) => {
        if (t.at < end || t.at >= clauseEnd) return false;
        const gap = s.slice(end, t.at).trim();
        const words = gap ? gap.split(/\s+/) : [];
        return words.length <= 3 && !words.some((x) => NOT_OBJECT.test(x));
      });
      if (!object || held.has(object.id)) continue;
      // the subject: the character named last before the word (after it when it opens the sentence)
      const before = who.filter((m) => m.end <= v!.index && !m.possessive);
      let subject: Mention | null = before.length ? before[before.length - 1] : null;
      if (!subject && /^\s*(?:\w+ly\s+)?$/.test(lead))
        subject = who.find((m) => m.at >= object.end && !m.possessive) ?? null;
      if (!subject) continue;
      out.push({ holder: subject.id, prop: object.id });
      held.add(object.id);
    }
  }
  return out;
}

// ---------------------------------------------------------------- camera moves

const PANS = /\bpan(?:s|ned|ning)?\b/;
const ORBITS = /\borbit(?:s|ed|ing)?\b/;
const TILTS = /\btilt(?:s|ed|ing)?\b/;

/**
 * Which way a camera move goes by its words (`a` or `b`; null when its sentence says neither): in the
 * first sentence where `verb` names the move, where it goes to ("from left to right", "to the
 * right", "rightwards", "pans right"), else the other way from where it starts ("from the left").
 */
export function directionOf(text: string, verb: RegExp, a: string, b: string): string | null {
  const dir = `(${a}|${b})`;
  const other = (d: string) => (d === a ? b : a);
  for (const s of sentences(text)) {
    const v = verb.exec(s);
    if (!v) continue;
    const rest = s.slice(v.index + v[0].length);
    const to = new RegExp(
      `\\b(?:to|towards?|toward|round to|over to)\\s+(?:the\\s+)?(?:(?:camera|frame|screen)[\\s-]+)?${dir}\\b`,
    ).exec(rest);
    if (to) return to[1];
    const ward = new RegExp(`\\b${dir}wards?\\b`).exec(rest);
    if (ward) return ward[1];
    const first = new RegExp(`\\b${dir}\\b`).exec(rest);
    if (!first) continue;
    const from = /\bfrom\s+(?:the\s+)?(?:(?:camera|frame|screen)[\s-]+)?$/.test(rest.slice(0, first.index));
    return from ? other(first[1]) : first[1];
  }
  return null;
}

/** The move a shot's planned movement asks for when it names no move of the library. */
export function moveOfMovement(movement: RideoMovement, text: string): DeskMove {
  const t = plainText(text);
  switch (movement) {
    case 'static':
      return 'locked_off';
    case 'dolly_in':
      return 'push_in';
    case 'dolly_out':
      return 'pull_out';
    case 'tracking':
      return 'tracking_follow';
    case 'handheld':
      return 'handheld';
    case 'crane':
      return /\b(crane(s|d)? down|descend(s|ing)?|lower(s|ing)?)\b/.test(t) ? 'crane_down' : 'crane_up';
    case 'orbit':
      // "anti-clockwise" and "counter-clockwise" contain "clockwise": they are tested first
      if (/\b(?:anti|counter)[- ]?clockwise\b/.test(t)) return 'orbit_left';
      if (/\bclockwise\b/.test(t)) return 'orbit_right';
      return directionOf(t, ORBITS, 'left', 'right') === 'right' ? 'orbit_right' : 'orbit_left';
    case 'pan':
      return directionOf(t, PANS, 'left', 'right') === 'left' ? 'pan_left' : 'pan_right';
    case 'tilt':
      return directionOf(t, TILTS, 'up', 'down') === 'down' ? 'tilt_down' : 'tilt_up';
    case 'zoom':
      return /\bzoom(s|ing)? out\b/.test(t) ? 'pull_out' : 'push_in';
  }
}

/** Whether a pan's text names its direction (else the import pans the way the action goes). */
export const panDirectionSaid = (text: string): boolean =>
  directionOf(plainText(text), PANS, 'left', 'right') !== null;

/** The shot's text: description and action. */
export const shotText = (s: Pick<RideoShotInput, 'description' | 'action'>): string =>
  [s.description, s.action].filter(Boolean).join('. ');

// ---------------------------------------------------------------- poses

/** The editor pose an actor of `kind` takes for a rideo pose. */
export function editorPose(pose: RideoBlockingPose, kind: ActorKind): string {
  if (isHumanoid(kind)) return pose;
  switch (pose) {
    case 'walk':
      return 'walk';
    case 'run':
      return 'gallop';
    case 'sit':
      return 'sit';
    case 'crouch':
    case 'kneel':
    case 'lie':
      return 'lie';
    default:
      return 'stand';
  }
}

/** The rideo pose nearest an editor pose (people's and animals'). */
export function rideoPose(pose: string): RideoBlockingPose {
  switch (pose) {
    case 'walk':
    case 'trot':
      return 'walk';
    case 'run':
    case 'gallop':
      return 'run';
    case 'sit':
    case 'sit_ground':
    case 'ride':
      return 'sit';
    case 'crouch':
    case 'eat':
      return 'crouch';
    case 'kneel':
      return 'kneel';
    case 'lie':
      return 'lie';
    case 'reach':
    case 'throw':
      return 'reach';
    case 'point':
      return 'point';
    case 'wave':
      return 'wave';
    default:
      return 'stand';
  }
}

/** rideo poses only a person takes (an animal may crouch, kneel or lie down). */
export const PERSON_POSES: ReadonlySet<RideoBlockingPose> = new Set(['reach', 'point', 'wave']);

// ---------------------------------------------------------------- props and landmarks

/** A prop that flies on a string when someone holds it. */
export function flyerKind(text: string): 'kite' | 'balloon' | null {
  const t = plainText(text);
  if (/\bkites?\b/.test(t)) return 'kite';
  if (/\bballoons?\b/.test(t)) return 'balloon';
  return null;
}

/** Score a catalog match must reach to be taken (a name, synonym or tag of the label's head noun). */
export const MODEL_MATCH_SCORE = 20;

/**
 * The built-in model a label names (its words cleaned of possessives such as "Rosie's" and of the
 * cast's names), the best of the queries given; null when none matches well enough. People and
 * animals (actors) are never props or landmarks.
 */
export function modelFor(
  queries: readonly string[],
  o: { exclude?: readonly string[]; categories?: readonly CatalogEntry['category'][] } = {},
): { entry: CatalogEntry; score: number; query: string } | null {
  const names = (o.exclude ?? []).map((n) => plainText(n).trim()).filter(Boolean);
  let best: { entry: CatalogEntry; score: number; query: string } | null = null;
  for (const raw of queries) {
    let q = plainText(raw).replace(/\b[\p{L}\p{N}-]+'s\b/gu, ' ');
    for (const n of names) q = q.replace(new RegExp(`\\b${escapeRe(n)}\\b`, 'g'), ' ');
    q = q.replace(/\s+/g, ' ').trim();
    if (!q) continue;
    for (const r of rankCatalog(q)) {
      if (r.entry.rig === 'actor') continue;
      if (o.categories && !o.categories.includes(r.entry.category)) continue;
      if (r.score >= MODEL_MATCH_SCORE && (!best || r.score > best.score)) best = { ...r, query: q };
      break;
    }
  }
  return best;
}
