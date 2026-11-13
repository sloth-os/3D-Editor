import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { AgentHistory, historyKept, KEPT_CONTAINER_ITEM_BYTES, reachSearch } from '../../src/mcp/history';

/*
 * Bounded undo histories of MCP agents (apps/server/src/mcp/history.ts). Yjs keeps every item a
 * tracked transaction deleted (`keep`), forever: the server kept every mesh version an agent ever
 * replaced (phase 3: the lighthouse-cove rebuilds ran the server out of memory).
 */

const ORIGIN = { type: 'mcp', session: 'test' };

function setup(limits: { maxSteps?: number; maxBytes?: number } = {}) {
  const doc = new Y.Doc();
  const mesh = doc.getMap<any>('meshes');
  const history = new AgentHistory(doc, [mesh], ORIGIN, limits);
  /** One undo step (like AgentProject.step): every change in `fn` is one stack item. */
  const step = (fn: () => void) => {
    const um = history.undo;
    um.stopCapturing();
    um.captureTimeout = Number.POSITIVE_INFINITY;
    try {
      fn();
    } finally {
      um.captureTimeout = 0;
      um.stopCapturing();
    }
    history.maintain();
  };
  const set = (key: string, value: unknown) => doc.transact(() => mesh.set(key, value), ORIGIN);
  return { doc, mesh, history, step, set };
}

/** A blob of `size` bytes whose first byte is `tag`. */
function blob(tag: number, size = 100_000): Uint8Array {
  const b = new Uint8Array(size);
  b[0] = tag;
  return b;
}

/** Deleted items whose binary content the document still holds. */
function retained(doc: Y.Doc): { items: number; bytes: number } {
  let items = 0;
  let bytes = 0;
  for (const structs of doc.store.clients.values())
    for (const s of structs)
      if (s instanceof Y.Item && s.deleted && s.content instanceof Y.ContentBinary) {
        items++;
        bytes += s.content.content.byteLength;
      }
  return { items, bytes };
}

const tagOf = (v: unknown) => (v instanceof Uint8Array ? v[0] : null);

/** Size of a value as the test counts it (bytes of binary data, 8 per number, 1 per character). */
const sizeOf = (v: unknown): number =>
  v instanceof Uint8Array
    ? v.byteLength
    : Array.isArray(v)
      ? v.reduce((t: number, x) => t + sizeOf(x), 0)
      : v !== null && typeof v === 'object'
        ? Object.values(v).reduce((t: number, x) => t + sizeOf(x), 0)
        : typeof v === 'string'
          ? v.length
          : 8;

/**
 * Deleted values of any kind (JSON-like values, strings, binary data) whose content the document
 * still holds, counted one by one (Yjs merges consecutive deleted values into one item), and the
 * deleted containers it still holds.
 */
function held(doc: Y.Doc): { values: number; bytes: number; containers: number } {
  let values = 0;
  let bytes = 0;
  let containers = 0;
  for (const structs of doc.store.clients.values())
    for (const s of structs) {
      if (!(s instanceof Y.Item) || !s.deleted || s.content instanceof Y.ContentDeleted) continue;
      if (s.content instanceof Y.ContentType) containers++;
      else
        for (const v of s.content.getContent()) {
          values++;
          bytes += sizeOf(v);
        }
    }
  return { values, bytes, containers };
}

/**
 * Deleted values the document holds although no live undo or redo step of `histories` needs them
 * (after maintenance there must be none: what no step needs is collected).
 */
function orphans(doc: Y.Doc, histories: AgentHistory[]): number {
  const live = Y.mergeDeleteSets(
    histories.flatMap((h) => [...h.undo.undoStack, ...h.undo.redoStack].map((st) => st.deletions)),
  );
  let n = 0;
  for (const structs of doc.store.clients.values())
    for (const s of structs) {
      if (!(s instanceof Y.Item) || !s.deleted) continue;
      if (s.content instanceof Y.ContentDeleted || s.content instanceof Y.ContentType) continue;
      for (let c = 0; c < s.length; c++) if (!Y.isDeleted(live, Y.createID(s.id.client, s.id.clock + c))) n++;
    }
  return n;
}

/** A value the fuzz tests write to `field`: binary data, a string, numbers, or groups with weights. */
function fieldValue(field: string, tag: number): unknown {
  if (field === 'data') return blob(tag, 64);
  if (field === 'name') return `n${tag}`;
  if (field === 'vg')
    return [
      { name: `g${tag}`, weights: blob(tag, 24) },
      { name: 'h', weights: blob(tag + 1, 24) },
    ];
  return [tag, tag + 0.5, tag + 1];
}

/** A JSON-like value of `n` numbers (an agent's vertex group weights, a shape key …). */
const numbers = (tag: number, n = 2_000) => Array.from({ length: n }, (_, k) => tag * 10_000 + k);

