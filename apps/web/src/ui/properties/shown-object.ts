import type { RefObject } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ObjectData } from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';

/** Whether an element takes typed text (a text field, a number entry, a text area). */
export function takesText(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable) return true;
  if (el.tagName !== 'INPUT') return false;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(
    (el as HTMLInputElement).type,
  );
}

/**
 * The object an editor's per-object fields show: the active object, except while a field in `box`
 * is being typed into. Then that field's object stays shown when an agent (or another editor
 * command) makes another object active: the typing goes on into the field, and Enter commits it to
 * the object it was typed for. The active object is shown once the field is left (focus goes
 * elsewhere, or the field is taken away), or when the kept object is gone.
 *
 * Fields showing the object are keyed by its id: a field is never given another object.
 */
export function useShownObject(s: ProjectSession, box: RefObject<HTMLElement>): ObjectData | null {
  const activeId = s.state.$activeId.value;
  const shownId = useRef<string | null>(null);
  /**
   * The field here the focus is going to (Tab, or a click on it), from the blur of the field it
   * leaves until it arrives: what the blur commits renders the panel before then.
   */
  const moving = useRef<Element | null>(null);
  const [, refresh] = useState(0);
  const typingIn = (el: Element | null) => !!box.current && takesText(el) && box.current.contains(el);
  const typing =
    typeof document !== 'undefined' && (typingIn(document.activeElement) || typingIn(moving.current));
  let shown = activeId ? s.doc.getObject(activeId) : null;
  if (typing && shownId.current && shownId.current !== activeId)
    shown = s.doc.getObject(shownId.current) ?? shown;
  shownId.current = shown?.id ?? null;
  const kept = !!shown && shown.id !== activeId;
  // attached as the kept object is first shown (not after the next frame: the focus can leave then)
  useLayoutEffect(() => {
    const el = box.current;
    if (!kept || !el) return;
    const typingHere = (t: Element | null) => takesText(t) && el.contains(t);
    // the focus is leaving a field: for another field here it keeps the object shown (the blur comes
    // first, in the capture phase before the field commits what was typed)
    const onBlur = (e: FocusEvent) => {
      const next = e.relatedTarget as Element | null;
      moving.current = typingHere(next) ? next : null;
    };
    const onArrive = () => {
      moving.current = null;
    };
    // the field was left for something else
    const onLeave = (e: FocusEvent) => {
      if (typingHere(e.relatedTarget as Element | null)) return;
      moving.current = null;
      refresh((n) => n + 1);
    };
    // the field was taken away without a blur (Firefox and Safari send none: an entry closed by Enter)
    const observer = new MutationObserver(() => {
      if (!typingHere(document.activeElement)) refresh((n) => n + 1);
    });
    el.addEventListener('blur', onBlur, true);
    el.addEventListener('focusin', onArrive);
    el.addEventListener('focusout', onLeave);
    observer.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener('blur', onBlur, true);
      el.removeEventListener('focusin', onArrive);
      el.removeEventListener('focusout', onLeave);
      observer.disconnect();
      moving.current = null;
    };
  }, [kept, box]);
  return shown;
}
