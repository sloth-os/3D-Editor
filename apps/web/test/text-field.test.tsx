import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { closeDialog, dialog, openDialog } from '../src/app/store';
import { prefs } from '../src/app/prefs';
import { TextField } from '../src/ui/fields/fields';
import { DialogHost } from '../src/ui/dialogs/Dialogs';

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

  it('commits text left in the field when the field goes away; cancelled or unchanged text is not', () => {
    const onCommit = vi.fn();
    const view = render(<NameField onCommit={onCommit} />);
    const input = field(view.container);
    input.value = 'Left';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    view.unmount();
    expect(onCommit.mock.calls).toEqual([['Left']]);

    onCommit.mockClear();
    const again = render(<NameField onCommit={onCommit} />);
    const box = field(again.container);
    box.focus();
    fireEvent.input(box, { target: { value: 'Typed' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.value).toBe('Cube');
    again.unmount();
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

  it('a field that passes on every key (commitOnBlur off) passes each text once', () => {
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
    expect(onChange.mock.calls).toEqual([['me'], ['metal']]);
  });

  it('a field that its own commit removes commits once', () => {
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
    expect(onCommit.mock.calls).toEqual([['Box']]);
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
