import type { EvaluatedObject, EvaluatedScene } from '@3d-editor/core';

/*
 * Final renders with the WebGL rasterizer (F12, Render Animation, MCP renders): what they show and
 * at what size. They show the scene like the path tracer and the server's renderers do (Blender's
 * F12), not like the viewport: render visibility and render settings, none of the viewport's
 * display settings.
 */

/** Largest side (pixels) of a final render in the browser. */
export const MAX_RENDER_SIDE = 4096;

/** The pixel size of a final render (see {@link renderOutputSize}). */
export interface RenderOutputSize {
  width: number;
  height: number;
  /** The size the output settings ask for (resolution × percentage), before the size limit. */
  requested: { width: number; height: number };
  /** True when the requested size was scaled down to fit {@link MAX_RENDER_SIDE}. */
  scaled: boolean;
}

/**
 * The pixel size of a final render from the output settings: resolution × percentage, rounded, at
 * least 1 pixel per side. An output larger than {@link MAX_RENDER_SIDE} on a side is scaled down,
 * both sides by the same factor, so the image keeps the aspect ratio (the framing of the camera).
 */
export function renderOutputSize(
  resolutionX: number,
  resolutionY: number,
  percentage: number,
): RenderOutputSize {
  const pct = Number.isFinite(percentage) && percentage > 0 ? percentage : 100;
  const w = (Math.max(1, Number.isFinite(resolutionX) ? resolutionX : 1) * pct) / 100;
  const h = (Math.max(1, Number.isFinite(resolutionY) ? resolutionY : 1) * pct) / 100;
  const requested = { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
  const scale = Math.min(1, MAX_RENDER_SIDE / Math.max(w, h));
  if (scale >= 1) return { ...requested, requested, scaled: false };
  return {
    width: Math.max(1, Math.min(MAX_RENDER_SIDE, Math.round(w * scale))),
    height: Math.max(1, Math.min(MAX_RENDER_SIDE, Math.round(h * scale))),
    requested,
    scaled: true,
  };
}

/** A short note for the render windows when the output was scaled down, else null. */
export function scaledOutputNote(size: RenderOutputSize): string | null {
  if (!size.scaled) return null;
  return (
    `Scaled down from ${size.requested.width}×${size.requested.height} px ` +
    `(the browser renders at most ${MAX_RENDER_SIDE} px per side; the framing is the same)`
  );
}

/** Viewport-only display settings of an object (Display As, wireframe overlay). */
const viewportDisplayOnly = (o: EvaluatedObject) =>
  o.data.display_type === 'WIRE' || o.data.display_type === 'BOUNDS' || o.data.show_wire;

/**
 * An evaluated scene (evaluated with `forRender`) as a final render shows it, for the viewport's
 * scene mirror: an object is visible when it is visible in renders (`hide_render`, its collection),
 * whatever `hide_viewport` says, and the viewport-only display settings are left out (Display As
 * Wire or Bounds draws the object normally, no wireframe overlay). Objects that need no change are
 * shared with `ev`.
 */
export function finalRenderScene(ev: EvaluatedScene): EvaluatedScene {
  let changed = false;
  const objects = ev.objects.map((o): EvaluatedObject => {
    if (o.visible === o.renderVisible && !viewportDisplayOnly(o)) return o;
    changed = true;
    return {
      ...o,
      visible: o.renderVisible,
      data: viewportDisplayOnly(o) ? { ...o.data, display_type: 'TEXTURED', show_wire: false } : o.data,
    };
  });
  if (!changed) return ev;
  const byId = new Map(objects.map((o) => [o.id, o]));
  return {
    ...ev,
    objects,
    byId,
    activeCamera: ev.activeCamera ? (byId.get(ev.activeCamera.id) ?? null) : null,
  };
}
