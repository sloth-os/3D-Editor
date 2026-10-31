import { describe, expect, it } from 'vitest';
import {
  appendMesh,
  buildTopology,
  changeSelectMode,
  createCube,
  createGrid,
  createTorus,
  createUVSphere,
  edgeKey,
  edgeLoop,
  edgeRing,
  emptySelection,
  flushSelection,
  loopSelect,
  rotationFromEuler,
  selectAll,
  selectAllElements,
  selectByNormal,
  selectElements,
  selectLess,
  selectLinked,
  selectLoose,
  selectMore,
  selectNonManifold,
  selectRandom,
  selectionFromEdges,
  selectionFromFaces,
  selectionFromVerts,
  deleteGeometry,
  type MeshData,
  type MeshSelection,
} from '../src';

const sizes = (s: MeshSelection) => ({ verts: s.verts.size, edges: s.edges.size, faces: s.faces.size });

/** Index of grid vertex (i, j) for createGrid({x_subdivisions: n}). */
const gv = (n: number, i: number, j: number) => j * (n + 1) + i;

function twoCubes(): MeshData {
  const m = createCube();
  appendMesh(m, createCube(), (p) => [p[0] + 5, p[1], p[2]]);
  return m;
}

describe('select all / mode', () => {
  it('toggles, selects, deselects and inverts', () => {
    const m = createCube();
    expect(sizes(selectAll(m, emptySelection(), 'TOGGLE', 'VERT'))).toEqual({
      verts: 8,
      edges: 12,
      faces: 6,
    });
    expect(sizes(selectAll(m, selectionFromVerts(m, [0]), 'TOGGLE', 'VERT'))).toEqual({
      verts: 0,
      edges: 0,
      faces: 0,
    });
    expect(sizes(selectAll(m, emptySelection(), 'DESELECT', 'VERT'))).toEqual({
      verts: 0,
      edges: 0,
      faces: 0,
    });
    const inv = selectAll(m, selectionFromFaces(m, [5]), 'INVERT', 'FACE');
    expect([...inv.faces].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('converts between select modes, optionally expanding', () => {
    const m = createCube();
    const one = selectionFromVerts(m, [1]);
    expect(changeSelectMode(m, one, 'VERT', 'FACE').faces.size).toBe(0);
    expect(changeSelectMode(m, one, 'VERT', 'FACE', true).faces.size).toBe(3);
    expect(changeSelectMode(m, one, 'VERT', 'EDGE', true).edges.size).toBe(3);
    const top = selectionFromFaces(m, [5]);
    expect(changeSelectMode(m, top, 'FACE', 'VERT').verts.size).toBe(4);
  });
});

describe('select_elements', () => {
  it('selects explicit vertices, edges and faces in any mode', () => {
    const m = createCube();
    const s = selectElements(m, emptySelection(), { verts: [1, 5, 7, 3] }, { mode: 'FACE' });
    expect([...s.faces]).toEqual([5]);
    const e = selectElements(m, emptySelection(), { edges: [[0, 1]] }, { mode: 'EDGE' });
    expect([...e.edges]).toEqual([edgeKey(0, 1)]);
    expect(e.verts.size).toBe(2);
    const f = selectElements(m, emptySelection(), { faces: [0, 1] }, { mode: 'FACE' });
    expect(sizes(f)).toEqual({ verts: 8, edges: 8, faces: 2 });
  });

  it('extends and deselects', () => {
    const m = createCube();
    let s = selectElements(m, emptySelection(), { faces: [0] }, { mode: 'FACE' });
    s = selectElements(m, s, { faces: [1] }, { mode: 'FACE', extend: true });
    expect([...s.faces].sort()).toEqual([0, 1]);
    s = selectElements(m, s, { faces: [0] }, { mode: 'FACE', deselect: true });
    expect([...s.faces]).toEqual([1]);
    const v = selectElements(m, selectAllElements(m), { verts: [0] }, { mode: 'VERT', deselect: true });
    expect(v.verts.size).toBe(7);
    expect(v.faces.size).toBe(3);
  });

  it('rejects invalid references with a clear message', () => {
    const m = createCube();
    expect(() => selectElements(m, emptySelection(), { verts: [99] }, { mode: 'VERT' })).toThrow(
      /out of range/,
    );
    expect(() => selectElements(m, emptySelection(), { edges: [[0, 7]] }, { mode: 'EDGE' })).toThrow(
      /does not exist/,
    );
    expect(() => selectElements(m, emptySelection(), { faces: [6] }, { mode: 'FACE' })).toThrow(
      /out of range/,
    );
  });
});

describe('linked / more / less', () => {
  it('selects only the connected island', () => {
    const m = twoCubes();
    const s = flushSelection(m, selectLinked(m, selectionFromVerts(m, [0]), 'VERT', []), 'VERT');
    expect(sizes(s)).toEqual({ verts: 8, edges: 12, faces: 6 });
    expect([...s.verts].every((v) => v < 8)).toBe(true);
    const f = flushSelection(m, selectLinked(m, selectionFromFaces(m, [7]), 'FACE'), 'FACE');
    expect([...f.faces].sort((a, b) => a - b)).toEqual([6, 7, 8, 9, 10, 11]);
  });

  it('stops at seams when delimited', () => {
    const n = 4;
    const m = createGrid({ x_subdivisions: n, y_subdivisions: n });
    // Seam along the vertical grid line i = 2.
    for (let j = 0; j < n; j++) m.edgeAttrs[edgeKey(gv(n, 2, j), gv(n, 2, j + 1))] = { seam: true };
    const s = flushSelection(m, selectLinked(m, selectionFromFaces(m, [0]), 'FACE', ['SEAM']), 'FACE');
    expect(s.faces.size).toBe(8);
    const all = flushSelection(m, selectLinked(m, selectionFromFaces(m, [0]), 'FACE', []), 'FACE');
    expect(all.faces.size).toBe(16);
  });

  it('grows and shrinks around a vertex', () => {
    const n = 4;
    const m = createGrid({ x_subdivisions: n, y_subdivisions: n });
    const center = gv(n, 2, 2);
    const more = selectMore(m, selectionFromVerts(m, [center]), 'VERT');
    expect(more.verts.size).toBe(9);
    expect(more.faces.size).toBe(4);
    const edgeStep = selectMore(m, selectionFromVerts(m, [center]), 'VERT', false);
    expect(edgeStep.verts.size).toBe(5);
    const less = selectLess(m, more, 'VERT');
    expect([...less.verts]).toEqual([center]);
    // Face step grows across vertices; shrinking a block away from the border gives the center back.
    const g6 = createGrid({ x_subdivisions: 6, y_subdivisions: 6 });
    const faceMore = selectMore(g6, selectionFromFaces(g6, [2 * 6 + 2]), 'FACE');
    expect(faceMore.faces.size).toBe(9);
    expect([...selectLess(g6, faceMore, 'FACE').faces]).toEqual([14]);
    expect(selectMore(g6, selectionFromFaces(g6, [14]), 'FACE', false).faces.size).toBe(5);
  });
});

describe('loops and rings', () => {
  it('selects closed latitude loops and pole-to-pole meridians on a UV sphere', () => {
    const seg = 8;
    const rings = 6;
    const m = createUVSphere({ segments: seg, ring_count: rings });
    const topo = buildTopology(m);
    const ringV = (k: number, j: number) => 1 + (k - 1) * seg + (j % seg);
    const lat = topo.edgeIndex.get(edgeKey(ringV(2, 0), ringV(2, 1)))!;
    const loop = edgeLoop(m, topo, lat);
    expect(loop).toHaveLength(seg);
    expect(new Set(loop.flatMap((e) => topo.edges[e])).size).toBe(seg);
    const mer = topo.edgeIndex.get(edgeKey(ringV(2, 0), ringV(3, 0)))!;
    expect(edgeLoop(m, topo, mer)).toHaveLength(rings);
  });

  it('selects both loop directions on a torus', () => {
    const m = createTorus({ major_segments: 12, minor_segments: 6 });
    const s1 = loopSelect(m, emptySelection(), [0, 6], { mode: 'EDGE' }); // around the major circle
    expect(s1.edges.size).toBe(12);
    const s2 = loopSelect(m, emptySelection(), [0, 1], { mode: 'EDGE' }); // around the tube
    expect(s2.edges.size).toBe(6);
  });

  it('handles grid interior, boundary loops and rings', () => {
    const n = 4;
    const m = createGrid({ x_subdivisions: n, y_subdivisions: n });
    const interior = loopSelect(m, emptySelection(), [gv(n, 1, 2), gv(n, 2, 2)], { mode: 'EDGE' });
    expect(interior.edges.size).toBe(n);
    const boundary = loopSelect(m, emptySelection(), [gv(n, 1, 0), gv(n, 2, 0)], { mode: 'EDGE' });
    expect(boundary.edges.size).toBe(4 * n);
    const ring = loopSelect(m, emptySelection(), [gv(n, 1, 2), gv(n, 2, 2)], { mode: 'EDGE', ring: true });
    expect(ring.edges.size).toBe(n + 1);
    const topo = buildTopology(m);
    expect(edgeRing(m, topo, topo.edgeIndex.get(edgeKey(gv(n, 1, 2), gv(n, 2, 2)))!).faces).toHaveLength(n);
    const faceLoop = loopSelect(m, emptySelection(), [gv(n, 1, 2), gv(n, 2, 2)], { mode: 'FACE' });
    expect(faceLoop.faces.size).toBe(n);
  });

  it('extends, deselects and toggles', () => {
    const m = createTorus({ major_segments: 12, minor_segments: 6 });
    let s = loopSelect(m, emptySelection(), [0, 6], { mode: 'EDGE' });
    s = loopSelect(m, s, [0, 1], { mode: 'EDGE', extend: true });
    expect(s.edges.size).toBe(18);
    s = loopSelect(m, s, [0, 1], { mode: 'EDGE', toggle: true });
    expect(s.edges.size).toBe(12);
    s = loopSelect(m, s, [0, 6], { mode: 'EDGE', deselect: true });
    expect(s.edges.size).toBe(0);
    expect(() => loopSelect(m, s, [0, 50], { mode: 'EDGE' })).toThrow(/does not exist/);
  });
});

describe('special selections', () => {
  it('selects non-manifold boundary edges', () => {
    const c = createCube();
    const open = deleteGeometry(c, selectionFromFaces(c, [5]), 'FACE').mesh;
    const s = selectNonManifold(open, emptySelection());
    expect(s.edges.size).toBe(4);
    expect(selectNonManifold(c, emptySelection()).edges.size).toBe(0);
  });

  it('selects loose geometry', () => {
    const m = createCube();
    m.positions.push(5, 5, 5, 6, 6, 6, 7, 7, 7);
    m.looseEdges.push(9, 10);
    const s = selectLoose(m, emptySelection());
    expect([...s.verts].sort()).toEqual([10, 8, 9].sort());
    expect([...s.edges]).toEqual([edgeKey(9, 10)]);
    expect(s.faces.size).toBe(0);
  });

  it('random selection is deterministic per seed', () => {
    const m = createGrid({ x_subdivisions: 10, y_subdivisions: 10 });
    const a = selectRandom(m, emptySelection(), { ratio: 0.5, seed: 3, action: 'SELECT', mode: 'FACE' });
    const b = selectRandom(m, emptySelection(), { ratio: 0.5, seed: 3, action: 'SELECT', mode: 'FACE' });
    const c = selectRandom(m, emptySelection(), { ratio: 0.5, seed: 4, action: 'SELECT', mode: 'FACE' });
    expect([...a.faces]).toEqual([...b.faces]);
    expect([...a.faces]).not.toEqual([...c.faces]);
    expect(a.faces.size).toBeGreaterThan(25);
    expect(a.faces.size).toBeLessThan(75);
    expect(
      selectRandom(m, emptySelection(), { ratio: 1, seed: 0, action: 'SELECT', mode: 'VERT' }).verts.size,
    ).toBe(121);
    const none = selectRandom(m, selectAllElements(m), {
      ratio: 1,
      seed: 0,
      action: 'DESELECT',
      mode: 'EDGE',
    });
    expect(none.edges.size).toBe(0);
  });

  it('selects faces by normal direction (top faces)', () => {
    const c = createCube();
    const top = selectByNormal(c, emptySelection(), { direction: [0, 0, 1], angle: 0.1, mode: 'FACE' });
    expect([...top.faces]).toEqual([5]);
    const sphere = createUVSphere({ segments: 16, ring_count: 8 });
    const cap = selectByNormal(sphere, emptySelection(), {
      direction: [0, 0, 1],
      angle: Math.PI / 6,
      mode: 'FACE',
    });
    expect(cap.faces.size).toBe(16);
    // Rotate the object 90° about X: world +Y now corresponds to local +Z.
    const rotated = selectByNormal(c, emptySelection(), {
      direction: [0, -1, 0],
      angle: 0.1,
      mode: 'FACE',
      matrix: rotationFromEuler([Math.PI / 2, 0, 0]),
    });
    expect([...rotated.faces]).toEqual([5]);
    const extended = selectByNormal(c, top, {
      direction: [0, 0, -1],
      angle: 0.1,
      mode: 'FACE',
      extend: true,
    });
    expect([...extended.faces].sort()).toEqual([4, 5]);
  });

  it('edge selections flush to faces only when complete', () => {
    const m = createCube();
    const s = selectionFromEdges(m, [edgeKey(1, 5), edgeKey(5, 7), edgeKey(7, 3), edgeKey(3, 1)]);
    expect([...s.faces]).toEqual([5]);
  });
});
