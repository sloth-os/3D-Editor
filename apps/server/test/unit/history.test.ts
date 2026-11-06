import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { AgentHistory } from '../../src/mcp/history';

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
            const field = pick(['data', 'name', 'loc']);
            const kind = rnd();
            const tag = Math.floor(rnd() * 250);
            ops.push((d) => {
              const o = d.root.get(key);
              if (kind < 0.2) d.root.set(key, new Y.Map());
              else if (kind < 0.3) d.root.delete(key);
              else if (o instanceof Y.Map) o.set(field, field === 'data' ? blob(tag, 64) : [tag, tag + 1]);
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
      }
      // the bounded history keeps no more replaced data than the reference
      expect(retained(a.doc).bytes).toBeLessThanOrEqual(retained(b.doc).bytes);
      a.history!.destroy();
      expect(retained(a.doc).items).toBe(0);
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
            const field = pick(['data', 'name']);
            const kind = rnd();
            const tag = Math.floor(rnd() * 250);
            ops.push((root) => {
              const o = root.get(key);
              if (kind < 0.15) root.set(key, new Y.Map());
              else if (kind < 0.25) root.delete(key);
              else if (o instanceof Y.Map) {
                if (kind < 0.35) o.set('child', new Y.Map());
                else if (o.get('child') instanceof Y.Map && kind < 0.55)
                  o.get('child').set(field, blob(tag, 48));
                else o.set(field, field === 'data' ? blob(tag, 64) : [tag]);
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
      }
      expect(retained(a.doc).bytes).toBeLessThanOrEqual(retained(b.doc).bytes);
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
            const field = pick(['data', 'name']);
            const kind = rnd();
            const tag = Math.floor(rnd() * 250);
            ops.push((root) => {
              const o = root.get(key);
              if (kind < 0.15) root.set(key, new Y.Map());
              else if (kind < 0.25) root.delete(key);
              else if (o instanceof Y.Map) {
                if (kind < 0.35) o.set('child', new Y.Map());
                else if (o.get('child') instanceof Y.Map && kind < 0.55)
                  o.get('child').set(field, blob(tag, 48));
                else if (kind < 0.6) o.delete(field);
                else o.set(field, field === 'data' ? blob(tag, 64) : [tag]);
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
      }
      if (!referenceFailed)
        expect(retained(a.doc).bytes, `seed ${seed}`).toBeLessThanOrEqual(retained(b.doc).bytes);
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
    }
  });
});
