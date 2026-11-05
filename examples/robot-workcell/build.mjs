#!/usr/bin/env node
/**
 * Robot palletizing workcell — built from scratch through the 3D editor's MCP server.
 *
 *   MCP_URL=http://127.0.0.1:8080/mcp node examples/robot-workcell/build.mjs [options]
 *
 * Options
 *   --no-render        build and verify the scene only (no render, no export)
 *   --preview=DIR      also write quick RASTER previews + a contact sheet into DIR (not the outputs)
 *   --still-only       final outputs: only render.png
 *   --skip-still       final outputs: skip render.png (GIF, contact sheet, GLB only)
 *
 * Outputs (next to this script): render.png (path traced still), preview.gif (48-frame
 * pick-and-place cycle), contact_sheet.png, scene.glb.
 *
 * Everything is created through MCP tools (create_project, run_operator, batch, insert_keyframe,
 * set_scene_settings, render_image, render_animation, export_scene …). Sizes are metres, Z is up.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../../scripts/mcp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = 'robot-workcell';
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const NO_RENDER = flag('no-render');
const PREVIEW_DIR = option('preview');
const STILL_ONLY = flag('still-only');
const SKIP_STILL = flag('skip-still');

const T0 = Date.now();
const timings = {};
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s]`, ...a);

const mcp = await connect();

// ---------------------------------------------------------------------------------------------
// MCP helpers
// ---------------------------------------------------------------------------------------------
async function call(tool, args = {}, opts) {
  try {
    return await mcp.call(tool, args, opts);
  } catch (e) {
    const shown = JSON.stringify(args, (k, v) => (Array.isArray(v) && v.length > 12 ? `[${v.length} items]` : v));
    throw new Error(`${tool} failed: ${e.message}\n  args: ${shown.slice(0, 1500)}`);
  }
}
const tool = (name, args = {}, opts) => call(name, { project: PROJECT, ...args }, opts);
async function op(operator, params = {}, selection) {
  const r = await tool('run_operator', { operator, params, ...(selection ? { selection } : {}) });
  for (const rep of r.reports ?? []) if (rep.level !== 'INFO') log(`  ${operator}: ${rep.level} ${rep.message}`);
  return r.result;
}
async function batch(operations, label = 'batch') {
  for (let i = 0; i < operations.length; i += 200) {
    const r = await tool('batch', { operations: operations.slice(i, i + 200) });
    if (!r.ok) throw new Error(`${label}: ${JSON.stringify(r).slice(0, 2000)}`);
  }
}
const sel = (objects, active) => ({ operator: 'object.select', params: { objects, ...(active ? { active } : {}) } });

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
    for (const y of [cy - sy / 2, cy + sy / 2]) for (const x of [cx - sx / 2, cx + sx / 2]) g.v.push([r6(x), r6(y), r6(z)]);
  for (const q of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]])
    g.f.push(q.map((i) => vb + i));
  return { v: vb, f: fb, nv: 8, nf: 6 };
}
/** Box tapering along local Z from (w0 x d0) at z0 to (w1 x d1) at z1 (w along X, d along Y). */
function addTaperBox(g, z0, z1, [w0, d0], [w1, d1], [ox, oy] = [0, 0]) {
  const vb = g.v.length;
  const fb = g.f.length;
  for (const [z, w, d] of [[z0, w0, d0], [z1, w1, d1]])
    for (const y of [-d / 2, d / 2]) for (const x of [-w / 2, w / 2]) g.v.push([r6(ox + x), r6(oy + y), r6(z)]);
  for (const q of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]])
    g.f.push(q.map((i) => vb + i));
  return { v: vb, f: fb };
}
/** Closed cylinder around `axis` ('X' | 'Y' | 'Z') centred at c. */
function addCylinder(g, c, radius, length, axis = 'Z', segments = 32) {
  const vb = g.v.length;
  const fb = g.f.length;
  const map = (a, b, h) =>
    axis === 'Z' ? [c[0] + a, c[1] + b, c[2] + h] : axis === 'Y' ? [c[0] + a, c[1] + h, c[2] + b] : [c[0] + h, c[1] + a, c[2] + b];
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
const CAMERA_LOC = [0.45, -6.1, 2.55];
const CAMERA_AIM = [0.0, 0.0, 1.05];
const STILL_FRAME = 47;
const F_GRIP_START = 28;
const F_GRIPPED = 33; // fingers closed: the crate starts to follow the gripper
const F_RELEASE = 72; // crate set down on the pallet
const F_OPEN = 77;
const F_CRATE_ARRIVES = 18;
const CRATE_START_Y = 2.3;

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
const crateYAt = (f) => {
  const u = Math.min(1, Math.max(0, (f - 1) / (F_CRATE_ARRIVES - 1)));
  return CRATE_START_Y * (1 - (1 - (1 - u) ** 3));
};

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
  paint: { name: 'Robot Teal Paint', base_color: [0.012, 0.23, 0.26, 1], roughness: 0.3, coat_weight: 0.6, coat_roughness: 0.08 },
  graphite: { name: 'Graphite Housing', base_color: [0.025, 0.027, 0.03, 1], metallic: 0.55, roughness: 0.38 },
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
  screen: { name: 'HMI Screen', base_color: [0.02, 0.02, 0.02, 1], roughness: 0.2, emission_color: [0.2, 0.55, 1.0], emission_strength: 3 },
  green: { name: 'Lamp Green', base_color: [0.05, 0.5, 0.1, 1], roughness: 0.3, emission_color: [0.1, 1.0, 0.25], emission_strength: 12 },
  amber: { name: 'Lamp Amber', base_color: [0.6, 0.35, 0.02, 1], roughness: 0.3, emission_color: [1.0, 0.55, 0.05], emission_strength: 0 },
  red: { name: 'Lamp Red', base_color: [0.5, 0.03, 0.02, 1], roughness: 0.3, emission_color: [1.0, 0.05, 0.03], emission_strength: 0 },
  button: { name: 'EStop Red', base_color: [0.55, 0.02, 0.015, 1], roughness: 0.25, coat_weight: 0.5 },
  sign: { name: 'Sign Yellow', base_color: [0.9, 0.7, 0.05, 1], roughness: 0.5 },
  text: { name: 'Sign Black', base_color: [0.01, 0.01, 0.01, 1], roughness: 0.5 },
  wall: { name: 'Corrugated Wall', base_color: [0.05, 0.058, 0.066, 1], metallic: 0.35, roughness: 0.5 },
  window: { name: 'Hall Window', base_color: [0.05, 0.06, 0.08, 1], roughness: 0.1, emission_color: [0.35, 0.5, 0.85], emission_strength: 0.75 },
  column: { name: 'Column Paint', base_color: [0.16, 0.17, 0.18, 1], metallic: 0.3, roughness: 0.5 },
  curtain: { name: 'Light Curtain Red', base_color: [0.3, 0.01, 0.01, 1], roughness: 0.3, emission_color: [1.0, 0.04, 0.02], emission_strength: 6 },
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
            color_a: [0.07, 0.075, 0.08],
            color_b: [0.14, 0.145, 0.15],
          },
        },
      },
      {
        operator: 'material.procedural_set',
        params: {
          material: MAT.floor.name,
          channel: 'roughness',
          procedural: { type: 'NOISE', mapping: 'OBJECT', scale: 2.5, detail: 4, color_a: [0.12, 0.12, 0.12], color_b: [0.36, 0.36, 0.36] },
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
            params: { wave_type: 'BANDS', direction: 'DIAGONAL', wave_profile: 'SAW', ramp_interpolation: 'CONSTANT' },
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
await op('object.armature_add', { name: 'Robot_Rig', bone_name: 'J1_Base', location: [0, 0, 0], radius: 0.4 });
await op('armature.bone_update', { object: 'Robot_Rig', bone: 'J1_Base', head: J1_HEAD, tail: J1_TAIL });
const chain = await op('armature.chain_add', {
  object: 'Robot_Rig',
  points: [SHOULDER, ELBOW, WRIST, WRIST_TAIL],
  names: ['J2_Shoulder', 'J3_Elbow', 'J4_Wrist'],
  parent: 'J1_Base',
  use_connect: false,
});
await op('armature.properties_set', { object: 'Robot_Rig', display_type: 'STICK', show_names: true });
log(`armature bones: J1_Base + ${chain.bones.join(', ')} (lengths ${chain.lengths.join(', ')})`);

const robotParts = []; // [object name, material key, bone]
{
  const ops = [];
  // Static base (not rigged)
  let g = newGeo();
  addBox(g, [0, 0, 0.03], [0.9, 0.9, 0.06]);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) addCylinder(g, [sx * 0.36, sy * 0.36, 0.075], 0.03, 0.03, 'Z', 12);
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
  const LU = dist(ELBOW, SHOULDER);
  g = newGeo();
  addTaperBox(g, 0.1, LU - 0.1, [0.24, 0.24], [0.17, 0.2]);
  ops.push(meshOp('Robot_UpperArm', g, { location: SHOULDER, rotation: [0, Math.atan2(dU[0], dU[2]), 0] }));
  robotParts.push(['Robot_UpperArm', 'paint', 'J2_Shoulder']);

  // J3: elbow housing, rear motor, forearm
  g = newGeo();
  addCylinder(g, ELBOW, 0.14, 0.28, 'Y', 40);
  ops.push(meshOp('Robot_ElbowHousing', g));
  robotParts.push(['Robot_ElbowHousing', 'graphite', 'J3_Elbow']);
  const dF = norm(sub(WRIST, ELBOW));
  const LF = dist(WRIST, ELBOW);
  g = newGeo();
  addTaperBox(g, -0.34, -0.12, [0.15, 0.15], [0.15, 0.15]);
  addCylinder(g, [0, 0, -0.38], 0.085, 0.08, 'Z', 28);
  ops.push(meshOp('Robot_ElbowMotor', g, { location: ELBOW, rotation: [0, Math.atan2(dF[0], dF[2]), 0] }));
  robotParts.push(['Robot_ElbowMotor', 'graphite', 'J3_Elbow']);
  g = newGeo();
  addTaperBox(g, 0.08, LF - 0.06, [0.19, 0.18], [0.13, 0.14]);
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
await op('object.generate_gear', { name: 'Robot_SlewRing', teeth: 60, radius: 0.335, tooth_depth: 0.02, thickness: 0.05, bore: 0.25, location: [0, 0, 0.345] });
await op('object.generate_gear', { name: 'Robot_ShoulderGear', teeth: 28, radius: 0.16, tooth_depth: 0.022, thickness: 0.035, bore: 0.05, location: [SHOULDER[0], 0.235, SHOULDER[2]], rotation: [Math.PI / 2, 0, 0] });
await op('object.generate_gear', { name: 'Robot_ElbowGear', teeth: 22, radius: 0.125, tooth_depth: 0.018, thickness: 0.03, bore: 0.04, location: [ELBOW[0], 0.155, ELBOW[2]], rotation: [Math.PI / 2, 0, 0] });
robotParts.push(['Robot_SlewRing', 'steel', 'J1_Base'], ['Robot_ShoulderGear', 'steel', 'J2_Shoulder'], ['Robot_ElbowGear', 'steel', 'J3_Elbow']);

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

// Materials + smooth shading + bone parenting of every rigid part
{
  const ops = [];
  for (const [name, mat] of robotParts) if (mat) ops.push(assign(mat, [name]));
  ops.push(assign('paint', ['Robot_Turret']));
  const smooth = robotParts.map(([n]) => n).concat(['Robot_BasePlate', 'Robot_Pedestal']);
  ops.push(sel(smooth), { operator: 'object.shade_auto_smooth', params: { angle: 0.6 } });
  for (const bone of ['J1_Base', 'J2_Shoulder', 'J3_Elbow', 'J4_Wrist']) {
    const kids = robotParts.filter(([, , b]) => b === bone).map(([n]) => n);
    ops.push({ operator: 'object.parent_to', params: { objects: kids, parent: 'Robot_Rig', type: 'BONE', bone } });
  }
  ops.push({ operator: 'object.parent_to', params: { objects: ['Robot_BasePlate', 'Robot_Pedestal'], parent: 'Robot_Rig', type: 'OBJECT' } });
  await batch(ops, 'robot materials + bone parenting');
  log(`bone-parented ${robotParts.length} rigid parts`);
}

// Dress-pack hose along the arm, skinned with automatic weights so it bends with the joints
{
  const nB = [-dirOf(SHOULDER, ELBOW)[2], 0, dirOf(SHOULDER, ELBOW)[0]]; // behind the upper arm
  function dirOf(a, b) {
    return norm(sub(b, a));
  }
  const dU = dirOf(SHOULDER, ELBOW);
  const dF = dirOf(ELBOW, WRIST);
  const up = [-dF[2], 0, dF[0]];
  const pts = [
    [-0.3, 0, 0.63],
    [-0.31, 0, 0.74],
    [-0.22, 0, 0.9],
    add(add(SHOULDER, mul(dU, 0.35)), mul(nB, 0.17)),
    add(add(SHOULDER, mul(dU, 0.7)), mul(nB, 0.165)),
  ];
  for (const a of [150, 118, 85]) {
    const t = (a * Math.PI) / 180;
    pts.push([ELBOW[0] + 0.235 * Math.cos(t), 0, ELBOW[2] + 0.235 * Math.sin(t)]);
  }
  for (const t of [0.35, 0.68, 0.9]) pts.push(add(add(ELBOW, mul(dF, t)), mul(up, 0.135)));
  pts.push([WRIST[0] - 0.04, 0, WRIST[2] + 0.12]);
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
    radius: 0.032,
    segments: 14,
    bend_radius: 0,
    closed_ends: true,
    location: [0, 0, 0],
  });
  const weights = await op(
    'object.parent_set',
    { type: 'ARMATURE_AUTO' },
    { objects: ['Robot_Hose', 'Robot_Rig'], active: 'Robot_Rig' },
  );
  await batch([assign('rubber', ['Robot_Hose']), sel(['Robot_Hose']), { operator: 'object.shade_smooth' }], 'hose');
  log(`hose: ${hose.vertices} vertices, auto weights -> ${JSON.stringify(weights.vertex_groups)}`);
  // clamps holding the hose (bone-parented rings)
  const clampOps = [];
  const clampAt = (name, p, dir, bone) => {
    clampOps.push({
      operator: 'mesh.primitive_torus_add',
      params: { name, major_radius: 0.042, minor_radius: 0.011, major_segments: 24, minor_segments: 8, location: p, rotation: [0, Math.atan2(dir[0], dir[2]), 0] },
    });
    clampOps.push(assign('steel', [name]));
    clampOps.push({ operator: 'object.parent_to', params: { objects: [name], parent: 'Robot_Rig', type: 'BONE', bone } });
  };
  clampAt('Robot_HoseClamp1', pts[3], dU, 'J2_Shoulder');
  clampAt('Robot_HoseClamp2', pts[4], dU, 'J2_Shoulder');
  clampAt('Robot_HoseClamp3', pts[9], dF, 'J3_Elbow');
  await batch(clampOps, 'hose clamps');
}

