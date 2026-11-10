import type { Mat4 } from '../math/types';
import { compose4, identity4, multiply4, translation4 } from '../math/mat4';
import type { AnimTargetType, CurveData, DriverData, FCurve, ObjectData } from '../doc/types';
import { fcurveKey, type SceneDoc } from '../doc/scene-doc';
import { evaluateFCurve } from '../anim/fcurve';
import { readChannel, writeChannel } from '../anim/properties';
import { evaluateDriver } from '../anim/drivers';
import { createPoseEvaluation, type PoseEvaluation } from '../armature/pose';
import type { ArmaturePose } from '../armature/types';
import { solveConstraints } from '../constraints/solve';
import { constraintContextFor, constraintObjectInfo } from '../constraints/context';
import { dependencyGraph, inParentLoop } from '../constraints/depgraph';
import type { ConstraintContext, ConstraintError } from '../constraints/types';
import { buildCurvePath, type CurvePath } from '../curve/path';

export interface EvalError {
  /** What failed, e.g. `driver:object:<id>:location:0`, `pose:<objectId>`. */
  source: string;
  message: string;
}

type CurveIndex = Map<string, FCurve[]>; // `${type}:${id}` → curves

/** An object's location, rotation and scale. */
type Channels = Pick<ObjectData, 'location' | 'rotation_euler' | 'scale'>;

/** What a frame state reads from the document, once (see FrameStateOptions.base). */
interface FrameInput {
  raw: ObjectData[];
  rawById: Map<string, ObjectData>;
  curves: CurveIndex;
  drivers: Map<string, DriverData[]>;
}

/** Options of a {@link FrameState}. */
export interface FrameStateOptions {
  /**
   * A frame state of the same document whose reading of the document this one shares (the
   * document must not have changed since): building it then reads nothing from the document.
   */
  base?: FrameState;
  /**
   * Objects whose location, rotation and scale are replaced at this frame: they show these values,
   * whatever their stored values and keys give (their drivers still apply on top). What the scene
   * evaluates once these channels are stored and keyed at the frame, as while a transform is
   * previewed.
   */
  channels?: ReadonlyMap<string, Channels>;
  /**
   * With `base` (at the same frame, with the same simulated matrices): the only objects this frame
   * state evaluates anew. It must hold every object whose evaluation `channels` can change: the
   * objects in `channels` and every object reading one of them, directly or through others
   * (parenting, constraints, drivers, armature poses). Everything else (the other objects' values,
   * matrices and poses, datablocks without drivers, the dependency cycles found) is read from
   * `base`, so replacing the channels of a few objects costs what evaluating those objects costs,
   * not what the scene does. These objects are evaluated as they are asked for: ask for them
   * dependencies first, so long chains do not recurse deeply. Without it (or without `base`) every
   * object is evaluated anew.
   */
  affected?: ReadonlySet<string>;
  /**
   * With `affected`: the datablocks other than objects (`<type>:<id>`, e.g. `curve:<id>`) this
   * frame state evaluates anew, those whose drivers read what `channels` changes, directly or
   * through others; the others are read from `base`. Without it every datablock with a driver is
   * evaluated anew.
   */
  affectedData?: ReadonlySet<string>;
  /**
   * Objects whose simulated matrices (the `simulated` of the constructor) this frame state leaves
   * out: they are evaluated from their channels, as Blender evaluates a rigid body while a
   * transform moves it (BKE_rigidbody_sync_transforms leaves the simulation out for the selected
   * objects while G.moving is set). With `affected` they must be among it.
   */
  unsimulated?: ReadonlySet<string>;
}

/** A frame state that evaluates only some objects anew (FrameStateOptions.affected). */
interface Overlay {
  base: FrameState;
  affected: ReadonlySet<string>;
}

