import { describe, expect, it, vi } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';

/*
 * The children of an object are found from two stored fields of each object (its parent and name),
 * not from copies of every object: the desk looks up an actor's parts for every frame it measures.
 */

function family() {
  const doc = SceneDoc.create({ empty: true });
  const root = doc.addObject({ type: 'EMPTY', name: 'Rig' });
  const kids = ['shin', 'Arm', 'body', 'arm.001', 'Zed'].map((name) =>
    doc.addObject({ type: 'EMPTY', name, parent: root }),
  );
  const grandchild = doc.addObject({ type: 'EMPTY', name: 'hand', parent: kids[1] });
  const loose = ['b', 'A', 'c'].map((name) => doc.addObject({ type: 'EMPTY', name }));
  return { doc, root, kids, grandchild, loose };
}

/** The children as the objects themselves list them: listObjects' order (by name), filtered by parent. */
const listed = (doc: SceneDoc, id: string | null) =>
  doc
    .listObjects()
    .filter((o) => o.parent === id)
    .map((o) => o.id);

describe('the children of an object', () => {
  it('are listed by name as listObjects orders them, without copying any object', () => {
    const { doc, root, kids, grandchild } = family();
    const reads = vi.spyOn(doc, 'getObject');
    const ids = doc.childIds(root);
    const rootIds = doc.childIds(null);
    const index = doc.childrenIndex();
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    expect(ids).toEqual(listed(doc, root));
    expect(new Set(ids)).toEqual(new Set(kids));
    expect(rootIds).toEqual(listed(doc, null));
    expect(doc.childIds(kids[1])).toEqual([grandchild]);
    expect(doc.childIds(grandchild)).toEqual([]);
    expect(doc.childIds('no-such-object')).toEqual([]);
    for (const o of doc.listObjects()) expect(index.get(o.id) ?? [], o.name).toEqual(listed(doc, o.id));
    expect(index.get(null)).toEqual(rootIds);
    // childrenOf: the objects themselves, in the same order
    expect(doc.childrenOf(root).map((o) => o.id)).toEqual(ids);
    expect(doc.childrenOf(root)[0]).toEqual(doc.getObject(ids[0]));
  });

  it('follow renames, reparenting and removals', () => {
    const { doc, root, kids, loose } = family();
    doc.updateObject(kids[0], { name: 'Aaa' });
    doc.updateObject(loose[0], { parent: root });
    doc.removeObject(kids[4]);
    expect(doc.childIds(root)).toEqual(listed(doc, root));
    expect(doc.childIds(root)[0]).toBe(kids[0]);
    expect(doc.childIds(root)).toContain(loose[0]);
    expect(doc.childIds(root)).not.toContain(kids[4]);
    expect(doc.childIds(null)).toEqual(listed(doc, null));
    expect(doc.childrenIndex().get(root)).toEqual(listed(doc, root));
  });
});