// ---------------------------------------------------------------------------------------------
// 5. IK rig: target empty (keyframed), wrist aim, IK + Damped Track
// ---------------------------------------------------------------------------------------------
await batch(
  [
    { operator: 'object.empty_add', params: { name: 'IK_Target', type: 'SPHERE', radius: 0.08, location: WRIST } },
    { operator: 'object.empty_add', params: { name: 'Wrist_Aim', type: 'PLAIN_AXES', radius: 0.05, location: sub(WRIST, [0, 0, 1]) } },
    { operator: 'object.parent_to', params: { objects: ['Wrist_Aim'], parent: 'IK_Target' } },
  ],
  'ik helpers',
);
const ik = await op('pose.ik_add', { object: 'Robot_Rig', bone: 'J3_Elbow', target: 'IK_Target', chain_count: 2, iterations: 500 });
await op('pose.constraint_add', {
  object: 'Robot_Rig',
  bone: 'J4_Wrist',
  type: 'DAMPED_TRACK',
  name: 'Keep Vertical',
  target: 'Wrist_Aim',
  params: { track_axis: 'TRACK_Y' },
});
log(`IK on J3_Elbow, chain ${ik.chain.join(' -> ')}; Damped Track keeps the wrist vertical`);

// ---------------------------------------------------------------------------------------------
// 6. Conveyor (rollers via ARRAY), pallet (ARRAY boards), crates
// ---------------------------------------------------------------------------------------------
{
  const len = 5.2;
  const y0 = -0.5;
  const yc = y0 + len / 2;
  const ops = [];
  let g = newGeo();
  for (const sx of [-1, 1]) addBox(g, [CONVEYOR_X + sx * 0.335, yc, 0.735], [0.05, len, 0.13]);
  addBox(g, [CONVEYOR_X, y0 + 0.08, 0.77], [0.62, 0.04, 0.035]); // low end stop
  addBox(g, [CONVEYOR_X, len + y0 - 0.25, 0.48], [0.5, 0.35, 0.3]); // drive box
  ops.push(meshOp('Conveyor_Frame', g), assign('frame', ['Conveyor_Frame']));
  // one leg + half a cross brace; MIRROR across the centre line, ARRAY along the belt
  g = newGeo();
  addBox(g, [0.335, 0, 0.335], [0.06, 0.06, 0.67]);
  addBox(g, [0.17, 0, 0.22], [0.33, 0.04, 0.04]);
  ops.push(meshOp('Conveyor_Legs', g, { location: [CONVEYOR_X, y0 + 0.2, 0] }), assign('frame', ['Conveyor_Legs']));
  // one roller, axis along X; ARRAY along the object's local Y (= world Y)
  ops.push({
    operator: 'mesh.primitive_cylinder_add',
    params: { name: 'Conveyor_Rollers', radius: 0.035, depth: 0.62, vertices: 20, location: [CONVEYOR_X, y0 + 0.14, ROLLER_TOP - 0.035], rotation: [0, Math.PI / 2, 0] },
  });
  ops.push(assign('roller', ['Conveyor_Rollers']), sel(['Conveyor_Rollers']), { operator: 'object.shade_smooth' });
  // photo-eye sensor post at the pick station
  g = newGeo();
  addBox(g, [CONVEYOR_X - 0.42, 0.25, 0.55], [0.04, 0.04, 0.5]);
  addBox(g, [CONVEYOR_X - 0.42, 0.25, 0.83], [0.06, 0.08, 0.07]);
  ops.push(meshOp('Conveyor_Sensor', g), assign('graphite', ['Conveyor_Sensor']));
  await batch(ops, 'conveyor');
  await tool('add_modifier', { object: 'Conveyor_Legs', type: 'MIRROR', params: { use_axis: [true, false, false] } });
  await tool('add_modifier', { object: 'Conveyor_Legs', type: 'ARRAY', params: { count: 4, use_relative_offset: false, use_constant_offset: true, constant_offset_displace: [0, 1.55, 0] } });
  await tool('add_modifier', { object: 'Conveyor_Rollers', type: 'ARRAY', params: { count: 42, use_relative_offset: false, use_constant_offset: true, constant_offset_displace: [0, 0.12, 0] } });
  log('conveyor: 42 rollers (ARRAY), mirrored + arrayed legs');
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
    params: { object, type: 'ARRAY', name, params: { count, use_relative_offset: false, use_constant_offset: true, constant_offset_displace: d } },
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
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) addBox(g, [sx * (w / 2 - 0.0225), sy * (d / 2 - 0.0225), 0], [0.035, 0.035, h - 0.02]);
  const label = addBox(g, [0, -d / 2 + 0.0035, 0.07], [0.16, 0.01, 0.06]);
  await batch(
    [
      meshOp('Crate', g, { location: [PICK[0], CRATE_START_Y, PICK[2]] }),
      assign('crate', ['Crate'], 0),
      assign('label', ['Crate'], 1),
    ],
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
    ['Crate_Queued', [PICK[0], 3.25, PICK[2]]],
    ['Crate_Pallet1', SLOT(-1, 1)],
    ['Crate_Pallet2', SLOT(1, 1)],
    ['Crate_Pallet3', SLOT(1, -1)],
  ];
  for (const [name, loc] of copies) {
    await tool('duplicate_object', { object: 'Crate', linked: true, name });
    await tool('transform_object', { object: name, location: loc });
  }
  log(`crates: active + ${copies.length} linked duplicates`);
}

