/* Subset of the glTF 2.0 JSON schema used by the importer and exporter. */

export type GltfExtensions = Record<string, any>;

export interface GltfTextureInfo {
  index: number;
  texCoord?: number;
  scale?: number;
  strength?: number;
  extensions?: GltfExtensions;
}

export interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    baseColorTexture?: GltfTextureInfo;
    metallicFactor?: number;
    roughnessFactor?: number;
    metallicRoughnessTexture?: GltfTextureInfo;
  };
  normalTexture?: GltfTextureInfo;
  occlusionTexture?: GltfTextureInfo;
  emissiveTexture?: GltfTextureInfo;
  emissiveFactor?: number[];
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff?: number;
  doubleSided?: boolean;
  extensions?: GltfExtensions;
  extras?: unknown;
}

export interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: Record<string, number>[];
  extensions?: GltfExtensions;
}

export interface GltfMesh {
  name?: string;
  primitives: GltfPrimitive[];
  weights?: number[];
  extras?: unknown;
}

export interface GltfNode {
  name?: string;
  children?: number[];
  mesh?: number;
  camera?: number;
  skin?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  weights?: number[];
  extensions?: GltfExtensions;
  extras?: unknown;
}

export interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT2' | 'MAT3' | 'MAT4';
  min?: number[];
  max?: number[];
  sparse?: {
    count: number;
    indices: { bufferView: number; byteOffset?: number; componentType: number };
    values: { bufferView: number; byteOffset?: number };
  };
  name?: string;
}

export interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
  name?: string;
}

export interface GltfCamera {
  name?: string;
  type: 'perspective' | 'orthographic';
  perspective?: { aspectRatio?: number; yfov: number; znear: number; zfar?: number };
  orthographic?: { xmag: number; ymag: number; znear: number; zfar: number };
}

export interface GltfLight {
  name?: string;
  type: 'point' | 'spot' | 'directional';
  color?: number[];
  intensity?: number;
  range?: number;
  spot?: { innerConeAngle?: number; outerConeAngle?: number };
}

export interface GltfAnimation {
  name?: string;
  channels: { sampler: number; target: { node?: number; path: string; extensions?: GltfExtensions } }[];
  samplers: { input: number; output: number; interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE' }[];
}

export interface GltfRoot {
  asset: { version: string; generator?: string; minVersion?: string; copyright?: string };
  scene?: number;
  scenes?: { name?: string; nodes?: number[]; extras?: unknown }[];
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  materials?: GltfMaterial[];
  textures?: { sampler?: number; source?: number; name?: string; extensions?: GltfExtensions }[];
  images?: { uri?: string; mimeType?: string; bufferView?: number; name?: string }[];
  samplers?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }[];
  cameras?: GltfCamera[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: { uri?: string; byteLength: number; name?: string }[];
  animations?: GltfAnimation[];
  skins?: unknown[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  extensions?: GltfExtensions;
  extras?: unknown;
}

export const GL = {
  BYTE: 5120,
  UNSIGNED_BYTE: 5121,
  SHORT: 5122,
  UNSIGNED_SHORT: 5123,
  UNSIGNED_INT: 5125,
  FLOAT: 5126,
  ARRAY_BUFFER: 34962,
  ELEMENT_ARRAY_BUFFER: 34963,
  LINEAR: 9729,
  LINEAR_MIPMAP_LINEAR: 9987,
  REPEAT: 10497,
} as const;

export const COMPONENT_SIZE: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};
export const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};
