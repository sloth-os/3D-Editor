#!/usr/bin/env node
/**
 * Lighthouse Cove ("North Point") — an original coastal scene at dusk, built from nothing entirely
 * through the 3D editor's MCP server (the same tools any external AI agent gets).
 *
 *   MCP_URL=http://127.0.0.1:4501/mcp node examples/lighthouse-cove/build.mjs [mode] [flags]
 *
 * Modes (default: build + checks + final still + beam animation; scene.glb is not touched)
 *   --build-only   build the scene and run the checks, no renders, no export
 *   --preview      build + checks + a RASTER and a small path-traced preview, written to
 *                  $TMPDIR/lighthouse-cove-preview (nothing is written next to this file)
 *   --export-only  build + checks + export scene.glb (no renders)
 * Flags
 *   --skip-final   skip the final path-traced still (render.png)
 *   --skip-anim    skip the beam animation (contact_sheet.png, preview.gif)
 *   --export       also export scene.glb after the renders
 *   --out <dir>    write the outputs to <dir> instead of this folder
 *   --keep         fail instead of deleting an existing "lighthouse-cove" project
 *
 * Re-runnable: an existing project named "lighthouse-cove" is deleted and rebuilt from nothing.
 * Every number the scene depends on is in this file. Any tool error (including an operator
 * warning about ignored input) stops the build with the failing call.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../../scripts/mcp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'lighthouse-cove';
const ARGS = process.argv.slice(2);
const FLAGS = new Set(ARGS.filter((a) => a.startsWith('--')));
const OUT_DIR = ARGS.includes('--out') ? path.resolve(ARGS[ARGS.indexOf('--out') + 1]) : HERE;
const MODE = FLAGS.has('--build-only') ? 'build' : FLAGS.has('--preview') ? 'preview' : FLAGS.has('--export-only') ? 'export' : 'final';
for (const f of FLAGS) {
  if (!['--build-only', '--preview', '--export-only', '--skip-final', '--skip-anim', '--export', '--out', '--keep'].includes(f)) {
    throw new Error(`unknown flag ${f}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Scene design (metres, Z up, north = +Y)
// ---------------------------------------------------------------------------------------------
const SEA = 0.6; // sea level (the island terrain meets z = 0 at its border, 0.6 m under water)
const TERRAIN = { size: 64, sub: 128, height: 3.2, noise_scale: 14, seed: 3 };
const LH = [14, 12]; // lighthouse axis (x, y) on the north-eastern headland
const HOUSE = { x: 5, y: -2.6, w: 6.4, d: 4.4 }; // keeper's cottage footprint (front door faces -Y)
// Island shaping: GRAB strokes (vertical moves with a smooth falloff) and FLATTEN dabs that
// even out the building pads (the buildings also sit on foundations that reach into the ground).
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
const PATH_TILT_SIGN = 1; // curve tilt that raises the profile's left side (+x of the bevel frame)
const SIGN = { at: [1.5, -8.2], turn: -0.25 }; // sign position; it faces the camera, turned by `turn`
const COVE = { at: [2, -12], r: 9 }; // the cove keeps a wider beach
const JETTY = { x: 0, y: -8.7, len: 7.4, w: 1.5 }; // jetty from the cove beach out over the water
// The camera floats over the cove mouth; its Track To target is an empty beside the lighthouse.
const CAMERA = { at: [15.5, -36, 3.3], target: [8, 6, 8.6], lens: 26 };
// A low sun behind the camera's right shoulder warms the lighthouse; the sky ahead is the pink and
// violet twilight side, where the beams show best.
const SUN = { elevation: 0.04, rotation: 4.22 };
// Light mist: 95 % at 800 m, so the island (30–60 m away) stays clear while the far sea and the
// clouds (700–1000 m) fade into the lavender twilight haze.
const MIST = { distance: 800, color: [0.6, 0.45, 0.5] };
// Two opposite beams turn half a revolution in FRAMES frames → a seamless loop of the pair.
const FRAMES = 24;
// Beam A heading at frame 1 (radians about Z, counter-clockwise from +Y, like the sun azimuth).
// Chosen so that neither beam points at the sun in the still (a shaft would shade the gallery).
const BEAM_PHASE = 1.43;
const BEAM_TILT = 0.035; // beams dip slightly below the horizontal
const SHAFT = { start: 1.3, length: 30 }; // visible shaft: from just outside the lantern glass
// Scattered vegetation and rocks (object.scatter_add on the island, density from vertex groups).
const SCATTERS = [
  { name: 'Pines', objects: ['Pine A', 'Pine B', 'Pine C'], vertex_group: 'Trees', count: 40, seed: 11, min_distance: 2.6, size_random: 0.35, align_to_normal: false },
  { name: 'Rocks', objects: ['Rock A', 'Rock B', 'Rock C'], vertex_group: 'Rocks', count: 100, seed: 5, min_distance: 1.3, size_random: 0.65, rotation_random: 0.25, align_to_normal: true },
  { name: 'Grass Tufts', objects: ['Tuft A', 'Tuft B'], vertex_group: 'Grass', count: 2600, seed: 3, min_distance: 0.32, size_random: 0.5, align_to_normal: true },
  { name: 'Bushes', objects: ['Bush A'], vertex_group: 'Bushes', count: 30, seed: 7, min_distance: 2.2, size_random: 0.45, align_to_normal: false },
];

// ---------------------------------------------------------------------------------------------
// MCP helpers
// ---------------------------------------------------------------------------------------------
const mcp = await connect();
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)} s]`, ...a);
let PID = NAME; // project id once created
const timings = {};

/** Calls an MCP tool on the project; any tool error is printed with its arguments and rethrown. */
async function tool(name, args = {}) {
  try {
    return await mcp.call(name, { project: PID, ...args });
  } catch (e) {
    console.error(`\n✗ ${name} ${JSON.stringify(args).slice(0, 400)}\n  → ${e.message}\n`);
    throw e;
  }
}
/** Fails on WARNING/ERROR reports: they mean that some input was ignored. */
function checkReports(where, reports = []) {
  const bad = reports.filter((r) => !/INFO/i.test(r.level ?? r.type ?? ''));
  if (bad.length) throw new Error(`${where}: ${bad.map((r) => `${r.level ?? r.type} ${r.message}`).join('; ')}`);
}
/** run_operator; returns the operator result. `allow` = regexp of tolerated warning messages. */
async function op(operator, params = {}, { selection, allow } = {}) {
  const r = await tool('run_operator', { operator, params, ...(selection ? { selection } : {}) });
  checkReports(operator, (r.reports ?? []).filter((x) => !(allow && allow.test(x.message ?? ''))));
  return r.result;
}
/** Runs operators as batches (one undo step per 200); throws if any failed or warned. */
async function ops(operations) {
  const out = [];
  for (let i = 0; i < operations.length; i += 200) {
    const r = await tool('batch', { operations: operations.slice(i, i + 200) });
    if (!r.ok || r.failed) {
      const bad = r.results.find((x) => !x.ok);
      throw new Error(`batch failed at ${bad?.operator}: ${JSON.stringify(bad).slice(0, 500)}`);
    }
    for (const x of r.results) checkReports(`batch ${x.operator}`, x.reports);
    out.push(...r.results.map((x) => x.result));
  }
  return out;
}
const add = (type, name, extra = {}) => tool('add_object', { type, name, ...extra });
const material = (object, props) => tool('set_material', { object, ...props });
/** Reads a whole mesh with get_mesh_data (paged): vertices (Z up), faces and any extra fields. */
async function getMesh(object, include = ['vertices', 'faces'], extra = {}) {
  const out = {};
  let next = { vertex_offset: 0, face_offset: 0 };
  for (;;) {
    const r = await tool('get_mesh_data', { object, include, limit: 20000, ...extra, ...next });
    for (const k of include) if (Array.isArray(r[k])) (out[k] ??= []).push(...r[k]);
    if (!r.truncated) return out;
    next = r.next;
  }
}
/** Saves the first image / embedded resource of a result (or downloads its link) to `file`. */
async function saveResult(result, file) {
  const out = path.isAbsolute(file) ? file : path.join(OUT_DIR, file);
  const img = result.images?.[0] ?? result.resources?.find((x) => x.blob);
  let bytes;
  if (img) bytes = Buffer.from(img.data ?? img.blob, 'base64');
  else if (result.links?.[0]) bytes = Buffer.from(await (await fetch(result.links[0].uri)).arrayBuffer());
  else throw new Error(`no file in result: ${JSON.stringify(result).slice(0, 300)}`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, bytes);
  log(`  → ${out} (${(bytes.length / 1e6).toFixed(2)} MB)`);
  return bytes.length;
}

