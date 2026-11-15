import { beforeEach, describe, expect, it } from 'vitest';
import { toasts } from '../src/app/store';
import { UPDATE_WAITS_FOR_DESK } from '../src/pwa/sw-desk';
import { sayWhyUpdateWaits } from '../src/pwa/update-waits';

/*
 * The editor's side of the answer to its Update (src/pwa/update-waits.ts, wired to the page's
 * ServiceWorkerContainer by register.ts registerPWA): when the waiting version answers that a desk
 * page open in this browser keeps it waiting (sw.ts, sw-desk.ts answerSkipWaiting), the editor says
 * so instead of seeming to ignore the click (docs/storage-and-sync.md "Offline / PWA",
 * docs/embedding.md "Offline"). e2e/tests/desk-partition.spec.ts presses Update in Chromium.
 */

const NOTE = "A director's desk is open in this browser; close it to update";

/** The page's ServiceWorkerContainer: the service worker's messages arrive on it. */
let container: EventTarget;
const fromServiceWorker = (data: unknown) => container.dispatchEvent(new MessageEvent('message', { data }));

beforeEach(() => {
  container = new EventTarget();
  sayWhyUpdateWaits(container);
  toasts.value = [];
});

describe("the editor's Update while a director's desk is open", () => {
  it('says why the update waits when the service worker answers so', () => {
    fromServiceWorker({ type: UPDATE_WAITS_FOR_DESK });
    expect(toasts.value.map((t) => [t.message, t.level])).toEqual([[NOTE, 'warning']]);
  });

  it('says nothing for other messages of the service worker', () => {
    fromServiceWorker({ type: 'SKIP_WAITING' });
    fromServiceWorker({ type: 'CACHE_UPDATED' });
    fromServiceWorker(null);
    fromServiceWorker('UPDATE_WAITS_FOR_DESK');
    expect(toasts.value).toEqual([]);
  });
});
