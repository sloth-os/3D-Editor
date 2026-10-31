import type { Vec2, Vec3, Vec4 } from '../math/types';

/*
 * Document datablock types. Field names intentionally mirror Blender's RNA/Python API
 * (snake_case, e.g. `rotation_euler`, `hide_viewport`, `base_color`) so that scripts and AI
 * agents (via MCP) can use familiar property paths.
 *
 * All datablocks are stored in the shared Yjs document; every field is an independent
 * last-writer-wins register, so concurrent edits to different fields merge cleanly.
 */

export const SCHEMA_VERSION = 1;
export const ROOT_COLLECTION_ID = 'root';

/** Object types. FONT is a text object (Blender's name); CURVE and FONT use curve data. */
export type ObjectType = 'MESH' | 'EMPTY' | 'CAMERA' | 'LIGHT' | 'CURVE' | 'FONT' | 'ARMATURE';
export type EmptyDisplayType =
  'PLAIN_AXES' | 'ARROWS' | 'SINGLE_ARROW' | 'CIRCLE' | 'CUBE' | 'SPHERE' | 'CONE';
export type DisplayType = 'TEXTURED' | 'SOLID' | 'WIRE' | 'BOUNDS';

export interface ModifierData {
  id: string;
  name: string;
  /** Blender modifier type identifier, e.g. 'SUBSURF', 'MIRROR', 'ARRAY', 'BOOLEAN'. */
  type: string;
  show_viewport: boolean;
  show_render: boolean;
  show_in_editmode: boolean;
  show_expanded: boolean;
  /** Type-specific parameters (validated by the modifier's schema). */
  params: Record<string, unknown>;
}

export interface ObjectData {
  id: string;
  name: string;
  type: ObjectType;
  parent: string | null;
  collection: string;
  location: Vec3;
  rotation_euler: Vec3;
  scale: Vec3;
  /** Id of the object data block (mesh, camera or light), null for empties. */
  data: string | null;
  material_slots: (string | null)[];
  modifiers: ModifierData[];
  hide_viewport: boolean;
  hide_render: boolean;
  hide_select: boolean;
  display_type: DisplayType;
  show_wire: boolean;
  show_in_front: boolean;
  /** Object color (used by solid shading "Object" color mode). */
  color: Vec4;
  empty_display_type: EmptyDisplayType;
  empty_display_size: number;
  custom_props: Record<string, string | number | boolean>;
  /** 'BONE' parents the object to `parent_bone` of the parent armature (rigid, follows the bone). */
  parent_type: 'OBJECT' | 'BONE';
  parent_bone: string;
  /** Object constraints, evaluated in order after parenting and animation. */
  constraints: ConstraintData[];
  /** Empties can instance a collection (Blender "Collection Instance"). */
  instance_type: 'NONE' | 'COLLECTION';
  instance_collection: string | null;
  /** Particle systems scattering object/collection instances over this mesh. */
  particle_systems: ParticleSystemData[];
  /** Armature objects: per-bone pose transforms (bone local space), `pose.bones["Bone"]`. */
  pose: { bones: Record<string, PoseBone> };
  /** Rigid body physics settings (null = not simulated). */
  rigid_body: RigidBodyData | null;
}

export type ConstraintType =
  | 'TRACK_TO'
  | 'DAMPED_TRACK'
  | 'LOCKED_TRACK'
  | 'COPY_LOCATION'
  | 'COPY_ROTATION'
  | 'COPY_SCALE'
  | 'COPY_TRANSFORMS'
  | 'LIMIT_LOCATION'
  | 'LIMIT_ROTATION'
  | 'LIMIT_SCALE'
  | 'LIMIT_DISTANCE'
  | 'CHILD_OF'
  | 'FOLLOW_PATH'
  | 'CLAMP_TO'
  | 'FLOOR'
  | 'PIVOT'
  /** Inverse kinematics (pose bones only). */
  | 'IK';

export interface ConstraintData {
  id: string;
  name: string;
  type: ConstraintType;
  /** Disabled when true (Blender `mute`). */
  mute: boolean;
  /** 0..1 blend between the unconstrained and the constrained result. */
  influence: number;
  /** Target object id (or null). */
  target: string | null;
  /** Target bone name when the target is an armature ('' = none). */
  subtarget: string;
  show_expanded: boolean;
  /** Type-specific parameters (validated by the constraint's schema). */
  params: Record<string, unknown>;
}

export interface ParticleSystemData {
  id: string;
  name: string;
  show_viewport: boolean;
  show_render: boolean;
  /** Distribution / instancing settings (validated by the particle system schema). */
  settings: Record<string, unknown>;
}