// small maths
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const hash = (i, j) => {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
/** Smooth 2D value noise in -1..1 (and a 3-octave sum of it). */
function vnoise(x, y, seed = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smooth(0, 1, x - xi);
  const v = smooth(0, 1, y - yi);
  const h = (i, j) => hash(i + seed * 101.3, j - seed * 57.7) * 2 - 1;
  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const c = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y, seed) => (vnoise(x, y, seed) + 0.5 * vnoise(2.03 * x, 2.03 * y, seed + 1) + 0.25 * vnoise(4.1 * x, 4.1 * y, seed + 2)) / 1.75;
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
  log(`created project ${NAME} (${PID})  ${r.editor_url ?? ''}`);
  await tool('set_scene_settings', {
    resolution_x: 1280,
    resolution_y: 720,
    frame_start: 1,
    frame_end: FRAMES,
    fps: 24,
    engine: 'PATHTRACER',
    samples: 128,
    max_bounces: 8, // the beam shafts are index-matched glass walls: each one is a transmission bounce
    use_denoising: true,
    view_transform: 'ACES',
    exposure: 0,
  });
}

// ---------------------------------------------------------------------------------------------
// 2. Island terrain: generate, sculpt, read back, then ground colours (vertex colours) and
//    ground materials (face slots)
// ---------------------------------------------------------------------------------------------
const N = TERRAIN.sub + 1;
const CELL = TERRAIN.size / TERRAIN.sub;
let ground; // { vertices, faces } of the final island mesh (object space = world space)
let dryBeach; // per face: 1 = beach sand above the waterline (no rocks or grass are scattered there)
let nearBeach; // per vertex: 1 = corner of a dry beach face
/** Index of the island grid face under (x, y). */
const faceAt = (x, y) => {
  const i = Math.floor(clamp((x + TERRAIN.size / 2) / CELL, 0, TERRAIN.sub - 1e-6));
  const j = Math.floor(clamp((y + TERRAIN.size / 2) / CELL, 0, TERRAIN.sub - 1e-6));
  return j * TERRAIN.sub + i;
};
function heightAt(x, y) {
  const fi = clamp((x + TERRAIN.size / 2) / CELL, 0, TERRAIN.sub - 1e-6);
  const fj = clamp((y + TERRAIN.size / 2) / CELL, 0, TERRAIN.sub - 1e-6);
  const i = Math.floor(fi);
  const j = Math.floor(fj);
  const u = fi - i;
  const v = fj - j;
  const z = (a, b) => ground.vertices[(j + b) * N + i + a][2];
  return (1 - v) * ((1 - u) * z(0, 0) + u * z(1, 0)) + v * ((1 - u) * z(0, 1) + u * z(1, 1));
}
function maxHeightIn(cx, cy, r) {
  let m = -Infinity;
  for (let a = 0; a < 24; a++)
    for (const s of [0.35, 0.7, 1]) m = Math.max(m, heightAt(cx + Math.cos((a / 24) * 2 * Math.PI) * r * s, cy + Math.sin((a / 24) * 2 * Math.PI) * r * s));
  return Math.max(m, heightAt(cx, cy));
}
/** Up component of the grid normal at vertex (i, j) (1 = flat, 0 = vertical). */
function normalZ(i, j) {
  const V = ground.vertices;
  const zx = V[j * N + Math.min(N - 1, i + 1)][2] - V[j * N + Math.max(0, i - 1)][2];
  const zy = V[Math.min(N - 1, j + 1) * N + i][2] - V[Math.max(0, j - 1) * N + i][2];
  return 1 / Math.hypot(zx / (2 * CELL), zy / (2 * CELL), 1);
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
    zones: false, // our own zones below
    materials: false,
    location: [0, 0, 0],
  });
  log(`terrain: ${r.vertices} verts, ${r.faces} faces`);
  ground = await getMesh('Island');
  for (const s of SCULPT) {
    const z = heightAt(s.at[0], s.at[1]);
    if (s.brush === 'GRAB') {
      await op('sculpt.brush_stroke', { object: 'Island', brush: 'GRAB', points: [[s.at[0], s.at[1], z]], radius: s.r, strength: 1, grab_delta: [0, 0, s.dz] });
    } else {
      const pts = Array.from({ length: s.dabs }, () => [s.at[0], s.at[1], z]);
      await op('sculpt.brush_stroke', { object: 'Island', brush: s.brush, points: pts, radius: s.r, strength: 1 });
    }
    ground = await getMesh('Island');
  }
  const hm = await tool('get_mesh_data', { object: 'Island', include: ['heightmap'], heightmap_resolution: 16 });
  log(`island heights ${hm.heightmap.z_range.map((v) => v.toFixed(2)).join(' … ')} m`);

  // ---- ground zones per vertex: sand above the waterline (wider in the cove), rock on steep
  // slopes, lush/dry grass elsewhere, worn earth along the path and around the buildings.
  // Boundaries are perturbed by smooth noise so they look natural, not like contour lines.
  const COL = {
    lush: [0.055, 0.115, 0.03],
    dry: [0.2, 0.185, 0.075],
    earth: [0.16, 0.12, 0.08],
    rock: [0.25, 0.24, 0.225],
    sand: [0.62, 0.5, 0.33],
    wet: [0.32, 0.25, 0.17],
  };
  const housePad = (p) => Math.max(Math.abs(p[0] - HOUSE.x) - HOUSE.w / 2, Math.abs(p[1] - HOUSE.y) - HOUSE.d / 2, 0);
  const W = []; // per vertex {sand, rock, h}
  const colors = [];
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const p = ground.vertices[j * N + i];
      const h = p[2] - SEA;
      const n1 = fbm(p[0] / 6, p[1] / 6, 1);
      const n2 = fbm(p[0] / 9, p[1] / 9, 7);
      const cove = smooth(COVE.r + 3, COVE.r - 2, Math.hypot(p[0] - COVE.at[0], p[1] - COVE.at[1]));
      const beachTop = 0.3 + 0.45 * cove + 0.16 * n1;
      const nz = normalZ(i, j);
      const rock = smooth(0.82, 0.7, nz + 0.05 * n2);
      const sand = (1 - smooth(beachTop - 0.12, beachTop + 0.12, h)) * (1 - rock);
      const dryness = clamp(0.45 + 0.7 * n2 + 0.5 * smooth(beachTop + 0.7, beachTop + 0.15, h) + 0.25 * smooth(4, 7, h));
      const worn = clamp(0.7 * smooth(1.7, 0.85, distToPolyline(p, PATH_WAYPOINTS)) + 0.75 * smooth(1.3, 0.35, housePad(p)) + 0.6 * smooth(3.6, 2.8, Math.hypot(p[0] - LH[0], p[1] - LH[1])));
      let c = mix(COL.lush, COL.dry, dryness);
      c = mix(c, COL.earth, worn * 0.8);
      c = mix(c, mix(COL.rock, [0.3, 0.28, 0.25], 0.5 + 0.5 * n1), rock);
      c = mix(c, mix(COL.sand, COL.wet, smooth(0.15, 0.0, h)), sand);
      W.push({ sand, rock, h });
      colors.push(c);
    }
  // Paint them: one small dab per vertex (radius below the 0.5 m grid spacing, strength 1), with
  // the colours quantised so that every colour is one paint.vertex_color_stroke call.
  const groups = new Map();
  colors.forEach((c, k) => {
    const q = c.map((x) => Math.round(Math.pow(x, 1 / 2.2) * 40) / 40);
    const key = q.join(',');
    if (!groups.has(key)) groups.set(key, { color: [...q.map((x) => Math.pow(x, 2.2)), 1], points: [] });
    groups.get(key).points.push(ground.vertices[k]);
  });
  const t = Date.now();
  await ops([
    { operator: 'paint.vertex_color_set', params: { object: 'Island', color: [1, 1, 1, 1] } },
    ...[...groups.values()].map((g) => ({ operator: 'paint.vertex_color_stroke', params: { object: 'Island', points: g.points, radius: 0.3 * CELL, strength: 1, color: g.color } })),
  ]);
  log(`vertex colours: ${colors.length} vertices in ${groups.size} colours (${((Date.now() - t) / 1000).toFixed(1)} s)`);

  // ---- materials: the presets give texture, bump and roughness; their colours are made neutral
  // (light greys) so the vertex colours above set the hue. Slot per face from its corners.
  await op('material.preset_apply', { preset: 'grass', objects: ['Island'], slot: 0, name: 'Island Ground' });
  await op('material.preset_apply', { preset: 'rock', objects: ['Island'], slot: 1, name: 'Island Rock' });
  await op('material.preset_apply', { preset: 'sand', objects: ['Island'], slot: 2, name: 'Beach Sand' });
  for (const [m, lo] of [['Island Ground', 0.62], ['Island Rock', 0.55], ['Beach Sand', 0.8]]) {
    await op('material.procedural_set', { material: m, channel: 'base_color', procedural: { color_a: [lo, lo, lo], color_b: [1, 1, 1] } });
  }
  const slots = [[], [], []];
  ground.faces.forEach((f, k) => {
    const sand = f.reduce((s, v) => s + W[v].sand, 0) / f.length;
    const rock = f.reduce((s, v) => s + W[v].rock, 0) / f.length;
    slots[sand > 0.5 ? 2 : rock > 0.5 ? 1 : 0].push(k);
  });
  log(`ground slots: ${slots[0].length} ground, ${slots[1].length} rock, ${slots[2].length} sand faces`);
  // The dry beach: sand faces with a corner above the waterline. Their corners get no scatter
  // density, so no rock or grass tuft can land on them (rocks still stand in the shallows).
  dryBeach = new Uint8Array(ground.faces.length);
  nearBeach = new Uint8Array(ground.vertices.length);
  for (const k of slots[2]) {
    if (ground.faces[k].some((v) => W[v].h > 0)) {
      dryBeach[k] = 1;
      for (const v of ground.faces[k]) nearBeach[v] = 1;
    }
  }
  log(`dry beach: ${dryBeach.reduce((s, x) => s + x, 0)} faces`);
  for (const [index, faces] of slots.entries()) {
    if (index === 0) continue; // faces start in slot 0
    await tool('edit_mesh', { object: 'Island', operator: 'object.material_slot_assign', params: { index }, selection: { faces, all: false }, select_mode: 'FACE' });
  }
}

