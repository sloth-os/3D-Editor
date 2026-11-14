/*
 * One relevance score for the results of every provider, so a search can merge them: each provider
 * keeps its own order (its own ranking, or its search engine's), and the merge picks, step by step,
 * the provider whose next result scores best (built-in models first on ties). The weights follow the
 * built-in catalog's search (name 10, synonyms 8, tags 6, category 4, description 1.5; a word that
 * only starts a model's word counts half; bonuses for the whole name and for matching every word).
 */

/** Lower-case words of a text (accents folded; split at anything but letters and digits). */
export function words(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Words ignored in queries. */
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
  '3d',
  'model',
  'models',
]);

/** The query's words (stop words dropped, unless nothing else is left). */
export function queryWords(query: string): string[] {
  const all = words(query);
  const kept = all.filter((w) => !STOP_WORDS.has(w));
  return kept.length ? kept : all;
}

/** A word and its singular candidates (chairs → chair, boxes → box, berries → berry, shelves → shelf). */
export function wordForms(w: string): string[] {
  const out = [w];
  if (w.length < 4) return out;
  if (w.endsWith('s') && !w.endsWith('ss')) out.push(w.slice(0, -1));
  if (w.endsWith('es')) out.push(w.slice(0, -2));
  if (w.endsWith('ies')) out.push(`${w.slice(0, -3)}y`);
  if (w.endsWith('ves')) out.push(`${w.slice(0, -3)}f`, `${w.slice(0, -3)}fe`);
  return out;
}

/** The text a provider knows of a model. */
export interface RelevanceFields {
  name: string;
  /** Alternative names (built-in synonyms). */
  synonyms?: readonly string[];
  tags?: readonly string[];
  category?: string | null;
  /** Description or summary. */
  description?: string | null;
}

const WEIGHT = { name: 10, synonym: 8, tag: 6, category: 4, description: 1.5 } as const;
const PREFIX_SHARE = 0.5;
const NAME_PHRASE = 25;
const ALL_WORDS = 10;

/**
 * Score of a model for the query words `q` (0: nothing matched; an empty query scores every model
 * 0, so providers keep their order and built-in models come first).
 */
export function relevance(q: readonly string[], f: RelevanceFields): number {
  if (!q.length) return 0;
  const forms = new Map<string, number>();
  const all: [string, number][] = [];
  const add = (text: string | null | undefined, weight: number) => {
    if (!text) return;
    for (const w of words(text)) {
      all.push([w, weight]);
      for (const form of wordForms(w)) if ((forms.get(form) ?? 0) < weight) forms.set(form, weight);
    }
  };
  add(f.name, WEIGHT.name);
  for (const s of f.synonyms ?? []) add(s, WEIGHT.synonym);
  for (const t of f.tags ?? []) add(t, WEIGHT.tag);
  add(f.category, WEIGHT.category);
  add(f.description, WEIGHT.description);
  let score = 0;
  let matched = 0;
  for (const w of q) {
    let best = 0;
    for (const form of wordForms(w)) best = Math.max(best, forms.get(form) ?? 0);
    if (!best && w.length >= 3)
      for (const [word, weight] of all) if (word.startsWith(w)) best = Math.max(best, weight * PREFIX_SHARE);
    if (best) matched++;
    score += best;
  }
  if (!score) return 0;
  if (matched === q.length) score += ALL_WORDS;
  if (words(f.name).join(' ') === q.join(' ')) score += NAME_PHRASE;
  return score;
}
