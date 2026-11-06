#!/usr/bin/env node
/**
 * Robot palletizing workcell — built from scratch through the 3D editor's MCP server.
 *
 *   MCP_URL=http://127.0.0.1:8080/mcp node examples/robot-workcell/build.mjs [mode] [options]
 *
 * Modes (exclusive; the scene is always deleted, rebuilt and verified first)
 *   (none)             final renders: render.png, contact_sheet.png, preview.gif
 *   --no-render        build + verify only (a few seconds)
 *   --export-only      build + verify, then export scene.glb (no renders)
 *   --preview=DIR      build + verify, then quick previews into DIR (RASTER stills, a RASTER
 *                      contact sheet and one small path-traced frame); the outputs are untouched
 * Options for the final renders (only without a mode flag)
 *   --still-only       only render.png
 *   --anim-only        only contact_sheet.png and preview.gif
 *   --still-time=S     time limit of the path-traced still in seconds (default 480)
 * Unknown, repeated or incomplete arguments (e.g. --preview without =DIR) and contradictory
 * combinations are rejected before anything is built or rendered.
 *
 * Outputs (next to this script): render.png (path-traced 1280x720 still), contact_sheet.png
 * (24 path-traced frames of the cycle), preview.gif (48-frame pick-and-place cycle) and, with
 * --export-only, scene.glb.
 *
 * Everything is created through MCP tools (create_project, run_operator, batch, insert_keyframe,
 * add_modifier, set_scene_settings, get_object, get_mesh_data, render_image, render_animation,
 * export_scene …). Sizes are metres, angles radians, Z is up. Any tool error aborts the build.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../../scripts/mcp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = 'robot-workcell';

// Command line, validated strictly before anything runs: the default mode overwrites the final
// outputs, so a mistyped or incomplete flag must never fall through to it.
const FLAGS = ['no-render', 'export-only', 'still-only', 'anim-only']; // --name
const VALUES = ['preview', 'still-time']; // --name=value
const args = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(a);
  const known = [...FLAGS.map((k) => `--${k}`), ...VALUES.map((k) => `--${k}=…`)].join(' ');
  if (!m || (!FLAGS.includes(m[1]) && !VALUES.includes(m[1])))
    throw new Error(`unknown argument ${a} (known: ${known})`);
  const [, name, value] = m;
  if (FLAGS.includes(name) && value !== undefined) throw new Error(`--${name} takes no value`);
  if (VALUES.includes(name) && !value)
    throw new Error(`--${name} needs a value: --${name}=${name === 'preview' ? 'DIR' : 'SECONDS'}`);
  if (name in args) throw new Error(`--${name} is given twice`);
  args[name] = value ?? true;
}
const modes = ['no-render', 'export-only', 'preview'].filter((k) => k in args);
if (modes.length > 1) throw new Error(`the modes ${modes.map((k) => `--${k}`).join(', ')} are exclusive`);
if (args['still-only'] && args['anim-only'])
  throw new Error('--still-only and --anim-only are exclusive (give neither to render both)');
const finalOptions = ['still-only', 'anim-only', 'still-time'].filter((k) => k in args);
if (modes.length && finalOptions.length)
  throw new Error(
    `${finalOptions.map((k) => `--${k}`).join(', ')} only ${finalOptions.length > 1 ? 'apply' : 'applies'} to the final renders (no mode flag), not to --${modes[0]}`,
  );
if (args['anim-only'] && args['still-time']) throw new Error('--still-time has no effect with --anim-only');
// (--no-render needs no variable: with it, none of the render and export stages at the end runs)
const EXPORT_ONLY = !!args['export-only'];
const PREVIEW_DIR = args.preview;
const STILL_ONLY = !!args['still-only'];
const ANIM_ONLY = !!args['anim-only'];
const STILL_TIME = Number(args['still-time'] ?? 480);
if (!(STILL_TIME > 0 && STILL_TIME <= 3600))
  throw new Error(`--still-time must be a number of seconds in (0, 3600], got ${args['still-time']}`);
const FINAL_RENDERS = !modes.length;

const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s]`, ...a);

const mcp = await connect();

// ---------------------------------------------------------------------------------------------
// MCP helpers
// ---------------------------------------------------------------------------------------------
let mcpCalls = 0;
async function call(tool, args = {}, opts) {
  mcpCalls++;
  try {
    return await mcp.call(tool, args, opts);
  } catch (e) {
    const shown = JSON.stringify(args, (k, v) =>
      Array.isArray(v) && v.length > 12 ? `[${v.length} items]` : v,
    );
    throw new Error(`${tool} failed: ${e.message}\n  args: ${shown.slice(0, 1500)}`, { cause: e });
  }
}
const tool = (name, args = {}, opts) => call(name, { project: PROJECT, ...args }, opts);
async function op(operator, params = {}, selection) {
  const r = await tool('run_operator', { operator, params, ...(selection ? { selection } : {}) });
  for (const rep of r.reports ?? [])
    if (rep.level !== 'INFO') log(`  ${operator}: ${rep.level} ${rep.message}`);
  return r.result;
}
async function batch(operations, label = 'batch') {
  const results = [];
  for (let i = 0; i < operations.length; i += 200) {
    const r = await tool('batch', { operations: operations.slice(i, i + 200) });
    if (!r.ok) throw new Error(`${label}: ${JSON.stringify(r).slice(0, 2000)}`);
    // batch reports every operation's warnings: surface them instead of dropping them
    for (const res of r.results ?? [])
      for (const rep of res.reports ?? [])
        if (rep.level !== 'INFO') log(`  ${label} / ${res.operator}: ${rep.level} ${rep.message}`);
    results.push(...(r.results ?? []));
  }
  return results;
}
const sel = (objects, active) => ({
  operator: 'object.select',
  params: { objects, ...(active ? { active } : {}) },
});

// ---------------------------------------------------------------------------------------------
// Geometry helpers (meshes are built at real size: object scale stays 1, so procedural
// textures use true metres and bone parenting never sees a non-uniform scale)
// ---------------------------------------------------------------------------------------------
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const newGeo = () => ({ v: [], f: [] });
/** Axis-aligned box; returns the first vertex and face index. */
function addBox(g, [cx, cy, cz], [sx, sy, sz]) {
  const vb = g.v.length;
  const fb = g.f.length;
  for (const z of [cz - sz / 2, cz + sz / 2])
    for (const y of [cy - sy / 2, cy + sy / 2])
      for (const x of [cx - sx / 2, cx + sx / 2]) g.v.push([r6(x), r6(y), r6(z)]);
  for (const q of [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ])
    g.f.push(q.map((i) => vb + i));
  return { v: vb, f: fb, nv: 8, nf: 6 };
}
/** Box tapering along local Z from (w0 x d0) at z0 to (w1 x d1) at z1 (w along X, d along Y). */
function addTaperBox(g, z0, z1, [w0, d0], [w1, d1], [ox, oy] = [0, 0]) {
  const vb = g.v.length;
  const fb = g.f.length;
  for (const [z, w, d] of [
    [z0, w0, d0],
    [z1, w1, d1],
  ])
    for (const y of [-d / 2, d / 2])
      for (const x of [-w / 2, w / 2]) g.v.push([r6(ox + x), r6(oy + y), r6(z)]);
  for (const q of [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ])
    g.f.push(q.map((i) => vb + i));
  return { v: vb, f: fb };
}
const addTaper = (g, t) => addTaperBox(g, t.z0, t.z1, [t.w0, t.d0], [t.w1, t.d1]);
/** Box centred at c with edges along the unit vectors a, b and a x b (sizes [sa, sb, sc]). */
function addOrientedBox(g, c, a, b, [sa, sb, sc]) {
  const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const vb = g.v.length;
  for (const k of [-0.5, 0.5])
    for (const j of [-0.5, 0.5])
      for (const i of [-0.5, 0.5])
        g.v.push(c.map((x, m) => r6(x + a[m] * i * sa + b[m] * j * sb + n[m] * k * sc)));
  for (const q of [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ])
    g.f.push(q.map((i) => vb + i));
}
/** Closed cylinder around `axis` ('X' | 'Y' | 'Z') centred at c. */
function addCylinder(g, c, radius, length, axis = 'Z', segments = 32) {
  const vb = g.v.length;
  const fb = g.f.length;
  const map = (a, b, h) =>
    axis === 'Z'
      ? [c[0] + a, c[1] + b, c[2] + h]
      : axis === 'Y'
        ? [c[0] + a, c[1] + h, c[2] + b]
        : [c[0] + h, c[1] + a, c[2] + b];
  for (const h of [-length / 2, length / 2])
    for (let i = 0; i < segments; i++) {
      const t = (2 * Math.PI * i) / segments;
      g.v.push(map(radius * Math.cos(t), radius * Math.sin(t), h).map(r6));
    }
  // Orientation: for axis Y the (a, b, h) frame is left-handed, so faces flip.
  const flip = axis === 'Y';
  const face = (q) => g.f.push((flip ? q.slice().reverse() : q).map((i) => vb + i));
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    face([i, j, segments + j, segments + i]);
  }
  face([...Array(segments).keys()].reverse());
  face([...Array(segments).keys()].map((i) => segments + i));
  return { v: vb, f: fb };
}
const meshOp = (name, g, extra = {}) => ({
  operator: 'object.add_mesh_from_data',
  params: { name, vertices: g.v, faces: g.f, ...extra },
});

// vector helpers
const add = (a, b) => a.map((x, i) => x + b[i]);
const sub = (a, b) => a.map((x, i) => x - b[i]);
const mul = (a, s) => a.map((x) => x * s);
const len = (a) => Math.hypot(...a);
const norm = (a) => mul(a, 1 / len(a));
const dist = (a, b) => len(sub(a, b));
const dot = (a, b) => a.reduce((acc, x, i) => acc + x * b[i], 0);
const fmt = (a) => `[${a.map((x) => x.toFixed(3)).join(', ')}]`;

// ---------------------------------------------------------------------------------------------
// Design constants (metres, radians). The robot stands at the origin; in the rest pose the arm
// points along +X. Joint 1 yaws about Z, J2/J3 pitch (IK), J4 rolls the gripper about the
// vertical (the wrist is kept vertical by a Damped Track, like a palletizer's parallel link).
// ---------------------------------------------------------------------------------------------
const J1_HEAD = [0, 0, 0.32];
const J1_TAIL = [0, 0, 0.74];
const SHOULDER = [0.14, 0, 0.84];
const ELBOW = [0.3, 0, 1.8];
const WRIST = [1.32, 0, 1.62];
const WRIST_TAIL = [1.32, 0, 1.38];
const HOSE_START = [-0.3, 0, 0.63]; // dress-pack hose: cable fitting at the back of the turret ...
const HOSE_END = [WRIST[0] - 0.04, 0, WRIST[2] + 0.12]; // ... to the top of the wrist
const LU = dist(ELBOW, SHOULDER); // upper-arm and forearm bone lengths
const LF = dist(WRIST, ELBOW);
// The two arm links are boxes tapering along their bone: from z0 to z1 (metres from the bone head)
// with width w (in the arm plane) and depth d (along the joint axes, world Y) at both ends.
const UPPER_ARM_TAPER = { z0: 0.1, z1: LU - 0.1, w0: 0.24, d0: 0.24, w1: 0.17, d1: 0.2 };
const FOREARM_START = 0.12; // the forearm starts this far from the elbow axis ...
const FOREARM_TAPER = { z0: FOREARM_START, z1: LF - 0.06, w0: 0.19, d0: 0.18, w1: 0.13, d1: 0.14 };
const ELBOW_HOUSING_R = 0.16; // ... inside the elbow housing, which covers both link ends
const ELBOW_MOTOR_Y = -0.19; // the rear elbow motor sits beside the arm's centre plane
/** Half the in-plane width of a tapered link `s` metres from its bone head. */
const taperHalf = (t, s) => (t.w0 + ((t.w1 - t.w0) * (s - t.z0)) / (t.z1 - t.z0)) / 2;
// Dress-pack hose route: centre line 0.17 m behind the upper arm's axis, a 0.235 m arc around
// the elbow axis, 0.135 m above the forearm's axis
const HOSE_BACK_OFFSET = 0.17;
const HOSE_ARC_R = 0.235;
const HOSE_ARC_DEG = [150, 118, 85];
const HOSE_TOP_OFFSET = 0.135;
const GRIP_DROP = 0.52; // wrist head (IK target) -> centre of a gripped crate
const CRATE = [0.42, 0.42, 0.32];
const CONVEYOR_X = -1.55;
const ROLLER_TOP = 0.78;
const PICK = [CONVEYOR_X, 0, ROLLER_TOP + CRATE[2] / 2]; // crate centre at the pick station
const PALLET_C = [1.62, -0.15];
const PALLET_TOP = 0.144;
const SLOT = (sx, sy) => [PALLET_C[0] + sx * 0.28, PALLET_C[1] + sy * 0.29, PALLET_TOP + CRATE[2] / 2];
const PLACE = SLOT(-1, -1); // the free pallet slot (front, nearest to the robot)
const AZ_P = Math.PI;
const R_P = Math.hypot(PICK[0], PICK[1]);
let AZ_Q = Math.atan2(PLACE[1], PLACE[0]);
while (AZ_Q < AZ_P) AZ_Q += 2 * Math.PI; // swing counter-clockwise from the conveyor to the pallet
const R_Q = Math.hypot(PLACE[0], PLACE[1]);
const WZ_PICK = PICK[2] + GRIP_DROP;
const WZ_PLACE = PLACE[2] + GRIP_DROP;

