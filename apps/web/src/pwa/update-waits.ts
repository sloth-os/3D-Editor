import { toast } from '../app/store';
import { telemetry } from '../telemetry/telemetry';
import { UPDATE_WAITS_FOR_DESK } from './sw-desk';

/** What the editor says when its Update waits for a desk page (docs/storage-and-sync.md). */
export const UPDATE_WAITS_FOR_DESK_NOTE = "A director's desk is open in this browser; close it to update";

/**
 * Listens on the page's ServiceWorkerContainer for the waiting version's answer to the editor's
 * Update (sw-desk.ts answerSkipWaiting): while a desk page is open in this browser partition the
 * new version keeps waiting, so the files of a running desk never change under it, and the editor
 * says so rather than seem to ignore the click. Update pressed again once the desk is closed
 * applies it (the page then reloads under the new version).
 */
export function sayWhyUpdateWaits(container: Pick<EventTarget, 'addEventListener'>): void {
  container.addEventListener('message', (event) => {
    const data = (event as MessageEvent).data as { type?: unknown } | null | undefined;
    if (data?.type !== UPDATE_WAITS_FOR_DESK) return;
    toast(UPDATE_WAITS_FOR_DESK_NOTE, 'warning', 8000);
    telemetry.count('editor.pwa.update_waits_for_desk');
  });
}