// ---------------------------------------------------------------------------------------------
// 7. Safety fence (generator), sign, controller cabinet with signal tower, light curtain
// ---------------------------------------------------------------------------------------------
{
  const fence = { height: 2.0, post_spacing: 1.3, post_width: 0.07, style: 'RAIL', rails: 3, location: [0, 0, 0], materials: false };
  await op('object.generate_fence', { ...fence, name: 'Fence_West', points: [[-2.2, 2.75], [-3.35, 2.75], [-3.35, -2.6]] });
  await op('object.generate_fence', { ...fence, name: 'Fence_East', points: [[-0.9, 2.75], [2.75, 2.75], [2.75, -2.6]] });
  // welded-mesh infill panels between the posts (thin dark boxes)
  const g = newGeo();
  const panel = (a, b) => {
    const L = dist(a, b);
    const n = Math.max(1, Math.ceil(L / 1.3 - 1e-6));
    for (let i = 0; i < n; i++) {
      const p = add(a, mul(sub(b, a), (i + 0.5) / n));
      const s = L / n - 0.1;
      const alongX = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]);
      addBox(g, [p[0], p[1], 1.05], alongX ? [s, 0.012, 1.75] : [0.012, s, 1.75]);
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
      params: { plane: 'WALL', brick_width: 0.05, row_height: 0.05, mortar_size: 0.004, mortar_smooth: 0, offset: 0, mortar_r: 1, mortar_g: 1, mortar_b: 1 },
    },
  });
  log('safety fence: generate_fence (2 runs) + welded-mesh panels');
}
{
  const ops = [];
  let g = newGeo();
  addBox(g, [1.0, 2.715, 1.35], [1.25, 0.02, 0.42]);
  ops.push(meshOp('Sign_Plate', g), assign('sign', ['Sign_Plate']));
  ops.push({ operator: 'object.text_add', params: { name: 'Sign_Title', body: 'CELL 04 - PALLETIZING', size: 0.12, align_x: 'CENTER', extrude: 0.002, location: [1.0, 2.70, 1.40], rotation: [Math.PI / 2, 0, 0] } });
  ops.push({ operator: 'object.text_add', params: { name: 'Sign_Warning', body: 'AUTOMATIC MACHINE - KEEP OUT', size: 0.065, align_x: 'CENTER', extrude: 0.002, location: [1.0, 2.70, 1.235], rotation: [Math.PI / 2, 0, 0] } });
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
  // emergency-stop station inside the light curtain (yellow box, red mushroom button)
  g = newGeo();
  addBox(g, [-2.55, -2.05, 0.55], [0.06, 0.06, 1.1]);
  addBox(g, [-2.55, -2.05, 0.02], [0.24, 0.24, 0.04]);
  ops.push(meshOp('EStop_Post', g), assign('graphite', ['EStop_Post']));
  g = newGeo();
  addBox(g, [-2.55, -2.09, 1.16], [0.17, 0.12, 0.17]);
  ops.push(meshOp('EStop_Box', g), assign('sign', ['EStop_Box']));
  g = newGeo();
  addCylinder(g, [-2.55, -2.165, 1.17], 0.022, 0.04, 'Y', 20);
  addCylinder(g, [-2.55, -2.20, 1.17], 0.045, 0.03, 'Y', 28);
  ops.push(meshOp('EStop_Button', g), assign('button', ['EStop_Button']));
  // floor cable protector from the fence to the robot base (trapezoid profile, hazard striped)
  g = newGeo();
  {
    const [ya, yb, xc] = [0.47, 2.72, 0.22];
    const prof = [[0.13, 0], [-0.13, 0], [-0.05, 0.045], [0.05, 0.045]];
    for (const y of [ya, yb]) for (const [dx, z] of prof) g.v.push([r6(xc + dx), y, z]);
    g.f.push([0, 1, 2, 3].reverse(), [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]);
  }
  ops.push(meshOp('Cable_Protector', g), assign('stripes', ['Cable_Protector']));
  ops.push(sel(['Signal_Pole', 'Signal_Green', 'Signal_Amber', 'Signal_Red', 'EStop_Button']), { operator: 'object.shade_auto_smooth', params: { angle: 0.6 } });
  await batch(ops, 'props');
  log('sign, controller cabinet, signal tower, light curtain, e-stop, cable protector');
}

