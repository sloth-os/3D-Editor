import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, render } from '@testing-library/preact';
import { NavGizmo } from '../src/ui/NavGizmo';
import { DEFAULT_POSE, type ViewPose } from '../src/viewport/navigation';
import type { ViewportEngine } from '../src/viewport/engine';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A 2D context that records where the gizmo writes its axis labels (X, Y, Z). */
function recordLabels(): Record<string, { x: number; y: number }> {
  const labels: Record<string, { x: number; y: number }> = {};
  const ctx = new Proxy(
    {},
    {
      get: (_, key) =>
        key === 'fillText'
          ? (text: string, x: number, y: number) => (labels[text] = { x, y })
          : () => undefined,
      set: () => true,
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as never);
  return labels;
}

const pose = (yawDeg: number, pitchDeg: number): ViewPose => ({
  ...DEFAULT_POSE(),
  yaw: (yawDeg * Math.PI) / 180,
  pitch: (pitchDeg * Math.PI) / 180,
});

describe('NavGizmo', () => {
  /*
   * During an animated view change (Numpad keys, view_orbit, framing) the engine's pose is already
   * the view it goes to, while the frames show views on the way there: the gizmo drew the end view
   * for the whole animation.
   */
  it('shows the orientation of the frame drawn while an animated view change runs', () => {
    const labels = recordLabels();
    const engine = {
      pose: pose(0, 90), // Top: the view the animation goes to
      shownPose: pose(0, 0), // Front: what the last frame showed
      onAfterRender: new Set<() => void>(),
    };
    render(h(NavGizmo, { engine: engine as unknown as ViewportEngine }));
    // gizmo of 90 px, axes of 32 px around its centre (45, 45); labels drawn 0.5 px lower
    // Front: X to the right, Z up
    expect(labels.X.x).toBeCloseTo(77);
    expect(labels.X.y).toBeCloseTo(45.5);
    expect(labels.Z.x).toBeCloseTo(45);
    expect(labels.Z.y).toBeCloseTo(13.5);
    // the animation ends: the next frame shows the end view (Top: Y up, Z towards the viewer)
    engine.shownPose = engine.pose;
    for (const draw of engine.onAfterRender) draw();
    expect(labels.Y.x).toBeCloseTo(45);
    expect(labels.Y.y).toBeCloseTo(13.5);
    expect(labels.Z.x).toBeCloseTo(45);
    expect(labels.Z.y).toBeCloseTo(45.5);
  });
});
