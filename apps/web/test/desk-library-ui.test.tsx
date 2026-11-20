import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import { SceneDoc, SceneEvaluator } from '@3d-editor/core';
import { session as sessionSignal } from '../src/app/store';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import { BottomPane, NARROW_PANEL_SHARE, NARROW_SCREEN, type ExtraBottomTab } from '../src/ui/App';
import { DeskController, type PublishOutcome, type SceneWorkspace } from '../src/embed/controller';
import { deskExtraTabs } from '../src/embed/DeskApp';
import { LibraryTab, linkedWords, publishResultText } from '../src/embed/LibraryTab';
import { SaveToLibraryDialog } from '../src/embed/SaveToLibraryDialog';
import { deskMessageProblems, type DeskMessage, type UnitPublishMessage } from '../src/embed/protocol';
import type { UnitExtract } from '../src/embed/staging-engine';
import type { LibraryRow, SaveTarget } from '../src/embed/units';
import { KITE, MIRA, exampleBrief } from './desk-units-helpers';

// (the service worker's registration is a module of the production build)
vi.mock('../src/pwa/register', () => ({ pwaUpdate: { value: false }, applyPwaUpdate: () => undefined }));

/*
 * The desk's library UI (docs/director-desk.md "The Library tab", "Save to library"): the Library
 * bottom tab only after an open with library units (a page's own bottom tab, after the desk's), its
 * rows (name, kind, version, status in words, Make local on an instance) and Save to library… with
 * the reason it is off; and the Save dialog: its first target (the selected actor or prop, else the
 * set), the name following the target, "Save as a new version of <item> vN" on an instance, the
 * preview (thumbnail, counts, warnings), the progress while the host saves it and what came of it
 * (linked, not linked, not saved), in a read-only open too. The controller is the real one over a
 * fake scene; the host's answers are given by hand. (The real desk page, its worker and a host:
 * e2e/tests/desk-library.spec.ts.)
 */

const UNITS_ON = { units: { version: 1, publish: true } };
const BRIEF = exampleBrief();
const kiteName = BRIEF.elements.find((e) => e.id === KITE)!.name;

const SET: SaveTarget = {
  what: { set: true },
  kind: 'set',
  label: 'The set',
  name: 'Meadow',
  basedOn: null,
  slot: 'set',
};
const MIRA_T: SaveTarget = {
  what: { root: 'mira-root' },
  kind: 'figure',
  label: 'Mira',
  name: 'Mira',
  basedOn: null,
  slot: `cast:${MIRA}`,
};
const KITE_T: SaveTarget = {
  what: { root: 'kite-root' },
  kind: 'prop',
  label: kiteName,
  name: kiteName,
  basedOn: { ref: 'lib_0123456789kite', version: 2, name: kiteName },
  slot: `el:${KITE}`,
};
const TARGETS = [SET, MIRA_T, KITE_T];

const row = (r: Partial<LibraryRow> & Pick<LibraryRow, 'key' | 'name' | 'status' | 'text'>): LibraryRow => ({
  slot: r.key,
  root: null,
  kind: 'prop',
  ref: 'lib_0123456789xxxx',
  version: 1,
  edited: 0,
  pinned: null,
  why: null,
  ...r,
});
const ROWS: LibraryRow[] = [
  row({
    key: 'set',
    kind: 'set',
    name: 'Harbor',
    root: 'set-root',
    version: 3,
    status: 'current',
    text: 'up to date',
  }),
  row({
    key: `cast:${MIRA}`,
    kind: 'figure',
    name: 'Mira',
    root: 'mira-root',
    status: 'edited',
    edited: 2,
    text: '2 parts edited here',
  }),
  row({
    key: `el:${KITE}`,
    name: kiteName,
    version: 2,
    status: 'pending',
    why: 'missing',
    text: 'waiting: its file was not sent; staged from the words',
  }),
  row({ key: 'el:ele_0123456789boat', name: 'Boat', status: 'local', text: 'made local: it stays as it is' }),
];