// Factory hall behind the cell: corrugated walls with a strip of windows, steel columns
{
  const ops = [];
  let g = newGeo();
  addBox(g, [-1, 7.2, 3.5], [20, 0.2, 7]);
  addBox(g, [-8.2, -1, 3.5], [0.2, 16.6, 7]);
  ops.push(meshOp('Hall_Walls', g), assign('wall', ['Hall_Walls']));
  g = newGeo();
  // mullioned window strips: 3 x 2 panes per bay
  for (let x = -7.2; x <= 7; x += 2.05)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) addBox(g, [x - 0.57 + i * 0.57, 7.08, 2.48 + j * 0.56], [0.52, 0.04, 0.5]);
  for (let y = -4.5; y <= 6.5; y += 2.05)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) addBox(g, [-8.08, y - 0.57 + i * 0.57, 2.48 + j * 0.56], [0.04, 0.52, 0.5]);
  ops.push(meshOp('Hall_Windows', g), assign('window', ['Hall_Windows']));
  g = newGeo();
  for (const x of [-6, -2, 2, 6]) addBox(g, [x, 6.9, 3.5], [0.35, 0.35, 7]);
  for (const y of [-4, 0, 4]) addBox(g, [-7.9, y, 3.5], [0.35, 0.35, 7]);
  ops.push(meshOp('Hall_Columns', g), assign('column', ['Hall_Columns']));
  await batch(ops, 'hall');
  await op('material.procedural_set', {
    material: MAT.wall.name,
    channel: 'normal',
    procedural: { type: 'WAVE', mapping: 'OBJECT', scale: 2.2, params: { wave_type: 'BANDS', direction: 'X', wave_profile: 'SIN', bump_distance: 0.02 } },
  });
  log('factory hall: walls (WAVE bump corrugation), window strips, columns');
}

