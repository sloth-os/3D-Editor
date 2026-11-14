import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import * as Y from 'yjs';
import { SceneDoc, builtinResult, getCatalogEntry, type StoreResult } from '@3d-editor/core';
import { updatePrefs } from '../src/app/prefs';
import { serverConfig, session as sessionSignal, toasts } from '../src/app/store';
import type { ServerConfig } from '../src/app/server-config';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import type { StoreProviderStatus } from '../src/io/store-client';
import { AssetBrowser, SHORT_BROWSER_PX, lastAssetQuery } from '../src/ui/assets/AssetBrowser';
import { ASSET_DRAG_TYPE } from '../src/ui/assets/drop';
import { SEARCH_DEBOUNCE_MS } from '../src/ui/assets/search';

/*
 * The Asset Browser: model cards (thumbnail, name, provider, licence badge with its credit),
 * debounced search words, category chips, a provider choice with each provider's state, thumbnails
 * fetched once their card shows, the next page once the end of the list shows, empty and error
 * states, cards dragged as application/x-3d-editor-asset and Add at the 3D cursor; without a server
 * the built-in catalog alone, searched in the browser.
 */

const SERVER: ServerConfig = {
  version: 'test',
  features: {
    sync: true,
    mcp: true,
    telemetry: false,
    webdavProxy: false,
    modelStore: true,
    videoExport: true,
  },
  webdav: null,
  persistence: 'memory',
};

