import { it, expect } from 'vitest';
import * as Y from 'yjs';
import { AgentHistory } from '../../src/mcp/history';

function blob(tag: number, size = 100_000): Uint8Array {
  const b = new Uint8Array(size);
  b[0] = tag;
  return b;
}
function retained(doc: Y.Doc): number {
  let bytes = 0;
  for (const structs of doc.store.clients.values())
    for (const s of structs)
      if (s instanceof Y.Item && s.deleted && s.content instanceof Y.ContentBinary) bytes += s.content.content.byteLength;
  return bytes;
}

it('fuzz many seeds, 1-3 agents + remote edits', () => {
  const failures: string[] = [];
  let runs = 0;
  for (let seed = 1; seed <= 400; seed++) {
    let x = seed * 104729 + 17;
    const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
    const nAgents = 1 + (seed % 3);
    const maxSteps = [1, 2, 3, 5, 1000][seed % 5];
    const remote = seed % 4 === 0;
    const make = (bounded: boolean) => {
      const doc = new Y.Doc();
      doc.clientID = 7;
      const root = doc.getMap<any>('meshes');
      const agents = Array.from({ length: nAgents }, (_, n) => {
        const origin = { type: 'mcp', session: `A${n}` };
        const history = bounded ? new AgentHistory(doc, [root], origin, { maxSteps }) : null;
        const um = history?.undo ?? new Y.UndoManager([root], { trackedOrigins: new Set([origin]), captureTimeout: 0 });
        return { origin, history, um };
      });
      return { doc, root, agents, name: bounded ? 'bounded' : 'reference' };
    };
    const a = make(true);
    const b = make(false);
    let failed = '';
    runs++;
    for (let i = 0; i < 300 && !failed; i++) {
      const who = Math.floor(rnd() * (nAgents + (remote ? 1 : 0)));
      const isRemote = who === nAgents;
      const r = rnd();
      const choice = isRemote ? 'edit' : r < 0.15 ? 'undo' : r < 0.24 ? 'redo' : 'edit';
      const ops: ((root: Y.Map<any>) => void)[] = [];
      if (choice === 'edit')
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
              else if (o.get('child') instanceof Y.Map && kind < 0.55) o.get('child').set(field, blob(tag, 48));
              else if (kind < 0.6) o.delete(field);
              else o.set(field, field === 'data' ? blob(tag, 64) : [tag]);
            } else root.set(key, blob(tag, 32));
          });
        }
      for (const d of [a, b]) {
        try {
          if (isRemote) {
            for (const op of ops) d.doc.transact(() => op(d.root), { type: 'remote' });
            continue;
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
        } catch (e) {
          failed = `seed ${seed} op ${i} ${who} ${choice}: ${d.name} threw ${(e as Error).message}`;
        }
      }
      for (const ag of a.agents) ag.history!.maintain();
      for (const ag of b.agents) while (ag.um.undoStack.length > maxSteps) ag.um.undoStack.shift();
      if (!failed && JSON.stringify(a.root.toJSON()) !== JSON.stringify(b.root.toJSON()))
        failed = `seed ${seed} op ${i} ${who} ${choice}: states differ`;
    }
    if (!failed && retained(a.doc) > retained(b.doc)) failed = `seed ${seed}: retains more ${retained(a.doc)} > ${retained(b.doc)}`;
    if (!failed) {
      // end histories one by one; the others keep working like the reference
      for (let k = 0; k < nAgents - 1 && !failed; k++) {
        a.agents[k].history!.destroy();
        b.agents[k].um.destroy();
        const last = nAgents - 1;
        for (let u = 0; u < 3 && !failed; u++) {
          try { a.agents[last].um.undo(); } catch (e) { failed = `seed ${seed} end ${k} undo ${u}: bounded threw ${(e as Error).message}`; }
          try { b.agents[last].um.undo(); } catch (e) { failed = failed || `seed ${seed} end ${k}: reference threw ${(e as Error).message}`; }
          a.agents[last].history!.maintain();
          if (!failed && JSON.stringify(a.root.toJSON()) !== JSON.stringify(b.root.toJSON())) failed = `seed ${seed} end ${k} undo ${u}: states differ`;
        }
      }
      for (const ag of a.agents) ag.history!.destroy();
      if (!failed && retained(a.doc) !== 0) {
        failed = `seed ${seed}: retains ${retained(a.doc)} after all ended`;
        if ([4, 14, 52].includes(seed)) {
          for (const structs of a.doc.store.clients.values())
            for (const st of structs)
              if (st instanceof Y.Item && st.deleted && st.content instanceof Y.ContentBinary) {
                const par = (st.parent as any)._item as Y.Item | null;
                console.log(`seed ${seed} retained ${st.id.client}:${st.id.clock} keep=${st.keep} redone=${st.redone ? st.redone.clock : null} parentSub=${st.parentSub} parent=${par ? `${par.id.clock} deleted=${par.deleted} keep=${par.keep}` : 'root'}`);
              }
        }
      }
    }
    if (failed) failures.push(failed);
  }
  console.log(`runs ${runs}, failures ${failures.length}\n` + failures.slice(0, 30).join('\n'));
  expect(failures).toEqual([]);
});
