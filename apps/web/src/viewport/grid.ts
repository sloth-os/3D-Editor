import * as THREE from 'three';

/**
 * Infinite-looking floor grid on the XY plane with 1 m / 10 m lines that fade with distance,
 * plus the red X and green Y axis lines.
 */
export function createGrid(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uDistance: { value: 15 },
      uOrtho: { value: 0 },
    },
    vertexShader: /* glsl */ `
      uniform float uDistance;
      varying vec3 vWorld;
      void main() {
        float s = max(uDistance * 60.0, 100.0);
        vec3 p = vec3(position.xy * s + cameraPosition.xy, 0.0);
        vWorld = p;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uDistance;
      uniform float uOrtho;
      varying vec3 vWorld;
      float gridLine(vec2 coord, float size) {
        vec2 c = coord / size;
        vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      void main() {
        float level = pow(10.0, floor(log(max(uDistance, 0.5) / 4.0) / log(10.0)));
        float small = gridLine(vWorld.xy, level);
        float large = gridLine(vWorld.xy, level * 10.0);
        float d = length(vWorld.xy - cameraPosition.xy);
        float fade = 1.0 - smoothstep(uDistance * 2.0, uDistance * 12.0, d);
        if (uOrtho > 0.5) fade = 1.0;
        vec3 color = vec3(0.33);
        float alpha = max(small * 0.35, large * 0.6) * fade;
        // axis lines
        vec2 w = fwidth(vWorld.xy);
        float ax = 1.0 - min(abs(vWorld.y) / (w.y * 1.5), 1.0);
        float ay = 1.0 - min(abs(vWorld.x) / (w.x * 1.5), 1.0);
        if (ax > 0.0) { color = mix(color, vec3(0.86, 0.22, 0.29), ax); alpha = max(alpha, ax * fade); }
        if (ay > 0.0) { color = mix(color, vec3(0.45, 0.72, 0.15), ay); alpha = max(alpha, ay * fade); }
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  mesh.name = '__grid';
  return mesh;
}

export function updateGrid(grid: THREE.Mesh, distance: number, ortho: boolean): void {
  const m = grid.material as THREE.ShaderMaterial;
  m.uniforms.uDistance.value = distance;
  m.uniforms.uOrtho.value = ortho ? 1 : 0;
}