// UV maps for the meshes with procedural materials: renders do not need them (OBJECT mapping),
// but the glTF exporter can only bake procedural textures to PNG through UVs.
for (const object of ['Floor', 'Hazard_Border', 'Hazard_RobotZone', 'Cable_Protector', 'Fence_Panels', 'Hall_Walls',
  'Pallet_Deck', 'Pallet_Blocks', 'Pallet_Base', 'PalletStack_Deck', 'PalletStack_Blocks', 'PalletStack_Base'])
  await tool('edit_mesh', { object, operator: 'uv.smart_project', params: { island_margin: 0.01 } });

// Status lamp: the amber light of the signal tower blinks while the cell runs (driver)
{
  const d = await op('anim.driver_add', {
    target_type: 'material',
    target: MAT.amber.name,
    path: 'emission_strength',
    expression: '14 * (fract(frame / 12) < 0.5)',
  });
  log(`driver on '${MAT.amber.name}'.emission_strength: ${JSON.stringify(d).slice(0, 200)}`);
}

// ---------------------------------------------------------------------------------------------
// 8. Animation: IK target path, J1 yaw, J4 wrist roll, gripper shape key, conveyor crate
// ---------------------------------------------------------------------------------------------
const frames = [];
for (let f = 1; f <= FRAME_END; f++) frames.push(f);
const tgt = frames.map(targetAt);
const yaw = frames.map((f) => cylAt(f).az);
const keyMany = (target, pathName, index, fr, values, interpolation = 'LINEAR', extra = {}) => ({
  operator: 'anim.keyframes_insert_many',
  params: { target, path: pathName, index, frames: fr, values: values.map((v) => r6(v)), interpolation, ...extra },
});
await batch(
  [
    keyMany('IK_Target', 'location', 0, frames, tgt.map((p) => p[0])),
    keyMany('IK_Target', 'location', 1, frames, tgt.map((p) => p[1])),
    keyMany('IK_Target', 'location', 2, frames, tgt.map((p) => p[2])),
    keyMany('Robot_Rig', 'pose.bones["J1_Base"].rotation_euler', 1, frames, yaw),
    // J4 rolls against the base yaw so the gripper (and the crate) keep their heading
    keyMany('Robot_Rig', 'pose.bones["J4_Wrist"].rotation_euler', 1, frames, yaw.map((a) => a - Math.PI)),
  ],
  'arm keys',
);
// gripper fingers: shape key keyed over time
for (const [f, v] of [[1, 0], [F_GRIP_START, 0], [F_GRIPPED, 1], [F_RELEASE, 1], [F_OPEN, 0]])
  await tool('insert_keyframe', { object: 'Robot_Gripper', property: 'shape_keys["Grip"].value', frame: f, value: v, interpolation: 'BEZIER' });