function indexByTarget<T extends { target_type: string; target_id: string; mute: boolean }>(
  items: T[],
  skip: (t: T) => boolean,
): Map<string, T[]> {
  const idx = new Map<string, T[]>();
  for (const it of items) {
    if (it.mute || skip(it)) continue;
    const k = `${it.target_type}:${it.target_id}`;
    const list = idx.get(k);
    if (list) list.push(it);
    else idx.set(k, [it]);
  }
  return idx;
}

type Block = Record<string, unknown>;

/**
 * Lazily animated datablocks of one frame: F-curves first, then drivers. A driver reading a
 * datablock that is still being resolved (e.g. its own object) sees the F-curve values.
 */
class AnimatedStore {
  private readonly animated = new Map<string, Block | null>();
  private readonly final = new Map<string, Block | null>();
  private readonly resolving = new Set<string>();

  constructor(
    private readonly doc: SceneDoc,
    private readonly frame: number,
    private readonly objects: Map<string, ObjectData>,
    private readonly curves: CurveIndex,
    private readonly drivers: Map<string, DriverData[]>,
    private readonly errors: EvalError[],
    /** Objects' channels replacing what their F-curves and stored values give (before drivers). */
    private readonly channels: ReadonlyMap<string, Channels> | null = null,
    /**
     * The store of the base frame state of an overlay (see FrameStateOptions.affected): objects not
     * evaluated anew, and the other datablocks not in `data` (without it: those without drivers),
     * are read from it.
     */
    private readonly fallback: {
      store: AnimatedStore;
      affected: ReadonlySet<string>;
      data: ReadonlySet<string> | null;
    } | null = null,
  ) {}

  private raw(type: AnimTargetType, id: string): Block | null {
    const d = this.doc;
    switch (type) {
      case 'object':
        return (this.objects.get(id) as unknown as Block) ?? null;
      case 'material':
        return d.getMaterial(id) as unknown as Block | null;
      case 'light':
        return d.getLight(id) as unknown as Block | null;
      case 'camera':
        return d.getCamera(id) as unknown as Block | null;
      case 'world':
        return d.getWorld() as unknown as Block;
      case 'scene':
        return d.getScene() as unknown as Block;
      case 'mesh':
        return d.getMeshBlock(id) ? { shape_keys: d.getShapeKeys(id) } : null;
      case 'curve':
        return d.getCurve(id) as unknown as Block | null;
    }
  }

  private animatedOnly(type: AnimTargetType, id: string): Block | null {
    const k = `${type}:${id}`;
    if (this.animated.has(k)) return this.animated.get(k)!;
    const raw = this.raw(type, id);
    let out = raw;
    const curves = this.curves.get(k);
    if (raw && curves) {
      out = { ...raw };
      for (const fc of curves) {
        const v = evaluateFCurve(fc, this.frame);
        if (v !== undefined) writeChannel(out, fc.path, fc.index, v);
      }
    }
    const c = raw && type === 'object' ? this.channels?.get(id) : undefined;
    if (out && c) out = { ...out, location: c.location, rotation_euler: c.rotation_euler, scale: c.scale };
    this.animated.set(k, out);
    return out;
  }

  get<T = Block>(type: AnimTargetType, id: string): T | null {
    const k = `${type}:${id}`;
    if (this.final.has(k)) return this.final.get(k) as T | null;
    const fb = this.fallback;
    if (fb && (type === 'object' ? !fb.affected.has(id) : fb.data ? !fb.data.has(k) : !this.drivers.has(k)))
      return fb.store.get<T>(type, id);
    const base = this.animatedOnly(type, id);
    const ds = base ? this.drivers.get(k) : undefined;
    if (!base || !ds) {
      this.final.set(k, base);
      return base as T | null;
    }
    this.resolving.add(k);
    const out: Block = { ...base };
    for (const d of ds) {
      try {
        const v = evaluateDriver(d, this.frame, this.read);
        if (Number.isFinite(v)) writeChannel(out, d.path, d.index, v);
        else throw new Error(`driver returned ${v}`);
      } catch (e) {
        this.errors.push({ source: `driver:${fcurveKey(d)}`, message: (e as Error).message });
      }
    }
    this.resolving.delete(k);
    this.final.set(k, out);
    return out as T;
  }

