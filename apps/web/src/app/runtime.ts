/*
 * Which page of the web app runs: the full editor (index.html) or the embeddable director's desk
 * (desk.html, docs/embedding.md). desk.html says so on its root element (`data-runtime="desk"`),
 * which every module can read before any of them runs: a flag set by the desk's entry module would
 * come too late for modules of a chunk the two pages share (their code runs first).
 *
 * The desk never asks a server for its configuration, never sends telemetry, never syncs, and keeps
 * its own preferences: modules that would do so check this first.
 */

/** Whether this page is the embeddable desk (desk.html). */
export function isDeskRuntime(): boolean {
  return typeof document !== 'undefined' && document.documentElement?.dataset.runtime === 'desk';
}
