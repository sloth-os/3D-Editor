import { z } from 'zod';
import { invert4 } from '../math/mat4';
import { vertexCount } from '../mesh/types';
import { decodeFloat32 } from '../mesh/shape-keys';
import {
  boneEnvelopeWeight,
  deformBones,
  denseToSkinWeights,
  meshToArmatureSpace,
  skinPositions,
} from '../armature/skinning';
import type { ModifierDef } from './registry';
import { transformPositions, withPositions, zObjectRef } from './util';

const schema = z.object({
  object: zObjectRef('Armature object whose pose deforms the mesh'),
  use_vertex_groups: z
    .boolean()
    .default(true)
    .describe('Deform with the vertex groups named like the deform bones (weights normalised per vertex)'),
  use_bone_envelopes: z
    .boolean()
    .default(false)
    .describe("Deform with the bones' envelopes; used for vertices that have no bone vertex-group weight"),
  use_deform_preserve_volume: z
    .boolean()
    .default(false)
    .describe('Dual quaternion skinning: keeps volume at bent joints (no "candy wrapper" collapse)'),
  vertex_group: z
    .string()
    .default('')
    .describe('Optional vertex group scaling the whole deformation per vertex (empty = none)'),
  invert_vertex_group: z.boolean().default(false).describe('Invert the influence of `vertex_group`'),
});

export const armatureModifier: ModifierDef<typeof schema> = {
  type: 'ARMATURE',
  label: 'Armature',
  category: 'DEFORM',
  description:
    'Deforms the mesh with the pose of an armature object (skinning). Each vertex follows the deform bones whose ' +
    'names match its vertex groups, weighted by the (normalised) group weights; with `use_bone_envelopes`, vertices ' +
    'without bone weights use the bone envelopes instead. Vertices without any weight stay in place. Place it before ' +
    'modifiers that change the topology (e.g. Subdivision), since vertex groups only match the original vertices.',
  schema,
  dependencies: (p) => (p.object ? [p.object] : []),
  apply(mesh, p, ctx) {
    if (!p.object) return mesh;
    const n = vertexCount(mesh);
    if (n === 0) return mesh;
    if (!ctx.getArmature) throw new Error('armature deformation is not available in this context');
    const arm = ctx.getArmature(p.object);
    if (!arm) throw new Error('armature object not found (or it is not an armature)');
    const bones = deformBones(arm.pose);
    if (!bones.length || (!p.use_vertex_groups && !p.use_bone_envelopes)) return mesh;
    // every deform bone at rest: nothing moves (exact result, no work)
    const atRest = bones.every((b) =>
      b.matrix.every((x, i) => Math.abs(x - b.rest[i]) <= 1e-12 * (1 + Math.abs(x))),
    );
    if (atRest) return mesh;

    const toArm = meshToArmatureSpace(ctx.objectMatrix, arm.matrix);
    const pos = transformPositions(mesh.positions, toArm);
    const groups = new Map((ctx.vertexGroups ?? []).map((g) => [g.name, g]));

    const perBone: (Float32Array | null)[] = bones.map(() => null);
    let mismatch = false;
    if (p.use_vertex_groups) {
      bones.forEach((b, i) => {
        const g = groups.get(b.name);
        if (!g) return;
        const w = decodeFloat32(g.weights);
        if (w.length === n) perBone[i] = w;
        else mismatch = true;
      });
      if (mismatch && !p.use_bone_envelopes)
        throw new Error(
          `vertex groups do not match the mesh (${n} vertices): move the Armature modifier above modifiers ` +
            'that change the topology, or reassign the weights',
        );
      if (mismatch) perBone.fill(null);
    }
    if (p.use_bone_envelopes) {
      // envelopes only for vertices without any bone-group weight (Blender behaviour)
      const hasGroupWeight = new Uint8Array(n);
      for (const w of perBone) if (w) for (let v = 0; v < n; v++) if (w[v] > 0) hasGroupWeight[v] = 1;
      bones.forEach((b, i) => {
        let env: Float32Array | null = null;
        for (let v = 0; v < n; v++) {
          if (hasGroupWeight[v]) continue;
          const w = boneEnvelopeWeight(b, [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
          if (!(w > 0)) continue;
          if (!env) env = perBone[i] ? Float32Array.from(perBone[i]!) : new Float32Array(n);
          env[v] = w;
        }
        if (env) perBone[i] = env;
      });
    }
    const weights = denseToSkinWeights(perBone, n);
    if (weights.bones.length === 0) return mesh;

    let mask: Float32Array | null = null;
    const mg = p.vertex_group ? groups.get(p.vertex_group) : undefined;
    if (mg) {
      const w = decodeFloat32(mg.weights);
      if (w.length !== n)
        throw new Error(`vertex group "${p.vertex_group}" does not match the mesh (${n} vertices)`);
      mask = p.invert_vertex_group ? w.map((x) => 1 - x) : w;
    }
    const skinned = skinPositions(pos, weights, bones, {
      preserveVolume: p.use_deform_preserve_volume,
      mask,
    });
    return withPositions(mesh, transformPositions(skinned, invert4(toArm)));
  },
};
