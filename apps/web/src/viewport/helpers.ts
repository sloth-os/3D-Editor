import * as THREE from 'three';
import type { CameraData, EmptyDisplayType, LightData } from '@3d-editor/core';
import { cameraFovY, orthoHalfExtents } from '@3d-editor/core';

/** Line-segment geometry builders for non-mesh objects (empties, lights, cameras). */

function circle(out: number[], r: number, axis: 'X' | 'Y' | 'Z', segments = 32, center: [number, number, number] = [0, 0, 0]): void {
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const p = (a: number): [number, number, number] => {
      const c = Math.cos(a) * r;
      const s = Math.sin(a) * r;
      if (axis === 'Z') return [center[0] + c, center[1] + s, center[2]];
      if (axis === 'Y') return [center[0] + c, center[1], center[2] + s];
      return [center[0], center[1] + c, center[2] + s];
    };
    out.push(...p(a0), ...p(a1));
  }
}

export function emptyLines(type: EmptyDisplayType, size: number): number[] {
  const s = size;
  const out: number[] = [];
  switch (type) {
    case 'ARROWS': {
      const head = s * 0.08;
      out.push(0, 0, 0, s, 0, 0, s, 0, 0, s - head, head, 0, s, 0, 0, s - head, -head, 0);
      out.push(0, 0, 0, 0, s, 0, 0, s, 0, head, s - head, 0, 0, s, 0, -head, s - head, 0);
      out.push(0, 0, 0, 0, 0, s, 0, 0, s, head, 0, s - head, 0, 0, s, -head, 0, s - head);
      break;
    }
    case 'SINGLE_ARROW': {
      const head = s * 0.08;
      out.push(0, 0, 0, 0, 0, s, 0, 0, s, head, 0, s - head, 0, 0, s, -head, 0, s - head);
      break;
    }
    case 'CUBE': {
      const c = [-s, s];
      for (const a of c)
        for (const b of c) {
          out.push(-s, a, b, s, a, b);
          out.push(a, -s, b, a, s, b);
          out.push(a, b, -s, a, b, s);
        }
      break;
    }
    case 'SPHERE':
      circle(out, s, 'X');
      circle(out, s, 'Y');
      circle(out, s, 'Z');
      break;
    case 'CIRCLE':
      circle(out, s, 'Z');
      break;
    case 'CONE': {
      circle(out, s, 'Z', 24);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        out.push(Math.cos(a) * s, Math.sin(a) * s, 0, 0, 0, s * 2);
      }
      break;
    }
    case 'PLAIN_AXES':
    default:
      out.push(-s, 0, 0, s, 0, 0, 0, -s, 0, 0, s, 0, 0, 0, -s, 0, 0, s);
  }
  return out;
}

export function lightLines(l: LightData): number[] {
  const out: number[] = [];
  const r = 0.1;
  switch (l.type) {
    case 'SUN': {
      circle(out, r, 'Z', 16);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        out.push(Math.cos(a) * r * 1.6, Math.sin(a) * r * 1.6, 0, Math.cos(a) * r * 2.6, Math.sin(a) * r * 2.6, 0);
      }
      out.push(0, 0, 0, 0, 0, -1.5);
      break;
    }
    case 'SPOT': {
      circle(out, r, 'Z', 16);
      const len = 1.5;
      const rad = Math.tan(l.spot_size / 2) * len;
      circle(out, rad, 'Z', 32, [0, 0, -len]);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        out.push(0, 0, 0, Math.cos(a) * rad, Math.sin(a) * rad, -len);
      }
      break;
    }
    case 'AREA': {
      const w = l.size / 2;
      const h = (l.shape === 'RECTANGLE' || l.shape === 'ELLIPSE' ? l.size_y : l.size) / 2;
      if (l.shape === 'DISK' || l.shape === 'ELLIPSE') {
        const seg = 32;
        for (let i = 0; i < seg; i++) {
          const a0 = (i / seg) * Math.PI * 2;
          const a1 = ((i + 1) / seg) * Math.PI * 2;
          out.push(Math.cos(a0) * w, Math.sin(a0) * h, 0, Math.cos(a1) * w, Math.sin(a1) * h, 0);
        }
      } else out.push(-w, -h, 0, w, -h, 0, w, -h, 0, w, h, 0, w, h, 0, -w, h, 0, -w, h, 0, -w, -h, 0);
      out.push(0, 0, 0, 0, 0, -0.8);
      break;
    }
    case 'POINT':
    default:
      circle(out, r, 'Z', 16);
      circle(out, r * 1.8, 'Z', 24);
  }
  return out;
}

export function cameraLines(c: CameraData, aspect: number, size = 1): number[] {
  const out: number[] = [];
  let hw: number;
  let hh: number;
  const d = size;
  const apex: [number, number, number] = [0, 0, 0];
  if (c.type === 'ORTHO') {
    const e = orthoHalfExtents(c, aspect);
    hw = e.halfW;
    hh = e.halfH;
    out.push(-hw, -hh, 0, -hw, -hh, -d, hw, -hh, 0, hw, -hh, -d, hw, hh, 0, hw, hh, -d, -hw, hh, 0, -hw, hh, -d);
  } else {
    const fov = cameraFovY(c, aspect);
    hh = Math.tan(fov / 2) * d;
    hw = hh * aspect;
    for (const [x, y] of [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ])
      out.push(...apex, x, y, -d);
  }
  const sx = c.shift_x * 2 * Math.max(hw, hh);
  const sy = c.shift_y * 2 * Math.max(hw, hh);
  out.push(-hw + sx, -hh + sy, -d, hw + sx, -hh + sy, -d, hw + sx, -hh + sy, -d, hw + sx, hh + sy, -d);
  out.push(hw + sx, hh + sy, -d, -hw + sx, hh + sy, -d, -hw + sx, hh + sy, -d, -hw + sx, -hh + sy, -d);
  // "up" triangle
  const t = hh * 0.25;
  out.push(-hw * 0.4 + sx, hh * 1.1 + sy, -d, hw * 0.4 + sx, hh * 1.1 + sy, -d);
  out.push(hw * 0.4 + sx, hh * 1.1 + sy, -d, sx, hh * 1.1 + t * 2 + sy, -d);
  out.push(sx, hh * 1.1 + t * 2 + sy, -d, -hw * 0.4 + sx, hh * 1.1 + sy, -d);
  return out;
}

export function linesObject(positions: number[], color: THREE.ColorRepresentation): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const m = new THREE.LineBasicMaterial({ color, depthTest: true, transparent: true, opacity: 0.95 });
  const l = new THREE.LineSegments(g, m);
  return l;
}
