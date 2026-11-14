import type { Mat4, Vec3 } from '../math/types';
import { compose4, identity4, invert4, multiply4 } from '../math/mat4';
import type { ArmatureData, BoneData, ConstraintData, PoseBone } from '../doc/types';
import type { ArmaturePose, PoseBoneMatrix, PoseContext } from './types';
import { blendMatrices, boneRestMatrix, invertRigid, isFiniteMatrix, originOf, tailOf } from './bone-math';
import {
  applyBoneConstraint,
  parseBoneConstraintParams,
  type BoneConstraintTarget,
  type IkParams,
} from './bone-constraints';
import { ikSettingsOf, solveIk, type IkBone, type IkBoneSettings, type IkChain } from './ik';

/*
 * Pose evaluation. Every bone gets a rest matrix (from head/tail/roll) and a posed matrix
 *
 *   posed = parentPosed · parentRest⁻¹ · rest · basis(location, rotation_euler, scale)
 *
 * (roots: rest · basis). Connected bones keep their head on the parent's tail and ignore their
 * pose location. Bone constraints are applied in stack order after the bone's own transform; IK
 * chains are solved when the first bone of the chain is needed, on top of the chain's
 * constrained transforms, before any child outside the chain is evaluated.
 *
 * Evaluation is lazy and per bone (like Blender's per-bone dependency graph): a bone is computed
 * when it is first needed, after the bones and targets it depends on. Constraint targets inside
 * the same armature are therefore evaluated first, and an object parented to a bone that does not
 * depend on it can serve as a target of other bones of the same armature. A bone needed while it
 * is itself being evaluated closes a dependency cycle: it is reported in `errors` and its
 * unconstrained pose is used there; results computed from such a provisional matrix are computed
 * again once the cycle is left (at most once per bone, so evaluation stays linear).
 */

interface Node {
  /** Position in the parents-first order. */
  index: number;
  name: string;
  bone: BoneData;
  parent: Node | null;
  /** Effective rest head (the parent's tail for connected bones) and tail. */
  head: Vec3;
  tail: Vec3;
  length: number;
  rest: Mat4;
  /** parentRest⁻¹ · rest (rest for roots). */
  offset: Mat4;
  /** Local pose transform (bone space). */
  basis: Mat4;
  /** Active constraints (not muted, positive influence). */
  constraints: ConstraintData[];
  /** IK locks, limits and stiffness (null: none). */
  ik: IkBoneSettings | null;
}

interface ChainSpec {
  owner: Node;
  constraint: ConstraintData;
  params: IkParams;
  /** Chain bones, root first. */
  nodes: Node[];
}

interface Job {
  /** Bones of the job in parents-first order. */
  nodes: Node[];
  chains: ChainSpec[];
}

/** A bone evaluated on demand (`PoseEvaluation.bone`), in armature space. */
export interface EvaluatedBone {
  matrix: Mat4;
  length: number;
  /**
   * True when the bone is being evaluated, or depends on a bone that is (a dependency cycle):
   * `matrix` is then provisional (unconstrained where the cycle closes).
   */
  cyclic: boolean;
}

/**
 * Incremental evaluation of one armature pose. Bones are computed on demand and memoised, so a
 * caller (the scene's FrameState) can ask for single bones while other bones of the same pose are
 * still being evaluated, e.g. for an IK target object parented to another bone of the armature.
 */
export interface PoseEvaluation {
  /** Evaluates one bone and what it depends on (null for unknown bones). */
  bone(name: string): EvaluatedBone | null;
  /**
   * A bone as evaluated so far, evaluating nothing (null for unknown bones): its final matrix once
   * evaluated, else its pose without its own constraints under its parent as evaluated so far, which
   * a dependency cycle reads while the bone is being evaluated.
   */
  peek(name: string): { matrix: Mat4; length: number } | null;
  /** True while a bone of this pose is being evaluated (re-entrant calls see partial results). */
  readonly busy: boolean;
  /** Evaluates every bone (once) and returns the pose. */
  result(): ArmaturePose;
}

