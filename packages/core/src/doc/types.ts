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

export type ObjectType = 'MESH' | 'EMPTY' | 'CAMERA' | 'LIGHT';
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

export interface TextureSlot {
  /** Image datablock id. */
  image: string;
  scale: Vec2;
  offset: Vec2;
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
}

export type Interpolation = 'CONSTANT' | 'LINEAR' | 'BEZIER';
export type Easing = 'AUTO' | 'EASE_IN' | 'EASE_OUT' | 'EASE_IN_OUT';

export interface Keyframe {
  frame: number;
  value: number;
  interpolation: Interpolation;
  easing?: Easing;
}

export type AnimTargetType = 'object' | 'material' | 'light' | 'camera' | 'world' | 'scene';

/** An animation curve for one scalar channel (`path` + `index`) of one datablock. */
export interface FCurve {
  target_type: AnimTargetType;
  target_id: string;
  /** Property path on the target, e.g. 'location', 'rotation_euler', 'energy', 'base_color'. */
  path: string;
  /** Array index for vector properties (0 for scalars). */
  index: number;
  keyframes: Keyframe[];
  extrapolation: 'CONSTANT' | 'LINEAR';
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
  meshes: (MeshBlock & { mesh: import('../mesh/types').MeshData })[];
  materials: MaterialData[];
  lights: LightData[];
  cameras: CameraData[];
  images: (ImageData & { data_base64: string })[];
  collections: CollectionData[];
  fcurves: FCurve[];
}

export type DatablockKind =
  'objects' | 'meshes' | 'materials' | 'lights' | 'cameras' | 'images' | 'collections';
