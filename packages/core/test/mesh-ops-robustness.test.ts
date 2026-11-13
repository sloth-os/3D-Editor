import { describe, expect, it } from 'vitest';
import {
  appendMesh,
  bevel,
  bridgeEdgeLoops,
  buildTopology,
  countInconsistentEdges,
  createCircle,
  createCone,
  createCube,
  createCylinder,
  createGrid,
  createIcoSphere,
  createTorus,
  createUVSphere,
  cubeProject,
  cylinderProject,
  deleteGeometry,
  dissolveEdges,
  dissolveFaces,
  dissolveVerts,
  duplicateSelection,
  edgeFaceAdd,
  emptySelection,
  extrudeEdgesOnly,
  extrudeIndividualFaces,
  extrudeRegion,
  extrudeVerticesOnly,
  fillHoles,
  flipNormals,
  flushSelection,
  insetFaces,
  isClosedManifold,
  loopCut,
  makeNormalsConsistent,
  markSeam,
  markSharp,
  mergeVertices,
  pokeFaces,
  quadsToTris,
  removeDoubles,
  resetUVs,
  selectRandom,
  separateMesh,
  setEdgeCrease,
  smartProject,
  smoothVertices,
  solidifyFaces,
  sphereProject,
  spin,
  splitSelection,
  subdivide,
  symmetrize,
  trisToQuads,
  validateMesh,
  vertexCount,
  type MeshData,
  type MeshSelection,
  type SelectMode,
} from '../src';
import { seededRandom } from '../src/mesh/ops/util';

/*
 * Randomized robustness sweep: every operation runs on several primitives with random selections
 * in all select modes. Each run must either fail with a clear "nothing suitable selected" style
 * error or return a structurally valid mesh; operations that are supposed to keep closed meshes
 * closed (and consistently wound) are checked for that too.
 */

type Op = (m: MeshData, s: MeshSelection) => { mesh: MeshData };

const PRIMITIVES: [string, () => MeshData][] = [
  ['cube', () => createCube()],
  ['grid', () => createGrid({ x_subdivisions: 4, y_subdivisions: 3 })],
  ['uv sphere', () => createUVSphere({ segments: 8, ring_count: 5 })],
  ['ico sphere', () => createIcoSphere({ subdivisions: 1 })],
  ['cylinder', () => createCylinder({ vertices: 6 })],
  ['cone', () => createCone({ vertices: 5 })],
  ['torus', () => createTorus({ major_segments: 6, minor_segments: 4 })],
  ['circle', () => createCircle({ vertices: 6 })],
  [
    'mixed',
    () => {
      const m = createCube();
      appendMesh(m, createCircle({ vertices: 5 }), (p) => [p[0] + 3, p[1], p[2]]);
      m.positions.push(9, 9, 9);
      m.colors = new Array(vertexCount(m) * 4).fill(0.3);
      return m;
    },
  ],
];

const firstEdge = (m: MeshData, s: MeshSelection): [number, number] => {
  const t = buildTopology(m);
  return t.edges[s.edges.size % Math.max(1, t.edges.length)] ?? [0, 1];
};