// ---------------------------------------------------------------------------------------------
// 3. Sea
// ---------------------------------------------------------------------------------------------
async function buildSea() {
  await add('plane', 'Sea', { params: { size: 600 }, location: [0, 0, SEA] });
  await op('material.preset_apply', { preset: 'water', objects: ['Sea'], name: 'Sea Water' });
  // The island terrain ends 0.6 m under the surface at its square border, and the path tracer
  // does not light the sea bed through refracting water (glass blocks shadow rays, as in Cycles).
  // So the sea is opaque and glossy (reflections only; the preset keeps its ripples), with a
  // lighter teal over the shallows around the island (a SPHERICAL gradient in object space).
  await op('material.update', { material: 'Sea Water', transmission: 0, base_color: [0.012, 0.035, 0.045, 1], roughness: 0.03 });
  await op('material.procedural_set', {
    material: 'Sea Water',
    channel: 'base_color',
    procedural: { type: 'GRADIENT', mapping: 'OBJECT', scale: 1 / 46, color_a: [0.01, 0.03, 0.04], color_b: [0.035, 0.11, 0.1], ramp_low: 0.1, ramp_high: 0.55, params: { gradient_type: 'SPHERICAL', offset_x: -3, offset_y: -2, ramp_interpolation: 'EASE' } },
  });
}