const FRAME_END = 96;
const WAY = {
  home: { az: 1.5 * Math.PI, r: 1.2, z: 1.9 },
  pAbove: { az: AZ_P, r: R_P, z: WZ_PICK + 0.45 },
  pGrip: { az: AZ_P, r: R_P, z: WZ_PICK },
  pLift: { az: AZ_P, r: R_P, z: WZ_PICK + 0.5 },
  qAbove: { az: AZ_Q, r: R_Q, z: WZ_PLACE + 0.47 },
  qPlace: { az: AZ_Q, r: R_Q, z: WZ_PLACE },
  qLift: { az: AZ_Q, r: R_Q, z: WZ_PLACE + 0.5 },
};
// [frame, waypoint]; consecutive equal waypoints are holds
const TIMELINE = [
  [1, 'home'],
  [16, 'pAbove'],
  [19, 'pAbove'],
  [28, 'pGrip'],
  [34, 'pGrip'],
  [43, 'pLift'],
  [63, 'qAbove'],
  [72, 'qPlace'],
  [78, 'qPlace'],
  [86, 'qLift'],
  [96, 'home'],
];
// Camera: a low three-quarter view from the open front-left corner of the cell; it pans after
// the gripper with a half-strength Damped Track and keeps the gripper in focus (depth of field).
const CAMERA_LOC = [-2.3, -4.7, 1.55];
const CAMERA_AIM = [0.3, 0.05, 1.0];
const CAMERA_LENS = 30;
const STILL_FRAME = 49; // the crate lifted high, on its way from the conveyor to the free pallet slot
const F_GRIP_START = 28;
const F_GRIPPED = 33; // fingers closed: the crate starts to follow the gripper
const F_RELEASE = 72; // crate set down on the pallet
const F_OPEN = 77;
// Conveyor: the crate waits at the pick station at frame 1. While the robot swings it to the
// pallet, the conveyor indexes the queue one pitch forward: at frame 96 every queued crate sits
// where the one ahead of it started, and Crate_Queued5, hidden in the infeed hood at frame 1, has
// taken the last place, so the conveyor looks the same at frames 1 and 96 (verified in step 11).
const QUEUE_PITCH = 1.05; // spacing of the waiting crates along the belt (m)
const QUEUED = ['Crate_Queued1', 'Crate_Queued2', 'Crate_Queued3', 'Crate_Queued4', 'Crate_Queued5'];
const F_INDEX_START = 44;
const F_INDEX_END = 62;
// Infeed hood at the far end of the belt (mouth at INFEED_Y0, back wall at INFEED_Y1) and its
// roll-up door, keyed [frame, lift in m]: closed, open before the crate arrives, closed behind it
const INFEED_Y0 = 4.52;
const INFEED_Y1 = 5.85;
const MOUTH_HALF = 0.25; // half width of the mouth (crate: 0.21)
const MOUTH_TOP = ROLLER_TOP + CRATE[2] + 0.06; // 6 cm above a crate
const DOOR_Y = INFEED_Y0 + 0.065; // door plane, just behind the 5 cm front wall
const DOOR_LIFT = 0.42; // fully open: the door is hidden behind the header
const DOOR_KEYS = [
  [1, 0],
  [45, 0],
  [51, DOOR_LIFT],
  [58, DOOR_LIFT],
  [64, 0],
];

const smoother = (u) => u * u * u * (u * (u * 6 - 15) + 10);
function cylAt(f) {
  for (let i = 0; i < TIMELINE.length - 1; i++) {
    const [fa, a] = TIMELINE[i];
    const [fb, b] = TIMELINE[i + 1];
    if (f >= fa && f <= fb) {
      const u = smoother((f - fa) / (fb - fa));
      const A = WAY[a];
      const B = WAY[b];
      return { az: A.az + (B.az - A.az) * u, r: A.r + (B.r - A.r) * u, z: A.z + (B.z - A.z) * u };
    }
  }
  return WAY[TIMELINE[TIMELINE.length - 1][1]];
}
const targetAt = (f) => {
  const c = cylAt(f);
  return [c.r * Math.cos(c.az), c.r * Math.sin(c.az), c.z];
};
/** Belt travel of the queued crates (0 -> one pitch) while the conveyor indexes. */
const beltAt = (f) =>
  QUEUE_PITCH * smoother(Math.min(1, Math.max(0, (f - F_INDEX_START) / (F_INDEX_END - F_INDEX_START))));

// ---------------------------------------------------------------------------------------------
// 1. Project
// ---------------------------------------------------------------------------------------------
log(`MCP ${process.env.MCP_URL ?? '(default URL)'}; project "${PROJECT}"`);
const existing = await call('list_projects');
const projects = Array.isArray(existing) ? existing : (existing.projects ?? []);
for (const p of projects.filter((p) => p.name === PROJECT)) {
  await call('delete_project', { project: p.id, confirm: true });
  log(`deleted existing project ${p.id}`);
}
const created = await call('create_project', { name: PROJECT, empty: true });
log(`created project ${created.id} -> ${created.editor_url}`);

await tool('set_scene_settings', {
  frame_start: 1,
  frame_end: FRAME_END,
  fps: 24,
  resolution_x: 1280,
  resolution_y: 720,
  engine: 'PATHTRACER',
  samples: 128,
  max_bounces: 6,
  use_denoising: true,
  view_transform: 'AGX',
});

// ---------------------------------------------------------------------------------------------
// 2. Materials
// ---------------------------------------------------------------------------------------------
const MAT = {
  paint: {
    name: 'Robot Teal Paint',
    base_color: [0.012, 0.23, 0.26, 1],
    roughness: 0.3,
    coat_weight: 0.6,
    coat_roughness: 0.08,
  },
  graphite: {
    name: 'Graphite Housing',
    base_color: [0.025, 0.027, 0.03, 1],
    metallic: 0.55,
    roughness: 0.38,
  },
  steel: { name: 'Machined Steel', base_color: [0.62, 0.63, 0.64, 1], metallic: 1, roughness: 0.28 },
  alu: { name: 'Gripper Aluminium', base_color: [0.8, 0.8, 0.82, 1], metallic: 1, roughness: 0.34 },
  rubber: { name: 'Black Rubber', base_color: [0.012, 0.012, 0.013, 1], roughness: 0.62 },
  pad: { name: 'Grip Pad', base_color: [0.6, 0.18, 0.02, 1], roughness: 0.7 },
  crate: { name: 'Crate Plastic', base_color: [0.75, 0.16, 0.02, 1], roughness: 0.42, coat_weight: 0.2 },
  label: { name: 'Crate Label', base_color: [0.85, 0.85, 0.82, 1], roughness: 0.6 },
  frame: { name: 'Conveyor Frame', base_color: [0.05, 0.06, 0.075, 1], metallic: 0.3, roughness: 0.45 },
  roller: { name: 'Roller Chrome', base_color: [0.75, 0.76, 0.78, 1], metallic: 1, roughness: 0.18 },
  fence: { name: 'Fence Yellow', base_color: [0.85, 0.52, 0.02, 1], metallic: 0.1, roughness: 0.45 },
  mesh: { name: 'Fence Mesh', base_color: [0.04, 0.04, 0.045, 1], metallic: 0.4, roughness: 0.5 },
  floor: { name: 'Epoxy Floor', base_color: [0.1, 0.105, 0.11, 1], roughness: 0.3 },
  stripes: { name: 'Hazard Stripes', base_color: [0.9, 0.62, 0.02, 1], roughness: 0.5 },
  cabinet: { name: 'Cabinet Grey', base_color: [0.42, 0.44, 0.46, 1], metallic: 0.2, roughness: 0.4 },
  screen: {
    name: 'HMI Screen',
    base_color: [0.02, 0.02, 0.02, 1],
    roughness: 0.2,
    emission_color: [0.2, 0.55, 1.0],
    emission_strength: 3,
  },
  green: {
    name: 'Lamp Green',
    base_color: [0.05, 0.5, 0.1, 1],
    roughness: 0.3,
    emission_color: [0.1, 1.0, 0.25],
    emission_strength: 12,
  },
  amber: {
    name: 'Lamp Amber',
    base_color: [0.6, 0.35, 0.02, 1],
    roughness: 0.3,
    emission_color: [1.0, 0.55, 0.05],
    emission_strength: 0,
  },
  red: {
    name: 'Lamp Red',
    base_color: [0.5, 0.03, 0.02, 1],
    roughness: 0.3,
    emission_color: [1.0, 0.05, 0.03],
    emission_strength: 0,
  },
  button: { name: 'EStop Red', base_color: [0.55, 0.02, 0.015, 1], roughness: 0.25, coat_weight: 0.5 },
  sign: { name: 'Sign Yellow', base_color: [0.9, 0.7, 0.05, 1], roughness: 0.5 },
  text: { name: 'Sign Black', base_color: [0.01, 0.01, 0.01, 1], roughness: 0.5 },
  wall: { name: 'Corrugated Wall', base_color: [0.05, 0.058, 0.066, 1], metallic: 0.35, roughness: 0.5 },
  wallSide: {
    name: 'Corrugated Wall Side',
    base_color: [0.05, 0.058, 0.066, 1],
    metallic: 0.35,
    roughness: 0.5,
  },
  window: {
    name: 'Hall Window',
    base_color: [0.05, 0.06, 0.08, 1],
    roughness: 0.1,
    emission_color: [0.35, 0.5, 0.85],
    emission_strength: 2.0,
  },
  column: { name: 'Column Paint', base_color: [0.16, 0.17, 0.18, 1], metallic: 0.3, roughness: 0.5 },
  curtain: {
    name: 'Light Curtain Red',
    base_color: [0.3, 0.01, 0.01, 1],
    roughness: 0.3,
    emission_color: [1.0, 0.04, 0.02],
    emission_strength: 6,
  },
};
await batch(
  Object.values(MAT).map((m) => ({ operator: 'material.new', params: { ...m, assign: false } })),
  'materials',
);
log(`materials: ${Object.keys(MAT).length}`);
const assign = (material, objects, slot = 0) => ({
  operator: 'object.material_assign',
  params: { material: MAT[material].name, objects, slot },
});

// ---------------------------------------------------------------------------------------------
// 3. Floor with procedural safety stripes
// ---------------------------------------------------------------------------------------------
{
  const g = newGeo();
  addBox(g, [0, 0, -0.05], [30, 30, 0.1]);
  // Hazard border: a rectangular ring just inside the fence
  const ring = newGeo();
  const [x0, x1, y0, y1, w] = [-3.15, 2.6, -2.55, 2.6, 0.16];
  addBox(ring, [(x0 + x1) / 2, y0 + w / 2, 0.002], [x1 - x0, w, 0.004]);
  addBox(ring, [(x0 + x1) / 2, y1 - w / 2, 0.002], [x1 - x0, w, 0.004]);
  addBox(ring, [x0 + w / 2, (y0 + y1) / 2, 0.002], [w, y1 - y0 - 2 * w, 0.004]);
  addBox(ring, [x1 - w / 2, (y0 + y1) / 2, 0.002], [w, y1 - y0 - 2 * w, 0.004]);
  // Pedestal danger square around the robot base
  const sq = newGeo();
  const s = 0.62;
  const sw = 0.1;
  addBox(sq, [0, -s + sw / 2, 0.002], [2 * s, sw, 0.004]);
  addBox(sq, [0, s - sw / 2, 0.002], [2 * s, sw, 0.004]);
  addBox(sq, [-s + sw / 2, 0, 0.002], [sw, 2 * s - 2 * sw, 0.004]);
  addBox(sq, [s - sw / 2, 0, 0.002], [sw, 2 * s - 2 * sw, 0.004]);
  // Yellow walkway line in front of the cell
  const walk = newGeo();
  addBox(walk, [-0.3, -3.25, 0.002], [9, 0.1, 0.004]);
  addBox(walk, [-0.3, -4.55, 0.002], [9, 0.1, 0.004]);
  await batch(
    [
      meshOp('Floor', g),
      meshOp('Hazard_Border', ring),
      meshOp('Hazard_RobotZone', sq),
      meshOp('Walkway_Lines', walk),
      assign('floor', ['Floor']),
      assign('stripes', ['Hazard_Border', 'Hazard_RobotZone']),
      assign('fence', ['Walkway_Lines']),
    ],
    'floor',
  );
  // Subtle mottling on the epoxy floor + diagonal black/yellow hazard stripes (procedural WAVE)
  await batch(
    [
      {
        operator: 'material.procedural_set',
        params: {
          material: MAT.floor.name,
          channel: 'base_color',
          procedural: {
            type: 'NOISE',
            mapping: 'OBJECT',
            scale: 0.9,
            detail: 6,
            roughness: 0.55,
            color_a: [0.035, 0.038, 0.042],
            color_b: [0.08, 0.083, 0.088],
          },
        },
      },
      {
        operator: 'material.procedural_set',
        params: {
          material: MAT.floor.name,
          channel: 'roughness',
          procedural: {
            type: 'NOISE',
            mapping: 'OBJECT',
            scale: 2.5,
            detail: 4,
            color_a: [0.12, 0.12, 0.12],
            color_b: [0.36, 0.36, 0.36],
          },
        },
      },
      {
        operator: 'material.procedural_set',
        params: {
          material: MAT.stripes.name,
          channel: 'base_color',
          procedural: {
            type: 'WAVE',
            mapping: 'OBJECT',
            scale: 3.2,
            color_a: [0.92, 0.62, 0.01],
            color_b: [0.012, 0.012, 0.012],
            ramp_low: 0.5,
            ramp_high: 0.5,
            params: {
              wave_type: 'BANDS',
              direction: 'DIAGONAL',
              wave_profile: 'SAW',
              ramp_interpolation: 'CONSTANT',
            },
          },
        },
      },
    ],
    'floor procedurals',
  );
  log('floor + safety stripes');
}

