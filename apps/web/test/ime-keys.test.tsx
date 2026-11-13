import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { paletteOpen, registry } from '../src/editor/editor';
import { infoLog } from '../src/editor/runner';
import { registerUiOperators } from '../src/editor/ui-operators';
import { CommandPalette } from '../src/ui/Menu';
import { Console } from '../src/ui/InfoLog';
import { TextBody } from '../src/ui/properties/DataTab';

/*
 * The keys that confirm or cancel an IME composition (Chinese, Japanese, Korean input) belong to the
 * composition: Chrome and Firefox mark them isComposing, Safari sends them after the composition with
 * key code 229. Regression: the operator search ran an operator, the console ran a half-typed command
 * and the text body reverted all its typing on the Enter or Escape that ended a conversion.
 */

afterEach(() => {
  cleanup();
  paletteOpen.value = false;
});

const imeEnter = [
  { key: 'Enter', isComposing: true, keyCode: 229 },
  { key: 'Enter', keyCode: 229 },
];
const imeEscape = [
  { key: 'Escape', isComposing: true, keyCode: 229 },
  { key: 'Escape', keyCode: 229 },
];
/**
 * The Enter (Go) key of Android's Gboard while the word typed last is still its composition: Chrome
 * sends it as a real Enter (key code 13), marked isComposing. It ends the typing like any Enter.
 */
const gboardEnter = { key: 'Enter', keyCode: 13, isComposing: true };

it('the operator search neither runs nor closes on the keys of a composition', async () => {
  if (!registry.has('wm.search_menu')) registerUiOperators(registry);
  const { container } = render(<CommandPalette />);
  await act(async () => {
    paletteOpen.value = true;
  });
  const input = container.querySelector<HTMLInputElement>('[data-testid="palette-input"]')!;
  fireEvent.input(input, { target: { value: 'ぷれ' } });
  for (const k of [...imeEnter, ...imeEscape]) fireEvent.keyDown(input, k);
  expect(paletteOpen.value).toBe(true);
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(paletteOpen.value).toBe(false);
});

it('the console does not run a command on the Enter that ends a composition', () => {
  const { container } = render(<Console />);
  const input = container.querySelector<HTMLInputElement>('[data-testid="console-input"]')!;
  const ran = () => infoLog.value.filter((l) => l.source === 'console' && l.message === '>>> 1 + 1').length;
  const before = ran();
  fireEvent.input(input, { target: { value: '1 + 1' } });
  for (const k of [...imeEnter, ...imeEscape]) fireEvent.keyDown(input, k);
  expect(input.value).toBe('1 + 1');
  expect(ran()).toBe(before);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(ran()).toBe(before + 1);
  expect(input.value).toBe('');
});

it('the text body keeps its typing on the keys of a composition', () => {
  const onCommit = vi.fn(() => true);
  const { container } = render(<TextBody value="Hello" onCommit={onCommit} />);
  const box = container.querySelector<HTMLTextAreaElement>('[data-testid="font-body"]')!;
  box.focus();
  fireEvent.input(box, { target: { value: 'Hello せかい' } });
  for (const k of [...imeEscape, ...imeEnter.map((k) => ({ ...k, ctrlKey: true }))])
    fireEvent.keyDown(box, k);
  expect(box.value).toBe('Hello せかい');
  expect(document.activeElement).toBe(box);
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
  expect(onCommit).toHaveBeenCalledWith('Hello せかい');
});

it('the operator search runs the highlighted operator on the Enter of an Android keyboard', async () => {
  // regression: the search ignored the Enter Gboard sends while the typed word is still its composition
  if (!registry.has('wm.search_menu')) registerUiOperators(registry);
  const { container } = render(<CommandPalette />);
  await act(async () => {
    paletteOpen.value = true;
  });
  const input = container.querySelector<HTMLInputElement>('[data-testid="palette-input"]')!;
  fireEvent.input(input, { target: { value: 'cube' } });
  fireEvent.keyDown(input, gboardEnter);
  expect(paletteOpen.value).toBe(false);
});

it('the console runs the command on the Enter of an Android keyboard', () => {
  // regression: the console ignored the Enter Gboard sends while the typed word is still its composition
  const { container } = render(<Console />);
  const input = container.querySelector<HTMLInputElement>('[data-testid="console-input"]')!;
  const ran = () => infoLog.value.filter((l) => l.source === 'console' && l.message === '>>> 2 + 3').length;
  const before = ran();
  fireEvent.input(input, { target: { value: '2 + 3' } });
  fireEvent.keyDown(input, gboardEnter);
  expect(ran()).toBe(before + 1);
  expect(input.value).toBe('');
});
