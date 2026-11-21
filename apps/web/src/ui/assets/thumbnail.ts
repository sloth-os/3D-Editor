import { useEffect, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { BUILTIN_PROVIDER, type StoreResult } from '@3d-editor/core';
import { storeThumbnailUrl } from '../../io/store-client';
import { ThumbnailError, thumbnailService, type ThumbnailTicket } from '../../assets/thumbnails';
import type { VisibilityWatcher } from './visibility';

/*
 * A card's thumbnail in the Asset Browser. A built-in model's is made in this browser
 * (assets/thumbnails: cache, workers), never asked of the editor server: the card asks for it when
 * it comes near the visible part of the list (on screen first), lets the request go when it leaves
 * before the thumbnail is there, and shows the category's icon with a placeholder meanwhile, or a
 * warning when the thumbnail could not be made. Another provider's thumbnail comes from the editor
 * server's store (it proxies and caches it), fetched once the card comes near.
 */

/** The list's visibility watchers a card follows. */
export interface CardWatchers {
  /** Near the visible part of the list (the next screenful): thumbnails are asked for. */
  near(): VisibilityWatcher;
  /** On screen: their thumbnails are made first. */
  view(): VisibilityWatcher;
}

/**
 * Where a card's thumbnail is: not asked for yet (idle), being made or read (pending), loading
 * into the image (loading), shown (ready), or none (failed).
 */
export type ThumbStatus = 'idle' | 'pending' | 'loading' | 'ready' | 'failed';

export interface CardThumbnail {
  /** Whether the card can have a thumbnail at all (built-in, or the server's store has one). */
  available: boolean;
  status: ThumbStatus;
  /** What the image shows (null: nothing yet). */
  src: string | null;
  /** Where it came from: memory, cache or render (made here), or server. */
  source: string | null;
  /** Why there is none (failed). */
  error: string | null;
  onLoad(): void;
  onError(): void;
}

interface State {
  status: ThumbStatus;
  src: string | null;
  source: string | null;
  error: string | null;
}

const IDLE: State = { status: 'idle', src: null, source: null, error: null };

/** Whether `r`'s thumbnail is made in this browser (the built-in models). */
export const thumbnailMadeHere = (r: StoreResult) => r.provider === BUILTIN_PROVIDER;

/**
 * The tooltip of a card whose thumbnail could not be made: the reason, said once (core's own
 * message already says the thumbnail could not be made; a worker's failure does not).
 */
export function failedThumbnailTitle(error: string | null): string {
  const reason = error?.trim() || 'unknown error';
  return /\bcould not be made\b/i.test(reason) ? reason : `The thumbnail could not be made: ${reason}`;
}

/** The thumbnail of card `r` (its element `el`), following the list's watchers. */
export function useCardThumbnail(
  r: StoreResult,
  el: RefObject<HTMLElement>,
  watchers: CardWatchers,
  serverThumbnails: boolean,
): CardThumbnail {
  const [state, setState] = useState<State>(IDLE);
  const server = serverThumbnails ? storeThumbnailUrl(r) : null;
  const here = thumbnailMadeHere(r);

  useEffect(() => {
    setState(IDLE);
    const node = el.current;
    if (!node) return;
    if (!here) {
      // another provider's: from the server's store, once the card comes near
      if (!server) return;
      return watchers
        .near()
        .watch(node, () => setState({ ...IDLE, status: 'loading', src: server, source: 'server' }));
    }
    let alive = true;
    let ticket: ThumbnailTicket | null = null;
    let inView = false;
    let done = false;
    const stops: (() => void)[] = [];
    const stopFollowing = () => {
      for (const stop of stops.splice(0)) stop();
    };
    const ask = () => {
      if (ticket || done) return;
      const t = thumbnailService().request({ model: r.id }, inView ? 'visible' : 'near');
      ticket = t;
      setState((s) => (s.status === 'failed' || s.status === 'idle' ? { ...IDLE, status: 'pending' } : s));
      t.promise.then(
        (img) => {
          if (!alive || ticket !== t) return;
          // the card keeps its thumbnail: nothing more to follow
          done = true;
          stopFollowing();
          setState({ status: 'loading', src: img.url, source: img.source, error: null });
        },
        (err: unknown) => {
          if (!alive || ticket !== t) return;
          ticket = null;
          const e = err instanceof ThumbnailError ? err : null;
          if (e?.code === 'CANCELLED') return;
          // a model this build does not know: the server's store may (an older or newer server)
          if (e?.code === 'NOT_FOUND' && server) {
            done = true;
            stopFollowing();
            setState({ status: 'loading', src: server, source: 'server', error: null });
            return;
          }
          setState({
            status: 'failed',
            src: null,
            source: null,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
    };
    const letGo = () => {
      ticket?.cancel();
      ticket = null;
      setState((s) => (s.status === 'pending' ? IDLE : s));
    };
    stops.push(
      watchers.view().follow(node, (visible) => {
        inView = visible;
        ticket?.setPriority(visible ? 'visible' : 'near');
      }),
      watchers.near().follow(node, (near) => (near ? ask() : letGo())),
    );
    return () => {
      alive = false;
      stopFollowing();
      ticket?.cancel();
      ticket = null;
    };
  }, [r.id, here, server]);

  return {
    ...state,
    available: here || !!server,
    onLoad: () => setState((s) => (s.status === 'loading' ? { ...s, status: 'ready' } : s)),
    onError: () =>
      setState((s) => ({
        status: 'failed',
        src: null,
        source: s.source,
        error: s.source === 'server' ? 'The thumbnail did not load' : 'The thumbnail image is broken',
      })),
  };
}
