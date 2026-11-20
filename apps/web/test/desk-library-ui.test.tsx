import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import {
  SceneDoc,
  SceneEvaluator,
  adoptPublished,
  decodePNG,
  extractUnit,
  stageBrief,
  unitSourceOf,
  type BriefUnitPin,
  type SceneBrief,
  type UnitSpec,
} from '@3d-editor/core';
import { session as sessionSignal, toasts } from '../src/app/store';
import { installKeymap } from '../src/editor/keymap';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import { BottomPane, NARROW_PANEL_SHARE, NARROW_SCREEN, type ExtraBottomTab } from '../src/ui/App';
import { DeskController, type PublishOutcome, type SceneWorkspace } from '../src/embed/controller';
import { DeskApp, deskExtraTabs, deskModals } from '../src/embed/DeskApp';
import type { LengthCheck } from '../src/embed/export';
import { DESK_IGNORED_KEYS } from '../src/embed/guards';
import { LibraryTab, linkedWords, publishOutcome, publishResultText } from '../src/embed/LibraryTab';
import { SaveToLibraryDialog } from '../src/embed/SaveToLibraryDialog';
import {
  PUBLISH_ACK_BASE_MS,
  deskMessageProblems,
  type DeskMessage,
  type UnitPublishMessage,
} from '../src/embed/protocol';
import { renderUnitThumbnail, type UnitExtract } from '../src/embed/staging-engine';
import {
  defaultSaveTarget as unitDefaultTarget,
  libraryRows as unitLibraryRows,
  saveTargets as unitSaveTargets,
  type LibraryRow,
  type SaveTarget,
} from '../src/embed/units';
import { KITE, MIRA, exampleBrief, library, stagedDoc, withPins, type Lib } from './desk-units-helpers';

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

/**
 * Timers that never fire on their own (the controller's: no ack wait outlives a test); `fire(ms)`
 * runs those set for at least `ms` (the wait for a host's answer) as if their time had come.
 */
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
    fire(ms: number) {
      for (const [k, t] of [...due])
        if (t.at >= ms) {
          due.delete(k);
          t.fn();
        }
    },
  };
}

/** The real controller over the workspace `ws`, opened with `options` (the messages it sent). */
async function connect(
  ws: SceneWorkspace,
  options: Record<string, unknown> = UNITS_ON,
  timers = handTimers(),
  brief: SceneBrief = BRIEF,
) {
  const sent: DeskMessage[] = [];
  const c = new DeskController({
    send: (m) => (sent.push(m), true),
    workspace: ws,
    exportSupport: async () => ({ available: false, reason: 'not in this test' }),
    deskVersion: 'test',
    timers,
    log: () => {},
  });
  await c.connected('https://host.example');
  c.message({ type: 'open', scene: brief, state: null, options: { hostName: 'rideo', ...options } } as never);
  await vi.waitFor(() => expect(sent.some((m) => m.type === 'state')).toBe(true));
  const published = () => sent.filter((m) => m.type === 'unit-publish') as UnitPublishMessage[];
  return { c, sent, published, timers };
}

/** The real controller over a fake scene with library units, opened with `options`. */
async function openDesk(
  options: Record<string, unknown> = UNITS_ON,
  extract?: (t: SaveTarget) => UnitExtract,
  timers = handTimers(),
) {
  // the instances made local: their rows say so and name no root (as units.ts libraryRows)
  const local = new Set<string>();
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
    libraryRows: () =>
      ROWS.map((r) =>
        r.root && local.has(r.root)
          ? { ...r, root: null, status: 'local' as const, edited: 0, text: 'made local: it stays as it is' }
          : r,
      ),
    saveTargets: () => TARGETS,
    defaultSaveTarget: (selected: string | null) =>
      TARGETS.find((t) => 'root' in t.what && t.what.root === selected) ?? SET,
    extractUnit: vi.fn(async (what: SaveTarget['what'], name: string) => {
      const t = TARGETS.find((x) => JSON.stringify(x.what) === JSON.stringify(what))!;
      return extract ? extract(t) : extraction(t, name);
    }),
    adoptUnit: vi.fn(async () => ({ root: 'kite-root', recorded: true, warnings: [] })),
    makeLocal: vi.fn(async (root: string) => (local.add(root), { root, parts: 3 })),
    setBrief: vi.fn(),
    revision: () => 7,
  } satisfies SceneWorkspace;
  const opened = await connect(ws, options, timers);
  /** Ctrl+Z of a Make local: the instance is linked again (as the controller refreshes after an edit). */
  const undoLocal = (root: string) => {
    local.delete(root);
    opened.c.libraryRows.value = ws.libraryRows();
  };
  return { ...opened, ws, undoLocal };
}

