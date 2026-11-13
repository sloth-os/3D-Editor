import type { CatalogEntry, StoreCategory, StoreResult } from './types';
import { BUILTIN_CATALOG, builtinResult } from './catalog';

/*
 * Keyword search of the built-in catalog (CATALOG owns this module): every word of the query is
 * matched against the words of a model's name and id, synonyms, tags, category and description,
 * the best field counting (name 10, synonyms 8, tags 6, category 4, description 1.5; a word that only
 * starts a model's word counts half). A word of a synonym or tag of several words ('people carrier',
 * 'light truck') counts as little as a description word unless the query holds the whole phrase.
 * The query's last word, in English usually its noun ('red couch', 'kitchen chair'), counts one and
 * a half times. Plurals match singulars (simple stemming: chairs, boxes, berries, shelves, knives;
 * and the irregular men, women, children, people, feet, teeth, mice, geese). A query that is a
 * model's whole name, id or synonym, that names part of its name, or that every word of matches,
 * ranks higher. Ties go to the usual model of a generic noun (a sedan for 'car', a soccer ball for
 * 'ball': CANONICAL), then by name. Words are split at anything but letters and digits of any
 * script, accents folded. An empty query lists every model by name; a query with no word to search
 * (only stop words, punctuation or emoji) finds nothing.
 */

export interface CatalogSearchOptions {
  category?: StoreCategory | null;
  /** Most results (default 20). */
  limit?: number;
  /** Results to skip (paging). */
  offset?: number;
}

/** Words a query ignores. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'of',
  'with',
  'and',
  'or',
  'for',
  'in',
  'on',
  'to',
  'at',
  'some',
  'my',
  'is',
]);

const WEIGHT = { name: 10, synonym: 8, tag: 6, category: 4, description: 1.5 } as const;
/** Weight of one word of a synonym or tag of several words (the whole phrase weighs the field's). */
const PHRASE_WORD = WEIGHT.description;
/** Share of a field's weight when a query word only starts one of its words. */
const PREFIX_SHARE = 0.5;
/** Bonus when the whole query is the model's name / one of its synonyms / names part of it. */
const NAME_PHRASE = 25;
const SYNONYM_PHRASE = 20;
const PARTIAL_PHRASE = 8;
/** Bonus when every word of the query matched. */
const ALL_WORDS = 10;
/** Factor of the query's last word (its head noun, as a rule). */
const HEAD_SHARE = 1.5;

/** Lower-case words of a text: accents folded, split at anything but letters and digits (any script). */
export function searchWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Plurals no ending rule finds, with their singular. */
const IRREGULAR: Readonly<Record<string, string>> = {
  men: 'man',
  women: 'woman',
  children: 'child',
  people: 'person',
  feet: 'foot',
  teeth: 'tooth',
  mice: 'mouse',
  geese: 'goose',
  oxen: 'ox',
  dice: 'die',
  cacti: 'cactus',
};

/**
 * The forms a word may stand for, itself first: its singular candidates when it looks plural
 * (chairs → chair, boxes → box, berries → berry, shelves → shelf, knives → knife, men → man).
 * Other short words have no other forms. Index words and query words both expand, so 'book' finds
 * 'books' and back.
 */