const PENDING = 0;
const BUSY = 1;
const DONE = 2;

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Own (not inherited) entry of a record keyed by bone name, e.g. a pose channel. */
function ownEntry<T>(rec: Readonly<Record<string, T>> | null | undefined, key: string): T | undefined {
  return rec !== null && typeof rec === 'object' && Object.hasOwn(rec, key) ? rec[key] : undefined;
}

/** `v` as a vector: its first three numbers when they are finite, else `fallback` (reported unless `v` is absent). */
function readVec(v: unknown, fallback: Vec3, what: string, error: (message: string) => void): Vec3 {
  if (v === undefined || v === null) return [fallback[0], fallback[1], fallback[2]];
  if (Array.isArray(v) && v.length >= 3) {
    const [x, y, z] = v as unknown[];
    if (
      typeof x === 'number' &&
      Number.isFinite(x) &&
      typeof y === 'number' &&
      Number.isFinite(y) &&
      typeof z === 'number' &&
      Number.isFinite(z)
    )
      return [x, y, z];
  }
  error(`${what} is not a valid vector; using [${fallback.join(', ')}]`);
  return [fallback[0], fallback[1], fallback[2]];
}

/** A bone's rest frame, from the armature alone (see {@link Skeleton}). */
interface RestBone {
  /** The bone's position in the armature's `bones`. */
  source: number;
  name: string;
  /** Its parent's position in the skeleton (parents first), −1 for a root. */
  parent: number;
  connected: boolean;
  /** Effective rest head (the parent's tail for connected bones) and tail. */
  head: Vec3;
  tail: Vec3;
  length: number;
  rest: Mat4;
  /** parentRest⁻¹ · rest (rest for roots). */
  offset: Mat4;
  /** Problems with the bone's own data, reported before those of its pose. */
  errors: string[];
}

/**
 * What a pose evaluation takes from the armature alone: its bones in parents-first order (depth
 * first, bones in their stored order) with their rest frames, and the problems found with them
 * (missing parents and parent cycles are dropped: the bone becomes a root). It is the same for
 * every pose of an armature whose bones are unchanged, so it is kept per armature object (see
 * {@link skeletonOf}); its arrays are shared by the evaluations that use it and never handed out.
 */
interface Skeleton {
  bones: RestBone[];
  /** Problems with the bones as a whole (names, parents), reported first. */
  errors: string[];
}

function buildSkeleton(arm: ArmatureData): Skeleton {
  const errors: string[] = [];
  const stored = Array.isArray(arm.bones) ? arm.bones : [];
  const list: { b: BoneData; source: number }[] = [];
  const byName = new Map<string, BoneData>();
  stored.forEach((b, source) => {
    if (!b || typeof b.name !== 'string' || !b.name) {
      errors.push('a bone without a name was ignored');
      return;
    }
    if (byName.has(b.name)) {
      errors.push(`duplicate bone name "${b.name}" ignored`);
      return;
    }
    byName.set(b.name, b);
    list.push({ b, source });
  });
  // parents: missing parents and cycles are dropped (the bone becomes a root)
  const parentOf = new Map<string, string | null>();
  for (const { b } of list) {
    let p = typeof b.parent === 'string' && b.parent ? b.parent : null;
    if (p === b.name || (p && !byName.has(p))) {
      errors.push(`bone "${b.name}": parent "${p}" not found`);
      p = null;
    }
    parentOf.set(b.name, p);
  }
  for (const { b } of list) {
    const seen = new Set<string>();
    let cur = parentOf.get(b.name) ?? null;
    while (cur && !seen.has(cur)) {
      if (cur === b.name) {
        errors.push(`bone "${b.name}": parent cycle broken`);
        parentOf.set(b.name, null);
        break;
      }
      seen.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
  }
  // parents-first order (depth first, bones in their stored order)
  const children = new Map<string, { b: BoneData; source: number }[]>();
  const roots: { b: BoneData; source: number }[] = [];
  for (const e of list) {
    const p = parentOf.get(e.b.name);
    if (p) {
      const c = children.get(p);
      if (c) c.push(e);
      else children.set(p, [e]);
    } else roots.push(e);
  }
  const bones: RestBone[] = [];
  const stack = [...roots].reverse().map((e) => ({ ...e, parent: -1 }));
  while (stack.length) {
    const { b, source, parent: pi } = stack.pop()!;
    const parent = pi >= 0 ? bones[pi] : null;
    const name = b.name;
    const errs: string[] = [];
    const report = (m: string) => errs.push(m);
    const connected = !!b.use_connect && !!parent;
    const head = connected
      ? ([...parent!.tail] as Vec3)
      : readVec(b.head, [0, 0, 0], `bone "${name}" head`, report);
    const tail = readVec(b.tail, [0, 0, 1], `bone "${name}" tail`, report);
    const fallbackDir: Vec3 = parent ? [parent.rest[4], parent.rest[5], parent.rest[6]] : [0, 1, 0];
    const { matrix: rest, length } = boneRestMatrix(head, tail, finiteOr(b.roll, 0), fallbackDir);
    if (!(length > 1e-9)) errs.push(`bone "${name}" has zero length`);
    const offset = parent ? multiply4(invertRigid(parent.rest), rest) : rest;
    const index = bones.length;
    bones.push({ source, name, parent: pi, connected, head, tail, length, rest, offset, errors: errs });
    const kids = children.get(name) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ ...kids[i], parent: index });
  }
  return { bones, errors };
}