// ---------------------------------------------------------------------------------------------
// 4. Robot: armature (4 joints) and its rigid parts
// ---------------------------------------------------------------------------------------------
await op('object.armature_add', {
  name: 'Robot_Rig',
  bone_name: 'J1_Base',
  location: [0, 0, 0],
  radius: 0.4,
});
await op('armature.bone_update', { object: 'Robot_Rig', bone: 'J1_Base', head: J1_HEAD, tail: J1_TAIL });
// align_roll: every arm bone's local Z axis faces the front (-Y), so the pitch joints J2 and J3
// bend about their own Z axis (the joint axis), which the IK locks in section 5 rely on
const chain = await op('armature.chain_add', {
  object: 'Robot_Rig',
  points: [SHOULDER, ELBOW, WRIST, WRIST_TAIL],
  names: ['J2_Shoulder', 'J3_Elbow', 'J4_Wrist'],
  parent: 'J1_Base',
  use_connect: false,
  align_roll: [0, -1, 0],
});
await op('armature.properties_set', { object: 'Robot_Rig', display_type: 'STICK', show_names: true });
log(`armature bones: J1_Base + ${chain.bones.join(', ')} (lengths ${chain.lengths.join(', ')})`);

const robotParts = []; // [object name, material key, bone]
{
  const ops = [];
  // Static base (not rigged)
  let g = newGeo();
  addBox(g, [0, 0, 0.03], [0.9, 0.9, 0.06]);
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) addCylinder(g, [sx * 0.36, sy * 0.36, 0.075], 0.03, 0.03, 'Z', 12);
  ops.push(meshOp('Robot_BasePlate', g), assign('graphite', ['Robot_BasePlate']));
  g = newGeo();
  addCylinder(g, [0, 0, 0.19], 0.3, 0.26, 'Z', 48);
  ops.push(meshOp('Robot_Pedestal', g), assign('paint', ['Robot_Pedestal']));

  // J1: turret, shoulder yoke, J2 motor, cable fitting
  g = newGeo();
  addCylinder(g, [0, 0, 0.455], 0.27, 0.27, 'Z', 48);
  addBox(g, [0.0, 0, 0.62], [0.36, 0.43, 0.1]);
  for (const sy of [-1, 1]) {
    addBox(g, [0.07, sy * 0.19, 0.72], [0.3, 0.05, 0.26]);
    addCylinder(g, [SHOULDER[0], sy * 0.19, SHOULDER[2]], 0.15, 0.05, 'Y', 40);
  }
  ops.push(meshOp('Robot_Turret', g));
  robotParts.push(['Robot_Turret', 'paint', 'J1_Base']);
  g = newGeo();
  addCylinder(g, [SHOULDER[0], -0.29, SHOULDER[2]], 0.095, 0.15, 'Y', 32);
  addCylinder(g, [SHOULDER[0], -0.38, SHOULDER[2]], 0.06, 0.04, 'Y', 24);
  addCylinder(g, [-0.2, 0, 0.5], 0.08, 0.22, 'X', 28); // J1 drive motor at the back
  addBox(g, [-0.3, 0, 0.62], [0.08, 0.1, 0.07]); // cable fitting
  ops.push(meshOp('Robot_Motors', g));
  robotParts.push(['Robot_Motors', 'graphite', 'J1_Base']);

  // J2: shoulder housing + upper arm (tapered box along the bone)
  g = newGeo();
  addCylinder(g, SHOULDER, 0.17, 0.33, 'Y', 48);
  ops.push(meshOp('Robot_ShoulderHousing', g));
  robotParts.push(['Robot_ShoulderHousing', 'graphite', 'J2_Shoulder']);
  const dU = norm(sub(ELBOW, SHOULDER));
  g = newGeo();
  addTaper(g, UPPER_ARM_TAPER);
  ops.push(meshOp('Robot_UpperArm', g, { location: SHOULDER, rotation: [0, Math.atan2(dU[0], dU[2]), 0] }));
  robotParts.push(['Robot_UpperArm', 'paint', 'J2_Shoulder']);

  // J3: elbow housing, rear motor, forearm. The elbow bends between 78 and 127 degrees in the
  // cycle, so the links are laid out to clear each other over that whole range: the forearm
  // starts 0.12 m from the joint axis (inside the 0.16 m housing), so its lower corner never
  // reaches the end of the upper arm when the elbow closes, and the rear motor is mounted beside
  // the arm's centre plane (y -0.115 to -0.265): it swings past the upper arm (|y| <= 0.1) when
  // the elbow opens, and the dress-pack hose (y = 0) runs around the back of the elbow next to it.
  g = newGeo();
  addCylinder(g, ELBOW, ELBOW_HOUSING_R, 0.3, 'Y', 44);
  ops.push(meshOp('Robot_ElbowHousing', g));
  robotParts.push(['Robot_ElbowHousing', 'graphite', 'J3_Elbow']);
  const dF = norm(sub(WRIST, ELBOW));
  g = newGeo();
  addTaperBox(g, -0.34, -0.1, [0.15, 0.15], [0.15, 0.15], [0, ELBOW_MOTOR_Y]);
  addCylinder(g, [0, ELBOW_MOTOR_Y, -0.38], 0.085, 0.08, 'Z', 28);
  ops.push(meshOp('Robot_ElbowMotor', g, { location: ELBOW, rotation: [0, Math.atan2(dF[0], dF[2]), 0] }));
  robotParts.push(['Robot_ElbowMotor', 'graphite', 'J3_Elbow']);
  g = newGeo();
  addTaper(g, FOREARM_TAPER);
  ops.push(meshOp('Robot_Forearm', g, { location: ELBOW, rotation: [0, Math.atan2(dF[0], dF[2]), 0] }));
  robotParts.push(['Robot_Forearm', 'paint', 'J3_Elbow']);
  g = newGeo();
  addCylinder(g, WRIST, 0.095, 0.21, 'Y', 32);
  ops.push(meshOp('Robot_WristJoint', g));
  robotParts.push(['Robot_WristJoint', 'graphite', 'J3_Elbow']);

  // J4: rotating flange
  g = newGeo();
  addCylinder(g, [WRIST[0], 0, 1.455], 0.075, 0.15, 'Z', 32);
  addCylinder(g, [WRIST[0], 0, 1.392], 0.095, 0.024, 'Z', 32);
  ops.push(meshOp('Robot_WristFlange', g));
  robotParts.push(['Robot_WristFlange', 'steel', 'J4_Wrist']);
  await batch(ops, 'robot parts');
}
// Gears (generator): slewing ring on J1, gear wheels on the shoulder and elbow
// (materials: false: the parts get their materials below, so no unused default "Steel" is made)
await op('object.generate_gear', {
  name: 'Robot_SlewRing',
  teeth: 60,
  radius: 0.335,
  tooth_depth: 0.02,
  thickness: 0.05,
  bore: 0.25,
  location: [0, 0, 0.345],
  materials: false,
});
await op('object.generate_gear', {
  name: 'Robot_ShoulderGear',
  teeth: 28,
  radius: 0.16,
  tooth_depth: 0.022,
  thickness: 0.035,
  bore: 0.05,
  location: [SHOULDER[0], 0.235, SHOULDER[2]],
  rotation: [Math.PI / 2, 0, 0],
  materials: false,
});
await op('object.generate_gear', {
  name: 'Robot_ElbowGear',
  teeth: 26,
  radius: 0.145,
  tooth_depth: 0.02,
  thickness: 0.03,
  bore: 0.04,
  location: [ELBOW[0], 0.165, ELBOW[2]],
  rotation: [Math.PI / 2, 0, 0],
  materials: false,
});
robotParts.push(
  ['Robot_SlewRing', 'steel', 'J1_Base'],
  ['Robot_ShoulderGear', 'steel', 'J2_Shoulder'],
  ['Robot_ElbowGear', 'steel', 'J3_Elbow'],
);

// Gripper with two fingers; the 'Grip' shape key closes them onto the crate
const gripper = newGeo();
addBox(gripper, [0, 0, -0.015], [0.16, 0.16, 0.03]);
addBox(gripper, [0, 0, -0.07], [0.14, 0.7, 0.08]);
addCylinder(gripper, [0, 0, -0.07], 0.035, 0.74, 'Y', 16); // actuator rod
const FINGER_OPEN = 0.303;
const PAD_OPEN = 0.2765;
const fingerL = addBox(gripper, [0, -FINGER_OPEN, -0.23], [0.12, 0.04, 0.34]);
const padL = addBox(gripper, [0, -PAD_OPEN, -0.31], [0.1, 0.013, 0.14]);
const fingerR = addBox(gripper, [0, FINGER_OPEN, -0.23], [0.12, 0.04, 0.34]);
const padR = addBox(gripper, [0, PAD_OPEN, -0.31], [0.1, 0.013, 0.14]);
const GRIP_TRAVEL = PAD_OPEN - 0.0065 - (CRATE[1] / 2 + 0.002); // pads stop 2 mm from the crate
{
  await batch(
    [
      meshOp('Robot_Gripper', gripper, { location: WRIST_TAIL }),
      assign('alu', ['Robot_Gripper'], 0),
      assign('pad', ['Robot_Gripper'], 1),
    ],
    'gripper',
  );
  await tool('edit_mesh', {
    object: 'Robot_Gripper',
    operator: 'object.material_slot_assign',
    params: { index: 1 },
    selection: { faces: [...Array(6).keys()].flatMap((i) => [padL.f + i, padR.f + i]) },
  });
  await op('object.shape_key_add', { object: 'Robot_Gripper', name: 'Grip' });
  const idxL = [...Array(8).keys()].flatMap((i) => [fingerL.v + i, padL.v + i]);
  const idxR = [...Array(8).keys()].flatMap((i) => [fingerR.v + i, padR.v + i]);
  await op('object.shape_key_set_positions', {
    object: 'Robot_Gripper',
    key: 'Grip',
    indices: [...idxL, ...idxR],
    offsets: [...idxL.map(() => [0, GRIP_TRAVEL, 0]), ...idxR.map(() => [0, -GRIP_TRAVEL, 0])],
  });
  robotParts.push(['Robot_Gripper', null, 'J4_Wrist']);
  log(`gripper: finger travel ${(GRIP_TRAVEL * 1000).toFixed(1)} mm per side`);
}

// Materials + smooth shading + bone parenting of every rigid part. Bone parenting works like
// Blender's Ctrl+P > Bone: select the parts, make the armature active, object.parent_set BONE.
{
  const ops = [];
  for (const [name, mat] of robotParts) if (mat) ops.push(assign(mat, [name]));
  ops.push(assign('paint', ['Robot_Turret']));
  const smooth = robotParts.map(([n]) => n).concat(['Robot_BasePlate', 'Robot_Pedestal']);
  ops.push(sel(smooth), { operator: 'object.shade_auto_smooth', params: { angle: 0.6 } });
  for (const bone of ['J1_Base', 'J2_Shoulder', 'J3_Elbow', 'J4_Wrist']) {
    const kids = robotParts.filter(([, , b]) => b === bone).map(([n]) => n);
    ops.push(sel([...kids, 'Robot_Rig'], 'Robot_Rig'), {
      operator: 'object.parent_set',
      params: { type: 'BONE', bone },
    });
  }
  ops.push(sel(['Robot_BasePlate', 'Robot_Pedestal', 'Robot_Rig'], 'Robot_Rig'), {
    operator: 'object.parent_set',
    params: { type: 'OBJECT' },
  });
  await batch(ops, 'robot materials + bone parenting');
  log(`bone-parented ${robotParts.length} rigid parts (object.parent_set BONE)`);
}

