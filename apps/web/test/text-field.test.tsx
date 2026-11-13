import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { closeDialog, dialog, openDialog } from '../src/app/store';
import { prefs } from '../src/app/prefs';
import { TextField } from '../src/ui/fields/fields';
import { DialogHost } from '../src/ui/dialogs/Dialogs';
import { removalLikeChromium, settle } from './removal';

/*
 * What a text field commits and what it shows afterwards: the text in the input (also text a script
 * filled in, such as a password manager), and then the stored value (the new one, or the old one when
 * the edit was refused).
 */

afterEach(() => {
  cleanup();
  closeDialog();
});

/** A field over a stored name that refuses empty names and trims spaces, as the panels' name fields do. */
function NameField(p: { onCommit?: (v: string) => void }) {
  const [name, setName] = useState('Cube');
  return (
    <TextField
      value={name}
      testId="name"
      onChange={(v) => {
        p.onCommit?.(v);
        if (v.trim()) setName(v.trim());
      }}
    />
  );
}

const field = (c: Element) => c.querySelector<HTMLInputElement>('[data-testid="name"]')!;

/** The texts written into the input's value from now on (by Preact or by the field). */
function valueWrites(el: HTMLInputElement): string[] {
  const writes: string[] = [];
  let proto: object | null = Object.getPrototypeOf(el);
  let desc: PropertyDescriptor | undefined;
  while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, 'value')))
    proto = Object.getPrototypeOf(proto);
  const { get, set } = desc!;
  Object.defineProperty(el, 'value', {
    configurable: true,
    get() {
      return get!.call(this);
    },
    set(v: string) {
      writes.push(v);
      set!.call(this, v);
    },
  });
  return writes;
}