/** The values of the bones of `arm` a skeleton is built from, in a fixed order (see forEachSkeletonInput). */
function skeletonInputs(arm: ArmatureData): unknown[] {
  const out: unknown[] = [];
  forEachSkeletonInput(arm, (v) => {
    out.push(v);
    return true;
  });
  return out;
}

/**
 * Calls `visit` with each value of the bones of `arm` a skeleton is built from (buildSkeleton reads
 * these and nothing else), in a fixed order, while it returns true; false when it stopped early.
 */
function forEachSkeletonInput(arm: ArmatureData, visit: (v: unknown) => boolean): boolean {
  const stored: unknown = arm.bones;
  if (!Array.isArray(stored)) return visit(stored === undefined ? undefined : null);
  if (!visit(stored.length)) return false;
  for (const b of stored as (BoneData | null | undefined)[]) {
    if (!b || typeof b !== 'object') {
      if (!visit(b)) return false;
      continue;
    }
    if (!visit(b.name) || !visit(b.parent) || !visit(b.use_connect) || !visit(b.roll)) return false;
    for (const v of [b.head, b.tail] as unknown[]) {
      if (!Array.isArray(v)) {
        if (!visit(v)) return false;
      } else if (!visit(v.length) || !visit(v[0]) || !visit(v[1]) || !visit(v[2])) return false;
    }
  }
  return true;
}

/** Skeletons by armature object, with the values they were built from (see {@link skeletonOf}). */
const skeletons = new WeakMap<ArmatureData, { inputs: unknown[]; skeleton: Skeleton }>();

/**
 * The skeleton of `arm`: built once per armature object and kept while its bones hold the values it
 * was built from (checked value by value at every evaluation, so a bone changed in place builds it
 * again), as the many poses of one armature a move computes share it.
 */
function skeletonOf(arm: ArmatureData): Skeleton {
  if (typeof arm !== 'object' || arm === null) return buildSkeleton(arm);
  const hit = skeletons.get(arm);
  if (hit) {
    let i = 0;
    const same = forEachSkeletonInput(arm, (v) => Object.is(v, hit.inputs[i++]));
    if (same && i === hit.inputs.length) return hit.skeleton;
  }
  const skeleton = buildSkeleton(arm);
  skeletons.set(arm, { inputs: skeletonInputs(arm), skeleton });
  return skeleton;
}

class PoseEvaluator implements PoseEvaluation {
  readonly errors: string[] = [];
  private readonly errorSet = new Set<string>();
  readonly nodes = new Map<string, Node>();
  readonly order: Node[] = [];
  private readonly state: number[];
  private readonly final: (Mat4 | null)[];
  private readonly provisional: (Mat4 | null)[];
  private readonly retried: Uint8Array;
  private readonly plainM: (Mat4 | null)[];
  private readonly jobOf: (Job | null)[];
  private readonly armInv: Mat4;
  private readonly restPosition: boolean;
  /** Nesting depth of bone evaluations in progress. */
  private depth = 0;
  /** Number of dependency cycles met so far (detects provisional results). */
  private cycles = 0;
  private cached: ArmaturePose | null = null;