const CLAMPS = []; // [clamp name, hose point it holds (rest pose)], filled below, used by the verification
// Dress-pack hose along the arm, skinned with automatic weights so it bends with the joints.
// Route (arm plane y = 0): turret fitting -> up the back of the upper arm -> around the back of
// the elbow (outside the housing, next to the side-mounted elbow motor) -> along the top of the
// forearm -> wrist. Clamps on brackets hold it to the arm.
{
  const dU = norm(sub(ELBOW, SHOULDER));
  const dF = norm(sub(WRIST, ELBOW));
  const nB = [-dU[2], 0, dU[0]]; // behind the upper arm (its local -X)
  const up = [-dF[2], 0, dF[0]]; // above the forearm (its local -X)
  const HOSE_R = 0.032;
  const pts = [
    HOSE_START,
    [-0.31, 0, 0.74],
    [-0.22, 0, 0.9],
    add(add(SHOULDER, mul(dU, 0.35)), mul(nB, HOSE_BACK_OFFSET)),
    add(add(SHOULDER, mul(dU, 0.7)), mul(nB, HOSE_BACK_OFFSET)),
  ];
  for (const a of HOSE_ARC_DEG) {
    const t = (a * Math.PI) / 180;
    pts.push([ELBOW[0] + HOSE_ARC_R * Math.cos(t), 0, ELBOW[2] + HOSE_ARC_R * Math.sin(t)]);
  }
  const forePts = [0.35, 0.68, 0.9].map((t) => add(add(ELBOW, mul(dF, t)), mul(up, HOSE_TOP_OFFSET)));
  pts.push(...forePts, HOSE_END);
  // densify (~4 cm) so the skinned tube bends smoothly
  const dense = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const n = Math.max(1, Math.ceil(dist(pts[i], pts[i + 1]) / 0.04));
    for (let k = 0; k < n; k++) dense.push(add(pts[i], mul(sub(pts[i + 1], pts[i]), k / n)).map(r6));
  }
  dense.push(pts[pts.length - 1].map(r6));
  const hose = await op('object.generate_pipe', {
    name: 'Robot_Hose',
    points: dense,
    radius: HOSE_R,
    segments: 14,
    bend_radius: 0,
    closed_ends: true,
    location: [0, 0, 0],
    materials: false,
  });
  const weights = await op(
    'object.parent_set',
    { type: 'ARMATURE_AUTO' },
    { objects: ['Robot_Hose', 'Robot_Rig'], active: 'Robot_Rig' },
  );
  await batch(
    [assign('rubber', ['Robot_Hose']), sel(['Robot_Hose']), { operator: 'object.shade_smooth' }],
    'hose',
  );
  log(`hose: ${hose.vertices} vertices, auto weights -> ${JSON.stringify(weights.vertex_groups)}`);
  // Weight fix-up (what a rigger does with weight painting after automatic weights): the
  // automatic weights blend over long stretches of the hose (at the root about half J2_Shoulder,
  // at the upper-arm clamps 5-16 % J1_Base and up to 15 % J3_Elbow), so the root would slide over
  // its fitting and the clamped stretches through their clamps. The stretches that are fixed to
  // a link are pinned to its bone (root -> J1_Base, upper-arm clamps -> J2_Shoulder, forearm ->
  // J3_Elbow) and blend back into the automatic weights over 12-15 cm, so the hose still bends
  // with the automatic weights at the shoulder and around the elbow. Weights are read with
  // get_mesh_data and written with object.vertex_group_set_weights.
  const arc = [0];
  for (let i = 1; i < dense.length; i++) arc.push(arc[i - 1] + dist(dense[i - 1], dense[i]));
  /** Arc length along the hose path of the path point closest to p. */
  const arcAt = (p) => {
    let best = Infinity;
    let at = 0;
    for (let i = 0; i < dense.length - 1; i++) {
      const d = sub(dense[i + 1], dense[i]);
      const L = len(d);
      const t = Math.min(1, Math.max(0, dot(sub(p, dense[i]), d) / (L * L)));
      const e = dist(p, add(dense[i], mul(d, t)));
      if (e < best) [best, at] = [e, arc[i] + t * L];
    }
    return at;
  };
  const zones = [
    { bone: 'J1_Base', from: 0, to: 0.1, blend: 0.15 },
    { bone: 'J2_Shoulder', from: arcAt(pts[3]) - 0.05, to: arcAt(pts[4]) + 0.05, blend: 0.12 },
    { bone: 'J3_Elbow', from: arcAt(forePts[0]) - 0.05, to: Infinity, blend: 0.12 },
  ];
  const wd = await tool('get_mesh_data', {
    object: 'Robot_Hose',
    include: ['vertices', 'vertex_groups'],
    source: 'BASE',
    space: 'WORLD',
    limit: 5000,
  });
  const groups = Object.keys(wd.vertex_groups);
  const fixed = Object.fromEntries(groups.map((g) => [g, []]));
  const pinned = Object.fromEntries(zones.map((z) => [z.bone, 0]));
  wd.vertices.forEach((v, i) => {
    const s = arcAt(v);
    let pin = 0;
    let bone = null;
    for (const z of zones) {
      const k = 1 - Math.max(0, z.from - s, s - z.to) / z.blend;
      if (k > pin) [pin, bone] = [k, z.bone];
    }
    if (pin >= 1) pinned[bone]++;
    for (const g of groups) fixed[g][i] = r6((1 - pin) * wd.vertex_groups[g][i] + (g === bone ? pin : 0));
  });
  await batch(
    groups.map((group) => ({
      operator: 'object.vertex_group_set_weights',
      params: { object: 'Robot_Hose', group, weights: fixed[group] },
    })),
    'hose weights',
  );
  log(
    `hose weights pinned (vertices fully pinned per bone ${JSON.stringify(pinned)}); automatic weights kept at the shoulder and the elbow`,
  );

  // Clamps (bone-parented rings around the hose), each on a small bracket that reaches down to
  // the arm surface; the bracket length follows the taper of the arm segment it is bolted to.
  const RING = 0.042; // torus major radius
  const clampOps = [];
  const upperBrackets = newGeo();
  const foreBrackets = newGeo();
  const clampAt = (name, p, dir, bone, toArm, offset, halfWidth, g) => {
    clampOps.push({
      operator: 'mesh.primitive_torus_add',
      params: {
        name,
        major_radius: RING,
        minor_radius: 0.011,
        major_segments: 24,
        minor_segments: 8,
        location: p,
        rotation: [0, Math.atan2(dir[0], dir[2]), 0],
      },
    });
    clampOps.push(assign('steel', [name]));
    clampOps.push(sel([name, 'Robot_Rig'], 'Robot_Rig'), {
      operator: 'object.parent_set',
      params: { type: 'BONE', bone },
    });
    const t0 = RING - 0.004; // inside the ring's tube ...
    const t1 = offset - halfWidth + 0.006; // ... to 6 mm inside the arm
    addOrientedBox(g, add(p, mul(toArm, (t0 + t1) / 2)), toArm, [0, 1, 0], [t1 - t0, 0.03, 0.022]);
  };
  const upperHalf = (s) => taperHalf(UPPER_ARM_TAPER, s);
  const foreHalf = (s) => taperHalf(FOREARM_TAPER, s);
  CLAMPS.push(['Robot_HoseClamp1', pts[3]], ['Robot_HoseClamp2', pts[4]], ['Robot_HoseClamp3', forePts[1]]);
  clampAt(
    'Robot_HoseClamp1',
    pts[3],
    dU,
    'J2_Shoulder',
    mul(nB, -1),
    HOSE_BACK_OFFSET,
    upperHalf(0.35),
    upperBrackets,
  );
  clampAt(
    'Robot_HoseClamp2',
    pts[4],
    dU,
    'J2_Shoulder',
    mul(nB, -1),
    HOSE_BACK_OFFSET,
    upperHalf(0.7),
    upperBrackets,
  );
  clampAt(
    'Robot_HoseClamp3',
    forePts[1],
    dF,
    'J3_Elbow',
    mul(up, -1),
    HOSE_TOP_OFFSET,
    foreHalf(0.68),
    foreBrackets,
  );
  clampOps.push(
    meshOp('Robot_ClampBrackets_Upper', upperBrackets),
    meshOp('Robot_ClampBracket_Fore', foreBrackets),
    assign('steel', ['Robot_ClampBrackets_Upper', 'Robot_ClampBracket_Fore']),
    sel(['Robot_ClampBrackets_Upper', 'Robot_Rig'], 'Robot_Rig'),
    { operator: 'object.parent_set', params: { type: 'BONE', bone: 'J2_Shoulder' } },
    sel(['Robot_ClampBracket_Fore', 'Robot_Rig'], 'Robot_Rig'),
    { operator: 'object.parent_set', params: { type: 'BONE', bone: 'J3_Elbow' } },
  );
  await batch(clampOps, 'hose clamps');
}

// ---------------------------------------------------------------------------------------------
// 5. IK rig: target empty (keyframed), wrist aim, a three-bone IK chain with per-bone IK locks
//    (J1 may only yaw, J2 and J3 only pitch) + a Damped Track that keeps the wrist vertical
// ---------------------------------------------------------------------------------------------
await batch(
  [
    {
      operator: 'object.empty_add',
      params: { name: 'IK_Target', type: 'SPHERE', radius: 0.08, location: WRIST },
    },
    {
      operator: 'object.empty_add',
      params: { name: 'Wrist_Aim', type: 'PLAIN_AXES', radius: 0.05, location: sub(WRIST, [0, 0, 1]) },
    },
    { operator: 'object.parent_to', params: { objects: ['Wrist_Aim'], parent: 'IK_Target' } },
  ],
  'ik helpers',
);
const ik = await op('pose.ik_add', {
  object: 'Robot_Rig',
  bone: 'J3_Elbow',
  target: 'IK_Target',
  chain_count: 3,
  iterations: 500,
});
// Per-bone IK locks and limits (Blender's lock_ik_* / use_ik_limit_*): the vertical base bone J1
// turns only about its own Y axis (the vertical: yaw), the shoulder and the elbow only about their
// Z axes (the joint axes, see align_roll in section 4), so the arm stays in the vertical plane
// through the base axis and the target. Joint limits, measured from the rest pose (positive = the
// link tilts back / up), keep the shoulder from swinging over the top and the elbow from flipping
// over; the cycle uses -28..8 degrees at J2 and -11..38 degrees at J3.
const IK_SETTINGS = {
  J1_Base: { lock_ik_x: true, lock_ik_z: true },
  J2_Shoulder: { lock_ik_x: true, lock_ik_y: true, use_ik_limit_z: true, ik_min_z: -50, ik_max_z: 30 },
  J3_Elbow: { lock_ik_x: true, lock_ik_y: true, use_ik_limit_z: true, ik_min_z: -35, ik_max_z: 60 },
};
const ikSet = await batch(
  Object.entries(IK_SETTINGS).map(([bone, s]) => ({
    operator: 'pose.ik_settings_set',
    params: {
      object: 'Robot_Rig',
      bone,
      ...s,
      ...(s.use_ik_limit_z
        ? { ik_min_z: (s.ik_min_z * Math.PI) / 180, ik_max_z: (s.ik_max_z * Math.PI) / 180 }
        : {}),
    },
  })),
  'ik settings',
);
for (const r of ikSet)
  if (!r.result?.chains?.some((c) => c.constraint === 'IK'))
    throw new Error(`IK settings of ${r.result?.bone}: not in the IK chain (${JSON.stringify(r.result)})`);
// The solver starts from the pose channels (like Blender's IK), so J1 is posed (not keyed) at the
// home azimuth, facing the front of the cell: every target of the cycle then lies within 90 degrees
// of the start and the solver turns the base the short way round. (From the rest pose, the pick
// station lies straight behind the arm, where the yaw has no direction to start in.)
await op('pose.bone_transform_set', {
  object: 'Robot_Rig',
  bone: 'J1_Base',
  rotation_euler: [0, WAY.home.az, 0],
});
await op('pose.constraint_add', {
  object: 'Robot_Rig',
  bone: 'J4_Wrist',
  type: 'DAMPED_TRACK',
  name: 'Keep Vertical',
  target: 'Wrist_Aim',
  params: { track_axis: 'TRACK_Y' },
});
const lockText = (s) =>
  `locks ${['x', 'y', 'z'].filter((a) => s[`lock_ik_${a}`]).join('')}` +
  (s.use_ik_limit_z ? ` + z limit ${s.ik_min_z}..${s.ik_max_z} deg` : '');
const ikText = Object.entries(IK_SETTINGS).map(([b, s]) => `${b} ${lockText(s)}`);
const homeDeg = ((WAY.home.az * 180) / Math.PI).toFixed(0);
log(
  `IK on J3_Elbow, chain ${ik.chain.join(' -> ')}: ${ikText.join(', ')}; solver start J1 yaw ${homeDeg} deg`,
);
log('Damped Track keeps the wrist vertical');