/**
 * A SceneWorkspace over a real core document staged from `brief0` (with the files of `units`): the
 * Library tab's rows, the targets and the unit made of the scene as units.ts and core make them,
 * and a linked save adopted by core (no worker, no thumbnail).
 */
function realWorkspace(brief0: SceneBrief, units: Lib[] = []) {
  const doc = SceneDoc.create({ empty: true });
  const given = units.map((u) => ({ ...u.pin, data: u.data }));
  stageBrief(doc, brief0, given.length ? { units: unitSourceOf(given) } : {});
  let brief = brief0;
  let revision = 0;
  doc.ydoc.on('update', () => revision++);
  const spec = (what: SaveTarget['what'], name: string): UnitSpec => {
    if ('set' in what) return { kind: 'set', name };
    const role = String(doc.getObject(what.root)?.custom_props?.desk_role ?? '');
    return role === 'actor'
      ? { kind: 'figure', actor: what.root, name }
      : { kind: 'prop', root: what.root, name };
  };
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
    projectId: 'desk-ui-real',
    libraryRows: () => unitLibraryRows(doc, brief, () => false),
    saveTargets: () => unitSaveTargets(doc, brief),
    defaultSaveTarget: (selected: string | null) =>
      unitDefaultTarget(doc, unitSaveTargets(doc, brief), selected),
    extractUnit: vi.fn(async (what: SaveTarget['what'], name: string): Promise<UnitExtract> => {
      const ex = extractUnit(doc, spec(what, name), { deskVersion: 'test' });
      ex.probe.destroy();
      const { data, sha256, header, meta, link, from, basedOn, warnings } = ex;
      return {
        data,
        sha256,
        header,
        meta,
        link,
        from,
        basedOn,
        warnings,
        thumbnail: null,
        thumbnailSize: null,
      };
    }),
    adoptUnit: vi.fn(
      async (unit: Pick<UnitExtract, 'link' | 'from' | 'header'>, pin: BriefUnitPin, linked: boolean) =>
        adoptPublished(doc, brief, { slot: unit.from, link: unit.link, pin, linked, header: unit.header }),
    ),
    makeLocal: vi.fn(async (root: string) => ({ root, parts: 0 })),
    setBrief: (b: SceneBrief) => void (brief = b),
    revision: () => revision,
  } satisfies SceneWorkspace;
  return { ws, doc };
}

/**
 * The share of an RGBA image's drawn pixels (alpha above 0) within 12 of its most common drawn colour
 * in each channel: near 1 for a blank, one-colour square.
 */