export interface PoseBone {
  location: Vec3;
  rotation_euler: Vec3;
  scale: Vec3;
  /** Bone constraints (e.g. IK), evaluated in armature space during pose evaluation. */
  constraints?: ConstraintData[];
}

export type CollisionShape = 'BOX' | 'SPHERE' | 'CAPSULE' | 'CYLINDER' | 'CONE' | 'CONVEX_HULL' | 'MESH';

export interface RigidBodyData {
  /** ACTIVE bodies are simulated; PASSIVE bodies are static (or animated) colliders. */
  type: 'ACTIVE' | 'PASSIVE';
  enabled: boolean;
  /** Passive bodies follow their animation instead of the simulation. */
  kinematic: boolean;
  mass: number;
  friction: number;
  restitution: number;
  collision_shape: CollisionShape;
  collision_margin: number;
  linear_damping: number;
  angular_damping: number;
}

export type SplineType = 'POLY' | 'BEZIER' | 'NURBS';
export type HandleType = 'AUTO' | 'VECTOR' | 'ALIGNED' | 'FREE';

export interface SplinePoint {
  co: Vec3;
  /** Bezier handles (null for POLY/NURBS points, or AUTO handles computed on evaluation). */
  handle_left: Vec3 | null;
  handle_right: Vec3 | null;
  handle_left_type: HandleType;
  handle_right_type: HandleType;
  /** Bevel/taper radius multiplier. */
  radius: number;
  /** Twist around the curve tangent (radians). */
  tilt: number;
  /** NURBS weight. */
  weight: number;
}

export interface Spline {
  type: SplineType;
  points: SplinePoint[];
  use_cyclic_u: boolean;
  /** Per-spline resolution (0 = use the curve's resolution_u). */
  resolution_u: number;
  order_u: number;
  use_endpoint_u: boolean;
  use_smooth: boolean;
  material_index: number;
}

export type CurveFillMode = 'FULL' | 'BACK' | 'FRONT' | 'HALF' | 'NONE' | 'BOTH';
export type TextAlignX = 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY' | 'FLUSH';
export type TextAlignY = 'TOP_BASELINE' | 'TOP' | 'CENTER' | 'BOTTOM' | 'BOTTOM_BASELINE';

/**
 * Curve datablock, used by CURVE objects and (with the text fields) FONT objects, like
 * Blender's Curve / TextCurve.
 */
export interface CurveData {
  id: string;
  name: string;
  dimensions: '2D' | '3D';
  splines: Spline[];
  resolution_u: number;
  render_resolution_u: number;
  bevel_mode: 'ROUND' | 'OBJECT';
  bevel_depth: number;
  bevel_resolution: number;
  /** Optional curve object whose shape is used as the bevel profile (bevel_mode OBJECT). */
  bevel_object: string | null;
  /** Fraction of the curve to build the bevel along (0..1), for "growing" animations. */
  bevel_factor_start: number;
  bevel_factor_end: number;
  extrude: number;
  offset: number;
  fill_mode: CurveFillMode;
  use_fill_caps: boolean;
  twist_mode: 'Z_UP' | 'MINIMUM' | 'TANGENT';
  /** Follow Path: number of frames to traverse the path, and the current evaluation time. */
  path_duration: number;
  eval_time: number;
  use_path: boolean;
  /** Text (FONT objects) */
  body: string;
  font: string;
  size: number;
  space_line: number;
  space_word: number;
  space_character: number;
  shear: number;
  align_x: TextAlignX;
  align_y: TextAlignY;
  offset_x: number;
  offset_y: number;
}

export interface BoneData {
  name: string;
  parent: string | null;
  /** Rest pose in armature space. The bone's Y axis points from head to tail. */
  head: Vec3;
  tail: Vec3;
  roll: number;
  use_connect: boolean;
  use_deform: boolean;
  envelope_distance: number;
  envelope_weight: number;
  head_radius: number;
  tail_radius: number;
}

export interface ArmatureData {
  id: string;
  name: string;
  bones: BoneData[];
  display_type: 'OCTAHEDRAL' | 'STICK' | 'BBONE' | 'ENVELOPE' | 'WIRE';
  show_names: boolean;
  show_axes: boolean;
  /** REST shows the rest pose (pose transforms ignored). */
  pose_position: 'POSE' | 'REST';
}

/** Mesh shape key (morph target). Positions are absolute, vertex count must match the mesh. */
export interface ShapeKeyData {
  name: string;
  value: number;
  slider_min: number;
  slider_max: number;
  mute: boolean;
  /** Name of the key this one is relative to ('' = the basis / mesh itself). */
  relative_key: string;
  /** Float32 xyz positions (little endian). */
  data: Uint8Array;
}

