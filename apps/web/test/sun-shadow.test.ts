import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  DEPTH_BIAS_TEXELS,
  fitSunShadow,
  NORMAL_BIAS_TEXELS,
  SHADOW_DISTANCE_SCALE,
  SUN_SHADOW_MAP_SIZE,
  type SunShadowFit,
} from '../src/viewport/sun-shadow';

/*
 * Shadow maps of suns fitted to what the render camera sees (sun-shadow.ts), checked geometrically:
 * the test environment has no WebGL.
 */

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

/** A sun shining along `direction` (from the sun into the scene), like the engine's sun lamps. */
function sun(direction: [number, number, number], at: [number, number, number] = [0, 0, 10]) {
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.castShadow = true;
  light.shadow.mapSize.set(SUN_SHADOW_MAP_SIZE, SUN_SHADOW_MAP_SIZE);
  light.shadow.radius = 3;
  light.position.set(...at);
  light.target.position.set(at[0] + direction[0], at[1] + direction[1], at[2] + direction[2]);
  const scene = new THREE.Scene();
  scene.add(light, light.target);
  return light;
}

/** A perspective camera at `eye` looking at `target` (Z up), 16:9. */
function camera(eye: [number, number, number], target: [number, number, number], fovY = 23, far = 1000) {
  const c = new THREE.PerspectiveCamera(fovY, 16 / 9, 0.1, far);
  c.position.set(...eye);
  c.lookAt(new THREE.Vector3(...target));
  c.updateMatrixWorld(true);
  c.updateProjectionMatrix();
  return c;
}

const box = (min: [number, number, number], max: [number, number, number]) =>
  new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));

/** Whether a world point is inside the sun's fitted shadow frustum (footprint and depth range). */
function inMap(light: THREE.DirectionalLight, p: THREE.Vector3): boolean {
  const c = light.shadow.camera;
  const v = p.clone().applyMatrix4(c.matrixWorldInverse);
  const e = 1e-6;
  return (
    v.x >= c.left - e &&
    v.x <= c.right + e &&
    v.y >= c.bottom - e &&
    v.y <= c.top + e &&
    -v.z >= c.near - e &&
    -v.z <= c.far + e
  );
}

/** Whether the camera sees a world point (inside its view frustum). */
function seen(cam: THREE.Camera, p: THREE.Vector3): boolean {
  const f = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
  );
  return f.containsPoint(p);
}

/** Points on a box (a 5 × 5 × 5 lattice). */
function lattice(b: THREE.Box3): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= 4; i++)
    for (let j = 0; j <= 4; j++)
      for (let k = 0; k <= 4; k++)
        out.push(
          new THREE.Vector3(
            THREE.MathUtils.lerp(b.min.x, b.max.x, i / 4),
            THREE.MathUtils.lerp(b.min.y, b.max.y, j / 4),
            THREE.MathUtils.lerp(b.min.z, b.max.z, k / 4),
          ),
        );
  return out;
}

/** Where the sun casts the shadow of `p` onto the plane z = `floor`. */
function shadowOf(light: THREE.DirectionalLight, p: THREE.Vector3, floor: number): THREE.Vector3 {
  light.updateWorldMatrix(true, true);
  const from = new THREE.Vector3().setFromMatrixPosition(light.matrixWorld);
  const to = new THREE.Vector3().setFromMatrixPosition(light.target.matrixWorld);
  const d = to.sub(from).normalize();
  return p.clone().addScaledVector(d, (floor - p.z) / d.z);
}

/** The default scene of the report: a floor plane at z = −1, the 2 m cube, a pole and a box. */
function reportScene(floorSize: number) {
  const h = floorSize / 2;
  const casters = {
    cube: box([-1, -1, -1], [1, 1, 1]),
    pole: box([2.425, 0.925, -1], [2.575, 1.075, 2]),
    box: box([-2.25, -2.25, -1], [-1.75, -1.75, -0.5]),
  };
  return {
    floor: box([-h, -h, -1], [h, h, -1]),
    casters,
    boxes: [box([-h, -h, -1], [h, h, -1]), ...Object.values(casters)],
  };
}