  constructor(
    arm: ArmatureData,
    pose: Record<string, PoseBone>,
    private readonly ctx: PoseContext,
  ) {
    this.restPosition = arm.pose_position === 'REST';
    this.armInv = invert4(ctx.armatureMatrix);
    this.build(arm, pose ?? {});
    const count = this.order.length;
    this.state = new Array<number>(count).fill(PENDING);
    this.final = new Array<Mat4 | null>(count).fill(null);
    this.provisional = new Array<Mat4 | null>(count).fill(null);
    this.retried = new Uint8Array(count);
    this.plainM = new Array<Mat4 | null>(count).fill(null);
    this.jobOf = new Array<Job | null>(count).fill(null);
    if (!this.restPosition) this.buildJobs();
  }

  get busy(): boolean {
    return this.depth > 0;
  }

  error(message: string): void {
    if (this.errorSet.has(message)) return;
    this.errorSet.add(message);
    this.errors.push(message);
  }

  private vec(v: unknown, fallback: Vec3, what: string): Vec3 {
    return readVec(v, fallback, what, (m) => this.error(m));
  }

  private build(arm: ArmatureData, pose: Record<string, PoseBone>): void {
    const skeleton = skeletonOf(arm);
    for (const e of skeleton.errors) this.error(e);
    const stored = Array.isArray(arm.bones) ? arm.bones : [];
    for (const r of skeleton.bones) {
      for (const e of r.errors) this.error(e);
      const parent = r.parent >= 0 ? this.order[r.parent] : null;
      const node = this.makeNode(r, stored[r.source], parent, ownEntry(pose, r.name));
      this.nodes.set(r.name, node);
      this.order.push(node);
    }
  }

  private makeNode(r: RestBone, b: BoneData, parent: Node | null, pb: PoseBone | undefined): Node {
    const name = r.name;
    const loc = r.connected ? [0, 0, 0] : this.vec(pb?.location, [0, 0, 0], `pose bone "${name}" location`);
    const rot = this.vec(pb?.rotation_euler, [0, 0, 0], `pose bone "${name}" rotation_euler`);
    const scl = this.vec(pb?.scale, [1, 1, 1], `pose bone "${name}" scale`);
    const constraints: ConstraintData[] = [];
    if (Array.isArray(pb?.constraints)) {
      for (const c of pb!.constraints) {
        if (!c || typeof c.type !== 'string' || c.mute) continue;
        if (!(finiteOr(c.influence, 0) > 0)) continue;
        constraints.push(c);
      }
    }
    return {
      index: this.order.length,
      name,
      bone: b,
      parent,
      head: r.head,
      tail: r.tail,
      length: r.length,
      rest: r.rest,
      offset: r.offset,
      basis: compose4(loc as Vec3, rot, scl),
      constraints,
      ik: ikSettingsOf(pb, (m) => this.error(`pose bone "${name}": ${m}`)),
    };
  }

  /** Groups the IK chains into jobs (chains sharing bones are solved together). */
  private buildJobs(): void {
    const specs: ChainSpec[] = [];
    for (const node of this.order) {
      for (const c of node.constraints) {
        if (c.type !== 'IK') continue;
        let params: IkParams;
        try {
          params = parseBoneConstraintParams('IK', c.params);
        } catch (e) {
          this.error(`bone "${node.name}" constraint "${c.name}": ${(e as Error).message}`);
          continue;
        }
        if (!c.target) continue; // targetless IK: nothing to reach for
        const tip = params.use_tail ? node : node.parent;
        if (!tip) {
          this.error(
            `bone "${node.name}" constraint "${c.name}": use_tail is off but the bone has no parent`,
          );
          continue;
        }
        const chain: Node[] = [];
        for (let n: Node | null = tip; n; n = n.parent) {
          chain.push(n);
          if (params.chain_count > 0 && chain.length >= params.chain_count) break;
        }
        specs.push({ owner: node, constraint: c, params, nodes: chain.reverse() });
      }
    }
    if (!specs.length) return;
    // union-find over chains sharing bones
    const owner = new Map<number, number>();
    const parent = specs.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    specs.forEach((s, i) => {
      for (const n of s.nodes) {
        const o = owner.get(n.index);
        if (o === undefined) owner.set(n.index, i);
        else parent[find(i)] = find(o);
      }
    });
    const jobs = new Map<number, Job>();
    specs.forEach((s, i) => {
      const r = find(i);
      let job = jobs.get(r);
      if (!job) jobs.set(r, (job = { nodes: [], chains: [] }));
      job.chains.push(s);
      for (const n of s.nodes) if (!job.nodes.includes(n)) job.nodes.push(n);
    });
    for (const job of jobs.values()) {
      job.nodes.sort((a, b) => a.index - b.index);
      for (const n of job.nodes) this.jobOf[n.index] = job;
    }
  }

