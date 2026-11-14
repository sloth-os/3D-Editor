import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { STORE_CATEGORIES, type StoreCategory, type StoreResult } from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';
import { serverConfig } from '../../app/store';
import { storeThumbnailUrl, type StoreProviderStatus } from '../../io/store-client';
import { Icon } from '../icons';
import { CategoryIcon } from './category-icons';
import { licenceLabel, licenceTone, licenceTooltip, providerBadge } from './badges';
import { insertBlocker, insertStoreModel, insertsInFlight } from './insert';
import { setAssetDragData } from './drop';
import { AssetSearch, localBackend, serverBackend, type AssetQuery, type ProviderChoice } from './search';
import { VisibilityWatcher } from './visibility';
import './assets.css';

/*
 * The Asset Browser (SPEC §13): searches the model store and inserts models into the scene. It
 * shows in the Director workspace's right column and in the bottom area's 'assets' tab (both
 * mounted by App.tsx). Search words (debounced), a provider choice with each provider's state (ok /
 * needs key / offline), category chips, and a grid of cards: thumbnail (fetched once the card comes
 * into view), name, provider and licence badge (its credit as the tooltip). The grid pages on with
 * the search cursor as it is scrolled. A card's Add inserts the model at the 3D cursor; dragging it
 * into the viewport inserts it where it is dropped (drop.ts). Without the editor server only the
 * built-in models are offered (searched in this browser, without thumbnails).
 */

/** Props of the Asset Browser: mounted in the Director right column and the 'assets' bottom tab. */
export interface AssetBrowserProps {
  /** The open project (inserts go to the editor's open project in any case). */
  session?: ProjectSession | null;
  /** Narrow layout for the Director column. */
  compact?: boolean;
}

const CATEGORY_LABELS: Record<StoreCategory, string> = {
  people: 'People',
  animals: 'Animals',
  furniture: 'Furniture',
  props: 'Props',
  food: 'Food',
  vehicles: 'Vehicles',
  nature: 'Nature',
  architecture: 'Architecture',
  street: 'Street',
  sports: 'Sports',
};

/**
 * The query an Asset Browser opens with: the last one asked in any of them (kept while the editor
 * runs, so switching tabs or workspaces keeps the search).
 */
export const lastAssetQuery = signal<AssetQuery>({ text: '', category: null, provider: 'all' });

/** Whether this editor has a server with the model store (else the built-in catalog is searched here). */
function storeOnServer(): boolean {
  return serverConfig.value?.features.modelStore === true;
}

/**
 * Below this height the browser lays its cards out as rows (small thumbnail, name, Add): a card
 * tile is about 170 px tall, which a short area (the bottom area opens 150 px tall) cuts off.
 */
export const SHORT_BROWSER_PX = 300;

/**
 * How far above and below the visible part of the results a card already counts as visible (its
 * thumbnail is fetched): one height of the results box, the next screenful, whatever the layout. A
 * fixed margin would cover every card of a page in a short box (the bottom area's is about 70 px
 * tall), and the server, which renders thumbnails one at a time, would make the cards on screen wait
 * behind the others.
 */
export const THUMBNAIL_MARGIN = '100% 0px';

