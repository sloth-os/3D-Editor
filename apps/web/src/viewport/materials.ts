import * as THREE from 'three';
import type { MaterialData, SceneDoc } from '@3d-editor/core';

let matcap: THREE.Texture | null = null;

/** Procedural studio matcap (soft key light from top-left, rim light) for Solid shading. */
export function studioMatcap(): THREE.Texture {
  if (matcap) return matcap;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const img = ctx.createImageData(size, size);
    const light = new THREE.Vector3(-0.45, 0.6, 0.66).normalize();
    const fill = new THREE.Vector3(0.6, -0.2, 0.75).normalize();
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const nx = (x / (size - 1)) * 2 - 1;
        const ny = 1 - (y / (size - 1)) * 2;
        const r2 = nx * nx + ny * ny;
        const i = (y * size + x) * 4;
        if (r2 > 1) {
          img.data[i + 3] = 255;
          continue;
        }
        const n = new THREE.Vector3(nx, ny, Math.sqrt(1 - r2));
        const diff = Math.max(0, n.dot(light)) * 0.75 + Math.max(0, n.dot(fill)) * 0.25;
        const spec =
          Math.pow(
            Math.max(
              0,
              n
                .clone()
                .reflect(new THREE.Vector3(0, 0, 1))
                .negate()
                .dot(light),
            ),
            24,
          ) * 0.25;
        const rim = Math.pow(1 - n.z, 3) * 0.18;
        const v = Math.min(1, 0.16 + diff * 0.82 + spec + rim);
        const c = Math.round(Math.pow(v, 1 / 2.2) * 255);
        img.data[i] = c;
        img.data[i + 1] = c;
        img.data[i + 2] = c;
        img.data[i + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
  }
  matcap = new THREE.CanvasTexture(canvas);
  matcap.colorSpace = THREE.SRGBColorSpace;
  return matcap;
}

const DEFAULT_GREY = new THREE.Color(0.8, 0.8, 0.8);

export type ShadingKind = 'SOLID' | 'PBR';

/** Image datablock → GPU texture cache (decoded asynchronously). */
export class TextureCache {
  private cache = new Map<string, { texture: THREE.Texture; bytes: Uint8Array }>();
  constructor(private readonly onLoaded: () => void) {}

  get(doc: SceneDoc, imageId: string, srgb: boolean): THREE.Texture | null {
    const bytes = doc.getImageBytes(imageId);
    if (!bytes) return null;
    const key = `${imageId}:${srgb ? 's' : 'l'}`;
    const hit = this.cache.get(key);
    if (hit && hit.bytes === bytes) return hit.texture;
    hit?.texture.dispose();
    const tex = new THREE.Texture();
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.flipY = false;
    this.cache.set(key, { texture: tex, bytes });
    const mime = doc.getImage(imageId)?.mime ?? 'image/png';
    void createImageBitmap(new Blob([bytes as BlobPart], { type: mime }), { imageOrientation: 'flipY' })
      .then((bmp) => {
        tex.image = bmp;
        tex.needsUpdate = true;
        this.onLoaded();
      })
      .catch(() => undefined);
    return tex;
  }

  dispose(): void {
    for (const { texture } of this.cache.values()) texture.dispose();
    this.cache.clear();
  }
}

/** Builds a three.js material for a material slot in the given shading mode. */
export function buildMaterial(
  m: MaterialData | null,
  kind: ShadingKind,
  doc: SceneDoc,
  textures: TextureCache,
  opts: { objectColor?: [number, number, number, number]; vertexColors?: boolean } = {},
): THREE.Material {
  if (kind === 'SOLID') {
    const mat = new THREE.MeshMatcapMaterial({ matcap: studioMatcap() });
    if (m) mat.color.setRGB(m.base_color[0], m.base_color[1], m.base_color[2]);
    else mat.color.copy(DEFAULT_GREY);
    if (opts.objectColor && !m)
      mat.color.setRGB(opts.objectColor[0], opts.objectColor[1], opts.objectColor[2]);
    mat.vertexColors = !!opts.vertexColors;
    mat.side = m?.use_backface_culling ? THREE.FrontSide : THREE.DoubleSide;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = 1;
    mat.polygonOffsetUnits = 1;
    return mat;
  }
  const mat = new THREE.MeshPhysicalMaterial();
  const d = m;
  if (!d) {
    mat.color.copy(DEFAULT_GREY);
    mat.roughness = 0.5;
    mat.side = THREE.DoubleSide;
    return mat;
  }
  mat.name = d.name;
  mat.color.setRGB(d.base_color[0], d.base_color[1], d.base_color[2]);
  mat.metalness = d.metallic;
  mat.roughness = d.roughness;
  mat.ior = d.ior;
  mat.transmission = d.transmission;
  mat.thickness = d.transmission > 0 ? 0.5 : 0;
  mat.emissive.setRGB(d.emission_color[0], d.emission_color[1], d.emission_color[2]);
  mat.emissiveIntensity = d.emission_strength;
  mat.clearcoat = d.coat_weight;
  mat.clearcoatRoughness = d.coat_roughness;
  mat.sheen = d.sheen_weight;
  mat.sheenColor.setRGB(d.sheen_tint[0], d.sheen_tint[1], d.sheen_tint[2]);
  const alpha = d.alpha * d.base_color[3];
  mat.opacity = alpha;
  mat.transparent = d.blend_method === 'BLEND' && alpha < 1;
  mat.alphaTest = d.blend_method === 'CLIP' ? d.alpha_threshold : 0;
  mat.depthWrite = !mat.transparent;
  mat.side = d.use_backface_culling ? THREE.FrontSide : THREE.DoubleSide;
  mat.vertexColors = !!opts.vertexColors;
  const tex = (ch: keyof MaterialData['textures'], srgb: boolean) => {
    const slot = d.textures[ch];
    if (!slot) return null;
    const t = textures.get(doc, slot.image, srgb);
    if (t) {
      t.repeat.set(slot.scale?.[0] ?? 1, slot.scale?.[1] ?? 1);
      t.offset.set(slot.offset?.[0] ?? 0, slot.offset?.[1] ?? 0);
    }
    return t;
  };
  mat.map = tex('base_color', true);
  mat.roughnessMap = tex('roughness', false);
  mat.metalnessMap = tex('metallic', false);
  mat.normalMap = tex('normal', false);
  if (mat.normalMap) mat.normalScale.set(d.normal_strength, d.normal_strength);
  mat.emissiveMap = tex('emission', true);
  mat.alphaMap = tex('alpha', false);
  return mat;
}

export function materialKey(
  m: MaterialData | null,
  kind: ShadingKind,
  vertexColors: boolean,
  imagesRev: number,
): string {
  return `${kind}|${vertexColors ? 1 : 0}|${imagesRev}|${m ? JSON.stringify(m) : 'none'}`;
}
