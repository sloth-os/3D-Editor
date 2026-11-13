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
 * How long after a press in the box is released the box still counts as pressed: the click and a
 * second one that makes a double click land on what was pressed (Safari and Firefox on macOS do not
 * give a pressed button the focus that would hold the object otherwise).
 */
export const PRESS_GRACE_MS = 500;

/**
 * The object an editor's per-object fields show: the active object, except while the person works
 * in `box`. When an agent (through this browser's editor commands) makes another object active while
 * a field of the box is being typed into, or a press in it is under way (a click, a slider drag), the
 * box holds on to the object it showed: the typing goes on into the field and Enter commits it to the
 * object it was typed for, a drag ends on its own object, a click lands on what was pressed. The box
 * holds the object while the focus stays in it (Tab or a click to another field, a checkbox, a button
 * of it) and through every press in it. It lets go, showing the active object, once the focus has left
 * the box (or the focused element is taken away, as when Enter closes a number entry) with no press
 * under way in it, or when the held object is gone.
 *
 * Only those events let go, never a render by itself: when the focus leaves a text field whose text
 * changed, browsers send the field its change event (which commits the text and draws the box again)
 * while no element has the focus, before the focus arrives in the next field.
 *
 * Fields showing the object are keyed by its id: a field is never given another object.
 */
export function useShownObject(s: ProjectSession, box: RefObject<HTMLElement>): ObjectData | null {
  const activeId = s.state.$activeId.value;
  const shownId = useRef<string | null>(null);
  /** Whether the box holds on to another object than the active one, for the person's work in it. */
  const held = useRef(false);
  /** A press in the box, until {@link PRESS_GRACE_MS} after its release. */
  const pressing = useRef(false);
  const [, refresh] = useState(0);
  const focus = typeof document !== 'undefined' ? document.activeElement : null;
  const typing = !!focus && !!box.current && box.current.contains(focus) && takesText(focus);
  let shown = activeId ? s.doc.getObject(activeId) : null;
  if ((held.current || typing || pressing.current) && shownId.current && shownId.current !== activeId)
    shown = s.doc.getObject(shownId.current) ?? shown;
  shownId.current = shown?.id ?? null;
  held.current = !!shown && shown.id !== activeId;
  const isHeld = held.current;
  // presses in the box, also while it shows the active object: an agent may change that meanwhile
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onPress = () => {
      clearTimeout(timer);
      pressing.current = true;
    };
    const onRelease = () => {
      if (!pressing.current) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        pressing.current = false;
        // the press is over: the object is held on only by the focus in the box
        if (held.current && !el.contains(document.activeElement)) {
          held.current = false;
          refresh((n) => n + 1);
        }
      }, PRESS_GRACE_MS);
    };
    // a field that takes text got the focus (a number entry the press opened): the focus holds the
    // object from now on, so confirming the field lets go at once
    const onField = (e: FocusEvent) => {
      if (!pressing.current || !takesText(e.target as Element | null)) return;
      clearTimeout(timer);
      pressing.current = false;
    };
    el.addEventListener('pointerdown', onPress, true);
    el.addEventListener('focusin', onField);
    window.addEventListener('pointerup', onRelease, true);
    window.addEventListener('pointercancel', onRelease, true);
    // a release outside the window may never come
    window.addEventListener('blur', onRelease);
    return () => {
      el.removeEventListener('pointerdown', onPress, true);
      el.removeEventListener('focusin', onField);
      window.removeEventListener('pointerup', onRelease, true);
      window.removeEventListener('pointercancel', onRelease, true);
      window.removeEventListener('blur', onRelease);
      clearTimeout(timer);
      pressing.current = false;
    };
  }, [box]);
  // attached as the held object is first shown (not after the next frame: the focus can leave then)
  useLayoutEffect(() => {
    const el = box.current;
    if (!isHeld || !el) return;
    const inBox = (t: EventTarget | null) => t instanceof Node && el.contains(t);
    /** The element of the box that has the focus. */
    let focused = inBox(document.activeElement) ? document.activeElement : null;
    /**
     * The element of the box the focus is going to (Tab, or a click on it), from the blur of the one
     * it leaves until it arrives: the element left can be taken away meanwhile (a number entry its blur
     * closes).
     */
    let next: Element | null = null;
    // (a press under way goes on holding the object, through the render, until it ends: see above)
    const letGo = () => {
      focused = next = null;
      held.current = false;
      refresh((n) => n + 1);
    };
    // the capture phase: before the element left handles its blur
    const onBlur = (e: FocusEvent) => {
      next = inBox(e.relatedTarget) ? (e.relatedTarget as Element) : null;
    };
    const onArrive = (e: FocusEvent) => {
      focused = e.target as Element;
      next = null;
    };
    // the focus left the box: not for another element of it, nor with the window (the element keeps
    // the focus then)
    const onLeave = (e: FocusEvent) => {
      if (inBox(e.relatedTarget) || inBox(document.activeElement)) return;
      letGo();
    };
    // the focused element was taken away with no blur reaching the box (Firefox and Safari send none,
    // Chromium sends it to the element already taken out): an entry closed by Enter
    const observer = new MutationObserver(() => {
      if (!focused || el.contains(focused) || inBox(document.activeElement)) return;
      if (!next || !el.contains(next)) letGo();
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
    };
  }, [isHeld, box]);
  return shown;
}
