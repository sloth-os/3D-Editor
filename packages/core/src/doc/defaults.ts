import type {
  ArmatureData,
  BoneData,
  CameraData,
  CurveData,
  PoseBone,
  RigidBodyData,
  Spline,
  SplinePoint,
  CollectionData,
  LightData,
  LightType,
  MaterialData,
  ObjectData,
  ObjectType,
  RenderSettings,
  SceneSettings,
  WorldSettings,
} from './types';
import { ROOT_COLLECTION_ID } from './types';

export function defaultObject(type: ObjectType, id: string, name: string): ObjectData {
  return {
    id,
    name,
    type,
    parent: null,
    collection: ROOT_COLLECTION_ID,
    location: [0, 0, 0],
    rotation_euler: [0, 0, 0],
    scale: [1, 1, 1],
    data: null,
    material_slots: [],
    modifiers: [],
    hide_viewport: false,
    hide_render: false,
    hide_select: false,
    display_type: 'TEXTURED',
    show_wire: false,
    show_in_front: false,
    color: [1, 1, 1, 1],
    empty_display_type: 'PLAIN_AXES',
    empty_display_size: 1,
    custom_props: {},
    parent_type: 'OBJECT',
    parent_bone: '',
    constraints: [],
    instance_type: 'NONE',
    instance_collection: null,
    particle_systems: [],
    pose: { bones: {} },
    rigid_body: null,
  };
}

export function defaultSplinePoint(co: [number, number, number] = [0, 0, 0]): SplinePoint {
  return {
    co,
    handle_left: null,
    handle_right: null,
    handle_left_type: 'AUTO',
    handle_right_type: 'AUTO',
    radius: 1,
    tilt: 0,
    weight: 1,
  };
}

export function defaultSpline(type: Spline['type'] = 'BEZIER', points: SplinePoint[] = []): Spline {
  return {
    type,
    points,
    use_cyclic_u: false,
    resolution_u: 0,
    order_u: 4,
    use_endpoint_u: true,
    use_smooth: true,
    material_index: 0,
  };
}

export function defaultCurve(id: string, name: string): CurveData {
  return {
    id,
    name,
    dimensions: '3D',
    splines: [],
    resolution_u: 12,
    render_resolution_u: 0,
    bevel_mode: 'ROUND',
    bevel_depth: 0,
    bevel_resolution: 4,
    bevel_object: null,
    bevel_factor_start: 0,
    bevel_factor_end: 1,
    extrude: 0,
    offset: 0,
    fill_mode: 'FULL',
    use_fill_caps: false,
    twist_mode: 'MINIMUM',
    path_duration: 100,
    eval_time: 0,
    use_path: true,
    body: '',
    font: 'BUILTIN',
    size: 1,
    space_line: 1,
    space_word: 1,
    space_character: 1,
    shear: 0,
    align_x: 'LEFT',
    align_y: 'TOP_BASELINE',
    offset_x: 0,
    offset_y: 0,
  };
}

export function defaultBone(
  name: string,
  head: [number, number, number] = [0, 0, 0],
  tail: [number, number, number] = [0, 0, 1],
): BoneData {
  return {
    name,
    parent: null,
    head,
    tail,
    roll: 0,
    use_connect: false,
    use_deform: true,
    envelope_distance: 0.25,
    envelope_weight: 1,
    head_radius: 0.1,
    tail_radius: 0.05,
  };
}

export function defaultArmature(id: string, name: string): ArmatureData {
  return {
    id,
    name,
    bones: [],
    display_type: 'OCTAHEDRAL',
    show_names: false,
    show_axes: false,
    pose_position: 'POSE',
  };
}

export function defaultPoseBone(): PoseBone {
  return { location: [0, 0, 0], rotation_euler: [0, 0, 0], scale: [1, 1, 1] };
}