/** Named per-vertex weights (Blender vertex group). Vertex count must match the mesh. */
export interface VertexGroupData {
  name: string;
  /** Float32 weights (little endian), one per vertex, 0..1. */
  weights: Uint8Array;
}

export interface MeshBlock {
  id: string;
  name: string;
}

export type LightType = 'POINT' | 'SUN' | 'SPOT' | 'AREA';
export type AreaShape = 'SQUARE' | 'RECTANGLE' | 'DISK' | 'ELLIPSE';

export interface LightData {
  id: string;
  name: string;
  type: LightType;
  color: Vec3;
  /** Power in watts (point/spot/area) or irradiance strength in W/m² (sun). */
  energy: number;
  use_shadow: boolean;
  shadow_soft_size: number;
  spot_size: number;
  spot_blend: number;
  shape: AreaShape;
  size: number;
  size_y: number;
}

export type CameraType = 'PERSP' | 'ORTHO';
export type SensorFit = 'AUTO' | 'HORIZONTAL' | 'VERTICAL';

export interface CameraData {
  id: string;
  name: string;
  type: CameraType;
  /** Focal length in millimeters. */
  lens: number;
  sensor_width: number;
  sensor_fit: SensorFit;
  clip_start: number;
  clip_end: number;
  ortho_scale: number;
  shift_x: number;
  shift_y: number;
  dof_use: boolean;
  dof_focus_distance: number;
  dof_aperture_fstop: number;
}

export type ProceduralType =
  'NOISE' | 'VORONOI' | 'CHECKER' | 'GRADIENT' | 'WAVE' | 'BRICK' | 'MARBLE' | 'WOOD' | 'MAGIC';

/** Procedural texture (shader-node-like), evaluated identically on CPU and GPU. */
export interface ProceduralTexture {
  type: ProceduralType;
  /** Texture coordinates: GENERATED (bounding box 0..1), OBJECT (object space) or UV. */
  mapping: 'GENERATED' | 'OBJECT' | 'UV';
  scale: number;
  detail: number;
  roughness: number;
  distortion: number;
  /** Color ramp: factor 0 → color_a, 1 → color_b (scalar channels use the red component). */
  color_a: Vec4;
  color_b: Vec4;
  /** Ramp remap: factor values below ramp_low map to 0, above ramp_high to 1. */
  ramp_low: number;
  ramp_high: number;
  seed: number;
  /** Type-specific options (e.g. brick mortar_size, wave_type). */
  params: Record<string, number | string>;
}

export interface TextureSlot {
  /** Image datablock id ('' when the slot is procedural). */
  image: string;
  scale: Vec2;
  offset: Vec2;
  /** When set, the slot uses this procedural texture instead of the image. */
  procedural?: ProceduralTexture | null;
}

export type MaterialTextureChannel =
  'base_color' | 'metallic' | 'roughness' | 'normal' | 'emission' | 'alpha';
export type BlendMethod = 'OPAQUE' | 'CLIP' | 'BLEND';

/** Principled-BSDF style physically based material. Colors are linear RGB(A). */
export interface MaterialData {
  id: string;
  name: string;
  base_color: Vec4;
  metallic: number;
  roughness: number;
  ior: number;
  transmission: number;
  emission_color: Vec3;
  emission_strength: number;
  alpha: number;
  blend_method: BlendMethod;
  alpha_threshold: number;
  coat_weight: number;
  coat_roughness: number;
  sheen_weight: number;
  sheen_tint: Vec3;
  normal_strength: number;
  use_backface_culling: boolean;
  textures: Partial<Record<MaterialTextureChannel, TextureSlot | null>>;
}

export interface ImageData {
  id: string;
  name: string;
  mime: string;
  width: number;
  height: number;
}

export interface CollectionData {
  id: string;
  name: string;
  parent: string | null;
  hide_viewport: boolean;
  hide_render: boolean;
  color_tag: string;
  /** Origin of the collection when instanced by an empty (Blender instance_offset). */
  instance_offset: Vec3;
}

export type ViewTransform = 'STANDARD' | 'AGX' | 'FILMIC' | 'ACES' | 'NEUTRAL';
export type RenderEngine = 'RASTER' | 'PATHTRACER';

export interface RenderSettings {
  engine: RenderEngine;
  resolution_x: number;
  resolution_y: number;
  resolution_percentage: number;
  samples: number;
  film_transparent: boolean;
  view_transform: ViewTransform;
  exposure: number;
  use_shadows: boolean;
  use_ambient_occlusion: boolean;
  use_bloom: boolean;
  /** Path tracer: maximum light bounces and denoising. */
  max_bounces: number;
  use_denoising: boolean;
}

