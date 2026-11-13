import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { NumberField, TextField } from '../src/ui/fields/fields';

afterEach(cleanup);

/** Opens the text entry of a number field (click without dragging) and types `text`. */
function typeInto(el: HTMLElement, text: string): HTMLInputElement {
  fireEvent.pointerDown(el, { button: 0, clientX: 10, pointerId: 1 });
  fireEvent.pointerUp(el, { button: 0, clientX: 10, pointerId: 1 });
  const input = el.querySelector('input')!;
  fireEvent.input(input, { target: { value: text } });
  return input;
}

describe('number field text entry', () => {
  it('commits a typed value once: the blur of the removed input does not commit it again', async () => {
    const onChange = vi.fn();
    const { getByTestId } = render(<NumberField value={1} onChange={onChange} testId="nf" />);
    const input = typeInto(getByTestId('nf'), '2');
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => undefined);
    // Chromium fires blur when the focused input is removed from the page
    fireEvent.blur(input);
    expect(onChange.mock.calls).toEqual([[2, true]]);
  });

  it('Escape cancels the entry without committing it on blur', async () => {
    const onChange = vi.fn();
    const { getByTestId } = render(<NumberField value={1} onChange={onChange} testId="nf" />);
    const input = typeInto(getByTestId('nf'), '5');
    fireEvent.keyDown(input, { key: 'Escape' });
    await act(async () => undefined);
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clicking elsewhere still commits the typed value', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(<NumberField value={1} onChange={onChange} testId="nf" />);
    const input = typeInto(getByTestId('nf'), '3');
    fireEvent.blur(input);
    expect(onChange.mock.calls).toEqual([[3, true]]);
  });
});

/** Types `text` key by key into a focused input, as a browser does: each key replaces the selection. */
function typeKeys(input: HTMLInputElement, text: string): void {
  for (const ch of text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + ch + input.value.slice(end);
    input.setSelectionRange(start + 1, start + 1);
    fireEvent.input(input);
  }
}

describe('typing key by key', () => {
  it('keeps every typed key of a number entry', () => {
    // regression: the entry selected its text again on every render, and every typed key renders
    // the field, so each key replaced the ones before it ("1.5" typed key by key gave 5)
    const onChange = vi.fn();
    const { getByTestId } = render(<NumberField value={0} onChange={onChange} testId="nf" />);
    const el = getByTestId('nf');
    fireEvent.pointerDown(el, { button: 0, clientX: 10, pointerId: 1 });
    fireEvent.pointerUp(el, { button: 0, clientX: 10, pointerId: 1 });
    const input = el.querySelector('input')!;
    // the whole value is selected when the entry opens, so the first key replaces it
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 1]);
    typeKeys(input, '1.5');
    expect(input.value).toBe('1.5');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange.mock.calls).toEqual([[1.5, true]]);
  });

  it('commits the text a script typed and confirmed before the entry rendered it', () => {
    // regression: Enter committed the text the entry had rendered (the old value)
    const onChange = vi.fn();
    const { getByTestId } = render(<NumberField value={0} onChange={onChange} testId="nf" />);
    const el = getByTestId('nf');
    fireEvent.pointerDown(el, { button: 0, clientX: 10, pointerId: 1 });
    fireEvent.pointerUp(el, { button: 0, clientX: 10, pointerId: 1 });
    const input = el.querySelector('input')!;
    input.value = '7';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onChange.mock.calls).toEqual([[7, true]]);
  });

  it('keeps the typed keys of a number entry when the field renders for another reason', () => {
    const onChange = vi.fn();
    const { getByTestId, rerender } = render(<NumberField value={0} onChange={onChange} testId="nf" />);
    const el = getByTestId('nf');
    fireEvent.pointerDown(el, { button: 0, clientX: 10, pointerId: 1 });
    fireEvent.pointerUp(el, { button: 0, clientX: 10, pointerId: 1 });
    const input = el.querySelector('input')!;
    typeKeys(input, '2');
    // e.g. an agent changes something the panel shows
    rerender(<NumberField value={0} onChange={onChange} testId="nf" title="other" />);
    typeKeys(input, '5');
    expect(input.value).toBe('25');
  });
});

describe('IME composition', () => {
  it('the keys that confirm or cancel a composition do not commit, cancel or close anything', () => {
    const onChange = vi.fn();
    const outside = vi.fn();
    window.addEventListener('keydown', outside);
    try {
      const { getByTestId, container } = render(
        <>
          <TextField value="Cube" onChange={onChange} testId="tf" />
          <NumberField value={1} onChange={onChange} testId="nf" />
        </>,
      );
      const text = getByTestId('tf') as HTMLInputElement;
      text.focus();
      fireEvent.input(text, { target: { value: 'Cubeかな' } });
      // Chrome and Firefox mark them isComposing; Safari sends them after the composition, with key code 229
      fireEvent.keyDown(text, { key: 'Enter', isComposing: true });
      fireEvent.keyDown(text, { key: 'Enter', keyCode: 229 });
      fireEvent.keyDown(text, { key: 'Escape', isComposing: true });
      fireEvent.keyDown(text, { key: 'Escape', keyCode: 229 });
      expect(onChange).not.toHaveBeenCalled();
      expect(text.value).toBe('Cubeかな');
      fireEvent.keyDown(text, { key: 'Enter' });
      expect(onChange.mock.calls).toEqual([['Cubeかな']]);

      const nf = getByTestId('nf');
      fireEvent.pointerDown(nf, { button: 0, clientX: 10, pointerId: 1 });
      fireEvent.pointerUp(nf, { button: 0, clientX: 10, pointerId: 1 });
      const entry = nf.querySelector('input')!;
      fireEvent.input(entry, { target: { value: '２' } });
      fireEvent.keyDown(entry, { key: 'Enter', isComposing: true });
      fireEvent.keyDown(entry, { key: 'Escape', keyCode: 229 });
      expect(container.querySelector('[data-testid="nf"] input')).toBe(entry);
      expect(onChange.mock.calls).toHaveLength(1);
      // none of them reached the window (the editor keymap, a window's Escape)
      expect(outside).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', outside);
    }
  });

  it('the Enter of an Android keyboard that still composes the typed word commits', () => {
    // regression: Gboard keeps the word typed last as a composition, and Chrome sends its Enter (Go)
    // as a real Enter (key code 13) marked isComposing: the fields ignored it
    const gboardEnter = { key: 'Enter', keyCode: 13, isComposing: true };
    const onChange = vi.fn();
    const { getByTestId } = render(
      <>
        <TextField value="Cube" onChange={onChange} testId="tf" />
        <NumberField value={1} onChange={onChange} testId="nf" />
      </>,
    );
    const text = getByTestId('tf') as HTMLInputElement;
    text.focus();
    fireEvent.input(text, { target: { value: 'Crate' } });
    fireEvent.keyDown(text, gboardEnter);
    expect(onChange.mock.calls).toEqual([['Crate']]);

    const nf = getByTestId('nf');
    fireEvent.pointerDown(nf, { button: 0, clientX: 10, pointerId: 1 });
    fireEvent.pointerUp(nf, { button: 0, clientX: 10, pointerId: 1 });
    const entry = nf.querySelector('input')!;
    fireEvent.input(entry, { target: { value: '3' } });
    fireEvent.keyDown(entry, gboardEnter);
    expect(nf.querySelector('input')).toBeNull();
    expect(onChange.mock.calls[1]).toEqual([3, true]);
  });
});