function dominantShare(px: Uint8Array | Uint8ClampedArray): number {
  const counts = new Map<number, number>();
  for (let i = 0; i < px.length; i += 4)
    if (px[i + 3] > 0) {
      const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  let top = 0;
  let most = -1;
  for (const [k, n] of counts) if (n > most) [top, most] = [k, n];
  const rgb = [top >> 16, (top >> 8) & 255, top & 255];
  let drawn = 0;
  let near = 0;
  for (let i = 0; i < px.length; i += 4)
    if (px[i + 3] > 0) {
      drawn++;
      if (rgb.every((v, c) => Math.abs(px[i + c] - v) <= 12)) near++;
    }
  return drawn ? near / drawn : 1;
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

  it('takes back "is local now" once Ctrl+Z links the instance again', async () => {
    const { c, undoLocal } = await openDesk();
    const v = render(<LibraryTab c={c} onSave={() => {}} />);
    const mira = () => v.container.querySelector<HTMLElement>(`[data-key="cast:${MIRA}"]`)!;
    await act(async () => void fireEvent.click(q({ container: mira() }, 'desk-library-make-local')!));
    await settle();
    expect(mira().dataset.status).toBe('local');
    expect(q(v, 'desk-library-note')!.textContent).toBe(
      'Mira is local now: it stays as it is (Ctrl+Z undoes it).',
    );
    // other rows changing leave it as it is
    await act(async () => void (c.libraryRows.value = c.libraryRows.value.slice()));
    expect(q(v, 'desk-library-note')).not.toBeNull();
    // Ctrl+Z: the row is Mira's instance again
    await act(async () => undoLocal('mira-root'));
    expect(mira().dataset.status).toBe('edited');
    expect(q(v, 'desk-library-note')).toBeNull();
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
    // an instance of a library unit: a new version of it, ticked, under its item's name (read-only)
    await choose(v, 'root:kite-root');
    expect([name(v).value, name(v).readOnly]).toEqual([kiteName, true]);
    const box = q(v, 'desk-save-new-version') as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.parentElement!.textContent).toBe(`Save as a new version of ${kiteName} v2`);
    // a typed name stays when the target changes
    await choose(v, 'set');
    expect(name(v).readOnly).toBe(false);
    await act(async () => void fireEvent.input(name(v), { target: { value: 'Harbor' } }));
    await choose(v, 'root:mira-root');
    expect(name(v).value).toBe('Harbor');
    // and comes back when a new version, which keeps its item's name, is unticked: a new item
    await choose(v, 'root:kite-root');
    expect([name(v).value, name(v).readOnly]).toEqual([kiteName, true]);
    await act(async () => void fireEvent.click(q(v, 'desk-save-new-version')!));
    expect([name(v).value, name(v).readOnly]).toEqual(['Harbor', false]);
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

  it("saves a new version under its item's name, not one typed for another target; the description is its note", async () => {
    const { c, published } = await openDesk();
    const v = dialog(c, 'mira-root');
    await settle();
    await act(async () => void fireEvent.input(name(v), { target: { value: 'Harbor' } }));
    await choose(v, 'root:kite-root');
    // the host keeps its item's name for a new version: the dialog shows it, and sends it
    expect([name(v).value, name(v).readOnly]).toEqual([kiteName, true]);
    expect(name(v).title).toBe(`A new version keeps the name of ${kiteName}`);
    await act(
      async () =>
        void fireEvent.input(q(v, 'desk-save-description')!, { target: { value: 'A longer tail' } }),
    );
    await act(async () => void fireEvent.click(q(v, 'desk-save-submit')!));
    await settle();
    expect(published()).toHaveLength(1);
    const m = published()[0];
    expect(m).toMatchObject({
      name: kiteName,
      description: 'A longer tail',
      newVersionOf: { ref: 'lib_0123456789kite', version: 2 },
    });
    expect(q(v, 'desk-save-progress')!.textContent).toMatch(
      new RegExp(`^Waiting for rideo to save '${kiteName}'… \\d+ s$`),
    );
    c.message({ type: 'unit-ack', id: m.id, ok: true, ref: 'lib_0123456789kite', version: 3, linked: true });
    await settle();
    await settle();
    // the notice names the item, as the Library tab does
    const result = q(v, 'desk-save-result')!;
    expect(result.textContent).toBe(`Saved '${kiteName}' v3 to rideo; linked to ${kiteName}`);
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

  it('after a save the host linked, offers the same target as a new version of what it saved', async () => {
    const { ws, doc } = realWorkspace(exampleBrief());
    const { c, published } = await connect(ws);
    const v = dialog(c, null);
    await settle();
    expect(q(v, 'desk-save-new-item')!.textContent).toBe('A new item in rideo’s library (set).');
    await act(async () => void fireEvent.input(name(v), { target: { value: 'Harbor' } }));
    await act(async () => void fireEvent.click(q(v, 'desk-save-submit')!));
    await vi.waitFor(() => expect(published()).toHaveLength(1));
    expect(published()[0].newVersionOf).toBeUndefined();
    c.message({
      type: 'unit-ack',
      id: published()[0].id,
      ok: true,
      ref: 'lib_harbor000001',
      version: 1,
      linked: true,
    });
    await vi.waitFor(() =>
      expect(q(v, 'desk-save-result')?.textContent).toBe(
        "Saved 'Harbor' v1 to rideo; linked to the scene's place",
      ),
    );
    // the set is an instance of Harbor v1 now: chosen again, it is offered as a new version of it
    await choose(v, [...what(v).options].find((o) => o.textContent === 'Mira (actor)')!.value);
    await choose(v, 'set');
    const box = q(v, 'desk-save-new-version') as HTMLInputElement | null;
    expect(box?.parentElement?.textContent).toBe('Save as a new version of Harbor v1');
    expect(box!.checked).toBe(true);
    expect(q(v, 'desk-save-new-item')).toBeNull();
    expect(name(v).value).toBe('Harbor');
    await act(async () => void fireEvent.click(q(v, 'desk-save-submit')!));
    await vi.waitFor(() => expect(published()).toHaveLength(2));
    expect(published()[1].newVersionOf).toEqual({ ref: 'lib_harbor000001', version: 1 });
    doc.destroy();
  }, 60_000);

  it('after a new version the host linked, names that version when the target is chosen again', async () => {
    const lib = library();
    const brief = withPins(exampleBrief(), { set: lib.set });
    const { ws, doc } = realWorkspace(brief, [lib.set]);
    const { c, published } = await connect(ws, UNITS_ON, handTimers(), brief);
    const v = dialog(c, null);
    await settle();
    expect(q(v, 'desk-save-new-version')!.parentElement!.textContent).toBe(
      'Save as a new version of Meadow v1',
    );
    await act(async () => void fireEvent.click(q(v, 'desk-save-submit')!));
    await vi.waitFor(() => expect(published()).toHaveLength(1));
    expect(published()[0].newVersionOf).toEqual({ ref: lib.set.pin.ref, version: 1 });
    c.message({
      type: 'unit-ack',
      id: published()[0].id,
      ok: true,
      ref: lib.set.pin.ref,
      version: 2,
      linked: true,
    });
    await vi.waitFor(() =>
      expect(q(v, 'desk-save-result')?.textContent).toBe(
        "Saved 'Meadow' v2 to rideo; linked to the scene's place",
      ),
    );
    await choose(v, [...what(v).options].find((o) => o.textContent === 'Mira (actor)')!.value);
    await choose(v, 'set');
    expect(q(v, 'desk-save-new-version')!.parentElement!.textContent).toBe(
      'Save as a new version of Meadow v2',
    );
    await act(async () => void fireEvent.click(q(v, 'desk-save-submit')!));
    await vi.waitFor(() => expect(published()).toHaveLength(2));
    expect(published()[1].newVersionOf).toEqual({ ref: lib.set.pin.ref, version: 2 });
    doc.destroy();
  }, 60_000);

  it('says it is not known whether the host saved a unit it did not answer for in time', async () => {
    const timers = handTimers();
    const { c, published } = await openDesk(UNITS_ON, undefined, timers);
    const v = dialog(c, null);
    await settle();
    await act(async () => void fireEvent.click(q(v, 'desk-save-submit')!));
    await settle();
    expect(published()).toHaveLength(1);
    // the wait for rideo's answer ends (120 s and more): rideo may still save and link it
    await act(async () => timers.fire(PUBLISH_ACK_BASE_MS));
    await settle();
    const result = q(v, 'desk-save-result')!;
    const words =
      "Not known whether rideo saved 'Meadow': it did not answer in time. Look in its library before saving again.";
    expect([result.dataset.outcome, result.dataset.code, result.textContent]).toEqual([
      'unknown',
      'timeout',
      words,
    ]);
    const tab = render(<LibraryTab c={c} onSave={() => {}} />);
    expect(q(tab, 'desk-library-last')!.dataset.outcome).toBe('unknown');
    expect(q(tab, 'desk-library-last')!.textContent).toBe(words);
  });

  it('says "Not saved" with the host’s reason when the host refuses with a code of the desk’s own', async () => {
    const { c, published } = await openDesk(UNITS_ON);
    const v = dialog(c, null);
    await settle();
    await act(async () => void fireEvent.click(q(v, 'desk-save-submit')!));
    await settle();
    expect(published()).toHaveLength(1);
    // a host may answer any code: 'closed' here is its own (its library is closed), not the desk's
    const message = 'The library is closed for maintenance.';
    await act(async () =>
      c.message({ type: 'unit-ack', id: published()[0].id, ok: false, code: 'closed', message }),
    );
    await settle();
    const result = q(v, 'desk-save-result')!;
    expect([result.dataset.outcome, result.dataset.code, result.textContent]).toEqual([
      'failed',
      'closed',
      `Not saved: ${message}`,
    ]);
    expect(c.lastPublish.value!.result).toEqual({ ok: false, code: 'closed', message });
    const tab = render(<LibraryTab c={c} onSave={() => {}} />);
    expect(q(tab, 'desk-library-last')!.dataset.outcome).toBe('failed');
    expect(q(tab, 'desk-library-last')!.textContent).toBe(`Not saved: ${message}`);
  });

  it('leaves the Escape that ends an IME composition, and a held Escape’s repeats, to the field', async () => {
    const onClose = vi.fn();
    const { c } = await openDesk();
    const v = dialog(c, null, onClose);
    await settle();
    const field = name(v);
    field.focus();
    const escape = (init: KeyboardEventInit & { keyCode?: number }) =>
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }),
      );
    // Chrome and Firefox: the Escape that cancels a candidate; Safari: the one after the composition
    escape({ isComposing: true, keyCode: 229 });
    escape({ keyCode: 229 });
    escape({ repeat: true });
    expect(onClose).not.toHaveBeenCalled();
    escape({});
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('takes the focus, keeps Tab inside, and gives the focus back to what opened it', async () => {
    const { c } = await openDesk();
    const opener = document.createElement('button');
    opener.textContent = 'Save to library…';
    const behind = document.createElement('button');
    behind.textContent = 'Make local';
    document.body.append(opener, behind);
    opener.focus();
    const v = dialog(c, null);
    await settle();
    const box = v.container.querySelector<HTMLElement>('[role="dialog"]')!;
    const inside = () => box.contains(document.activeElement);
    expect(inside()).toBe(true);
    const tab = (shift = false) =>
      act(() => {
        const e = new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: shift,
          bubbles: true,
          cancelable: true,
        });
        (document.activeElement ?? document.body).dispatchEvent(e);
      });
    // from the dialog itself: Shift+Tab goes to its last control, not to what is behind it
    await tab(true);
    expect(document.activeElement).toBe(q(v, 'desk-save-submit'));
    // from the last control Tab wraps to the first, and Shift+Tab back
    await tab();
    expect(document.activeElement).toBe(what(v));
    await tab(true);
    expect(document.activeElement).toBe(q(v, 'desk-save-submit'));
    // the focus taken away (behind the dialog): Tab brings it back
    behind.focus();
    await tab();
    expect(document.activeElement).toBe(what(v));
    v.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
    behind.remove();
  });

  it('shows a set’s colours, not a grey square: no one colour covers 97% of its thumbnail', () => {
    const doc = stagedDoc();
    const kite = doc
      .listObjects()
      .find((o) => o.custom_props?.desk_element_id === KITE && o.custom_props?.desk_role === 'prop')!;
    for (const spec of [
      { kind: 'set' as const, name: 'Meadow' },
      { kind: 'prop' as const, root: kite.id, name: 'Kite' },
    ]) {
      const ex = extractUnit(doc, spec, { deskVersion: 'test' });
      const img = decodePNG(renderUnitThumbnail(ex.probe, ex.header)!.png);
      ex.probe.destroy();
      expect(dominantShare(img.data), spec.kind).toBeLessThan(0.97);
    }
    doc.destroy();
  }, 60_000);

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
      publishResultText(outcome({ ok: false, code: 'refused', message: 'Only editors.' }), 'rideo', 'x'),
    ).toBe('Not saved: Only editors.');
  });

  it('do not say "Not saved" when the host may have saved it after all: no answer in time, the desk closed, an invalid answer', () => {
    const unknown = (code: string, message: string) => {
      const o = outcome({ ok: false, code, message, unknown: true });
      return [publishOutcome(o), publishResultText(o, 'rideo', 'x')];
    };
    const look = 'Look in its library before saving again.';
    expect(unknown('timeout', "rideo did not say whether it saved 'Harbor'.")).toEqual([
      'unknown',
      `Not known whether rideo saved 'Harbor': it did not answer in time. ${look}`,
    ]);
    expect(unknown('closed', 'The desk closed before the host answered.')).toEqual([
      'unknown',
      `Not known whether rideo saved 'Harbor': the desk closed before it answered. ${look}`,
    ]);
    expect(unknown('bad_reply', "rideo's answer was not valid: version: Required")).toEqual([
      'unknown',
      `Not known whether rideo saved 'Harbor': its answer was not valid. ${look}`,
    ]);
  });

  it('say "Not saved" with the reason for every refusal of the host, whatever its code, and for the desk’s own before anything was sent', () => {
    const refused = (code: string) => {
      const o = outcome({ ok: false, code, message: 'Why.' });
      return [publishOutcome(o), publishResultText(o, 'rideo', 'x')];
    };
    // a host may answer any code of 1–40 characters: the desk's own words are not the host's
    for (const code of ['refused', 'conflict', 'too_large', 'unavailable', 'failed', 'busy', 'invalid'])
      expect(refused(code)).toEqual(['failed', 'Not saved: Why.']);
    for (const code of ['timeout', 'closed', 'bad_reply', 'constructor', 'toString'])
      expect(refused(code)).toEqual(['failed', 'Not saved: Why.']);
  });

  it('are those docs/director-desk.md gives', () => {
    const doc = readFileSync(resolve(__dirname, '../../../docs/director-desk.md'), 'utf8').replace(
      /\s+/g,
      ' ',
    );
    const ok = { ok: true as const, ref: 'lib_1' };
    const words = (r: PublishOutcome['result'], version = 3) =>
      publishResultText(outcome(r.ok ? { ...r, version } : r), 'rideo', "the scene's place");
    for (const said of [
      words({ ...ok, version: 3, linked: true, adopted: true }),
      // a read-only open: rideo saves it and says why it does not link it
      words({ ...ok, version: 1, linked: false, adopted: false, message: 'the scene is read-only' }, 1),
      words({ ok: false, code: 'timeout', message: 'x', unknown: true }),
    ])
      expect(doc).toContain(said);
    expect(doc).toContain('"Not saved: …"');
    expect(doc).toContain('"not linked here"');
    // the name a new version is saved under
    expect(doc).toContain(
      "A new version is saved under its item's name, which the host keeps: Name shows it and cannot be changed, and Description is the new version's note.",
    );
  });
});

