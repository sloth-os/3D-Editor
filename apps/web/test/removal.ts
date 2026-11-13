import { act } from '@testing-library/preact';

/**
 * Makes element removals behave as in Chromium, which sends a focused input it removes (also with an
 * element holding it) a change event and a blur during the removal. happy-dom sends neither, as
 * Firefox and Safari do not. Returns the undo.
 */
export function removalLikeChromium(): () => void {
  const removeChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
    const active = document.activeElement;
    if (
      (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
      child.contains(active)
    ) {
      active.dispatchEvent(new Event('change', { bubbles: true }));
      active.dispatchEvent(new FocusEvent('blur'));
    }
    return removeChild.call(this, child) as T;
  };
  return () => {
    Node.prototype.removeChild = removeChild;
  };
}

/** Lets the commit a text field makes after it went away run (it waits for the end of the task). */
export const settle = () => act(async () => await Promise.resolve());
