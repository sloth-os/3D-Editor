import { z } from 'zod';
import type { Vec3 } from '../math/types';
import type { MeshData } from '../mesh/types';
import { meshStats } from '../mesh/types';
import type { MeshSelection } from '../mesh/selection';
import { emptySelection, flushSelection } from '../mesh/selection';
import type { MeshOpResult } from '../mesh/ops/types';
import {
  bevel,
  bridgeEdgeLoops,
  changeSelectMode,
  cubeProject,
  cylinderProject,
  deleteGeometry,
  dissolveEdges,
  dissolveFaces,
  dissolveVerts,
  duplicateSelection,
  edgeFaceAdd,
  extrudeEdgesOnly,
  extrudeIndividualFaces,
  extrudeRegion,
  extrudeVerticesOnly,
  fillHoles,
  flipNormals,
  insetFaces,
  loopCut,
  loopSelect,
  makeNormalsConsistent,
  markSeam,
  markSharp,
  mergeVertices,
  pokeFaces,
  quadsToTris,
  removeDoubles,
  resetUVs,
  selectAll,
  selectByNormal,
  selectElements,
  selectLess,
  selectLinked,
  selectLoose,
  selectMore,
  selectNonManifold,
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
} from '../mesh/ops';
import { newId } from '../util/id';
import type { OperatorContext } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import {
  commitEdit,
  editTarget,
  pollEditMesh,
  vec3,
  worldDirToLocal,
  worldToLocal,
  type EditTarget,
} from './helpers';

/*
 * Edit-mode mesh operators (mesh.select_*, mesh.extrude_*, mesh.inset, mesh.bevel, uv.*, ...).
 * Thin wrappers around the pure functions in `../mesh/ops`: they read the edit mesh and the
 * local edit selection, convert world-space inputs into object space and commit the result as
 * one undo step. Ids and parameter names follow Blender's `bpy.ops` so scripts and AI agents can
 * use familiar names. Element indices refer to the current edit mesh (see mesh.select_elements).
 */

/** Result reported by every edit-mode operator. */
export interface MeshEditSummary {
  vertices: number;
  edges: number;
  faces: number;
  selected_verts: number;
  selected_edges: number;
  selected_faces: number;
}

function summary(mesh: MeshData, sel: MeshSelection): MeshEditSummary {
  const s = meshStats(mesh);
  return {
    vertices: s.vertices,
    edges: s.edges,
    faces: s.faces,
    selected_verts: sel.verts.size,
    selected_edges: sel.edges.size,
    selected_faces: sel.faces.size,
  };
}

const edgePair = z.tuple([z.number().int().min(0), z.number().int().min(0)]);
const WORLD = 'world space';

interface EditOpDef<S extends z.ZodType> {
  id: string;
  label: string;
  description: string;
  schema: S;
  category?: string;
  redoable?: boolean;
  poll?: (ctx: OperatorContext) => true | string;
  run(ctx: OperatorContext, t: EditTarget, p: z.infer<S>): MeshOpResult;
}

interface SelectOpDef<S extends z.ZodType> {
  id: string;
  label: string;
  description: string;
  schema: S;
  poll?: (ctx: OperatorContext) => true | string;
  run(ctx: OperatorContext, t: EditTarget, p: z.infer<S>): MeshSelection;
}