/** A unit made of the scene (fake bytes: the UI and the protocol's checks only). */
function extraction(t: SaveTarget, name: string, warnings: string[] = []): UnitExtract {
  return {
    data: new Uint8Array(64).fill(7),
    sha256: 'a'.repeat(64),
    header: {
      kind: t.kind,
      name,
      counts: { objects: 3, meshes: 2, triangles: 1234, vertices: 24, faces: 12 },
    } as never,
    meta: {
      dimensionsM: [1, 2, 0.5],
      objects: 3,
      triangles: 1234,
      actor: t.kind === 'figure' ? { kind: 'child', heightM: 1.28 } : null,
      credits: [],
      deskVersion: 'test',
      digest: 'b'.repeat(64),
    },
    link: {} as never,
    from:
      t.slot === 'set'
        ? { set: true }
        : t.slot?.startsWith('cast:')
          ? { castId: t.slot.slice(5) }
          : { elementId: t.slot!.slice(3) },
    basedOn: t.basedOn ? { ref: t.basedOn.ref, version: t.basedOn.version } : null,
    warnings,
    thumbnail: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    thumbnailSize: 256,
  };
}

/** Timers that never fire on their own (the controller's: no ack wait outlives a test). */
function handTimers() {
  const now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      due.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (h: unknown) => void due.delete(h as number),
  };
}

/** The real controller over a fake scene with library units, opened with `options`. */
async function openDesk(
  options: Record<string, unknown> = UNITS_ON,
  extract?: (t: SaveTarget) => UnitExtract,
) {
  const sent: DeskMessage[] = [];
  const ws = {
    open: vi.fn(async () => ({
      source: 'brief' as const,
      changes: null,
      unreadable: null,
      plan: 'stage' as const,
      stageMs: 1,
      persistent: true,
      units: [],
    })),
    encodeState: vi.fn(async () => ({
      state: { format: '3d-editor.desk-state' as const, version: 1 as const, data: new ArrayBuffer(16) },
      shots: 2,
      units: [],
    })),
    onEdit: () => () => {},
    snapshot: () => new Uint8Array([1]),
    stagedShots: () => [],
    lengthMismatches: () => [],
    changes: () => null,
    updateFromBrief: vi.fn(async () => null),
    results: vi.fn(async () => []),
    projectId: 'desk-ui',
    libraryRows: () => ROWS,
    saveTargets: () => TARGETS,
    defaultSaveTarget: (selected: string | null) =>
      TARGETS.find((t) => 'root' in t.what && t.what.root === selected) ?? SET,
    extractUnit: vi.fn(async (what: SaveTarget['what'], name: string) => {
      const t = TARGETS.find((x) => JSON.stringify(x.what) === JSON.stringify(what))!;
      return extract ? extract(t) : extraction(t, name);
    }),
    adoptUnit: vi.fn(async () => ({ root: 'kite-root', recorded: true, warnings: [] })),
    makeLocal: vi.fn(async (root: string) => ({ root, parts: 3 })),
    setBrief: vi.fn(),
    revision: () => 7,
  } satisfies SceneWorkspace;
  const c = new DeskController({
    send: (m) => (sent.push(m), true),
    workspace: ws,
    exportSupport: async () => ({ available: false, reason: 'not in this test' }),
    deskVersion: 'test',
    timers: handTimers(),
    log: () => {},
  });
  await c.connected('https://host.example');
  c.message({ type: 'open', scene: BRIEF, state: null, options: { hostName: 'rideo', ...options } } as never);
  await vi.waitFor(() => expect(sent.some((m) => m.type === 'state')).toBe(true));
  const published = () => sent.filter((m) => m.type === 'unit-publish') as UnitPublishMessage[];
  return { c, ws, sent, published };
}

