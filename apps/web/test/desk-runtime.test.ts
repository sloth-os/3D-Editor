import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { OperatorRegistry, defineOperator, type SceneBrief } from '@3d-editor/core';
import { z } from 'zod';
import { DESK_HIDDEN_OPERATORS, DESK_IGNORED_KEYS, deskRefusal, guardRegistry } from '../src/embed/guards';
import { readStorage, writeStorage } from '../src/app/safe-storage';
import { DeskController, type SceneWorkspace } from '../src/embed/controller';
import type { LengthCheck } from '../src/embed/export';

// (the service worker's registration is a module of the production build)
vi.mock('../src/pwa/register', () => ({ pwaUpdate: { value: false }, applyPwaUpdate: () => undefined }));

/*
 * What the embedded desk turns off (embed/guards.ts and the desk runtime): the editor chrome's
 * operators always, every operator that changes the scene in a read-only open (refused in the
 * registry's poll, so every way of running them fails), the keys of the chrome it hides, the
 * editor's preferences (never read or written by the desk), and storage that may be blocked; and
 * the desk's header: where the state went, the Follow menu in the host's order, Send off for a
 * brief over the export's size, the Send check (the brief's retimed shots apart from the desk's,
 * with Update shots). (The chrome taking the viewport's keys away is checked in a real browser:
 * e2e/tests/desk-embed.spec.ts.)
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

describe("the desk's header", () => {
  afterEach(() => cleanup());

  const brief = {
    id: 'clp_1',
    name: 'Scene',
    fps: 24,
    width: 320,
    height: 180,
    shots: [
      { id: 'sht_a', durationSec: 3 },
      { id: 'sht_b', durationSec: 2 },
    ],
  } as unknown as SceneBrief;

  async function openDesk(options: object, scene: SceneBrief = brief) {
    const ws: SceneWorkspace = {
      open: async () => ({
        source: 'brief',
        changes: null,
        unreadable: null,
        plan: 'stage',
        stageMs: 1,
        persistent: true,
      }),
      encodeState: async () => ({
        state: { format: '3d-editor.desk-state', version: 1, data: new ArrayBuffer(4) },
        shots: 2,
      }),
      onEdit: () => () => {},
      snapshot: () => new Uint8Array([1]),
      stagedShots: () => ['sht_a', 'sht_b'],
      lengthMismatches: () => [],
      changes: () => null,
      updateFromBrief: async () => null,
      results: async () => [],
      projectId: 'desk-1',
    };
    const c = new DeskController({
      send: () => true,
      workspace: ws,
      exportSupport: async () => ({ available: true, reason: null }),
      deskVersion: '1.0.0',
      log: () => {},
    });
    await c.connected('https://host.example');
    c.message({ type: 'open', scene, state: null, options } as never);
    await vi.waitFor(() => expect(c.lastStateAt.value).not.toBeNull());
    return c;
  }

  async function header(c: DeskController, checks: LengthCheck[] = []) {
    const { DeskApp } = await import('../src/embed/DeskApp');
    return render(h(DeskApp, { c, work: null, lengthChecks: () => checks }));
  }

  it("says the state was sent to the host, and lists the host's modes in its order in Follow", async () => {
    const c = await openDesk({ hostName: 'rideo', modes: ['camera', 'pose'] });
    const v = await header(c);
    expect(v.getByTestId('desk-state-sent').textContent).toMatch(/^Sent to rideo just now/);
    const follow = v.getByTestId('desk-mode') as HTMLSelectElement;
    expect([...follow.options].map((o) => o.value)).toEqual(['camera', 'pose']);
    expect(follow.value).toBe('camera');
    fireEvent.change(follow, { target: { value: 'pose' } });
    expect(c.mode.value).toBe('pose');
    expect(v.getByTestId('desk-send').getAttribute('title')).toContain('the Pose reference clip');
  });

  it("lists the brief's changes in words, what else an update acts on too", async () => {
    const { changesText } = await import('../src/embed/DeskApp');
    const changes = {
      added: ['sht_c'],
      removed: [],
      retimed: ['sht_a', 'sht_b'],
      recast: [],
      cast: { added: [], removed: ['chr_x'] },
    };
    expect(changesText(changes)).toBe('1 shot added, 2 shots retimed, 1 cast member removed');
    expect(changesText({ ...changes, other: ['the frame rate (24 to 30 fps)', 'the set'] })).toBe(
      '1 shot added, 2 shots retimed, 1 cast member removed, the frame rate (24 to 30 fps), the set',
    );
  });

  it('offers Close over the work while the scene opens (another desk has it): Close ends the open', async () => {
    const cancelOpen = vi.fn();
    const sent: string[] = [];
    const ws: SceneWorkspace = {
      // another desk of this browser has the scene: the open waits
      open: () => new Promise(() => {}),
      encodeState: async () => ({
        state: { format: '3d-editor.desk-state', version: 1, data: new ArrayBuffer(4) },
        shots: 2,
      }),
      onEdit: () => () => {},
      snapshot: () => new Uint8Array([1]),
      stagedShots: () => [],
      lengthMismatches: () => [],
      changes: () => null,
      updateFromBrief: async () => null,
      results: async () => [],
      projectId: null,
      cancelOpen,
    };
    const c = new DeskController({
      send: (m) => (sent.push(m.type), true),
      workspace: ws,
      exportSupport: async () => ({ available: true, reason: null }),
      deskVersion: '1.0.0',
      log: () => {},
    });
    await c.connected('https://host.example');
    c.message({ type: 'open', scene: brief, state: null } as never);
    await vi.waitFor(() => expect(c.status.value).toBe('opening'));
    const { DeskApp } = await import('../src/embed/DeskApp');
    const { OTHER_DESK_WAIT } = await import('../src/embed/workspace');
    const v = render(
      h(DeskApp, { c, work: { label: OTHER_DESK_WAIT, startedAt: Date.now() }, lengthChecks: () => [] }),
    );
    expect(v.getByTestId('desk-work').textContent).toContain('open in another tab');
    fireEvent.click(v.getByTestId('desk-work-close'));
    await vi.waitFor(() => expect(c.status.value).toBe('closed'));
    expect(cancelOpen).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(['ready', 'close']);
    // once the scene is open, the work of an update offers no Close (the header has it)
    cleanup();
    const open = await openDesk({ hostName: 'rideo' });
    const { DeskApp: App } = await import('../src/embed/DeskApp');
    const u = render(
      h(App, {
        c: open,
        work: { label: 'Updating 2 shots from the brief…', startedAt: 0 },
        lengthChecks: () => [],
      }),
    );
    expect(u.getByTestId('desk-work')).toBeTruthy();
    expect(u.queryByTestId('desk-work-close')).toBeNull();
  });

  it("turns Send off for a brief over the export's size and says why", async () => {
    const c = await openDesk({ hostName: 'rideo' }, { ...brief, width: 2160, height: 3840 } as SceneBrief);
    const v = await header(c);
    const send = v.getByTestId('desk-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.getAttribute('title')).toContain('2160 × 3840, too high');
  });

  it("asks before a Send whose clips the host refuses: the brief's retimed shots apart from the desk's", async () => {
    const c = await openDesk({ hostName: 'rideo' });
    const update = vi.spyOn(c, 'updateShots').mockResolvedValue();
    const send = vi.spyOn(c, 'sendToHost').mockResolvedValue(null);
    const checks: LengthCheck[] = [
      { shotId: 'sht_a', name: 'Opening', frames: 72, briefFrames: 84, byBrief: true },
      { shotId: 'sht_b', name: 'Reply', frames: 60, briefFrames: 48, byBrief: false },
    ];
    const v = await header(c, checks);
    fireEvent.click(v.getByTestId('desk-send'));
    expect(send).not.toHaveBeenCalled();
    expect(v.getByTestId('desk-send-check-brief').textContent).toContain(
      'The brief changed the length of this shot',
    );
    expect(v.getByTestId('desk-send-check-brief').textContent).toContain('Opening');
    expect(v.getByTestId('desk-send-check-desk').textContent).toContain('made longer or shorter here');
    expect(v.getByTestId('desk-send-check-desk').textContent).toContain('Reply');
    fireEvent.click(v.getByTestId('desk-send-check-update'));
    expect(update).toHaveBeenCalledTimes(1);
    expect(v.queryByTestId('desk-send-check')).toBeNull();
    // read-only: no Update shots, and it says why the clips are refused
    cleanup();
    const ro = await openDesk({ hostName: 'rideo', readOnly: true });
    const r = await header(ro, checks);
    fireEvent.click(r.getByTestId('desk-send'));
    expect(r.queryByTestId('desk-send-check-update')).toBeNull();
    expect(r.getByTestId('desk-send-check-brief').textContent).toContain('read-only here');
    fireEvent.click(r.getByTestId('desk-send-check-send'));
    expect(r.queryByTestId('desk-send-check')).toBeNull();
  });
});