/** Whether `el` is shorter than SHORT_BROWSER_PX, followed as it is resized (false without ResizeObserver). */
function useShort(el: { current: HTMLElement | null }): boolean {
  const [short, setShort] = useState(false);
  useEffect(() => {
    const node = el.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[entries.length - 1]?.contentRect.height ?? 0;
      // a hidden browser (display: none, height 0) keeps its layout
      if (h > 0) setShort(h < SHORT_BROWSER_PX);
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  return short;
}

export function AssetBrowser({ compact }: AssetBrowserProps) {
  const remote = storeOnServer();
  const search = useMemo(() => new AssetSearch(remote ? serverBackend() : localBackend()), [remote]);
  const [text, setText] = useState(lastAssetQuery.peek().text);
  const [category, setCategory] = useState<StoreCategory | null>(lastAssetQuery.peek().category);
  const [provider, setProvider] = useState<ProviderChoice>(remote ? lastAssetQuery.peek().provider : 'all');
  const rootRef = useRef<HTMLDivElement>(null);
  const short = useShort(rootRef);
  const scrollRef = useRef<HTMLDivElement>(null);
  const watcherRef = useRef<VisibilityWatcher | null>(null);
  const watcher = () => (watcherRef.current ??= new VisibilityWatcher(scrollRef.current, THUMBNAIL_MARGIN));

  // a new search object (the server came or went): ask it about its providers and search again
  useEffect(() => {
    void search.loadProviders();
    const q = lastAssetQuery.peek();
    search.request({ ...q, provider: remote ? q.provider : 'all' }, { immediate: true });
    return () => search.dispose();
  }, [search, remote]);
  useEffect(
    () => () => {
      watcherRef.current?.disconnect();
      watcherRef.current = null;
    },
    [],
  );

  const ask = (q: AssetQuery, immediate: boolean) => {
    lastAssetQuery.value = q;
    search.request(q, { immediate });
  };
  const query = (): AssetQuery => ({ text, category, provider });

  const results = search.results.value;
  const loading = search.loading.value;
  const error = search.error.value;
  const next = search.next.value;
  const statuses = search.statuses.value;
  const shown = search.query.value;
  const enabled = statuses.filter((p) => p.enabled);
  // the provider asked for last stays a choice even when the server no longer offers it
  const choices = enabled.concat(statuses.filter((p) => !p.enabled && p.id === provider));
  const names = new Map(statuses.map((p) => [p.id, p.name]));
  const chosen = provider === 'all' ? null : (statuses.find((p) => p.id === provider) ?? null);

  return (
    <div
      class={`asset-browser${compact ? ' compact' : ''}${short ? ' short' : ''}`}
      ref={rootRef}
      data-testid="asset-browser"
    >
      <div class="asset-toolbar">
        <div class="asset-search">
          <Icon name="search" size={13} />
          <input
            class="textfield"
            type="search"
            value={text}
            placeholder={remote ? 'Search models' : 'Search built-in models'}
            aria-label="Search models"
            data-testid="asset-search"
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              setText(v);
              ask({ text: v, category, provider }, false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.isComposing) ask(query(), true);
            }}
          />
        </div>
        {remote && (
          <select
            class="select"
            value={provider}
            aria-label="Provider"
            title="Where to search"
            data-testid="asset-provider"
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              setProvider(v);
              ask({ text, category, provider: v }, true);
            }}
          >
            <option value="all">All providers</option>
            {choices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.status === 'ok' ? '' : ` (${providerBadge(p).label})`}
              </option>
            ))}
          </select>
        )}
        <ProviderStatuses statuses={enabled} />
      </div>
      <div class="asset-chips" role="toolbar" aria-label="Categories" data-testid="asset-categories">
        <button
          class="asset-chip"
          aria-pressed={category === null}
          data-testid="asset-category-all"
          onClick={() => {
            setCategory(null);
            ask({ text, category: null, provider }, true);
          }}
        >
          All
        </button>
        {STORE_CATEGORIES.map((c) => (
          <button
            key={c}
            class="asset-chip"
            aria-pressed={category === c}
            data-testid={`asset-category-${c}`}
            title={CATEGORY_LABELS[c]}
            onClick={() => {
              const v = category === c ? null : c;
              setCategory(v);
              ask({ text, category: v, provider }, true);
            }}
          >
            <CategoryIcon category={c} size={12} />
            {CATEGORY_LABELS[c]}
          </button>
        ))}
      </div>
      <div class="asset-results" ref={scrollRef} data-testid="asset-results" aria-busy={loading}>
        {results.length > 0 && (
          <div class="asset-grid" role="list">
            {results.map((r) => (
              <AssetCard
                key={r.id}
                result={r}
                providerName={names.get(r.provider) ?? r.provider}
                thumbnails={remote}
                watcher={watcher}
              />
            ))}
          </div>
        )}
        {error ? (
          <div class="asset-empty" data-testid="asset-error" role="alert">
            <span class="error-text">{error}</span>
            <button class="btn" data-testid="asset-retry" onClick={() => void search.retry()}>
              Retry
            </button>
          </div>
        ) : loading ? (
          <div class="asset-note" data-testid="asset-loading">
            {results.length ? 'Loading more…' : 'Searching…'}
          </div>
        ) : results.length === 0 && shown ? (
          <div class="asset-empty" data-testid="asset-empty">
            <CategoryIcon category={shown.category} size={28} />
            <span>{emptyText(shown, chosen)}</span>
          </div>
        ) : next ? (
          <>
            <Sentinel key={next} watcher={watcher} onVisible={() => void search.more()} />
            <div class="asset-note">
              <button class="btn flat" data-testid="asset-more" onClick={() => void search.more()}>
                Load more
              </button>
            </div>
          </>
        ) : results.length > 0 ? (
          <div class="asset-note" data-testid="asset-end">
            {results.length} model{results.length === 1 ? '' : 's'}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** What the empty results say: nothing matches, or why the provider asked gave nothing. */
function emptyText(q: AssetQuery, chosen: StoreProviderStatus | null): string {
  if (chosen && chosen.status !== 'ok') return `${chosen.name}: ${providerBadge(chosen).title}`;
  const words = q.text.trim();
  const where = q.category ? ` in ${CATEGORY_LABELS[q.category]}` : '';
  return words ? `No models match “${words}”${where}.` : `No models${where}.`;
}

/** Each searched provider and how it answered (ok / needs key / offline), the reason as tooltip. */
function ProviderStatuses({ statuses }: { statuses: StoreProviderStatus[] }) {
  if (!statuses.length) return null;
  return (
    <div class="asset-providers" data-testid="asset-provider-statuses">
      {statuses.map((p) => {
        const b = providerBadge(p);
        return (
          <span
            key={p.id}
            class={`asset-status ${b.tone}`}
            title={b.title}
            data-testid={`asset-provider-status-${p.id}`}
            data-status={b.label}
          >
            {p.name} · {b.label}
          </span>
        );
      })}
    </div>
  );
}

/** The end of the list: shown, it asks for the next page (re-keyed per page, so it asks again). */
function Sentinel({ watcher, onVisible }: { watcher: () => VisibilityWatcher; onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => (ref.current ? watcher().watch(ref.current, () => cb.current()) : undefined), []);
  return <div class="asset-sentinel" ref={ref} data-testid="asset-sentinel" aria-hidden="true" />;
}

/** One model: thumbnail, name, provider, licence; Add inserts it at the 3D cursor; drag it into the viewport. */
function AssetCard({
  result: r,
  providerName,
  thumbnails,
  watcher,
}: {
  result: StoreResult;
  providerName: string;
  thumbnails: boolean;
  watcher: () => VisibilityWatcher;
}) {
  const src = thumbnails ? storeThumbnailUrl(r) : null;
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const showImg = !!src && !failed;
  const thumbRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!src || !thumbRef.current) return;
    return watcher().watch(thumbRef.current, () => setVisible(true));
  }, [src]);
  const progress = insertsInFlight.value.get(r.id) ?? null;
  const blocker = insertBlocker(r);
  const add = () => void insertStoreModel(r);
  const dims = r.dimensions_m?.every((d) => Number.isFinite(d) && d > 0)
    ? `${r.dimensions_m.map((d) => (d >= 10 ? d.toFixed(0) : d.toPrecision(2))).join(' × ')} m`
    : null;
  return (
    <div
      class={`asset-card ${progress ? 'busy' : ''}`}
      role="listitem"
      tabIndex={0}
      draggable
      data-testid={`asset-card-${r.id}`}
      title={`${r.name}${dims ? ` · ${dims}` : ''}\nDrag into the viewport, or Add to place it at the 3D cursor`}
      onDragStart={(e) => {
        if (e.dataTransfer) setAssetDragData(e.dataTransfer, r);
      }}
      onDblClick={(e) => {
        // a double click on Add already added the model with each of its clicks
        if ((e.target as Element | null)?.closest?.('button')) return;
        add();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) add();
      }}
    >
      <div class="asset-thumb" ref={thumbRef}>
        {/* the category's icon until the thumbnail is there (servers render some on first request) */}
        {!(showImg && loaded) && <CategoryIcon category={r.category} size={34} />}
        {showImg && (
          <img
            class={loaded ? 'loaded' : undefined}
            src={visible ? src : undefined}
            loading="lazy"
            decoding="async"
            alt=""
            draggable={false}
            data-testid={`asset-thumb-${r.id}`}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        )}
        {progress && (
          <div
            class="asset-progress"
            role="progressbar"
            aria-label={`Adding ${r.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.fraction === null ? undefined : Math.round(progress.fraction * 100)}
            style={{ width: `${Math.round((progress.fraction ?? 0.1) * 100)}%` }}
          />
        )}
      </div>
      <div class="asset-info">
        <div class="asset-name">{r.name}</div>
        <div class="asset-meta">
          <span class="asset-provider">{providerName}</span>
          <span
            class={`asset-licence ${licenceTone(r.license.spdx)}`}
            title={licenceTooltip(r)}
            aria-label={`Licence ${r.license.spdx}${r.license.attribution ? `, credit: ${r.license.attribution}` : ''}`}
            data-testid={`asset-licence-${r.id}`}
          >
            {licenceLabel(r.license.spdx)}
          </span>
        </div>
      </div>
      <div class="asset-actions">
        <button
          class="btn"
          data-testid={`asset-add-${r.id}`}
          disabled={!!progress}
          title={blocker ? blocker.message : 'Add at the 3D cursor'}
          onClick={(e) => {
            e.stopPropagation();
            add();
          }}
        >
          {progress
            ? progress.phase === 'inserting'
              ? 'Adding…'
              : progress.fraction === null
                ? 'Downloading…'
                : `${Math.round(progress.fraction * 100)}%`
            : blocker?.code === 'NEEDS_KEY'
              ? 'Needs key'
              : blocker?.code === 'NOT_DOWNLOADABLE'
                ? 'View only'
                : 'Add'}
        </button>
      </div>
    </div>
  );
}
