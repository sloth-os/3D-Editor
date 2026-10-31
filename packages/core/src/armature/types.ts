import type { Mat4, Vec3 } from '../math/types';

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
}

export interface ArmaturePose {
  bones: Map<string, PoseBoneMatrix>;
  /** Bone names ordered parents-first. */
  order: string[];
}

export interface PoseContext {
  frame: number;
  /** World matrix of the armature object. */
  armatureMatrix: Mat4;
  /** Final world matrix of another object (IK / constraint targets), null if missing or cyclic. */
  getWorldMatrix(id: string): Mat4 | null;
}