const OPS: [string, Op, boolean][] = [
  // [name, op, keeps closed meshes closed]
  [
    'extrude region',
    (m, s) => extrudeRegion(m, s, { offset: [0, 0, 0.3], normalOffset: 0.1, evenOffset: true }),
    false,
  ],
  ['extrude edges', (m, s) => extrudeEdgesOnly(m, s, { offset: [0.1, 0, 0] }), false],
  ['extrude verts', (m, s) => extrudeVerticesOnly(m, s, { offset: [0.1, 0, 0] }), false],
  ['extrude faces', (m, s) => extrudeIndividualFaces(m, s, 0.2), true],
  ['inset', (m, s) => insetFaces(m, s, { thickness: 0.05, depth: 0.02 }), true],
  ['inset individual', (m, s) => insetFaces(m, s, { thickness: 0.05, individual: true }), true],
  ['loop cut', (m, s) => loopCut(m, firstEdge(m, s), { cuts: 2, smoothness: 0.3 }), true],
  ['subdivide', (m, s) => subdivide(m, s, { cuts: 2, smoothness: 0.5 }), true],
  ['delete verts', (m, s) => deleteGeometry(m, s, 'VERT'), false],
  ['delete edges', (m, s) => deleteGeometry(m, s, 'EDGE'), false],
  ['delete faces', (m, s) => deleteGeometry(m, s, 'FACE'), false],
  ['delete only faces', (m, s) => deleteGeometry(m, s, 'ONLY_FACE'), false],
  ['delete edges+faces', (m, s) => deleteGeometry(m, s, 'EDGE_FACE'), false],
  ['dissolve verts', (m, s) => dissolveVerts(m, s), true],
  ['dissolve edges', (m, s) => dissolveEdges(m, s), true],
  ['dissolve faces', (m, s) => dissolveFaces(m, s, { useVerts: true }), true],
  ['merge collapse', (m, s) => mergeVertices(m, s, 'COLLAPSE'), false],
  ['merge center', (m, s) => mergeVertices(m, s, 'CENTER'), false],
  ['remove doubles', (m, s) => removeDoubles(m, s, 0.5), false],
  ['edge/face add', (m, s) => edgeFaceAdd(m, s), false],
  ['fill', (m, s) => fillHoles(m, s), false],
  ['triangulate', (m, s) => quadsToTris(m, s), true],
  ['tris to quads', (m, s) => trisToQuads(m, s), true],
  ['poke', (m, s) => pokeFaces(m, s, { offset: 0.1 }), true],
  ['flip normals', (m, s) => flipNormals(m, s), false],
  ['recalc normals', (m, s) => makeNormalsConsistent(m, s), true],
  ['smooth', (m, s) => smoothVertices(m, s, { repeat: 2 }), true],
  ['duplicate', (m, s) => duplicateSelection(m, s, [1, 0, 0]), false],
  ['split', (m, s) => splitSelection(m, s), false],
  ['separate', (m, s) => separateMesh(m, s, 'SELECTED'), false],
  ['mark seam', (m, s) => markSeam(m, s), true],
  ['mark sharp', (m, s) => markSharp(m, s, { useVerts: true }), true],
  ['crease', (m, s) => setEdgeCrease(m, s, 0.3), true],
  ['bevel edges', (m, s) => bevel(m, s, { offset: 0.05, segments: 2 }), true],
  ['bevel edges 1', (m, s) => bevel(m, s, { offset: 0.05 }), true],
  ['bevel verts', (m, s) => bevel(m, s, { offset: 0.05, affect: 'VERTICES', segments: 3 }), true],
  ['bridge', (m, s) => bridgeEdgeLoops(m, s, { cuts: 1 }), false],
  ['spin', (m, s) => spin(m, s, { steps: 3, angle: 1 }), false],
  ['spin 360', (m, s) => spin(m, s, { steps: 4, angle: Math.PI * 2, axis: [0, 1, 0] }), false],
  ['symmetrize selected', (m, s) => symmetrize(m, s, 'NEGATIVE_X'), false],
  ['symmetrize all', (m) => symmetrize(m, emptySelection(), 'NEGATIVE_Y'), true],
  ['solidify', (m, s) => solidifyFaces(m, s, 0.1), false],
  ['smart project', (m, s) => smartProject(m, s, { islandMargin: 0.02 }), true],
  ['cube project', (m, s) => cubeProject(m, s), true],
  ['cylinder project', (m, s) => cylinderProject(m, s), true],
  ['sphere project', (m, s) => sphereProject(m, s), true],
  ['reset uvs', (m, s) => resetUVs(m, s), true],
];

const EXPECTED_ERRORS =
  /No .* selected|already exists|at least|Select |manifold|Cannot bridge|outline|simple chain|one connected part|one material|does not exist|needs at least one quad/;

describe('randomized robustness', () => {
  it('every operation returns valid meshes or a clear error', () => {
    const rnd = seededRandom(42);
    const problems: string[] = [];
    for (const [pn, make] of PRIMITIVES) {
      for (let trial = 0; trial < 6; trial++) {
        const m = make();
        const mode: SelectMode = (['VERT', 'EDGE', 'FACE'] as const)[trial % 3];
        const ratio = trial === 5 ? 1 : [0.15, 0.4, 0.7][trial % 3];
        const sel = flushSelection(
          m,
          selectRandom(m, emptySelection(), { ratio, seed: Math.floor(rnd() * 1e6), action: 'SELECT', mode }),
          mode,
        );
        const closedIn = isClosedManifold(m) && countInconsistentEdges(m) === 0;
        for (const [on, op, keepsClosed] of OPS) {
          const tag = `${pn} #${trial} ${mode} ${on}`;
          let mesh: MeshData;
          try {
            mesh = op(m, sel).mesh;
          } catch (e) {
            const msg = (e as Error).message;
            if (!EXPECTED_ERRORS.test(msg)) problems.push(`${tag}: unexpected error ${msg}`);
            continue;
          }
          const v = validateMesh(mesh);
          if (v.length) problems.push(`${tag}: ${v.slice(0, 2).join('; ')}`);
          const mustStayClosed = keepsClosed || (on === 'extrude region' && mode === 'FACE');
          if (closedIn && mustStayClosed) {
            if (!isClosedManifold(mesh)) problems.push(`${tag}: not closed`);
            if (countInconsistentEdges(mesh)) problems.push(`${tag}: inconsistent winding`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  }, 30000);
});