describe('the desk’s modal windows', () => {
  afterEach(() => void (sessionSignal.value = null));

  it('the editor’s keys act on nothing while one is open (installKeymap blocked), and on the scene again after', () => {
    let blocked = true;
    const off = installKeymap({ ignore: DESK_IGNORED_KEYS, blocked: () => blocked });
    // without a scene, a key that runs an operator says so in a toast: none while blocked
    const press = (init: KeyboardEventInit) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      window.dispatchEvent(e);
      return e;
    };
    const n = toasts.value.length;
    for (const k of [
      { key: ' ', code: 'Space' },
      { key: 'z', code: 'KeyZ', ctrlKey: true },
      { key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true },
      { key: 'ArrowRight', code: 'ArrowRight' },
      { key: 'R', code: 'KeyR', shiftKey: true },
    ])
      expect(press(k).defaultPrevented, k.code).toBe(false);
    expect(toasts.value.length).toBe(n);
    blocked = false;
    press({ key: ' ', code: 'Space' });
    expect(toasts.value.length).toBe(n + 1);
    off();
  });

  it('the Send check counts as one while open, takes the focus and gives it back, and leaves IME and repeated Escapes alone', async () => {
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
      stagedShots: () => [],
      lengthMismatches: () => [],
      changes: () => null,
      updateFromBrief: async () => null,
      results: async () => [],
      projectId: 'desk-modal',
    };
    const { c } = await connect(ws, {});
    const checks: LengthCheck[] = [
      { shotId: 'sht_a', name: 'Opening', frames: 72, briefFrames: 84, byBrief: false },
    ];
    const v = render(<DeskApp c={c} work={null} lengthChecks={() => checks} />);
    const send = q(v, 'desk-send') as HTMLButtonElement;
    send.focus();
    expect(deskModals.value).toBe(0);
    await act(async () => void fireEvent.click(send));
    const box = q(v, 'desk-send-check')!.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(deskModals.value).toBe(1);
    expect(box.contains(document.activeElement)).toBe(true);
    // Shift+Tab from the window itself goes to its last button, not behind it
    await act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(q(v, 'desk-send-check-send'));
    const escape = (init: KeyboardEventInit & { keyCode?: number }) =>
      act(() => {
        document.activeElement!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }),
        );
      });
    await escape({ isComposing: true, keyCode: 229 });
    await escape({ keyCode: 229 });
    await escape({ repeat: true });
    expect(q(v, 'desk-send-check')).not.toBeNull();
    await escape({});
    expect(q(v, 'desk-send-check')).toBeNull();
    expect(deskModals.value).toBe(0);
    expect(document.activeElement).toBe(send);
  });
});

