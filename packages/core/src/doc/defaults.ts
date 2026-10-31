import type {
  CameraData,
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

export function defaultCollection(id: string, name: string, parent: string | null = ROOT_COLLECTION_ID): CollectionData {
  return { id, name, parent, hide_viewport: false, hide_render: false, color_tag: 'NONE' };
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
  };
}