// ---------------------------------------------------------------------------------------------
// 6. Conveyor (rollers via ARRAY) with an infeed hood, pallets (ARRAY boards), crates
// ---------------------------------------------------------------------------------------------
// The conveyor runs from the pick station out through the gap in the fence to an infeed hood.
// The next crate waits inside the hood behind a closed roll-up door, out of the camera's sight;
// while the queue indexes, the door opens, the crate rolls out and the door closes behind it, so
// the conveyor looks the same at frames 1 and 96.
{
  const y0 = -0.5;
  const y1 = INFEED_Y1 - 0.05;
  const len = y1 - y0;
  const yc = (y0 + y1) / 2;
  const ops = [];
  let g = newGeo();
  for (const sx of [-1, 1]) addBox(g, [CONVEYOR_X + sx * 0.335, yc, 0.735], [0.05, len, 0.13]);
  addBox(g, [CONVEYOR_X, y0 + 0.08, 0.77], [0.62, 0.04, 0.035]); // low end stop
  addBox(g, [CONVEYOR_X, 4.0, 0.48], [0.5, 0.35, 0.3]); // drive box
  ops.push(meshOp('Conveyor_Frame', g), assign('frame', ['Conveyor_Frame']));
  // one leg + half a cross brace; MIRROR across the centre line, ARRAY along the belt
  g = newGeo();
  addBox(g, [0.335, 0, 0.335], [0.06, 0.06, 0.67]);
  addBox(g, [0.17, 0, 0.22], [0.33, 0.04, 0.04]);
  ops.push(
    meshOp('Conveyor_Legs', g, { location: [CONVEYOR_X, y0 + 0.2, 0] }),
    assign('frame', ['Conveyor_Legs']),
  );
  // one roller, axis along X; ARRAY along the object's local Y (= world Y)
  ops.push({
    operator: 'mesh.primitive_cylinder_add',
    params: {
      name: 'Conveyor_Rollers',
      radius: 0.035,
      depth: 0.62,
      vertices: 20,
      location: [CONVEYOR_X, y0 + 0.14, ROLLER_TOP - 0.035],
      rotation: [0, Math.PI / 2, 0],
    },
  });
  ops.push(assign('roller', ['Conveyor_Rollers']), sel(['Conveyor_Rollers']), {
    operator: 'object.shade_smooth',
  });
  // photo-eye sensor post at the pick station
  g = newGeo();
  addBox(g, [CONVEYOR_X - 0.42, 0.25, 0.55], [0.04, 0.04, 0.5]);
  addBox(g, [CONVEYOR_X - 0.42, 0.25, 0.83], [0.06, 0.08, 0.07]);
  ops.push(meshOp('Conveyor_Sensor', g), assign('graphite', ['Conveyor_Sensor']));
  // infeed hood: side walls, roof, back wall and a front wall around a mouth a little wider and
  // taller than a crate; the roll-up door sits just behind the front wall
  g = newGeo();
  const [hx, hz0, hz1, wall] = [0.42, 0.6, 1.66, 0.03];
  const hy = (INFEED_Y0 + INFEED_Y1) / 2;
  const depth = INFEED_Y1 - INFEED_Y0;
  for (const sx of [-1, 1])
    addBox(g, [CONVEYOR_X + sx * (hx - wall / 2), hy, (hz0 + hz1) / 2], [wall, depth, hz1 - hz0]);
  addBox(g, [CONVEYOR_X, hy, hz1 - 0.02], [2 * hx, depth, 0.04]); // roof
  addBox(g, [CONVEYOR_X, INFEED_Y1 - wall / 2, (hz0 + hz1) / 2], [2 * hx, wall, hz1 - hz0]); // back
  for (const sx of [-1, 1])
    addBox(
      g,
      [CONVEYOR_X + (sx * (MOUTH_HALF + hx)) / 2, INFEED_Y0 + 0.025, (hz0 + hz1) / 2],
      [hx - MOUTH_HALF, 0.05, hz1 - hz0],
    );
  addBox(g, [CONVEYOR_X, INFEED_Y0 + 0.025, (MOUTH_TOP + hz1) / 2], [2 * hx, 0.05, hz1 - MOUTH_TOP]); // header
  ops.push(meshOp('Infeed_Hood', g), assign('frame', ['Infeed_Hood']));
  g = newGeo();
  addBox(g, [CONVEYOR_X, INFEED_Y0 - 0.003, MOUTH_TOP + 0.12], [2 * hx - 0.06, 0.006, 0.14]); // hazard band over the mouth
  ops.push(meshOp('Infeed_Band', g), assign('stripes', ['Infeed_Band']));
  g = newGeo();
  const [dz0, dz1] = [ROLLER_TOP + 0.005, MOUTH_TOP + 0.025];
  addBox(g, [CONVEYOR_X, DOOR_Y, (dz0 + dz1) / 2], [2 * MOUTH_HALF + 0.02, 0.02, dz1 - dz0]);
  ops.push(meshOp('Infeed_Door', g), assign('fence', ['Infeed_Door']));
  await batch(ops, 'conveyor');
  const rollers = Math.floor((y1 - 0.15 - (y0 + 0.14)) / 0.12) + 1;
  await tool('add_modifier', {
    object: 'Conveyor_Legs',
    type: 'MIRROR',
    params: { use_axis: [true, false, false] },
  });
  await tool('add_modifier', {
    object: 'Conveyor_Legs',
    type: 'ARRAY',
    params: {
      count: 4,
      use_relative_offset: false,
      use_constant_offset: true,
      constant_offset_displace: [0, (len - 0.4) / 3, 0],
    },
  });
  await tool('add_modifier', {
    object: 'Conveyor_Rollers',
    type: 'ARRAY',
    params: {
      count: rollers,
      use_relative_offset: false,
      use_constant_offset: true,
      constant_offset_displace: [0, 0.12, 0],
    },
  });
  log(`conveyor: ${rollers} rollers (ARRAY), mirrored + arrayed legs, infeed hood with roll-up door`);
}
// Pallets: one deck board, one block and one base board, multiplied with ARRAY modifiers
// (a second, stacked set adds a Z ARRAY on top: a stack of empty pallets in the back corner)
async function buildPallet(prefix, [cx, cy], rotZ, stack = 1) {
  const names = [`${prefix}_Deck`, `${prefix}_Blocks`, `${prefix}_Base`];
  const ops = [];
  let g = newGeo();
  addBox(g, [0, -0.44, 0.133], [1.2, 0.12, 0.022]);
  ops.push(meshOp(names[0], g, { location: [cx, cy, 0], rotation: [0, 0, rotZ] }));
  g = newGeo();
  addBox(g, [-0.54, -0.44, 0.072], [0.12, 0.12, 0.1]);
  ops.push(meshOp(names[1], g, { location: [cx, cy, 0], rotation: [0, 0, rotZ] }));
  g = newGeo();
  addBox(g, [0, -0.44, 0.011], [1.2, 0.12, 0.022]);
  ops.push(meshOp(names[2], g, { location: [cx, cy, 0], rotation: [0, 0, rotZ] }));
  const arr = (object, name, count, d) => ({
    operator: 'object.modifier_add',
    params: {
      object,
      type: 'ARRAY',
      name,
      params: { count, use_relative_offset: false, use_constant_offset: true, constant_offset_displace: d },
    },
  });
  ops.push(arr(names[0], 'Boards', 5, [0, 0.22, 0]));
  ops.push(arr(names[1], 'Blocks X', 3, [0.54, 0, 0]));
  ops.push(arr(names[1], 'Blocks Y', 3, [0, 0.44, 0]));
  ops.push(arr(names[2], 'Boards', 3, [0, 0.44, 0]));
  if (stack > 1) for (const n of names) ops.push(arr(n, 'Stack', stack, [0, 0, 0.144]));
  await batch(ops, prefix);
  return names;
}
{
  const main = await buildPallet('Pallet', PALLET_C, 0);
  const stack = await buildPallet('PalletStack', [-2.62, 1.75], -0.12, 5);
  await op('material.preset_apply', { preset: 'wood', name: 'Pallet Pine', objects: [...main, ...stack] });
  await op('material.procedural_set', {
    material: 'Pallet Pine',
    channel: 'base_color',
    procedural: { color_a: [0.42, 0.27, 0.13], color_b: [0.62, 0.45, 0.25] },
  });
  log('pallets: deck boards, blocks and base boards as ARRAY modifiers (+ a 5-high stack)');
}
// Crate: ribbed plastic tote (one mesh), shared by every crate (linked duplicates)
{
  const g = newGeo();
  const [w, d, h] = CRATE;
  addBox(g, [0, 0, 0], [w - 0.02, d - 0.02, h - 0.01]);
  addBox(g, [0, 0, h / 2 - 0.0175], [w, d, 0.035]);
  addBox(g, [0, 0, -h / 2 + 0.0175], [w, d, 0.035]);
  addBox(g, [0, 0, 0], [w - 0.008, d - 0.008, 0.03]);
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      addBox(g, [sx * (w / 2 - 0.0225), sy * (d / 2 - 0.0225), 0], [0.035, 0.035, h - 0.02]);
  const label = addBox(g, [0, -d / 2 + 0.0035, 0.07], [0.16, 0.01, 0.06]);
  await batch(
    [meshOp('Crate', g, { location: PICK }), assign('crate', ['Crate'], 0), assign('label', ['Crate'], 1)],
    'crate',
  );
  await tool('edit_mesh', {
    object: 'Crate',
    operator: 'object.material_slot_assign',
    params: { index: 1 },
    selection: { faces: [...Array(6).keys()].map((i) => label.f + i) },
  });
  await tool('add_modifier', { object: 'Crate', type: 'BEVEL', params: { width: 0.004, segments: 2 } });
  const copies = [
    ...QUEUED.map((name, i) => [name, [PICK[0], PICK[1] + (i + 1) * QUEUE_PITCH, PICK[2]]]),
    ['Crate_Pallet1', SLOT(-1, 1)],
    ['Crate_Pallet2', SLOT(1, 1)],
    ['Crate_Pallet3', SLOT(1, -1)],
  ];
  for (const [name, loc] of copies) {
    await tool('duplicate_object', { object: 'Crate', linked: true, name });
    await tool('transform_object', { object: name, location: loc });
  }
  log(
    `crates: active + ${copies.length} linked duplicates (${QUEUED.length} queued on the conveyor, 3 on the pallet)`,
  );
}

