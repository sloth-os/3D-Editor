/*
 * Lazy loading in the Asset Browser: one IntersectionObserver per results list tells each card when
 * it comes near the visible part of the list (its thumbnail is fetched then: only the cards on
 * screen ask the server for one), and tells the end of the list when it shows (the next page is
 * fetched). Without IntersectionObserver everything counts as visible at once.
 */

export class VisibilityWatcher {
  private readonly io: IntersectionObserver | null;
  private readonly callbacks = new Map<Element, () => void>();

  /**
   * @param root the scrolling element (null: the page's viewport)
   * @param rootMargin how far outside it an element already counts as visible (CSS margin syntax;
   *   percentages are of the root's own size, so the margin follows the root as it is resized)
   */
  constructor(root: Element | null, rootMargin = '200px') {
    this.io =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => this.onEntries(entries), { root, rootMargin })
        : null;
  }

  private onEntries(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const cb = this.callbacks.get(e.target);
      if (!cb) continue;
      this.unwatch(e.target);
      cb();
    }
  }

  /**
   * Calls `onVisible` once, when `el` first comes near the root (at once without
   * IntersectionObserver). Returns the function that stops watching.
   */
  watch(el: Element, onVisible: () => void): () => void {
    if (!this.io) {
      onVisible();
      return () => undefined;
    }
    this.callbacks.set(el, onVisible);
    this.io.observe(el);
    return () => this.unwatch(el);
  }

  private unwatch(el: Element): void {
    if (!this.callbacks.delete(el)) return;
    this.io?.unobserve(el);
  }

  /** Stops watching everything. */
  disconnect(): void {
    this.callbacks.clear();
    this.io?.disconnect();
  }
}
