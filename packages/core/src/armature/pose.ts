import type { Mat4, Vec3 } from '../math/types';
import { compose4, invert4, multiply4 } from '../math/mat4';
import type { ArmatureData, BoneData, ConstraintData, PoseBone } from '../doc/types';
import type { ArmaturePose, PoseBoneMatrix, PoseContext } from './types';
import { blendMatrices, boneRestMatrix, invertRigid, isFiniteMatrix, originOf, tailOf } from './bone-math';
import {
  applyBoneConstraint,
  parseBoneConstraintParams,
  type BoneConstraintTarget,
  type IkParams,
} from './bone-constraints';
import { solveIk, type IkBone, type IkChain } from './ik';

/*
 * Pose evaluation. Every bone gets a rest matrix (from head/tail/roll) and a posed matrix
 *
 *   posed = parentPosed · parentRest⁻¹ · rest · basis(location, rotation_euler, scale)
 *
 * (roots: rest · basis). Connected bones keep their head on the parent's tail and ignore their
 * pose location. Bone constraints are applied in stack order after the bone's own transform; IK
 * chains are solved when the first bone of the chain is needed, on top of the chain's
 * constrained transforms, before any child outside the chain is evaluated. Evaluation is lazy and
 * dependency driven, so constraint targets inside the same armature are evaluated first;
 * dependency cycles fall back to the unconstrained pose and are reported in `errors`.
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

const PENDING = 0;
const BUSY = 1;
const DONE = 2;

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function matricesEqual(a: Readonly<Mat4>, b: Readonly<Mat4>, eps: number): boolean {
  for (let i = 0; i < 16; i++) if (!(Math.abs(a[i] - b[i]) <= eps)) return false;
  return true;
}

class PoseEvaluator {
  readonly errors: string[] = [];
  private readonly errorSet = new Set<string>();
  readonly nodes = new Map<string, Node>();
  readonly order: Node[] = [];
  private readonly state: number[];
  private readonly final: (Mat4 | null)[];
  private readonly plainM: (Mat4 | null)[];
  private readonly jobOf: (Job | null)[];
  private readonly armInv: Mat4;
  private readonly restPosition: boolean;

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
    this.plainM = new Array<Mat4 | null>(count).fill(null);
    this.jobOf = new Array<Job | null>(count).fill(null);
    if (!this.restPosition) this.buildJobs();
  }

  error(message: string): void {
    if (this.errorSet.has(message)) return;
    this.errorSet.add(message);
    this.errors.push(message);
  }

  private vec(v: unknown, fallback: Vec3, what: string): Vec3 {
    if (v === undefined || v === null) return [fallback[0], fallback[1], fallback[2]];
    if (
      Array.isArray(v) &&
      v.length >= 3 &&
      v.slice(0, 3).every((x) => typeof x === 'number' && Number.isFinite(x))
    )
      return [v[0], v[1], v[2]];
    this.error(`${what} is not a valid vector; using [${fallback.join(', ')}]`);
    return [fallback[0], fallback[1], fallback[2]];
  }

  private build(arm: ArmatureData, pose: Record<string, PoseBone>): void {
    const list: BoneData[] = [];
    const byName = new Map<string, BoneData>();
    for (const b of Array.isArray(arm.bones) ? arm.bones : []) {
      if (!b || typeof b.name !== 'string' || !b.name) {
        this.error('a bone without a name was ignored');
        continue;
      }
      if (byName.has(b.name)) {
        this.error(`duplicate bone name "${b.name}" ignored`);
        continue;
      }
      byName.set(b.name, b);
      list.push(b);
    }
    // parents: missing parents and cycles are dropped (the bone becomes a root)
    const parentOf = new Map<string, string | null>();
    for (const b of list) {
      let p = typeof b.parent === 'string' && b.parent ? b.parent : null;
      if (p === b.name || (p && !byName.has(p))) {
        this.error(`bone "${b.name}": parent "${p}" not found`);
        p = null;
      }
      parentOf.set(b.name, p);
    }
    for (const b of list) {
      const seen = new Set<string>();
      let cur = parentOf.get(b.name) ?? null;
      while (cur && !seen.has(cur)) {
        if (cur === b.name) {
          this.error(`bone "${b.name}": parent cycle broken`);
          parentOf.set(b.name, null);
          break;
        }
        seen.add(cur);
        cur = parentOf.get(cur) ?? null;
      }
    }
    // parents-first order (depth first, bones in their stored order)
    const children = new Map<string, BoneData[]>();
    const roots: BoneData[] = [];
    for (const b of list) {
      const p = parentOf.get(b.name);
      if (p) {
        const c = children.get(p);
        if (c) c.push(b);
        else children.set(p, [b]);
      } else roots.push(b);
    }
    const stack = [...roots].reverse().map((b) => ({ b, parent: null as Node | null }));
    while (stack.length) {
      const { b, parent } = stack.pop()!;
      const node = this.makeNode(b, parent, pose[b.name]);
      this.nodes.set(b.name, node);
      this.order.push(node);
      const kids = children.get(b.name) ?? [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ b: kids[i], parent: node });
    }
  }

  private makeNode(b: BoneData, parent: Node | null, pb: PoseBone | undefined): Node {
    const name = b.name;
    const connected = !!b.use_connect && !!parent;
    const head = connected ? ([...parent!.tail] as Vec3) : this.vec(b.head, [0, 0, 0], `bone "${name}" head`);
    const tail = this.vec(b.tail, [0, 0, 1], `bone "${name}" tail`);
    const fallbackDir: Vec3 = parent ? [parent.rest[4], parent.rest[5], parent.rest[6]] : [0, 1, 0];
    const { matrix: rest, length } = boneRestMatrix(head, tail, finiteOr(b.roll, 0), fallbackDir);
    if (!(length > 1e-9)) this.error(`bone "${name}" has zero length`);
    const offset = parent ? multiply4(invertRigid(parent.rest), rest) : rest;
    const loc = connected ? [0, 0, 0] : this.vec(pb?.location, [0, 0, 0], `pose bone "${name}" location`);
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
      head,
      tail,
      length,
      rest,
      offset,
      basis: compose4(loc as Vec3, rot, scl),
      constraints,
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
        if (!c.target && !c.subtarget) continue; // targetless IK: nothing to reach for
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
      ? node.rest
      : multiply4(node.parent ? multiply4(this.plain(node.parent), node.offset) : node.rest, node.basis);
    this.plainM[node.index] = m;
    return m;
  }

  /** Final (constrained) armature-space matrix of a bone. */
  get(node: Node): Mat4 {
    const st = this.state[node.index];
    if (st === DONE) return this.final[node.index]!;
    if (st === BUSY) {
      this.error(`dependency cycle involving bone "${node.name}"`);
      return this.plain(node);
    }
    if (this.restPosition) {
      this.state[node.index] = DONE;
      return (this.final[node.index] = node.rest);
    }
    const job = this.jobOf[node.index];
    if (job) {
      this.runJob(job);
      return this.final[node.index] ?? this.plain(node);
    }
    this.state[node.index] = BUSY;
    const parentM = node.parent ? this.get(node.parent) : null;
    const frame = parentM ? multiply4(parentM, node.offset) : node.rest;
    const m = this.constrain(node, multiply4(frame, node.basis), frame);
    this.final[node.index] = m;
    this.state[node.index] = DONE;
    return m;
  }

  /** Rest frame of a bone under its posed parent (LOCAL space basis). */
  private frameOf(node: Node): Mat4 {
    return node.parent ? multiply4(this.get(node.parent), node.offset) : node.rest;
  }

  /** True when a constraint target refers to a bone of this armature. */
  private isSelf(target: string | null, subtarget: string): boolean {
    if (!target) return !!subtarget;
    if (this.ctx.armatureId !== undefined) return target === this.ctx.armatureId;
    if (!subtarget || !this.nodes.has(subtarget)) return false;
    const w = this.ctx.getWorldMatrix(target);
    return !!w && matricesEqual(w, this.ctx.armatureMatrix, 1e-9);
  }

  /** Resolves a target (object, or bone with subtarget) in armature space. */
  resolveTarget(target: string | null, subtarget: string): BoneConstraintTarget | null {
    if (!target && !subtarget) return null;
    if (this.isSelf(target, subtarget)) {
      const node = this.nodes.get(subtarget);
      if (!node) return null;
      return { matrix: this.get(node), frame: this.frameOf(node), length: node.length };
    }
    const w = this.ctx.getWorldMatrix(target!);
    if (!w || !isFiniteMatrix(w)) return null;
    if (subtarget) {
      const bm = this.ctx.getBoneMatrix?.(target!, subtarget);
      if (bm) return { matrix: multiply4(this.armInv, bm.matrix), frame: null, length: bm.length };
      if (this.ctx.getBoneMatrix) return null;
      this.error(
        `bone "${subtarget}" of another armature is not available here: using that armature's origin`,
      );
    }
    return { matrix: multiply4(this.armInv, w), frame: null, length: 0 };
  }

  /** Applies the bone's non-IK constraints in order. */
  private constrain(node: Node, m: Mat4, frame: Mat4): Mat4 {
    for (const c of node.constraints) {
      if (c.type === 'IK') continue;
      try {
        const res = applyBoneConstraint(c, m, {
          frame,
          target: (cc) => this.resolveTarget(cc.target, cc.subtarget ?? ''),
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
      bones.push({ matrix: m, length: n.length, parent: pj ?? -1 });
    }
    // goals
    const chains: IkChain[] = [];
    for (const s of job.chains) {
      const label = `bone "${s.owner.name}" constraint "${s.constraint.name}"`;
      const t = this.resolveTarget(s.constraint.target, s.constraint.subtarget ?? '');
      if (!t) {
        this.error(`${label}: IK target not found`);
        continue;
      }
      let pole: Vec3 | null = null;
      if (s.params.pole_target || s.params.pole_subtarget) {
        const p = this.resolveTarget(s.params.pole_target, s.params.pole_subtarget);
        if (p) pole = originOf(p.matrix);
        else this.error(`${label}: pole target not found`);
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
    for (const n of this.order) this.get(n);
    const bones = new Map<string, PoseBoneMatrix>();
    for (const n of this.order) {
      const m = this.final[n.index] ?? this.plain(n);
      const b = n.bone;
      bones.set(n.name, {
        name: n.name,
        parent: n.parent?.name ?? null,
        rest: n.rest,
        matrix: m,
        length: n.length,
        head: originOf(m),
        tail: tailOf(m, n.length),
        restHead: n.head,
        restTail: n.tail,
        deform: b.use_deform !== false,
        envelope: {
          distance: Math.max(0, finiteOr(b.envelope_distance, 0.25)),
          weight: finiteOr(b.envelope_weight, 1),
          headRadius: Math.max(0, finiteOr(b.head_radius, 0.1)),
          tailRadius: Math.max(0, finiteOr(b.tail_radius, 0.05)),
        },
      });
    }
    return { bones, order: this.order.map((n) => n.name), errors: this.errors };
  }
}

/**
 * Computes rest and posed bone matrices of an armature (parents first). With
 * `arm.pose_position === 'REST'` pose transforms (and constraints) are ignored. Pose bone
 * transforms are relative to the rest pose in the bone's local space (Blender convention); bone
 * constraints (IK…) apply last. Never throws for bad data: problems are listed in `errors`.
 */
export function computePose(
  arm: ArmatureData,
  pose: Record<string, PoseBone>,
  ctx: PoseContext,
): ArmaturePose {
  return new PoseEvaluator(arm, pose, ctx).result();
}
