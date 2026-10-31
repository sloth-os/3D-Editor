import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DEFAULT_POSE, axisViewAngles, poseBasis, posePosition, poseToPresence, presenceToPose, viewLabel, lerpPose, applyPoseToCamera } from '../src/viewport/navigation';

describe('viewport navigation', () => {
  it('front/right/top views look along the expected axes (Z up)', () => {
    const p = DEFAULT_POSE();
    p.target.set(0, 0, 0);
    p.distance = 10;
    Object.assign(p, axisViewAngles('FRONT'));
    expect(posePosition(p).toArray().map((v) => Math.round(v) + 0)).toEqual([0, -10, 0]);
    Object.assign(p, axisViewAngles('RIGHT'));
    expect(posePosition(p).toArray().map((v) => Math.round(v) + 0)).toEqual([10, 0, 0]);
    Object.assign(p, axisViewAngles('TOP'));
    expect(posePosition(p).toArray().map((v) => Math.round(v) + 0)).toEqual([0, 0, 10]);
    // basis stays orthonormal at the pole
    const b = poseBasis(p);
    expect(Math.abs(b.right.dot(b.up))).toBeLessThan(1e-9);
    expect(b.up.y).toBeCloseTo(1);
  });

  it('labels views like Blender', () => {
    const p = DEFAULT_POSE();
    expect(viewLabel(p)).toBe('User Perspective');
    Object.assign(p, axisViewAngles('TOP'), { ortho: true });
    expect(viewLabel(p)).toBe('Top Orthographic');
  });

  it('round-trips through the presence payload (follow mode)', () => {
    const p = DEFAULT_POSE();
    p.target.set(1, 2, 3);
    const q = presenceToPose(poseToPresence(p));
    expect(q.target.distanceTo(p.target)).toBeLessThan(1e-9);
    expect(q.distance).toBeCloseTo(p.distance);
    expect(q.yaw).toBeCloseTo(p.yaw);
    expect(q.pitch).toBeCloseTo(p.pitch);
  });

  it('interpolates poses along the shortest yaw arc', () => {
    const a = DEFAULT_POSE();
    const b = DEFAULT_POSE();
    a.yaw = Math.PI - 0.1;
    b.yaw = -Math.PI + 0.1;
    const m = lerpPose(a, b, 0.5);
    expect(Math.abs(Math.abs(m.yaw) - Math.PI)).toBeLessThan(1e-6);
  });

  it('places the three.js camera looking at the target', () => {
    const p = DEFAULT_POSE();
    const cam = new THREE.PerspectiveCamera();
    applyPoseToCamera(p, cam, 1.5);
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    const toTarget = p.target.clone().sub(cam.position).normalize();
    expect(dir.dot(toTarget)).toBeCloseTo(1, 6);
  });
});