/** IntersectionObserver whose intersections the test makes happen. */
class FakeIO {
  static all: FakeIO[] = [];
  readonly observed = new Set<Element>();
  constructor(private readonly cb: IntersectionObserverCallback) {
    FakeIO.all.push(this);
  }
  observe(el: Element) {
    this.observed.add(el);
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  disconnect() {
    this.observed.clear();
  }
  takeRecords() {
    return [];
  }
  /** Shows every observed element that matches `selector` (or contains a match). */
  static show(selector: string): number {
    let n = 0;
    for (const io of FakeIO.all)
      for (const el of [...io.observed])
        if (el.matches(selector) || el.querySelector(selector)) {
          n++;
          io.cb([{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry], io as never);
        }
    return n;
  }
}

const SHEEN: StoreResult = {
  id: 'khronos:SheenChair',
  provider: 'khronos',
  name: 'Sheen Chair',
  category: 'furniture',
  tags: [],
  thumbnail_url: '/api/store/models/khronos:SheenChair/thumbnail',
  license: { spdx: 'CC-BY-4.0', url: null, attribution: '“Sheen Chair” by Wayfair, CC BY 4.0' },
  author: 'Wayfair',
  source_url: 'https://github.com/KhronosGroup/glTF-Sample-Assets',
  dimensions_m: [0.6, 0.7, 0.9],
  triangles: 1000,
  formats: ['glb'],
  downloadable: true,
};
const CHAIR: StoreResult = {
  ...builtinResult(getCatalogEntry('chair')!),
  thumbnail_url: '/api/store/models/builtin:chair/thumbnail',
};

const PROVIDERS: StoreProviderStatus[] = [
  { id: 'builtin', name: 'Built-in models', enabled: true, status: 'ok', needs_key: null, message: null },
  {
    id: 'khronos',
    name: 'Khronos glTF sample models',
    enabled: true,
    status: 'ok',
    needs_key: null,
    message: null,
  },
  {
    id: 'polypizza',
    name: 'Poly Pizza',
    enabled: true,
    status: 'needs_key',
    needs_key: 'POLYPIZZA_API_KEY',
    message: 'set POLYPIZZA_API_KEY to use Poly Pizza',
  },
  {
    id: 'sketchfab',
    name: 'Sketchfab',
    enabled: true,
    status: 'error',
    needs_key: null,
    message: 'HTTP 500',
  },
  {
    id: 'catalog',
    name: 'Model catalogs',
    enabled: false,
    status: 'disabled',
    needs_key: null,
    message: null,
  },
];

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/** The searches the browser asked for (their query parameters). */
let searches: URLSearchParams[] = [];
/** What the next searches answer (by default: both chairs, no more pages). */
let answer: (p: URLSearchParams) => Response = () =>
  json({ results: [CHAIR, SHEEN], providers: [], next_cursor: null });
const fetchMock = vi.fn(async (url: string) => {
  const u = new URL(url, 'http://editor.test');
  if (u.pathname === '/api/store/providers') return json({ providers: PROVIDERS });
  if (u.pathname === '/api/store/search') {
    searches.push(u.searchParams);
    return answer(u.searchParams);
  }
  return json({ error: `unexpected ${url}` }, 404);
});

function fakeSession(): ProjectSession {
  const doc = SceneDoc.create({ empty: true });
  const undo = new Y.UndoManager(doc.sharedTypes(), {
    trackedOrigins: new Set([doc.origin]),
    captureTimeout: 0,
  });
  return {
    id: 'browser-test',
    doc,
    undo,
    state: new EditorStateSignals(),
    view: new ViewState(),
  } as unknown as ProjectSession;
}

const byTestId = (c: Element, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);

// happy-dom's elements lack the drag and double-click handler properties browsers have, so Preact
// would listen for 'DragStart' instead of 'dragstart': give them the browsers' properties
const HANDLERS = ['ondragstart', 'ondblclick'] as const;
beforeAll(() => {
  for (const h of HANDLERS)
    if (!(h in HTMLElement.prototype))
      Object.defineProperty(HTMLElement.prototype, h, { value: null, writable: true, configurable: true });
});
afterAll(() => {
  for (const h of HANDLERS) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[h];
});

beforeEach(() => {
  searches = [];
  answer = () => json({ results: [CHAIR, SHEEN], providers: [], next_cursor: null });
  fetchMock.mockClear();
  FakeIO.all = [];
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('IntersectionObserver', FakeIO);
  serverConfig.value = SERVER;
  lastAssetQuery.value = { text: '', category: null, provider: 'all' };
  updatePrefs((p) => ({ ...p, sync: { ...p.sync, serverUrl: '', token: 'tk' } }));
  toasts.value = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  serverConfig.value = null;
  sessionSignal.value = null;
  updatePrefs((p) => ({ ...p, sync: { ...p.sync, token: '' } }));
});

describe('Asset Browser', () => {
  it('shows the models found as cards with their provider and licence', async () => {
    const { container } = render(<AssetBrowser />);
    await waitFor(() => expect(byTestId(container, 'asset-card-khronos:SheenChair')).not.toBeNull());
    expect(byTestId(container, 'asset-browser')).not.toBeNull();
    const sheen = byTestId(container, 'asset-card-khronos:SheenChair')!;
    expect(sheen.textContent).toContain('Sheen Chair');
    expect(sheen.textContent).toContain('Khronos glTF sample models');
    const badge = byTestId(container, 'asset-licence-khronos:SheenChair')!;
    expect(badge.textContent).toBe('CC BY 4.0');
    expect(badge.title).toContain('Credit: “Sheen Chair” by Wayfair');
    expect(badge.className).toContain('credit');
    const cc0 = byTestId(container, 'asset-licence-builtin:chair')!;
    expect(cc0.textContent).toBe('CC0');
    expect(cc0.className).toContain('free');
    expect(byTestId(container, 'asset-end')?.textContent).toBe('2 models');
    // one search for the opening query: every provider, no words
    expect(searches).toHaveLength(1);
    expect(searches[0].get('query')).toBeNull();
    expect(searches[0].get('providers')).toBeNull();
  });

  it('shows how each provider answered: ok, needs key, offline', async () => {
    const { container } = render(<AssetBrowser />);
    await waitFor(() => expect(byTestId(container, 'asset-provider-status-polypizza')).not.toBeNull());
    const state = (id: string) => byTestId(container, `asset-provider-status-${id}`)!;
    expect(state('builtin').dataset.status).toBe('ok');
    expect(state('polypizza').dataset.status).toBe('needs key');
    expect(state('polypizza').title).toContain('POLYPIZZA_API_KEY');
    expect(state('sketchfab').dataset.status).toBe('offline');
    expect(state('sketchfab').title).toBe('HTTP 500');
    // disabled providers are neither shown nor offered
    expect(byTestId(container, 'asset-provider-status-catalog')).toBeNull();
    const select = byTestId(container, 'asset-provider') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      'all',
      'builtin',
      'khronos',
      'polypizza',
      'sketchfab',
    ]);
    expect([...select.options].find((o) => o.value === 'polypizza')!.textContent).toContain('needs key');
  });

  it('searches typed words after a pause, and at once on Enter', async () => {
    const { container } = render(<AssetBrowser />);
    await waitFor(() => expect(searches).toHaveLength(1));
    const input = byTestId(container, 'asset-search') as HTMLInputElement;
    for (const v of ['c', 'ch', 'chair']) fireEvent.input(input, { target: { value: v } });
    // nothing yet: the debounce waits for the pause
    await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS / 2));
    expect(searches).toHaveLength(1);
    await waitFor(() => expect(searches).toHaveLength(2));
    expect(searches[1].get('query')).toBe('chair');
    await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS * 2));
    expect(searches).toHaveLength(2);
    fireEvent.input(input, { target: { value: 'sofa' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(searches).toHaveLength(3));
    expect(searches[2].get('query')).toBe('sofa');
    expect(lastAssetQuery.value.text).toBe('sofa');
  });

  it('narrows the search by category and provider', async () => {
    const { container } = render(<AssetBrowser />);
    await waitFor(() => expect(searches).toHaveLength(1));
    const chip = byTestId(container, 'asset-category-furniture')!;
    fireEvent.click(chip);
    await waitFor(() => expect(searches).toHaveLength(2));
    expect(searches[1].get('category')).toBe('furniture');
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(byTestId(container, 'asset-category-all')!.getAttribute('aria-pressed')).toBe('false');
    fireEvent.change(byTestId(container, 'asset-provider')!, { target: { value: 'khronos' } });
    await waitFor(() => expect(searches).toHaveLength(3));
    expect(searches[2].get('providers')).toBe('khronos');
    expect(searches[2].get('category')).toBe('furniture');
    // the chip again: every category
    fireEvent.click(chip);
    await waitFor(() => expect(searches).toHaveLength(4));
    expect(searches[3].get('category')).toBeNull();
  });

  it('fetches a thumbnail only once its card comes into view', async () => {
    const { container } = render(<AssetBrowser />);
    await waitFor(() => expect(byTestId(container, 'asset-thumb-builtin:chair')).not.toBeNull());
    const img = byTestId(container, 'asset-thumb-builtin:chair') as HTMLImageElement;
    expect(img.getAttribute('src')).toBeNull();
    expect(img.getAttribute('loading')).toBe('lazy');
    // (observed once the card's effects ran)
    await waitFor(() => expect(FakeIO.show('[data-testid="asset-thumb-builtin:chair"]')).toBe(1));
    await waitFor(() =>
      expect(img.getAttribute('src')).toBe('/api/store/models/builtin:chair/thumbnail?token=tk'),
    );
    // the other card is still waiting
    expect(byTestId(container, 'asset-thumb-khronos:SheenChair')!.getAttribute('src')).toBeNull();
    // the category's icon shows until the thumbnail has loaded
    const thumb = (id: string) => byTestId(container, `asset-card-${id}`)!.querySelector('.asset-thumb')!;
    expect(thumb('builtin:chair').querySelector('svg')).not.toBeNull();
    expect(img.classList.contains('loaded')).toBe(false);
    fireEvent.load(img);
    await waitFor(() => expect(thumb('builtin:chair').querySelector('svg')).toBeNull());
    expect(img.classList.contains('loaded')).toBe(true);
    // a thumbnail that fails to load leaves the category icon
    const sheen = byTestId(container, 'asset-thumb-khronos:SheenChair')!;
    fireEvent.error(sheen);
    await waitFor(() => expect(byTestId(container, 'asset-thumb-khronos:SheenChair')).toBeNull());
    expect(thumb('khronos:SheenChair').querySelector('svg')).not.toBeNull();
  });

  it('asks for the next page when the end of the list shows', async () => {
    answer = (p) =>
      p.get('cursor') === 'c1'
        ? json({
            results: [{ ...SHEEN, id: 'khronos:Lantern', name: 'Lantern' }],
            providers: [],
            next_cursor: null,
          })
        : json({ results: [CHAIR, SHEEN], providers: [], next_cursor: 'c1' });
    const { container } = render(<AssetBrowser />);
    await waitFor(() => expect(byTestId(container, 'asset-sentinel')).not.toBeNull());
    expect(byTestId(container, 'asset-more')).not.toBeNull();
    await waitFor(() => expect(FakeIO.show('[data-testid="asset-sentinel"]')).toBe(1));
    await waitFor(() => expect(byTestId(container, 'asset-card-khronos:Lantern')).not.toBeNull());
    expect(searches[1].get('cursor')).toBe('c1');
    expect(container.querySelectorAll('[data-testid^="asset-card-"]')).toHaveLength(3);
    expect(byTestId(container, 'asset-end')?.textContent).toBe('3 models');
    expect(byTestId(container, 'asset-sentinel')).toBeNull();
  });

  it('says when nothing matches, and offers to retry a failed search', async () => {
    answer = () => json({ results: [], providers: [], next_cursor: null });
    lastAssetQuery.value = { text: 'zzz', category: 'food', provider: 'all' };
    const first = render(<AssetBrowser />);
    await waitFor(() => expect(byTestId(first.container, 'asset-empty')).not.toBeNull());
    expect(byTestId(first.container, 'asset-empty')!.textContent).toBe('No models match “zzz” in Food.');
    first.unmount();

    // a provider that cannot search says why
    lastAssetQuery.value = { text: 'pizza', category: null, provider: 'polypizza' };
    const keyed = render(<AssetBrowser />);
    await waitFor(() =>
      expect(byTestId(keyed.container, 'asset-empty')?.textContent).toContain('POLYPIZZA_API_KEY'),
    );
    keyed.unmount();

    lastAssetQuery.value = { text: '', category: null, provider: 'all' };
    answer = () =>
      json({ error: 'The model store is not available yet on this server.', code: 'UNAVAILABLE' }, 503);
    const { container } = render(<AssetBrowser />);
    await waitFor(() => expect(byTestId(container, 'asset-error')).not.toBeNull());
    expect(byTestId(container, 'asset-error')!.textContent).toContain('not available yet');
    answer = () => json({ results: [CHAIR], providers: [], next_cursor: null });
    fireEvent.click(byTestId(container, 'asset-retry')!);
    await waitFor(() => expect(byTestId(container, 'asset-card-builtin:chair')).not.toBeNull());
    expect(byTestId(container, 'asset-error')).toBeNull();
  });

  it('drags a card with the model as application/x-3d-editor-asset', async () => {
    const { container } = render(<AssetBrowser />);
    await waitFor(() => expect(byTestId(container, 'asset-card-khronos:SheenChair')).not.toBeNull());
    const card = byTestId(container, 'asset-card-khronos:SheenChair')!;
    expect(card.getAttribute('draggable')).toBe('true');
    const data = new Map<string, string>();
    const dt = { effectAllowed: 'all', setData: (t: string, v: string) => data.set(t, v) };
    const ev = new Event('dragstart', { bubbles: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    card.dispatchEvent(ev);
    const carried = JSON.parse(data.get(ASSET_DRAG_TYPE)!);
    expect(carried).toMatchObject({
      v: 1,
      model: 'khronos:SheenChair',
      provider: 'khronos',
      name: 'Sheen Chair',
    });
    expect(carried.result.license.spdx).toBe('CC-BY-4.0');
    expect(dt.effectAllowed).toBe('copy');
  });

  it('adds a model at the 3D cursor, and says why a model cannot be added', async () => {
    const s = fakeSession();
    sessionSignal.value = s;
    s.state.cursorLocation = [2, 1, 0];
    const keyed: StoreResult = {
      ...SHEEN,
      id: 'sketchfab:abc',
      provider: 'sketchfab',
      needs_key: 'SKETCHFAB_TOKEN',
    };
    answer = () => json({ results: [CHAIR, keyed], providers: [], next_cursor: null });
    const { container } = render(<AssetBrowser />);
    await waitFor(() => expect(byTestId(container, 'asset-add-builtin:chair')).not.toBeNull());
    fireEvent.click(byTestId(container, 'asset-add-builtin:chair')!);
    const root = s.doc.listObjects().find((o) => o.type === 'EMPTY' && !o.parent)!;
    expect(root.location).toEqual([2, 1, 0]);
    const add = byTestId(container, 'asset-add-sketchfab:abc')!;
    expect(add.textContent).toBe('Needs key');
    expect(add.title).toContain('SKETCHFAB_TOKEN');
    fireEvent.click(add);
    expect(toasts.value.at(-1)?.message).toContain('needs SKETCHFAB_TOKEN');
    expect(s.doc.listObjects().filter((o) => o.type === 'EMPTY' && !o.parent)).toHaveLength(1);
  });

  it('adds a model once per click on Add: a double click on Add adds it twice, not three times', async () => {
    const s = fakeSession();
    sessionSignal.value = s;
    const { container } = render(<AssetBrowser />);
    await waitFor(() => expect(byTestId(container, 'asset-add-builtin:chair')).not.toBeNull());
    const roots = () => s.doc.listObjects().filter((o) => o.type === 'EMPTY' && !o.parent).length;
    const add = byTestId(container, 'asset-add-builtin:chair')!;
    // a double click on Add: its two clicks, then the double click, which bubbles to the card
    fireEvent.click(add, { detail: 1 });
    fireEvent.click(add, { detail: 2 });
    fireEvent.dblClick(add, { detail: 2 });
    expect(roots()).toBe(2);
    expect(s.undo.undoStack).toHaveLength(2);
    // a double click elsewhere on the card adds the model once
    fireEvent.dblClick(byTestId(container, 'asset-card-builtin:chair')!.querySelector('.asset-name')!);
    expect(roots()).toBe(3);
  });

  it('fetches the thumbnails of the cards in view and of the next row only', async () => {
    // a page of 24 models, laid out as rows of four 48 px tall cards (52 px apart) in a list 73 px
    // tall (the bottom area's), as in the browser
    const ROW = 52;
    const CARD = 48;
    const LIST = 73;
    const many: StoreResult[] = Array.from({ length: 24 }, (_, i) => ({
      ...CHAIR,
      id: `builtin:m${i}`,
      name: `Model ${i}`,
      thumbnail_url: `/api/store/models/builtin:m${i}/thumbnail`,
    }));
    answer = () => json({ results: many, providers: [], next_cursor: null });
    /** An IntersectionObserver that intersects the layout above with its root and root margin. */
    class LayoutIO {
      readonly observed = new Set<Element>();
      constructor(
        private readonly cb: IntersectionObserverCallback,
        private readonly opts: IntersectionObserverInit = {},
      ) {}
      /** Top and bottom margin in px: CSS margin shorthand, % of the root's height. */
      private margins(height: number): [number, number] {
        const v = (this.opts.rootMargin ?? '0px').trim().split(/\s+/);
        const px = (s: string) => (s.endsWith('%') ? (parseFloat(s) / 100) * height : parseFloat(s));
        return [px(v[0]), px(v[2] ?? v[0])];
      }
      observe(el: Element) {
        this.observed.add(el);
        queueMicrotask(() => {
          if (!this.observed.has(el)) return;
          const root = (this.opts.root as Element).getBoundingClientRect();
          const [top, bottom] = this.margins(root.height);
          const r = el.getBoundingClientRect();
          if (r.bottom >= root.top - top && r.top <= root.bottom + bottom)
            this.cb(
              [{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry],
              this as never,
            );
        });
      }
      unobserve(el: Element) {
        this.observed.delete(el);
      }
      disconnect() {
        this.observed.clear();
      }
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal('IntersectionObserver', LayoutIO);
    const rect = (top: number, height: number) =>
      ({ top, bottom: top + height, height, left: 0, right: 900, width: 900, x: 0, y: top }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.matches('[data-testid="asset-results"]')) return rect(0, LIST);
      const card = this.closest('[data-testid^="asset-card-"]');
      if (!card) return rect(10_000, 0);
      const i = [...document.querySelectorAll('[data-testid^="asset-card-"]')].indexOf(card);
      return rect(Math.floor(i / 4) * ROW, CARD);
    });
    const { container } = render(<AssetBrowser />);
    await waitFor(() => expect(container.querySelectorAll('.asset-thumb img')).toHaveLength(24));
    const asked = () =>
      [...container.querySelectorAll('.asset-thumb img')].filter((img) => img.getAttribute('src')).length;
    // rows 0 and 1 show, row 2 is the next: 12 thumbnails, not the 24 of the page
    await waitFor(() => expect(asked()).toBe(12));
    await new Promise((r) => setTimeout(r, 20));
    expect(asked()).toBe(12);
    expect(byTestId(container, 'asset-thumb-builtin:m11')!.getAttribute('src')).not.toBeNull();
    expect(byTestId(container, 'asset-thumb-builtin:m12')!.getAttribute('src')).toBeNull();
  });

  it('without a server, offers the built-in models alone, searched in the browser', async () => {
    serverConfig.value = null;
    const { container } = render(<AssetBrowser compact />);
    await waitFor(() =>
      expect(container.querySelectorAll('[data-testid^="asset-card-"]').length).toBeGreaterThan(5),
    );
    expect(byTestId(container, 'asset-browser')!.className).toContain('compact');
    expect(byTestId(container, 'asset-provider')).toBeNull();
    expect(byTestId(container, 'asset-provider-status-builtin')!.dataset.status).toBe('ok');
    const input = byTestId(container, 'asset-search') as HTMLInputElement;
    expect(input.placeholder).toBe('Search built-in models');
    fireEvent.input(input, { target: { value: 'chair' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(byTestId(container, 'asset-card-builtin:chair')).not.toBeNull());
    // no thumbnails without a server: the category's icon
    expect(container.querySelector('.asset-thumb img')).toBeNull();
    expect(byTestId(container, 'asset-card-builtin:chair')!.querySelector('.asset-thumb svg')).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lays the cards out as rows while the browser is short, as tiles once it is tall', async () => {
    /** ResizeObserver whose sizes the test sets. */
    class FakeRO {
      static all: FakeRO[] = [];
      readonly observed: Element[] = [];
      constructor(private readonly cb: ResizeObserverCallback) {
        FakeRO.all.push(this);
      }
      observe(el: Element) {
        this.observed.push(el);
      }
      unobserve() {}
      disconnect() {
        this.observed.length = 0;
      }
      static resize(height: number) {
        for (const ro of FakeRO.all)
          for (const target of ro.observed)
            ro.cb(
              [{ target, contentRect: { width: 900, height } } as unknown as ResizeObserverEntry],
              ro as never,
            );
      }
    }
    vi.stubGlobal('ResizeObserver', FakeRO);
    const { container, unmount } = render(<AssetBrowser />);
    await waitFor(() => expect(byTestId(container, 'asset-card-khronos:SheenChair')).not.toBeNull());
    const root = byTestId(container, 'asset-browser')!;
    expect(root.classList.contains('short')).toBe(false);
    // the bottom area opens 150 px tall: rows
    FakeRO.resize(150);
    await waitFor(() => expect(root.classList.contains('short')).toBe(true));
    // the provider states sit in the toolbar row, the Add button beside the card's text
    expect(root.querySelector('.asset-toolbar [data-testid="asset-provider-statuses"]')).not.toBeNull();
    expect(byTestId(container, 'asset-add-khronos:SheenChair')!.closest('.asset-info')).toBeNull();
    FakeRO.resize(SHORT_BROWSER_PX);
    await waitFor(() => expect(root.classList.contains('short')).toBe(false));
    // a hidden browser (0 high) keeps its layout
    FakeRO.resize(120);
    await waitFor(() => expect(root.classList.contains('short')).toBe(true));
    FakeRO.resize(0);
    expect(root.classList.contains('short')).toBe(true);
    unmount();
    expect(FakeRO.all.every((ro) => ro.observed.length === 0)).toBe(true);
  });
});