  readonly read = (type: AnimTargetType, id: string, path: string, index: number): number | undefined => {
    const k = `${type}:${id}`;
    const src = this.resolving.has(k) ? this.animatedOnly(type, id) : this.get(type, id);
    return src ? readChannel(src, path, index) : undefined;
  };
}

/**
 * Transform state of the scene at one frame: animated + driven datablocks, parenting (object and
 * bone), armature poses, constraints and rigid body overrides. Everything is computed lazily and
 * memoised; dependency cycles resolve to null (callers fall back to identity). `options.channels`
 * replaces the channels of some objects, and `options.affected` limits what is evaluated anew to
 * the objects they change (see {@link FrameStateOptions}).
 */
export class FrameState {
  private objectList: ObjectData[] | null = null;
  private objectMap: Map<string, ObjectData> | null = null;
  private readonly over: Overlay | null;
  readonly errors: EvalError[] = [];
  readonly constraintErrors = new Map<string, ConstraintError[]>();
  private readonly store: AnimatedStore;
  private readonly input: FrameInput;
  private readonly localM = new Map<string, Mat4>();
  private readonly parentM = new Map<string, Mat4>();
  private readonly worldM = new Map<string, Mat4>();
  private readonly computing = new Set<string>();
  private readonly poses = new Map<string, ArmaturePose | null>();
  /** Incremental pose evaluations (bones are evaluated on demand, see `boneMatrix`). */
  private readonly poseEvals = new Map<string, PoseEvaluation | null>();
  private readonly paths = new Map<string, CurvePath | null>();
  /**
   * Simulated world matrices replacing the computed ones (rigid body world), without those of
   * FrameStateOptions.unsimulated.
   */
  readonly simulated: ReadonlyMap<string, Mat4> | null;

  constructor(
    readonly doc: SceneDoc,
    readonly frame: number,
    /** Simulated world matrices replacing the computed ones (rigid body world). */
    simulated: ReadonlyMap<string, Mat4> | null = null,
    options: FrameStateOptions = {},
  ) {
    const released = options.unsimulated;
    this.simulated =
      simulated && released && [...released].some((id) => simulated.has(id))
        ? new Map([...simulated].filter(([id]) => !released.has(id)))
        : simulated;
    let input = options.base?.input;
    if (!input) {
      const raw = doc.listObjects();
      input = {
        raw,
        rawById: new Map(raw.map((o) => [o.id, o])),
        curves: indexByTarget(doc.listFCurves(), (fc) => fc.keyframes.length === 0),
        drivers: indexByTarget(doc.listDrivers(), () => false),
      };
    }
    this.input = input;
    const { base, affected } = options;
    this.over =
      base && affected && base.frame === frame && base.simulated === simulated ? { base, affected } : null;
    const { rawById, curves, drivers } = input;
    const fallback = this.over && {
      store: this.over.base.store,
      affected: this.over.affected,
      data: options.affectedData ?? null,
    };
    this.store = new AnimatedStore(
      doc,
      frame,
      rawById,
      curves,
      drivers,
      this.errors,
      options.channels,
      fallback,
    );
    // an overlay lists the scene's objects only when asked for them
    if (!this.over) void this.byId;
  }

  /** The scene's objects, animated and driven. */
  get objects(): ObjectData[] {
    return (this.objectList ??= this.input.raw.map((o) => this.store.get<ObjectData>('object', o.id)!));
  }

  /** The scene's objects by id, animated and driven. */
  get byId(): Map<string, ObjectData> {
    return (this.objectMap ??= new Map(this.objects.map((o) => [o.id, o])));
  }

  /** Animated object `id` (undefined when missing), found without listing the scene's objects. */
  private object(id: string): ObjectData | undefined {
    return this.store.get<ObjectData>('object', id) ?? undefined;
  }