// ---------------------------------------------------------------------------------------------
// 7. Safety fence (generator), sign, controller cabinet with signal tower, light curtain
// ---------------------------------------------------------------------------------------------
{
  const fence = {
    height: 2.0,
    post_spacing: 1.3,
    post_width: 0.07,
    style: 'RAIL',
    rails: 3,
    location: [0, 0, 0],
    materials: false,
  };
  await op('object.generate_fence', {
    ...fence,
    name: 'Fence_West',
    points: [
      [-2.2, 2.75],
      [-3.35, 2.75],
      [-3.35, -2.6],
    ],
  });
  await op('object.generate_fence', {
    ...fence,
    name: 'Fence_East',
    points: [
      [-0.9, 2.75],
      [2.75, 2.75],
      [2.75, -2.6],
    ],
  });
  // Welded-mesh infill panels between the posts (thin dark boxes whose alpha is the wire grid
  // below). The BRICK mortar lines (the wires) are 8 mm wide and centred on multiples of 5 cm in
  // object space, so the panel edges are placed where they cannot leave loose wire ends: the top
  // edge (1.804) lies inside the generated top rail (rail centres 0.6 / 1.2 / 1.8 m, 63 mm tall,
  // 28 mm thick), the bottom edge (0.196) closes on a full horizontal wire, and the side edges end
  // 25 mm from the post centres, inside the 70 mm posts.
  const g = newGeo();
  const PANEL_Z = [0.196, 1.804];
  const panel = (a, b) => {
    const L = dist(a, b);
    const n = Math.max(1, Math.ceil(L / 1.3 - 1e-6));
    for (let i = 0; i < n; i++) {
      const p = add(a, mul(sub(b, a), (i + 0.5) / n));
      const s = L / n - 0.05;
      const alongX = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]);
      const [z0, z1] = PANEL_Z;
      addBox(g, [p[0], p[1], (z0 + z1) / 2], alongX ? [s, 0.012, z1 - z0] : [0.012, s, z1 - z0]);
    }
  };
  panel([-2.2, 2.75], [-3.35, 2.75]);
  panel([-3.35, 2.75], [-3.35, -2.6]);
  panel([-0.9, 2.75], [2.75, 2.75]);
  panel([2.75, 2.75], [2.75, -2.6]);
  await batch(
    [
      assign('fence', ['Fence_West', 'Fence_East']),
      meshOp('Fence_Panels', g),
      assign('mesh', ['Fence_Panels']),
    ],
    'fence',
  );
  // grid of wires through a procedural BRICK alpha (mortar = wire, bricks = holes)
  await op('material.update', { material: MAT.mesh.name, blend_method: 'CLIP' });
  await op('material.procedural_set', {
    material: MAT.mesh.name,
    channel: 'alpha',
    procedural: {
      type: 'BRICK',
      mapping: 'OBJECT',
      scale: 1,
      color_a: [0, 0, 0],
      color_b: [0, 0, 0],
      params: {
        plane: 'WALL',
        brick_width: 0.05,
        row_height: 0.05,
        mortar_size: 0.004,
        mortar_smooth: 0,
        offset: 0,
        mortar_r: 1,
        mortar_g: 1,
        mortar_b: 1,
      },
    },
  });
  log('safety fence: generate_fence (2 runs) + welded-mesh panels');
}
{
  const ops = [];
  let g = newGeo();
  addBox(g, [1.0, 2.715, 1.35], [1.25, 0.02, 0.42]);
  ops.push(meshOp('Sign_Plate', g), assign('sign', ['Sign_Plate']));
  ops.push({
    operator: 'object.text_add',
    params: {
      name: 'Sign_Title',
      body: 'CELL 04 - PALLETIZING',
      size: 0.12,
      align_x: 'CENTER',
      extrude: 0.002,
      location: [1.0, 2.7, 1.4],
      rotation: [Math.PI / 2, 0, 0],
    },
  });
  ops.push({
    operator: 'object.text_add',
    params: {
      name: 'Sign_Warning',
      body: 'AUTOMATIC MACHINE - KEEP OUT',
      size: 0.065,
      align_x: 'CENTER',
      extrude: 0.002,
      location: [1.0, 2.7, 1.235],
      rotation: [Math.PI / 2, 0, 0],
    },
  });
  ops.push(assign('text', ['Sign_Title', 'Sign_Warning']));
  // controller cabinet outside the fence with HMI screen and a signal tower
  const CAB = [2.05, 3.4];
  g = newGeo();
  addBox(g, [CAB[0], CAB[1], 0.95], [0.85, 0.6, 1.9]);
  addBox(g, [CAB[0], CAB[1], 0.05], [0.9, 0.66, 0.1]);
  addBox(g, [CAB[0] + 0.2, CAB[1] - 0.305, 0.95], [0.03, 0.02, 0.3]); // door handle
  ops.push(meshOp('Controller_Cabinet', g), assign('cabinet', ['Controller_Cabinet']));
  g = newGeo();
  addBox(g, [CAB[0] - 0.08, CAB[1] - 0.306, 1.38], [0.38, 0.012, 0.26]);
  ops.push(meshOp('Controller_Screen', g), assign('screen', ['Controller_Screen']));
  g = newGeo();
  addCylinder(g, [CAB[0], CAB[1], 1.98], 0.015, 0.16, 'Z', 12);
  ops.push(meshOp('Signal_Pole', g), assign('steel', ['Signal_Pole']));
  const lamp = (name, z, mat) => {
    const lg = newGeo();
    addCylinder(lg, [CAB[0], CAB[1], z], 0.055, 0.085, 'Z', 24);
    ops.push(meshOp(name, lg), assign(mat, [name]));
  };
  lamp('Signal_Green', 2.105, 'green');
  lamp('Signal_Amber', 2.195, 'amber');
  lamp('Signal_Red', 2.285, 'red');
  // light curtain posts guarding the open front of the cell
  g = newGeo();
  for (const x of [-3.15, 2.55]) {
    addBox(g, [x, -2.6, 0.95], [0.07, 0.07, 1.9]);
    addBox(g, [x, -2.6, 0.03], [0.2, 0.2, 0.06]);
  }
  ops.push(meshOp('LightCurtain_Posts', g), assign('fence', ['LightCurtain_Posts']));
  g = newGeo();
  addBox(g, [-3.112, -2.6, 0.95], [0.006, 0.03, 1.6]);
  addBox(g, [2.512, -2.6, 0.95], [0.006, 0.03, 1.6]);
  ops.push(meshOp('LightCurtain_Emitters', g), assign('curtain', ['LightCurtain_Emitters']));
  // emergency-stop station at the operator side, just outside the light curtain
  // (yellow box, red mushroom button facing the walkway)
  const [ex, ey] = [-3.7, -2.95];
  g = newGeo();
  addBox(g, [ex, ey, 0.55], [0.06, 0.06, 1.1]);
  addBox(g, [ex, ey, 0.02], [0.24, 0.24, 0.04]);
  ops.push(meshOp('EStop_Post', g), assign('graphite', ['EStop_Post']));
  g = newGeo();
  addBox(g, [ex, ey - 0.04, 1.16], [0.17, 0.12, 0.17]);
  ops.push(meshOp('EStop_Box', g), assign('sign', ['EStop_Box']));
  g = newGeo();
  addCylinder(g, [ex, ey - 0.115, 1.17], 0.022, 0.04, 'Y', 20);
  addCylinder(g, [ex, ey - 0.15, 1.17], 0.045, 0.03, 'Y', 28);
  ops.push(meshOp('EStop_Button', g), assign('button', ['EStop_Button']));
  // floor cable protector from the fence to the robot base (trapezoid profile, hazard striped)
  g = newGeo();
  {
    const [ya, yb, xc] = [0.47, 2.72, 0.22];
    const prof = [
      [0.13, 0],
      [-0.13, 0],
      [-0.05, 0.045],
      [0.05, 0.045],
    ];
    for (const y of [ya, yb]) for (const [dx, z] of prof) g.v.push([r6(xc + dx), y, z]);
    g.f.push([0, 1, 2, 3].reverse(), [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]);
  }
  ops.push(meshOp('Cable_Protector', g), assign('stripes', ['Cable_Protector']));
  ops.push(sel(['Signal_Pole', 'Signal_Green', 'Signal_Amber', 'Signal_Red', 'EStop_Button']), {
    operator: 'object.shade_auto_smooth',
    params: { angle: 0.6 },
  });
  await batch(ops, 'props');
  log('sign, controller cabinet, signal tower, light curtain, e-stop, cable protector');
}

// Factory hall around the cell: corrugated walls (north, west, east) with strips of windows and
// steel columns. The corrugation is a WAVE bump on the normal channel; its bands run along the
// wall, so the side walls get their own material with the waves along Y.
{
  const ops = [];
  let g = newGeo();
  addBox(g, [0.4, 7.2, 3.5], [17.6, 0.2, 7]);
  ops.push(meshOp('Hall_Wall_North', g), assign('wall', ['Hall_Wall_North']));
  g = newGeo();
  addBox(g, [-8.2, -1, 3.5], [0.2, 16.6, 7]);
  addBox(g, [9.1, -1, 3.5], [0.2, 16.6, 7]);
  ops.push(meshOp('Hall_Walls_Side', g), assign('wallSide', ['Hall_Walls_Side']));
  g = newGeo();
  // mullioned window strips: 3 x 2 panes per bay
  for (let x = -7.2; x <= 8; x += 2.05)
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 2; j++) addBox(g, [x - 0.57 + i * 0.57, 7.08, 2.48 + j * 0.56], [0.52, 0.04, 0.5]);
  for (const wx of [-8.08, 8.98])
    for (let y = -4.5; y <= 6.5; y += 2.05)
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 2; j++) addBox(g, [wx, y - 0.57 + i * 0.57, 2.48 + j * 0.56], [0.04, 0.52, 0.5]);
  ops.push(meshOp('Hall_Windows', g), assign('window', ['Hall_Windows']));
  g = newGeo();
  for (const x of [-6, -2, 2, 6]) addBox(g, [x, 6.9, 3.5], [0.35, 0.35, 7]);
  for (const y of [-4, 0, 4]) addBox(g, [-7.9, y, 3.5], [0.35, 0.35, 7]);
  for (const y of [-4, 0, 4]) addBox(g, [8.8, y, 3.5], [0.35, 0.35, 7]);
  ops.push(meshOp('Hall_Columns', g), assign('column', ['Hall_Columns']));
  await batch(ops, 'hall');
  const corrugation = (material, direction) => ({
    operator: 'material.procedural_set',
    params: {
      material,
      channel: 'normal',
      procedural: {
        type: 'WAVE',
        mapping: 'OBJECT',
        scale: 2.2,
        params: { wave_type: 'BANDS', direction, wave_profile: 'SIN', bump_distance: 0.02 },
      },
    },
  });
  await batch([corrugation(MAT.wall.name, 'X'), corrugation(MAT.wallSide.name, 'Y')], 'wall corrugation');
  log('factory hall: walls (WAVE bump corrugation), window strips, columns');
}

// Status lamp: the amber light of the signal tower blinks while the cell runs (driver)
{
  const d = await op('anim.driver_add', {
    target_type: 'material',
    target: MAT.amber.name,
    path: 'emission_strength',
    expression: '14 * (fract(frame / 12) < 0.5)',
  });
  const drv = d.drivers?.[0] ?? d;
  log(
    `driver on '${MAT.amber.name}'.emission_strength = ${drv.expression ?? JSON.stringify(d).slice(0, 160)}`,
  );
}

// ---------------------------------------------------------------------------------------------
// 8. Animation: IK target path, J1 yaw, J4 wrist roll, gripper shape key, conveyor queue
// ---------------------------------------------------------------------------------------------
const frames = [];
for (let f = 1; f <= FRAME_END; f++) frames.push(f);
const tgt = frames.map(targetAt);
const yaw = frames.map((f) => cylAt(f).az);
const keyMany = (target, pathName, index, fr, values, interpolation = 'LINEAR', extra = {}) => ({
  operator: 'anim.keyframes_insert_many',
  params: {
    target,
    path: pathName,
    index,
    frames: fr,
    values: values.map((v) => r6(v)),
    interpolation,
    ...extra,
  },
});
await batch(
  [
    keyMany(
      'IK_Target',
      'location',
      0,
      frames,
      tgt.map((p) => p[0]),
    ),
    keyMany(
      'IK_Target',
      'location',
      1,
      frames,
      tgt.map((p) => p[1]),
    ),
    keyMany(
      'IK_Target',
      'location',
      2,
      frames,
      tgt.map((p) => p[2]),
    ),
    // J4 rolls against the base yaw (the target azimuth, which the IK turns J1 to) so the gripper
    // and the crate keep their heading
    keyMany(
      'Robot_Rig',
      'pose.bones["J4_Wrist"].rotation_euler',
      1,
      frames,
      yaw.map((a) => a - Math.PI),
    ),
  ],
  'arm keys',
);
// gripper fingers: shape key keyed over time
for (const [f, v] of [
  [1, 0],
  [F_GRIP_START, 0],
  [F_GRIPPED, 1],
  [F_RELEASE, 1],
  [F_OPEN, 0],
])
  await tool('insert_keyframe', {
    object: 'Robot_Gripper',
    property: 'shape_keys["Grip"].value',
    frame: f,
    value: v,
    interpolation: 'BEZIER',
  });
// The active crate waits at the pick station (its own location is keyed at frame 1 so the
// place keys added in step 9 do not leak backwards). While the robot carries it away the
// conveyor indexes: every queued crate moves one pitch towards the pick station, and the infeed
// door lifts to let the hidden crate out (smooth BEZIER keys on the door's Z location).
{
  const fr = frames.filter((f) => f >= F_INDEX_START && f <= F_INDEX_END);
  await batch(
    [
      ...[0, 1, 2].map((i) => keyMany('Crate', 'location', i, [1], [PICK[i]], 'CONSTANT')),
      ...QUEUED.map((name, i) =>
        keyMany(
          name,
          'location',
          1,
          fr,
          fr.map((f) => PICK[1] + (i + 1) * QUEUE_PITCH - beltAt(f)),
        ),
      ),
      keyMany(
        'Infeed_Door',
        'location',
        2,
        DOOR_KEYS.map(([f]) => f),
        DOOR_KEYS.map(([, z]) => z),
        'BEZIER',
      ),
    ],
    'crate + conveyor keys',
  );
}
log(
  `keyed ${FRAME_END} frames of IK target / J4 roll, gripper shape key, ${QUEUED.length} queued crates, infeed door`,
);

// ---------------------------------------------------------------------------------------------
// 9. The crate follows the gripper while carried: Child Of (J4_Wrist bone) with keyed influence
// ---------------------------------------------------------------------------------------------
{
  await op('scene.frame_set', { frame: F_GRIPPED });
  const c = await op('object.constraint_add', {
    object: 'Crate',
    type: 'CHILD_OF',
    name: 'Carried',
    target: 'Robot_Rig',
    subtarget: 'J4_Wrist',
  });
  if (c.errors?.length) throw new Error(`Child Of errors: ${JSON.stringify(c.errors)}`);
  const atGrip = await op('constraint.describe', { object: 'Crate', frame: F_GRIPPED });
  log(
    `Child Of inverse set at frame ${F_GRIPPED}: crate at ${fmt(atGrip.world_location)} (pick ${fmt(PICK)})`,
  );
  await tool('insert_keyframe', {
    object: 'Crate',
    property: 'constraints["Carried"].influence',
    frame: 1,
    value: 0,
    interpolation: 'CONSTANT',
  });
  await tool('insert_keyframe', {
    object: 'Crate',
    property: 'constraints["Carried"].influence',
    frame: F_GRIPPED,
    value: 1,
    interpolation: 'CONSTANT',
  });
  // where the gripper sets the crate down -> becomes the crate's own (keyed) transform
  const atPlace = await op('constraint.describe', { object: 'Crate', frame: F_RELEASE });
  const L = atPlace.world_location;
  const R = atPlace.world_rotation_euler;
  log(
    `crate at release frame ${F_RELEASE}: ${fmt(L)} rot ${fmt(R)} (slot ${fmt(PLACE)}, error ${(dist(L, PLACE) * 1000).toFixed(1)} mm)`,
  );
  await batch(
    [
      keyMany('Crate', 'location', 0, [F_RELEASE], [L[0]], 'CONSTANT'),
      keyMany('Crate', 'location', 1, [F_RELEASE], [L[1]], 'CONSTANT'),
      keyMany('Crate', 'location', 2, [F_RELEASE], [L[2]], 'CONSTANT'),
      keyMany('Crate', 'rotation_euler', 2, [1, F_RELEASE], [0, R[2]], 'CONSTANT'),
    ],
    'crate place keys',
  );
  await tool('insert_keyframe', {
    object: 'Crate',
    property: 'constraints["Carried"].influence',
    frame: F_RELEASE,
    value: 0,
    interpolation: 'CONSTANT',
  });
  await op('scene.frame_set', { frame: 1 });
}