const q = (root: { container: Element }, id: string) =>
  root.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (root: { container: Element }, id: string) => [
  ...root.container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the Library bottom tab', () => {
  it('is the desk’s only after an open whose host turned library units on', async () => {
    const off = await openDesk({});
    expect(off.c.units.value).toBeNull();
    expect(deskExtraTabs(off.c, () => {})).toEqual([]);
    const on = await openDesk();
    const tabs = deskExtraTabs(on.c, () => {});
    expect(tabs.map((t) => [t.id, t.label, t.panel])).toEqual([['library', 'Library', true]]);
    const v = render(<>{tabs[0].render()}</>);
    expect(q(v, 'desk-library')).not.toBeNull();
  });

  it('lists each unit: name, kind, version and status in words; Make local on instances only', async () => {
    const { c, ws } = await openDesk();
    const v = render(<LibraryTab c={c} onSave={() => {}} />);
    const rows = all(v, 'desk-library-row');
    expect(rows.map((r) => [r.dataset.key, r.dataset.status, r.dataset.kind, r.dataset.version])).toEqual([
      ['set', 'current', 'set', '3'],
      [`cast:${MIRA}`, 'edited', 'figure', '1'],
      [`el:${KITE}`, 'pending', 'prop', '2'],
      ['el:ele_0123456789boat', 'local', 'prop', '1'],
    ]);
    expect(rows.map((r) => q({ container: r }, 'desk-library-name')!.textContent)).toEqual([
      'Harbor',
      'Mira',
      kiteName,
      'Boat',
    ]);
    expect(rows.map((r) => q({ container: r }, 'desk-library-version')!.textContent)).toEqual([
      'v3',
      'v1',
      'v2',
      'v1',
    ]);
    expect(rows.map((r) => q({ container: r }, 'desk-library-status')!.textContent)).toEqual(
      ROWS.map((r) => r.text),
    );
    expect(q(v, 'desk-library-count')!.textContent).toBe('4');
    // Make local on the instances (the set, Mira), not on a slot waiting or made local
    const local = rows.map((r) => !!q({ container: r }, 'desk-library-make-local'));
    expect(local).toEqual([true, true, false, false]);
    await act(async () => void fireEvent.click(q({ container: rows[1] }, 'desk-library-make-local')!));
    await settle();
    expect(ws.makeLocal).toHaveBeenCalledWith('mira-root');
    expect(q(v, 'desk-library-note')!.textContent).toBe(
      'Mira is local now: it stays as it is (Ctrl+Z undoes it).',
    );
  });

  it('says when nothing of the library is in the scene', async () => {
    const { c } = await openDesk();
    c.libraryRows.value = [];
    const v = render(<LibraryTab c={c} onSave={() => {}} />);
    expect(q(v, 'desk-library-list')).toBeNull();
    expect(q(v, 'desk-library-empty')!.textContent).toContain('No library units in this scene yet');
  });

  it('turns Make local off in a read-only open and Save to library off when the host takes no units, with the reasons', async () => {
    const ro = await openDesk({ ...UNITS_ON, readOnly: true });
    const v = render(<LibraryTab c={ro.c} onSave={() => {}} />);
    const make = all(v, 'desk-library-make-local');
    expect(make).toHaveLength(2);
    for (const b of make) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
      expect(b.title).toBe('The scene is read-only here.');
    }
    // a read-only open may save to the library
    expect((q(v, 'desk-library-save') as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    const onSave = vi.fn();
    const noPublish = await openDesk({ units: { version: 1, publish: false } });
    const w = render(<LibraryTab c={noPublish.c} onSave={onSave} />);
    const save = q(w, 'desk-library-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title).toBe('rideo takes no units saved to its library from this scene.');
    expect(q(w, 'desk-library-save-why')!.textContent).toBe(save.title);
    for (const b of all(w, 'desk-library-make-local')) expect((b as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    const on = await openDesk();
    const u = render(<LibraryTab c={on.c} onSave={onSave} />);
    expect(q(u, 'desk-library-save-why')).toBeNull();
    fireEvent.click(q(u, 'desk-library-save')!);
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe('a page’s own bottom tab (BottomPane extraTabs)', () => {
  function fakeSession(): ProjectSession {
    const doc = SceneDoc.create({ empty: true });
    const undo = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    const revision = signal(0);
    doc.onChange(() => revision.value++);
    return {
      doc,
      undo,
      state: new EditorStateSignals(),
      view: new ViewState(),
      evaluator: new SceneEvaluator(doc),
      revision,
      undoRevision: signal(0),
      peers: signal([]),
      currentOperator: null,
    } as unknown as ProjectSession;
  }
  let narrow = false;
  beforeEach(() => {
    sessionSignal.value = fakeSession();
    narrow = false;
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          get matches() {
            expect(query).toBe(NARROW_SCREEN);
            return narrow;
          },
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });
    localStorage.clear();
  });
  afterEach(() => {
    sessionSignal.value = null;
  });

  const LIB: ExtraBottomTab = {
    id: 'library',
    label: 'Library',
    panel: true,
    render: () => <p data-testid="lib">L</p>,
  };
  const pane = (extra: ExtraBottomTab[] | undefined) => (
    <BottomPane
      s={sessionSignal.value!}
      initial="sequence"
      size={150}
      setSize={() => {}}
      tabs={['sequence', 'timeline', 'info']}
      extraTabs={extra}
    />
  );
  const height = (v: { container: Element }) =>
    (v.container.querySelector('.area') as HTMLElement).style.height;

  it('comes after the tabs offered, shows its content, and gives way to the first tab once it goes', async () => {
    const v = render(pane([LIB]));
    const buttons = [...v.container.querySelectorAll('[data-testid^="bottom-tab-"]')].map(
      (b) => b.textContent,
    );
    expect(buttons).toEqual(['Timeline', 'Sequence', 'Info', 'Library']);
    expect(q(v, 'lib')).toBeNull();
    await act(async () => void fireEvent.click(q(v, 'bottom-tab-library')!));
    expect(q(v, 'lib')!.textContent).toBe('L');
    expect(q(v, 'bottom-tab-library')!.className).toContain('open');
    expect(height(v)).toBe('150px');
    // the page takes it away (another open without units): the first tab again
    await act(async () => v.rerender(pane([])));
    await settle();
    expect(q(v, 'bottom-tab-library')).toBeNull();
    expect(q(v, 'lib')).toBeNull();
    expect(q(v, 'bottom-tab-sequence')!.className).toContain('open');
  });

  it('opens the area on a narrow screen as Shots and Assets do, when it says so', async () => {
    narrow = true;
    const v = render(pane([LIB]));
    expect(height(v)).toBe('150px');
    await act(async () => void fireEvent.click(q(v, 'bottom-tab-library')!));
    expect(height(v)).toBe(`${Math.round(800 * NARROW_PANEL_SHARE)}px`);
    cleanup();
    const plain = render(pane([{ ...LIB, panel: false }]));
    await act(async () => void fireEvent.click(q(plain, 'bottom-tab-library')!));
    expect(height(plain)).toBe('150px');
  });
});

describe('the Save to library dialog', () => {
  const dialog = (c: DeskController, selected: string | null = null, onClose = () => {}) =>
    render(<SaveToLibraryDialog c={c} selected={selected} onClose={onClose} />);
  const what = (v: { container: Element }) => q(v, 'desk-save-what') as HTMLSelectElement;
  const name = (v: { container: Element }) => q(v, 'desk-save-name') as HTMLInputElement;
  const choose = (v: { container: Element }, value: string) =>
    act(async () => void fireEvent.change(what(v), { target: { value } }));

  it('starts with the selected actor or prop, else the set; the name follows the target until it is typed', async () => {
    const { c } = await openDesk();
    const v = dialog(c, 'mira-root');
    await settle();
    expect([...what(v).options].map((o) => [o.value, o.textContent])).toEqual([
      ['set', 'The set'],
      ['root:mira-root', 'Mira (actor)'],
      ['root:kite-root', `${kiteName} (prop)`],
    ]);
    expect(what(v).value).toBe('root:mira-root');
    expect(name(v).value).toBe('Mira');
    expect(q(v, 'desk-save-new-item')!.textContent).toBe('A new item in rideo’s library (figure).');
    expect(q(v, 'desk-save-new-version')).toBeNull();
    // an instance of a library unit: a new version of it, ticked
    await choose(v, 'root:kite-root');
    expect(name(v).value).toBe(kiteName);
    const box = q(v, 'desk-save-new-version') as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.parentElement!.textContent).toBe(`Save as a new version of ${kiteName} v2`);
    // a typed name stays when the target changes
    await act(async () => void fireEvent.input(name(v), { target: { value: 'Harbor' } }));
    await choose(v, 'set');
    expect(name(v).value).toBe('Harbor');
    cleanup();
    expect(what(dialog(c, null)).value).toBe('set');
    cleanup();
    expect(what(dialog(c, 'kite-root')).value).toBe('root:kite-root');
  });

  it('shows the unit as it would be saved: thumbnail, counts, size and warnings', async () => {
    const { c, ws } = await openDesk(UNITS_ON, (t) => extraction(t, t.name, ['1 credit was dropped']));
    const v = dialog(c, 'mira-root');
    await settle();
    expect(ws.extractUnit).toHaveBeenCalledWith({ root: 'mira-root' }, 'Mira');
    expect(q(v, 'desk-save-preview')!.dataset.status).toBe('ok');
    expect((q(v, 'desk-save-thumbnail') as HTMLImageElement).src).toMatch(/^blob:/);
    expect(q(v, 'desk-save-counts')!.textContent).toBe(
      '3 objects · 1,234 triangles · 64 B · 1.00 × 2.00 × 0.50 m · child, 1.28 m tall',
    );
    expect(q(v, 'desk-save-warnings')!.textContent).toBe('1 credit was dropped');
  });

  it('cannot save a unit that cannot be made, or one without a name, and says why', async () => {
    const { c } = await openDesk(UNITS_ON, () => {
      throw new Error('the actor has no armature');
    });
    const v = dialog(c, 'mira-root');
    await settle();
    expect(q(v, 'desk-save-preview-error')!.textContent).toBe(
      'The unit cannot be made: the actor has no armature',
    );
    expect((q(v, 'desk-save-submit') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const ok = await openDesk();
    const w = dialog(ok.c, null);
    await settle();
    await act(async () => void fireEvent.input(name(w), { target: { value: '   ' } }));
    expect((q(w, 'desk-save-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(q(w, 'desk-save-why')!.textContent).toBe('A unit needs a name.');
  });

  it('saves a new version of the instance it is: progress while the host saves it, then "linked"', async () => {
    const { c, ws, published } = await openDesk();
    const v = dialog(c, 'kite-root');
    await settle();
    await act(
      async () =>
        void fireEvent.input(q(v, 'desk-save-description')!, { target: { value: 'Red, with a long tail' } }),
    );
    await act(async () => void fireEvent.click(q(v, 'desk-save-submit')!));
    await settle();
    expect(published()).toHaveLength(1);
    const m = published()[0];
    expect(deskMessageProblems(m)).toBeNull();
    expect(m).toMatchObject({
      kind: 'prop',
      name: kiteName,
      description: 'Red, with a long tail',
      newVersionOf: { ref: 'lib_0123456789kite', version: 2 },
      from: { castId: null, elementId: KITE, set: false },
    });
    // the extraction the dialog previewed is the one sent (no second one)
    expect(ws.extractUnit).toHaveBeenCalledTimes(1);
    const progress = q(v, 'desk-save-progress')!;
    expect(progress.dataset.phase).toBe('waiting');
    expect(progress.textContent).toMatch(new RegExp(`^Waiting for rideo to save '${kiteName}'… \\d+ s$`));
    expect((q(v, 'desk-save-submit') as HTMLButtonElement).disabled).toBe(true);
    c.message({ type: 'unit-ack', id: m.id, ok: true, ref: 'lib_0123456789kite', version: 3, linked: true });
    await settle();
    await settle();
    expect(ws.adoptUnit).toHaveBeenCalledTimes(1);
    const result = q(v, 'desk-save-result')!;
    expect(result.dataset.outcome).toBe('linked');
    expect(result.textContent).toBe(`Saved '${kiteName}' v3 to rideo; linked to ${kiteName}`);
    expect(q(v, 'desk-save-submit')).toBeNull();
    expect(q(v, 'desk-save-cancel')!.textContent).toBe('Close');
    // the Library tab says so too
    const tab = render(<LibraryTab c={c} onSave={() => {}} />);
    expect(q(tab, 'desk-library-last')!.textContent).toBe(result.textContent);
  });

  it('saves a new item when unticked; an ack not linked says why', async () => {
    const { c, ws, published } = await openDesk();
    const v = dialog(c, 'kite-root');
    await settle();
    await act(async () => void fireEvent.click(q(v, 'desk-save-new-version')!));
    expect(q(v, 'desk-save-new-item-note')!.textContent).toContain(`a new item in rideo’s library`);
    await act(async () => void fireEvent.click(q(v, 'desk-save-submit')!));
    await settle();
    const m = published()[0];
    expect(m.newVersionOf).toBeUndefined();
    c.message({
      type: 'unit-ack',
      id: m.id,
      ok: true,
      ref: 'lib_0123456789new1',
      version: 1,
      linked: false,
      message: 'The kite keeps its pin.',
    });
    await settle();
    await settle();
    expect(ws.adoptUnit).not.toHaveBeenCalled();
    expect(q(v, 'desk-save-result')!.dataset.outcome).toBe('unlinked');
    expect(q(v, 'desk-save-result')!.textContent).toBe(
      `Saved '${kiteName}' v1 to rideo; not linked: The kite keeps its pin.`,
    );
  });

  it('says the host’s reason when it does not save the unit', async () => {
    const { c, published } = await openDesk();
    const v = dialog(c, null);
    await settle();
    await act(async () => void fireEvent.click(q(v, 'desk-save-submit')!));
    await settle();
    const m = published()[0];
    expect(m).toMatchObject({
      kind: 'set',
      name: 'Meadow',
      from: { castId: null, elementId: null, set: true },
    });
    c.message({
      type: 'unit-ack',
      id: m.id,
      ok: false,
      code: 'refused',
      message: 'Only editors may save here.',
    });
    await settle();
    const result = q(v, 'desk-save-result')!;
    expect(result.dataset.outcome).toBe('failed');
    expect(result.dataset.code).toBe('refused');
    expect(result.textContent).toBe('Not saved: Only editors may save here.');
    const tab = render(<LibraryTab c={c} onSave={() => {}} />);
    expect(q(tab, 'desk-library-last')!.dataset.outcome).toBe('failed');
  });

  it('in a read-only open: says the scene stays as it is, and a linked ack adopts nothing', async () => {
    const { c, ws, published } = await openDesk({ ...UNITS_ON, readOnly: true });
    const v = dialog(c, null);
    await settle();
    expect(q(v, 'desk-save-read-only')!.textContent).toBe(
      'The scene is read-only here: rideo may save the unit, and the scene stays as it is.',
    );
    await act(async () => void fireEvent.click(q(v, 'desk-save-submit')!));
    await settle();
    c.message({
      type: 'unit-ack',
      id: published()[0].id,
      ok: true,
      ref: 'lib_0123456789mead',
      version: 1,
      linked: true,
    });
    await settle();
    expect(ws.adoptUnit).not.toHaveBeenCalled();
    expect(q(v, 'desk-save-result')!.textContent).toBe(
      "Saved 'Meadow' v1 to rideo; not linked here: The scene is read-only here: it stays as it is.",
    );
  });

  it('closes with Escape; a save under way goes on and the Library tab shows how far it is', async () => {
    const onClose = vi.fn();
    const { c, published } = await openDesk();
    const v = dialog(c, null, onClose);
    await settle();
    await act(async () => void fireEvent.click(q(v, 'desk-save-submit')!));
    await settle();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
    const tab = render(<LibraryTab c={c} onSave={() => {}} />);
    expect(q(tab, 'desk-library-publishing')!.dataset.phase).toBe('waiting');
    expect((q(tab, 'desk-library-save') as HTMLButtonElement).disabled).toBe(true);
    c.message({
      type: 'unit-ack',
      id: published()[0].id,
      ok: true,
      ref: 'lib_0123456789mead',
      version: 1,
      linked: true,
    });
    await settle();
    await settle();
    expect(q(tab, 'desk-library-publishing')).toBeNull();
    expect(q(tab, 'desk-library-last')!.textContent).toBe(
      "Saved 'Meadow' v1 to rideo; linked to the scene's place",
    );
  });
});

describe('the words of a Save to library', () => {
  const outcome = (
    result: PublishOutcome['result'],
    kind: PublishOutcome['kind'] = 'set',
  ): PublishOutcome => ({
    result,
    kind,
    name: 'Harbor',
    at: 0,
  });
  it('names where it was linked, and why it was not', () => {
    expect(linkedWords(BRIEF, 'set', 'set')).toBe("the scene's place");
    expect(linkedWords(BRIEF, `cast:${MIRA}`, 'figure')).toBe('Mira');
    expect(linkedWords(BRIEF, `el:${KITE}`, 'prop')).toBe(kiteName);
    expect(linkedWords(BRIEF, null, 'figure')).toBe('its actor');
    const ok = { ok: true as const, ref: 'lib_1', version: 3 };
    expect(
      publishResultText(outcome({ ...ok, linked: true, adopted: true }), 'rideo', "the scene's place"),
    ).toBe("Saved 'Harbor' v3 to rideo; linked to the scene's place");
    expect(publishResultText(outcome({ ...ok, linked: false, adopted: false }), 'rideo', 'x')).toBe(
      "Saved 'Harbor' v3 to rideo; not linked: rideo keeps the scene's pin as it was",
    );
    expect(
      publishResultText(outcome({ ok: false, code: 'timeout', message: 'No answer.' }), 'rideo', 'x'),
    ).toBe('Not saved: No answer.');
  });
});