// crate rides the conveyor to the pick station, then holds
{
  const fr = frames.filter((f) => f < F_CRATE_ARRIVES);
  await batch(
    [
      keyMany('Crate', 'location', 1, fr, fr.map(crateYAt)),
      keyMany('Crate', 'location', 1, [F_CRATE_ARRIVES], [0], 'CONSTANT'),
      keyMany('Crate', 'location', 0, [1], [PICK[0]], 'CONSTANT'),
      keyMany('Crate', 'location', 2, [1], [PICK[2]], 'CONSTANT'),
    ],
    'crate conveyor keys',
  );
}
log(`keyed ${FRAME_END} frames of IK target / J1 yaw / J4 roll, gripper shape key and conveyor crate`);

// ---------------------------------------------------------------------------------------------
// 9. The crate follows the gripper while carried: Child Of (J4_Wrist bone) with keyed influence
// ---------------------------------------------------------------------------------------------
{
  await op('scene.frame_set', { frame: F_GRIPPED });
  const c = await op('object.constraint_add', { object: 'Crate', type: 'CHILD_OF', name: 'Carried', target: 'Robot_Rig', subtarget: 'J4_Wrist' });
  if (c.errors?.length) throw new Error(`Child Of errors: ${JSON.stringify(c.errors)}`);
  const atGrip = await op('constraint.describe', { object: 'Crate', frame: F_GRIPPED });
  log(`Child Of inverse set at frame ${F_GRIPPED}: crate at ${fmt(atGrip.world_location)} (pick ${fmt(PICK)})`);
  await tool('insert_keyframe', { object: 'Crate', property: 'constraints["Carried"].influence', frame: 1, value: 0, interpolation: 'CONSTANT' });
  await tool('insert_keyframe', { object: 'Crate', property: 'constraints["Carried"].influence', frame: F_GRIPPED, value: 1, interpolation: 'CONSTANT' });
  // where the gripper sets the crate down -> becomes the crate's own (keyed) transform
  const atPlace = await op('constraint.describe', { object: 'Crate', frame: F_RELEASE });
  const L = atPlace.world_location;
  const R = atPlace.world_rotation_euler;
  log(`crate at release frame ${F_RELEASE}: ${fmt(L)} rot ${fmt(R)} (slot ${fmt(PLACE)}, error ${(dist(L, PLACE) * 1000).toFixed(1)} mm)`);
  await batch(
    [
      keyMany('Crate', 'location', 0, [F_RELEASE], [L[0]], 'CONSTANT'),
      keyMany('Crate', 'location', 1, [F_RELEASE], [L[1]], 'CONSTANT'),
      keyMany('Crate', 'location', 2, [F_RELEASE], [L[2]], 'CONSTANT'),
      keyMany('Crate', 'rotation_euler', 2, [1, F_RELEASE], [0, R[2]], 'CONSTANT'),
    ],
    'crate place keys',
  );
  await tool('insert_keyframe', { object: 'Crate', property: 'constraints["Carried"].influence', frame: F_RELEASE, value: 0, interpolation: 'CONSTANT' });
  await op('scene.frame_set', { frame: 1 });
}