describe('AgentHistory', () => {
  it('collects data created and deleted within one step; undo and redo still work', () => {
    const { doc, mesh, history, step, set } = setup();
    step(() => set('data', blob(1)));
    // a batch that replaces the same mesh 50 times (vertex paint dabs)
    step(() => {
      for (let i = 2; i <= 51; i++) set('data', blob(i));
    });
    // Yjs alone keeps all 50 replaced versions; only the version before the batch is needed
    expect(retained(doc).items).toBe(1);
    expect(history.stats().released_items).toBeGreaterThanOrEqual(49);
    expect(tagOf(mesh.get('data'))).toBe(51);
    history.undo.undo();
    expect(tagOf(mesh.get('data'))).toBe(1);
    history.undo.redo();
    expect(tagOf(mesh.get('data'))).toBe(51);
    history.undo.undo();
    history.undo.undo();
    expect(mesh.get('data')).toBeUndefined();
    history.undo.redo();
    history.undo.redo();
    expect(tagOf(mesh.get('data'))).toBe(51);
  });

  it('frees replaced versions while a step is still running (compactStep between operations)', () => {
    const { doc, mesh, history, step, set } = setup();
    step(() => set('data', blob(1)));
    let most = 0;
    step(() => {
      for (let i = 2; i <= 40; i++) {
        set('data', blob(i));
        history.compactStep();
        most = Math.max(most, retained(doc).items);
      }
    });
    // only the version before the step (needed for undo) and the one just replaced
    expect(most).toBeLessThanOrEqual(1);
    history.undo.undo();
    expect(tagOf(mesh.get('data'))).toBe(1);
    history.undo.redo();
    expect(tagOf(mesh.get('data'))).toBe(40);
  });

  it('keeps at most maxSteps steps and collects the dropped ones', () => {
    const { doc, mesh, history, step, set } = setup({ maxSteps: 3 });
    for (let i = 1; i <= 10; i++) step(() => set('data', blob(i)));
    expect(history.undo.undoStack.length).toBe(3);
    // versions 7, 8, 9 are needed to undo the last three steps; 1..6 are collected
    expect(retained(doc).items).toBe(3);
    expect(history.stats().dropped_steps).toBe(7);
    for (const want of [9, 8, 7]) {
      expect(history.undo.undo()).not.toBeNull();
      expect(tagOf(mesh.get('data'))).toBe(want);
    }
    expect(history.undo.undo()).toBeNull();
    expect(tagOf(mesh.get('data'))).toBe(7);
    for (const want of [8, 9, 10]) {
      history.undo.redo();
      expect(tagOf(mesh.get('data'))).toBe(want);
    }
  });

  it('keeps at most maxBytes of replaced data, but always the newest step', () => {
    const { doc, mesh, history, step, set } = setup({ maxBytes: 2_500_000 });
    for (let i = 1; i <= 6; i++) step(() => set('data', blob(i, 1_000_000)));
    // each step replaced 1 MB: two steps fit
    expect(history.undo.undoStack.length).toBe(2);
    expect(retained(doc).bytes).toBe(2_000_000);
    expect(history.stats().bytes).toBeGreaterThanOrEqual(2_000_000);
    expect(history.stats().bytes).toBeLessThanOrEqual(2_500_000);
    // one step that replaces more than the budget is still undoable
    step(() => set('big', blob(7, 1_000_000)));
    step(() => set('big', blob(8, 5_000_000)));
    step(() => set('big', blob(9, 10)));
    expect(history.undo.undoStack.length).toBe(1);
    history.undo.undo();
    expect(tagOf(mesh.get('big'))).toBe(8);
    expect(history.undo.undo()).toBeNull();
  });

  it('collects redo steps that a new change dropped', () => {
    const { doc, mesh, history, step, set } = setup();
    step(() => set('data', blob(1)));
    step(() => set('data', blob(2)));
    history.undo.undo();
    history.maintain();
    expect(tagOf(mesh.get('data'))).toBe(1);
    // the undo deleted version 2 (kept for redo) and restored version 1
    expect(history.undo.redoStack.length).toBe(1);
    step(() => set('data', blob(3)));
    // redo is gone: version 2 is collected, only version 1 (to undo step 3) is kept
    expect(history.undo.redoStack.length).toBe(0);
    expect(retained(doc).items).toBe(1);
    history.undo.undo();
    expect(tagOf(mesh.get('data'))).toBe(1);
  });

  it('collects everything it kept when it ends, the document keeps its current state', () => {
    const { doc, mesh, history, step, set } = setup();
    const nested = new Y.Map<any>();
    step(() => doc.transact(() => mesh.set('object', nested), ORIGIN));
    for (let i = 1; i <= 5; i++) step(() => doc.transact(() => nested.set('data', blob(i)), ORIGIN));
    step(() => set('data', blob(9)));
    step(() => doc.transact(() => mesh.delete('object'), ORIGIN));
    const before = Y.encodeStateAsUpdate(doc).byteLength;
    expect(retained(doc).items).toBeGreaterThanOrEqual(5);
    history.destroy();
    expect(retained(doc).items).toBe(0);
    expect(tagOf(mesh.get('data'))).toBe(9);
    expect(mesh.has('object')).toBe(false);
    // the persisted document no longer carries the old versions
    expect(Y.encodeStateAsUpdate(doc).byteLength).toBeLessThan(before - 400_000);
    // a replica built from it has the same state
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    expect(tagOf(copy.getMap('meshes').get('data'))).toBe(9);
  });

  it('undo restores deleted nested data after older steps were dropped', () => {
    const { mesh, history, step, set } = setup({ maxSteps: 2 });
    const obj = new Y.Map<any>();
    step(() => mesh.doc!.transact(() => mesh.set('object', obj), ORIGIN));
    step(() => mesh.doc!.transact(() => obj.set('data', blob(1)), ORIGIN));
    step(() => mesh.doc!.transact(() => obj.set('data', blob(2)), ORIGIN));
    step(() => set('other', 1));
    step(() => mesh.doc!.transact(() => mesh.delete('object'), ORIGIN));
    expect(history.undo.undoStack.length).toBe(2);
    history.undo.undo();
    const restored = mesh.get('object') as Y.Map<any>;
    expect(restored).toBeInstanceOf(Y.Map);
    expect(tagOf(restored.get('data'))).toBe(2);
    history.undo.undo();
    expect(mesh.has('other')).toBe(false);
    expect(history.undo.undo()).toBeNull();
    history.undo.redo();
    history.undo.redo();
    expect(mesh.has('object')).toBe(false);
    expect(mesh.get('other')).toBe(1);
  });

  it('undo follows the links of restored items after the originals were released', () => {
    const { doc, mesh, history, step, set } = setup();
    const obj = new Y.Map<any>();
    step(() => doc.transact(() => mesh.set('object', obj), ORIGIN));
    step(() => doc.transact(() => obj.set('data', blob(1)), ORIGIN));
    step(() => doc.transact(() => mesh.delete('object'), ORIGIN));
    history.undo.undo(); // restores copies of the object and its data
    history.maintain(); // releases the originals' content
    expect(tagOf((mesh.get('object') as Y.Map<any>).get('data'))).toBe(1);
    history.undo.undo(); // undoes step 2: must remove the restored copy of 'data'
    expect((mesh.get('object') as Y.Map<any>).has('data')).toBe(false);
    history.undo.undo();
    expect(mesh.has('object')).toBe(false);
    history.undo.redo();
    history.undo.redo();
    history.undo.redo();
    expect(mesh.has('object')).toBe(false);
    history.undo.undo();
    expect(tagOf((mesh.get('object') as Y.Map<any>).get('data'))).toBe(1);
    set('x', 1);
    expect(retained(doc).items).toBeLessThanOrEqual(2);
  });

  it('gives the same document states as an unbounded Y.UndoManager (random edits, undo, redo)', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      let x = seed * 7919;
      const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
      const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
      const maxSteps = seed % 2 ? 4 : 1000;
      const make = (bounded: boolean) => {
        const doc = new Y.Doc();
        doc.clientID = 42;
        const root = doc.getMap<any>('meshes');
        const origin = { type: 'mcp', session: `s${seed}` };
        const history = bounded ? new AgentHistory(doc, [root], origin, { maxSteps }) : null;
        const um =
          history?.undo ??
          new Y.UndoManager([root], { trackedOrigins: new Set([origin]), captureTimeout: 0 });
        return { doc, root, origin, history, um };
      };
      const a = make(true);
      const b = make(false);
      for (let i = 0; i < 250; i++) {
        const r = rnd();
        const choice = r < 0.12 ? 'undo' : r < 0.2 ? 'redo' : 'edit';
        const ops: ((d: ReturnType<typeof make>) => void)[] = [];
        if (choice === 'edit') {
          const n = 1 + Math.floor(rnd() * 3);
          for (let k = 0; k < n; k++) {
            const key = pick(['o1', 'o2', 'o3']);
            const field = pick(['data', 'name', 'loc', 'vg']);
            const kind = rnd();
            const tag = Math.floor(rnd() * 250);
            ops.push((d) => {
              const o = d.root.get(key);
              if (kind < 0.2) d.root.set(key, new Y.Map());
              else if (kind < 0.3) d.root.delete(key);
              else if (o instanceof Y.Map) o.set(field, fieldValue(field, tag));
              else d.root.set(key, blob(tag, 32));
            });
          }
        }
        for (const d of [a, b]) {
          if (choice === 'undo') d.um.undo();
          else if (choice === 'redo') d.um.redo();
          else {
            d.um.stopCapturing();
            d.um.captureTimeout = Number.POSITIVE_INFINITY;
            for (const op of ops) {
              d.doc.transact(() => op(d), d.origin);
              d.history?.compactStep();
            }
            d.um.captureTimeout = 0;
            d.um.stopCapturing();
          }
        }
        a.history!.maintain();
        // the reference drops the same old steps, without collecting anything
        while (b.um.undoStack.length > maxSteps) b.um.undoStack.shift();
        expect(a.um.undoStack.length, `seed ${seed} op ${i}`).toBe(b.um.undoStack.length);
        expect(a.um.redoStack.length, `seed ${seed} op ${i}`).toBe(b.um.redoStack.length);
        expect(JSON.stringify(a.root.toJSON()), `seed ${seed} op ${i} (${choice})`).toBe(
          JSON.stringify(b.root.toJSON()),
        );
        expect(orphans(a.doc, [a.history!]), `seed ${seed} op ${i} (${choice})`).toBe(0);
      }
      // the bounded history keeps no more replaced data than the reference
      expect(retained(a.doc).bytes).toBeLessThanOrEqual(retained(b.doc).bytes);
      expect(held(a.doc).bytes).toBeLessThanOrEqual(held(b.doc).bytes);
      a.history!.destroy();
      expect(retained(a.doc).items).toBe(0);
      expect(held(a.doc), `seed ${seed}`).toEqual({ values: 0, bytes: 0, containers: 0 });
    }
  });

  it('gives the same document states as unbounded Y.UndoManagers with two agents editing the same objects', () => {
    for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
      let x = seed * 104729;
      const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
      const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
      const maxSteps = seed % 2 ? 3 : 1000;
      const make = (bounded: boolean) => {
        const doc = new Y.Doc();
        doc.clientID = 7;
        const root = doc.getMap<any>('meshes');
        const agents = ['A', 'B'].map((n) => {
          const origin = { type: 'mcp', session: n };
          const history = bounded ? new AgentHistory(doc, [root], origin, { maxSteps }) : null;
          const um =
            history?.undo ??
            new Y.UndoManager([root], { trackedOrigins: new Set([origin]), captureTimeout: 0 });
          return { origin, history, um };
        });
        return { doc, root, agents };
      };
      const a = make(true);
      const b = make(false);
      for (let i = 0; i < 300; i++) {
        const who = rnd() < 0.5 ? 0 : 1;
        const r = rnd();
        const choice = r < 0.15 ? 'undo' : r < 0.22 ? 'redo' : 'edit';
        const ops: ((root: Y.Map<any>) => void)[] = [];
        if (choice === 'edit')
          for (let k = 1 + Math.floor(rnd() * 3); k > 0; k--) {
            const key = pick(['o1', 'o2']);
            const field = pick(['data', 'name', 'vg']);
            const kind = rnd();
            const tag = Math.floor(rnd() * 250);
            ops.push((root) => {
              const o = root.get(key);
              if (kind < 0.15) root.set(key, new Y.Map());
              else if (kind < 0.25) root.delete(key);
              else if (o instanceof Y.Map) {
                if (kind < 0.35) o.set('child', new Y.Map());
                else if (o.get('child') instanceof Y.Map && kind < 0.55)
                  o.get('child').set(field, fieldValue(field, tag));
                else o.set(field, fieldValue(field, tag));
              } else root.set(key, blob(tag, 32));
            });
          }
        for (const d of [a, b]) {
          const ag = d.agents[who];
          if (choice === 'undo') ag.um.undo();
          else if (choice === 'redo') ag.um.redo();
          else {
            ag.um.stopCapturing();
            ag.um.captureTimeout = Number.POSITIVE_INFINITY;
            for (const op of ops) {
              d.doc.transact(() => op(d.root), ag.origin);
              ag.history?.compactStep();
            }
            ag.um.captureTimeout = 0;
            ag.um.stopCapturing();
          }
        }
        for (const ag of a.agents) ag.history!.maintain();
        for (const ag of b.agents) while (ag.um.undoStack.length > maxSteps) ag.um.undoStack.shift();
        expect(JSON.stringify(a.root.toJSON()), `seed ${seed} op ${i} (${'AB'[who]} ${choice})`).toBe(
          JSON.stringify(b.root.toJSON()),
        );
        expect(
          orphans(
            a.doc,
            a.agents.map((ag) => ag.history!),
          ),
          `seed ${seed} op ${i}`,
        ).toBe(0);
      }
      expect(retained(a.doc).bytes).toBeLessThanOrEqual(retained(b.doc).bytes);
      expect(held(a.doc).bytes).toBeLessThanOrEqual(held(b.doc).bytes);
      // one agent's history ends: the other one's undo keeps working the same way
      a.agents[0].history!.destroy();
      b.agents[0].um.destroy();
      for (let i = 0; i < 4; i++) {
        a.agents[1].um.undo();
        b.agents[1].um.undo();
        a.agents[1].history!.maintain();
        expect(JSON.stringify(a.root.toJSON()), `seed ${seed} after A ended, undo ${i}`).toBe(
          JSON.stringify(b.root.toJSON()),
        );
      }
    }
  });

  it('does not collect a container below which another agent still keeps data', () => {
    const doc = new Y.Doc();
    const root = doc.getMap<any>('meshes');
    const A = { type: 'mcp', session: 'a' };
    const B = { type: 'mcp', session: 'b' };
    const ha = new AgentHistory(doc, [root], A);
    const hb = new AgentHistory(doc, [root], B);
    const obj = new Y.Map<any>();
    doc.transact(() => root.set('object', obj), B);
    doc.transact(() => obj.set('data', blob(1)), B);
    hb.undo.stopCapturing();
    doc.transact(() => obj.set('data', blob(2)), B); // B keeps version 1 to undo this
    doc.transact(() => root.delete('object'), A); // A keeps the object and version 2
    ha.maintain();
    hb.maintain();
    const tags = () =>
      [...doc.store.clients.values()]
        .flat()
        .filter((x): x is Y.Item => x instanceof Y.Item && x.deleted && x.content instanceof Y.ContentBinary)
        .map((x) => (x.content as Y.ContentBinary).content[0])
        .sort();
    expect(tags()).toEqual([1, 2]);
    // A's history ends: version 2 is collected, the object (holding B's version 1) is not
    ha.destroy();
    expect(tags()).toEqual([1]);
    hb.destroy();
    expect(tags()).toEqual([]);
  });

  it('collects no container while something no history knows keeps an item below it', () => {
    const doc = new Y.Doc();
    const root = doc.getMap<any>('objects');
    const A = { type: 'mcp', session: 'a' };
    const B = { type: 'mcp', session: 'b' };
    const other = { type: 'other' };
    const ha = new AgentHistory(doc, [root], A, { maxSteps: 1 });
    const hb = new AgentHistory(doc, [root], B, { maxSteps: 1 });
    // an undo manager no agent history knows of (created after the histories: they see its changes
    // first), whose step keeps version 1 below the object
    const plain = new Y.UndoManager([root], { trackedOrigins: new Set([other]), captureTimeout: 0 });
    const maintain = () => {
      ha.maintain();
      hb.maintain();
    };
    const obj = new Y.Map<any>();
    const nested = new Y.Map<any>();
    doc.transact(
      () => {
        root.set('object', obj);
        obj.set('modifier', nested);
        nested.set('count', 1);
      },
      { type: 'editor' },
    );
    const version1 = (nested._map.get('count') as Y.Item).id;
    doc.transact(() => nested.set('count', 2), other);
    doc.transact(() => nested.set('count', 3), A); // A's step keeps version 2
    doc.transact(() => root.delete('object'), B);
    maintain();
    // B's next step drops the one that deleted the object: the object is kept for A's step
    hb.undo.stopCapturing();
    doc.transact(() => root.set('b', 1), B);
    maintain();
    const objectItem = obj._item!;
    expect(objectItem.content).toBeInstanceOf(Y.ContentType);
    // A's next step drops the step that reached the object: no history needs it any more, but the
    // other undo manager keeps version 1 below it, which collecting the object would collect too
    ha.undo.stopCapturing();
    doc.transact(() => root.set('a', 1), A);
    maintain();
    expect(ha.undo.undoStack.length).toBe(1);
    expect(objectItem.content).toBeInstanceOf(Y.ContentType);
    const kept = Y.getItem(doc.store, version1);
    expect(kept).toBeInstanceOf(Y.Item);
    expect((kept as Y.Item).keep).toBe(true);
    expect((kept as Y.Item).content).toBeInstanceOf(Y.ContentAny);
    // once that undo manager lets it go and the histories end, nothing deleted is held
    plain.clear();
    ha.destroy();
    hb.destroy();
    expect(held(doc)).toEqual({ values: 0, bytes: 0, containers: 0 });
    expect(root.toJSON()).toEqual({ a: 1, b: 1 });
  });

  it('counts nothing as released when the document collects nothing (gc off)', () => {
    const doc = new Y.Doc({ gc: false });
    const mesh = doc.getMap<any>('meshes');
    const history = new AgentHistory(doc, [mesh], ORIGIN, { maxSteps: 2 });
    for (let i = 1; i <= 5; i++) {
      history.undo.stopCapturing();
      doc.transact(() => mesh.set('data', blob(i)), ORIGIN);
      history.maintain();
    }
    expect(history.stats()).toMatchObject({
      steps: 2,
      dropped_steps: 3,
      released_items: 0,
      released_bytes: 0,
    });
    // Yjs keeps the content of deleted items without gc
    expect(retained(doc).items).toBe(4);
    history.undo.undo();
    expect(tagOf(mesh.get('data'))).toBe(4);
  });

  it('only tracks its own origin: other users’ changes are neither undone nor kept', () => {
    const { doc, mesh, history, step, set } = setup();
    step(() => set('data', blob(1)));
    for (let i = 2; i <= 5; i++) doc.transact(() => mesh.set('data', blob(i)), { type: 'remote' });
    history.maintain();
    // replaced by someone else: collected by Yjs right away
    expect(retained(doc).items).toBe(0);
    expect(history.undo.undoStack.length).toBe(1);
  });

  it('collects the steps undo discards without an event (nothing left to change)', () => {
    const { doc, mesh, history, step, set } = setup();
    step(() => set('data', blob(1)));
    step(() => set('data', blob(2))); // keeps version 1 to undo this
    doc.transact(() => mesh.set('data', blob(3)), { type: 'remote' });
    // version 1 cannot come back over the other user's change: Yjs discards both steps silently
    history.undo.undo();
    history.maintain();
    expect(tagOf(mesh.get('data'))).toBe(3);
    expect(history.undo.undoStack.length).toBe(0);
    expect(retained(doc).items).toBe(0);
  });

  it('collects copies that undo restored into a container that is deleted by then', () => {
    const { doc, mesh, history, step } = setup();
    const t = (fn: () => void) => step(() => doc.transact(fn, ORIGIN));
    t(() => {
      const obj = new Y.Map<any>();
      mesh.set('object', obj);
      obj.set('data', blob(1));
    });
    t(() => mesh.get('object').set('data', blob(2))); // keeps version 1
    t(() => mesh.delete('object')); // keeps the object and version 2
    history.undo.undo(); // the object and version 2 come back as copies
    expect(tagOf(mesh.get('object').get('data'))).toBe(2);
    doc.transact(() => mesh.delete('object'), { type: 'remote' }); // someone deletes the copy
    // undo of version 2 restores version 1 into the deleted copy: Yjs deletes it at once, keeps it
    // and records no step, so nothing would ever release it
    history.undo.undo();
    history.maintain();
    expect(mesh.get('object')).toBeUndefined();
    history.destroy();
    expect(retained(doc)).toEqual({ items: 0, bytes: 0 });
  });

  it('collects restored copies that a change no agent tracks deletes', () => {
    const { doc, mesh, history, step, set } = setup();
    step(() => set('data', blob(1)));
    step(() => set('data', blob(2)));
    history.undo.undo(); // version 1 comes back as a copy, which Yjs keeps from the start
    expect(tagOf(mesh.get('data'))).toBe(1);
    doc.transact(() => mesh.set('data', blob(3)), { type: 'remote' }); // an editor replaces it
    history.maintain();
    // only version 2 (needed to redo) is kept; the copy of version 1 is collected
    expect(retained(doc).items).toBe(1);
    history.undo.redo(); // conflicts with the editor's change: nothing to redo
    expect(tagOf(mesh.get('data'))).toBe(3);
    history.destroy();
    expect(retained(doc).items).toBe(0);
  });

  /*
   * 60 random sessions of 200 steps, each run on two documents (AgentHistory and plain Yjs) and
   * compared after every step, which also counts the deleted values no step keeps: 0.84–0.90 s,
   * 1.46–1.84 s under coverage on a 4-CPU machine. CI runners can be 2–3 times slower, so the test
   * gets 15 s instead of the default 5 s.
   */
  it('never fails inside Yjs and keeps nothing once every history ended (1-3 agents, editors, random)', () => {
    for (let seed = 1; seed <= 60; seed++) {
      let x = seed * 104729 + 17;
      const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
      const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
      const agentCount = 1 + (seed % 3);
      const maxSteps = [1, 2, 3, 5, 1000][seed % 5];
      const editors = seed % 4 === 0;
      const make = (bounded: boolean) => {
        const doc = new Y.Doc();
        doc.clientID = 7;
        const root = doc.getMap<any>('meshes');
        const agents = Array.from({ length: agentCount }, (_, n) => {
          const origin = { type: 'mcp', session: `a${n}` };
          const history = bounded ? new AgentHistory(doc, [root], origin, { maxSteps }) : null;
          const um =
            history?.undo ??
            new Y.UndoManager([root], { trackedOrigins: new Set([origin]), captureTimeout: 0 });
          return { origin, history, um };
        });
        return { doc, root, agents };
      };
      const a = make(true);
      const b = make(false);
      let referenceFailed = false;
      for (let i = 0; i < 200 && !referenceFailed; i++) {
        const who = Math.floor(rnd() * (agentCount + (editors ? 1 : 0)));
        const r = rnd();
        const choice = who === agentCount ? 'editor' : r < 0.15 ? 'undo' : r < 0.24 ? 'redo' : 'edit';
        const ops: ((root: Y.Map<any>) => void)[] = [];
        if (choice === 'edit' || choice === 'editor')
          for (let k = 1 + Math.floor(rnd() * 3); k > 0; k--) {
            const key = pick(['o1', 'o2', 'o3']);
            const field = pick(['data', 'name', 'loc', 'vg']);
            const kind = rnd();
            const tag = Math.floor(rnd() * 250);
            ops.push((root) => {
              const o = root.get(key);
              if (kind < 0.15) root.set(key, new Y.Map());
              else if (kind < 0.25) root.delete(key);
              else if (o instanceof Y.Map) {
                if (kind < 0.35) o.set('child', new Y.Map());
                else if (o.get('child') instanceof Y.Map && kind < 0.55)
                  o.get('child').set(field, fieldValue(field, tag));
                else if (kind < 0.6) o.delete(field);
                else o.set(field, fieldValue(field, tag));
              } else root.set(key, blob(tag, 32));
            });
          }
        for (const d of [a, b]) {
          const run = () => {
            if (choice === 'editor') {
              for (const op of ops) d.doc.transact(() => op(d.root), { type: 'editor' });
              return;
            }
            const ag = d.agents[who];
            if (choice === 'undo') ag.um.undo();
            else if (choice === 'redo') ag.um.redo();
            else {
              ag.um.stopCapturing();
              ag.um.captureTimeout = Number.POSITIVE_INFINITY;
              for (const op of ops) {
                d.doc.transact(() => op(d.root), ag.origin);
                ag.history?.compactStep();
              }
              ag.um.captureTimeout = 0;
              ag.um.stopCapturing();
            }
          };
          if (d === a) run();
          else
            try {
              run();
            } catch {
              // plain Yjs itself can fail here (a restored copy below a container an editor
              // deleted); the comparison ends, the bounded run must not have failed before
              referenceFailed = true;
            }
        }
        for (const ag of a.agents) ag.history!.maintain();
        for (const ag of b.agents) while (ag.um.undoStack.length > maxSteps) ag.um.undoStack.shift();
        if (!referenceFailed)
          expect(JSON.stringify(a.root.toJSON()), `seed ${seed} op ${i} (${who} ${choice})`).toBe(
            JSON.stringify(b.root.toJSON()),
          );
        expect(
          orphans(
            a.doc,
            a.agents.map((ag) => ag.history!),
          ),
          `seed ${seed} op ${i} (${who} ${choice})`,
        ).toBe(0);
      }
      if (!referenceFailed) {
        expect(retained(a.doc).bytes, `seed ${seed}`).toBeLessThanOrEqual(retained(b.doc).bytes);
        expect(held(a.doc).bytes, `seed ${seed}`).toBeLessThanOrEqual(held(b.doc).bytes);
      }
      // histories end one after the other; the others keep undoing without errors (their results
      // may differ from plain Yjs once the ended history's values are collected: Yjs then treats
      // them like an editor's changes, whose overwritten values it collects too)
      for (const [k, ag] of a.agents.entries()) {
        ag.history!.destroy();
        for (const other of a.agents.slice(k + 1)) {
          other.um.undo();
          other.um.redo();
          other.history!.maintain();
        }
      }
      expect(retained(a.doc), `seed ${seed}`).toEqual({ items: 0, bytes: 0 });
      expect(held(a.doc), `seed ${seed}`).toEqual({ values: 0, bytes: 0, containers: 0 });
    }
  }, 15_000);
});