export function registerMeshEditOperators(reg: OperatorRegistry): void {
  /** Mesh-changing operator: one undo step, the result selection becomes the edit selection. */
  const edit = <S extends z.ZodType>(def: EditOpDef<S>) =>
    reg.register(
      defineOperator({
        id: def.id,
        label: def.label,
        description: def.description,
        category: def.category ?? 'Mesh',
        redoable: def.redoable ?? true,
        schema: def.schema,
        poll: def.poll ?? pollEditMesh,
        execute(ctx, p) {
          const t = editTarget(ctx);
          const r = def.run(ctx, t, p);
          commitEdit(ctx, t, r.mesh, r.selection);
          return summary(r.mesh, ctx.state.meshSelection);
        },
      }),
    );

  /** Selection-only operator: changes the local edit selection, not the document. */
  const select = <S extends z.ZodType>(def: SelectOpDef<S>) =>
    reg.register(
      defineOperator({
        id: def.id,
        label: def.label,
        description: def.description,
        category: 'Select',
        undo: false,
        schema: def.schema,
        poll: def.poll ?? pollEditMesh,
        execute(ctx, p) {
          const t = editTarget(ctx);
          ctx.state.meshSelection = flushSelection(t.mesh, def.run(ctx, t, p), ctx.state.selectMode);
          return summary(t.mesh, ctx.state.meshSelection);
        },
      }),
    );

  const toLocal = (t: EditTarget, v: readonly number[]): Vec3 =>
    worldDirToLocal(t.matrix, [v[0], v[1], v[2]]);

  // ================================================================== selection

  select({
    id: 'mesh.select_all',
    label: '(De)select All',
    description:
      'Change the selection of all mesh elements in Edit Mode: TOGGLE (deselect if anything is selected, else select all), SELECT, DESELECT or INVERT.',
    schema: z.object({ action: z.enum(['TOGGLE', 'SELECT', 'DESELECT', 'INVERT']).default('TOGGLE') }),
    run: (ctx, t, p) => selectAll(t.mesh, t.selection, p.action, ctx.state.selectMode),
  });

  reg.register(
    defineOperator({
      id: 'mesh.select_mode',
      label: 'Select Mode',
      description:
        'Switch the mesh select mode (VERT, EDGE or FACE) and convert the selection. With use_expand, switching to a higher mode selects every edge/face touching the selection instead of only fully selected ones.',
      category: 'Select',
      undo: false,
      schema: z.object({
        type: z.enum(['VERT', 'EDGE', 'FACE']).default('VERT'),
        use_expand: z.boolean().default(false),
      }),
      poll: pollEditMesh,
      execute(ctx, p) {
        const t = editTarget(ctx);
        ctx.state.meshSelection = changeSelectMode(
          t.mesh,
          t.selection,
          ctx.state.selectMode,
          p.type,
          p.use_expand,
        );
        ctx.state.selectMode = p.type;
        return { select_mode: p.type, ...summary(t.mesh, ctx.state.meshSelection) };
      },
    }),
  );

  select({
    id: 'mesh.select_elements',
    label: 'Select Elements',
    description:
      'Select mesh elements by index (essential for scripts/AI agents): verts are vertex indices, edges are [a, b] vertex index pairs of existing edges, faces are face indices. Vertices also select the edges/faces they fully cover. extend keeps the current selection; deselect removes the given elements instead. Invalid indices fail with an explanation.',
    schema: z.object({
      verts: z.array(z.number().int().min(0)).default([]),
      edges: z.array(edgePair).default([]),
      faces: z.array(z.number().int().min(0)).default([]),
      extend: z.boolean().default(false),
      deselect: z.boolean().default(false),
    }),
    run: (ctx, t, p) =>
      selectElements(
        t.mesh,
        t.selection,
        { verts: p.verts, edges: p.edges, faces: p.faces },
        { extend: p.extend, deselect: p.deselect, mode: ctx.state.selectMode },
      ),
  });

  select({
    id: 'mesh.select_linked',
    label: 'Select Linked All',
    description:
      'Select all geometry connected to the current selection. delimit stops the flood at SEAM, SHARP edges, MATERIAL changes, flipped NORMAL winding or UV discontinuities (empty list = plain connectivity).',
    schema: z.object({
      delimit: z.array(z.enum(['SEAM', 'SHARP', 'MATERIAL', 'NORMAL', 'UV'])).default(['SEAM']),
    }),
    run: (ctx, t, p) => selectLinked(t.mesh, t.selection, ctx.state.selectMode, p.delimit),
  });

  select({
    id: 'mesh.select_more',
    label: 'Select More',
    description:
      'Grow the selection by one step. use_face_step grows across faces (all vertices of touching faces) instead of along edges.',
    schema: z.object({ use_face_step: z.boolean().default(true) }),
    run: (ctx, t, p) => selectMore(t.mesh, t.selection, ctx.state.selectMode, p.use_face_step),
  });

  select({
    id: 'mesh.select_less',
    label: 'Select Less',
    description: 'Shrink the selection by one step (deselect elements on the border of the selected region).',
    schema: z.object({ use_face_step: z.boolean().default(true) }),
    run: (ctx, t, p) => selectLess(t.mesh, t.selection, ctx.state.selectMode, p.use_face_step),
  });

  const loopSchema = z.object({
    edge: edgePair.describe('Vertex index pair [a, b] of an existing edge the loop runs through'),
    extend: z.boolean().default(false),
    deselect: z.boolean().default(false),
    toggle: z.boolean().default(false),
    ring: z.boolean().default(false),
  });
  select({
    id: 'mesh.loop_select',
    label: 'Loop Select',
    description:
      'Select the edge loop through `edge` (Alt+click): continues straight through 4-valent vertices of quad topology, follows the mesh border for boundary edges. ring=true selects the edge ring (parallel edges across quads) instead. In face select mode the face loop crossed by the ring is selected.',
    schema: loopSchema,
    run: (ctx, t, p) =>
      loopSelect(t.mesh, t.selection, p.edge, {
        ring: p.ring,
        extend: p.extend,
        deselect: p.deselect,
        toggle: p.toggle,
        mode: ctx.state.selectMode,
      }),
  });

  select({
    id: 'mesh.edgering_select',
    label: 'Edge Ring Select',
    description:
      'Select the edge ring through `edge`: the parallel edges reached by crossing quads to their opposite edge (Ctrl+Alt+click).',
    schema: loopSchema.omit({ ring: true }),
    run: (ctx, t, p) =>
      loopSelect(t.mesh, t.selection, p.edge, {
        ring: true,
        extend: p.extend,
        deselect: p.deselect,
        toggle: p.toggle,
        mode: ctx.state.selectMode,
      }),
  });

  select({
    id: 'mesh.select_non_manifold',
    label: 'Select Non-Manifold',
    description:
      'Select non-manifold geometry: wire edges (no faces), boundary edges (one face), edges with more than two faces, edges between faces with opposite winding, and non-manifold vertices (bow-ties, isolated). Not available in face select mode.',
    schema: z.object({
      extend: z.boolean().default(true),
      use_wire: z.boolean().default(true),
      use_boundary: z.boolean().default(true),
      use_multi_face: z.boolean().default(true),
      use_non_contiguous: z.boolean().default(true),
      use_verts: z.boolean().default(true),
    }),
    poll: (ctx) => {
      const p = pollEditMesh(ctx);
      if (p !== true) return p;
      return ctx.state.selectMode === 'FACE' ? 'Does not work in face selection mode' : true;
    },
    run: (_ctx, t, p) =>
      selectNonManifold(
        t.mesh,
        t.selection,
        {
          wire: p.use_wire,
          boundary: p.use_boundary,
          multiFace: p.use_multi_face,
          nonContiguous: p.use_non_contiguous,
          verts: p.use_verts,
        },
        p.extend,
      ),
  });

  select({
    id: 'mesh.select_loose',
    label: 'Select Loose Geometry',
    description:
      'Select loose geometry: vertices without edges, wire edges without faces and faces that share no edge with another face.',
    schema: z.object({ extend: z.boolean().default(false) }),
    run: (_ctx, t, p) => selectLoose(t.mesh, t.selection, p.extend),
  });

  select({
    id: 'mesh.select_random',
    label: 'Select Random',
    description:
      'Randomly select (or deselect) elements of the current select mode. Deterministic for a given seed; ratio is the probability per element.',
    schema: z.object({
      ratio: z.number().min(0).max(1).default(0.5),
      seed: z.number().int().min(0).default(0),
      action: z.enum(['SELECT', 'DESELECT']).default('SELECT'),
    }),
    run: (ctx, t, p) =>
      selectRandom(t.mesh, t.selection, {
        ratio: p.ratio,
        seed: p.seed,
        action: p.action,
        mode: ctx.state.selectMode,
      }),
  });

  select({
    id: 'mesh.select_by_normal',
    label: 'Select by Normal',
    description: `Select faces whose normal points along \`direction\` (${WORLD}) within \`angle\` radians, e.g. direction [0,0,1] selects the top faces. extend keeps the current selection.`,
    schema: z.object({
      direction: vec3.default([0, 0, 1]).describe(`Direction in ${WORLD}`),
      angle: z
        .number()
        .min(0)
        .max(Math.PI)
        .default(Math.PI / 6)
        .describe('Maximum angle in radians'),
      extend: z.boolean().default(false),
    }),
    run: (ctx, t, p) =>
      selectByNormal(t.mesh, t.selection, {
        direction: p.direction as Vec3,
        angle: p.angle,
        extend: p.extend,
        mode: ctx.state.selectMode,
        matrix: t.matrix,
      }),
  });

  // ================================================================== extrude

  edit({
    id: 'mesh.extrude_region_move',
    label: 'Extrude Region and Move',
    description: `Extrude the selected region (E) and move it by \`value\` (${WORLD} offset). Faces are extruded as one region with side walls only on its outline (closed meshes stay closed); selected edges/vertices outside selected faces become faces/wire edges. The new geometry is selected.`,
    schema: z.object({ value: vec3.default([0, 0, 0]).describe(`Translation in ${WORLD}`) }),
    run: (_ctx, t, p) => extrudeRegion(t.mesh, t.selection, { offset: toLocal(t, p.value) }),
  });

  edit({
    id: 'mesh.extrude_region_shrink_fatten',
    label: 'Extrude Region and Shrink/Fatten',
    description:
      'Extrude the selected region and move it along its vertex normals by `value` (object local units; negative pushes inwards).',
    schema: z.object({ value: z.number().default(0), use_even_offset: z.boolean().default(false) }),
    run: (_ctx, t, p) =>
      extrudeRegion(t.mesh, t.selection, { normalOffset: p.value, evenOffset: p.use_even_offset }),
  });

  edit({
    id: 'mesh.extrude_faces_move',
    label: 'Extrude Individual Faces and Move',
    description:
      'Extrude every selected face separately and move each along its own normal by `value` (object local units).',
    schema: z.object({ value: z.number().default(0) }),
    run: (_ctx, t, p) => extrudeIndividualFaces(t.mesh, t.selection, p.value),
  });

  edit({
    id: 'mesh.extrude_edges_move',
    label: 'Extrude Edges and Move',
    description: `Extrude only the selected edges into new faces (ignoring faces) and move the new edges by \`value\` (${WORLD}).`,
    schema: z.object({ value: vec3.default([0, 0, 0]) }),
    run: (_ctx, t, p) => extrudeEdgesOnly(t.mesh, t.selection, { offset: toLocal(t, p.value) }),
  });

  edit({
    id: 'mesh.extrude_vertices_move',
    label: 'Extrude Vertices and Move',
    description: `Extrude the selected vertices into new wire edges and move the new vertices by \`value\` (${WORLD}).`,
    schema: z.object({ value: vec3.default([0, 0, 0]) }),
    run: (_ctx, t, p) => extrudeVerticesOnly(t.mesh, t.selection, { offset: toLocal(t, p.value) }),
  });

  // ================================================================== face tools

  edit({
    id: 'mesh.inset',
    label: 'Inset Faces',
    description:
      'Inset the selected faces (I): the outline of the selected region (or of each face with use_individual) is offset inwards by `thickness` and the inner faces are raised by `depth` (object local units). New faces fill the gap; the inner faces stay selected.',
    schema: z.object({
      thickness: z.number().min(0).default(0.1),
      depth: z.number().default(0),
      use_individual: z.boolean().default(false),
      use_even_offset: z.boolean().default(true),
    }),
    run: (_ctx, t, p) =>
      insetFaces(t.mesh, t.selection, {
        thickness: p.thickness,
        depth: p.depth,
        individual: p.use_individual,
        evenOffset: p.use_even_offset,
      }),
  });

  edit({
    id: 'mesh.loopcut',
    label: 'Loop Cut and Slide',
    description:
      'Insert `number_cuts` edge loops across the quad edge ring through `edge` ([a, b] vertex indices of an existing edge; Ctrl+R). factor (-1..1) slides a single cut towards vertex a (negative) or b (positive); smoothness rounds the new loops. The new loops are selected.',
    schema: z.object({
      edge: edgePair.describe('Vertex index pair of an edge in the ring to cut across'),
      number_cuts: z.number().int().min(1).max(100).default(1),
      smoothness: z.number().min(-4).max(4).default(0),
      factor: z.number().min(-1).max(1).default(0),
    }),
    run: (_ctx, t, p) =>
      loopCut(t.mesh, p.edge, { cuts: p.number_cuts, smoothness: p.smoothness, factor: p.factor }),
  });

  edit({
    id: 'mesh.subdivide',
    label: 'Subdivide',
    description:
      'Subdivide the selected edges with `number_cuts` cuts each. Fully selected quads become grids, triangles become triangle patterns, n-gons get a center vertex; neighbouring faces receive the new edge vertices (no cracks). smoothness (0..1) rounds the result following the vertex normals.',
    schema: z.object({
      number_cuts: z.number().int().min(1).max(100).default(1),
      smoothness: z.number().min(0).max(1).default(0),
    }),
    run: (_ctx, t, p) => subdivide(t.mesh, t.selection, { cuts: p.number_cuts, smoothness: p.smoothness }),
  });

  edit({
    id: 'mesh.poke',
    label: 'Poke Faces',
    description:
      'Split each selected face into a triangle fan around a new center vertex, optionally offset along the face normal.',
    schema: z.object({
      offset: z.number().default(0),
      use_relative_offset: z.boolean().default(false),
      center_mode: z.enum(['MEDIAN_WEIGHTED', 'MEDIAN', 'BOUNDS']).default('MEDIAN_WEIGHTED'),
    }),
    run: (_ctx, t, p) =>
      pokeFaces(t.mesh, t.selection, {
        offset: p.offset,
        relative: p.use_relative_offset,
        centerMode: p.center_mode,
      }),
  });

  edit({
    id: 'mesh.quads_convert_to_tris',
    label: 'Triangulate Faces',
    description:
      'Triangulate the selected faces (Ctrl+T). quad_method chooses the quad diagonal; n-gons are ear-clipped. UVs are kept.',
    schema: z.object({
      quad_method: z
        .enum(['BEAUTY', 'FIXED', 'FIXED_ALTERNATE', 'SHORTEST_DIAGONAL', 'LONGEST_DIAGONAL'])
        .default('BEAUTY'),
      ngon_method: z.enum(['BEAUTY', 'CLIP']).default('BEAUTY'),
    }),
    run: (_ctx, t, p) =>
      quadsToTris(t.mesh, t.selection, { quadMethod: p.quad_method, ngonMethod: p.ngon_method }),
  });

  const deg40 = (40 * Math.PI) / 180;
  edit({
    id: 'mesh.tris_convert_to_quads',
    label: 'Triangles to Quads',
    description:
      'Join pairs of adjacent selected triangles into quads (Alt+J). face_threshold: max angle (radians) between the triangle normals; shape_threshold: max deviation (radians) of the quad corners from 90°. uvs/seam/sharp/materials prevent joining across those boundaries.',
    schema: z.object({
      face_threshold: z.number().min(0).max(Math.PI).default(deg40),
      shape_threshold: z.number().min(0).max(Math.PI).default(deg40),
      uvs: z.boolean().default(false),
      vcols: z.boolean().default(false),
      seam: z.boolean().default(false),
      sharp: z.boolean().default(false),
      materials: z.boolean().default(false),
    }),
    run: (_ctx, t, p) =>
      trisToQuads(t.mesh, t.selection, {
        faceThreshold: p.face_threshold,
        shapeThreshold: p.shape_threshold,
        uvs: p.uvs,
        seam: p.seam,
        sharp: p.sharp,
        materials: p.materials,
      }),
  });

  // ================================================================== delete / dissolve / merge

  edit({
    id: 'mesh.delete',
    label: 'Delete',
    description:
      'Delete selected geometry (X): VERT (vertices and everything using them), EDGE (edges and their faces; orphaned vertices too), FACE (faces and edges/vertices no longer used), EDGE_FACE (edges and faces, keep vertices), ONLY_FACE (faces only, keep their edges).',
    schema: z.object({ type: z.enum(['VERT', 'EDGE', 'FACE', 'EDGE_FACE', 'ONLY_FACE']).default('VERT') }),
    run: (_ctx, t, p) => deleteGeometry(t.mesh, t.selection, p.type),
  });

  edit({
    id: 'mesh.dissolve_verts',
    label: 'Dissolve Vertices',
    description:
      'Remove the selected vertices while keeping the surface: the faces around each vertex are merged into one face (vertices with two edges are simply removed from the outline).',
    schema: z.object({}),
    redoable: false,
    run: (_ctx, t) => dissolveVerts(t.mesh, t.selection),
  });

  edit({
    id: 'mesh.dissolve_edges',
    label: 'Dissolve Edges',
    description:
      'Remove the selected edges by merging the two faces of each. use_verts also removes vertices left between two straight edges.',
    schema: z.object({ use_verts: z.boolean().default(true) }),
    run: (_ctx, t, p) => dissolveEdges(t.mesh, t.selection, { useVerts: p.use_verts }),
  });

  edit({
    id: 'mesh.dissolve_faces',
    label: 'Dissolve Faces',
    description:
      'Merge each connected group of selected faces into a single n-gon. use_verts also removes outline vertices left between two straight edges.',
    schema: z.object({ use_verts: z.boolean().default(false) }),
    run: (_ctx, t, p) => dissolveFaces(t.mesh, t.selection, { useVerts: p.use_verts }),
  });

  edit({
    id: 'mesh.merge',
    label: 'Merge Vertices',
    description:
      'Merge the selected vertices (M): CENTER (at their median), CURSOR (at the 3D cursor), COLLAPSE (each connected selected island at its median), FIRST / LAST (at the first / last selected vertex, in selection order). Degenerate faces are removed.',
    schema: z.object({ type: z.enum(['CENTER', 'CURSOR', 'COLLAPSE', 'FIRST', 'LAST']).default('CENTER') }),
    run: (ctx, t, p) =>
      mergeVertices(t.mesh, t.selection, p.type, worldToLocal(t.matrix, ctx.state.cursorLocation)),
  });

  edit({
    id: 'mesh.remove_doubles',
    label: 'Merge by Distance',
    description:
      'Merge selected vertices that are closer than `threshold` (object local units) to each other (Remove Doubles).',
    schema: z.object({ threshold: z.number().min(0).max(10).default(0.0001) }),
    run: (ctx, t, p) => {
      const r = removeDoubles(t.mesh, t.selection, p.threshold);
      ctx.report('INFO', `Removed ${r.removed} vertice(s)`);
      return r;
    },
  });

  // ================================================================== create geometry

  edit({
    id: 'mesh.edge_face_add',
    label: 'Make Edge/Face',
    description:
      'Create an edge (2 selected vertices) or a face (3+ vertices) from the selection (F). The vertex order follows selected edges when they form a loop (e.g. the outline of a hole) and otherwise goes around the best-fit plane; the face is wound consistently with its neighbours.',
    schema: z.object({}),
    redoable: false,
    run: (_ctx, t) => edgeFaceAdd(t.mesh, t.selection),
  });

  edit({
    id: 'mesh.fill',
    label: 'Fill',
    description:
      'Fill closed loops of selected boundary (or wire) edges with triangles (Alt+F), oriented consistently with the surrounding faces.',
    schema: z.object({ use_beauty: z.boolean().default(true) }),
    run: (_ctx, t) => fillHoles(t.mesh, t.selection),
  });

  edit({
    id: 'mesh.duplicate_move',
    label: 'Duplicate and Move',
    description: `Duplicate the selected geometry (Shift+D) and move the copy by \`value\` (${WORLD}). The copy becomes the selection.`,
    schema: z.object({ value: vec3.default([0, 0, 0]) }),
    run: (_ctx, t, p) => duplicateSelection(t.mesh, t.selection, toLocal(t, p.value)),
  });

  edit({
    id: 'mesh.split',
    label: 'Split',
    description:
      'Disconnect the selected faces from the rest of the mesh (Y) by duplicating the shared vertices.',
    schema: z.object({}),
    redoable: false,
    run: (_ctx, t) => splitSelection(t.mesh, t.selection),
  });

  reg.register(
    defineOperator({
      id: 'mesh.separate',
      label: 'Separate',
      description:
        'Move geometry into new objects (P): SELECTED (the selection), MATERIAL (one object per material index), LOOSE (one object per connected part). New objects copy the transform, parent, collection, material slots and modifiers and are added to the object selection.',
      category: 'Mesh',
      schema: z.object({ type: z.enum(['SELECTED', 'MATERIAL', 'LOOSE']).default('SELECTED') }),
      poll: pollEditMesh,
      execute(ctx, p) {
        const t = editTarget(ctx);
        const { mesh, parts } = separateMesh(t.mesh, t.selection, p.type);
        const meshName = ctx.doc.getMeshBlock(t.meshId)?.name ?? t.object.name;
        const objects: string[] = [];
        for (const part of parts) {
          const { id: _id, ...rest } = t.object;
          const data = ctx.doc.addMesh(meshName, part);
          objects.push(
            ctx.doc.addObject({
              ...rest,
              data,
              material_slots: [...t.object.material_slots],
              modifiers: t.object.modifiers.map((m) => ({ ...m, params: { ...m.params }, id: newId() })),
            }),
          );
        }
        commitEdit(ctx, t, mesh, emptySelection());
        ctx.state.selectedIds = [...new Set([...ctx.state.selectedIds, ...objects])];
        return {
          objects,
          names: objects.map((id) => ctx.doc.getObject(id)?.name),
          ...summary(mesh, ctx.state.meshSelection),
        };
      },
    }),
  );

  // ================================================================== normals / smoothing

  edit({
    id: 'mesh.flip_normals',
    label: 'Flip Normals',
    description: 'Reverse the winding (normal direction) of the selected faces.',
    schema: z.object({ only_clnors: z.boolean().default(false) }),
    redoable: false,
    run: (_ctx, t) => flipNormals(t.mesh, t.selection),
  });

  edit({
    id: 'mesh.normals_make_consistent',
    label: 'Recalculate Normals',
    description:
      'Make the winding of the selected faces consistent per connected part and point the normals outwards (Shift+N); inside=true points them inwards.',
    schema: z.object({ inside: z.boolean().default(false) }),
    run: (_ctx, t, p) => makeNormalsConsistent(t.mesh, t.selection, p.inside),
  });

  edit({
    id: 'mesh.vertices_smooth',
    label: 'Smooth Vertices',
    description:
      'Laplacian smoothing of the selected vertices: move each towards the average of its neighbours by `factor`, `repeat` times. Boundary vertices only follow the boundary.',
    schema: z.object({
      factor: z.number().min(-10).max(10).default(0.5),
      repeat: z.number().int().min(1).max(1000).default(1),
      xaxis: z.boolean().default(true),
      yaxis: z.boolean().default(true),
      zaxis: z.boolean().default(true),
    }),
    run: (_ctx, t, p) =>
      smoothVertices(t.mesh, t.selection, {
        factor: p.factor,
        repeat: p.repeat,
        xaxis: p.xaxis,
        yaxis: p.yaxis,
        zaxis: p.zaxis,
      }),
  });

  // ================================================================== edge data

  edit({
    id: 'mesh.mark_seam',
    label: 'Mark Seam',
    description:
      'Mark (or clear with clear=true) the selected edges as UV seams (used by uv.unwrap / uv.smart_project).',
    schema: z.object({ clear: z.boolean().default(false) }),
    run: (_ctx, t, p) => markSeam(t.mesh, t.selection, p.clear),
  });

  edit({
    id: 'mesh.mark_sharp',
    label: 'Mark Sharp',
    description:
      'Mark (or clear) the selected edges as sharp (splits smooth shading). use_verts affects every edge touching a selected vertex.',
    schema: z.object({ clear: z.boolean().default(false), use_verts: z.boolean().default(false) }),
    run: (_ctx, t, p) => markSharp(t.mesh, t.selection, { clear: p.clear, useVerts: p.use_verts }),
  });

  edit({
    id: 'transform.edge_crease',
    label: 'Edge Crease',
    description:
      'Set the subdivision-surface crease weight (0..1) of the selected edges; 0 removes the crease.',
    category: 'Transform',
    schema: z.object({ value: z.number().min(0).max(1).default(1) }),
    run: (_ctx, t, p) => setEdgeCrease(t.mesh, t.selection, p.value),
  });

  // ================================================================== advanced modeling

  edit({
    id: 'mesh.bevel',
    label: 'Bevel',
    description:
      'Bevel the selected edges (affect=EDGES, Ctrl+B) or vertices (affect=VERTICES, Ctrl+Shift+B). offset is in object local units, interpreted by offset_type (OFFSET: distance along the faces, WIDTH: width of the bevel face, DEPTH: depth from the original edge). segments > 1 with profile 0.5 gives round bevels (0.25 = flat chamfer, 1 = square). Only manifold edges are beveled; the new faces are selected.',
    schema: z.object({
      offset_type: z.enum(['OFFSET', 'WIDTH', 'DEPTH']).default('OFFSET'),
      offset: z.number().min(0).default(0.1),
      segments: z.number().int().min(1).max(100).default(1),
      profile: z.number().min(0).max(1).default(0.5),
      affect: z.enum(['EDGES', 'VERTICES']).default('EDGES'),
      clamp_overlap: z.boolean().default(false),
    }),
    run: (_ctx, t, p) =>
      bevel(t.mesh, t.selection, {
        offset: p.offset,
        offsetType: p.offset_type,
        segments: p.segments,
        profile: p.profile,
        affect: p.affect,
        clampOverlap: p.clamp_overlap,
      }),
  });

  edit({
    id: 'mesh.bridge_edge_loops',
    label: 'Bridge Edge Loops',
    description:
      'Connect two selected edge loops (closed or open; more loops are bridged in sequence) with a band of faces. With selected faces their outlines are bridged and the faces removed (e.g. two inset faces become a tunnel). number_cuts adds intermediate loops; twist_offset rotates the pairing. Loops with different vertex counts are joined with triangles.',
    schema: z.object({
      number_cuts: z.number().int().min(0).max(1000).default(0),
      twist_offset: z.number().int().min(-1000).max(1000).default(0),
    }),
    run: (_ctx, t, p) => bridgeEdgeLoops(t.mesh, t.selection, { cuts: p.number_cuts, twist: p.twist_offset }),
  });

  edit({
    id: 'mesh.spin',
    label: 'Spin',
    description: `Sweep the selected geometry around an axis like a lathe: \`steps\` steps over \`angle\` radians around \`axis\` through \`center\` (${WORLD}; center defaults to the 3D cursor). A full turn (2π) closes the result (use_auto_merge). dupli makes rotated copies instead. Edges become surfaces, faces become solids.`,
    schema: z.object({
      steps: z.number().int().min(1).max(1000).default(12),
      angle: z
        .number()
        .min(-1000)
        .max(1000)
        .default(Math.PI / 2),
      center: vec3.optional().describe(`Rotation center in ${WORLD} (default: 3D cursor)`),
      axis: vec3.default([0, 0, 1]).describe(`Rotation axis in ${WORLD}`),
      dupli: z.boolean().default(false),
      use_auto_merge: z.boolean().default(true),
      use_normal_flip: z.boolean().default(false),
    }),
    run: (ctx, t, p) =>
      spin(t.mesh, t.selection, {
        steps: p.steps,
        angle: p.angle,
        center: (p.center ?? ctx.state.cursorLocation) as Vec3,
        axis: p.axis as Vec3,
        dupli: p.dupli,
        autoMerge: p.use_auto_merge,
        flipNormals: p.use_normal_flip,
        matrix: t.matrix,
      }),
  });

  edit({
    id: 'mesh.symmetrize',
    label: 'Symmetrize',
    description:
      'Make the mesh symmetric across a local axis plane through the object origin: the selected faces (all if none) are cut at the plane and the source half is mirrored onto the other side (NEGATIVE_X copies -X onto +X, ...). Vertices within threshold of the plane are merged.',
    schema: z.object({
      direction: z
        .enum(['NEGATIVE_X', 'POSITIVE_X', 'NEGATIVE_Y', 'POSITIVE_Y', 'NEGATIVE_Z', 'POSITIVE_Z'])
        .default('NEGATIVE_X'),
      threshold: z.number().min(0).max(10).default(0.0001),
    }),
    run: (_ctx, t, p) => symmetrize(t.mesh, t.selection, p.direction, p.threshold),
  });

  edit({
    id: 'mesh.solidify',
    label: 'Solidify',
    description:
      'Give the selected faces thickness: a flipped copy offset by `thickness` (object local units) against the normals is joined to the original along the outline.',
    schema: z.object({ thickness: z.number().min(-1000).max(1000).default(0.01) }),
    run: (_ctx, t, p) => solidifyFaces(t.mesh, t.selection, p.thickness),
  });

  // ================================================================== UV mapping

  const uvBounds = {
    correct_aspect: z.boolean().default(true),
    clip_to_bounds: z.boolean().default(false),
    scale_to_bounds: z.boolean().default(false),
  };
  const UV_SCOPE =
    'Acts on the selected faces (all faces if none are selected) and creates the UV map if missing.';

  edit({
    id: 'uv.cube_project',
    label: 'Cube Projection',
    category: 'UV',
    description: `Project UVs from the six axis directions: each face uses the axis its normal is closest to, scaled by 1/cube_size. ${UV_SCOPE}`,
    schema: z.object({ cube_size: z.number().positive().default(1), ...uvBounds }),
    run: (_ctx, t, p) =>
      cubeProject(t.mesh, t.selection, {
        cubeSize: p.cube_size,
        clipToBounds: p.clip_to_bounds,
        scaleToBounds: p.scale_to_bounds,
      }),
  });

  edit({
    id: 'uv.cylinder_project',
    label: 'Cylinder Projection',
    category: 'UV',
    description: `Project UVs onto a cylinder around a local axis (default Z): u = angle around the axis, v = height / (2·radius). ${UV_SCOPE}`,
    schema: z.object({
      axis: z.enum(['X', 'Y', 'Z']).default('Z'),
      radius: z.number().positive().default(1),
      ...uvBounds,
    }),
    run: (_ctx, t, p) =>
      cylinderProject(t.mesh, t.selection, {
        axis: p.axis,
        radius: p.radius,
        clipToBounds: p.clip_to_bounds,
        scaleToBounds: p.scale_to_bounds,
      }),
  });

  edit({
    id: 'uv.sphere_project',
    label: 'Sphere Projection',
    category: 'UV',
    description: `Project UVs onto a sphere around a local axis (default Z): u = longitude, v = latitude. ${UV_SCOPE}`,
    schema: z.object({ axis: z.enum(['X', 'Y', 'Z']).default('Z'), ...uvBounds }),
    run: (_ctx, t, p) =>
      sphereProject(t.mesh, t.selection, {
        axis: p.axis,
        clipToBounds: p.clip_to_bounds,
        scaleToBounds: p.scale_to_bounds,
      }),
  });

  edit({
    id: 'uv.smart_project',
    label: 'Smart UV Project',
    category: 'UV',
    description: `Automatic unwrap: faces are grouped by normal direction (angle_limit in radians), every connected group (split at seams) is projected flat as an island, and the islands are packed into the 0..1 UV square (island_margin = gap as a fraction of the square). ${UV_SCOPE}`,
    schema: z.object({
      angle_limit: z
        .number()
        .min(0)
        .max(Math.PI / 2)
        .default((66 * Math.PI) / 180),
      island_margin: z.number().min(0).max(1).default(0),
      area_weight: z.number().min(0).max(1).default(0),
      correct_aspect: z.boolean().default(true),
      scale_to_bounds: z.boolean().default(false),
    }),
    run: (_ctx, t, p) =>
      smartProject(t.mesh, t.selection, { angleLimit: p.angle_limit, islandMargin: p.island_margin }),
  });

  edit({
    id: 'uv.unwrap',
    label: 'Unwrap',
    category: 'UV',
    description: `Unwrap UVs respecting seams (mark them with mesh.mark_seam). NOTE: angle-based/conformal flattening is not implemented yet; this uses the Smart UV Project chart algorithm (66° angle limit, islands split at seams) and packs islands into 0..1 with the given margin. ${UV_SCOPE}`,
    schema: z.object({
      method: z.enum(['ANGLE_BASED', 'CONFORMAL']).default('ANGLE_BASED'),
      fill_holes: z.boolean().default(true),
      correct_aspect: z.boolean().default(true),
      margin: z.number().min(0).max(1).default(0.001),
    }),
    run: (_ctx, t, p) => smartProject(t.mesh, t.selection, { islandMargin: p.margin }),
  });

  edit({
    id: 'uv.reset',
    label: 'Reset UVs',
    category: 'UV',
    description: `Reset UVs so every face covers the whole 0..1 square. ${UV_SCOPE}`,
    schema: z.object({}),
    redoable: false,
    run: (_ctx, t) => resetUVs(t.mesh, t.selection),
  });
}