// ---------------------------------------------------------------------------------------------
// 10. Camera (Damped Track on the gripper), lights, world
// ---------------------------------------------------------------------------------------------
{
  await op('object.camera_add', { name: 'Camera', lens: 28, location: CAMERA_LOC });
  await op('object.look_at', { objects: ['Camera'], point: CAMERA_AIM });
  await tool('set_active_camera', { camera: 'Camera' });
  const ct = await op('object.constraint_add', {
    object: 'Camera',
    type: 'DAMPED_TRACK',
    name: 'Follow Gripper',
    target: 'Robot_Gripper',
    influence: 0.5,
    params: { track_axis: 'TRACK_NEGATIVE_Z' },
  });
  if (ct.errors?.length) throw new Error(`camera constraint: ${JSON.stringify(ct.errors)}`);
  // Dark factory hall: large soft area lights (warm key over the cell, cool rim behind the
  // robot, dim fill from the front-left); the world is a dark blue-grey ambient.
  const LIGHTS = [
    { name: 'Key_Area', energy: 2400, color: [1.0, 0.92, 0.82], size: 2.6, location: [0.6, -1.7, 5.2], aim: [0.0, -0.2, 0.8] },
    { name: 'Rim_Area', energy: 2100, color: [0.7, 0.84, 1.0], size: 3, location: [-1.2, 4.4, 3.9], aim: [-0.2, 0, 1.2] },
    { name: 'Fill_Area', energy: 260, color: [0.85, 0.9, 1.0], size: 3, location: [-3.8, -4.6, 3.2], aim: [0.0, -0.2, 0.8] },
  ];
  await batch(
    LIGHTS.map((l) => ({ operator: 'object.light_add', params: { name: l.name, type: 'AREA', energy: l.energy, color: l.color, location: l.location } })),
    'lights',
  );
  for (const l of LIGHTS) {
    await op('object.look_at', { objects: [l.name], point: l.aim });
    // object.light_add ignores `radius` for area lights and data.set_property cannot resolve the
    // light datablock by name, so the size is set through a (constant) keyframe on data.size.
    for (const prop of ['size', 'size_y']) await tool('insert_keyframe', { object: l.name, property: `data.${prop}`, frame: 1, value: l.size });
  }
  await tool('set_scene_settings', { environment: 'NONE', world_color: [0.022, 0.026, 0.034], world_strength: 1, mist_distance: 32, mist_color: [0.035, 0.042, 0.055] });
  log('camera with Damped Track on the gripper, three area lights, dark world');
}

// ---------------------------------------------------------------------------------------------
// 11. Verification through MCP queries
// ---------------------------------------------------------------------------------------------
{
  const scene = await tool('get_scene', { max_objects: 5 });
  log(`scene: ${JSON.stringify(scene.counts ?? scene.stats ?? {}).slice(0, 300)}`);
  if (scene.problems?.length) log(`PROBLEMS: ${JSON.stringify(scene.problems).slice(0, 1500)}`);
  let worstIk = 0;
  let worstCarry = 0;
  for (const f of [1, 16, 28, 33, 40, 50, 63, 72, 80, 96]) {
    const d = await op('armature.describe', { object: 'Robot_Rig', frame: f });
    const wrist = d.bones.find((b) => b.name === 'J4_Wrist');
    const want = targetAt(f);
    const err = dist(wrist.posed_head_world, want);
    worstIk = Math.max(worstIk, err);
    const crate = await op('constraint.describe', { object: 'Crate', frame: f });
    const expectCrate = f >= F_GRIPPED && f < F_RELEASE ? sub(wrist.posed_head_world, [0, 0, GRIP_DROP]) : null;
    const carry = expectCrate ? dist(crate.world_location, expectCrate) : 0;
    worstCarry = Math.max(worstCarry, carry);
    log(
      `  f${String(f).padStart(2)} wrist ${fmt(wrist.posed_head_world)} target ${fmt(want)} IK err ${(err * 1000).toFixed(1)} mm` +
        ` | crate ${fmt(crate.world_location)}${expectCrate ? ` carry err ${(carry * 1000).toFixed(1)} mm` : ''}`,
    );
    if (d.errors?.length) log(`  pose errors: ${JSON.stringify(d.errors)}`);
  }
  log(`worst IK error ${(worstIk * 1000).toFixed(1)} mm, worst carry offset error ${(worstCarry * 1000).toFixed(1)} mm`);
  // scene.measure works at the agent's current frame: set it first
  await op('scene.frame_set', { frame: 50 });
  const m = await op('scene.measure', { objects: ['Robot_Gripper', 'Crate'] });
  const pair = m.distances?.[0] ?? {};
  log(`scene.measure @50 gripper<->crate: surface distance ${pair.surface_distance} m, intersecting ${pair.intersecting}`);
  await op('scene.frame_set', { frame: 1 });
}

// ---------------------------------------------------------------------------------------------
// 12. Renders and export
// ---------------------------------------------------------------------------------------------
const saveImage = async (r, file) => {
  const img = r.images?.[0] ?? r.resources?.[0];
  const data = img?.data ?? img?.blob;
  if (!data) throw new Error(`no image in result: ${JSON.stringify(r).slice(0, 500)}`);
  await writeFile(file, Buffer.from(data, 'base64'));
  return typeof r.text === 'string' ? r.text : JSON.stringify(r.text);
};
const progress = (label) => (p) => process.stdout.write(`\r  ${label} ${p.progress}${p.total ? `/${p.total}` : ''} ${p.message ?? ''}      `);

