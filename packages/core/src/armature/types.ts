import type { Mat4, Vec3 } from '../math/types';

/** Envelope deform settings of a bone (armature space, metres). */
export interface BoneEnvelope {
  /** Falloff distance beyond the radius (Blender `envelope_distance`). */
  distance: number;
  /** Envelope weight multiplier (Blender `envelope_multiplier`/`envelope_weight`). */
  weight: number;
  headRadius: number;
  tailRadius: number;
}

/** Evaluated bone: rest and posed matrices in armature (object) space. */
export interface PoseBoneMatrix {
  name: string;
  parent: string | null;
  /** Rest matrix: origin at the bone head, +Y axis from head to tail, X/Z from the roll. */
  rest: Mat4;
  /** Posed matrix (same convention as `rest`). */
  matrix: Mat4;
  length: number;
  /** Posed head/tail positions (armature space). */
  head: Vec3;
  tail: Vec3;
  /** Rest head/tail positions (armature space; a connected bone's head is its parent's tail). */
  restHead?: Vec3;
  restTail?: Vec3;
  /** Whether the bone deforms meshes (BoneData.use_deform). */
  deform?: boolean;
  /** Envelope settings (used by envelope skinning and envelope weights). */
  envelope?: BoneEnvelope;
}

export interface ArmaturePose {
  bones: Map<string, PoseBoneMatrix>;
  /** Bone names ordered parents-first. */
  order: string[];
  /**
   * Non-fatal problems found while posing (invalid bone data, missing constraint targets,
   * dependency cycles…). Evaluation never throws for bad user data.
   */
  errors?: string[];
}

export interface PoseContext {
  frame: number;
  /** World matrix of the armature object. */
  armatureMatrix: Mat4;
  /** Final world matrix of another object (IK / constraint targets), null if missing or cyclic. */
  getWorldMatrix(id: string): Mat4 | null;
  /**
   * Optional: id of the armature object being posed. Constraint targets equal to it address this
   * armature (with a `subtarget`: one of its bones). Without it, every target is another object.
   */
  armatureId?: string;
  /**
   * Optional: world-space posed matrix of a bone of another armature object (bone subtargets);
   * null when the object is not an armature, has no such bone or depends on this pose (cycle).
   */
  getBoneMatrix?(armatureObjectId: string, bone: string): { matrix: Mat4; length: number } | null;
}
