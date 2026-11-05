import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { NumberField } from '../src/ui/fields/fields';

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
