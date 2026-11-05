#!/usr/bin/env node
/**
 * Lighthouse Cove ("North Point") — an original coastal scene at dusk, built from scratch entirely
 * through the 3D editor's MCP server (the same tools any external AI agent gets).
 *
 *   MCP_URL=http://127.0.0.1:4501/mcp node examples/lighthouse-cove/build.mjs [flags]
 *
 * Flags
 *   --preview      build the scene and write a quick RASTER preview to $TMPDIR/lighthouse-cove-preview
 *                  (no path tracing, no animation, no export; nothing is written next to this file)
 *   --skip-final   skip the final path-traced still (render.png)
 *   --skip-anim    skip the beam animation (contact_sheet.png, preview.gif)
 *   --skip-export  skip the glTF export (scene.glb)
 *   --keep         do not delete an existing project first (fails if it exists)
 *
 * Re-runnable: an existing project named "lighthouse-cove" is deleted and rebuilt from nothing.
 * Every number the scene depends on is in this file; outputs are written next to it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../../scripts/mcp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'lighthouse-cove';
const FLAGS = new Set(process.argv.slice(2));
const PREVIEW = FLAGS.has('--preview');

// ---------------------------------------------------------------------------------------------
// Scene design (metres, Z up, north = +Y)
// ---------------------------------------------------------------------------------------------
const SEA = 0.6; // sea level
const TERRAIN = { size: 64, sub: 128, height: 3.2, noise_scale: 14, seed: 3 };
const LH = [14, 12]; // lighthouse axis (x, y)
const HOUSE = { x: 5, y: -2.6, w: 6.4, d: 4.4 }; // keeper's cottage footprint centre and size
// Island shaping: GRAB strokes (vertical moves with smooth falloff) and FLATTEN pads.
const SCULPT = [
  { brush: 'GRAB', at: [14, 12], dz: 5, r: 10 }, // the headland the lighthouse stands on
  { brush: 'GRAB', at: [-12, 6], dz: 3, r: 12 }, // wooded western hill
  { brush: 'GRAB', at: [2, -11], dz: -3, r: 7 }, // the cove ...
  { brush: 'GRAB', at: [2, -17], dz: -2, r: 7 }, // ... and its mouth
  { brush: 'FLATTEN', at: [HOUSE.x, HOUSE.y], r: 5, dabs: 8 }, // cottage pad
  { brush: 'FLATTEN', at: LH, r: 3.5, dabs: 8 }, // lighthouse pad
];
// The stone path: waypoints from the cove beach past the cottage door up to the lighthouse door.
const PATH_WAYPOINTS = [
  [3.2, -8.6], [4.3, -7.0], [5.4, -6.0], [7.6, -6.1], [9.6, -4.6], [10.9, -1.6],
  [11.3, 1.6], [12.0, 4.6], [13.0, 7.2], [13.7, 9.0],
];
const FENCE_RANGE = [3, 9]; // waypoint indices the seaward fence runs along
const SIGN = { at: [1.5, -8.2], turn: -0.25 }; // sign position; it faces the camera, turned by `turn`
const COVE = { at: [2, -12], r: 9 }; // the cove keeps a wider beach
const JETTY = { x: 0, y: -8.7, len: 7.4, w: 1.5 }; // jetty from the cove beach out over the water
// The camera floats over the cove mouth; its Track To target is an empty beside the lighthouse.
const CAMERA = { at: [15.5, -36, 3.3], target: [8, 6, 8.6], lens: 26 };
// A low sun behind the camera's right shoulder warms the lighthouse; the sky ahead is the pink and
// violet twilight side.
const SUN = { elevation: 0.04, rotation: 4.22 };
// Two opposite beams turn half a revolution in FRAMES frames → a seamless loop.
const FRAMES = 24;
const BEAM_PHASE = 1.1; // beam A heading at frame 1 (radians about Z from +Y)

// ---------------------------------------------------------------------------------------------
// MCP helpers
// ---------------------------------------------------------------------------------------------
const mcp = await connect();
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)} s]`, ...a);
let PID = NAME; // project id once created
const timings = {};

async function tool(name, args = {}) {
  try {
    return await mcp.call(name, { project: PID, ...args });
  } catch (e) {
    console.error(`\n✗ ${name} ${JSON.stringify(args).slice(0, 400)}\n  → ${e.message}\n`);
    throw e;
  }
}
/** run_operator; returns the operator result and logs WARNING/ERROR reports. */
async function op(operator, params = {}, selection) {
  const r = await tool('run_operator', { operator, params, ...(selection ? { selection } : {}) });
  for (const rep of r.reports ?? []) {
    const type = rep.type ?? rep.level ?? '';
    if (!/INFO/i.test(type)) log(`  ⚠ ${operator}: ${type} ${rep.message ?? JSON.stringify(rep)}`);
  }
  if (r.result?.warnings?.length) log(`  ⚠ ${operator}: ${r.result.warnings.join('; ')}`);
  return r.result;
}
/** batch of operators as one undo step; throws if any failed. */
async function ops(operations) {
  const out = [];
  for (let i = 0; i < operations.length; i += 200) {
    const r = await tool('batch', { operations: operations.slice(i, i + 200) });
    if (!r.ok || r.failed) {
      const bad = r.results.find((x) => !x.ok);
      throw new Error(`batch failed at ${bad?.operator}: ${JSON.stringify(bad).slice(0, 500)}`);
    }
    out.push(...r.results.map((x) => x.result));
  }
  return out;
}
const add = (type, name, extra = {}) => tool('add_object', { type, name, ...extra });
/**
 * Light datablock fields (spot_size, spot_blend, shadow_soft_size). data.set_property cannot address
 * a light by name and no tool reports light datablock ids, so each value is set through a single
 * keyframe at frame 1 (one key = a constant). See README "Known limitations".
 */
async function setLightData(object, values) {
  for (const [k, v] of Object.entries(values)) await tool('insert_keyframe', { object, property: `data.${k}`, frame: 1, value: v });
}
const material = (object, props) => tool('set_material', { object, ...props });
/** Saves the first image / embedded resource of a result (or downloads its link) to `file`. */
async function saveResult(result, file) {
  const out = path.isAbsolute(file) ? file : path.join(HERE, file);
  const img = result.images?.[0] ?? result.resources?.find((x) => x.blob);
  let bytes;
  if (img) bytes = Buffer.from(img.data ?? img.blob, 'base64');
  else if (result.links?.[0]) bytes = Buffer.from(await (await fetch(result.links[0].uri)).arrayBuffer());
  else throw new Error(`no file in result: ${JSON.stringify(result).slice(0, 300)}`);
  await writeFile(out, bytes);
  log(`  → ${path.relative(process.cwd(), out)} (${(bytes.length / 1e6).toFixed(2)} MB)`);
  return bytes.length;
}

