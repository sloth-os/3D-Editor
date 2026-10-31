import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  MATERIAL_TEXTURE_CHANNELS,
  PFX_COORD_LIMIT,
  PFX_FMIX_M1,
  PFX_FMIX_M2,
  PFX_GRADIENTS,
  PFX_STREAM,
  PFX_STREAM_CELL,
  PFX_STREAM_CELL_B,
  PFX_STREAM_CELL_G,
  PFX_STREAM_CELL_R,
  PFX_STREAM_JITTER_Y,
  PFX_STREAM_JITTER_Z,
  PFX_STREAM_WARP,
  SceneDoc,
  SceneEvaluator,
  buildRenderBuffers,
  compileProcedural,
  createCube,
  defaultProcedural,
  defaultWorldSettings,
  skyEquirect,
  skySun,
  type EvaluatedScene,
  type MaterialTextureChannel,
  type WorldSettings,
} from '../src';
import {
  PROCEDURAL_GLSL_LIB,
  injectProceduralShader,
  proceduralProgramKey,
  proceduralUniformName,
  proceduralUniformValue,
} from '../../../apps/web/src/viewport/procedural-glsl';
import { setProceduralScene, viewportOrco } from '../../../apps/web/src/viewport/materials';
import { ViewportSky } from '../../../apps/web/src/viewport/sky';

/*
 * The viewport side of the procedural textures and the sky (apps/web/src/viewport), testable without
 * WebGL: the generated GLSL shares the core constants, the shader injection finds its three.js
 * anchors, the uniform layout matches the compiled form, GENERATED coordinates get the undeformed
 * positions, and the sky textures have the documented layout. (GPU parity of the GLSL itself was
 * checked in headless Chrome; it is not part of this node suite.)
 */

describe('procedural GLSL library', () => {
  it('is generated from the core hash constants, gradient table and stream ids', () => {
    for (const m of [PFX_FMIX_M1, PFX_FMIX_M2, PFX_STREAM])
      expect(PROCEDURAL_GLSL_LIB).toContain(`${m >>> 0}u`);
    const g = PFX_GRADIENTS;
    for (let i = 0; i < 16; i++) {
      const v = g.slice(i * 3, i * 3 + 3).map((x) => `${x}.0`);
      expect(PROCEDURAL_GLSL_LIB).toContain(`vec3(${v.join(', ')})`);
    }
    for (const id of [
      PFX_STREAM_JITTER_Y,
      PFX_STREAM_JITTER_Z,
      PFX_STREAM_CELL,
      PFX_STREAM_CELL_R,
      PFX_STREAM_CELL_G,
      PFX_STREAM_CELL_B,
      PFX_STREAM_WARP,
      PFX_STREAM_WARP + 1,
      PFX_STREAM_WARP + 2,
    ])
      expect(PROCEDURAL_GLSL_LIB).toContain(`${id}u`);
    expect(PROCEDURAL_GLSL_LIB).toContain(`${PFX_COORD_LIMIT}.0`);
    // the ramp handles inverted stops like the TypeScript (regression)
    expect(PROCEDURAL_GLSL_LIB).toMatch(/span < 0\.0 \? \(f >= lo \? 0\.0 : 1\.0\)/);
    // distance to edge uses the Euclidean nearest point whatever the metric (regression)
    expect(PROCEDURAL_GLSL_LIB).toMatch(/vec3 a = pts\[bE\];/);
  });

  it('declares a PfxTex struct whose members are the compiled form, in uniform order', () => {
    const struct = /struct PfxTex \{([^}]*)\}/.exec(PROCEDURAL_GLSL_LIB)![1];
    const members = [...struct.matchAll(/\s*\w+ (\w+);/g)].map((m) => m[1]);
    const value = proceduralUniformValue(compileProcedural(defaultProcedural('BRICK', { seed: -3 })));
    expect(members).toEqual(Object.keys(value));
    const c = compileProcedural(defaultProcedural('VORONOI', { seed: 12 }));
    const u = proceduralUniformValue(c);
    expect(u.type).toBe(c.type);
    expect(u.mode).toEqual(c.mode);
    expect(u.k2).toEqual(c.k2);
    expect(u.seed).toBe(c.seed >>> 0);
    expect(Number.isInteger(u.seed) && (u.seed as number) >= 0).toBe(true);
  });
});

