import { useEffect, useRef, useState } from 'preact/hooks';
import { fcurveKey, type FCurve } from '@3d-editor/core';
import type { ProjectSession } from '../project/session';
import { run } from '../editor/editor';
import { Checkbox } from './fields/fields';

const ROW = 20;
const LABEL_W = 170;
const AXIS = ['X', 'Y', 'Z', 'W'];

interface Row {
  label: string;
  indent: number;
  curves: FCurve[];
  summary: boolean;
}

/** Dope Sheet: keyframes of objects per channel; click/box-select keys, drag to retime, X to delete. */
export function DopeSheet({ session: s }: { session: ProjectSession }) {
  void s.revision.value;
  const frame = s.state.$frame.value;
  const [onlySelected, setOnlySelected] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<{ x: number; delta: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scene = s.doc.getScene();
  const range = { start: scene.frame_start - 5, end: scene.frame_end + 5 };

  const objects = s.doc.listObjects().filter((o) => !onlySelected || s.state.selectedIds.includes(o.id));
  const rows: Row[] = [];
  const all: FCurve[] = [];
  for (const o of objects) {
    const curves = s.doc.listFCurves(o.id).sort((a, b) => a.path.localeCompare(b.path) || a.index - b.index);
    if (!curves.length) continue;
    all.push(...curves);
    rows.push({ label: o.name, indent: 0, curves, summary: true });
    for (const c of curves)
      rows.push({
        label: `${c.path.replace('_euler', '')} ${AXIS[c.index] ?? c.index}`,
        indent: 1,
        curves: [c],
        summary: false,
      });
  }
  const keyId = (fc: FCurve, f: number) => `${fcurveKey(fc)}@${f}`;

  const size = () => {
    const c = canvasRef.current!;
    return { w: c.clientWidth - LABEL_W, h: c.clientHeight };
  };
  const toX = (f: number, w: number) => LABEL_W + ((f - range.start) / (range.end - range.start)) * w;
  const toFrame = (x: number, w: number) => range.start + ((x - LABEL_W) / w) * (range.end - range.start);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const { w, h } = size();
    c.width = c.clientWidth * devicePixelRatio;
    c.height = c.clientHeight * devicePixelRatio;
    const g = c.getContext('2d');
    if (!g) return;
    g.scale(devicePixelRatio, devicePixelRatio);
    g.fillStyle = '#2b2b2b';
    g.fillRect(0, 0, c.clientWidth, h);
    const delta = drag ? Math.round(drag.delta) : 0;
    rows.forEach((r, i) => {
      const y = 18 + i * ROW;
      g.fillStyle = r.summary ? '#353535' : i % 2 ? '#2f2f2f' : '#2b2b2b';
      g.fillRect(0, y, c.clientWidth, ROW);
      g.fillStyle = r.summary ? '#e6e6e6' : '#aaa';
      g.font = `${r.summary ? 'bold ' : ''}11px system-ui`;
      g.fillText(r.label, 6 + r.indent * 12, y + 14);
      const frames = new Map<number, boolean>();
      for (const fc of r.curves)
        for (const k of fc.keyframes)
          frames.set(k.frame, (frames.get(k.frame) ?? false) || selected.has(keyId(fc, k.frame)));
      if (r.summary)
        for (const fc of r.curves)
          for (const k of fc.keyframes) if (selected.has(keyId(fc, k.frame))) frames.set(k.frame, true);
      for (const [f, sel] of frames) {
        const x = toX(f + (sel ? delta : 0), w);
        const cy = y + ROW / 2;
        g.fillStyle = sel ? '#ffb359' : '#d8d8d8';
        g.strokeStyle = '#111';
        g.beginPath();
        g.moveTo(x, cy - 5);
        g.lineTo(x + 5, cy);
        g.lineTo(x, cy + 5);
        g.lineTo(x - 5, cy);
        g.closePath();
        g.fill();
        g.stroke();
      }
    });
    // frame ruler + playhead
    g.fillStyle = '#232323';
    g.fillRect(0, 0, c.clientWidth, 18);
    g.fillStyle = '#999';
    g.font = '10px system-ui';
    g.textAlign = 'center';
    const span = range.end - range.start;
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((st) => (w / span) * st > 40) ?? 1000;
    for (let f = Math.ceil(range.start / step) * step; f <= range.end; f += step)
      g.fillText(String(f), toX(f, w), 12);
    g.textAlign = 'left';
    const px = toX(frame, w);
    g.strokeStyle = '#4772b3';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(px, 0);
    g.lineTo(px, h);
    g.stroke();
    if (!rows.length) {
      g.fillStyle = '#777';
      g.fillText(
        onlySelected
          ? 'Select animated objects (press I in the viewport to insert keyframes)'
          : 'No animation in this scene',
        LABEL_W + 10,
        40,
      );
    }
  });

  const hitKey = (x: number, y: number): { fc: FCurve; frame: number }[] => {
    const { w } = size();
    const i = Math.floor((y - 18) / ROW);
    const r = rows[i];
    if (!r) return [];
    const out: { fc: FCurve; frame: number }[] = [];
    for (const fc of r.curves)
      for (const k of fc.keyframes) if (Math.abs(toX(k.frame, w) - x) < 7) out.push({ fc, frame: k.frame });
    return out;
  };

  const selectedRefs = () =>
    all.flatMap((fc) =>
      fc.keyframes
        .filter((k) => selected.has(keyId(fc, k.frame)))
        .map((k) => ({ fcurve: fcurveKey(fc), frame: k.frame })),
    );

  return (
    <div class="column" style={{ height: '100%' }} onPointerDown={(e) => e.stopPropagation()}>
      <div class="area-header" style={{ gap: '8px' }}>
        <Checkbox value={onlySelected} label="Only Selected" onChange={setOnlySelected} />
        <button
          class="btn flat"
          disabled={!selected.size}
          onClick={() =>
            run('anim.keyframes_remove', { keys: selectedRefs() }, 'ui') && setSelected(new Set())
          }
        >
          Delete Keys
        </button>
        <button class="btn flat" onClick={() => run('anim.interpolation_type', { type: 'LINEAR' }, 'ui')}>
          Linear
        </button>
        <button class="btn flat" onClick={() => run('anim.interpolation_type', { type: 'BEZIER' }, 'ui')}>
          Bezier
        </button>
        <button class="btn flat" onClick={() => run('anim.interpolation_type', { type: 'CONSTANT' }, 'ui')}>
          Constant
        </button>
        <span class="hint">Click keys to select (Shift adds), drag to move, Delete removes</span>
      </div>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        style={{ flex: 1, width: '100%', minHeight: 0, outline: 'none' }}
        data-testid="dopesheet"
        onKeyDown={(e) => {
          if ((e.key === 'Delete' || e.key === 'x') && selected.size) {
            e.stopPropagation();
            run('anim.keyframes_remove', { keys: selectedRefs() }, 'ui');
            setSelected(new Set());
          }
        }}
        onPointerDown={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const x = e.clientX - r.left;
          const y = e.clientY - r.top;
          (e.currentTarget as HTMLElement).focus();
          if (y < 18 || x < LABEL_W) {
            const { w } = size();
            if (x >= LABEL_W) s.state.frame = Math.round(toFrame(x, w));
            return;
          }
          const hits = hitKey(x, y);
          const next = new Set(e.shiftKey ? selected : []);
          if (!hits.length) {
            setSelected(next);
            return;
          }
          const alreadySelected = hits.every((h) => selected.has(keyId(h.fc, h.frame)));
          for (const h of hits) next.add(keyId(h.fc, h.frame));
          setSelected(e.shiftKey || !alreadySelected ? next : selected);
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          setDrag({ x, delta: 0 });
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const { w } = size();
          const x = e.clientX - r.left;
          setDrag({ x: drag.x, delta: ((x - drag.x) / w) * (range.end - range.start) });
        }}
        onPointerUp={() => {
          if (!drag) return;
          const delta = Math.round(drag.delta);
          setDrag(null);
          if (delta === 0) return;
          const refs = selectedRefs();
          if (run('anim.keyframes_move', { keys: refs, delta }, 'ui')) {
            setSelected(new Set(refs.map((k) => `${k.fcurve}@${k.frame + delta}`)));
          }
        }}
      />
    </div>
  );
}