// ---------------------------------------------------------------------------------------------
// 4. Lighthouse
// ---------------------------------------------------------------------------------------------
let LZ = 0; // ground height at the lighthouse
let ZG = 0; // gallery floor
async function buildLighthouse() {
  const [x, y] = LH;
  LZ = maxHeightIn(x, y, 2.7);
  const z0 = LZ;
  const towerH = 11;
  const zt = z0 + 0.4; // top of the plinth
  const zg = zt + towerH; // gallery floor
  ZG = zg;
  log(`lighthouse base z = ${z0.toFixed(2)}, lamp at z = ${(zg + 1.1).toFixed(2)}`);
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
  // Lantern glass: alpha-blended (not refracting) so that the lamp light inside reaches the gallery,
  // the railing and the roof (refracting glass blocks shadow rays in the path tracer, as in Cycles).
  await material('LH Lantern Glass', { name: 'Lantern Glass', base_color: [1, 0.95, 0.85, 1], roughness: 0.05, alpha: 0.2, blend_method: 'BLEND', emission_color: [1, 0.78, 0.5], emission_strength: 0.6 });
  await material('LH Lamp', { name: 'Lamp Glow', base_color: [1, 0.9, 0.7, 1], emission_color: [1, 0.82, 0.52], emission_strength: 45 });
  await material('LH Door', { name: 'Door Green', base_color: [0.02, 0.09, 0.07, 1], roughness: 0.5 });
  for (const o of ['LH Window 1', 'LH Window 2']) await material(o, { name: 'Tower Window', base_color: [0.02, 0.02, 0.02, 1], roughness: 0.2, emission_color: [1, 0.7, 0.35], emission_strength: 1.5 });

  // Lamp light: a warm point light inside the lantern.
  await add('light', 'LH Lamp Light', { light_type: 'POINT', location: [x, y, zg + 1.1], params: { energy: 600, color: [1, 0.8, 0.55], shadow_soft_size: 0.3 } });
  // The rotating beams: two opposite SPOT lights whose heading is driven by the frame.
  for (const [k, phase] of [['A', BEAM_PHASE], ['B', BEAM_PHASE + Math.PI]]) {
    const beam = `LH Beam ${k}`;
    // A spot shines down its local −Z; rotation X = 90° − tilt turns it horizontal (towards +Y,
    // slightly down), Z = heading.
    await add('light', beam, {
      light_type: 'SPOT',
      location: [x, y, zg + 1.1],
      rotation: [Math.PI / 2 - BEAM_TILT, 0, phase],
      params: { energy: 60000, color: [1, 0.88, 0.65], spot_size: 0.26, spot_blend: 0.45, shadow_soft_size: 0.1 },
    });
    // Visible shaft (the path tracer has no volumes): two nested open cones parented to the spot,
    // made of index-matched glass (transmission 1, IOR 1: light passes straight through) that
    // glows. The glow is added to what is behind without stochastic alpha, so the shafts are
    // noise-free at any sample count; a SPHERICAL gradient on the emission fades them out.
    for (const [layer, r1, r2] of [['Outer', 1.7, 0.2], ['Core', 0.75, 0.1]]) {
      const shaft = `${beam} Shaft ${layer}`;
      await add('cone', shaft, { params: { vertices: 32, radius1: r1, radius2: r2, depth: SHAFT.length, end_fill_type: 'NOTHING' } });
      await tool('set_parent', { objects: [shaft], parent: beam });
      // cone axis = spot −Z; its narrow end (+Z of the cone) SHAFT.start in front of the lamp
      await tool('transform_object', { object: shaft, location: [0, 0, -(SHAFT.start + SHAFT.length / 2)], rotation: [0, 0, 0] });
    }
    const d = await op('anim.driver_add', { target_type: 'object', target: beam, path: 'rotation_euler', index: 2, expression: `${phase.toFixed(4)} + (frame - 1) * pi / ${FRAMES}` });
    if (d.drivers?.[0]?.error) throw new Error(`driver error: ${d.drivers[0].error}`);
  }
  for (const [layer, strength] of [['Outer', 0.32], ['Core', 0.42]]) {
    const m = `Beam Glow ${layer}`;
    await material(`LH Beam A Shaft ${layer}`, { name: m, base_color: [1, 1, 1, 1], transmission: 1, ior: 1, roughness: 0, emission_color: [1, 0.8, 0.52], emission_strength: strength });
    // Emission fades with the distance from the narrow end (object space: the cone spans
    // z = −L/2 … +L/2, so offset_z = −L/2 centres the sphere on the narrow end).
    await op('material.procedural_set', {
      material: m,
      channel: 'emission',
      procedural: { type: 'GRADIENT', mapping: 'OBJECT', scale: 1 / (SHAFT.length + 1), color_a: [0, 0, 0], color_b: [1, 0.8, 0.52], params: { gradient_type: 'QUADRATIC_SPHERE', offset_z: -SHAFT.length / 2, ramp_interpolation: 'LINEAR' } },
    });
    await material(`LH Beam B Shaft ${layer}`, { material: m });
  }
}