  /** Unconstrained pose (fallback for dependency cycles). */
  private plain(node: Node): Mat4 {
    const cached = this.plainM[node.index];
    if (cached) return cached;
    const m = this.restPosition
      ? node.rest.slice()
      : multiply4(node.parent ? multiply4(this.plain(node.parent), node.offset) : node.rest, node.basis);
    this.plainM[node.index] = m;
    return m;
  }

  /** Final (constrained) armature-space matrix of a bone. */
  get(node: Node): Mat4 {
    const st = this.state[node.index];
    if (st === DONE) return this.final[node.index]!;
    if (st === BUSY) {
      this.cycles++;
      this.error(`dependency cycle involving bone "${node.name}"`);
      return this.plain(node);
    }
    if (this.restPosition) {
      this.state[node.index] = DONE;
      return (this.final[node.index] = node.rest.slice());
    }
    this.depth++;
    try {
      const job = this.jobOf[node.index];
      if (job) {
        this.runJob(job);
        return this.final[node.index] ?? this.plain(node);
      }
      const cycles = this.cycles;
      this.state[node.index] = BUSY;
      const parentM = node.parent ? this.get(node.parent) : null;
      const frame = parentM ? multiply4(parentM, node.offset) : node.rest;
      const m = this.constrain(node, multiply4(frame, node.basis), frame);
      if (this.cycles !== cycles && !this.retried[node.index]) {
        // computed from a provisional matrix: compute it again once the cycle is left
        this.retried[node.index] = 1;
        this.provisional[node.index] = m;
        this.state[node.index] = PENDING;
      } else {
        this.final[node.index] = m;
        this.state[node.index] = DONE;
      }
      return m;
    } finally {
      this.depth--;
    }
  }

  bone(name: string): EvaluatedBone | null {
    const node = this.nodes.get(name);
    if (!node) return null;
    const cycles = this.cycles;
    const matrix = this.get(node);
    return { matrix, length: node.length, cyclic: this.cycles !== cycles };
  }

  peek(name: string): { matrix: Mat4; length: number } | null {
    const node = this.nodes.get(name);
    return node ? { matrix: this.peekMatrix(node), length: node.length } : null;
  }

  /**
   * A bone as evaluated so far (see peek): its final matrix once evaluated, else its pose under its
   * parent as evaluated so far, its own constraints left out (a constrained parent that is evaluated
   * counts with its constraints).
   */
  private peekMatrix(node: Node): Mat4 {
    if (this.state[node.index] === DONE) return this.final[node.index]!;
    if (this.restPosition) return node.rest.slice();
    const frame = node.parent ? multiply4(this.peekMatrix(node.parent), node.offset) : node.rest;
    return multiply4(frame, node.basis);
  }

  /** Rest frame of a bone under its posed parent (LOCAL space basis). */
  private frameOf(node: Node): Mat4 {
    return node.parent ? multiply4(this.get(node.parent), node.offset) : node.rest;
  }

