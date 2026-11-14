import { createHash } from 'node:crypto';
import { ToolError } from '../mcp/agent';
import type { ProviderModel, ProviderPage } from './providers/types';

/*
 * Merging the pages of several providers into one page, and the opaque cursor of the next page.
 *
 * Every provider returns up to `limit` results from its own offset, in its own order. The merge
 * takes, step by step, the next result of the provider whose next result scores best (relevance.ts;
 * ties go to the earlier provider in `order`, built-in models first), so each provider's results
 * stay in its order and the results taken from it are always a prefix of its page: its next offset
 * is exact. The cursor is base64url JSON {v: 1, k: <search key>, o: {<provider>: offset | null}}
 * (null: that provider has nothing more); the key ties it to the query, category and providers it
 * was made for.
 */

/** Offsets of the next page per provider (null: exhausted). */
export type CursorOffsets = Record<string, number | null>;

/** A short key of a search (what a cursor may only be used with). */
export function searchKey(query: string, category: string | null, providers: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([query.trim().toLowerCase(), category, [...providers].sort()]))
    .digest('base64url')
    .slice(0, 12);
}

export function encodeCursor(key: string, offsets: CursorOffsets): string {
  return Buffer.from(JSON.stringify({ v: 1, k: key, o: offsets })).toString('base64url');
}

/** The offsets of `cursor` (INVALID_PARAMS when it is malformed or belongs to another search). */
export function decodeCursor(cursor: string, key: string): CursorOffsets {
  let state: unknown;
  try {
    state = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ToolError(
      'invalid cursor: pass the next_cursor of the previous page unchanged',
      'INVALID_PARAMS',
    );
  }
  const s = state as { v?: unknown; k?: unknown; o?: unknown };
  if (!s || s.v !== 1 || typeof s.o !== 'object' || s.o === null || Array.isArray(s.o))
    throw new ToolError(
      'invalid cursor: pass the next_cursor of the previous page unchanged',
      'INVALID_PARAMS',
    );
  if (s.k !== key)
    throw new ToolError(
      'the cursor belongs to another search (query, category or providers changed): search again without cursor',
      'INVALID_PARAMS',
    );
  const out: CursorOffsets = {};
  for (const [id, v] of Object.entries(s.o as Record<string, unknown>)) {
    if (v === null) out[id] = null;
    else if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000) out[id] = v;
    else
      throw new ToolError(
        'invalid cursor: pass the next_cursor of the previous page unchanged',
        'INVALID_PARAMS',
      );
  }
  return out;
}

/**
 * Merges `pages` (by provider; providers without a page failed or were skipped and keep their
 * offset) into at most `limit` results. `order` lists the providers by tie precedence.
 */
export function mergePages(
  order: readonly string[],
  pages: ReadonlyMap<string, ProviderPage>,
  offsets: CursorOffsets,
  limit: number,
): { results: ProviderModel[]; offsets: CursorOffsets } {
  const taken = new Map<string, number>();
  const results: ProviderModel[] = [];
  const seen = new Set<string>();
  while (results.length < limit) {
    let best: string | null = null;
    let bestScore = -Infinity;
    for (const id of order) {
      const page = pages.get(id);
      const i = taken.get(id) ?? 0;
      if (!page || i >= page.hits.length) continue;
      if (page.hits[i].score > bestScore) {
        best = id;
        bestScore = page.hits[i].score;
      }
    }
    if (best === null) break;
    const i = taken.get(best) ?? 0;
    const model = pages.get(best)!.hits[i].model;
    taken.set(best, i + 1);
    // a model listed twice (an API's pages shifting under its cursor) is shown once
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    results.push(model);
  }
  const next: CursorOffsets = { ...offsets };
  for (const [id, page] of pages) {
    const k = taken.get(id) ?? 0;
    next[id] = k >= page.hits.length ? page.end : k > 0 ? page.hits[k - 1].next : (offsets[id] ?? 0);
  }
  return { results, offsets: next };
}