// ---------------------------------------------------------------------------------------------
// 5. Keeper's cottage (generated building), window light, porch lamp
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
  await op('object.transform_apply', { location: false, rotation: false, scale: true }, { selection: { objects: ['Cottage Foundation', 'Cottage Chimney'], mode: 'OBJECT' } });
  await op('material.preset_apply', { preset: 'rock', objects: ['Cottage Foundation'], name: 'Foundation Stone' });
  await op('material.preset_apply', { preset: 'brick', objects: ['Cottage Chimney'], name: 'Chimney Brick' });

  // Lamplight from the windows: a RECTANGLE area light (the size of the pane) just in front of
  // each window glass, facing out, so the windows throw warm light onto the ground.
  const md = await tool('get_mesh_data', { object: 'Cottage', include: ['face_materials', 'face_centers', 'face_normals'], space: 'WORLD', limit: 20000 });
  const panes = md.face_materials.map((m, i) => (m === 1 ? i : -1)).filter((i) => i >= 0);
  const lights = [];
  for (const [k, i] of panes.entries()) {
    const [cx, cy, cz] = md.face_centers[i];
    const [nx, ny] = md.face_normals[i];
    lights.push({
      operator: 'object.light_add',
      params: {
        name: `Cottage Window Light ${k + 1}`,
        type: 'AREA',
        shape: 'RECTANGLE',
        size: 0.85,
        size_y: 1.05,
        energy: 80,
        color: [1, 0.68, 0.38],
        location: [cx + nx * 0.03, cy + ny * 0.03, cz],
        // Rx(90°) turns the light's −Z to +Y; Rz(ψ) turns +Y to the outward normal (−sin ψ, cos ψ)
        rotation: [Math.PI / 2, 0, Math.atan2(-nx, ny)],
      },
    });
  }
  await ops(lights);
  log(`cottage: ${panes.length} window area lights`);
  // Porch lamp beside the door (the door is centred on the −Y facade).
  const lamp = [x + 0.85, y - d / 2 - 0.16, z + 2.25];
  await add('cube', 'Porch Lamp', { params: { size: 0.16 }, location: lamp });
  await material('Porch Lamp', { name: 'Porch Lamp Glow', base_color: [1, 0.9, 0.7, 1], emission_color: [1, 0.72, 0.42], emission_strength: 25 });
  await add('light', 'Porch Light', { light_type: 'POINT', location: [lamp[0], lamp[1] - 0.15, lamp[2] - 0.05], params: { energy: 60, color: [1, 0.72, 0.42], shadow_soft_size: 0.08 } });
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
  // Profile: a closed 2D rectangle 1.5 m wide and 0.53 m deep with its top 8 cm above the curve
  // (the deep sides stay buried where the ground falls away).
  await op('curve.add_from_points', { name: 'Path Profile', type: 'POLY', cyclic: true, dimensions: '2D', points: [[-0.75, -0.45, 0], [0.75, -0.45, 0], [0.75, 0.08, 0], [-0.75, 0.08, 0]], location: [0, 0, -20] });
  // Drop the path onto the ground: every resampled point gets its height from a downward ray cast
  // at its centre and a tilt (banking) from ray casts 0.7 m to its left and right, so the flat
  // profile follows the cross-slope.
  const xy = resample(PATH_WAYPOINTS, 0.8);
  const leftOf = xy.map((p, k) => {
    const a = xy[Math.max(0, k - 1)];
    const b = xy[Math.min(xy.length - 1, k + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l]; // left of the direction of travel
  });
  const zs = await raycastHeights(xy.flatMap((p, k) => [p, [p[0] + leftOf[k][0] * 0.7, p[1] + leftOf[k][1] * 0.7], [p[0] - leftOf[k][0] * 0.7, p[1] - leftOf[k][1] * 0.7]]));
  pathPts = xy.map(([x, y], k) => {
    const [zc, zl, zr] = zs.slice(3 * k, 3 * k + 3);
    return { co: [x, y, Math.max(zc, (zl + zr) / 2) + 0.03], tilt: PATH_TILT_SIGN * Math.atan2(zl - zr, 1.4) };
  });
  await op('curve.add_from_points', {
    name: 'Stone Path',
    type: 'BEZIER',
    points: pathPts,
    location: [0, 0, 0],
    bevel_mode: 'OBJECT',
    bevel_object: 'Path Profile',
    twist_mode: 'Z_UP',
    use_fill_caps: true,
    resolution_u: 4,
  });
  await material('Stone Path', { name: 'Path Stones', base_color: [0.42, 0.4, 0.37, 1], roughness: 0.85 });
  // Flagstones: Voronoi cells (random grey per stone) with dark joints from a distance-to-edge bump.
  await op('material.procedural_set', { material: 'Path Stones', channel: 'base_color', procedural: { type: 'VORONOI', mapping: 'OBJECT', scale: 1.8, color_a: [0.4, 0.38, 0.35], color_b: [0.66, 0.62, 0.56], params: { feature: 'CELL', randomness: 0.9 } } });
  await op('material.procedural_set', { material: 'Path Stones', channel: 'normal', procedural: { type: 'VORONOI', mapping: 'OBJECT', scale: 1.8, color_a: [0, 0, 0], color_b: [1, 1, 1], ramp_low: 0, ramp_high: 0.08, params: { feature: 'DISTANCE_TO_EDGE', randomness: 0.9, bump_distance: 0.03 } } });
  // Hide the bevel profile helper (it is only a shape).
  await op('data.set_property', { kind: 'objects', target: 'Path Profile', values: { hide_viewport: true, hide_render: true } });

  // Fence on the seaward (right-hand) side of the upper path, each post on the ground.
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
// 7. "NORTH POINT" sign: a wooden board on two posts with extruded 3D letters
// ---------------------------------------------------------------------------------------------
async function buildSign() {
  // Built around an empty at the foot of the sign (local −Y = front), then turned to face the camera.
  const [sx, sy] = SIGN.at;
  const z = (await raycastHeights([[sx, sy]]))[0];
  await add('empty', 'Sign', { location: [sx, sy, z], params: { type: 'PLAIN_AXES' } });
  await add('cube', 'Sign Post L', { params: { size: 1 }, location: [sx - 1.2, sy, z + 0.75], scale: [0.13, 0.13, 2.1] });
  await add('cube', 'Sign Post R', { params: { size: 1 }, location: [sx + 1.2, sy, z + 0.75], scale: [0.13, 0.13, 2.1] });
  await add('cube', 'Sign Board', { params: { size: 1 }, location: [sx, sy - 0.1, z + 1.3], scale: [2.9, 0.07, 0.72] });
  await add('cube', 'Sign Cap', { params: { size: 1 }, location: [sx, sy - 0.1, z + 1.7], scale: [3.05, 0.16, 0.07] });
  const t = await op('object.text_add', { name: 'Sign Text', body: 'NORTH POINT', size: 0.42, extrude: 0.015, align_x: 'CENTER', align_y: 'CENTER', location: [sx, sy - 0.15, z + 1.3], rotation: [Math.PI / 2, 0, 0] });
  log(`sign text ${t.width.toFixed(2)} × ${t.height.toFixed(2)} m`);
  // Wood grain: apply the board's scale (OBJECT mapping is in unscaled object space), then a
  // distorted WAVE texture whose bands run horizontally along the board.
  await op('object.transform_apply', { location: false, rotation: false, scale: true }, { selection: { objects: ['Sign Board'], mode: 'OBJECT' } });
  await material('Sign Board', { name: 'Sign Planks', base_color: [0.3, 0.19, 0.11, 1], roughness: 0.7 });
  await op('material.procedural_set', {
    material: 'Sign Planks',
    channel: 'base_color',
    procedural: { type: 'WAVE', mapping: 'OBJECT', scale: 4, distortion: 3, detail: 3, color_a: [0.12, 0.07, 0.04], color_b: [0.34, 0.22, 0.13], params: { wave_type: 'BANDS', direction: 'Z', wave_profile: 'SAW', detail_scale: 0.6 } },
  });
  await tool('set_parent', { objects: ['Sign Post L', 'Sign Post R', 'Sign Board', 'Sign Cap', 'Sign Text'], parent: 'Sign' });
  const [cx, cy] = CAMERA.at;
  const facing = Math.atan2(cx - sx, -(cy - sy)) + SIGN.turn; // local −Y towards the camera
  await tool('transform_object', { object: 'Sign', rotation: [0, 0, facing] });
  for (const o of ['Sign Post L', 'Sign Post R', 'Sign Cap']) await material(o, { material: 'Weathered Wood' });
  await material('Sign Text', { name: 'Letter Cream', base_color: [0.9, 0.84, 0.66, 1], roughness: 0.35 });
}

// ---------------------------------------------------------------------------------------------
// 7b. Jetty and rowing boat in the cove
// ---------------------------------------------------------------------------------------------
async function buildJetty() {
  const { x, y, len, w } = JETTY;
  const deckZ = SEA + 0.62;
  await add('cube', 'Jetty Deck', { params: { size: 1 }, location: [x, y - len / 2, deckZ], scale: [w, len, 0.12] });
  await op('object.transform_apply', { location: false, rotation: false, scale: true }, { selection: { objects: ['Jetty Deck'], mode: 'OBJECT' } });
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
  for (const pname of new Set(posts)) await material(pname, { material: 'Weathered Wood' });

  // Rowing boat: the lower half of a UV sphere (upper vertices deleted in Edit Mode), scaled into a
  // hull and given thickness with a Solidify modifier; two thwarts as seats.
  const at = [x + 1.6, y - len + 1.3, SEA + 0.2];
  await add('uv_sphere', 'Boat Hull', { params: { segments: 24, ring_count: 12, radius: 1 }, location: at });
  const hull = await getMesh('Boat Hull', ['vertices']);
  const upper = hull.vertices.map((v, i) => (v[2] > 1e-3 ? i : -1)).filter((i) => i >= 0); // object space
  await tool('edit_mesh', { object: 'Boat Hull', operator: 'mesh.delete', params: { type: 'VERT' }, selection: { verts: upper, all: false } });
  await tool('transform_object', { object: 'Boat Hull', scale: [1.45, 0.62, 0.42] });
  await op('object.transform_apply', { location: false, rotation: false, scale: true }, { selection: { objects: ['Boat Hull'], mode: 'OBJECT' } });
  await tool('add_modifier', { object: 'Boat Hull', type: 'SOLIDIFY', params: { thickness: 0.045 } });
  await op('object.shade_smooth', {}, { selection: { objects: ['Boat Hull'], mode: 'OBJECT' } });
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
  await material('Bush A', { slot: 1, name: 'Bush Leaves', base_color: [0.035, 0.085, 0.03, 1], roughness: 0.8 });

  // Density maps (vertex groups on the island, one weight per vertex).
  const housePad = (p) => Math.max(Math.abs(p[0] - HOUSE.x) - HOUSE.w / 2, Math.abs(p[1] - HOUSE.y) - HOUSE.d / 2, 0);
  const groups = { Trees: [], Rocks: [], Grass: [], Bushes: [] };
  const V = ground.vertices;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const p = V[j * N + i];
      const z = p[2];
      const nz = normalZ(i, j);
      const dPath = distToPolyline(p, PATH_WAYPOINTS);
      const dHouse = housePad(p);
      const dLH = Math.hypot(p[0] - LH[0], p[1] - LH[1]);
      const dSign = Math.hypot(p[0] - SIGN.at[0], p[1] - SIGN.at[1]);
      const land = smooth(SEA + 0.5, SEA + 1.0, z);
      const offBeach = 1 - nearBeach[j * N + i]; // nothing on the dry beach
      const clear = smooth(1.1, 1.8, dPath) * smooth(0.6, 1.5, dHouse) * smooth(2.8, 3.6, dLH) * smooth(0.8, 1.5, dSign) * offBeach;
      // trees: the western hill and the northern slopes; keep the cove, the cottage front and the headland open
      const west = smooth(4, -6, p[0]) + smooth(12, 20, p[1]) * smooth(10, 4, p[0]);
      const treeClear = smooth(2.5, 4.5, dPath) * smooth(3, 6, dHouse) * smooth(6, 9, dLH);
      groups.Trees.push(clamp(land * smooth(SEA + 1.2, SEA + 2.4, z) * treeClear * clamp(west) * smooth(0.75, 0.85, nz) * offBeach));
      // rocks: the shoreline band (standing in the shallows, not on the dry beach) and steep ground
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
    if (r.errors?.length) throw new Error(`scatter ${name}: ${r.errors.join('; ')}`);
    log(`scatter ${name}: ${r.particles} particles, ${r.instances} instances`);
  };
  for (const { name, objects, ...settings } of SCATTERS) await scatter(name, objects, { size: 1, ...settings });
}