describe('the banner of the brief’s changes', () => {
  it('turns Update shots off while the scene links a unit the host saved, and on again after', async () => {
    const { c } = await openDesk();
    c.changes.value = {
      added: ['sht_0123456789zzzz'],
      removed: [],
      retimed: [],
      recast: [],
      cast: { added: [], removed: [] },
    };
    const v = render(<DeskApp c={c} work={null} lengthChecks={() => []} />);
    const update = () => q(v, 'desk-update-shots') as HTMLButtonElement;
    const phase = (p: 'waiting' | 'linking' | null) =>
      act(() => {
        c.publishing.value = p && { kind: 'set', name: 'Meadow', phase: p, startedAt: 0, id: 'pub-1' };
      });
    expect(update().disabled).toBe(false);
    // the host has not answered yet: the update could go first
    await phase('waiting');
    expect(update().disabled).toBe(false);
    // the scene links the version the host saved: no update until it has
    await phase('linking');
    expect(update().disabled).toBe(true);
    await phase(null);
    expect(update().disabled).toBe(false);
  });

  it('turns the Send check’s Update shots off while the scene links a unit the host saved, as the banner’s', async () => {
    const { c } = await openDesk();
    const checks: LengthCheck[] = [
      { shotId: 'sht_a', name: 'Opening', frames: 72, briefFrames: 84, byBrief: true },
    ];
    const v = render(<DeskApp c={c} work={null} lengthChecks={() => checks} />);
    await act(async () => void fireEvent.click(q(v, 'desk-send')!));
    const update = () => q(v, 'desk-send-check-update') as HTMLButtonElement;
    const phase = (p: 'waiting' | 'linking' | null) =>
      act(() => {
        c.publishing.value = p && { kind: 'set', name: 'Meadow', phase: p, startedAt: 0, id: 'pub-1' };
      });
    expect(update().disabled).toBe(false);
    await phase('waiting');
    expect(update().disabled).toBe(false);
    await phase('linking');
    expect(update().disabled).toBe(true);
    expect(update().title).toBe('The scene is being linked to a unit saved to the library');
    await phase(null);
    expect(update().disabled).toBe(false);
  });
});
