/*
 * The desk's service worker (the PWA's, scope '/', which precaches desk.html and everything it
 * loads: docs/embedding.md, "Offline"). The desk registers it itself and never reloads for it: a new
 * version waits until every page it serves is closed and takes over at the next load, so a session
 * in a host is never cut short. (The editor's registration, pwa/register.ts, reloads once the person
 * asks for the update; the desk has no such button.)
 */

/** Registers the service worker; resolves with whether this page is (or will be) served offline. */
export async function registerDeskServiceWorker(): Promise<boolean> {
  if (import.meta.env.DEV || typeof navigator === 'undefined' || !('serviceWorker' in navigator))
    return false;
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/', type: 'classic' });
    return true;
  } catch (err) {
    console.warn('[desk] the service worker did not register: the desk works online only', err);
    return false;
  }
}
