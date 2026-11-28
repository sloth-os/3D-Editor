import { appBaseUrl } from '../app/base-url';

/*
 * The desk's service worker: the web app's (src/pwa/sw.ts, the base's sw.js with the base as its
 * scope: '/' at the root, '/3d/' behind a proxy at /3d/; docs/subpath.md), which precaches desk.html
 * and every file it loads (docs/embedding.md, "Offline"). The desk registers it itself and never
 * reloads for it. A new version installs in the background and waits until every page the old one
 * serves is closed, then takes over at the next load, so a session in a host is never cut short:
 * the editor's Update (pwa/register.ts), which makes a waiting version take over at once, is refused
 * while a desk page is open in the same browser partition (the sample, or a host on the desk's own
 * site), so the files of a running desk never change under it.
 */

/**
 * Registers the service worker of the app's base (the same registration as the editor's, which
 * registers ./sw.js with the scope ./ relative to the same base); resolves with whether this page is
 * (or will be) served offline.
 */
export async function registerDeskServiceWorker(): Promise<boolean> {
  if (import.meta.env.DEV || typeof navigator === 'undefined' || !('serviceWorker' in navigator))
    return false;
  try {
    const base = appBaseUrl();
    await navigator.serviceWorker.register(new URL('sw.js', base).href, { scope: base, type: 'classic' });
    return true;
  } catch (err) {
    console.warn('[desk] the service worker did not register: the desk works online only', err);
    return false;
  }
}