/** Blender's default camera (location (7.36, −6.93, 4.96) looking at the origin, 50 mm). */
const defaultCamera = () => camera([7.36, -6.93, 4.96], [0, 0, 0], 22.9, 100);
/** The sun of the report: rotation (0.6, 0.35, 0) → its −Z axis. */
function reportSun() {
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.6, 0.35, 0, 'XYZ'));
  const d = new THREE.Vector3(0, 0, -1).applyMatrix4(m);
  return sun([d.x, d.y, d.z], [2, -2, 5]);
}

describe('fitSunShadow', () => {
  it('fits what the camera sees, so a large ground plane does not dilute the map', () => {
    // regression: the map covered the whole scene's bounding sphere; with a 600 m floor a texel was
    // 0.42 m (wider than the 0.15 m pole), so the shadows of the cube, the pole and the box vanished
    const fits: SunShadowFit[] = [];
    for (const size of [12, 600]) {
      const { casters, boxes } = reportScene(size);
      const light = reportSun();
      const cam = defaultCamera();
      const fit = fitSunShadow(light, cam, boxes)!;
      expect(fit).not.toBeNull();
      fits.push(fit);
      // texels of about a centimetre: the 15 cm pole spans many of them
      expect(fit.texel).toBeLessThan(0.02);
      expect(0.15 / fit.texel).toBeGreaterThan(7);
      // every visible point of the casters, and their shadows on the floor where the camera sees
      // them, are in the map
      let checked = 0;
      for (const b of Object.values(casters))
        for (const p of lattice(b)) {
          if (seen(cam, p)) {
            expect(inMap(light, p)).toBe(true);
            checked++;
          }
          const s = shadowOf(light, p, -1);
          if (seen(cam, s) && Math.abs(s.x) <= size / 2 && Math.abs(s.y) <= size / 2) {
            expect(inMap(light, s)).toBe(true);
            checked++;
          }
        }
      expect(checked).toBeGreaterThan(200);
    }
    // the visible part of the floor ends where the camera stops seeing it (~23 m away): the map
    // of the 600 m floor is about the size of the 12 m one's, not 50 times larger
    expect(fits[1].texel / fits[0].texel).toBeLessThan(3);
  });

  it('keeps the biases a couple of texels in world units, whatever the depth range', () => {
    // regression: a fixed depth bias of 0.0005 of the map's depth range was 0.43 m over the 866 m
    // range of a 600 m floor
    for (const size of [12, 600]) {
      const light = reportSun();
      const fit = fitSunShadow(light, defaultCamera(), reportScene(size).boxes)!;
      expect(light.shadow.normalBias).toBeCloseTo(NORMAL_BIAS_TEXELS * fit.texel, 9);
      // three.js adds the bias to the 0..1 depth over near..far
      expect(-light.shadow.bias * (fit.far - fit.near)).toBeCloseTo(DEPTH_BIAS_TEXELS * fit.texel, 9);
      expect(light.shadow.normalBias).toBeLessThan(0.03);
      expect(-light.shadow.bias * (fit.far - fit.near)).toBeLessThan(0.03);
    }
  });

  it('includes casters outside the view whose shadows fall into it', () => {
    // a tower behind the camera; the low sun behind it throws its shadow forward into the view
    const tower = box([-1, -16, -1], [1, -14, 20]);
    const floor = box([-50, -50, -1], [50, 50, -1]);
    const light = sun([0, 1, -0.6], [0, -40, 30]);
    const cam = camera([0, -12, 2], [0, 0, 0]);
    expect(seen(cam, new THREE.Vector3(0, -15, 10))).toBe(false);
    fitSunShadow(light, cam, [floor, tower]);
    // the top of the tower casts its shadow into the view: both are in the map
    const top = new THREE.Vector3(0, -15, 20);
    const s = shadowOf(light, top, -1);
    expect(seen(cam, s)).toBe(true);
    expect(inMap(light, s)).toBe(true);
    expect(inMap(light, top)).toBe(true);
  });

  it('stops at a shadow distance in perspective views, so far scenery does not cost the foreground its resolution', () => {
    // a cove: a 600 m sea, an island 20–60 m from a camera near the water looking at the horizon,
    // and clouds 800–1000 m away
    const sea = box([-300, -300, 0], [300, 300, 0]);
    const island = [
      box([-10, -10, 0], [10, 10, 4]),
      box([2, 2, 0], [4, 4, 22]),
      box([-8, 5, 0], [-6, 7, 6]),
      box([6, -6, 0], [7, -5, 3]),
    ];
    const clouds = [box([-200, 800, 60], [100, 820, 80]), box([150, 950, 50], [400, 1000, 70])];
    const cam = camera([15.5, -36, 3.3], [0, 0, 8.6], 40, 2000);
    const light = sun([-0.5, 0.85, -0.15], [60, -120, 40]);
    const fit = fitSunShadow(light, cam, [sea, ...island, ...clouds])!;
    // SHADOW_DISTANCE_SCALE × the median distance at which the visible objects start
    expect(fit.shadowDistance).toBeGreaterThan(SHADOW_DISTANCE_SCALE * 20);
    expect(fit.shadowDistance).toBeLessThan(SHADOW_DISTANCE_SCALE * 60);
    for (const b of island) for (const p of lattice(b)) if (seen(cam, p)) expect(inMap(light, p)).toBe(true);
    // the clouds are far beyond it: outside the map, which stays fine enough for the island
    for (const b of clouds) expect(inMap(light, b.getCenter(new THREE.Vector3()))).toBe(false);
    expect(fit.texel).toBeLessThan(0.2);
    // about as fine as without the clouds, and far finer than a map reaching them
    const without = fitSunShadow(sun([-0.5, 0.85, -0.15], [60, -120, 40]), cam, [sea, ...island])!;
    expect(fit.texel).toBeLessThan(1.5 * without.texel);
    const reach = new THREE.Box3();
    for (const b of [...island, ...clouds]) reach.union(b);
    expect(fit.texel).toBeLessThan((reach.max.x - reach.min.x) / SUN_SHADOW_MAP_SIZE / 2);
  });

  it('ignores boxes the camera is inside (a room, a sky dome) when it sets the shadow distance', () => {
    const dome = box([-500, -500, -500], [500, 500, 500]);
    const things = [box([-1, -1, 0], [1, 1, 2]), box([3, 0, 0], [4, 1, 1]), box([-4, 2, 0], [-3, 3, 3])];
    const cam = camera([0, -10, 3], [0, 0, 1]);
    const fit = fitSunShadow(sun([0.3, 0.2, -1]), cam, [dome, ...things])!;
    // the things start about 9 m away; the dome at the near plane
    expect(fit.shadowDistance).toBeGreaterThan(SHADOW_DISTANCE_SCALE * 7);
    expect(fit.shadowDistance).toBeLessThan(SHADOW_DISTANCE_SCALE * 12);
  });

  it('has no shadow distance in orthographic views (as wide at every depth)', () => {
    const floor = box([-300, -300, 0], [300, 300, 0]);
    const things = [box([-1, -1, 0], [1, 1, 2]), box([200, 200, 0], [202, 202, 2])];
    const cam = new THREE.OrthographicCamera(-8, 8, 4.5, -4.5, -1000, 1000);
    cam.position.set(0, 0, 50);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    const light = sun([0.2, 0.3, -1]);
    const fit = fitSunShadow(light, cam, [floor, ...things])!;
    expect(fit.shadowDistance).toBe(Infinity);
    // a 16 × 9 m top view: the map covers about that much (plus the height of the things)
    expect(fit.right - fit.left).toBeLessThan(25);
    expect(fit.top - fit.bottom).toBeLessThan(25);
    for (const p of lattice(things[0])) expect(inMap(light, p)).toBe(true);
  });

  it('keeps its size and moves by whole texels while the camera moves a little (no shimmering edges)', () => {
    const { boxes } = reportScene(600);
    const light = reportSun();
    const a = fitSunShadow(light, defaultCamera(), boxes)!;
    const cam = defaultCamera();
    cam.position.x += 0.003;
    cam.updateMatrixWorld(true);
    const b = fitSunShadow(light, cam, boxes)!;
    expect(b.right - b.left).toBeCloseTo(a.right - a.left, 9);
    expect(b.top - b.bottom).toBeCloseTo(a.top - a.bottom, 9);
    const tx = (a.right - a.left) / SUN_SHADOW_MAP_SIZE;
    const shift = (b.left - a.left) / tx;
    expect(Math.abs(shift - Math.round(shift))).toBeLessThan(1e-6);
  });

  it('covers the whole scene when the camera sees none of it, and does nothing without geometry', () => {
    const light = reportSun();
    const cam = camera([0, 0, 50], [0, 0, 100]);
    const { boxes } = reportScene(12);
    const fit = fitSunShadow(light, cam, boxes)!;
    expect(fit).not.toBeNull();
    for (const b of boxes) expect(inMap(light, b.getCenter(new THREE.Vector3()))).toBe(true);
    const before = light.shadow.camera.left;
    expect(fitSunShadow(light, cam, [])).toBeNull();
    expect(fitSunShadow(light, cam, [new THREE.Box3()])).toBeNull();
    expect(light.shadow.camera.left).toBe(before);
  });

  it('fits exactly the corners of boxes wholly in view (their ranges come from centre and half size, without clipping)', () => {
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const corners = (b: THREE.Box3) =>
      [0, 1, 2, 3, 4, 5, 6, 7].map(
        (i) =>
          new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z),
      );
    const cam = camera([0, -40, 10], [0, 0, 2], 40);
    for (let t = 0; t < 20; t++) {
      // a dozen boxes the camera sees whole
      const boxes: THREE.Box3[] = [];
      while (boxes.length < 12) {
        const c = new THREE.Vector3((rnd() - 0.5) * 16, (rnd() - 0.5) * 16, rnd() * 4);
        const h = new THREE.Vector3(0.1 + rnd(), 0.1 + rnd(), 0.1 + 2 * rnd());
        const b = new THREE.Box3(c.clone().sub(h), c.clone().add(h));
        if (corners(b).every((p) => seen(cam, p))) boxes.push(b);
      }
      const light = sun([rnd() - 0.5, rnd() - 0.5, -0.3 - rnd()], [10 * rnd(), 10 * rnd(), 20]);
      const fit = fitSunShadow(light, cam, boxes)!;
      // the shadow distance: 4 × the median view depth at which the boxes start
      const starts = boxes
        .map((b) => Math.min(...corners(b).map((p) => -p.applyMatrix4(cam.matrixWorldInverse).z)))
        .sort((a, b) => a - b);
      expect(fit.shadowDistance).toBeCloseTo(SHADOW_DISTANCE_SCALE * starts[starts.length >> 1], 9);
      // the corners in the shadow camera's view
      const lv = boxes.flatMap(corners).map((p) => p.applyMatrix4(light.shadow.camera.matrixWorldInverse));
      const [x0, x1] = [Math.min(...lv.map((p) => p.x)), Math.max(...lv.map((p) => p.x))];
      const [y0, y1] = [Math.min(...lv.map((p) => p.y)), Math.max(...lv.map((p) => p.y))];
      const [d0, d1] = [Math.min(...lv.map((p) => -p.z)), Math.max(...lv.map((p) => -p.z))];
      // all of them are in the map, which is no larger than they need: their bounds plus the
      // filter's margin (less the half texel the map's centre may move to the texel grid), rounded
      // up to the next eighth of an octave
      const pad = (Math.max(x1 - x0, y1 - y0) * (light.shadow.radius + 2)) / SUN_SHADOW_MAP_SIZE;
      for (const [lo, hi, a, b] of [
        [fit.left, fit.right, x0, x1],
        [fit.bottom, fit.top, y0, y1],
      ]) {
        const halfTexel = (hi - lo) / SUN_SHADOW_MAP_SIZE / 2;
        expect(lo).toBeLessThanOrEqual(a - pad + halfTexel + 1e-9);
        expect(hi).toBeGreaterThanOrEqual(b + pad - halfTexel - 1e-9);
        expect(hi - lo).toBeLessThanOrEqual((b - a + 2 * pad) * 2 ** (1 / 8) + 1e-9);
      }
      // nothing lies between them and the sun: the depth range is theirs plus the margin
      const margin = Math.max(0.05, 0.01 * (d1 - d0));
      expect(fit.near).toBeCloseTo(d0 - margin, 9);
      expect(fit.far).toBeCloseTo(d1 + margin, 9);
    }
  });
});