if (PREVIEW_DIR) {
  await mkdir(PREVIEW_DIR, { recursive: true });
  for (const f of [1, 33, STILL_FRAME, 61, 72]) {
    const t = Date.now();
    const r = await tool('render_image', { engine: 'RASTER', width: 640, height: 360, frame: f });
    await saveImage(r, path.join(PREVIEW_DIR, `raster_f${f}.png`));
    log(`preview raster frame ${f}: ${Date.now() - t} ms`);
  }
  const t = Date.now();
  const r = await tool('render_animation', { format: 'CONTACT_SHEET', engine: 'RASTER', frame_start: 1, frame_end: FRAME_END, frame_step: 5, width: 320, columns: 5, time_limit: 300 }, { onProgress: progress('contact sheet') });
  await saveImage(r, path.join(PREVIEW_DIR, 'contact_raster.png'));
  log(`\npreview contact sheet: ${Date.now() - t} ms`);
}

if (!NO_RENDER) {
  if (!SKIP_STILL) {
    const t = Date.now();
    const r = await tool(
      'render_image',
      { engine: 'PATHTRACER', width: 1280, height: 720, frame: STILL_FRAME, samples: 160, denoise: true, max_bounces: 6, time_limit: 300 },
      { onProgress: progress('render.png') },
    );
    const info = await saveImage(r, path.join(HERE, 'render.png'));
    timings.still = { ms: Date.now() - t, info: JSON.parse(info) };
    log(`\nrender.png: ${Date.now() - t} ms ${info}`);
  }
  if (!STILL_ONLY) {
    // Contact sheet: 20 path-traced tiles of the cycle. Each frame needs >= 2 samples, because the
    // denoiser cannot filter a 1-sample frame (see README), hence the generous per-frame limit.
    let t = Date.now();
    let r = await tool(
      'render_animation',
      { format: 'CONTACT_SHEET', engine: 'PATHTRACER', frame_start: 1, frame_end: FRAME_END, frame_step: 5, width: 320, height: 180, columns: 5, samples: 3, max_bounces: 3, denoise: true, frame_time_limit: 12, time_limit: 300 },
      { onProgress: progress('contact_sheet.png') },
    );
    let info = await saveImage(r, path.join(HERE, 'contact_sheet.png'));
    timings.contact = { ms: Date.now() - t, info: JSON.parse(info) };
    log(`\ncontact_sheet.png: ${Date.now() - t} ms ${info.slice(0, 300)}`);
    // 48-frame GIF of the whole cycle (frames 1, 3 … 95), low-sample path tracing
    t = Date.now();
    r = await tool(
      'render_animation',
      {
        format: 'GIF',
        engine: 'PATHTRACER',
        frame_start: 1,
        frame_end: FRAME_END - 1,
        frame_step: 2,
        width: 480,
        height: 270,
        samples: 4,
        max_bounces: 3,
        denoise: true,
        frame_time_limit: 20,
        time_limit: 600,
        dither: 'BAYER',
      },
      { onProgress: progress('preview.gif') },
    );
    const gif = r.resources?.find((x) => x.mimeType === 'image/gif') ?? r.images?.[0];
    if (!gif) throw new Error(`no GIF in result: ${JSON.stringify(r).slice(0, 800)}`);
    await writeFile(path.join(HERE, 'preview.gif'), Buffer.from(gif.blob ?? gif.data, 'base64'));
    info = typeof r.text === 'string' ? r.text : JSON.stringify(r.text);
    timings.gif = { ms: Date.now() - t, info: JSON.parse(info) };
    log(`\npreview.gif: ${Date.now() - t} ms ${info.slice(0, 500)}`);

    // GLB: the glTF exporter ignores bone parenting and does not export armatures, IK, constraint
    // results or shape-key animation (see README). Workaround: bake the evaluated motion of the
    // rigid robot parts, the crate and the camera into plain object keyframes (world space,
    // unparented, constraints removed), export without the skinned hose and the rig helpers,
    // then undo the bake so the project keeps its live rig.
    t = Date.now();
    const scene = await tool('get_scene', { max_objects: 1000 });
    const rigid = scene.objects.filter((o) => o.parent === 'Robot_Rig' && o.parent_bone).map((o) => o.name);
    const baked = await op('anim.bake_transforms', {
      objects: [...rigid, 'Crate', 'Camera'],
      frame_start: 1,
      frame_end: FRAME_END,
      step: 1,
      clear_parents: true,
      clear_constraints: true,
      interpolation: 'LINEAR',
    });
    const exclude = new Set(['Robot_Hose', 'Robot_Rig', 'IK_Target', 'Wrist_Aim']);
    r = await tool('export_scene', { format: 'glb', objects: scene.objects.map((o) => o.name).filter((n) => !exclude.has(n)) });
    const undone = await tool('undo', { steps: 1 });
    const check = await tool('get_object', { object: 'Robot_UpperArm' });
    if (check.parent_bone !== 'J2_Shoulder') throw new Error(`undo of the bake failed: ${JSON.stringify(undone)}`);
    const glb = r.resources?.find((x) => x.blob);
    if (!glb) throw new Error(`no GLB in result: ${JSON.stringify(r).slice(0, 800)}`);
    const buf = Buffer.from(glb.blob, 'base64');
    await writeFile(path.join(HERE, 'scene.glb'), buf);
    timings.glb = { ms: Date.now() - t, bytes: buf.length, baked_objects: baked.objects.length };
    log(`scene.glb: ${(buf.length / 1e6).toFixed(2)} MB in ${Date.now() - t} ms (baked ${baked.objects.length} objects, bake undone)`);
  }
}

log(`done in ${((Date.now() - T0) / 1000).toFixed(1)} s ${JSON.stringify(timings)}`);
await mcp.close();