describe('shader injection', () => {
  const shaders = {
    physical: THREE.ShaderLib.physical,
    standard: THREE.ShaderLib.standard,
  };

  it('injects every channel set into MeshPhysical/MeshStandard shaders of this three.js', () => {
    const sets: MaterialTextureChannel[][] = [
      ...MATERIAL_TEXTURE_CHANNELS.map((ch) => [ch]),
      [...MATERIAL_TEXTURE_CHANNELS],
    ];
    for (const [name, lib] of Object.entries(shaders))
      for (const channels of sets) {
        const shader = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
        expect(() => injectProceduralShader(shader, channels), `${name} ${channels}`).not.toThrow();
        for (const ch of channels)
          expect(shader.fragmentShader).toContain(`uniform PfxTex ${proceduralUniformName(ch)};`);
        // GENERATED coordinates from the undeformed positions (orco texture read by vertex id)
        expect(shader.vertexShader).toContain('uniform highp sampler2D pfxOrco;');
        expect(shader.vertexShader).toMatch(/vPfxGen = pfxOrcoWidth > 0 \? texelFetch\(pfxOrco/);
        expect(shader.fragmentShader).toMatch(/\(vPfxGen\.x - pfxTexMin\.x\)/);
        // injected after the chunk it overrides
        const at = (src: string, s: string) => src.indexOf(s);
        if (channels.includes('roughness'))
          expect(at(shader.fragmentShader, 'roughnessFactor = clamp(pfxSample')).toBeGreaterThan(
            at(shader.fragmentShader, '#include <roughnessmap_fragment>'),
          );
        if (channels.includes('normal'))
          expect(at(shader.fragmentShader, 'normal = pfxBump(')).toBeGreaterThan(
            at(shader.fragmentShader, '#include <normal_fragment_maps>'),
          );
      }
  });

  it('fails loudly when a three.js anchor chunk disappears', () => {
    const shader = { vertexShader: 'void main() {}', fragmentShader: '#include <common>' };
    expect(() => injectProceduralShader(shader, ['base_color'])).toThrow(/anchor/);
  });

  it('shares one program per channel set', () => {
    expect(proceduralProgramKey(['base_color', 'normal'])).toBe(
      proceduralProgramKey(['normal', 'base_color']),
    );
    const keys = new Set(MATERIAL_TEXTURE_CHANNELS.map((ch) => proceduralProgramKey([ch])));
    expect(keys.size).toBe(MATERIAL_TEXTURE_CHANNELS.length);
  });
});

describe('viewport GENERATED coordinates (orco)', () => {
  const twist = {
    id: 'tw',
    name: 'Twist',
    type: 'SIMPLE_DEFORM',
    show_viewport: true,
    show_render: true,
    show_in_editmode: true,
    show_expanded: true,
    params: { deform_method: 'TWIST', angle: Math.PI / 4, deform_axis: 'Z' },
  };

  function setup() {
    const doc = SceneDoc.create({ empty: true });
    const base = createCube({ size: 2 });
    const twisted = doc.addObject({
      type: 'MESH',
      name: 'Twisted',
      data: doc.addMesh('Twisted', base),
      modifiers: [twist],
    });
    const plain = doc.addObject({ type: 'MESH', name: 'Plain', data: doc.addMesh('Plain', base) });
    const ev = new SceneEvaluator(doc).evaluate(1, {});
    const scene = new THREE.Scene();
    setProceduralScene(scene, ev);
    const geometryOf = (id: string) => {
      const rb = buildRenderBuffers(ev.byId.get(id)!.mesh!);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(rb.positions, 3));
      return g;
    };
    const objectOf = (id: string) => {
      const o = new THREE.Object3D();
      o.userData.objectId = id;
      return o;
    };
    return { doc, ev, scene, base, twisted, plain, geometryOf, objectOf };
  }

  it('reads the undeformed render-vertex positions of deformed objects from a float texture', () => {
    const { doc, scene, base, twisted, geometryOf, objectOf } = setup();
    const t = viewportOrco(doc, scene, objectOf(twisted), geometryOf(twisted))!;
    expect(t).toBeTruthy();
    const rb = buildRenderBuffers(base);
    expect(t.count).toBe(rb.positions.length / 3);
    const data = t.texture.image.data as Float32Array;
    expect(t.texture.type).toBe(THREE.FloatType);
    expect(t.texture.magFilter).toBe(THREE.NearestFilter);
    // vertex i at texel (i mod width, i div width): the base (undeformed) positions
    for (let i = 0; i < t.count; i++)
      for (let k = 0; k < 3; k++) expect(data[i * 4 + k]).toBe(Math.fround(rb.positions[i * 3 + k]));
    // the same orco mesh shares its texture (cached by content)
    expect(viewportOrco(doc, scene, objectOf(twisted), geometryOf(twisted))!.texture).toBe(t.texture);
  });

  it('uses the vertex positions for undeformed objects, unknown objects and mismatching geometry', () => {
    const { doc, scene, plain, twisted, geometryOf, objectOf } = setup();
    expect(viewportOrco(doc, scene, objectOf(plain), geometryOf(plain))).toBeNull();
    expect(viewportOrco(doc, scene, objectOf('nope'), geometryOf(plain))).toBeNull();
    const other = new THREE.BufferGeometry();
    other.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    expect(viewportOrco(doc, scene, objectOf(twisted), other)).toBeNull();
    // no evaluated scene published yet
    expect(viewportOrco(doc, new THREE.Scene(), objectOf(twisted), geometryOf(twisted))).toBeNull();
  });
});

