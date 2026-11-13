import { describe, expect, it } from 'vitest';
import { SceneEvaluator, renderSceneSoftware, type SoftwareRenderOptions } from '../src';
import { deskScene, imageHash, mixedScene, spotInteriorScene } from './render-desk-helpers';

/*
 * The render-quality options (shadows, ambient occlusion, msaa, tonemapped resolve, dither, looks,
 * AOVs, lines) are all off by default: default renders must stay pixel-identical to the renderer
 * before they existed. The hashes below were taken with that renderer (git HEAD before the desk
 * render work) on the same scenes and sizes.
 */
const BEFORE = {
  desk_s2: '3fc8d80a6f9ab18a',
  desk_s1: 'e8c77167ae2dd02c',
  mixed_s2: '9986e2b29cdcd69d',
  mixed_solid_wire: 'f394d1e03071bdc0',
  mixed_transparent_s4: '753c1a20f142fc4a',
  mixed_bg: 'c2a6f8fcf5b03fdb',
  interior_s2: 'd3e1324c79ec1ab2',
};

/** Every new option at its "off" value. */
const OFF: Partial<SoftwareRenderOptions> = {
  shadows: false,
  ao: false,
  msaa: false,
  resolve: 'box',
  dither: false,
  look: 'material',
  aovs: [],
  lines: [],
};

describe('render quality options are off by default', () => {
  it('desk scene (SKY world, AgX) renders as before', () => {
    const { doc } = deskScene();
    const s2 = renderSceneSoftware(doc, { width: 96, height: 54, samples: 2 });
    expect(imageHash(s2)).toBe(BEFORE.desk_s2);
    expect(imageHash(renderSceneSoftware(doc, { width: 96, height: 54, samples: 1 }))).toBe(BEFORE.desk_s1);
    // the off values change nothing, and plain renders carry no passes and no view
    expect(imageHash(renderSceneSoftware(doc, { width: 96, height: 54, samples: 2, ...OFF }))).toBe(
      BEFORE.desk_s2,
    );
    expect(s2.aovs).toBeUndefined();
    expect(s2.view).toBeUndefined();
  });

  it('a shared evaluator and pooled buffers of another size leave the image unchanged', () => {
    const { doc } = deskScene();
    const evaluator = new SceneEvaluator(doc);
    renderSceneSoftware(doc, { width: 64, height: 36, samples: 2, evaluator });
    expect(imageHash(renderSceneSoftware(doc, { width: 96, height: 54, samples: 2, evaluator }))).toBe(
      BEFORE.desk_s2,
    );
  });

  it('mixed scene (studio world, metals, glass, blending, mist, wireframe, film, background) renders as before', () => {
    const { doc } = mixedScene();
    expect(imageHash(renderSceneSoftware(doc, { width: 80, height: 60, samples: 2 }))).toBe(BEFORE.mixed_s2);
    expect(imageHash(renderSceneSoftware(doc, { width: 80, height: 60, samples: 2, ...OFF }))).toBe(
      BEFORE.mixed_s2,
    );
    expect(
      imageHash(
        renderSceneSoftware(doc, { width: 80, height: 60, samples: 1, shading: 'SOLID', wireframe: true }),
      ),
    ).toBe(BEFORE.mixed_solid_wire);
    doc.updateRender({ film_transparent: true, view_transform: 'AGX' });
    expect(imageHash(renderSceneSoftware(doc, { width: 48, height: 32, samples: 4 }))).toBe(
      BEFORE.mixed_transparent_s4,
    );
    expect(
      imageHash(
        renderSceneSoftware(doc, { width: 48, height: 32, samples: 2, background: [0.2, 0.3, 0.4, 1] }),
      ),
    ).toBe(BEFORE.mixed_bg);
  });

  it('spot-lit interior renders as before', () => {
    const { doc } = spotInteriorScene();
    expect(imageHash(renderSceneSoftware(doc, { width: 96, height: 54, samples: 2 }))).toBe(
      BEFORE.interior_s2,
    );
  });

  it("'scene' shadows follow render.use_shadows and leave shadowless scenes unchanged", () => {
    // the mixed scene's lights are point, spot and area lights under a studio world: with the
    // render setting off, 'scene' shadows draw nothing
    const { doc } = mixedScene();
    doc.updateRender({ use_shadows: false });
    expect(imageHash(renderSceneSoftware(doc, { width: 80, height: 60, samples: 2, shadows: 'scene' }))).toBe(
      BEFORE.mixed_s2,
    );
  });
});
