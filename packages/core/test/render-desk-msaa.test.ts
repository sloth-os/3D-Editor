import { describe, expect, it } from 'vitest';
import { SceneEvaluator, renderSceneSoftware, type RenderedImage } from '../src';
import { deskScene, imageHash, mixedScene } from './render-desk-helpers';

/** Mean absolute difference of two images' RGB bytes. */
function meanAbsDiff(a: RenderedImage, b: RenderedImage): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4)
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(a.data[i + c] - b.data[i + c]);
      n++;
    }
  return sum / n;
}

/** Share of pixels whose largest channel difference exceeds `t`. */
function shareOver(a: RenderedImage, b: RenderedImage, t: number): number {
  let over = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
    );
    if (d > t) over++;
  }
  return over / (a.data.length / 4);
}

describe('msaa (shading once per pixel and triangle)', () => {
  it('matches supersampling closely on the desk scene', () => {
    const { doc } = deskScene();
    const evaluator = new SceneEvaluator(doc);
    const size = { width: 192, height: 108, evaluator };
    const ss2 = renderSceneSoftware(doc, { ...size, samples: 2 });
    const ms2 = renderSceneSoftware(doc, { ...size, samples: 2, msaa: true });
    const ss4 = renderSceneSoftware(doc, { ...size, samples: 4 });
    expect(imageHash(ms2)).not.toBe(imageHash(ss2));
    expect(meanAbsDiff(ms2, ss2)).toBeLessThan(1);
    // edges keep their coverage: hardly any pixel differs visibly
    expect(shareOver(ms2, ss2, 12)).toBeLessThan(0.005);
    // as close to the 4 × 4 reference as plain 2 × 2 supersampling is
    expect(meanAbsDiff(ms2, ss4)).toBeLessThan(meanAbsDiff(ss2, ss4) * 1.5 + 0.3);
  });

  it('matches supersampling on textures, glass, alpha blending, metals, mist and wireframes', () => {
    const { doc } = mixedScene();
    for (const extra of [{}, { wireframe: true }]) {
      const ss = renderSceneSoftware(doc, { width: 120, height: 90, samples: 2, ...extra });
      const ms = renderSceneSoftware(doc, { width: 120, height: 90, samples: 2, msaa: true, ...extra });
      expect(meanAbsDiff(ms, ss)).toBeLessThan(1.5);
      expect(shareOver(ms, ss, 24)).toBeLessThan(0.01);
    }
  });

  it('is the plain renderer with one sample per pixel', () => {
    const { doc } = mixedScene();
    const a = renderSceneSoftware(doc, { width: 80, height: 60, samples: 1 });
    const b = renderSceneSoftware(doc, { width: 80, height: 60, samples: 1, msaa: true });
    expect(imageHash(b)).toBe(imageHash(a));
  });

  it('is deterministic: fresh renders, a shared evaluator and renders of other sizes in between', () => {
    const { doc } = deskScene({ segments: 16 });
    const opts = { width: 96, height: 54, samples: 2, msaa: true, shadows: true, ao: true } as const;
    const first = imageHash(renderSceneSoftware(doc, opts));
    expect(imageHash(renderSceneSoftware(doc, opts))).toBe(first);
    const evaluator = new SceneEvaluator(doc);
    renderSceneSoftware(doc, { ...opts, width: 64, height: 40, evaluator });
    expect(imageHash(renderSceneSoftware(doc, { ...opts, evaluator }))).toBe(first);
    // a fresh document built the same way renders the same pixels
    expect(imageHash(renderSceneSoftware(deskScene({ segments: 16 }).doc, opts))).toBe(first);
  });
});