  /** The base frame state when object `id` is read from it (FrameStateOptions.affected), else null. */
  private fromBase(id: string): FrameState | null {
    const over = this.over;
    return over && !over.affected.has(id) ? over.base : null;
  }

  /** Animated + driven datablock (null when missing). */
  get<T>(type: AnimTargetType, id: string): T | null {
    return this.store.get<T>(type, id);
  }

  curve(id: string): CurveData | null {
    return this.store.get<CurveData>('curve', id);
  }

  local(id: string): Mat4 {
    const base = this.fromBase(id);
    if (base) return base.local(id);
    if (!this.localM.has(id)) this.world(id);
    return this.localM.get(id) ?? identity4();
  }

  /** World matrix of the object's parent (bone tail for bone parenting), identity if none. */
  parent(id: string): Mat4 {
    const base = this.fromBase(id);
    if (base) return base.parent(id);
    if (!this.parentM.has(id)) this.world(id);
    return this.parentM.get(id) ?? identity4();
  }

  /** Final world matrix (null if the object is missing or part of a dependency cycle). */
  world(id: string): Mat4 | null {
    const cached = this.worldM.get(id);
    if (cached) return cached;
    const base = this.fromBase(id);
    if (base) return base.world(id);
    const o = this.object(id);
    if (!o || this.computing.has(id)) return null;
    // the object's dependencies not handed out yet are evaluated first (dependency order), so long
    // parent / constraint chains never recurse deeply, also when a pose bone reads an object while
    // another object is being evaluated (an overlay evaluates them as they are asked for, see
    // FrameStateOptions.affected)
    if (!this.over) for (const dep of dependencyGraph(this).evaluationOrder(id)) this.world(dep);
    // a dependency may have evaluated this object already, through a relation inside an armature
    // pose (a cycle the object graph cannot see): keep that result, so every object is solved once
    // and its constraint errors match its matrix whatever the evaluation order
    const done = this.worldM.get(id);
    if (done) return done;
    this.computing.add(id);
    try {
      const local = compose4(o.location, o.rotation_euler, o.scale);
      this.localM.set(id, local);
      let parent = identity4();
      if (o.parent && o.parent !== id && this.object(o.parent)) {
        const pw = this.world(o.parent);
        const boneParent = o.parent_type === 'BONE' && !!o.parent_bone;
        // The parent (or the pose of the parent armature) is being evaluated and depends on this
        // object: a dependency cycle through parenting. Report this object as cyclic (null, not
        // cached) instead of caching it without its parent; only loops of parent links (corrupt
        // data) fall back to an identity parent (parent links are not animated: the stored ones).
        if (
          pw ? boneParent && this.boneCycle(o.parent, o.parent_bone) : !inParentLoop(this.input.rawById, id)
        )
          return null;
        if (pw) {
          parent = pw;
          if (boneParent) {
            const b = this.boneMatrix(o.parent, o.parent_bone);
            // Blender: bone children are placed relative to the bone's tail
            if (b) parent = multiply4(b.matrix, translation4([0, b.length, 0]));
          }
        }
      }
      this.parentM.set(id, parent);
      let m = multiply4(parent, local);
      const sim = this.simulated?.get(id);
      if (sim) m = sim;
      else if (o.constraints?.length) {
        const res = solveConstraints(o.constraints, m, this.constraintContext(id, parent));
        m = res.matrix;
        if (res.errors.length) this.constraintErrors.set(id, res.errors);
      }
      this.worldM.set(id, m);
      return m;
    } finally {
      this.computing.delete(id);
    }
  }

  /**
   * The context solving the constraints of object `id`. An overlay finds the constraints on
   * dependency cycles in its base's dependency graph (replaced channels change no relation) and
   * reads other objects' info without listing the scene.
   */
  private constraintContext(id: string, parent: Mat4): ConstraintContext {
    const ctx = constraintContextFor(this, id, parent);
    const over = this.over;
    if (!over) return ctx;
    return {
      ...ctx,
      dependencyCycle: (c) => dependencyGraph(over.base).cycle(id, c),
      getObjectInfo: (t) => {
        const info = constraintObjectInfo(over.base, t);
        if (!info || !over.affected.has(t)) return info;
        return { ...info, parentMatrix: info.parentMatrix && this.parent(t), basisMatrix: this.local(t) };
      },
    };
  }