// small maths
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const hash = (i, j) => {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
function distToPolyline(p, pts) {
  let best = Infinity;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[k + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const t = clamp(((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1));
    best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
  }
  return best;
}
/** Catmull-Rom resampling of a 2D polyline at roughly `step` metres. */
function resample(pts, step) {
  const out = [];
  for (let k = 0; k + 1 < pts.length; k++) {
    const p0 = pts[Math.max(0, k - 1)];
    const p1 = pts[k];
    const p2 = pts[k + 1];
    const p3 = pts[Math.min(pts.length - 1, k + 2)];
    const n = Math.max(1, Math.round(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let s = 0; s < n; s++) {
      const t = s / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Reads a mesh back through export_scene (OBJ is Y-up: v x z -y) → Z-up vertices and faces. */
async function readMesh(object) {
  const r = await tool('export_scene', { format: 'obj', objects: [object], apply_modifiers: true });
  const txt = Buffer.from(r.resources[0].blob, 'base64').toString('utf8');
  const V = [];
  const F = [];
  for (const line of txt.split('\n')) {
    if (line.startsWith('v ')) {
      const [, x, y, z] = line.trim().split(/\s+/).map(Number);
      V.push([x, -z, y]);
    } else if (line.startsWith('f ')) {
      F.push(line.trim().split(/\s+/).slice(1).map((s) => parseInt(s, 10) - 1));
    }
  }
  return { V, F };
}

// ---------------------------------------------------------------------------------------------
// 1. Project
// ---------------------------------------------------------------------------------------------
async function createProject() {
  const list = await mcp.call('list_projects', {});
  const projects = Array.isArray(list) ? list : (list.projects ?? []);
  for (const p of projects.filter((x) => x.name === NAME)) {
    if (FLAGS.has('--keep')) throw new Error(`project ${NAME} exists (--keep)`);
    await mcp.call('delete_project', { project: p.id, confirm: true });
    log(`deleted old project ${p.id}`);
  }
  const r = await mcp.call('create_project', { name: NAME, empty: true });
  PID = r.id;
  log(`created project ${NAME} (${PID})  ${r.editor_url}`);
  await tool('set_scene_settings', {
    resolution_x: 1280,
    resolution_y: 720,
    frame_start: 1,
    frame_end: FRAMES,
    fps: 24,
    engine: 'PATHTRACER',
    samples: 128,
    max_bounces: 6,
    use_denoising: true,
    view_transform: 'ACES',
    exposure: -0.2,
  });
}

// ---------------------------------------------------------------------------------------------
// 2. Island terrain: generate, sculpt, read back, zone materials by face
// ---------------------------------------------------------------------------------------------
const N = TERRAIN.sub + 1;
const CELL = TERRAIN.size / TERRAIN.sub;
let ground; // { V, F } of the final island mesh
function heightAt(x, y) {
  const fi = clamp((x + TERRAIN.size / 2) / CELL, 0, TERRAIN.sub - 1e-6);
  const fj = clamp((y + TERRAIN.size / 2) / CELL, 0, TERRAIN.sub - 1e-6);
  const i = Math.floor(fi);
  const j = Math.floor(fj);
  const u = fi - i;
  const v = fj - j;
  const z = (a, b) => ground.V[(j + b) * N + i + a][2];
  return (1 - v) * ((1 - u) * z(0, 0) + u * z(1, 0)) + v * ((1 - u) * z(0, 1) + u * z(1, 1));
}
function maxHeightIn(cx, cy, r) {
  let m = -Infinity;
  for (let a = 0; a < 24; a++)
    for (const s of [0.35, 0.7, 1]) m = Math.max(m, heightAt(cx + Math.cos((a / 24) * 2 * Math.PI) * r * s, cy + Math.sin((a / 24) * 2 * Math.PI) * r * s));
  return Math.max(m, heightAt(cx, cy));
}

async function buildIsland() {
  const r = await op('object.generate_terrain', {
    name: 'Island',
    size: TERRAIN.size,
    subdivisions: TERRAIN.sub,
    height: TERRAIN.height,
    noise_scale: TERRAIN.noise_scale,
    octaves: 5,
    roughness: 0.5,
    noise_type: 'FBM',
    seed: TERRAIN.seed,
    island_falloff: 1,
    zones: true,
    rock_slope: 0.75,
    snow_height: 1,
    location: [0, 0, 0],
  });
  log(`terrain: ${r.vertices} verts, ${r.faces} faces, slots ${r.material_slots.map((s) => s.name).join('/')}`);
  ground = await readMesh('Island');
  for (const s of SCULPT) {
    const z = heightAt(s.at[0], s.at[1]);
    if (s.brush === 'GRAB') {
      await op('sculpt.brush_stroke', { object: 'Island', brush: 'GRAB', points: [[s.at[0], s.at[1], z]], radius: s.r, strength: 1, grab_delta: [0, 0, s.dz] });
    } else {
      const pts = Array.from({ length: s.dabs }, () => [s.at[0], s.at[1], z]);
      await op('sculpt.brush_stroke', { object: 'Island', brush: s.brush, points: pts, radius: s.r, strength: 1 });
    }
    ground = await readMesh('Island');
  }
  // Zones per face: sand just above the waterline (jittered so the edge is not a staircase),
  // rock where the slope is steeper than ~37°, grass elsewhere.
  const sand = [];
  const rock = [];
  const grass = [];
  ground.F.forEach((f, k) => {
    const P = f.map((i) => ground.V[i]);
    const zAvg = P.reduce((s, p) => s + p[2], 0) / P.length;
    const a = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]];
    const b = [P[3][0] - P[1][0], P[3][1] - P[1][1], P[3][2] - P[1][2]];
    const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const nz = Math.abs(n[2]) / Math.hypot(...n);
    const jitter = (hash(k % TERRAIN.sub, Math.floor(k / TERRAIN.sub)) - 0.5) * 0.3;
    const cx = P.reduce((s, p) => s + p[0], 0) / P.length;
    const cy = P.reduce((s, p) => s + p[1], 0) / P.length;
    const beach = SEA + 0.3 + 0.45 * smooth(COVE.r + 3, COVE.r - 2, Math.hypot(cx - COVE.at[0], cy - COVE.at[1]));
    if (zAvg + jitter < beach) sand.push(k);
    else if (nz < 0.8 + jitter * 0.15) rock.push(k);
    else grass.push(k);
  });
  log(`zones: ${grass.length} grass, ${rock.length} rock, ${sand.length} sand faces`);
  // New materials (the generator's "Grass"/"Rock" are shared with generated tufts and rocks).
  await op('material.preset_apply', { preset: 'grass', objects: ['Island'], slot: 0, name: 'Island Grass' });
  await op('material.preset_apply', { preset: 'rock', objects: ['Island'], slot: 1, name: 'Island Rock' });
  await op('material.preset_apply', { preset: 'sand', objects: ['Island'], slot: 2, name: 'Beach Sand' });
  for (const [index, faces] of [[0, grass], [1, rock], [2, sand]]) {
    await tool('edit_mesh', {
      object: 'Island',
      operator: 'object.material_slot_assign',
      params: { index },
      selection: { faces, all: false },
      select_mode: 'FACE',
    });
  }
}

// ---------------------------------------------------------------------------------------------
// 3. Sea
// ---------------------------------------------------------------------------------------------
async function buildSea() {
  await add('plane', 'Sea', { params: { size: 600 }, location: [0, 0, SEA] });
  await op('material.preset_apply', { preset: 'water', objects: ['Sea'], name: 'Sea Water' });
  // The island terrain ends 0.6 m under the surface at its square border; an opaque, dark,
  // glossy sea (reflections only) hides that edge while keeping the preset's ripples.
  await op('material.update', { material: 'Sea Water', transmission: 0, base_color: [0.012, 0.035, 0.045, 1], roughness: 0.03 });
}

// ---------------------------------------------------------------------------------------------
// 4. Lighthouse
// ---------------------------------------------------------------------------------------------
let LZ = 0; // ground height at the lighthouse
async function buildLighthouse() {
  const [x, y] = LH;
  LZ = maxHeightIn(x, y, 2.7);
  const z0 = LZ;
  log(`lighthouse base z = ${z0.toFixed(2)}`);
  const towerH = 11;
  const zt = z0 + 0.4; // top of the plinth
  const zg = zt + towerH; // gallery floor
  await add('cylinder', 'LH Plinth', { params: { vertices: 40, radius: 2.7, depth: 2.2 }, location: [x, y, z0 - 0.7] });
  await add('cone', 'LH Tower', { params: { vertices: 48, radius1: 1.9, radius2: 1.32, depth: towerH }, location: [x, y, zt + towerH / 2] });
  await add('cylinder', 'LH Gallery', { params: { vertices: 48, radius: 2.2, depth: 0.25 }, location: [x, y, zg + 0.125] });
  await add('cylinder', 'LH Lantern Glass', { params: { vertices: 12, radius: 1.2, depth: 1.8 }, location: [x, y, zg + 0.25 + 0.9] });
  await add('cylinder', 'LH Lantern Frame', { params: { vertices: 12, radius: 1.23, depth: 1.8, end_fill_type: 'NOTHING' }, location: [x, y, zg + 0.25 + 0.9] });
  await add('uv_sphere', 'LH Lamp', { params: { segments: 24, ring_count: 12, radius: 0.36 }, location: [x, y, zg + 1.1] });
  await add('cone', 'LH Roof', { params: { vertices: 48, radius1: 1.55, radius2: 0.12, depth: 1.15 }, location: [x, y, zg + 2.05 + 0.575] });
  await add('uv_sphere', 'LH Vent', { params: { segments: 16, ring_count: 8, radius: 0.2 }, location: [x, y, zg + 3.35] });
  await add('cylinder', 'LH Rod', { params: { vertices: 8, radius: 0.025, depth: 0.9 }, location: [x, y, zg + 3.8] });
  // Door and two small windows facing the path (south-west).
  const face = Math.atan2(PATH_WAYPOINTS.at(-1)[1] - y, PATH_WAYPOINTS.at(-1)[0] - x);
  const rad = (h) => 1.9 - (0.58 * h) / towerH; // tower radius at height h above the plinth
  const onWall = (h, inset) => [x + Math.cos(face) * (rad(h) - inset), y + Math.sin(face) * (rad(h) - inset), zt + h];
  await add('cube', 'LH Door', { params: { size: 1 }, location: onWall(1.0, 0.05), rotation: [0, 0, face + Math.PI / 2], scale: [0.95, 0.3, 2.0] });
  await add('cube', 'LH Window 1', { params: { size: 1 }, location: onWall(4.6, 0.05), rotation: [0, 0, face + Math.PI / 2], scale: [0.45, 0.3, 0.7] });
  await add('cube', 'LH Window 2', { params: { size: 1 }, location: onWall(8.0, 0.05), rotation: [0, 0, face + Math.PI / 2], scale: [0.4, 0.3, 0.65] });
  // Railing: a closed circular RAIL fence around the gallery.
  const ring = Array.from({ length: 28 }, (_, k) => [Math.cos((k / 28) * 2 * Math.PI) * 2.08, Math.sin((k / 28) * 2 * Math.PI) * 2.08, 0]);
  await op('object.generate_fence', { name: 'LH Railing', points: ring, closed: true, style: 'RAIL', rails: 3, height: 1.0, post_width: 0.05, post_spacing: 0.7, location: [x, y, zg + 0.25] });
  await tool('add_modifier', { object: 'LH Lantern Frame', type: 'WIREFRAME', params: { thickness: 0.07 } });
  await tool('add_modifier', { object: 'LH Tower', type: 'SMOOTH_BY_ANGLE' });
  await tool('add_modifier', { object: 'LH Plinth', type: 'SMOOTH_BY_ANGLE' });

  // Materials
  await op('material.preset_apply', { preset: 'concrete', objects: ['LH Plinth'], name: 'Lighthouse Stone' });
  await material('LH Tower', { name: 'Lighthouse Paint', base_color: [0.86, 0.85, 0.8, 1], roughness: 0.55 });
  // Red bands: a WAVE texture along Z with a hard (CONSTANT) ramp → 3 red / white bands.
  await op('material.procedural_set', {
    material: 'Lighthouse Paint',
    channel: 'base_color',
    procedural: {
      type: 'WAVE',
      mapping: 'OBJECT',
      scale: 0.1,
      color_a: [0.86, 0.85, 0.8],
      color_b: [0.55, 0.025, 0.02],
      ramp_low: 0.5,
      ramp_high: 0.5,
      params: { wave_type: 'BANDS', direction: 'Z', wave_profile: 'SIN', phase: 0, ramp_interpolation: 'CONSTANT' },
    },
  });
  for (const o of ['LH Gallery', 'LH Roof', 'LH Vent']) await material(o, { name: 'Lighthouse Red', base_color: [0.3, 0.02, 0.018, 1], roughness: 0.38, metallic: 0.2 });
  for (const o of ['LH Railing', 'LH Lantern Frame', 'LH Rod']) await material(o, { name: 'Lantern Iron', base_color: [0.025, 0.025, 0.028, 1], roughness: 0.45, metallic: 0.8 });
  await material('LH Lantern Glass', { name: 'Lantern Glass', base_color: [1, 0.97, 0.9, 1], transmission: 1, roughness: 0.04, ior: 1.45 });
  await material('LH Lamp', { name: 'Lamp Glow', base_color: [1, 0.9, 0.7, 1], emission_color: [1, 0.82, 0.52], emission_strength: 45 });
  await material('LH Door', { name: 'Door Green', base_color: [0.02, 0.09, 0.07, 1], roughness: 0.5 });
  for (const o of ['LH Window 1', 'LH Window 2']) await material(o, { name: 'Tower Window', base_color: [0.02, 0.02, 0.02, 1], roughness: 0.2, emission_color: [1, 0.7, 0.35], emission_strength: 1.5 });

  // Lamp light (warm point light inside the lantern) and the two rotating beams.
  await add('light', 'LH Lamp Light', { light_type: 'POINT', location: [x, y, zg + 1.1], params: { energy: 500, color: [1, 0.8, 0.55] } });
  await setLightData('LH Lamp Light', { shadow_soft_size: 0.3 });
  for (const [k, phase] of [['A', BEAM_PHASE], ['B', BEAM_PHASE + Math.PI]]) {
    const beam = `LH Beam ${k}`;
    // A SPOT light points along its local −Z; X = 90° − tilt makes it horizontal and slightly down.
    await add('light', beam, { light_type: 'SPOT', location: [x, y, zg + 1.1], rotation: [Math.PI / 2 - 0.05, 0, phase], params: { energy: 60000, color: [1, 0.88, 0.65] } });
    await setLightData(beam, { spot_size: 0.26, spot_blend: 0.45, shadow_soft_size: 0.25 });
    // Visible shaft: a long open cone (fake volumetric) parented to the spot, glowing and mostly transparent.
    await add('cone', `${beam} Shaft`, { params: { vertices: 24, radius1: 1.8, radius2: 0.16, depth: 30, end_fill_type: 'NOTHING' } });
    await tool('set_parent', { objects: [`${beam} Shaft`], parent: beam });
    await tool('transform_object', { object: `${beam} Shaft`, location: [0, 0, -15.3], rotation: [0, 0, 0] });
    // The rotation is driven by the frame: one revolution every FRAMES frames.
    const d = await op('anim.driver_add', { target_type: 'object', target: beam, path: 'rotation_euler', index: 2, expression: `${phase.toFixed(4)} + (frame - 1) * pi / ${FRAMES}` });
    if (d.drivers?.[0]?.error) throw new Error(`driver error: ${d.drivers[0].error}`);
  }
  await material('LH Beam A Shaft', { name: 'Beam Glow', base_color: [0, 0, 0, 1], emission_color: [1, 0.8, 0.52], emission_strength: 2.2, alpha: 0.1, blend_method: 'BLEND', roughness: 1 });
  // Fade the shaft out with distance from the lamp: a SPHERICAL gradient centred on the narrow end
  // (object space: the 30 m cone spans z = −15 … +15, so offset_z −15 moves its centre to the tip).
  await op('material.procedural_set', {
    material: 'Beam Glow',
    channel: 'alpha',
    procedural: { type: 'GRADIENT', mapping: 'OBJECT', scale: 1 / 31, color_a: [0, 0, 0], color_b: [0.12, 0.12, 0.12], params: { gradient_type: 'SPHERICAL', offset_z: -15, ramp_interpolation: 'EASE' } },
  });
  await material('LH Beam B Shaft', { material: 'Beam Glow' });
}

// ---------------------------------------------------------------------------------------------
// 5. Keeper's cottage
// ---------------------------------------------------------------------------------------------
async function buildCottage() {
  const { x, y, w, d } = HOUSE;
  const z = maxHeightIn(x, y, Math.hypot(w, d) / 2) - 0.08;
  const r = await op('object.generate_building', {
    name: 'Cottage',
    floors: 1,
    width: w,
    depth: d,
    floor_height: 2.8,
    window_cols: 2,
    window_cols_side: 1,
    window_width: 1.0,
    window_height: 1.2,
    sill_height: 0.9,
    door_width: 1.0,
    door_height: 2.05,
    roof: 'GABLE',
    roof_height: 1.9,
    roof_overhang: 0.35,
    location: [x, y, z],
  });
  log(`cottage at z=${z.toFixed(2)}: ${r.faces} faces, slots ${r.material_slots.map((s) => s.name).join('/')}`);
  await add('cube', 'Cottage Foundation', { params: { size: 1 }, location: [x, y, z - 0.55], scale: [w + 0.3, d + 0.3, 1.3] });
  await add('cube', 'Cottage Chimney', { params: { size: 1 }, location: [x + w / 2 - 0.9, y + 0.6, z + 2.8 + 1.5], scale: [0.55, 0.55, 1.6] });
  await material('Cottage', { slot: 0, name: 'Whitewash', base_color: [0.8, 0.78, 0.72, 1], roughness: 0.92 });
  await material('Cottage', { slot: 1, name: 'Warm Window', base_color: [0.05, 0.04, 0.03, 1], roughness: 0.15, emission_color: [1, 0.62, 0.3], emission_strength: 5 });
  await material('Cottage', { slot: 2, name: 'Trim White', base_color: [0.88, 0.88, 0.85, 1], roughness: 0.5 });
  await material('Cottage', { slot: 3, name: 'Slate Roof', base_color: [0.07, 0.075, 0.085, 1], roughness: 0.6 });
  await material('Cottage', { slot: 4, name: 'Door Green', material: 'Door Green' });
  // Presets with procedural textures use OBJECT mapping: apply the cubes' scale first (as the
  // preset warning advises) so the stone and brick patterns keep their real-world size.
  await op('object.transform_apply', { location: false, rotation: false, scale: true }, { objects: ['Cottage Foundation', 'Cottage Chimney'], mode: 'OBJECT' });
  await op('material.preset_apply', { preset: 'rock', objects: ['Cottage Foundation'], name: 'Foundation Stone' });
  await op('material.preset_apply', { preset: 'brick', objects: ['Cottage Chimney'], name: 'Chimney Brick' });
}

// ---------------------------------------------------------------------------------------------
// 6. Stone path (curve with a flat bevel profile, dropped onto the terrain) and fence
// ---------------------------------------------------------------------------------------------
async function raycastHeights(points) {
  const res = await ops(points.map(([x, y]) => ({ operator: 'scene.raycast', params: { origin: [x, y, 60], direction: [0, 0, -1], objects: ['Island'] } })));
  return res.map((r, k) => (r.hit ? r.point[2] : heightAt(points[k][0], points[k][1])));
}
let pathPts = [];
async function buildPath() {
  // Profile: a closed 2D rectangle 1.5 m wide, 0.32 m tall with its top 8 cm above the curve.
  await op('curve.add_from_points', { name: 'Path Profile', type: 'POLY', cyclic: true, dimensions: '2D', points: [[-0.75, -0.24, 0], [0.75, -0.24, 0], [0.75, 0.08, 0], [-0.75, 0.08, 0]], location: [0, 0, -20] });
  const xy = resample(PATH_WAYPOINTS, 1.2);
  const zs = await raycastHeights(xy);
  pathPts = xy.map(([x, y], k) => [x, y, zs[k] + 0.03]);
  await op('curve.add_from_points', {
    name: 'Stone Path',
    type: 'BEZIER',
    points: pathPts,
    location: [0, 0, 0],
    bevel_mode: 'OBJECT',
    bevel_object: 'Path Profile',
    twist_mode: 'Z_UP',
    use_fill_caps: true,
    resolution_u: 6,
  });
  await tool('set_material', { object: 'Stone Path', name: 'Path Stones', base_color: [0.42, 0.4, 0.37, 1], roughness: 0.85 });
  // Flagstones: Voronoi cells (random grey per stone) with dark joints from a distance-to-edge bump.
  await op('material.procedural_set', { material: 'Path Stones', channel: 'base_color', procedural: { type: 'VORONOI', mapping: 'OBJECT', scale: 1.8, color_a: [0.4, 0.38, 0.35], color_b: [0.66, 0.62, 0.56], params: { feature: 'CELL', randomness: 0.9 } } });
  await op('material.procedural_set', { material: 'Path Stones', channel: 'normal', procedural: { type: 'VORONOI', mapping: 'OBJECT', scale: 1.8, color_a: [0, 0, 0], color_b: [1, 1, 1], ramp_low: 0, ramp_high: 0.08, params: { feature: 'DISTANCE_TO_EDGE', randomness: 0.9, bump_distance: 0.03 } } });
  // Hide the bevel profile helper (it is only a shape).
  await op('data.set_property', { kind: 'objects', target: 'Path Profile', values: { hide_viewport: true, hide_render: true } });

  // Fence on the seaward (right-hand) side of the upper path.
  const seg = PATH_WAYPOINTS.slice(FENCE_RANGE[0], FENCE_RANGE[1] + 1);
  const dense = resample(seg, 2.0);
  const side = dense.map((p, k) => {
    const a = dense[Math.max(0, k - 1)];
    const b = dense[Math.min(dense.length - 1, k + 1)];
    const t = [b[0] - a[0], b[1] - a[1]];
    const l = Math.hypot(...t) || 1;
    return [p[0] + (t[1] / l) * 1.05, p[1] - (t[0] / l) * 1.05];
  });
  const fz = await raycastHeights(side);
  await op('object.generate_fence', { name: 'Path Fence', points: side.map(([x, y], k) => [x, y, fz[k] - 0.05]), style: 'RAIL', rails: 2, height: 1.0, post_width: 0.1, post_spacing: 2.0, location: [0, 0, 0] });
  await material('Path Fence', { name: 'Weathered Wood', base_color: [0.32, 0.27, 0.21, 1], roughness: 0.8 });
}

// ---------------------------------------------------------------------------------------------
// 7. "NORTH POINT" sign
// ---------------------------------------------------------------------------------------------
async function buildSign() {
  // Built around an empty at the foot of the sign (local -Y = front), then turned to face the camera.
  const [sx, sy] = SIGN.at;
  const z = (await raycastHeights([[sx, sy]]))[0];
  await add('empty', 'Sign', { location: [sx, sy, z], params: { type: 'PLAIN_AXES' } });
  await add('cube', 'Sign Post L', { params: { size: 1 }, location: [sx - 1.2, sy, z + 0.75], scale: [0.13, 0.13, 2.1] });
  await add('cube', 'Sign Post R', { params: { size: 1 }, location: [sx + 1.2, sy, z + 0.75], scale: [0.13, 0.13, 2.1] });
  await add('cube', 'Sign Board', { params: { size: 1 }, location: [sx, sy - 0.1, z + 1.3], scale: [2.9, 0.07, 0.72] });
  await add('cube', 'Sign Cap', { params: { size: 1 }, location: [sx, sy - 0.1, z + 1.7], scale: [3.05, 0.16, 0.07] });
  const t = await op('object.text_add', { name: 'Sign Text', body: 'NORTH POINT', size: 0.42, extrude: 0.015, align_x: 'CENTER', align_y: 'CENTER', location: [sx, sy - 0.15, z + 1.3], rotation: [Math.PI / 2, 0, 0] });
  log(`sign text ${t.width.toFixed(2)} × ${t.height.toFixed(2)} m`);
  await tool('set_parent', { objects: ['Sign Post L', 'Sign Post R', 'Sign Board', 'Sign Cap', 'Sign Text'], parent: 'Sign' });
  const [cx, cy] = CAMERA.at;
  const facing = Math.atan2(cx - sx, -(cy - sy)) + SIGN.turn; // local −Y towards the camera
  await tool('transform_object', { object: 'Sign', rotation: [0, 0, facing] });
  for (const o of ['Sign Post L', 'Sign Post R', 'Sign Cap']) await material(o, { material: 'Weathered Wood' });
  await material('Sign Board', { name: 'Sign Paint', base_color: [0.015, 0.06, 0.08, 1], roughness: 0.6 });
  await material('Sign Text', { name: 'Letter Cream', base_color: [0.9, 0.84, 0.66, 1], roughness: 0.35 });
}

// ---------------------------------------------------------------------------------------------
// 7b. Jetty and rowing boat in the cove
// ---------------------------------------------------------------------------------------------
async function buildJetty() {
  const { x, y, len, w } = JETTY;
  const deckZ = SEA + 0.62;
  await add('cube', 'Jetty Deck', { params: { size: 1 }, location: [x, y - len / 2, deckZ], scale: [w, len, 0.12] });
  await op('object.transform_apply', { location: false, rotation: false, scale: true }, { objects: ['Jetty Deck'], mode: 'OBJECT' });
  await material('Jetty Deck', { name: 'Jetty Planks', base_color: [0.3, 0.22, 0.15, 1], roughness: 0.75 });
  // Planks across the deck: a BRICK pattern whose rows run along Y and whose bricks are longer than
  // the deck is wide (offset_x keeps the only joint off the deck).
  await op('material.procedural_set', {
    material: 'Jetty Planks',
    channel: 'base_color',
    procedural: { type: 'BRICK', mapping: 'OBJECT', scale: 1, color_a: [0.2, 0.15, 0.1], color_b: [0.4, 0.31, 0.22], params: { plane: 'XY', brick_width: 3, row_height: 0.17, mortar_size: 0.012, offset: 0, offset_x: 1.5, mortar_r: 0.03, mortar_g: 0.024, mortar_b: 0.02 } },
  });
  // A pair of posts at the outer end, repeated towards the shore with array_place.
  const postH = 3.2;
  for (const [n, dx] of [['L', -w / 2 + 0.06], ['R', w / 2 - 0.06]]) {
    await add('cylinder', `Jetty Post ${n}`, { params: { vertices: 10, radius: 0.09, depth: postH }, location: [x + dx, y - len + 0.15, deckZ + 0.3 - postH / 2] });
  }
  const arr = await op('object.array_place', { objects: ['Jetty Post L', 'Jetty Post R'], pattern: 'LINE', count: 4, offset: [0, (len - 0.6) / 3, 0], linked: true });
  const posts = ['Jetty Post L', 'Jetty Post R', ...(arr.created ?? arr.objects ?? []).map((o) => o.name ?? o)];
  for (const pname of posts) await material(pname, { material: 'Weathered Wood' }).catch(() => {});

  // Rowing boat: the lower half of a UV sphere (upper vertices deleted in Edit Mode), scaled into a
  // hull and given thickness with a Solidify modifier; two thwarts as seats.
  const at = [x + 1.6, y - len + 1.3, SEA + 0.2];
  await add('uv_sphere', 'Boat Hull', { params: { segments: 24, ring_count: 12, radius: 1 }, location: at });
  const hull = await readMesh('Boat Hull');
  const upper = hull.V.map((v, i) => (v[2] > at[2] + 1e-3 ? i : -1)).filter((i) => i >= 0);
  await tool('edit_mesh', { object: 'Boat Hull', operator: 'mesh.delete', params: { type: 'VERT' }, selection: { verts: upper, all: false } });
  await tool('transform_object', { object: 'Boat Hull', scale: [1.45, 0.62, 0.42] });
  await op('object.transform_apply', { location: false, rotation: false, scale: true }, { objects: ['Boat Hull'], mode: 'OBJECT' });
  await tool('add_modifier', { object: 'Boat Hull', type: 'SOLIDIFY', params: { thickness: 0.045 } });
  await op('object.shade_smooth', {}, { objects: ['Boat Hull'], mode: 'OBJECT' });
  await material('Boat Hull', { name: 'Boat Paint', base_color: [0.03, 0.17, 0.26, 1], roughness: 0.45 });
  for (const [k, dx] of [[1, -0.45], [2, 0.42]]) {
    await add('cube', `Boat Seat ${k}`, { params: { size: 1 }, location: [at[0] + dx, at[1], at[2] - 0.11], scale: [0.22, 1.08, 0.04] });
    await material(`Boat Seat ${k}`, { material: 'Jetty Planks' });
  }
  await tool('set_parent', { objects: ['Boat Seat 1', 'Boat Seat 2'], parent: 'Boat Hull' });
  await tool('transform_object', { object: 'Boat Hull', rotation: [0.03, -0.02, 1.25] });
}

// ---------------------------------------------------------------------------------------------
// 8. Vegetation and rocks: generated sources + density-weighted scatters
// ---------------------------------------------------------------------------------------------
async function buildVegetation() {
  const far = (k) => [140 + k * 8, 0, 0];
  await op('object.generate_tree', { name: 'Pine A', style: 'CONIFER', height: 6.5, trunk_radius: 0.17, branch_levels: 3, leaf_density: 0.9, leaf_size: 0.6, seed: 4, location: far(0) });
  await op('object.generate_tree', { name: 'Pine B', style: 'CONIFER', height: 4.8, trunk_radius: 0.13, branch_levels: 2, leaf_density: 0.95, leaf_size: 0.5, seed: 9, location: far(1) });
  await op('object.generate_tree', { name: 'Pine C', style: 'CONIFER', height: 8, trunk_radius: 0.21, branch_levels: 4, leaf_density: 0.85, leaf_size: 0.7, seed: 13, location: far(2) });
  await op('object.generate_rock', { name: 'Rock A', size: [1.4, 1.1, 0.8], roughness: 0.6, seed: 2, location: far(3) });
  await op('object.generate_rock', { name: 'Rock B', size: [0.7, 0.6, 0.45], roughness: 0.5, seed: 5, location: far(4) });
  await op('object.generate_rock', { name: 'Rock C', size: [2.4, 1.7, 1.3], roughness: 0.65, facets: 7, seed: 8, location: far(5) });
  await op('object.generate_grass_tuft', { name: 'Tuft A', blades: 18, height: 0.38, spread: 0.1, seed: 1, location: far(6) });
  await op('object.generate_grass_tuft', { name: 'Tuft B', blades: 28, height: 0.55, spread: 0.14, bend: 0.6, seed: 3, location: far(7) });
  await op('object.generate_bush', { name: 'Bush A', height: 0.9, seed: 2, location: far(8) });
  await material('Pine A', { slot: 1, name: 'Pine Needles', base_color: [0.025, 0.07, 0.03, 1], roughness: 0.8 });
  await material('Pine B', { slot: 1, material: 'Pine Needles' });
  await material('Pine C', { slot: 1, material: 'Pine Needles' });
  await material('Tuft A', { name: 'Coastal Grass', base_color: [0.16, 0.2, 0.05, 1], roughness: 0.7 });
  await material('Tuft B', { material: 'Coastal Grass' });

  // Density maps (vertex groups on the island, one weight per vertex).
  const housePad = (p) => Math.max(Math.abs(p[0] - HOUSE.x) - HOUSE.w / 2, Math.abs(p[1] - HOUSE.y) - HOUSE.d / 2, 0);
  const groups = { Trees: [], Rocks: [], Grass: [], Bushes: [] };
  const V = ground.V;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const p = V[j * N + i];
      const z = p[2];
      const zx = V[j * N + Math.min(N - 1, i + 1)][2] - V[j * N + Math.max(0, i - 1)][2];
      const zy = V[Math.min(N - 1, j + 1) * N + i][2] - V[Math.max(0, j - 1) * N + i][2];
      const nz = 1 / Math.hypot(zx / (2 * CELL), zy / (2 * CELL), 1);
      const dPath = distToPolyline(p, PATH_WAYPOINTS);
      const dHouse = housePad(p);
      const dLH = Math.hypot(p[0] - LH[0], p[1] - LH[1]);
      const dSign = Math.hypot(p[0] - SIGN.at[0], p[1] - SIGN.at[1]);
      const land = smooth(SEA + 0.5, SEA + 1.0, z);
      const clear = smooth(1.1, 1.8, dPath) * smooth(0.6, 1.5, dHouse) * smooth(2.8, 3.6, dLH) * smooth(0.8, 1.5, dSign);
      // trees: the western hill and the northern slopes; keep the cove, the cottage front and the headland open
      const west = smooth(4, -6, p[0]) + smooth(12, 20, p[1]) * smooth(10, 4, p[0]);
      const treeClear = smooth(2.5, 4.5, dPath) * smooth(3, 6, dHouse) * smooth(6, 9, dLH);
      groups.Trees.push(clamp(land * smooth(SEA + 1.2, SEA + 2.4, z) * treeClear * clamp(west) * smooth(0.75, 0.85, nz)));
      // rocks: the shoreline band and steep ground
      const shore = smooth(SEA - 0.4, SEA, z) * smooth(SEA + 1.2, SEA + 0.5, z);
      groups.Rocks.push(clamp((0.55 * shore + smooth(0.86, 0.72, nz) + 0.04) * clear));
      const dune = smooth(SEA + 0.25, SEA + 0.6, z) * smooth(SEA + 1.4, SEA + 0.8, z); // just above the sand
      groups.Grass.push(clamp((0.45 * land + 0.9 * dune) * smooth(0.72, 0.85, nz) * clear * (0.55 + 0.45 * hash(i, j))));
      groups.Bushes.push(clamp(land * clear * smooth(3, 5, dPath) * smooth(1.5, 3, dHouse) * smooth(4, 6, dLH) * smooth(0.8, 0.9, nz) * (1 - 0.6 * clamp(west))));
    }
  for (const [g, w] of Object.entries(groups)) {
    await op('object.vertex_group_set_weights', { object: 'Island', group: g, weights: w.map((v) => Math.round(v * 1000) / 1000) });
  }
  const scatter = async (name, objects, extra) => {
    const r = await op('object.scatter_add', { surface: 'Island', objects, name, ...extra });
    log(`scatter ${name}: ${r.particles} particles, ${r.instances} instances${r.errors?.length ? ' ⚠ ' + r.errors.join('; ') : ''}`);
  };
  await scatter('Pines', ['Pine A', 'Pine B', 'Pine C'], { count: 40, seed: 11, min_distance: 2.6, size: 1, size_random: 0.35, align_to_normal: false, vertex_group: 'Trees' });
  await scatter('Rocks', ['Rock A', 'Rock B', 'Rock C'], { count: 110, seed: 5, min_distance: 1.3, size: 1, size_random: 0.65, rotation_random: 0.25, align_to_normal: true, vertex_group: 'Rocks' });
  await scatter('Grass Tufts', ['Tuft A', 'Tuft B'], { count: 2600, seed: 3, min_distance: 0.32, size: 1, size_random: 0.5, align_to_normal: true, vertex_group: 'Grass' });
  await scatter('Bushes', ['Bush A'], { count: 30, seed: 7, min_distance: 2.2, size: 1, size_random: 0.45, align_to_normal: false, vertex_group: 'Bushes' });
}

// ---------------------------------------------------------------------------------------------
// 9. Sky, mist, camera
// ---------------------------------------------------------------------------------------------
async function buildWorldAndCamera() {
  const sky = await op('world.sky_set', {
    preset: 'SUNSET',
    sun_elevation: SUN.elevation,
    sun_rotation: SUN.rotation,
    sun_intensity: 4,
    sun_size: 0.02,
    zenith_color: [0.05, 0.1, 0.38],
    horizon_color: [1.0, 0.5, 0.55],
    ground_color: [0.08, 0.06, 0.06],
  });
  log(`sky: sun dir ${sky.sun_direction.map((v) => v.toFixed(2))}, irradiance ${sky.sun_irradiance.map((v) => v.toFixed(2))}`);
  await op('world.mist_set', { distance: 800, color: [0.6, 0.45, 0.5] });
  // A few distant cumulus clouds catch the last pink light (the low sun is behind the camera).
  const view = [CAMERA.target[0] - CAMERA.at[0], CAMERA.target[1] - CAMERA.at[1]];
  const vl = Math.hypot(...view);
  const fwd = [view[0] / vl, view[1] / vl];
  const right = [fwd[1], -fwd[0]];
  const clouds = [
    { d: 430, side: 120, z: 40, size: [190, 80, 20], seed: 3 },
    { d: 520, side: -170, z: 52, size: [260, 90, 24], seed: 8 },
    { d: 380, side: -20, z: 66, size: [120, 50, 14], seed: 12 },
    { d: 560, side: 300, z: 30, size: [220, 80, 16], seed: 21 },
  ];
  for (const [k, c] of clouds.entries()) {
    const at = [CAMERA.at[0] + fwd[0] * c.d + right[0] * c.side, CAMERA.at[1] + fwd[1] * c.d + right[1] * c.side, c.z];
    await op('object.generate_cloud', { name: `Cloud ${k + 1}`, size: c.size, puffs: 18, smoothness: 0.25, resolution: 48, seed: c.seed, location: at, rotation: [0, 0, Math.atan2(fwd[1], fwd[0]) + Math.PI / 2] });
  }
  for (let k = 1; k <= clouds.length; k++) await material(`Cloud ${k}`, { name: 'Cloud Pink', base_color: [0.95, 0.76, 0.78, 1], roughness: 1 });
  await add('empty', 'Camera Target', { location: CAMERA.target, params: { type: 'SPHERE' } });
  await add('camera', 'Camera', { location: CAMERA.at, params: { lens: CAMERA.lens } });
  const c = await op('object.constraint_add', { object: 'Camera', type: 'TRACK_TO', target: 'Camera Target', params: { track_axis: 'TRACK_NEGATIVE_Z', up_axis: 'UP_Y' } });
  if (c.errors?.length) log(`  ⚠ camera constraint: ${c.errors.join('; ')}`);
  await tool('set_active_camera', { camera: 'Camera' });
}

// ---------------------------------------------------------------------------------------------
// 10. Checks and outputs
// ---------------------------------------------------------------------------------------------
async function check() {
  const s = await tool('get_scene', { max_objects: 5 });
  log(`scene: ${JSON.stringify(s.counts ?? {}).slice(0, 400)}`);
  if (s.problems?.length) log(`  ⚠ problems: ${JSON.stringify(s.problems).slice(0, 800)}`);
  // The beams are driven by the frame: read the driven headings back at a few frames.
  for (const frame of [1, 7, 13]) {
    const d = await op('anim.driver_list', { frame });
    log(`  drivers @${frame}: ${d.drivers.map((x) => `${x.target_name}.${x.path}[${x.index}] = ${x.value.toFixed(3)}${x.error ? ' ⚠ ' + x.error : ''}`).join(', ')}`);
  }
  const cam = await tool('get_object', { object: 'Camera' });
  const errs = (cam.constraints ?? []).flatMap((c) => c.errors ?? []);
  log(`  camera constraints: ${(cam.constraints ?? []).map((c) => `${c.type} → ${(c.targets ?? []).join(', ')}`).join(', ')}${errs.length ? ' ⚠ ' + errs.join('; ') : ' (no errors)'}`);
}

const stats = {};
async function renders() {
  if (PREVIEW) {
    const dir = path.join(os.tmpdir(), 'lighthouse-cove-preview');
    await mkdir(dir, { recursive: true });
    const prev = await tool('render_image', { width: 640, height: 360, engine: 'RASTER' });
    await saveResult(prev, path.join(dir, 'preview_raster.png'));
    return;
  }
  if (!FLAGS.has('--skip-final')) {
    const t = Date.now();
    const r = await tool('render_image', { width: 1280, height: 720, engine: 'PATHTRACER', samples: 128, max_bounces: 4, denoise: true, time_limit: 300, frame: 1 });
    stats.final = { seconds: (Date.now() - t) / 1000, samples: r.text?.samples, requested: r.text?.requested_samples, threads: r.text?.threads };
    log(`final still: ${JSON.stringify(stats.final)}`);
    await saveResult(r, 'render.png');
  }
  if (!FLAGS.has('--skip-anim')) {
    // Low-sample path tracing for both animation outputs (the raster engine draws the alpha-blended
    // beam shafts with a stipple pattern).
    const anim = { frame_start: 1, frame_end: FRAMES, engine: 'PATHTRACER', samples: 6, max_bounces: 3, denoise: true };
    let t = Date.now();
    const cs = await tool('render_animation', { ...anim, format: 'CONTACT_SHEET', width: 240, height: 135, columns: 6, time_limit: 240 });
    stats.contact_sheet = { seconds: (Date.now() - t) / 1000, frames: cs.text?.frame_count, truncated: cs.text?.truncated ?? false };
    log(`contact sheet: ${JSON.stringify(stats.contact_sheet)}`);
    await saveResult(cs, 'contact_sheet.png');
    t = Date.now();
    const gif = await tool('render_animation', { ...anim, format: 'GIF', width: 480, height: 270, fps: 10, dither: 'BAYER', time_limit: 300 });
    stats.gif = { seconds: (Date.now() - t) / 1000, frames: gif.text?.frame_count, truncated: gif.text?.truncated ?? false };
    log(`gif: ${JSON.stringify(stats.gif)}`);
    stats.gif.bytes = await saveResult(gif, 'preview.gif');
  }
  if (!FLAGS.has('--skip-export')) {
    const t = Date.now();
    const ex = await tool('export_scene', { format: 'glb' });
    stats.export = { seconds: (Date.now() - t) / 1000 };
    stats.export.bytes = await saveResult(ex, 'scene.glb');
    if (stats.export.bytes > 6e6) log('  ⚠ scene.glb is larger than 6 MB');
  }
}

// ---------------------------------------------------------------------------------------------
try {
  const stages = [
    ['project', createProject],
    ['island', buildIsland],
    ['sea', buildSea],
    ['lighthouse', buildLighthouse],
    ['cottage', buildCottage],
    ['path', buildPath],
    ['sign', buildSign],
    ['jetty', buildJetty],
    ['vegetation', buildVegetation],
    ['world+camera', buildWorldAndCamera],
    ['check', check],
    ['renders', renders],
  ];
  for (const [name, fn] of stages) {
    const t = Date.now();
    log(`── ${name}`);
    await fn();
    timings[`stage_${name}_s`] = (Date.now() - t) / 1000;
  }
  timings.total_s = (Date.now() - T0) / 1000;
  log(`done in ${timings.total_s.toFixed(1)} s`, JSON.stringify({ ...timings, renders: stats }));
} finally {
  await mcp.close();
}
