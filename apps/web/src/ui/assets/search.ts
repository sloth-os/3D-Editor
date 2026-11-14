import { signal } from '@preact/signals';
import { BUILTIN_PROVIDER, searchCatalogPage, type StoreCategory, type StoreResult } from '@3d-editor/core';
import {
  ApiError,
  fetchStoreProviders,
  isAbort,
  searchStore,
  type StoreProviderStatus,
} from '../../io/store-client';

/*
 * The Asset Browser's search (SPEC §13): what was asked (words, category, provider), the results
 * so far, the cursor of the next page, and how each provider answered. Typing searches after a short
 * pause (debounced); a new search aborts the one before and its late answers are dropped. With the
 * editor server the server's store searches every provider (GET /api/store/search, opaque cursor);
 * without it (standalone) the built-in catalog of core is searched here, its cursor an offset.
 */

/** Results per page. */
export const PAGE_SIZE = 24;
/** Pause after the last key before a typed search starts. */
export const SEARCH_DEBOUNCE_MS = 250;

/** 'all', or a provider id. */
export type ProviderChoice = string;

export interface AssetQuery {
  text: string;
  category: StoreCategory | null;
  provider: ProviderChoice;
}

export interface SearchPage {
  results: StoreResult[];
  next: string | null;
  /** How the providers answered this page (server searches). */
  providers?: StoreProviderStatus[];
}

/** Where a search goes: the server's store, or the built-in catalog in this browser. */
export interface SearchBackend {
  readonly kind: 'server' | 'local';
  providers(signal: AbortSignal): Promise<StoreProviderStatus[]>;
  page(q: AssetQuery, cursor: string | null, signal: AbortSignal): Promise<SearchPage>;
}

/** The status of the built-in catalog searched in this browser. */
export const LOCAL_BUILTIN_STATUS: StoreProviderStatus = {
  id: BUILTIN_PROVIDER,
  name: 'Built-in models',
  enabled: true,
  status: 'ok',
  needs_key: null,
  message: 'searched in this editor (no editor server: the online providers need one)',
};

/** Searches the built-in catalog of core (the cursor is the next offset). */
export function localBackend(pageSize = PAGE_SIZE): SearchBackend {
  return {
    kind: 'local',
    providers: async () => [LOCAL_BUILTIN_STATUS],
    page: async (q, cursor) => {
      if (q.provider !== 'all' && q.provider !== BUILTIN_PROVIDER) return { results: [], next: null };
      const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
      const page = searchCatalogPage(q.text, { category: q.category, limit: pageSize, offset });
      const end = offset + page.results.length;
      return { results: page.results, next: end < page.total ? String(end) : null };
    },
  };
}

/** Searches the editor server's model store. */
export function serverBackend(pageSize = PAGE_SIZE): SearchBackend {
  return {
    kind: 'server',
    providers: (signal) => fetchStoreProviders(signal),
    page: async (q, cursor, signal) => {
      const page = await searchStore(
        {
          query: q.text,
          category: q.category,
          providers: q.provider === 'all' ? undefined : [q.provider],
          limit: pageSize,
          cursor,
        },
        signal,
      );
      return { results: page.results, next: page.next_cursor, providers: page.providers };
    },
  };
}

/** Two queries ask the same thing (the words compared trimmed). */
export function sameQuery(a: AssetQuery | null, b: AssetQuery | null): boolean {
  return (
    !!a && !!b && a.text.trim() === b.text.trim() && a.category === b.category && a.provider === b.provider
  );
}

const messageOf = (err: unknown) =>
  err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);

export class AssetSearch {
  /** The results so far (pages appended, each model once). */
  readonly results = signal<StoreResult[]>([]);
  /** Cursor of the next page (null: no more). */
  readonly next = signal<string | null>(null);
  readonly loading = signal(false);
  /** Why the last page failed (null: it did not). */
  readonly error = signal<string | null>(null);
  /** How each provider answered last, configured ones first. */
  readonly statuses = signal<StoreProviderStatus[]>([]);
  /** The query of the results shown (null before the first search). */
  readonly query = signal<AssetQuery | null>(null);

  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private statusController: AbortController | null = null;

  constructor(readonly backend: SearchBackend) {}

  /** Asks the backend how its providers are (on opening the browser). */
  async loadProviders(): Promise<void> {
    this.statusController?.abort();
    const ctrl = new AbortController();
    this.statusController = ctrl;
    try {
      const list = await this.backend.providers(ctrl.signal);
      if (!ctrl.signal.aborted) this.statuses.value = list;
    } catch (err) {
      // the search itself reports an unreachable server
      if (!isAbort(err) && !ctrl.signal.aborted && !this.statuses.value.length) this.statuses.value = [];
    }
  }

  /**
   * Searches for `q`: at once, or after SEARCH_DEBOUNCE_MS without another request (typing). A
   * request for what is already shown does nothing unless `force`.
   */
  request(q: AssetQuery, opts: { immediate?: boolean; force?: boolean } = {}): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!opts.force && sameQuery(q, this.query.value) && !this.error.value) return;
    if (opts.immediate) {
      void this.run(q);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run(q);
    }, SEARCH_DEBOUNCE_MS);
  }

  /** Starts a new search for `q` (the one before is aborted), its first page. */
  async run(q: AssetQuery): Promise<void> {
    this.controller?.abort();
    const ctrl = new AbortController();
    this.controller = ctrl;
    this.query.value = { ...q, text: q.text.trim() };
    this.results.value = [];
    this.next.value = null;
    this.error.value = null;
    await this.fetchPage(ctrl, null, true);
  }

  /** Loads the next page of the current search (nothing while one loads, after a failure or at the end). */
  async more(): Promise<void> {
    const q = this.query.value;
    const cursor = this.next.value;
    if (!q || !cursor || this.loading.value || this.error.value) return;
    const ctrl = new AbortController();
    this.controller = ctrl;
    await this.fetchPage(ctrl, cursor, false);
  }

  /** Asks again for what failed (the first page, or the page after the results shown). */
  async retry(): Promise<void> {
    const q = this.query.value;
    if (!q) return;
    if (!this.results.value.length) return this.run(q);
    this.error.value = null;
    return this.more();
  }

  private async fetchPage(ctrl: AbortController, cursor: string | null, first: boolean): Promise<void> {
    const q = this.query.value!;
    this.loading.value = true;
    try {
      const page = await this.backend.page(q, cursor, ctrl.signal);
      if (ctrl.signal.aborted || this.controller !== ctrl) return;
      const seen = new Set(first ? [] : this.results.value.map((r) => r.id));
      const fresh = page.results.filter((r) => !seen.has(r.id) && seen.add(r.id));
      this.results.value = first ? fresh : [...this.results.value, ...fresh];
      this.next.value = page.next;
      if (page.providers?.length) this.mergeStatuses(page.providers);
    } catch (err) {
      if (isAbort(err) || ctrl.signal.aborted || this.controller !== ctrl) return;
      this.error.value = messageOf(err);
    } finally {
      if (this.controller === ctrl) {
        this.loading.value = false;
        this.controller = null;
      }
    }
  }

  /** Updates the providers a page reports on, keeping the others. */
  private mergeStatuses(list: StoreProviderStatus[]): void {
    const byId = new Map(list.map((p) => [p.id, p]));
    const merged = this.statuses.value.map((p) => byId.get(p.id) ?? p);
    for (const p of list) if (!merged.some((m) => m.id === p.id)) merged.push(p);
    this.statuses.value = merged;
  }

  /** Stops whatever runs (the browser was closed). */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    this.statusController?.abort();
    this.statusController = null;
    this.loading.value = false;
  }
}
