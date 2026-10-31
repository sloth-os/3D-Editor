import { useEffect, useRef } from 'preact/hooks';
import type { ProjectSession } from '../project/session';
import { NumberField } from './fields/fields';
import { Icon } from './icons';
import { run } from '../editor/editor';

/** Timeline with playback controls, frame range, scrubbing and keyframe diamonds of the selection. */
export function Timeline({ session }: { session: ProjectSession }) {
  void session.revision.value;
  const st = session.state;
  const frame = st.$frame.value;
  const playing = session.view.playing.value;
  const scene = session.doc.getScene();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sel = st.$selectedIds.value;
  const keyFrames = new Set<number>();
  for (const id of sel) for (const fc of session.doc.listFCurves(id)) for (const k of fc.keyframes) keyFrames.add(k.frame);

  const range = { start: scene.frame_start - 5, end: scene.frame_end + 5 };
  const toX = (f: number, w: number) => ((f - range.start) / (range.end - range.start)) * w;
  const toFrame = (x: number, w: number) => Math.round(range.start + (x / w) * (range.end - range.start));

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = w * devicePixelRatio;
    c.height = h * devicePixelRatio;
    const g = c.getContext('2d');
    if (!g) return;
    g.scale(devicePixelRatio, devicePixelRatio);
    g.fillStyle = '#2b2b2b';
    g.fillRect(0, 0, w, h);
    // out-of-range shading
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(0, 0, toX(scene.frame_start, w), h);
    g.fillRect(toX(scene.frame_end, w), 0, w, h);
    // ticks
    const span = range.end - range.start;
    const stepCandidates = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    const step = stepCandidates.find((s) => (w / span) * s > 40) ?? 1000;
    g.font = '10px system-ui';
    g.textAlign = 'center';
    for (let f = Math.ceil(range.start / step) * step; f <= range.end; f += step) {
      const x = toX(f, w);
      g.strokeStyle = '#3a3a3a';
      g.beginPath();
      g.moveTo(x + 0.5, 14);
      g.lineTo(x + 0.5, h);
      g.stroke();
      g.fillStyle = '#999';
      g.fillText(String(f), x, 10);
    }
    // keyframes
    for (const f of keyFrames) {
      const x = toX(f, w);
      const y = h / 2 + 6;
      g.fillStyle = f === frame ? '#ffd24a' : '#e8e8e8';
      g.strokeStyle = '#111';
      g.beginPath();
      g.moveTo(x, y - 5);
      g.lineTo(x + 5, y);
      g.lineTo(x, y + 5);
      g.lineTo(x - 5, y);
      g.closePath();
      g.fill();
      g.stroke();
    }
    // playhead
    const px = toX(frame, w);
    g.strokeStyle = '#4772b3';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(px, 14);
    g.lineTo(px, h);
    g.stroke();
    g.fillStyle = '#4772b3';
    const label = String(Math.round(frame));
    const tw = g.measureText(label).width + 10;
    g.fillRect(px - tw / 2, 0, tw, 14);
    g.fillStyle = '#fff';
    g.fillText(label, px, 10);
  });

  const scrub = (e: PointerEvent) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    st.frame = Math.max(-100000, toFrame(e.clientX - r.left, r.width));
  };

  return (
    <div class="timeline" onPointerDown={(e) => e.stopPropagation()}>
      <div class="area-header" style={{ gap: '6px' }}>
        <button class="btn flat icon" title="Jump to start (Shift ←)" onClick={() => run('screen.frame_jump', { end: false }, 'ui')}>
          <Icon name="first" />
        </button>
        <button class="btn flat icon" title="Previous keyframe (↓)" onClick={() => run('screen.keyframe_jump', { next: false }, 'ui')}>
          <Icon name="prev" />
        </button>
        <button class={`btn flat icon ${playing ? 'active' : ''}`} title="Play / Pause (Space)" data-testid="play" onClick={() => run('screen.animation_play', {}, 'ui')}>
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <button class="btn flat icon" title="Next keyframe (↑)" onClick={() => run('screen.keyframe_jump', { next: true }, 'ui')}>
          <Icon name="next" />
        </button>
        <button class="btn flat icon" title="Jump to end (Shift →)" onClick={() => run('screen.frame_jump', { end: true }, 'ui')}>
          <Icon name="last" />
        </button>
        <div style={{ width: '70px' }}>
          <NumberField value={frame} integer step={1} testId="current-frame" onChange={(v) => (st.frame = v)} />
        </div>
        <button
          class={`btn flat icon ${st.$autoKeying.value ? 'active' : ''}`}
          title="Auto Keying: transforms insert keyframes automatically"
          data-testid="autokey"
          onClick={() => (st.autoKeying = !st.autoKeying)}
          style={{ color: st.$autoKeying.value ? '#ff6b6b' : undefined }}
        >
          ●
        </button>
        <button class="btn flat" title="Insert keyframe on selected (I)" onClick={() => run('anim.keyframe_insert', {}, 'ui')}>
          <Icon name="key" size={12} /> Key
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px', alignItems: 'center' }}>
          <span class="hint">Start</span>
          <div style={{ width: '64px' }}>
            <NumberField value={scene.frame_start} integer step={1} onChange={(v, f) => f && run('data.set_property', { kind: 'scene', values: { frame_start: v } }, 'ui')} />
          </div>
          <span class="hint">End</span>
          <div style={{ width: '64px' }}>
            <NumberField value={scene.frame_end} integer step={1} onChange={(v, f) => f && run('data.set_property', { kind: 'scene', values: { frame_end: v } }, 'ui')} />
          </div>
        </div>
      </div>
      <div class="timeline-ruler" data-testid="timeline-ruler">
        <canvas
          ref={canvasRef}
          onPointerDown={(e) => {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            scrub(e);
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) scrub(e);
          }}
        />
      </div>
    </div>
  );
}