// ---------------------------------------------------------------------------------------------
// 9. Sky, mist, clouds, camera
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
  await op('world.mist_set', { distance: MIST.distance, color: MIST.color });
  // Thin cloud streaks low over the horizon and one high wisp, catching the last pink light. Each is
  // generated small (marching cubes need a sensible aspect ratio) and stretched by its object scale.
  const view = [CAMERA.target[0] - CAMERA.at[0], CAMERA.target[1] - CAMERA.at[1]];
  const vl = Math.hypot(...view);
  const fwd = [view[0] / vl, view[1] / vl];
  const right = [fwd[1], -fwd[0]];
  const clouds = [
    { d: 900, side: -420, z: 60, size: [60, 24, 8], scale: [9, 4, 1], seed: 21, yaw: 0 },
    { d: 1000, side: -60, z: 42, size: [60, 24, 8], scale: [10, 4, 0.8], seed: 5, yaw: 0 },
    { d: 900, side: 430, z: 50, size: [60, 24, 8], scale: [8, 4, 1.1], seed: 8, yaw: -0.1 },
    { d: 800, side: 230, z: 100, size: [50, 20, 8], scale: [7, 3.5, 1.1], seed: 12, yaw: 0.2 },
    { d: 700, side: -330, z: 250, size: [60, 24, 8], scale: [7, 3, 0.9], seed: 3, yaw: 0.15 },
  ];
  for (const [k, c] of clouds.entries()) {
    const at = [CAMERA.at[0] + fwd[0] * c.d + right[0] * c.side, CAMERA.at[1] + fwd[1] * c.d + right[1] * c.side, c.z];
    await op('object.generate_cloud', { name: `Cloud ${k + 1}`, size: c.size, puffs: 20, smoothness: 0.3, resolution: 64, seed: c.seed, location: at, scale: c.scale, rotation: [0, 0, Math.atan2(fwd[1], fwd[0]) + Math.PI / 2 + c.yaw] });
  }
  // At 700–1000 m the mist covers 90–99 % of a cloud's own shading, so the clouds simply glow in
  // the mist colour (black base, emission = mist colour). That also keeps them unchanged behind
  // the beam shafts: the path tracer evaluates the mist at the first surface a camera ray hits,
  // which there is the shaft glass a few metres away, so lit clouds would lose their mist and
  // show up dark brown through a passing beam.
  for (let k = 1; k <= clouds.length; k++) {
    await material(`Cloud ${k}`, k === 1 ? { name: 'Cloud Haze', base_color: [0, 0, 0, 1], roughness: 1, emission_color: MIST.color, emission_strength: 1 } : { material: 'Cloud Haze' });
  }
  await add('empty', 'Camera Target', { location: CAMERA.target, params: { type: 'SPHERE' } });
  await add('camera', 'Camera', { location: CAMERA.at, params: { lens: CAMERA.lens, clip_end: 2000 } });
  const c = await op('object.constraint_add', { object: 'Camera', type: 'TRACK_TO', target: 'Camera Target', params: { track_axis: 'TRACK_NEGATIVE_Z', up_axis: 'UP_Y' } });
  if (c.errors?.length) throw new Error(`camera constraint: ${c.errors.join('; ')}`);
  await tool('set_active_camera', { camera: 'Camera' });
}

