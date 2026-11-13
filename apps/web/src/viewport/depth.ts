import * as THREE from 'three';

/**
 * Captures a depth image of selected objects so edit-mode selection can ignore occluded
 * elements (like Blender with X-ray off). Depth is packed into 24-bit RGB for portability.
 */
export class DepthCapture {
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly material = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      void main() {
        float v = floor(gl_FragCoord.z * 16777215.0 + 0.5);
        float r = floor(v / 65536.0);
        float g = floor((v - r * 65536.0) / 256.0);
        float b = v - r * 65536.0 - g * 256.0;
        gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
      }
    `,
  });
  private pixels = new Uint8Array(0);
  width = 0;
  height = 0;

  capture(
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    objects: THREE.Object3D[],
    width: number,
    height: number,
  ): void {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (!this.target || this.target.width !== width || this.target.height !== height) {
      this.target?.dispose();
      this.target = new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: true,
        type: THREE.UnsignedByteType,
      });
      this.pixels = new Uint8Array(width * height * 4);
    }
    this.width = width;
    this.height = height;
    const scene = new THREE.Scene();
    scene.overrideMaterial = this.material;
    const parents = new Map<THREE.Object3D, THREE.Object3D | null>();
    // render clones sharing geometry, with the objects' world matrices
    for (const o of objects) {
      const mesh = o as THREE.Mesh;
      if (!mesh.geometry) continue;
      const c = new THREE.Mesh(mesh.geometry, this.material);
      c.matrixAutoUpdate = false;
      c.matrix.copy(mesh.matrixWorld);
      c.matrixWorldNeedsUpdate = true;
      scene.add(c);
      parents.set(c, null);
    }
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevAutoClear = renderer.autoClear;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0xffffff, 1);
    renderer.autoClear = true;
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(this.target, 0, 0, width, height, this.pixels);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAutoClear;
  }

  /** Window-space depth (0..1) at a pixel (y measured from the top), max over a 3x3 neighbourhood. */
  depthAt(x: number, yTop: number): number {
    if (!this.width) return 1;
    const cx = Math.round(x);
    const cy = this.height - 1 - Math.round(yTop);
    let max = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const px = Math.min(this.width - 1, Math.max(0, cx + dx));
        const py = Math.min(this.height - 1, Math.max(0, cy + dy));
        const i = (py * this.width + px) * 4;
        const d = (this.pixels[i] * 65536 + this.pixels[i + 1] * 256 + this.pixels[i + 2]) / 16777215;
        if (d > max) max = d;
      }
    return max;
  }

  dispose(): void {
    this.target?.dispose();
    this.material.dispose();
  }
}

/** Converts window depth to linear eye distance for a camera. */
export function linearDepth(d: number, camera: THREE.PerspectiveCamera | THREE.OrthographicCamera): number {
  const n = camera.near;
  const f = camera.far;
  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) return n + d * (f - n);
  const z = d * 2 - 1;
  return (2 * n * f) / (f + n - z * (f - n));
}
