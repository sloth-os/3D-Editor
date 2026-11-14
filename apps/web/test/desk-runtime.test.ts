import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperatorRegistry, defineOperator } from '@3d-editor/core';
import { z } from 'zod';
import { DESK_HIDDEN_OPERATORS, DESK_IGNORED_KEYS, deskRefusal, guardRegistry } from '../src/embed/guards';
import { readStorage, writeStorage } from '../src/app/safe-storage';

/*
 * What the embedded desk turns off (embed/guards.ts and the desk runtime): the editor chrome's
 * operators always, every operator that changes the scene in a read-only open (refused in the
 * registry's poll, so every way of running them fails), the keys of the chrome it hides, the
 * editor's preferences (never read or written by the desk), and storage that may be blocked.
 */

const ctx = {} as never;

function registry() {
  const reg = new OperatorRegistry();
  const op = (id: string, undo?: boolean) =>
    reg.register(
      defineOperator({
        id,
        label: id,
        description: id,
        category: 'Test',
        schema: z.object({}),
        ...(undo === undefined ? {} : { undo }),
        execute: () => 'ran',
      }),
    );
  op('object.translate');
  op('view3d.view_axis', false);
  op('screen.frame_set', false);
  op('view3d.transform_modal', false);
  op('wm.preferences', false);
  op('wm.read_homefile');
  return reg;
}

describe('the desk guards', () => {
  it('always refuses the chrome it hides; in read-only also what changes the scene', () => {
    const reg = registry();
    for (const id of ['wm.preferences', 'wm.read_homefile']) {
      expect(deskRefusal(reg, id, false)).toMatch(/not available in the embedded desk/);
      expect(DESK_HIDDEN_OPERATORS.has(id)).toBe(true);
    }
    expect(deskRefusal(reg, 'object.translate', false)).toBeNull();
    expect(deskRefusal(reg, 'object.translate', true)).toMatch(/read-only/);
    // looking around and playing are not edits
    expect(deskRefusal(reg, 'view3d.view_axis', true)).toBeNull();
    expect(deskRefusal(reg, 'screen.frame_set', true)).toBeNull();
    // a modal move starts an edit
    expect(deskRefusal(reg, 'view3d.transform_modal', true)).toMatch(/read-only/);
    expect(deskRefusal(reg, 'no.such_op', true)).toBeNull();
  });

  it('refuses in the poll, so running refuses too, and can be undone', () => {
    const reg = registry();
    let readOnly = false;
    const undo = guardRegistry(reg, () => readOnly);
    expect(reg.poll(ctx, 'object.translate')).toBe(true);
    expect(reg.poll(ctx, 'wm.preferences')).toMatch(/embedded desk/);
    readOnly = true;
    expect(reg.poll(ctx, 'object.translate')).toMatch(/read-only/);
    const doc = { transact: (fn: () => void) => fn() };
    const r = reg.run(
      { doc, report: () => {}, state: { mode: 'OBJECT' }, source: 'ui' } as never,
      'object.translate',
      {},
    );
    expect(r).toMatchObject({ ok: false, code: 'POLL_FAILED' });
    expect(r.error).toMatch(/read-only/);
    undo();
    expect(reg.poll(ctx, 'object.translate')).toBe(true);
    expect(reg.poll(ctx, 'wm.preferences')).toBe(true);
  });

  it('ignores the keys of the chrome it hides', () => {
    for (const k of ['Ctrl+N', 'Ctrl+O', 'Ctrl+,', 'F1', 'F3']) expect(DESK_IGNORED_KEYS.has(k)).toBe(true);
  });
});

describe('the keymap of the desk', () => {
  afterEach(() => vi.resetModules());

  it('leaves the ignored keys alone', async () => {
    const { installKeymap } = await import('../src/editor/keymap');
    const { toasts } = await import('../src/app/store');
    const press = (init: KeyboardEventInit) =>
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
    // without a project, a key that runs an operator says so in a toast
    const plain = installKeymap();
    const before = toasts.value.length;
    press({ key: 'F3', code: 'F3' });
    expect(toasts.value.length).toBe(before + 1);
    plain();
    const desk = installKeymap({ ignore: DESK_IGNORED_KEYS });
    const n = toasts.value.length;
    press({ key: 'F3', code: 'F3' });
    press({ key: 'o', code: 'KeyO', ctrlKey: true });
    press({ key: ',', code: 'Comma', ctrlKey: true });
    expect(toasts.value.length).toBe(n);
    desk();
  });
});

describe('the desk runtime', () => {
  afterEach(() => {
    delete document.documentElement.dataset.runtime;
    vi.resetModules();
    localStorage.clear();
  });

  it("neither reads nor writes the editor's preferences", async () => {
    localStorage.setItem(
      '3d-editor:prefs:v1',
      JSON.stringify({ telemetry: true, sync: { enabled: true, serverUrl: 'https://x' } }),
    );
    document.documentElement.dataset.runtime = 'desk';
    vi.resetModules();
    const { prefs, updatePrefs } = await import('../src/app/prefs');
    expect(prefs.value.telemetry).toBe(false);
    expect(prefs.value.sync.enabled).toBe(false);
    expect(prefs.value.storage.mode).toBe('browser');
    localStorage.removeItem('3d-editor:prefs:v1');
    updatePrefs((p) => ({ ...p, userName: 'Someone' }));
    expect(localStorage.getItem('3d-editor:prefs:v1')).toBeNull();
  });

  it('keeps the editor writing its preferences', async () => {
    vi.resetModules();
    const { updatePrefs } = await import('../src/app/prefs');
    updatePrefs((p) => ({ ...p, userName: 'Editor person' }));
    expect(JSON.parse(localStorage.getItem('3d-editor:prefs:v1')!).userName).toBe('Editor person');
  });

  it('reads and writes nothing, without failing, where storage is blocked', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    try {
      expect(readStorage('k')).toBeNull();
      expect(() => writeStorage('k', 'v')).not.toThrow();
      expect(() => writeStorage('k', null)).not.toThrow();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
    writeStorage('k', 'v');
    expect(readStorage('k')).toBe('v');
    writeStorage('k', null);
    expect(readStorage('k')).toBeNull();
  });
});