  /**
   * Incremental pose evaluation of an armature object (null if not an armature, or while the
   * armature object's own transform is being computed).
   */
  private poseEvaluation(id: string): PoseEvaluation | null {
    const base = this.fromBase(id);
    if (base) return base.poseEvaluation(id);
    const known = this.poseEvals.get(id);
    if (known !== undefined) return known;
    const o = this.object(id);
    const arm = o?.type === 'ARMATURE' && o.data ? this.doc.getArmature(o.data) : null;
    if (!o || !arm) {
      this.poseEvals.set(id, null);
      return null;
    }
    const armatureMatrix = this.world(id);
    if (!armatureMatrix) return null;
    let ev = this.poseEvals.get(id);
    if (!ev) {
      ev = createPoseEvaluation(arm, o.pose?.bones ?? {}, {
        frame: this.frame,
        armatureMatrix,
        armatureId: id,
        getWorldMatrix: (t) => this.world(t),
        getBoneMatrix: (a, b) => this.boneMatrix(a, b),
      });
      this.poseEvals.set(id, ev);
    }
    return ev;
  }

  /**
   * Evaluated pose of an armature object (null if not an armature, or cyclic). Pose problems are
   * reported in `errors` (source `pose:<id>`).
   */
  pose(id: string): ArmaturePose | null {
    const base = this.fromBase(id);
    if (base) return base.pose(id);
    if (this.poses.has(id)) return this.poses.get(id)!;
    const ev = this.poseEvaluation(id);
    // asked for while one of its bones is being evaluated: a dependency cycle
    if (!ev || ev.busy) return null;
    let pose: ArmaturePose | null = null;
    try {
      pose = ev.result();
      for (const message of pose.errors ?? []) this.errors.push({ source: `pose:${id}`, message });
    } catch (e) {
      this.errors.push({ source: `pose:${id}`, message: (e as Error).message });
    }
    this.poses.set(id, pose);
    return pose;
  }

  /**
   * World-space posed bone matrix (origin at the head, +Y along the bone). Only the bone and
   * what it depends on are evaluated, so this works while other bones of the pose are evaluated.
   */
  boneMatrix(armatureId: string, bone: string): { matrix: Mat4; length: number } | null {
    const b = this.poseEvaluation(armatureId)?.bone(bone);
    const am = b ? this.world(armatureId) : null;
    return b && am ? { matrix: multiply4(am, b.matrix), length: b.length } : null;
  }

  /** Whether a bone is being evaluated or depends on one that is (a cycle through bone parenting). */
  private boneCycle(armatureId: string, bone: string): boolean {
    return !!this.poseEvaluation(armatureId)?.bone(bone)?.cyclic;
  }

  /** Path along the first spline of a CURVE object, with its world matrix. */
  curvePath(id: string): { path: CurvePath; matrix: Mat4; curve: CurveData } | null {
    const base = this.fromBase(id);
    if (base) return base.curvePath(id);
    const o = this.object(id);
    if (!o || o.type !== 'CURVE' || !o.data) return null;
    const curve = this.curve(o.data);
    if (!curve) return null;
    if (!this.paths.has(id)) this.paths.set(id, buildCurvePath(curve));
    const path = this.paths.get(id);
    const matrix = this.world(id);
    return path && matrix ? { path, matrix, curve } : null;
  }

  /** World matrices of every object. */
  allWorldMatrices(): Map<string, Mat4> {
    const out = new Map<string, Mat4>();
    for (const o of this.objects) out.set(o.id, this.world(o.id) ?? identity4());
    return out;
  }
}