export function wordForms(w: string): string[] {
  const out = [w];
  const irregular = IRREGULAR[w];
  if (irregular) out.push(irregular);
  if (w.length < 4) return out;
  if (w.endsWith("'s")) out.push(w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss')) out.push(w.slice(0, -1));
  if (w.endsWith('es')) out.push(w.slice(0, -2));
  if (w.endsWith('ies') && w.length > 4) out.push(`${w.slice(0, -3)}y`);
  if (w.endsWith('ves') && w.length > 4) out.push(`${w.slice(0, -3)}f`, `${w.slice(0, -3)}fe`);
  return out;
}

interface EntryIndex {
  /** Best field weight of each word form. */
  forms: Map<string, number>;
  /** Every indexed word with its field weight (for prefix matches). */
  words: [string, number][];
  /** Words of the name and of the id (phrase matches). */
  names: string[][];
  synonyms: string[][];
  /** Synonyms and tags of several words, with the weight a query holding them gives their words. */
  phrases: { words: string[]; weight: number }[];
}

const indexes = new WeakMap<CatalogEntry, EntryIndex>();

function entryIndex(e: CatalogEntry): EntryIndex {
  let ix = indexes.get(e);
  if (ix) return ix;
  const forms = new Map<string, number>();
  const words = new Map<string, number>();
  const phrases: EntryIndex['phrases'] = [];
  const add = (text: string, weight: number) => {
    for (const w of searchWords(text)) {
      if (STOP_WORDS.has(w)) continue;
      if ((words.get(w) ?? 0) < weight) words.set(w, weight);
      for (const f of wordForms(w)) if ((forms.get(f) ?? 0) < weight) forms.set(f, weight);
    }
  };
  /** A synonym or tag: one word weighs the field's weight, the words of a phrase each a little. */
  const addTerm = (text: string, weight: number) => {
    const ws = searchWords(text).filter((w) => !STOP_WORDS.has(w));
    if (ws.length > 1) phrases.push({ words: ws, weight });
    add(text, ws.length > 1 ? PHRASE_WORD : weight);
  };
  add(e.name, WEIGHT.name);
  add(e.id, WEIGHT.name);
  for (const s of e.synonyms) addTerm(s, WEIGHT.synonym);
  for (const t of e.tags) addTerm(t, WEIGHT.tag);
  add(e.category, WEIGHT.category);
  add(e.description, WEIGHT.description);
  ix = {
    forms,
    words: [...words],
    names: [searchWords(e.name), searchWords(e.id)],
    synonyms: e.synonyms.map(searchWords),
    phrases,
  };
  indexes.set(e, ix);
  return ix;
}

/** Score of a query word against a model: its best field (exact form, else half for a prefix). */
function wordScore(ix: EntryIndex, word: string): number {
  let best = 0;
  for (const f of wordForms(word)) best = Math.max(best, ix.forms.get(f) ?? 0);
  if (best > 0 || word.length < 3) return best;
  for (const [w, weight] of ix.words) if (w.startsWith(word)) best = Math.max(best, weight * PREFIX_SHARE);
  return best;
}

/** Whether two words are the same up to plural endings ('chairs' and 'chair'). */
function sameWord(a: string, b: string): boolean {
  return a === b || wordForms(a).includes(b) || wordForms(b).includes(a);
}

/** Whether `words` holds the query's words in a row, from position `at`. */
function runAt(words: readonly string[], query: readonly string[], at: number): boolean {
  for (let i = 0; i < query.length; i++) if (!sameWord(words[at + i], query[i])) return false;
  return true;
}

function samePhrase(words: readonly string[], query: readonly string[]): boolean {
  return words.length === query.length && runAt(words, query, 0);
}

function holdsPhrase(words: readonly string[], query: readonly string[]): boolean {
  for (let at = 0; at + query.length <= words.length; at++) if (runAt(words, query, at)) return true;
  return false;
}

/** Score of a parsed query against a model (0: no word matched). */
function entryScore(e: CatalogEntry, words: readonly string[]): number {
  const ix = entryIndex(e);
  const scores = words.map((w) => wordScore(ix, w));
  // the words of a synonym or tag phrase the query holds weigh what the phrase weighs
  for (const p of ix.phrases)
    for (let at = 0; at + p.words.length <= words.length; at++)
      if (runAt(words, p.words, at))
        for (let i = at; i < at + p.words.length; i++) scores[i] = Math.max(scores[i], p.weight);
  let sum = 0;
  let matched = 0;
  scores.forEach((s, i) => {
    if (s > 0) {
      sum += i === words.length - 1 && words.length > 1 ? s * HEAD_SHARE : s;
      matched++;
    }
  });
  if (!matched) return 0;
  if (matched === words.length) sum += ALL_WORDS;
  if (ix.names.some((n) => samePhrase(n, words))) sum += NAME_PHRASE;
  else if (ix.synonyms.some((n) => samePhrase(n, words))) sum += SYNONYM_PHRASE;
  else if (words.length > 1 && ix.names.some((n) => holdsPhrase(n, words))) sum += PARTIAL_PHRASE;
  return sum;
}

function byName(a: CatalogEntry, b: CatalogEntry): number {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The usual model of generic nouns, first among models that score the same: a car is a sedan before
 * a hatchback or an SUV, a ball a soccer ball, a blanket a picnic blanket, a couch a sofa, a person
 * a person before a man or a woman.
 */
export const CANONICAL: readonly string[] = [
  'person',
  'sedan',
  'soccer_ball',
  'sofa',
  'picnic_blanket',
  'chair',
  'table',
  'oak_tree',
  'house',
  'rowboat',
  'dog',
  'horse',
];

function canonicalRank(e: CatalogEntry): number {
  const i = CANONICAL.indexOf(e.id);
  return i < 0 ? CANONICAL.length : i;
}

/** Ties: the canonical model first, then by name and id. */
function tieOrder(a: CatalogEntry, b: CatalogEntry): number {
  return canonicalRank(a) - canonicalRank(b) || byName(a, b);
}

/**
 * Every built-in model matching `query` with its score, best first (ties: the canonical model of a
 * generic noun first, then by name and id). An empty query gives every model with score 0, by name;
 * a query with nothing to search (stop words, punctuation, symbols) gives none.
 */
export function rankCatalog(
  query: string,
  opts: Pick<CatalogSearchOptions, 'category'> = {},
): { entry: CatalogEntry; score: number }[] {
  const pool = opts.category ? BUILTIN_CATALOG.filter((e) => e.category === opts.category) : BUILTIN_CATALOG;
  const words = searchWords(query).filter((w) => !STOP_WORDS.has(w));
  if (!words.length)
    return query.trim() ? [] : [...pool].sort(byName).map((entry) => ({ entry, score: 0 }));
  const out: { entry: CatalogEntry; score: number }[] = [];
  for (const entry of pool) {
    const score = entryScore(entry, words);
    if (score > 0) out.push({ entry, score });
  }
  return out.sort((a, b) => b.score - a.score || tieOrder(a.entry, b.entry));
}

function page(opts: CatalogSearchOptions): { offset: number; limit: number } {
  const offset = Number.isFinite(opts.offset) ? Math.max(0, Math.floor(opts.offset as number)) : 0;
  const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit as number)) : 20;
  return { offset, limit };
}

/** One page of the models matching `query` as store results, and how many match in all. */
export function searchCatalogPage(
  query: string,
  opts: CatalogSearchOptions = {},
): { results: StoreResult[]; total: number; entries: CatalogEntry[] } {
  const ranked = rankCatalog(query, opts);
  const { offset, limit } = page(opts);
  const entries = ranked.slice(offset, offset + limit).map((r) => r.entry);
  return { results: entries.map(builtinResult), total: ranked.length, entries };
}

/** Built-in models matching `query` (empty: all, by name; nothing to search: none), best first. */
export function searchCatalog(query: string, opts: CatalogSearchOptions = {}): StoreResult[] {
  return searchCatalogPage(query, opts).results;
}