/*
 * Yjs merges the deleted values one client wrote to one map key one after another (an agent moving
 * an object, renaming vertex groups, adding shape keys: JSON-like values) into one item, kept when
 * any part of it is. The history collected nothing of them: its collection split such an item at a
 * step's clock ranges, and the transaction's cleanup merged the parts back into the kept ones before
 * Yjs's garbage collection ran (200 writes of 5,000 numbers to one key kept 4.0 MB with ten steps).
 */
describe('AgentHistory: values written to one key one after another', () => {
  /** An agent writing JSON values to `key` of one object, a step per write (as MCP tools do). */
  function writer(limits: { maxSteps?: number; maxBytes?: number }) {
    const t = setup(limits);
    const write = (key: string, value: unknown) => t.step(() => t.set(key, value));
    return { ...t, write };
  }

  /** Encoded size of a document holding just `value` under one key (a version kept costs about that). */
  function encodedValue(value: unknown): number {
    const doc = new Y.Doc();
    doc.getMap('meshes').set('vg', value);
    return Y.encodeStateAsUpdate(doc).byteLength;
  }

  it('keeps only the versions its maxSteps steps need; undo and redo restore them exactly', () => {
    const { doc, mesh, history, write } = writer({ maxSteps: 10 });
    for (let i = 0; i < 120; i++) write('vg', numbers(i));
    expect(history.undo.undoStack.length).toBe(10);
    // the versions replaced by the last ten steps (109 … 118), no more
    expect(held(doc)).toEqual({ values: 10, bytes: 10 * 2_000 * 8, containers: 0 });
    expect(Y.encodeStateAsUpdate(doc).byteLength).toBeLessThan(12 * encodedValue(numbers(119)));
    // what the history reports keeping is what the document holds (its estimate: 16 bytes per value more)
    expect(history.stats().bytes).toBeGreaterThanOrEqual(held(doc).bytes);
    expect(history.stats().bytes).toBeLessThan(held(doc).bytes * 1.01);
    expect(historyKept(doc)).toEqual({ bytes: history.stats().bytes, items: 10 });
    for (let u = 1; u <= 10; u++) {
      expect(history.undo.undo()).not.toBeNull();
      history.maintain();
      expect(mesh.get('vg')).toEqual(numbers(119 - u));
    }
    expect(history.undo.undo()).toBeNull();
    for (let r = 1; r <= 10; r++) {
      history.undo.redo();
      history.maintain();
      expect(mesh.get('vg')).toEqual(numbers(109 + r));
    }
    // undo and redo collected what they replaced: still ten versions at most
    expect(held(doc).values).toBeLessThanOrEqual(10);
  });

  it('keeps only the versions maxBytes allows (and always the newest step)', () => {
    const one = 2_000 * 8 + 96; // the history's estimate of one version
    const { doc, mesh, history, write } = writer({ maxBytes: 4.5 * one });
    for (let i = 0; i < 60; i++) write('vg', numbers(i));
    expect(history.undo.undoStack.length).toBe(4);
    expect(held(doc).values).toBe(4);
    expect(history.stats().bytes).toBeLessThanOrEqual(4.5 * one);
    expect(Y.encodeStateAsUpdate(doc).byteLength).toBeLessThan(6 * encodedValue(numbers(59)));
    for (let u = 1; u <= 4; u++) {
      history.undo.undo();
      history.maintain();
      expect(mesh.get('vg')).toEqual(numbers(59 - u));
    }
    expect(history.undo.undo()).toBeNull();
    for (let r = 1; r <= 4; r++) {
      history.undo.redo();
      history.maintain();
      expect(mesh.get('vg')).toEqual(numbers(55 + r));
    }
    expect(history.undo.redo()).toBeNull();
    // a step that replaces more than the budget is kept alone
    write('big', numbers(1, 10_000));
    write('big', numbers(2, 10_000));
    write('big', numbers(3, 10));
    expect(history.undo.undoStack.length).toBe(1);
    history.undo.undo();
    expect(mesh.get('big')).toEqual(numbers(2, 10_000));
  });

  it('collects the versions a step wrote and replaced itself, merged with the version before it', () => {
    const { doc, mesh, history, step, set } = setup();
    step(() => set('vg', numbers(1)));
    // one step writing the same key 50 times (one transaction each, as a batch's operators do)
    step(() => {
      for (let i = 2; i <= 51; i++) set('vg', numbers(i));
    });
    // Yjs merged version 1 (needed to undo) with versions 2 … 50 (created and replaced by the step)
    expect(held(doc).values).toBe(1);
    expect(history.stats().bytes).toBeLessThan(2 * 2_000 * 8);
    // one item kept (the placeholders of the versions collected count for nothing)
    expect(historyKept(doc).items).toBe(1);
    expect(Y.encodeStateAsUpdate(doc).byteLength).toBeLessThan(3 * encodedValue(numbers(51)));
    history.undo.undo();
    expect(mesh.get('vg')).toEqual(numbers(1));
    history.undo.redo();
    expect(mesh.get('vg')).toEqual(numbers(51));
    // the same in one transaction
    step(() =>
      doc.transact(() => {
        for (let i = 52; i <= 80; i++) mesh.set('vg', numbers(i));
      }, ORIGIN),
    );
    expect(held(doc).values).toBe(2);
    history.undo.undo();
    expect(mesh.get('vg')).toEqual(numbers(51));
  });

  it('frees them while the step runs (compactStep) and counts what the step keeps as it grows', () => {
    const { doc, history, step, set } = setup();
    for (const k of ['a', 'b', 'c']) step(() => set(k, numbers(1)));
    const sizes: number[] = [];
    let most = 0;
    step(() => {
      for (let i = 2; i <= 30; i++) {
        set(['a', 'b', 'c'][i % 3], numbers(i));
        history.compactStep();
        most = Math.max(most, held(doc).values);
        sizes.push(history.kept().bytes);
      }
    });
    // the three versions from before the step, and the three steps' own versions … at most one more
    expect(most).toBeLessThanOrEqual(3 + 3);
    // the step's size counts each version it replaced from before it, once, while it runs
    const before = sizes[0] - (2_000 * 8 + 96);
    expect(sizes.slice(0, 3).map((b) => Math.round((b - before) / (2_000 * 8 + 96)))).toEqual([1, 2, 3]);
    expect(sizes.at(-1)).toBe(sizes[2]);
    history.maintain();
    expect(history.kept().bytes).toBe(sizes[2]);
    expect(historyKept(doc).bytes).toBe(sizes[2]);
  });

  it('frees a version an operation wrote and replaced in one transaction while the step runs', () => {
    // Yjs merges that version with the one from before the step into one deleted item: compactStep
    // collects the part of it the step created, not only items the step created whole
    const { doc, mesh, history, step, set } = setup();
    step(() => set('vg', numbers(1)));
    const during: number[] = [];
    step(() => {
      for (let i = 0; i < 5; i++) {
        doc.transact(() => {
          mesh.set('vg', numbers(100 + 2 * i));
          mesh.set('vg', numbers(101 + 2 * i));
        }, ORIGIN);
        history.compactStep();
        during.push(held(doc).values);
      }
    });
    // only version 1, which undo needs
    expect(during).toEqual([1, 1, 1, 1, 1]);
    history.undo.undo();
    expect(mesh.get('vg')).toEqual(numbers(1));
  });

  it('counts what its redo steps keep, as what its undo steps keep', () => {
    const { doc, history, write } = writer({});
    write('vg', numbers(1));
    write('vg', numbers(2)); // keeps version 1
    const one = history.kept().bytes;
    expect(one).toBeGreaterThanOrEqual(2_000 * 8);
    history.undo.undo();
    history.maintain();
    // version 1 is back; the redo step keeps version 2, the step left to undo nothing
    expect(history.undo.redoStack.length).toBe(1);
    expect(history.kept()).toEqual({ bytes: one, items: 1 });
    expect(historyKept(doc)).toEqual({ bytes: one, items: 1 });
    expect(history.stats().bytes).toBe(Math.round(one));
  });

  it('over maxBytes drops the furthest redo steps, but keeps the next redo when nothing is left to undo', () => {
    // steps that create values keep nothing to undo; undoing them deletes the values, which their
    // redo steps keep
    const one = 2_000 * 8 + 96; // the history's estimate of one version
    const { doc, mesh, history, write } = writer({ maxBytes: 2.5 * one });
    write('a', numbers(1));
    write('b', numbers(2));
    write('c', numbers(3));
    expect(history.undo.undoStack.length).toBe(3);
    for (let u = 0; u < 3; u++) history.undo.undo();
    history.maintain();
    // the redo of c (the furthest) went: a and b fit
    expect(history.undo.redoStack.length).toBe(2);
    expect(held(doc).values).toBe(2);
    expect(history.stats().bytes).toBeLessThanOrEqual(2.5 * one);
    history.undo.redo();
    history.undo.redo();
    expect(mesh.get('a')).toEqual(numbers(1));
    expect(mesh.get('b')).toEqual(numbers(2));
    expect(history.undo.redo()).toBeNull();
    expect(mesh.get('c')).toBeUndefined();
    // a redo step alone over the budget is kept when there is nothing to undo, as the newest step is
    const small = writer({ maxBytes: 0.5 * one });
    small.write('d', numbers(4));
    small.history.undo.undo();
    small.history.maintain();
    expect(small.history.undo.redoStack.length).toBe(1);
    small.history.undo.redo();
    expect(small.mesh.get('d')).toEqual(numbers(4));
  });

  it('measures a step again when it changes after it was measured', () => {
    const { history, step, set } = setup();
    step(() => {
      set('a', numbers(1));
      set('b', numbers(1));
    });
    const um = history.undo;
    um.stopCapturing();
    um.captureTimeout = Number.POSITIVE_INFINITY;
    set('a', numbers(2)); // replaces version 1 of a
    history.maintain(); // measures the step while it runs
    const one = history.kept().bytes;
    set('b', numbers(2)); // the same step replaces version 1 of b
    history.maintain();
    um.captureTimeout = 0;
    expect(um.undoStack.length).toBe(2);
    expect(history.kept()).toEqual({ bytes: 2 * one, items: 2 });
  });

  it('two agents and a remote client: each undoes its own versions exactly, nothing else is held', () => {
    const doc = new Y.Doc();
    const root = doc.getMap<any>('meshes');
    const remote = new Y.Doc();
    doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') Y.applyUpdate(remote, u, 'local');
    });
    remote.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== 'local') Y.applyUpdate(doc, u, 'remote');
    });
    const remoteRoot = remote.getMap<any>('meshes');
    const agents = ['A', 'B'].map((name, n) => {
      const origin = { type: 'mcp', session: name };
      const history = new AgentHistory(doc, [root], origin, { maxSteps: 4 + n });
      const write = (key: string, value: unknown) => {
        history.undo.stopCapturing();
        doc.transact(() => root.set(key, value), origin);
        history.maintain();
      };
      return { origin, history, write };
    });
    const [a, b] = agents;
    // runs of writes to one key (consecutive items Yjs merges), interleaved with the other writers
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 5; i++) a.write('k1', numbers(round * 10 + i, 300));
      for (let i = 0; i < 4; i++) b.write('k2', numbers(1_000 + round * 10 + i, 300));
      remote.transact(() => remoteRoot.set('k3', numbers(2_000 + round, 300)));
      a.write('k3', numbers(3_000 + round, 300));
    }
    // A keeps the versions of its last 4 steps, B those of its last 5; the remote client's own
    // replaced versions are not kept by anyone
    expect(held(doc).values).toBe(4 + 5);
    expect(historyKept(doc).bytes).toBe(a.history.kept().bytes + b.history.kept().bytes);
    // A's last steps: k3 (round 5), k1 54, 53, 52
    a.history.undo.undo();
    expect(root.get('k3')).toEqual(numbers(2_005, 300));
    a.history.undo.undo();
    expect(root.get('k1')).toEqual(numbers(53, 300));
    a.history.undo.undo();
    expect(root.get('k1')).toEqual(numbers(52, 300));
    b.history.undo.undo();
    expect(root.get('k2')).toEqual(numbers(1_052, 300));
    a.history.undo.redo();
    expect(root.get('k1')).toEqual(numbers(53, 300));
    for (const ag of agents) ag.history.maintain();
    expect(remoteRoot.toJSON()).toEqual(root.toJSON());
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
    expect(replica.getMap('meshes').toJSON()).toEqual(root.toJSON());
    // the histories end: nothing is held any more
    a.history.destroy();
    b.history.destroy();
    expect(held(doc)).toEqual({ values: 0, bytes: 0, containers: 0 });
    expect(historyKept(doc).bytes).toBe(0);
  });

  it('frees every deleted container undo still needed when the last history of the document ends', () => {
    const { doc, mesh, history, step } = setup();
    const t = (fn: () => void) => step(() => doc.transact(fn, ORIGIN));
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 10; i++)
        t(() => {
          const o = new Y.Map<any>();
          mesh.set(`o${i}`, o);
          o.set('location', [i, round, 0]);
          o.set('name', `Object ${i}`);
        });
      t(() => {
        for (let i = 0; i < 10; i++) mesh.delete(`o${i}`);
      });
      // undo restores copies of the objects; their originals keep links to them
      history.undo.undo();
      history.maintain();
    }
    expect(mesh.size).toBe(10);
    const before = Y.encodeStateAsUpdate(doc).byteLength;
    expect(held(doc).containers).toBeGreaterThan(0);
    history.destroy();
    expect(held(doc)).toEqual({ values: 0, bytes: 0, containers: 0 });
    // the deleted objects' fields are placeholders now, merged: the state shrinks
    expect(Y.encodeStateAsUpdate(doc).byteLength).toBeLessThan(before / 2);
    expect((mesh.get('o3') as Y.Map<any>).get('location')).toEqual([3, 2, 0]);
  });
});

