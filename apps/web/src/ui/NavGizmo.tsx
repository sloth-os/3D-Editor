import { useEffect, useRef } from 'preact/hooks';
import * as THREE from 'three';
import type { ViewportEngine } from '../viewport/engine';
import { poseBasis, clonePose } from '../viewport/navigation';
import { run } from '../editor/editor';

const AXES = [
  { dir: new THREE.Vector3(1, 0, 0), color: '#e8505e', label: 'X', view: 'RIGHT' },
  { dir: new THREE.Vector3(0, 1, 0), color: '#86c440', label: 'Y', view: 'BACK' },
  { dir: new THREE.Vector3(0, 0, 1), color: '#4a8fe8', label: 'Z', view: 'TOP' },
  { dir: new THREE.Vector3(-1, 0, 0), color: '#e8505e', label: '', view: 'LEFT' },
  { dir: new THREE.Vector3(0, -1, 0), color: '#86c440', label: '', view: 'FRONT' },
  { dir: new THREE.Vector3(0, 0, -1), color: '#4a8fe8', label: '', view: 'BOTTOM' },
] as const;

/** Axis orientation widget: shows the view orientation; click an axis to align, drag to orbit. */
export function NavGizmo({ engine }: { engine: ViewportEngine }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const hits = useRef<{ x: number; y: number; view: string }[]>([]);
  useEffect(() => {
    const draw = () => {
      const c = ref.current;
      if (!c) return;
      const size = 90;
      c.width = size * devicePixelRatio;
      c.height = size * devicePixelRatio;
      const g = c.getContext('2d');
      if (!g) return;
      g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      g.clearRect(0, 0, size, size);
      // the view of the frame drawn (on the way to engine.pose while an animated view change runs)
      const { right, up, back } = poseBasis(engine.shownPose);
      const cx = size / 2;
      const cy = size / 2;
      const r = 32;
      const pts = AXES.map((a) => ({
        a,
        x: cx + a.dir.dot(right) * r,
        y: cy - a.dir.dot(up) * r,
        z: a.dir.dot(back),
      })).sort((p, q) => p.z - q.z);
      g.lineWidth = 2;
      for (const p of pts) {
        if (p.a.label) {
          g.strokeStyle = p.a.color;
          g.beginPath();
          g.moveTo(cx, cy);
          g.lineTo(p.x, p.y);
          g.stroke();
        }
      }
      hits.current = [];
      for (const p of pts) {
        g.beginPath();
        g.arc(p.x, p.y, p.a.label ? 8 : 6, 0, Math.PI * 2);
        g.fillStyle = p.a.label ? p.a.color : `${p.a.color}66`;
        g.fill();
        if (!p.a.label) {
          g.strokeStyle = p.a.color;
          g.lineWidth = 1.5;
          g.stroke();
        }
        if (p.a.label) {
          g.fillStyle = '#111';
          g.font = 'bold 10px system-ui';
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText(p.a.label, p.x, p.y + 0.5);
        }
        hits.current.push({ x: p.x, y: p.y, view: p.a.view });
      }
    };
    engine.onAfterRender.add(draw);
    draw();
    return () => engine.onAfterRender.delete(draw);
  }, [engine]);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  return (
    <canvas
      ref={ref}
      class="nav-gizmo"
      data-testid="nav-gizmo"
      style={{ width: '90px', height: '90px' }}
      onPointerDown={(e) => {
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 3) return;
        d.moved = true;
        d.x = e.clientX;
        d.y = e.clientY;
        const p = clonePose(engine.pose);
        p.yaw -= dx * 0.01;
        p.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, p.pitch + dy * 0.01));
        p.ortho = false;
        engine.setPose(p);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d || d.moved) return;
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        const hit = [...hits.current].reverse().find((h) => Math.hypot(h.x - x, h.y - y) < 10);
        if (hit) run('view3d.view_axis', { type: hit.view }, 'ui');
      }}
    />
  );
}