export function defaultRigidBody(type: RigidBodyData['type'] = 'ACTIVE'): RigidBodyData {
  return {
    type,
    enabled: type === 'ACTIVE',
    kinematic: false,
    mass: 1,
    friction: 0.5,
    restitution: 0,
    collision_shape: 'CONVEX_HULL',
    collision_margin: 0.04,
    linear_damping: 0.04,
    angular_damping: 0.1,
  };
}

export function defaultMaterial(id: string, name: string): MaterialData {
  return {
    id,
    name,
    base_color: [0.8, 0.8, 0.8, 1],
    metallic: 0,
    roughness: 0.5,
    ior: 1.5,
    transmission: 0,
    emission_color: [1, 1, 1],
    emission_strength: 0,
    alpha: 1,
    blend_method: 'OPAQUE',
    alpha_threshold: 0.5,
    coat_weight: 0,
    coat_roughness: 0.03,
    sheen_weight: 0,
    sheen_tint: [1, 1, 1],
    normal_strength: 1,
    use_backface_culling: false,
    textures: {},
  };
}

export function defaultLight(id: string, name: string, type: LightType = 'POINT'): LightData {
  return {
    id,
    name,
    type,
    color: [1, 1, 1],
    energy: type === 'SUN' ? 1 : 1000,
    use_shadow: true,
    shadow_soft_size: type === 'SUN' ? 0 : 0.25,
    spot_size: Math.PI / 4,
    spot_blend: 0.15,
    shape: 'SQUARE',
    size: type === 'AREA' ? 1 : 0.25,
    size_y: 1,
  };
}

export function defaultCamera(id: string, name: string): CameraData {
  return {
    id,
    name,
    type: 'PERSP',
    lens: 50,
    sensor_width: 36,
    sensor_fit: 'AUTO',
    clip_start: 0.1,
    clip_end: 1000,
    ortho_scale: 6,
    shift_x: 0,
    shift_y: 0,
    dof_use: false,
    dof_focus_distance: 10,
    dof_aperture_fstop: 2.8,
  };
}

export function defaultCollection(
  id: string,
  name: string,
  parent: string | null = ROOT_COLLECTION_ID,
): CollectionData {
  return {
    id,
    name,
    parent,
    hide_viewport: false,
    hide_render: false,
    color_tag: 'NONE',
    instance_offset: [0, 0, 0],
  };
}

export function defaultSceneSettings(): SceneSettings {
  return {
    name: 'Scene',
    camera: null,
    frame_start: 1,
    frame_end: 250,
    fps: 24,
    unit_system: 'METRIC',
    unit_scale_length: 1,
    use_gravity: true,
    gravity: [0, 0, -9.81],
    rigidbody_world: {
      enabled: true,
      frame_start: 1,
      frame_end: 250,
      substeps_per_frame: 10,
      solver_iterations: 10,
      time_scale: 1,
    },
  };
}

export function defaultRenderSettings(): RenderSettings {
  return {
    engine: 'RASTER',
    resolution_x: 1920,
    resolution_y: 1080,
    resolution_percentage: 100,
    samples: 64,
    film_transparent: false,
    view_transform: 'AGX',
    exposure: 0,
    use_shadows: true,
    use_ambient_occlusion: false,
    use_bloom: false,
    max_bounces: 4,
    use_denoising: true,
  };
}

export function defaultWorldSettings(): WorldSettings {
  return {
    color: [0.051, 0.051, 0.051],
    strength: 1,
    environment: 'STUDIO',
    environment_image: null,
    environment_rotation: 0,
    environment_strength: 1,
    show_environment_background: false,
    sky_zenith_color: [0.12, 0.28, 0.65],
    sky_horizon_color: [0.62, 0.74, 0.88],
    sky_ground_color: [0.18, 0.16, 0.14],
    sun_elevation: (35 * Math.PI) / 180,
    sun_rotation: (45 * Math.PI) / 180,
    sun_intensity: 3,
    sun_size: (0.545 * Math.PI) / 180,
    sun_color: [1, 0.95, 0.88],
    mist_density: 0,
    mist_color: [0.7, 0.75, 0.8],
  };
}