describe('ViewportSky', () => {
  /** PMREM stand-in: keeps the equirect texture so its content can be inspected. */
  const pmrem = {
    fromEquirectangular: (t: THREE.Texture) => ({ texture: t.clone(), dispose: () => undefined }),
  } as unknown as THREE.PMREMGenerator;
  const world = (patch: Partial<WorldSettings> = {}): WorldSettings => ({
    ...defaultWorldSettings(),
    environment: 'SKY',
    show_environment_background: true,
    ...patch,
  });
  const evaluated = (w: WorldSettings) => ({ world: w, objects: [] }) as unknown as EvaluatedScene;

  it('uploads the sky with three.js row order (row 0 = nadir) and Z-up rotation', () => {
    const w = world({ sun_elevation: 0.4, sun_rotation: 2 });
    const scene = new THREE.Scene();
    new ViewportSky(pmrem).apply(scene, evaluated(w), 'RENDERED', false);
    const bg = scene.background as THREE.DataTexture;
    expect(bg).toBeInstanceOf(THREE.DataTexture);
    const { width, height, data } = bg.image as { width: number; height: number; data: Uint16Array };
    const ref = skyEquirect(w, width, height, { sun: true });
    for (const [x, y] of [
      [0, 0],
      [width / 2, 10],
      [width - 1, height - 1],
      [37, height / 2 + 3],
    ]) {
      // texture row y is image row height − 1 − y of the core equirect (row 0 = zenith)
      const src = ((height - 1 - y) * width + x) * 3;
      for (let k = 0; k < 3; k++)
        expect(THREE.DataUtils.fromHalfFloat(data[(y * width + x) * 4 + k])).toBeCloseTo(ref[src + k], 2);
    }
    expect(scene.backgroundRotation.x).toBeCloseTo(Math.PI / 2, 12);
    expect(scene.environmentRotation.x).toBeCloseTo(Math.PI / 2, 12);
    expect(scene.environment).toBeTruthy();
  });

  it("adds the sky's sun as a light pointing along the sun direction, and mist as fog", () => {
    const w = world({ sun_elevation: 0.5, sun_rotation: 1, mist_density: 0.05, mist_color: [0.5, 0.6, 0.7] });
    const scene = new THREE.Scene();
    const sky = new ViewportSky(pmrem);
    sky.apply(scene, evaluated(w), 'RENDERED', true);
    const sun = scene.getObjectByName('Sky Sun') as THREE.DirectionalLight;
    expect(sun).toBeTruthy();
    const d = new THREE.Vector3().subVectors(sun.position, sun.target.position).normalize();
    const ref = skySun(w).direction;
    expect(d.x).toBeCloseTo(ref[0], 6);
    expect(d.y).toBeCloseTo(ref[1], 6);
    expect(d.z).toBeCloseTo(ref[2], 6);
    expect(sun.castShadow).toBe(true);
    const fog = scene.fog as THREE.FogExp2;
    expect(fog).toBeInstanceOf(THREE.FogExp2);
    expect(fog.density).toBe(0.05);
    expect(fog.color.toArray()).toEqual([0.5, 0.6, 0.7]);
    // Solid shading: no sky sun, no mist
    sky.apply(scene, evaluated(w), 'SOLID', false);
    expect(scene.getObjectByName('Sky Sun')).toBeUndefined();
    expect(scene.fog).toBeNull();
    // the evaluated scene is published for the procedural materials
    expect(scene.userData.pfxEvaluatedScene).toBeTruthy();
  });
});