export type EnvironmentType = 'NONE' | 'STUDIO' | 'SKY' | 'IMAGE';

export interface WorldSettings {
  color: Vec3;
  strength: number;
  environment: EnvironmentType;
  environment_image: string | null;
  environment_rotation: number;
  environment_strength: number;
  show_environment_background: boolean;
  /** Procedural sky (environment 'SKY'): linear colors, sun direction in radians. */
  sky_zenith_color: Vec3;
  sky_horizon_color: Vec3;
  sky_ground_color: Vec3;
  sun_elevation: number;
  sun_rotation: number;
  sun_intensity: number;
  sun_size: number;
  sun_color: Vec3;
  /** Distance fog (Blender mist): 0 disables. */
  mist_density: number;
  mist_color: Vec3;
}

export interface SceneSettings {
  name: string;
  /** Active camera object id. */
  camera: string | null;
  frame_start: number;
  frame_end: number;
  fps: number;
  unit_system: 'METRIC' | 'IMPERIAL' | 'NONE';
  unit_scale_length: number;
  /** Physics */
  use_gravity: boolean;
  gravity: Vec3;
  rigidbody_world: RigidBodyWorld;
}

export interface RigidBodyWorld {
  enabled: boolean;
  frame_start: number;
  frame_end: number;
  substeps_per_frame: number;
  solver_iterations: number;
  time_scale: number;
}

export type Interpolation = 'CONSTANT' | 'LINEAR' | 'BEZIER';
export type Easing = 'AUTO' | 'EASE_IN' | 'EASE_OUT' | 'EASE_IN_OUT';

export interface Keyframe {
  frame: number;
  value: number;
  interpolation: Interpolation;
  easing?: Easing;
}

/** 'mesh' targets shape key values, 'curve' targets curve/text data. */
export type AnimTargetType =
  'object' | 'material' | 'light' | 'camera' | 'world' | 'scene' | 'mesh' | 'curve';

/** An animation curve for one scalar channel (`path` + `index`) of one datablock. */
export interface FCurve {
  target_type: AnimTargetType;
  target_id: string;
  /** Property path on the target, e.g. 'location', 'rotation_euler', 'energy', 'base_color'. */
  path: string;
  /** Array index for vector properties (0 for scalars). */
  index: number;
  keyframes: Keyframe[];
  /** CYCLIC repeats the keyed range forever (like a Cycles F-modifier). */
  extrapolation: 'CONSTANT' | 'LINEAR' | 'CYCLIC';
  mute: boolean;
  /** F-curve modifiers applied after keyframe evaluation, in order. */
  modifiers?: FModifierData[];
}

export type FModifierType = 'NOISE' | 'STEPPED' | 'GENERATOR' | 'LIMITS' | 'ENVELOPE';

/** F-curve modifier (Blender FModifier): procedural change of an animation curve's value. */
export interface FModifierData {
  type: FModifierType;
  mute?: boolean;
  /** Type-specific parameters (Blender names, e.g. NOISE scale/strength/phase/offset/depth). */
  params: Record<string, number | boolean | string>;
}

export interface DriverVariable {
  name: string;
  target_type: AnimTargetType;
  target_id: string;
  path: string;
  index: number;
}

/**
 * Driver: sets an object property from an expression of other properties (and `frame`).
 * Evaluated after animation, before constraints.
 */
export interface DriverData {
  target_type: AnimTargetType;
  target_id: string;
  path: string;
  index: number;
  expression: string;
  variables: DriverVariable[];
  mute: boolean;
}

export interface ProjectMeta {
  schema_version: number;
  name: string;
  created_at: string;
  /** Free-form app version that created the document. */
  generator: string;
}

/** Plain JSON snapshot of a whole document (for export, debugging and tests). */
export interface SceneSnapshot {
  meta: ProjectMeta;
  scene: SceneSettings;
  render: RenderSettings;
  world: WorldSettings;
  objects: ObjectData[];
  meshes: (MeshBlock & {
    mesh: import('../mesh/types').MeshData;
    shape_keys?: (Omit<ShapeKeyData, 'data'> & { data_base64: string })[];
    vertex_groups?: { name: string; weights_base64: string }[];
  })[];
  materials: MaterialData[];
  lights: LightData[];
  cameras: CameraData[];
  images: (ImageData & { data_base64: string })[];
  collections: CollectionData[];
  fcurves: FCurve[];
  curves?: CurveData[];
  armatures?: ArmatureData[];
  drivers?: DriverData[];
}

export type DatablockKind =
  | 'objects'
  | 'meshes'
  | 'materials'
  | 'lights'
  | 'cameras'
  | 'images'
  | 'collections'
  | 'curves'
  | 'armatures';