  /**
   * Resolves a constraint target in armature space: a bone of this armature (`target` is this
   * armature object, `ctx.armatureId`, and `subtarget` names the bone), a bone of another
   * armature object (`subtarget`, read with `ctx.getBoneMatrix`) or an object. Throws an error
   * saying why when it is not available. An object whose evaluation reads this pose (a dependency
   * cycle: an IK target parented to a bone of its own chain) is used with the matrix it has so far
   * (`ctx.getCycleTarget`), as Blender evaluates a cycle, and `cycle` reports the cycle (`closing`:
   * the relation by which the pose reads the target, "IK of bone 'Shin'").
   */
  resolveTarget(
    target: string | null | undefined,
    subtarget: string,
    closing = '',
    cycle: (message: string) => void = () => undefined,
  ): BoneConstraintTarget {
    if (!target) throw new Error('no target set');
    if (this.ctx.armatureId !== undefined && target === this.ctx.armatureId) {
      if (!subtarget) return { matrix: identity4(), frame: null, length: 0 };
      const node = this.nodes.get(subtarget);
      if (!node) throw new Error(`target bone "${subtarget}" not found`);
      return { matrix: this.get(node), frame: this.frameOf(node), length: node.length };
    }
    let w = this.ctx.getWorldMatrix(target);
    if (!w) {
      // Blender marks one relation of a cycle cyclic and evaluates with what the target has then
      const inCycle = this.ctx.getCycleTarget?.(target, closing);
      if (!inCycle) throw new Error('target not found');
      if (!inCycle.matrix || subtarget) throw new Error(inCycle.message);
      cycle(inCycle.message);
      w = inCycle.matrix;
    }
    if (!isFiniteMatrix(w)) throw new Error('target has an invalid transform');
    if (subtarget) {
      if (!this.ctx.getBoneMatrix)
        throw new Error(`target bone "${subtarget}" of another armature cannot be resolved here`);
      const bm = this.ctx.getBoneMatrix(target, subtarget);
      if (!bm) throw new Error(`target bone "${subtarget}" not found`);
      return { matrix: multiply4(this.armInv, bm.matrix), frame: null, length: bm.length };
    }
    return { matrix: multiply4(this.armInv, w), frame: null, length: 0 };
  }

  /** Applies the bone's non-IK constraints in order. */
  private constrain(node: Node, m: Mat4, frame: Mat4): Mat4 {
    for (const c of node.constraints) {
      if (c.type === 'IK') continue;
      try {
        const label = `bone "${node.name}" constraint "${c.name}"`;
        const res = applyBoneConstraint(c, m, {
          frame,
          armatureMatrix: this.ctx.armatureMatrix,
          target: (cc) =>
            this.resolveTarget(cc.target, cc.subtarget ?? '', `${c.name} of bone '${node.name}'`, (e) =>
              this.error(`${label}: ${e}`),
            ),
        });
        const influence = Math.min(1, finiteOr(c.influence, 0));
        const next = influence >= 1 ? res : blendMatrices(m, res, influence);
        if (!isFiniteMatrix(next)) throw new Error('produced an invalid transform');
        m = next;
      } catch (e) {
        this.error(`bone "${node.name}" constraint "${c.name}": ${(e as Error).message}`);
      }
    }
    return m;
  }