// ---------------------------------------------------------------------------------------------
// 10. Camera (Damped Track on the gripper + depth of field), lights, world
// ---------------------------------------------------------------------------------------------
{
  await op('object.camera_add', {
    name: 'Camera',
    lens: CAMERA_LENS,
    clip_start: 0.05,
    clip_end: 60,
    location: CAMERA_LOC,
  });
  await op('object.look_at', { objects: ['Camera'], point: CAMERA_AIM });
  await tool('set_active_camera', { camera: 'Camera' });
  // The camera pans half-way towards the gripper (influence 0.5 keeps the cell framed)
  const ct = await op('object.constraint_add', {
    object: 'Camera',
    type: 'DAMPED_TRACK',
    name: 'Follow Gripper',
    target: 'Robot_Gripper',
    influence: 0.5,
    params: { track_axis: 'TRACK_NEGATIVE_Z' },
  });
  if (ct.errors?.length) throw new Error(`camera constraint: ${JSON.stringify(ct.errors)}`);
  // Depth of field (path tracer): the gripper stays in focus at every frame, the hall softens
  const cam = await op('camera.properties_set', {
    object: 'Camera',
    dof_use: true,
    dof_focus_object: 'Robot_Gripper',
    dof_aperture_fstop: 2.8,
  });
  log(
    `camera: lens ${cam.cameras[0].lens} mm, DOF f/${cam.cameras[0].dof_aperture_fstop} on ${cam.cameras[0].dof_focus_object}`,
  );

  // Lights: two long LED ceiling strips over the cell (RECTANGLE area lights), a warm spot
  // from high front-left that models the robot and throws its shadow across the floor, and a
  // cool rectangular rim behind the robot that separates the arm from the dark hall. The world
  // is a dim blue-grey ambient with mist; the hall windows glow.
  const LIGHTS = [
    {
      name: 'Ceiling_Strip_Front',
      type: 'AREA',
      shape: 'RECTANGLE',
      size: 4.2,
      size_y: 0.45,
      energy: 1000,
      color: [0.93, 0.96, 1.0],
      location: [-0.3, -1.1, 4.5],
    },
    {
      name: 'Ceiling_Strip_Back',
      type: 'AREA',
      shape: 'RECTANGLE',
      size: 4.2,
      size_y: 0.45,
      energy: 800,
      color: [0.93, 0.96, 1.0],
      location: [-0.3, 1.3, 4.5],
    },
    {
      name: 'Key_Spot',
      type: 'SPOT',
      energy: 5000,
      spot_size: 0.9,
      spot_blend: 0.6,
      shadow_soft_size: 0.35,
      color: [1.0, 0.8, 0.58],
      location: [-3.6, -3.6, 5.2],
      aim: [0.1, -0.2, 0.9],
    },
    {
      name: 'Rim_Cool',
      type: 'AREA',
      shape: 'RECTANGLE',
      size: 3.0,
      size_y: 1.0,
      energy: 2000,
      color: [0.55, 0.72, 1.0],
      location: [1.2, 4.2, 3.3],
      aim: [0.0, 0.0, 1.2],
    },
  ];
  await batch(
    LIGHTS.flatMap(({ aim, ...l }) => [
      { operator: 'object.light_add', params: l },
      ...(aim ? [{ operator: 'object.look_at', params: { objects: [l.name], point: aim } }] : []),
    ]),
    'lights',
  );
  await tool('set_scene_settings', {
    environment: 'NONE',
    world_color: [0.006, 0.007, 0.01],
    world_strength: 1,
    mist_distance: 30,
    mist_color: [0.02, 0.024, 0.032],
  });
  log(
    `lights: ${LIGHTS.map((l) => `${l.name} ${l.shape ?? l.type}${l.size ? ` ${l.size}x${l.size_y} m` : ''} ${l.energy} W`).join(', ')}`,
  );
}

// ---------------------------------------------------------------------------------------------
// 11. Verification through MCP queries (evaluated values at several frames); any failed check
//     aborts the build
// ---------------------------------------------------------------------------------------------
const verify = {};
{
  const failures = [];
  const check = (ok, msg) => {
    if (!ok) failures.push(msg);
  };
  const mm = (d) => `${(d * 1000).toFixed(1)} mm`;
  const scene = await tool('get_scene', { max_objects: 5 });
  log(`scene: ${JSON.stringify(scene.counts ?? {}).slice(0, 300)}`);
  check(
    !scene.problems?.length,
    `get_scene problems: ${JSON.stringify(scene.problems ?? []).slice(0, 1500)}`,
  );

  // (a) IK: the wrist reaches the keyed target; (b) the crate rests at the pick station, rides
  // with the gripper while gripped and stays on its pallet slot after the release; (c) fingers
  // (shape key) and Child Of influence evaluated per frame; (d) the camera focus follows the gripper
  let worstIk = 0;
  let worstYaw = 0;
  let worstTilt = 0;
  let worstCarry = 0;
  const focus = [];
  /** Angle difference wrapped to [-pi, pi). */
  const wrap = (a) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
  for (const f of [1, 12, 16, 22, 28, 33, 40, 47, 50, 56, 63, 68, 72, 77, 80, 88, 96]) {
    const d = await op('armature.describe', { object: 'Robot_Rig', frame: f });
    check(!d.errors?.length, `pose errors at ${f}: ${JSON.stringify(d.errors)}`);
    const bone = (n) => d.bones.find((b) => b.name === n);
    const wrist = bone('J4_Wrist').posed_head_world;
    const ikErr = dist(wrist, targetAt(f));
    worstIk = Math.max(worstIk, ikErr);
    // the IK locks keep the base vertical (J1 only yaws) and the arm in the vertical plane through
    // the base axis and the target: J1's yaw (the direction of the shoulder) is the target azimuth
    const [j1h, j1t] = [bone('J1_Base').posed_head_world, bone('J1_Base').posed_tail_world];
    worstTilt = Math.max(worstTilt, Math.hypot(j1t[0] - j1h[0], j1t[1] - j1h[1]) / dist(j1t, j1h));
    const sh = bone('J2_Shoulder').posed_head_world;
    worstYaw = Math.max(worstYaw, Math.abs(wrap(Math.atan2(sh[1], sh[0]) - cylAt(f).az)));
    const crate = await tool('get_object', { object: 'Crate', frame: f });
    const grip = await tool('get_object', { object: 'Robot_Gripper', frame: f });
    const camera = await tool('get_object', { object: 'Camera', frame: f });
    const carried = f >= F_GRIPPED && f < F_RELEASE;
    const want = carried ? sub(wrist, [0, 0, GRIP_DROP]) : f < F_GRIPPED ? PICK : PLACE;
    const carryErr = dist(crate.world_location, want);
    worstCarry = Math.max(worstCarry, carryErr);
    const influence = crate.constraints.find((c) => c.name === 'Carried').influence;
    const fingers = grip.data.shape_keys.find((k) => k.name === 'Grip').value;
    focus.push(camera.data.dof_focus_distance);
    check(influence === (carried ? 1 : 0), `Child Of influence ${influence} at frame ${f}`);
    if (f > F_GRIPPED && f < F_RELEASE)
      check(fingers > 0.999, `fingers open (${fingers}) while carrying at ${f}`);
    if (f <= F_GRIP_START || f >= F_OPEN) check(fingers < 0.001, `fingers closed (${fingers}) at ${f}`);
    log(
      `  f${String(f).padStart(2)} wrist IK err ${mm(ikErr)} | crate ${fmt(crate.world_location)} (${carried ? 'carried' : f < F_GRIPPED ? 'at pick' : 'on pallet'}, err ${mm(carryErr)})` +
        ` | fingers ${fingers.toFixed(2)} | Child Of ${influence} | focus ${camera.data.dof_focus_distance.toFixed(2)} m`,
    );
  }
  check(worstIk < 0.005, `IK error ${mm(worstIk)}`);
  check(worstTilt < 1e-5, `J1 tilts out of the vertical (sin ${worstTilt})`);
  check(worstYaw < 1e-4, `J1 yaw is ${worstYaw} rad off the target azimuth`);
  check(worstCarry < 0.005, `crate offset error ${mm(worstCarry)}`);
  check(
    Math.max(...focus) - Math.min(...focus) > 0.3,
    `camera focus distance does not follow the gripper: ${focus.join(', ')}`,
  );
  log(
    `worst IK error ${mm(worstIk)}, J1 yaw - target azimuth <= ${((worstYaw * 180) / Math.PI).toExponential(1)} deg, J1 tilt ${worstTilt.toExponential(1)}, worst crate error ${mm(worstCarry)}, focus ${Math.min(...focus).toFixed(2)}..${Math.max(...focus).toFixed(2)} m`,
  );

  // (e) the skinned hose follows the arm: its root stays on the turret fitting (the rest root
  // turned by the J1 yaw: catches sliding up, down or around as well as away from the axis), the
  // stretches in the three clamps stay centred in their rings, and the wrist end keeps its
  // distance to the wrist joint
  const base = await tool('get_mesh_data', {
    object: 'Robot_Hose',
    include: ['vertices'],
    source: 'BASE',
    space: 'WORLD',
    limit: 5000,
  });
  const near = (p, r) =>
    base.vertices
      .map((v, i) => [v, i])
      .filter(([v]) => dist(v, p) < r)
      .map(([, i]) => i);
  const centroid = (verts, idx) =>
    mul(
      idx.reduce((acc, i) => add(acc, verts[i]), [0, 0, 0]),
      1 / idx.length,
    );
  const endIdx = near(HOSE_END, 0.05);
  const startIdx = near(HOSE_START, 0.05);
  const clampIdx = CLAMPS.map(([, p]) => near(p, 0.035));
  check(
    endIdx.length > 3 && startIdx.length > 3 && clampIdx.every((x) => x.length > 3),
    'hose end / clamp rings not found',
  );
  const root0 = centroid(base.vertices, startIdx);
  const endGap = [];
  let rootErr = 0;
  let clampErr = 0;
  for (const f of [1, 16, 28, 45, 56, 72, 77, 96]) {
    const ev = await tool('get_mesh_data', {
      object: 'Robot_Hose',
      include: ['vertices'],
      source: 'EVALUATED',
      space: 'WORLD',
      frame: f,
      limit: 5000,
    });
    const d = await op('armature.describe', { object: 'Robot_Rig', frame: f });
    const bone = (n) => d.bones.find((b) => b.name === n);
    const shoulder = bone('J2_Shoulder').posed_head_world;
    const yawF = Math.atan2(shoulder[1], shoulder[0]);
    const fitting = [
      root0[0] * Math.cos(yawF) - root0[1] * Math.sin(yawF),
      root0[0] * Math.sin(yawF) + root0[1] * Math.cos(yawF),
      root0[2],
    ];
    rootErr = Math.max(rootErr, dist(centroid(ev.vertices, startIdx), fitting));
    for (const [k, [name]] of CLAMPS.entries()) {
      const ring = (await tool('get_object', { object: name, frame: f })).world_location;
      clampErr = Math.max(clampErr, dist(centroid(ev.vertices, clampIdx[k]), ring));
    }
    endGap.push(dist(centroid(ev.vertices, endIdx), bone('J4_Wrist').posed_head_world));
  }
  const spread = (a) => Math.max(...a) - Math.min(...a);
  log(
    `hose (${base.vertices.length} vertices): root off its fitting <= ${mm(rootErr)}, hose off clamp centres <= ${mm(clampErr)}, wrist end - wrist joint ${endGap.map((x) => x.toFixed(4)).join(' / ')} m`,
  );
  check(rootErr < 0.002, `hose root slides off its turret fitting by ${mm(rootErr)}`);
  check(clampErr < 0.002, `hose slides in its clamps by ${mm(clampErr)}`);
  check(spread(endGap) < 0.003, `hose end drifts from the wrist by ${mm(spread(endGap))}`);

  // (f) no part of the arm passes through another one: the hose against the links, housings,
  // motors and gears, and the elbow motor and forearm against the upper arm (scene.measure finds
  // the closest distance between the actual surfaces, intersecting = true where they cross), at
  // frames that cover the whole range of the elbow (78-127 degrees) and the shoulder
  const ARM = [
    'Robot_Hose',
    'Robot_UpperArm',
    'Robot_Forearm',
    'Robot_ElbowMotor',
    'Robot_ElbowHousing',
    'Robot_ElbowGear',
    'Robot_ShoulderHousing',
    'Robot_Turret',
  ];
  const mustClear = (a, b) =>
    a === 'Robot_Hose' ||
    b === 'Robot_Hose' ||
    [a, b].sort().join() === 'Robot_ElbowMotor,Robot_UpperArm' ||
    [a, b].sort().join() === 'Robot_Forearm,Robot_UpperArm';
  const gaps = {};
  for (const f of [1, 13, 17, 29, 41, 45, 49, 57, 65, 73, 77, 89]) {
    const m = await op('scene.measure', { objects: ARM, frame: f });
    for (const p of m.distances)
      if (mustClear(p.a_name, p.b_name)) {
        const key = `${p.a_name.replace('Robot_', '')}/${p.b_name.replace('Robot_', '')}`;
        gaps[key] = Math.min(gaps[key] ?? Infinity, p.intersecting ? -1 : p.surface_distance);
        check(
          !p.intersecting && p.surface_distance > 0.003,
          `${key} at frame ${f}: ${p.intersecting ? 'intersecting' : mm(p.surface_distance)}`,
        );
      }
  }
  const tight = Object.entries(gaps)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 5);
  log(`arm clearances (12 frames): ${tight.map(([k, g]) => `${k} ${mm(g)}`).join(', ')}, ... all >= 3 mm`);

  // (g) clearance between the finger pads and the carried crate
  const m = await op('scene.measure', { objects: ['Robot_Gripper', 'Crate'], frame: 50 });
  const pair = m.distances?.[0] ?? {};
  log(
    `scene.measure @50 gripper <-> crate: surface distance ${pair.surface_distance} m, intersecting ${pair.intersecting}`,
  );
  check(
    pair.intersecting === false && pair.surface_distance < 0.01,
    `gripper/crate clearance ${JSON.stringify(pair)}`,
  );

  // (h) the conveyor loops: every queued crate moves exactly one pitch (the first one onto the
  // pick station), the crate that replaces the last one waits invisible inside the infeed hood at
  // frame 1 (scene.raycast from the camera to its corners hits something else first), the door
  // is closed at frames 1 and 96, open while the crate passes and never touches it
  for (const [i, name] of QUEUED.entries()) {
    const y1 = (await tool('get_object', { object: name, frame: 1 })).world_location[1];
    const y96 = (await tool('get_object', { object: name, frame: FRAME_END })).world_location[1];
    check(Math.abs(y1 - y96 - QUEUE_PITCH) < 1e-3, `${name} moved ${y1 - y96} m instead of one pitch`);
    if (i === 0) check(Math.abs(y96 - PICK[1]) < 1e-3, `${name} does not reach the pick station (${y96})`);
  }
  const hidden = QUEUED[QUEUED.length - 1];
  const eye = (await tool('get_object', { object: 'Camera', frame: 1 })).world_location;
  const c5 = (await tool('get_object', { object: hidden, frame: 1 })).world_location;
  const probes = [c5];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1])
        probes.push(
          add(c5, [sx * (CRATE[0] / 2 - 0.01), sy * (CRATE[1] / 2 - 0.01), sz * (CRATE[2] / 2 - 0.01)]),
        );
  const seen = [];
  for (const q of probes) {
    const hit = await op('scene.raycast', { origin: eye, direction: sub(q, eye), frame: 1 });
    if (!hit.hit || hit.name === hidden) seen.push(fmt(q));
  }
  check(!seen.length, `${hidden} is visible from the camera at frame 1 at ${seen.join(' ')}`);
  const doorZ = async (f) =>
    (await tool('get_object', { object: 'Infeed_Door', frame: f })).world_location[2];
  const [door1, door96] = [await doorZ(1), await doorZ(FRAME_END)];
  check(
    Math.abs(door1) < 1e-4 && Math.abs(door96) < 1e-4,
    `infeed door not closed at frames 1/96 (${door1}, ${door96})`,
  );
  let doorGap = Infinity;
  for (let f = F_INDEX_START; f <= DOOR_KEYS[DOOR_KEYS.length - 1][0]; f += 2) {
    const dm = await op('scene.measure', { objects: ['Infeed_Door', hidden], frame: f });
    const dp = dm.distances[0];
    doorGap = Math.min(doorGap, dp.intersecting ? -1 : dp.surface_distance);
    check(!dp.intersecting, `infeed door intersects ${hidden} at frame ${f}`);
  }
  log(
    `conveyor loop: ${QUEUED.length} queued crates moved one pitch; ${hidden} hidden at frame 1 (${probes.length} camera rays blocked); door closed at 1/96, door <-> crate >= ${mm(doorGap)}`,
  );
  Object.assign(verify, {
    worst_ik_mm: +(worstIk * 1000).toFixed(2),
    j1_yaw_err_deg: +((worstYaw * 180) / Math.PI).toExponential(1),
    worst_crate_mm: +(worstCarry * 1000).toFixed(2),
    pad_gap_m: pair.surface_distance,
    hose_root_mm: +(rootErr * 1000).toFixed(2),
    hose_clamp_mm: +(clampErr * 1000).toFixed(2),
    min_arm_clearance_mm: +(Math.min(...Object.values(gaps)) * 1000).toFixed(1),
  });
  if (failures.length) throw new Error(`verification failed:\n  ${failures.join('\n  ')}`);
  log('verification passed');
}

