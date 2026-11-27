/*
 * Lazy loading in the Asset Browser: an IntersectionObserver per results list (and per distance)
 * tells each card when it comes near the visible part of the list, and tells the end of the list
 * when it shows (the next page is fetched). A card's server thumbnail is fetched once it comes near;
 * a built-in model's thumbnail, made in this browser, is followed both ways: asked for when the
 * card comes near, let go when it leaves (a thumbnail still waiting then leaves the queue).
 * Without IntersectionObserver everything counts as visible at once.
 */

export class VisibilityWatcher {
  private readonly io: IntersectionObserver | null;
  private readonly callbacks = new Map<Element, () => void>();
  private readonly followers = new Map<Element, (near: boolean) => void>();

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
      this.followers.get(e.target)?.(e.isIntersecting);
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

  /**
   * Tells `onChange` whether `el` is near the root each time that changes, first when the observer
   * first sees it (at once and for good without IntersectionObserver: near). Returns the function
   * that stops following.
   */
  follow(el: Element, onChange: (near: boolean) => void): () => void {
    if (!this.io) {
      onChange(true);
      return () => undefined;
    }
    this.followers.set(el, onChange);
    this.io.observe(el);
    return () => {
      if (this.followers.get(el) !== onChange) return;
      this.followers.delete(el);
      if (!this.callbacks.has(el)) this.io?.unobserve(el);
    };
  }

  private unwatch(el: Element): void {
    if (!this.callbacks.delete(el)) return;
    if (!this.followers.has(el)) this.io?.unobserve(el);
  }

  /** Stops watching everything. */
  disconnect(): void {
    this.callbacks.clear();
    this.followers.clear();
    this.io?.disconnect();
  }
}