/*
 * Deleted objects (containers) that undo restored: their originals link to the copies, which undo and
 * redo follow, so a collected container would end those links where they lead below it. The history
 * kept such containers until the last history of the document ended, also after every step that could
 * follow the links into them was dropped, and counted none of them.
 */
describe('AgentHistory: deleted objects that undo restored', () => {
  /** The fields an object gets (`round` tells versions apart). */
  const fields = (i: number, round: number): Record<string, unknown> => ({
    name: `Object ${i}`,
    location: [i, round, 0],
    scale: [1, 1, 1],
    hide: false,
  });
  const OBJECTS = 20;
  /** Items a deleted object keeps: itself, its fields, and a nested map with two fields. */
  const ITEMS = 1 + Object.keys(fields(0, 0)).length + 3;

  /**
   * Agents with the given maxSteps in one document, and the same agents with plain unbounded
   * Y.UndoManagers that drop the same old steps without collecting anything (the reference); every
   * action is applied to both and their states compared.
   */
  function worlds(maxSteps: number[]) {
    const make = (bounded: boolean) => {
      const doc = new Y.Doc();
      doc.clientID = 9;
      const root = doc.getMap<any>('objects');
      const agents = maxSteps.map((steps, n) => {
        const origin = { type: 'mcp', session: `a${n}` };
        const history = bounded ? new AgentHistory(doc, [root], origin, { maxSteps: steps }) : null;
        const um =
          history?.undo ??
          new Y.UndoManager([root], { trackedOrigins: new Set([origin]), captureTimeout: 0 });
        return { origin, history, um, maxSteps: steps };
      });
      return { doc, root, agents };
    };
    const a = make(true);
    const b = make(false);
    const settle = () => {
      for (const ag of a.agents) ag.history!.maintain();
      for (const ag of b.agents) while (ag.um.undoStack.length > ag.maxSteps) ag.um.undoStack.shift();
      expect(a.root.toJSON()).toEqual(b.root.toJSON());
    };
    /** Agent `n` changes the document: one step. */
    const step = (n: number, fn: (root: Y.Map<any>) => void) => {
      for (const w of [a, b]) {
        w.agents[n].um.stopCapturing();
        w.doc.transact(() => fn(w.root), w.agents[n].origin);
      }
      settle();
    };
    const undo = (n: number) => {
      for (const w of [a, b]) w.agents[n].um.undo();
      settle();
    };
    const redo = (n: number) => {
      for (const w of [a, b]) w.agents[n].um.redo();
      settle();
    };
    /** A change no agent tracks (an editor). */
    const editor = (fn: (root: Y.Map<any>) => void) => {
      for (const w of [a, b]) w.doc.transact(() => fn(w.root), { type: 'editor' });
      settle();
    };
    return { a, b, step, undo, redo, editor };
  }

  const addObjects = (round: number) => (root: Y.Map<any>) => {
    for (let i = 0; i < OBJECTS; i++) {
      const o = new Y.Map<any>();
      root.set(`o${i}`, o);
      for (const [k, v] of Object.entries(fields(i, round))) o.set(k, v);
      const nested = new Y.Map<any>();
      o.set('modifier', nested);
      nested.set('type', 'ARRAY');
      nested.set('count', i);
    }
  };
  const deleteObjects = (root: Y.Map<any>) => {
    for (let i = 0; i < OBJECTS; i++) root.delete(`o${i}`);
  };

  it('frees them once the steps that could follow the links into them are dropped', () => {
    const w = worlds([4]);
    const doc = w.a.doc;
    w.step(0, addObjects(0)); // undoing it deletes the objects' latest copies, through the links
    for (let round = 1; round <= 2; round++) {
      w.step(0, deleteObjects);
      w.undo(0); // copies of the objects come back
      w.step(0, (root) => root.set('marker', round)); // and the redo step is dropped
    }
    // the originals and the first copies, deleted (with their nested maps), with the placeholders of
    // their fields
    expect(held(doc).containers).toBe(2 * 2 * OBJECTS);
    // counted with what the history keeps, though no step of it keeps them
    const history = w.a.agents[0].history!;
    expect(historyKept(doc).bytes - history.kept().bytes).toBe(
      KEPT_CONTAINER_ITEM_BYTES * 2 * OBJECTS * ITEMS,
    );
    const before = Y.encodeStateAsUpdate(doc).byteLength;
    // two more steps: the step that created the objects is dropped (4 steps kept)
    w.step(0, (root) => root.set('marker', 3));
    w.step(0, (root) => root.set('marker', 4));
    expect(w.a.agents[0].um.undoStack.length).toBe(4);
    expect(held(doc).containers).toBe(0);
    expect(historyKept(doc).bytes).toBe(history.kept().bytes);
    expect(Y.encodeStateAsUpdate(doc).byteLength).toBeLessThan(before - 1_000);
    // undo and redo of every step left give the reference's states (compared at each one)
    for (let i = 0; i < 4; i++) w.undo(0);
    expect(w.a.root.has('marker')).toBe(false);
    expect((w.a.root.get('o3') as Y.Map<any>).get('location')).toEqual([3, 0, 0]);
    for (let i = 0; i < 4; i++) w.redo(0);
    expect(w.a.root.get('marker')).toBe(4);
  });

  it('keeps them while the step that created them can still be undone: undo deletes the copies', () => {
    const w = worlds([10]);
    const doc = w.a.doc;
    w.step(0, addObjects(0));
    for (let round = 1; round <= 2; round++) {
      w.step(0, deleteObjects);
      w.undo(0);
      w.step(0, (root) => root.set('marker', round));
    }
    for (let i = 0; i < 6; i++) w.step(0, (root) => root.set('other', i));
    expect(held(doc).containers).toBe(2 * 2 * OBJECTS);
    // back to before the objects were created: the latest copies are deleted (compared with the reference)
    while (w.a.agents[0].um.undoStack.length) w.undo(0);
    expect(w.a.root.has('o0')).toBe(false);
    // the step that reached them was applied: they are freed; the latest copies are kept to redo it
    expect(held(doc).containers).toBe(2 * OBJECTS);
    while (w.a.agents[0].um.redoStack.length) w.redo(0);
    expect((w.a.root.get('o7') as Y.Map<any>).get('location')).toEqual([7, 0, 0]);
  });

  it('frees them while another agent keeps steps that cannot reach them', () => {
    const w = worlds([3, 100]);
    const doc = w.a.doc;
    // agent 1 works on something else, then waits
    w.step(1, (root) => root.set('b', 1));
    w.step(1, (root) => root.set('b', 2));
    w.step(0, addObjects(0));
    w.step(0, deleteObjects);
    w.undo(0);
    w.step(0, (root) => root.set('marker', 1));
    expect(held(doc).containers).toBe(2 * OBJECTS);
    for (let i = 2; i <= 4; i++) w.step(0, (root) => root.set('marker', i));
    // agent 0's step that created the objects is dropped; agent 1's steps stay
    expect(w.a.agents[1].um.undoStack.length).toBe(2);
    expect(held(doc).containers).toBe(0);
    w.undo(1);
    w.undo(1);
    expect(w.a.root.has('b')).toBe(false);
    for (let i = 0; i < 3; i++) w.undo(0);
    expect(w.a.root.get('marker')).toBe(1);
  });

  it('frees them when the history of the agent whose step could reach them ends', () => {
    const w = worlds([10, 10]);
    const doc = w.a.doc;
    w.step(1, (root) => root.set('b', 1));
    w.step(0, addObjects(0));
    w.step(0, deleteObjects);
    w.undo(0);
    w.step(0, (root) => root.set('marker', 1));
    expect(held(doc).containers).toBe(2 * OBJECTS); // the objects and their nested maps
    w.a.agents[0].history!.destroy();
    w.b.agents[0].um.destroy();
    expect(held(doc).containers).toBe(0);
    w.undo(1);
    expect(w.a.root.has('b')).toBe(false);
    expect(w.a.root.toJSON()).toEqual(w.b.root.toJSON());
  });

  it('keeps a deleted copy while a step can restore a value into it (its deleted parent links to it)', () => {
    const w = worlds([2]);
    const doc = w.a.doc;
    w.step(0, (root) => {
      const o = new Y.Map<any>();
      root.set('o', o);
      o.set('name', 'Object');
      o.set('f', 1);
    });
    w.step(0, (root) => root.get('o').delete('f')); // keeps the value: undo restores it into the object
    w.step(0, (root) => root.delete('o')); // the step that created the object is dropped (2 kept)
    w.undo(0); // a copy of the object comes back, linked from the original
    w.step(0, (root) => root.set('x', 1));
    w.editor((root) => root.delete('o')); // someone deletes the copy
    // undoing the field's deletion restores it into the original's latest copy: the deleted copy
    // stays (collected, the undo would fail inside Yjs)
    expect(held(doc).containers).toBeGreaterThanOrEqual(1);
    w.undo(0);
    w.undo(0);
    expect(w.a.root.has('o')).toBe(false);
    w.redo(0);
    w.redo(0);
    expect(w.a.root.get('x')).toBe(1);
  });

  it('frees restored objects an editor deleted once no step can reach them', () => {
    const w = worlds([3]);
    const doc = w.a.doc;
    w.step(0, addObjects(0));
    w.step(0, deleteObjects);
    w.undo(0); // copies come back (Yjs keeps restored copies)
    w.editor(deleteObjects); // someone else deletes them
    // the originals and the copies: the step that created the objects can reach both
    expect(held(doc).containers).toBe(2 * 2 * OBJECTS);
    w.redo(0); // nothing left to delete: discarded
    for (let i = 1; i <= 3; i++) w.step(0, (root) => root.set('marker', i));
    expect(held(doc).containers).toBe(0);
    for (let i = 0; i < 3; i++) w.undo(0);
    expect(w.a.root.has('marker')).toBe(false);
    expect(w.a.root.has('o1')).toBe(false);
  });

  it('past its search budget counts the oldest steps as reaching them: kept until those are dropped', () => {
    const budget = reachSearch.budget;
    // two items for each of the three newest steps, and one of the step before: no more
    reachSearch.budget = 7;
    try {
      const w = worlds([8]);
      const doc = w.a.doc;
      /** A step that adds two values under keys of their own (two items, which never merge). */
      const mark = (i: number) => (root: Y.Map<any>) => {
        root.set(`m${i}`, i);
        root.set(`n${i}`, -i);
      };
      w.step(0, (root) => {
        const o = new Y.Map<any>();
        root.set('o', o);
        o.set('name', 'Object');
        o.set('location', [0, 0, 0]);
      });
      // a value below the object: undoing this step follows the link of the value's copy
      w.step(0, (root) => (root.get('o') as Y.Map<any>).set('location', [1, 0, 0]));
      for (let i = 1; i <= 4; i++) w.step(0, mark(i));
      w.step(0, (root) => root.delete('o'));
      w.undo(0); // a copy comes back; the original is kept for the steps that can reach it
      expect(held(doc).containers).toBe(1);
      // the three oldest steps are dropped: they were not searched and counted as reaching it
      for (let i = 5; i <= 9; i++) w.step(0, mark(i));
      expect(w.a.agents[0].um.undoStack.length).toBe(8);
      expect(held(doc).containers).toBe(0);
      // undo and redo of every step left give the reference's states (compared at each one)
      for (let i = 0; i < 8; i++) w.undo(0);
      expect(w.a.root.has('m2')).toBe(false);
      expect(w.a.root.get('m1')).toBe(1);
      expect((w.a.root.get('o') as Y.Map<any>).get('location')).toEqual([1, 0, 0]);
      for (let i = 0; i < 8; i++) w.redo(0);
      expect(w.a.root.get('n9')).toBe(-9);
    } finally {
      reachSearch.budget = budget;
    }
  });
});