// ---------------------------------------------------------------------------------------------
// 12. Outputs (see the modes at the top): quick previews, the final renders or the glTF export
// ---------------------------------------------------------------------------------------------
const info = (r) => (typeof r.text === 'string' ? JSON.parse(r.text) : r.text);
async function save(r, file, mime = 'image/png') {
  const item =
    r.resources?.find((x) => x.mimeType === mime && x.blob) ?? r.images?.find((x) => x.mimeType === mime);
  const data = item?.blob ?? item?.data;
  if (!data) throw new Error(`no ${mime} in result: ${JSON.stringify(r).slice(0, 600)}`);
  const buf = Buffer.from(data, 'base64');
  await writeFile(file, buf);
  return buf.length;
}
/** Progress notifications of long renders, at most one line every 15 s. */
function progress(label) {
  let last = 0;
  return (p) => {
    if (Date.now() - last < 15000) return;
    last = Date.now();
    log(`  ${label}: ${p.progress}${p.total ? `/${p.total}` : ''} ${p.message ?? ''}`);
  };
}
async function render(toolName, args, label) {
  const t = Date.now();
  const r = await tool(toolName, args, { onProgress: progress(label) });
  return { r, ms: Date.now() - t, meta: info(r) };
}
/** Samples per pixel the frames of a path-traced render_animation reached (samples_reached). */
function sampleStats(meta) {
  const s = meta.samples_reached;
  if (!s) return { samples_reached: 'not reported' };
  return { spp_min: s.min, spp_mean: s.mean, spp_max: s.max, requested: meta.requested_samples };
}
const timings = { build_s: +((Date.now() - T0) / 1000).toFixed(1), build_mcp_calls: mcpCalls, verify };

if (PREVIEW_DIR) {
  await mkdir(PREVIEW_DIR, { recursive: true });
  for (const f of [1, 22, 33, 47, STILL_FRAME, 66, 77, 90]) {
    const { r, ms } = await render(
      'render_image',
      { engine: 'RASTER', width: 640, height: 360, frame: f },
      `raster ${f}`,
    );
    await save(r, path.join(PREVIEW_DIR, `raster_f${f}.png`));
    log(`preview: RASTER frame ${f} in ${ms} ms`);
  }
  const sheet = await render(
    'render_animation',
    {
      format: 'CONTACT_SHEET',
      engine: 'RASTER',
      frame_start: 1,
      frame_end: FRAME_END,
      frame_step: 4,
      width: 320,
      height: 180,
      columns: 6,
      time_limit: 300,
    },
    'raster contact sheet',
  );
  await save(sheet.r, path.join(PREVIEW_DIR, 'contact_raster.png'));
  log(`preview: RASTER contact sheet in ${sheet.ms} ms`);
  const pt = await render(
    'render_image',
    {
      engine: 'PATHTRACER',
      width: 640,
      height: 360,
      frame: STILL_FRAME,
      samples: 32,
      max_bounces: 4,
      denoise: true,
      time_limit: 45,
    },
    'path traced preview',
  );
  await save(pt.r, path.join(PREVIEW_DIR, `pt_f${STILL_FRAME}.png`));
  log(`preview: path traced frame ${STILL_FRAME} in ${pt.ms} ms, ${pt.meta.samples} spp`);
}

if (FINAL_RENDERS) {
  if (!ANIM_ONLY) {
    // Final still: path traced, denoised; sampling stops at the time limit
    const { r, ms, meta } = await render(
      'render_image',
      {
        engine: 'PATHTRACER',
        width: 1280,
        height: 720,
        frame: STILL_FRAME,
        samples: 256,
        max_bounces: 6,
        denoise: true,
        time_limit: STILL_TIME,
      },
      'render.png',
    );
    const bytes = await save(r, path.join(HERE, 'render.png'));
    timings.still = {
      s: +(ms / 1000).toFixed(1),
      samples: meta.samples,
      requested: meta.requested_samples,
      threads: meta.threads,
      bytes,
    };
    log(`render.png: ${JSON.stringify(timings.still)}`);
  }
  if (!STILL_ONLY) {
    // Contact sheet: 24 path-traced frames of the cycle (every 4th frame), denoised
    let { r, ms, meta } = await render(
      'render_animation',
      {
        format: 'CONTACT_SHEET',
        engine: 'PATHTRACER',
        frame_start: 1,
        frame_end: FRAME_END,
        frame_step: 4,
        width: 320,
        height: 180,
        columns: 6,
        samples: 12,
        max_bounces: 4,
        denoise: true,
        frame_time_limit: 10,
        time_limit: 300,
      },
      'contact_sheet.png',
    );
    if (meta.truncated) throw new Error(`contact_sheet.png truncated: ${JSON.stringify(meta).slice(0, 600)}`);
    let bytes = await save(r, path.join(HERE, 'contact_sheet.png'));
    timings.contact_sheet = {
      s: +(ms / 1000).toFixed(1),
      frames: meta.frames?.length,
      undersampled: meta.undersampled_frames?.length ?? 0,
      ...sampleStats(meta),
      bytes,
    };
    log(`contact_sheet.png: ${JSON.stringify(timings.contact_sheet)}`);
    // preview.gif: the whole 96-frame cycle as 48 path-traced frames (every 2nd frame, 12 fps)
    ({ r, ms, meta } = await render(
      'render_animation',
      {
        format: 'GIF',
        engine: 'PATHTRACER',
        frame_start: 1,
        frame_end: FRAME_END - 1,
        frame_step: 2,
        width: 480,
        height: 270,
        samples: 16,
        max_bounces: 4,
        denoise: true,
        frame_time_limit: 15,
        time_limit: 600,
        dither: 'BAYER',
      },
      'preview.gif',
    ));
    if (meta.truncated) throw new Error(`preview.gif truncated: ${JSON.stringify(meta).slice(0, 600)}`);
    bytes = await save(r, path.join(HERE, 'preview.gif'), 'image/gif');
    if (bytes > 6e6) log(`WARNING: preview.gif is ${(bytes / 1e6).toFixed(2)} MB (limit 6 MB)`);
    timings.gif = {
      s: +(ms / 1000).toFixed(1),
      frames: meta.frames?.length,
      undersampled: meta.undersampled_frames?.length ?? 0,
      ...sampleStats(meta),
      bytes,
    };
    log(`preview.gif: ${JSON.stringify(timings.gif)} ${JSON.stringify(meta).slice(0, 400)}`);
  }
}

if (EXPORT_ONLY) {
  // glTF binary of the live, rigged scene at frame 1 (the exporter samples the animation over the
  // frame range: IK, constraints, the shape key as a morph target, the skinned hose as a skin)
  const t = Date.now();
  const r = await tool('export_scene', { format: 'glb', frame: 1 });
  const meta = info(r);
  const bytes = await save(r, path.join(HERE, 'scene.glb'), 'model/gltf-binary');
  timings.glb = {
    s: +((Date.now() - t) / 1000).toFixed(1),
    export_ms: meta.elapsed_ms,
    bytes,
    warnings: meta.warnings ?? [],
  };
  log(
    `scene.glb: ${(bytes / 1e6).toFixed(2)} MB in ${timings.glb.s} s; warnings: ${JSON.stringify(meta.warnings ?? []).slice(0, 1500)}`,
  );
}

log(`done in ${((Date.now() - T0) / 1000).toFixed(1)} s`);
console.log(`TIMINGS ${JSON.stringify(timings)}`);
await mcp.close();