// ---------------------------------------------------------------------------------------------
// 10. Checks: scene problems, the driven beams at several frames, the camera aim
// ---------------------------------------------------------------------------------------------
/** Forward (−Z) axis of an XYZ Euler rotation. */
function forwardOf([rx, ry, rz]) {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rx), Math.sin(rx), Math.cos(ry), Math.sin(ry), Math.cos(rz), Math.sin(rz)];
  // third column of Rz·Ry·Rx, negated
  return [-(cz * sy * cx + sz * sx), -(sz * sy * cx - cz * sx), -(cy * cx)];
}
async function check() {
  const s = await tool('get_scene', { max_objects: 5 });
  log(`scene: ${JSON.stringify(s.counts ?? {}).slice(0, 400)}`);
  if (s.problems?.length) throw new Error(`scene problems: ${JSON.stringify(s.problems).slice(0, 800)}`);
  // The beams are driven by the frame: read the evaluated heading back with get_object {frame}.
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  for (const frame of [1, 7, 13, 19, 25]) {
    const parts = [];
    for (const [k, phase] of [['A', BEAM_PHASE], ['B', BEAM_PHASE + Math.PI]]) {
      const o = await tool('get_object', { object: `LH Beam ${k}`, frame });
      const got = o.world_transform.rotation_euler[2];
      const want = phase + ((frame - 1) * Math.PI) / FRAMES;
      if (Math.abs(wrap(got - want)) > 1e-3) throw new Error(`beam ${k} at frame ${frame}: heading ${got}, expected ${want}`);
      parts.push(`${k} ${((wrap(got) * 180) / Math.PI).toFixed(1)}° (stored ${o.stored?.rotation_euler?.[2]?.toFixed(3) ?? '-'})`);
    }
    log(`  beams @${frame}: ${parts.join(', ')}`);
  }
  // Frame 25 equals frame 1 with the beams swapped: the 24-frame loop is seamless.
  // The path lies on the ground: its evaluated surface against the island heightmap.
  const pm = await tool('get_mesh_data', { object: 'Stone Path', include: ['vertices'], source: 'EVALUATED', space: 'WORLD', limit: 20000 });
  const hm = (await tool('get_mesh_data', { object: 'Island', include: ['heightmap'], heightmap_resolution: 256 })).heightmap;
  const groundAt = (x, y) => {
    const fi = clamp((x - hm.min_xy[0]) / hm.step[0], 0, hm.samples[0] - 1.001);
    const fj = clamp((y - hm.min_xy[1]) / hm.step[1], 0, hm.samples[1] - 1.001);
    const [i, j, u, v] = [Math.floor(fi), Math.floor(fj), fi % 1, fj % 1];
    const H = hm.heights;
    return (1 - v) * ((1 - u) * H[j][i] + u * H[j][i + 1]) + v * ((1 - u) * H[j + 1][i] + u * H[j + 1][i + 1]);
  };
  const above = pm.vertices.map(([x, y, z]) => z - groundAt(x, y));
  log(`  path: ${pm.vertices.length} vertices, highest ${Math.max(...above).toFixed(2)} m above the ground (top surface: +0.11 m)`);
  const cam = await tool('get_object', { object: 'Camera', frame: 1 });
  const errs = (cam.constraints ?? []).flatMap((c) => c.errors ?? (c.error ? [c.error] : []));
  if (errs.length) throw new Error(`camera constraint errors: ${errs.join('; ')}`);
  const f = forwardOf(cam.world_transform.rotation_euler);
  const to = CAMERA.target.map((v, i) => v - cam.world_transform.location[i]);
  const tl = Math.hypot(...to);
  const angle = (Math.acos(clamp((f[0] * to[0] + f[1] * to[1] + f[2] * to[2]) / tl, -1, 1)) * 180) / Math.PI;
  log(`  camera: ${(cam.constraints ?? []).map((c) => `${c.type} → ${(c.targets ?? []).join(', ')}`).join(', ')}; aims ${angle.toFixed(3)}° off the target`);
  if (angle > 0.1) throw new Error(`camera does not aim at its target (${angle}°)`);

  // Scatter placement. Instances have no positions of their own in the MCP results, so each
  // particle system is made real for a moment: one batch shows only that system and runs
  // object.duplicates_make_real, get_scene lists the new objects, and undo reverts the batch.
  // The 2,600 grass tufts are left out: making them real roughly doubles the server's memory
  // (see the README). They follow the same density rules (zero weight on the dry beach).
  const pathLine = resample(PATH_WAYPOINTS, 0.25);
  for (const sc of SCATTERS.filter((x) => x.count <= 500)) {
    const res = await ops([
      ...SCATTERS.map((o) => ({ operator: 'object.particle_system_update', params: { object: 'Island', particle_system: o.name, show_viewport: o === sc, show_render: o === sc } })),
      { operator: 'object.duplicates_make_real', params: { objects: ['Island'] } },
    ]);
    const made = new Set(res.at(-1).objects);
    const listed = await tool('get_scene', { max_objects: 5000 });
    const u = await tool('undo', {});
    if (u.undone !== 1) throw new Error(`undo after the ${sc.name} placement check: ${JSON.stringify(u)}`);
    const pts = listed.objects.filter((o) => made.has(o.id)).map((o) => o.location);
    if (pts.length !== made.size) throw new Error(`${sc.name}: ${made.size} objects made real, ${pts.length} listed`);
    let closest = Infinity;
    for (let a = 0; a < pts.length; a++)
      for (let b = a + 1; b < pts.length; b++) closest = Math.min(closest, Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1], pts[a][2] - pts[b][2]));
    const onPath = pts.filter((q) => distToPolyline(q, pathLine) < 0.75).length; // the path is 1.5 m wide
    const onBeach = pts.filter((q) => dryBeach[faceAt(q[0], q[1])]).length;
    const inSea = pts.filter((q) => q[2] < SEA).length;
    log(`  ${sc.name}: ${pts.length} placed, closest pair ${closest.toFixed(2)} m (min_distance ${sc.min_distance}), on the path ${onPath}, on the dry beach ${onBeach}, in the shallows ${inSea}`);
    if (closest < sc.min_distance - 1e-3 || onPath || onBeach) throw new Error(`${sc.name} placement check failed`);
  }
  const after = await tool('get_scene', { max_objects: 1 });
  if (after.counts.objects !== s.counts.objects || after.counts.instances !== s.counts.instances) {
    throw new Error(`the placement checks changed the scene: ${JSON.stringify(after.counts)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// 11. Renders and export
// ---------------------------------------------------------------------------------------------
const stats = {};
async function renders() {
  if (MODE === 'preview') {
    const dir = path.join(os.tmpdir(), 'lighthouse-cove-preview');
    let t = Date.now();
    await saveResult(await tool('render_image', { width: 640, height: 360, engine: 'RASTER' }), path.join(dir, 'preview_raster.png'));
    log(`raster preview ${((Date.now() - t) / 1000).toFixed(1)} s`);
    t = Date.now();
    const pt = await tool('render_image', { width: 640, height: 360, engine: 'PATHTRACER', samples: 16, denoise: true, time_limit: 60, frame: 1 });
    log(`path-traced preview ${((Date.now() - t) / 1000).toFixed(1)} s, ${pt.text?.samples} spp`);
    await saveResult(pt, path.join(dir, 'preview_pt.png'));
    return;
  }
  if (!FLAGS.has('--skip-final')) {
    const t = Date.now();
    const r = await tool('render_image', { width: 1280, height: 720, engine: 'PATHTRACER', samples: 128, max_bounces: 8, denoise: true, time_limit: 420, frame: 1 });
    stats.final = { seconds: (Date.now() - t) / 1000, samples: r.text?.samples, requested: r.text?.requested_samples, threads: r.text?.threads };
    log(`final still: ${JSON.stringify(stats.final)}`);
    await saveResult(r, 'render.png');
  }
  if (!FLAGS.has('--skip-anim')) {
    // Both animation outputs are path traced at a low sample count and denoised; the beam shafts
    // are noise-free by construction (index-matched glass), so few samples suffice.
    const anim = { frame_start: 1, frame_end: FRAMES, engine: 'PATHTRACER', max_bounces: 8, denoise: true };
    let t = Date.now();
    const cs = await tool('render_animation', { ...anim, format: 'CONTACT_SHEET', samples: 12, width: 320, height: 180, columns: 6, time_limit: 200 });
    stats.contact_sheet = { seconds: (Date.now() - t) / 1000, frames: cs.text?.frame_count, truncated: cs.text?.truncated ?? false, samples_per_frame: 12, threads: cs.text?.threads };
    log(`contact sheet: ${JSON.stringify(stats.contact_sheet)}`);
    await saveResult(cs, 'contact_sheet.png');
    t = Date.now();
    const gif = await tool('render_animation', { ...anim, format: 'GIF', samples: 16, width: 480, height: 270, fps: 10, dither: 'FLOYD_STEINBERG', time_limit: 480 });
    stats.gif = { seconds: (Date.now() - t) / 1000, frames: gif.text?.frame_count, truncated: gif.text?.truncated ?? false, samples_per_frame: 16, threads: gif.text?.threads };
    log(`gif: ${JSON.stringify(stats.gif)}`);
    stats.gif.bytes = await saveResult(gif, 'preview.gif');
  }
}
async function exportScene() {
  const t = Date.now();
  const ex = await tool('export_scene', { format: 'glb' });
  stats.export = { seconds: (Date.now() - t) / 1000, warnings: ex.text?.warnings ?? ex.warnings };
  if (stats.export.warnings?.length) log(`  export warnings: ${JSON.stringify(stats.export.warnings).slice(0, 600)}`);
  stats.export.bytes = await saveResult(ex, 'scene.glb');
  if (stats.export.bytes > 6e6) log('  ⚠ scene.glb is larger than 6 MB');
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
  ];
  if (MODE === 'final' || MODE === 'preview') stages.push(['renders', renders]);
  if (MODE === 'export' || FLAGS.has('--export')) stages.push(['export', exportScene]);
  log(`mode ${MODE}, outputs → ${MODE === 'preview' ? path.join(os.tmpdir(), 'lighthouse-cove-preview') : MODE === 'build' ? 'none' : OUT_DIR}`);
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