describe('after a commit the field shows the stored value', () => {
  it('a refused edit shows the stored value again, after Enter and after leaving the field', () => {
    // regression: the field kept the refused text (an empty name) while the document kept 'Cube'
    const { container } = render(<NameField />);
    const input = field(container);
    input.focus();
    fireEvent.input(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('Cube');
    fireEvent.input(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(input.value).toBe('Cube');
  });

  it('an accepted edit shows what was stored: a normalized name, or the typed one', () => {
    const { container } = render(<NameField />);
    const input = field(container);
    fireEvent.input(input, { target: { value: '  Box ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('Box');
    fireEvent.input(input, { target: { value: 'Crate' } });
    fireEvent.blur(input);
    expect(input.value).toBe('Crate');
  });

  it('an edit stored as typed writes nothing into the input: its caret, selection and undo stay', () => {
    // regression: after Enter the field wrote the old text and then the new one into the input, which
    // moved the caret to the end, dropped the selection and emptied the input's own undo
    const { container } = render(<NameField />);
    const input = field(container);
    input.focus();
    fireEvent.input(input, { target: { value: 'Boxes' } });
    const writes = valueWrites(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(writes).toEqual([]);
    expect(input.value).toBe('Boxes');
    // a normalized or refused edit writes the stored text, once
    fireEvent.input(input, { target: { value: ' Crate ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(writes).toEqual(['Crate']);
    fireEvent.input(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(writes).toEqual(['Crate', 'Crate']);
  });

  it('a refused edit filled in and committed in one go (a script) shows the stored value', () => {
    // regression: the field kept the refused text: the typing and the reset after the commit left
    // its state as rendered, so nothing rendered
    const { container } = render(<NameField />);
    const input = field(container);
    input.focus();
    act(() => {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
    });
    expect(input.value).toBe('Cube');
    // filled in without focus, with input and change events
    act(() => {
      input.value = '  ';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(input.value).toBe('Cube');
  });

  it('commits once: Enter, the change event and the blur that follow it commit nothing more', () => {
    const onCommit = vi.fn();
    const { container } = render(<NameField onCommit={onCommit} />);
    const input = field(container);
    fireEvent.input(input, { target: { value: 'Box' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input);
    fireEvent.blur(input);
    expect(onCommit.mock.calls).toEqual([['Box']]);
  });
});

describe('text filled in by a script', () => {
  it('commits a value filled in with input and change events, without focus or blur (Firefox, Safari)', () => {
    // regression: only Enter and blur committed, so a saved password filled in this way was never stored
    const onCommit = vi.fn();
    const { container } = render(<NameField onCommit={onCommit} />);
    const input = field(container);
    input.value = 'Filled';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onCommit.mock.calls).toEqual([['Filled']]);
  });

  it('commits the filled text when a script fills the field and blurs it before it renders', () => {
    // regression: the blur committed the text the field had rendered (still the old one), so nothing
    const onCommit = vi.fn();
    const { container } = render(<NameField onCommit={onCommit} />);
    const input = field(container);
    input.focus();
    // one synchronous run, as a fill script does: no render between the events
    input.value = 'Scripted';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur();
    expect(onCommit.mock.calls).toEqual([['Scripted']]);
  });

  it('commits text left in the field when the field goes away; cancelled or unchanged text is not', async () => {
    const onCommit = vi.fn();
    const view = render(<NameField onCommit={onCommit} />);
    const input = field(view.container);
    input.value = 'Left';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    view.unmount();
    await settle();
    expect(onCommit.mock.calls).toEqual([['Left']]);

    onCommit.mockClear();
    const again = render(<NameField onCommit={onCommit} />);
    const box = field(again.container);
    box.focus();
    fireEvent.input(box, { target: { value: 'Typed' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.value).toBe('Cube');
    again.unmount();
    await settle();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Escape puts the stored text back in the input at once: a blur right after it commits nothing', () => {
    const onCommit = vi.fn();
    const { container } = render(<NameField onCommit={onCommit} />);
    const input = field(container);
    input.focus();
    fireEvent.input(input, { target: { value: 'Typed' } });
    // one synchronous run: the Escape and a blur before the field renders again
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    input.blur();
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('Cube');
  });

  it('a field that passes on every key (commitOnBlur off) passes each text once', async () => {
    const onChange = vi.fn();
    function Search() {
      const [q, setQ] = useState('');
      return (
        <TextField
          value={q}
          testId="name"
          commitOnBlur={false}
          onChange={(v) => {
            onChange(v);
            setQ(v);
          }}
        />
      );
    }
    const view = render(<Search />);
    const input = field(view.container);
    fireEvent.input(input, { target: { value: 'me' } });
    // one synchronous run: the change and the blur come before the field renders the new text
    input.value = 'metal';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.blur();
    view.unmount();
    await settle();
    expect(onChange.mock.calls).toEqual([['me'], ['metal']]);
  });

  it('a field that its own commit removes commits once', async () => {
    const onCommit = vi.fn();
    function Removed() {
      const [shown, setShown] = useState(true);
      return shown ? (
        <TextField
          value="Cube"
          testId="name"
          onChange={(v) => {
            onCommit(v);
            setShown(false);
          }}
        />
      ) : null;
    }
    const { container } = render(<Removed />);
    const input = field(container);
    fireEvent.input(input, { target: { value: 'Box' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(container.querySelector('[data-testid="name"]')).toBeNull();
    await settle();
    expect(onCommit.mock.calls).toEqual([['Box']]);
  });

  describe('a field taken away while it holds typed text', () => {
    function Hidden(p: { onCommit: (v: string) => void; hide: { current: () => void } }) {
      const [shown, setShown] = useState(true);
      p.hide.current = () => setShown(false);
      return <div>{shown && <TextField value="Cube" testId="name" onChange={p.onCommit} />}</div>;
    }

    it('commits the text once in Chromium, which sends a change event and a blur while removing it', async () => {
      // regression: the commit when the field went away and the change event Chromium sends during
      // the removal both committed the text (two renames, two error toasts when the object was gone)
      const restore = removalLikeChromium();
      try {
        const onCommit = vi.fn();
        const hide = { current: () => {} };
        const { container } = render(<Hidden onCommit={onCommit} hide={hide} />);
        const input = field(container);
        input.focus();
        fireEvent.input(input, { target: { value: 'Box' } });
        act(() => hide.current());
        expect(container.querySelector('[data-testid="name"]')).toBeNull();
        await settle();
        expect(onCommit.mock.calls).toEqual([['Box']]);
      } finally {
        restore();
      }
    });

    it('commits the text once in browsers that send nothing while removing it (Firefox, Safari)', async () => {
      const onCommit = vi.fn();
      const hide = { current: () => {} };
      const { container } = render(<Hidden onCommit={onCommit} hide={hide} />);
      const input = field(container);
      input.focus();
      fireEvent.input(input, { target: { value: 'Box' } });
      act(() => hide.current());
      await settle();
      expect(onCommit.mock.calls).toEqual([['Box']]);
    });
  });
});

describe('Preferences filled in by a password manager', () => {
  beforeEach(() => {
    localStorage.clear();
    prefs.value = {
      ...prefs.value,
      storage: {
        ...prefs.value.storage,
        webdav: { ...prefs.value.storage.webdav, username: '', password: '' },
      },
    };
  });

  const fill = (el: HTMLInputElement, value: string, change: boolean) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (change) el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('stores credentials filled in without focus (input and change), and Done keeps them', async () => {
    // regression: the password was shown in the window but never stored
    const { container } = render(<DialogHost />);
    await act(() => openDialog('preferences'));
    const user = container.querySelector<HTMLInputElement>('[data-testid="webdav-username"]')!;
    const pass = container.querySelector<HTMLInputElement>('[data-testid="webdav-password"]')!;
    fill(user, 'me', true);
    fill(pass, 'secret', true);
    fireEvent.click(container.querySelector('.modal-footer .btn')!);
    expect(dialog.value).toBeNull();
    expect(prefs.value.storage.webdav.username).toBe('me');
    expect(prefs.value.storage.webdav.password).toBe('secret');
  });

  it('stores a password filled in with only an input event when the window closes', async () => {
    const { container } = render(<DialogHost />);
    await act(() => openDialog('preferences'));
    const pass = container.querySelector<HTMLInputElement>('[data-testid="webdav-password"]')!;
    fill(pass, 'secret', false);
    expect(prefs.value.storage.webdav.password).toBe('');
    await act(() => {
      fireEvent.click(container.querySelector('.modal-footer .btn')!);
    });
    expect(dialog.value).toBeNull();
    expect(prefs.value.storage.webdav.password).toBe('secret');
  });
});