  private runJob(job: Job): void {
    for (const n of job.nodes) this.state[n.index] = BUSY;
    const local = new Map<Node, number>(job.nodes.map((n, i) => [n, i]));
    // forward kinematics (+ regular constraints) of the job bones
    const fk: Mat4[] = [];
    const bones: IkBone[] = [];
    for (const n of job.nodes) {
      const pj = n.parent ? local.get(n.parent) : undefined;
      const parentM = pj !== undefined ? fk[pj] : n.parent ? this.get(n.parent) : null;
      const frame = parentM ? multiply4(parentM, n.offset) : n.rest;
      const m = this.constrain(n, multiply4(frame, n.basis), frame);
      fk.push(m);
      // IK limits are measured from the rest frame (relative to the parent when it is solved too)
      bones.push({
        matrix: m,
        length: n.length,
        parent: pj ?? -1,
        restFrame: pj !== undefined ? n.offset : frame,
        ik: n.ik,
      });
    }
    // goals
    const chains: IkChain[] = [];
    for (const s of job.chains) {
      const label = `bone "${s.owner.name}" constraint "${s.constraint.name}"`;
      const closing = `${s.constraint.name} of bone '${s.owner.name}'`;
      let t: BoneConstraintTarget;
      try {
        t = this.resolveTarget(s.constraint.target, s.constraint.subtarget ?? '', closing, (e) =>
          this.error(`${label}: IK ${e}`),
        );
      } catch (e) {
        this.error(`${label}: IK ${(e as Error).message}`);
        continue;
      }
      let pole: Vec3 | null = null;
      // a pole bone without a pole object is ignored (as in Blender)
      if (s.params.pole_target) {
        try {
          pole = originOf(
            this.resolveTarget(s.params.pole_target, s.params.pole_subtarget, closing, (e) =>
              this.error(`${label}: pole ${e}`),
            ).matrix,
          );
        } catch (e) {
          this.error(`${label}: pole ${(e as Error).message}`);
        }
      }
      chains.push({
        bones: s.nodes.map((n) => local.get(n)!),
        target: originOf(t.matrix),
        pole,
        poleAngle: s.params.pole_angle,
        iterations: s.params.iterations,
        useStretch: s.params.use_stretch,
        influence: Math.min(1, finiteOr(s.constraint.influence, 0)),
      });
    }
    try {
      const res = solveIk(bones, chains);
      for (const w of res.warnings) this.error(`IK: ${w}`);
    } catch (e) {
      this.error(`IK solver failed: ${(e as Error).message}`);
    }
    job.nodes.forEach((n, i) => {
      const m = bones[i].matrix;
      this.final[n.index] = isFiniteMatrix(m) ? m : fk[i];
      this.state[n.index] = DONE;
    });
  }

  result(): ArmaturePose {
    if (this.cached) return this.cached;
    for (const n of this.order) this.get(n);
    // bones left provisional by a dependency cycle get their second (final) evaluation
    for (const n of this.order) if (this.state[n.index] !== DONE) this.get(n);
    const bones = new Map<string, PoseBoneMatrix>();
    for (const n of this.order) {
      const m = this.final[n.index] ?? this.provisional[n.index] ?? this.plain(n);
      const b = n.bone;
      bones.set(n.name, {
        name: n.name,
        parent: n.parent?.name ?? null,
        rest: n.rest.slice(),
        matrix: m,
        length: n.length,
        head: originOf(m),
        tail: tailOf(m, n.length),
        restHead: [n.head[0], n.head[1], n.head[2]],
        restTail: [n.tail[0], n.tail[1], n.tail[2]],
        deform: b.use_deform !== false,
        envelope: {
          distance: Math.max(0, finiteOr(b.envelope_distance, 0.25)),
          weight: finiteOr(b.envelope_weight, 1),
          headRadius: Math.max(0, finiteOr(b.head_radius, 0.1)),
          tailRadius: Math.max(0, finiteOr(b.tail_radius, 0.05)),
        },
      });
    }
    this.cached = { bones, order: this.order.map((n) => n.name), errors: this.errors };
    return this.cached;
  }
}

/**
 * Starts an incremental evaluation of an armature pose: bones are computed when first asked for
 * (`bone`), or all at once (`result`). See `computePose` for the conventions; never throws for
 * bad data.
 */
export function createPoseEvaluation(
  arm: ArmatureData,
  pose: Record<string, PoseBone>,
  ctx: PoseContext,
): PoseEvaluation {
  return new PoseEvaluator(arm, pose, ctx);
}

/**
 * Computes rest and posed bone matrices of an armature (parents first). With
 * `arm.pose_position === 'REST'` pose transforms (and constraints) are ignored. Pose bone
 * transforms are relative to the rest pose in the bone's local space (Blender convention); bone
 * constraints (IK…) apply last. Constraint targets that are this armature object (with a
 * `subtarget` bone) need `ctx.armatureId`; bones of other armatures need `ctx.getBoneMatrix`.
 * Never throws for bad data: problems are listed in `errors`.
 */
export function computePose(
  arm: ArmatureData,
  pose: Record<string, PoseBone>,
  ctx: PoseContext,
): ArmaturePose {
  return new PoseEvaluator(arm, pose, ctx).result();
}
