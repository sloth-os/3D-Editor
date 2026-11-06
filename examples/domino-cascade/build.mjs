#!/usr/bin/env node
/**
 * Domino Cascade — an original rigid-body physics showcase built entirely through the 3D editor's
 * MCP server (no file is touched except the outputs written next to this script).
 *
 * A blue glass marble rolls down a curved aluminium chute (a thick C-shaped profile curve swept
 * along a 3D Bezier path as a bevel object, converted to a mesh) that winds down from a tower of
 * toy blocks, leaves the lip and knocks over the first of 60 rainbow-coloured plastic dominoes
 * standing along an S-curve on a generated oak table. The table, chute, dowels, blocks and floor
 * are PASSIVE colliders, the dominoes ACTIVE boxes and the marble an ACTIVE sphere. The script
 * checks the simulation (every domino must topple, in path order), keys a focus target that
 * follows the marble and then the wave front (camera depth of field), animates a showcase camera,
 * renders inspection contact sheets, bakes the simulation to keyframes (and checks that the keys
 * reproduce it), then renders a path-traced still, a contact sheet and a GIF.
 *
 *   MCP_URL=http://127.0.0.1:4504/mcp node examples/domino-cascade/build.mjs [mode] [options]
 *
 * Modes (default --final):
 *   --final        scene, verify, animate, inspect, bake, still, sheet, gif   (the production run)
 *   --build-only   scene, verify, animate, inspect, bake       (no path tracing: RASTER sheets only)
 *   --preview      scene, verify, animate, bake, preview       (640x360 RASTER + 24 spp path trace)
 *   --export-only  scene, verify, animate, bake, export        (scene.glb only, no renders)
 *   --stages=a,b   any of: scene verify animate inspect bake preview still sheet gif export
 *                  (stages without `scene` work on the existing project, e.g. --stages=still)
 * Options:
 *   --still-samples=N  --still-time=S   path-traced still budget (default 256 spp / 450 s)
 *   --frame=F                           still / preview frame (default 55, mid-cascade)
 *   --draft                             low-sample still / sheet / GIF written to $WORK_DIR/draft
 *                                       instead of next to this script (tests the whole pipeline)
 * Environment: MCP_URL / MCP_TOKEN (endpoint, default http://127.0.0.1:8080/mcp),
 *   WORK_DIR (inspection images and timings.json, default $TMPDIR/domino-cascade-work),
 *   PROJECT_NAME (default domino-cascade).
 */
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../../scripts/mcp.mjs';

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------
const MODES = {
  final: ['scene', 'verify', 'animate', 'inspect', 'bake', 'still', 'sheet', 'gif'],
  'build-only': ['scene', 'verify', 'animate', 'inspect', 'bake'],
  preview: ['scene', 'verify', 'animate', 'bake', 'preview'],
  'export-only': ['scene', 'verify', 'animate', 'bake', 'export'],
};
const KNOWN_STAGES = ['scene', 'verify', 'animate', 'inspect', 'bake', 'preview', 'still', 'sheet', 'gif', 'export'];
const opts = { mode: 'final', stages: null, stillSamples: 256, stillTime: 450, frame: 55, draft: false };
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.replace(/^--/, '').split('=');
  if (MODES[key] && value === undefined) opts.mode = key;
  else if (key === 'stages' && value) opts.stages = value.split(',').map((s) => s.trim()).filter(Boolean);
  else if (key === 'still-samples') opts.stillSamples = Number(value);
  else if (key === 'still-time') opts.stillTime = Number(value);
  else if (key === 'frame') opts.frame = Number(value);
  else if (key === 'draft' && value === undefined) opts.draft = true;
  else throw new Error(`unknown argument '${arg}' (modes: ${Object.keys(MODES).map((m) => '--' + m).join(' ')}; --stages=, --still-samples=, --still-time=, --frame=, --draft)`);
}
const STAGES = new Set(opts.stages ?? MODES[opts.mode]);
for (const s of STAGES) if (!KNOWN_STAGES.includes(s)) throw new Error(`unknown stage '${s}' (known: ${KNOWN_STAGES.join(', ')})`);

const PROJECT = process.env.PROJECT_NAME ?? 'domino-cascade';
const WORK = process.env.WORK_DIR ?? path.join(os.tmpdir(), 'domino-cascade-work');
// final outputs go next to this script (draft outputs to the work directory)
const OUT = opts.draft ? path.join(WORK, 'draft') : path.dirname(fileURLToPath(import.meta.url));
// render budgets: [samples, time_limit s]; --draft = a quick check of the whole pipeline
const BUDGET = opts.draft
  ? { still: [16, 60], still_size: [640, 360], sheet: [2, 120], gif: [2, 240] }
  : { still: [opts.stillSamples, opts.stillTime], still_size: [1280, 720], sheet: [16, 240], gif: [10, 480] };
const STILL_FRAME = opts.frame; // mid-cascade: the wave front is half way along the S
const timings = {};

// ---------------------------------------------------------------------------------------------
// Scene dimensions (metres, Z up)
// ---------------------------------------------------------------------------------------------
const TABLE = { width: 2.6, depth: 1.5, height: 0.75, top: 0.05, leg: 0.09 };
const TOP = TABLE.height; // z of the table top
const DOMINO = { h: 0.08, w: 0.04, t: 0.014, mass: 0.047, count: 60 }; // jumbo toy dominoes
const S_CURVE = { x0: -0.9, y0: 0.0, amplitude: 0.35, wavelength: 2.0 };
const MARBLE = { r: 0.014, mass: 0.029 }; // 28 mm glass marble
const CHUTE = {
  radius: 0.022, // inner radius of the channel
  wall: 0.003, // wall thickness of the swept C-section
  arc: 140, // degrees of the circle the channel covers (180 = half-pipe); shallower shows the marble
  startHeight: 0.25, // centreline height above the table at the tower
  lipBottom: 0.046, // channel floor height above the table at the lip (marble centre at 0.06)
  gap: 0.05, // lip-to-first-domino-centre distance along the path
  leadIn: 0.15, // straight run leaving the tower (heading -X)
  bendRadius: 0.24,
  runOut: 0.14, // straight run into the lip
};
// Main camera: three-quarter view from the front right that frames the whole S and the chute
// (azimuth -50 deg, elevation 22 deg, 45 mm); f/2 depth of field focused on the "Focus Target".
const CAMERA = { location: [1.54, -1.73, 1.74], target: [0.183, 0.161, 0.802], lens: 45, fstop: 2.0 };
// Showcase camera (GIF / contact sheet): starts close on the chute while the marble rolls, then
// pulls back to the main camera's framing while the wave runs (keys at SHOWCASE.frames).
const SHOWCASE = {
  start: { location: [-0.05, -0.75, 1.3], target: [-0.88, 0.18, 0.84] },
  frames: [26, 60],
  lens: 45,
  fstop: 2.8,
};
const FPS = 24;
const FRAME_END = 100; // the last domino lands near frame 80; everything is at rest by ~90

// ---------------------------------------------------------------------------------------------
// MCP helpers: every tool error throws (with the tool name and arguments), warnings are printed
// ---------------------------------------------------------------------------------------------
const mcp = await connect(process.env.MCP_URL ?? 'http://127.0.0.1:8080/mcp');
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

async function call(tool, args = {}) {
  const started = Date.now();
  try {
    const r = await mcp.call(tool, { project: PROJECT, ...args }, {
      onProgress: (p) => process.stderr.write(`    progress ${p.progress}${p.total ? '/' + p.total : ''} ${p.message ?? ''}\n`),
    });
    const ms = Date.now() - started;
    if (ms > 2000) log(`  ${tool} took ${(ms / 1000).toFixed(1)} s`);
    return r;
  } catch (e) {
    throw new Error(`${tool} ${JSON.stringify(args).slice(0, 300)} failed: ${e.message.slice(0, 2000)}`);
  }
}

const printReports = (operator, reports) => {
  for (const rep of reports ?? []) if (rep.level !== 'INFO') log(`  ${operator} ${rep.level}: ${rep.message}`);
};

/**
 * run_operator; returns the operator's result and prints its warnings. Operators that act on the
 * selection (transform_apply, shade_smooth, convert ...) get it through run_operator's
 * `selection` (`select`); unknown parameters are rejected by the server.
 */
async function op(operator, params = {}, select = null) {
  const r = await call('run_operator', { operator, params, ...(select ? { selection: { objects: select } } : {}) });
  printReports(operator, r.reports);
  return r.result;
}

/** batch: many operators as one undo step (chunks of 200); stops and throws at the first error. */
async function batch(operations) {
  const results = [];
  for (let i = 0; i < operations.length; i += 200) {
    const r = await call('batch', { operations: operations.slice(i, i + 200) });
    for (const it of r.results) printReports(it.operator, it.reports);
    results.push(...r.results);
  }
  return results;
}

function save(name, data) {
  const file = path.isAbsolute(name) ? name : path.join(WORK, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(data, 'base64'));
  log(`  wrote ${file} (${(statSync(file).size / 1024).toFixed(0)} KB)`);
  return file;
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers (all placements are computed here and sent as plain numbers)
// ---------------------------------------------------------------------------------------------
const deg = (d) => (d * Math.PI) / 180;
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Dense polyline of the S-curve y = y0 - A sin(k (x - x0)), x0..x0+λ, with arc lengths. */
function sCurve() {
  const { x0, y0, amplitude: A, wavelength: lam } = S_CURVE;
  const k = (2 * Math.PI) / lam;
  const pts = [];
  let s = 0;
  const M = 4000;
  for (let i = 0; i <= M; i++) {
    const x = x0 + (i / M) * lam;
    const y = y0 - A * Math.sin(k * (x - x0));
    if (i) s += Math.hypot(x - pts[i - 1].x, y - pts[i - 1].y);
    pts.push({ x, y, s });
  }
  return pts;
}

/** Point and heading at arc length s on a dense polyline. */
function atLength(pts, s) {
  let i = 1;
  while (i < pts.length - 1 && pts[i].s < s) i++;
  const a = pts[i - 1];
  const b = pts[i];
  const f = (s - a.s) / (b.s - a.s || 1);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, heading: Math.atan2(b.y - a.y, b.x - a.x) };
}

/** Domino placements: equal arc-length spacing, centre and heading (local +X = direction of fall). */
function dominoLayout() {
  const pts = sCurve();
  const L = pts[pts.length - 1].s;
  const spacing = L / (DOMINO.count - 1);
  const out = [];
  for (let i = 0; i < DOMINO.count; i++) {
    const p = atLength(pts, i * spacing);
    out.push({ x: p.x, y: p.y, z: TOP + DOMINO.h / 2, heading: p.heading });
  }
  return { dominoes: out, length: L, spacing };
}

/**
 * Chute centreline: lead-in heading -X from the tower, a left-hand bend, a straight run-out
 * ending at the lip aligned with the first domino; heights fall with (1-u)^2 so the channel
 * is steep at the top and level at the lip.
 */
function chutePath(first) {
  const ds = 0.005;
  const plan = [];
  let x = 0;
  let y = 0;
  let th = Math.PI; // heading -X
  const step = () => {
    x += Math.cos(th) * ds;
    y += Math.sin(th) * ds;
    plan.push([x, y]);
  };
  plan.push([x, y]);
  const turn = first.heading - Math.PI + 2 * Math.PI; // left turn from -X to the domino heading
  const turnAngle = ((turn % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  for (let s = 0; s < CHUTE.leadIn - 1e-9; s += ds) step();
  const nArc = Math.round((CHUTE.bendRadius * turnAngle) / ds);
  for (let i = 0; i < nArc; i++) {
    th += turnAngle / nArc;
    step();
  }
  for (let s = 0; s < CHUTE.runOut - 1e-9; s += ds) step();
  // translate so the end sits at the lip, CHUTE.gap before the first domino
  const end = plan[plan.length - 1];
  const lip = [first.x - Math.cos(first.heading) * CHUTE.gap, first.y - Math.sin(first.heading) * CHUTE.gap];
  const off = [lip[0] - end[0], lip[1] - end[1]];
  const L = (plan.length - 1) * ds;
  const zS = TOP + CHUTE.startHeight;
  const zE = TOP + CHUTE.lipBottom + CHUTE.radius;
  const dense = plan.map(([px, py], i) => {
    const u = (i * ds) / L;
    return [px + off[0], py + off[1], zE + (zS - zE) * (1 - u) ** 2];
  });
  return { dense, length: L, headingEnd: th, lip };
}

/**
 * Domino colours: a rainbow red → orange → yellow → green → cyan → blue → violet → magenta with
 * an equal number of dominoes per segment (a linear hue ramp would spend a third of the line on
 * yellow-green). HSV → sRGB → linear RGB.
 */
function dominoColor(i, n) {
  const hues = [0.0, 0.075, 0.15, 0.33, 0.5, 0.615, 0.74, 0.87];
  const t = (i / (n - 1)) * (hues.length - 1);
  const k = Math.min(hues.length - 2, Math.floor(t));
  const h = hues[k] + (hues[k + 1] - hues[k]) * (t - k);
  const s = 0.82;
  const v = 0.95;
  const f = (m) => {
    const kk = (m + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(kk, 4 - kk, 1));
  };
  const srgb = [f(5), f(3), f(1)];
  return srgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
}

const layout = dominoLayout();
const chute = chutePath(layout.dominoes[0]);
const dominoNames = layout.dominoes.map((_, i) => `Domino.${String(i + 1).padStart(2, '0')}`);
const MARBLE_START_INDEX = 7; // chute.dense index (35 mm down the lead-in)

// ---------------------------------------------------------------------------------------------
// Stage: scene
// ---------------------------------------------------------------------------------------------
async function buildScene() {
  log(`S-curve length ${layout.length.toFixed(3)} m, spacing ${(layout.spacing * 1000).toFixed(1)} mm, chute ${chute.length.toFixed(3)} m`);
  const projects = await mcp.call('list_projects', {});
  const list = Array.isArray(projects) ? projects : (projects.projects ?? []);
  if (list.some((p) => p.name === PROJECT)) {
    await mcp.call('delete_project', { project: PROJECT, confirm: true });
    log(`deleted the existing '${PROJECT}' project`);
  }
  const created = await mcp.call('create_project', { name: PROJECT, empty: true });
  log(`created project ${created.id} — open ${created.editor_url}`);

  await call('set_scene_settings', { frame_start: 1, frame_end: FRAME_END, fps: FPS, resolution_x: 1280, resolution_y: 720 });

  // --- table (generator) + its collider -----------------------------------------------------
  const table = await op('object.generate_table', {
    name: 'Table',
    width: TABLE.width,
    depth: TABLE.depth,
    height: TABLE.height,
    top_thickness: TABLE.top,
    leg_thickness: TABLE.leg,
    location: [0, 0, 0],
  });
  log(`table: ${table.vertices} verts, top at z=${table.bounds.max[2]}`);
  // the convex hull of the table is its top slab plus the legs' footprint: exactly the top surface
  await op('rigidbody.object_add', {
    objects: ['Table'],
    type: 'PASSIVE',
    collision_shape: 'CONVEX_HULL',
    friction: 0.6,
    restitution: 0.1,
    collision_margin: 0.002,
  });

  // --- dominoes -----------------------------------------------------------------------------
  // one bevelled prototype with its rigid body, then linked copies moved onto the S-curve
  await op('mesh.primitive_cube_add', {
    name: dominoNames[0],
    size: 1,
    location: [0, 0, TOP + DOMINO.h / 2],
    scale: [DOMINO.t, DOMINO.w, DOMINO.h],
  });
  await op('object.transform_apply', { location: false, rotation: false, scale: true }, [dominoNames[0]]);
  await call('add_modifier', { object: dominoNames[0], type: 'BEVEL', params: { width: 0.0025, segments: 3 } });
  await call('apply_modifier', { object: dominoNames[0], modifier: 'Bevel' });
  await op('object.shade_auto_smooth', { angle: deg(35) }, [dominoNames[0]]);
  await op('rigidbody.object_add', {
    objects: [dominoNames[0]],
    type: 'ACTIVE',
    collision_shape: 'BOX',
    mass: DOMINO.mass,
    friction: 0.5,
    restitution: 0.1,
    collision_margin: 0.002,
  });
  const placed = await op('object.array_place', {
    objects: [dominoNames[0]],
    pattern: 'LINE',
    count: DOMINO.count,
    offset: [0.1, 0, 0],
    linked: true,
  });
  const ids = [null, ...placed.objects];
  const ops = [];
  layout.dominoes.forEach((d, i) => {
    if (i > 0) ops.push({ operator: 'object.rename', params: { object: ids[i], name: dominoNames[i] } });
    ops.push({
      operator: 'object.transform_set',
      params: { objects: [i === 0 ? dominoNames[0] : ids[i]], location: [d.x, d.y, d.z], rotation_euler: [0, 0, d.heading] },
    });
  });
  await batch(ops);
  log(`placed ${DOMINO.count} dominoes along the S-curve`);

  // --- chute: a thick C-shaped profile curve swept along a 3D Bezier path (bevel object), then
  // converted to a mesh. Profile x/y = the path frame's side/up axes (Z_UP twist keeps it level).
  const prof = [];
  const half = deg(CHUTE.arc / 2);
  const nArc = 14;
  const ro = CHUTE.radius + CHUTE.wall;
  for (let k = 0; k <= nArc; k++) {
    const a = -Math.PI / 2 - half + (2 * half * k) / nArc; // outer arc, counter-clockwise
    prof.push([ro * Math.cos(a), ro * Math.sin(a), 0]);
  }
  for (let k = nArc; k >= 0; k--) {
    const a = -Math.PI / 2 - half + (2 * half * k) / nArc; // inner arc back
    prof.push([CHUTE.radius * Math.cos(a), CHUTE.radius * Math.sin(a), 0]);
  }
  await op('curve.add_from_points', { name: 'Chute Profile', points: prof, type: 'POLY', cyclic: true, dimensions: '2D', location: [0, 0, -1] });
  const pts = [];
  const stride = 6;
  for (let i = 0; i < chute.dense.length; i += stride) pts.push(chute.dense[i]);
  if ((chute.dense.length - 1) % stride) pts.push(chute.dense[chute.dense.length - 1]);
  await op('curve.add_from_points', {
    name: 'Chute',
    points: pts,
    type: 'BEZIER',
    dimensions: '3D',
    bevel_mode: 'OBJECT',
    bevel_object: 'Chute Profile',
    use_fill_caps: true,
    twist_mode: 'Z_UP',
    resolution_u: 4,
    location: [0, 0, 0],
  });
  const conv = await op('object.convert', { target: 'MESH' }, ['Chute']);
  log(`chute converted: ${JSON.stringify(conv.converted)}`);
  await call('delete_objects', { objects: ['Chute Profile'] });
  await op('object.shade_auto_smooth', { angle: deg(40) }, ['Chute']);
  // the channel is concave: a triangle-mesh collider
  await op('rigidbody.object_add', { objects: ['Chute'], type: 'PASSIVE', collision_shape: 'MESH', friction: 0.4, collision_margin: 0.002 });

  // --- marble -------------------------------------------------------------------------------
  const c0 = chute.dense[MARBLE_START_INDEX];
  await op('mesh.primitive_uv_sphere_add', {
    name: 'Marble',
    radius: MARBLE.r,
    segments: 32,
    ring_count: 16,
    location: [c0[0], c0[1], c0[2] - CHUTE.radius + MARBLE.r + 0.0005],
  });
  await op('object.shade_smooth', {}, ['Marble']);
  await op('rigidbody.object_add', {
    objects: ['Marble'],
    type: 'ACTIVE',
    collision_shape: 'SPHERE',
    mass: MARBLE.mass,
    friction: 0.4,
    restitution: 0.2,
    collision_margin: 0.002,
    // rolling resistance stand-in: without it the rebounding marble rolls off the table
    linear_damping: 0.35,
    angular_damping: 0.35,
  });

  // --- physics world ------------------------------------------------------------------------
  const world = await op('rigidbody.world_set', { frame_start: 1, frame_end: FRAME_END, substeps_per_frame: 20, solver_iterations: 20 });
  log(`rigid body world: ${JSON.stringify(world.rigidbody_world)}, step ${world.step_seconds.toFixed(5)} s`);

  await buildProps();
  await lookDev();
  await lightsAndCameras();

  const sc = await call('get_scene', { max_objects: 1 });
  log(`scene: ${JSON.stringify(sc.counts)}; problems: ${JSON.stringify(sc.problems ?? [])}`);
  if ((sc.problems ?? []).length) throw new Error('the scene has evaluation problems');
}

/** Toy-block tower under the top of the chute, dowels under the bend, the floor and two walls. */
async function buildProps() {
  // three stacked toy blocks carry the top of the chute
  const top = chute.dense[0];
  const blockZ = TOP + CHUTE.startHeight - CHUTE.radius - CHUTE.wall - 0.001; // just under the chute
  const nBlocks = 3;
  const size = (blockZ - TOP) / nBlocks;
  const blockOps = [];
  for (let k = 0; k < nBlocks; k++) {
    blockOps.push({
      operator: 'mesh.primitive_cube_add',
      params: {
        name: `Block.${k + 1}`,
        size,
        // the chute starts heading -X: the tower stands just behind its first point so the
        // blocks never poke through the channel floor
        location: [top[0] + size / 2 - 0.008 + 0.006 * Math.sin(k * 2.1), top[1] + 0.006 * Math.cos(k * 1.7), TOP + size * (k + 0.5)],
        rotation: [0, 0, deg([8, -11, 4][k])],
      },
    });
  }
  await batch(blockOps);
  for (let k = 0; k < nBlocks; k++) await call('add_modifier', { object: `Block.${k + 1}`, type: 'BEVEL', params: { width: 0.004, segments: 2 } });

  // wooden dowels under the chute (they stop where the chute floor is)
  const ds = 0.005;
  const dowelAt = [0.2, 0.36, 0.52, 0.68];
  await batch(
    dowelAt.map((s, k) => {
      const p = chute.dense[Math.round(s / ds)];
      const h = p[2] - CHUTE.radius - CHUTE.wall - TOP;
      return {
        operator: 'mesh.primitive_cylinder_add',
        params: { name: `Dowel.${k + 1}`, radius: 0.006, depth: h, vertices: 16, location: [p[0], p[1], TOP + h / 2] },
      };
    }),
  );
  // colliders for the props, so a stray marble cannot roll through them
  await op('rigidbody.object_add', { objects: dowelAt.map((_, k) => `Dowel.${k + 1}`), type: 'PASSIVE', collision_shape: 'CYLINDER', collision_margin: 0.001 });
  await op('rigidbody.object_add', {
    objects: Array.from({ length: nBlocks }, (_, k) => `Block.${k + 1}`),
    type: 'PASSIVE',
    collision_shape: 'BOX',
    collision_margin: 0.001,
  });

  // room: a floor and two plaster walls closing the corner behind the table (x = -3.2, y = 3.2);
  // the floor is rotated a quarter turn so its (object space) boards run along world Y
  await op('mesh.primitive_plane_add', { name: 'Floor', size: 1, location: [0.65, -0.4, 0], rotation: [0, 0, deg(90)], scale: [7.2, 7.7, 1] });
  await op('object.transform_apply', { location: false, rotation: false, scale: true }, ['Floor']);
  await op('mesh.primitive_plane_add', { name: 'Wall', size: 1, location: [0.65, 3.2, 1.6], rotation: [deg(90), 0, 0], scale: [7.7, 3.2, 1] });
  await op('mesh.primitive_plane_add', { name: 'Side Wall', size: 1, location: [-3.2, -0.4, 1.6], rotation: [deg(90), 0, deg(90)], scale: [7.2, 3.2, 1] });
  await op('object.transform_apply', { location: false, rotation: true, scale: true }, ['Wall', 'Side Wall']);
  await op('rigidbody.object_add', { objects: ['Floor'], type: 'PASSIVE', collision_shape: 'BOX', friction: 0.6 });
}

/** Materials: rainbow glossy plastic dominoes, oak table, aluminium chute, glass marble, room. */
async function lookDev() {
  // dominoes: one glossy plastic material per domino, hues running through the rainbow
  await batch(
    dominoNames.map((name, i) => ({
      operator: 'material.preset_apply',
      params: { preset: 'glossy_plastic', objects: [name], name: `Plastic ${String(i + 1).padStart(2, '0')}`, base_color: [...dominoColor(i, DOMINO.count), 1] },
    })),
  );

  // table top: satin oak boards (BRICK pattern = planks with a random tone each and hairline
  // seams) with a fine grain running along the boards (bump + gloss)
  await op('material.update', { material: 'Wood', base_color: [0.4, 0.21, 0.09, 1], roughness: 0.42, coat_weight: 0.15, coat_roughness: 0.15 });
  await op('material.procedural_set', {
    material: 'Wood',
    channel: 'base_color',
    replace: true,
    procedural: {
      type: 'BRICK',
      mapping: 'OBJECT',
      scale: 1,
      color_a: [0.21, 0.085, 0.03, 1],
      color_b: [0.42, 0.19, 0.07, 1],
      params: { plane: 'XY', brick_width: 1.3, row_height: 0.1875, mortar_size: 0.0012, mortar_smooth: 0.3, offset: 0.37, mortar_r: 0.05, mortar_g: 0.025, mortar_b: 0.01 },
    },
  });
  // grain: SAW-profile WAVE bands varying along Y (= lines along X, the boards' length, ~14 mm
  // apart) wobbled by noise; a 0.15 mm bump and, with the same pattern, the gloss (roughness
  // 0.3..0.55). (WOOD rings around Z with fibre streaks read as a rippled, hammered surface on a
  // horizontal top at full resolution.)
  const grain = (colorA, colorB, extra = {}) => ({
    type: 'WAVE',
    mapping: 'OBJECT',
    scale: 22,
    detail: 3,
    distortion: 4,
    roughness: 0.55,
    color_a: colorA,
    color_b: colorB,
    params: { wave_type: 'BANDS', direction: 'Y', wave_profile: 'SAW', detail_scale: 0.6, ...extra },
  });
  await op('material.procedural_set', {
    material: 'Wood',
    channel: 'normal',
    replace: true,
    procedural: grain([0, 0, 0, 1], [1, 1, 1, 1], { bump_distance: 0.00015 }),
  });
  await op('material.procedural_set', {
    material: 'Wood',
    channel: 'roughness',
    replace: true,
    procedural: grain([0.3, 0.3, 0.3, 1], [0.55, 0.55, 0.55, 1]),
  });
  await op('material.update', { material: 'Wood Dark', base_color: [0.09, 0.045, 0.02, 1], roughness: 0.5 });

  // chute: satin aluminium; dowels: beech; blocks: painted toy blocks
  await call('set_material', { object: 'Chute', name: 'Satin Aluminium', base_color: [0.86, 0.87, 0.88, 1], metallic: 1, roughness: 0.28 });
  await op('material.preset_apply', { preset: 'wood', objects: ['Dowel.1', 'Dowel.2', 'Dowel.3', 'Dowel.4'], name: 'Beech', base_color: [0.62, 0.42, 0.24, 1] });
  await op('material.procedural_set', { material: 'Beech', channel: 'base_color', procedural: { color_a: [0.45, 0.28, 0.14, 1], color_b: [0.7, 0.5, 0.3, 1] } });
  const blockColors = [
    [0.55, 0.035, 0.02],
    [0.8, 0.42, 0.02],
    [0.02, 0.13, 0.5],
  ];
  for (let k = 0; k < 3; k++) await call('set_material', { object: `Block.${k + 1}`, name: `Toy Block ${k + 1}`, base_color: [...blockColors[k], 1], roughness: 0.5 });

  // marble: clear glass with a blue tint
  await op('material.preset_apply', { preset: 'clear_glass', objects: ['Marble'], name: 'Marble Glass', base_color: [0.05, 0.25, 0.85, 1] });

  // room: muted teal plaster (complements the warm oak) and a dark walnut plank floor
  await call('set_material', { object: 'Wall', name: 'Plaster', base_color: [0.05, 0.09, 0.1, 1], roughness: 0.92 });
  await call('set_material', { object: 'Side Wall', material: 'Plaster' });
  await call('set_material', { object: 'Floor', name: 'Parquet', base_color: [0.3, 0.17, 0.08, 1], roughness: 0.55 });
  await op('material.procedural_set', {
    material: 'Parquet',
    channel: 'base_color',
    procedural: {
      type: 'BRICK',
      mapping: 'OBJECT',
      scale: 1,
      color_a: [0.07, 0.035, 0.018, 1],
      color_b: [0.19, 0.1, 0.05, 1],
      params: { plane: 'XY', brick_width: 1.2, row_height: 0.14, mortar_size: 0.0015, offset: 0.31, mortar_r: 0.02, mortar_g: 0.012, mortar_b: 0.006 },
    },
  });
}

/**
 * Lights: a large warm rectangular soft box on the left (window-like key) and a long, cool strip
 * light from the back right (rim highlights on the domino edges), dim studio environment.
 * Cameras: the main camera (depth of field on the "Focus Target" empty), the animated showcase
 * camera (Track To an animated target empty) and a close-up "Ramp Cam" for inspection.
 */
async function lightsAndCameras() {
  await call('set_scene_settings', {
    environment: 'STUDIO',
    environment_strength: 0.15,
    engine: 'PATHTRACER',
    samples: 128,
    max_bounces: 6,
    use_denoising: true,
    view_transform: 'ACES', // more saturated and contrasty than AgX: suits the toy colours
    exposure: -0.5,
  });
  await op('object.light_add', {
    type: 'AREA',
    name: 'Key Light',
    energy: 650,
    color: [1.0, 0.86, 0.7],
    shape: 'RECTANGLE',
    size: 2.0,
    size_y: 1.1,
    location: [-2.4, -0.5, 2.2],
  });
  await op('object.look_at', { objects: ['Key Light'], point: [0.0, 0.0, TOP] });
  await op('object.light_add', {
    type: 'AREA',
    name: 'Rim Light',
    energy: 260,
    color: [0.78, 0.86, 1.0],
    shape: 'RECTANGLE',
    size: 1.6,
    size_y: 0.4,
    location: [1.6, 2.1, 1.7],
  });
  await op('object.look_at', { objects: ['Rim Light'], point: [0.1, 0.0, TOP] });

  // depth of field target: keyed in the `animate` stage to follow the marble, then the wave front
  const d0 = layout.dominoes[0];
  await op('object.empty_add', { name: 'Focus Target', type: 'SPHERE', radius: 0.02, location: [d0.x, d0.y, d0.z] });

  // main camera (still): f/2 with the focus on the Focus Target
  await op('object.camera_add', {
    name: 'Camera',
    lens: CAMERA.lens,
    location: CAMERA.location,
    dof_use: true,
    dof_focus_object: 'Focus Target',
    dof_aperture_fstop: CAMERA.fstop,
  });
  await op('object.look_at', { objects: ['Camera'], point: CAMERA.target });
  await call('set_active_camera', { camera: 'Camera' });

  // showcase camera (GIF, contact sheet): Track To an empty; both are keyed in `animate`
  await op('object.empty_add', { name: 'Showcase Target', type: 'PLAIN_AXES', radius: 0.05, location: SHOWCASE.start.target });
  await op('object.camera_add', {
    name: 'Showcase Cam',
    lens: SHOWCASE.lens,
    location: SHOWCASE.start.location,
    dof_use: true,
    dof_focus_object: 'Focus Target',
    dof_aperture_fstop: SHOWCASE.fstop,
  });
  const track = await op('object.track_set', { type: 'TRACKTO', objects: ['Showcase Cam'], target: 'Showcase Target' });
  if ((track.constraints ?? []).some((c) => (c.errors ?? []).length)) throw new Error(`track_set: ${JSON.stringify(track)}`);

  // close-up of the chute for the marble-run inspection sheet
  await op('object.camera_add', { name: 'Ramp Cam', lens: 35, location: [-0.3, -0.42, 1.12] });
  await op('object.look_at', { objects: ['Ramp Cam'], point: [-0.88, 0.28, TOP + 0.09] });
}

// ---------------------------------------------------------------------------------------------
// Stage: verify — every domino topples, in path order (sampled with rigidbody.describe)
// ---------------------------------------------------------------------------------------------
async function verify() {
  const fallFrame = new Array(DOMINO.count).fill(null);
  const tilt = new Array(DOMINO.count).fill(0);
  const marbleTrack = [];
  for (let f = 1; f <= FRAME_END; f += 2) {
    const r = await op('rigidbody.describe', { frame: f });
    for (const b of r.objects) {
      if (b.name === 'Marble') marbleTrack.push({ frame: f, location: b.world_location });
      const i = dominoNames.indexOf(b.name);
      if (i < 0) continue;
      // tilt of the local Z axis from vertical (rotation XYZ euler)
      const [rx, ry] = b.world_rotation_euler;
      const a = Math.acos(Math.max(-1, Math.min(1, Math.cos(rx) * Math.cos(ry))));
      tilt[i] = a;
      if (fallFrame[i] === null && a > deg(45)) fallFrame[i] = f;
    }
  }
  const fallen = fallFrame.filter((f) => f !== null).length;
  let inOrder = true;
  for (let i = 1; i < DOMINO.count; i++)
    if (fallFrame[i] !== null && fallFrame[i - 1] !== null && fallFrame[i] < fallFrame[i - 1]) inOrder = false;
  const fmt = (p) => p.map((v) => +v.toFixed(3));
  log(`marble track (frame: x, y, z): ${marbleTrack.filter((_, k) => k % 3 === 0).map((m) => `${m.frame}: ${fmt(m.location).join(', ')}`).join(' | ')}`);
  log(`fall frames (first sampled frame past 45 deg): ${JSON.stringify(fallFrame)}`);
  log(`final tilt (deg): ${JSON.stringify(tilt.map((a) => Math.round((a * 180) / Math.PI)))}`);
  log(`${fallen}/${DOMINO.count} dominoes toppled; in order: ${inOrder}`);
  if (fallen !== DOMINO.count || !inOrder) throw new Error('the cascade is incomplete or out of order');
  return { fallFrame, marbleTrack };
}

// ---------------------------------------------------------------------------------------------
// Stage: animate — focus target (marble, then the wave front) and the showcase camera move
// ---------------------------------------------------------------------------------------------
async function animateCameras(sim) {
  // wave front: least-squares line through the fall frames, frame(i) = a + b·i
  const n = DOMINO.count;
  const mi = (n - 1) / 2;
  const mf = sim.fallFrame.reduce((s, f) => s + f, 0) / n;
  let sxy = 0;
  let sxx = 0;
  sim.fallFrame.forEach((f, i) => {
    sxy += (i - mi) * (f - mf);
    sxx += (i - mi) ** 2;
  });
  const b = sxy / sxx;
  const a = mf - b * mi;
  log(`wave front: frame ≈ ${a.toFixed(1)} + ${b.toFixed(3)}·i  (${(layout.spacing / (b / FPS)).toFixed(2)} m/s)`);
  const keys = [];
  // the marble on its way down (until just before the impact)
  for (const m of sim.marbleTrack) if (m.frame < a - 2 && (m.frame - 1) % 4 === 0) keys.push([m.frame, m.location]);
  for (let i = 0; i < n; i += 6) keys.push([a + b * i, [layout.dominoes[i].x, layout.dominoes[i].y, TOP + 0.04]]);
  keys.push([a + b * (n - 1), [layout.dominoes[n - 1].x, layout.dominoes[n - 1].y, TOP + 0.04]]);
  const anim = (target, frames, values, interpolation) =>
    [0, 1, 2].map((index) => ({
      operator: 'anim.keyframes_insert_many',
      params: { target, path: 'location', index, frames, values: values.map((v) => v[index]), interpolation, replace: true },
    }));
  const end = { location: CAMERA.location, target: CAMERA.target };
  await batch([
    ...anim('Focus Target', keys.map((k) => +k[0].toFixed(2)), keys.map((k) => k[1]), 'LINEAR'),
    // the showcase camera eases from the chute close-up to the main camera's framing
    ...anim('Showcase Cam', SHOWCASE.frames, [SHOWCASE.start.location, end.location], 'BEZIER'),
    ...anim('Showcase Target', SHOWCASE.frames, [SHOWCASE.start.target, end.target], 'BEZIER'),
  ]);
  log(`focus target: ${keys.length} keys (frames ${keys[0][0]}..${keys[keys.length - 1][0].toFixed(1)}); showcase camera keys at ${SHOWCASE.frames}`);
}

// ---------------------------------------------------------------------------------------------
// Stage: inspect — RASTER contact sheets of the live simulation at several stages + get_object
// checks of evaluated (simulated / animated) values at several frames
// ---------------------------------------------------------------------------------------------
async function inspect() {
  const sheets = [
    { name: 'sim-1-marble-run', camera: 'Ramp Cam', frame_start: 1, frame_end: 31, frame_step: 2 },
    { name: 'sim-2-cascade', camera: 'Camera', frame_start: 27, frame_end: 87, frame_step: 4 },
    { name: 'sim-3-showcase-cam', camera: 'Showcase Cam', frame_start: 1, frame_end: 96, frame_step: 5 },
  ];
  for (const st of sheets) {
    const { name, ...range } = st;
    const r = await call('render_animation', { format: 'CONTACT_SHEET', engine: 'RASTER', width: 320, columns: 4, time_limit: 120, ...range });
    save(path.join(WORK, `${name}.png`), r.images[0].data);
  }
  // evaluated values at several frames
  const at = async (object, frame) => (await call('get_object', { object, frame })).world_transform;
  const v = (p) => `[${p.map((x) => x.toFixed(3)).join(', ')}]`;
  const marble = [];
  for (const f of [1, 10, 20, 26, 30, 60, 100]) marble.push(`f${f} ${v((await at('Marble', f)).location)}`);
  log(`  Marble: ${marble.join('  ')}`);
  const tiltOf = (rot) => (Math.acos(Math.max(-1, Math.min(1, Math.cos(rot[0]) * Math.cos(rot[1])))) * 180) / Math.PI;
  for (const [name, frames] of [
    [dominoNames[0], [20, 30, 40]],
    [dominoNames[29], [45, 55, 65]],
    [dominoNames[59], [70, 80, 95]],
  ]) {
    const parts = [];
    for (const f of frames) {
      const tr = await at(name, f);
      parts.push(`f${f} tilt ${tiltOf(tr.rotation_euler).toFixed(0)}° at ${v(tr.location)}`);
    }
    log(`  ${name}: ${parts.join('  ')}`);
  }
  const focus = await at('Focus Target', STILL_FRAME);
  const near = layout.dominoes.map((d, i) => [i, Math.hypot(d.x - focus.location[0], d.y - focus.location[1])]).sort((p, q) => p[1] - q[1])[0];
  const cam = await call('get_object', { object: 'Camera', frame: STILL_FRAME });
  log(`  frame ${STILL_FRAME}: Focus Target at ${v(focus.location)} (next to ${dominoNames[near[0]]}); Camera focuses on '${cam.data.dof_focus_object}' at ${cam.data.dof_focus_distance.toFixed(3)} m (f/${cam.data.dof_aperture_fstop})`);
  const sc = await call('get_object', { object: 'Showcase Cam', frame: 1 });
  log(`  Showcase Cam f1 ${v(sc.world_transform.location)} rot ${v(sc.world_transform.rotation_degrees)}`);
}

// ---------------------------------------------------------------------------------------------
// Stage: bake — rigid body simulation -> keyframes, then check the keys reproduce the simulation
// ---------------------------------------------------------------------------------------------
async function bake() {
  const probe = [10, 30, STILL_FRAME, 80];
  const names = ['Marble', dominoNames[0], dominoNames[20], dominoNames[40], dominoNames[59]];
  const before = {};
  for (const f of probe) {
    const r = await op('rigidbody.describe', { frame: f, objects: names });
    for (const b of r.objects) before[`${b.name}@${f}`] = b.world_location;
  }
  const r = await op('rigidbody.bake_to_keyframes', { objects: [...dominoNames, 'Marble'], frame_start: 1, frame_end: FRAME_END, step: 1 });
  const baked = Array.isArray(r) ? r : (r.objects ?? []);
  const nKeys = baked.reduce((s, o) => s + (o.keyframes ?? 0), 0);
  log(`baked ${baked.length} bodies, ${nKeys} keyframes (simplified per body)`);
  let worst = 0;
  for (const f of probe)
    for (const n of names) {
      const o = await call('get_object', { object: n, frame: f });
      worst = Math.max(worst, dist3(o.world_location, before[`${n}@${f}`]));
    }
  log(`baked keys vs simulation: max position difference ${(worst * 1000).toFixed(3)} mm`);
  if (worst > 0.002) throw new Error('baked keyframes do not reproduce the simulation');
  const scene = await call('get_scene', { max_objects: 1 });
  log(`scene after bake: ${JSON.stringify(scene.counts)}; problems: ${JSON.stringify(scene.problems ?? [])}`);
}

// ---------------------------------------------------------------------------------------------
// Renders
// ---------------------------------------------------------------------------------------------
/** Quick previews of the current state (raster and a short path trace). */
async function preview() {
  const r = await call('render_image', { width: 640, height: 360, engine: 'RASTER', frame: STILL_FRAME });
  save('preview-raster.png', r.images[0].data);
  const p = await call('render_image', { width: 640, height: 360, engine: 'PATHTRACER', samples: 24, time_limit: 60, frame: STILL_FRAME });
  save('preview-pt.png', p.images[0].data);
  log(`  path trace: ${JSON.stringify(p.text).slice(0, 300)}`);
}

function record(name, started, text) {
  timings[name] = { seconds: +((Date.now() - started) / 1000).toFixed(1), ...text };
  log(`  ${name}: ${JSON.stringify(text).slice(0, 500)}`);
}

async function still() {
  const started = Date.now();
  const r = await call('render_image', {
    camera: 'Camera',
    width: BUDGET.still_size[0],
    height: BUDGET.still_size[1],
    engine: 'PATHTRACER',
    samples: BUDGET.still[0],
    denoise: true,
    time_limit: BUDGET.still[1],
    frame: STILL_FRAME,
  });
  save(path.join(OUT, 'render.png'), r.images[0].data);
  record('still', started, r.text);
}

async function sheet() {
  const started = Date.now();
  const r = await call('render_animation', {
    format: 'CONTACT_SHEET',
    camera: 'Showcase Cam',
    engine: 'PATHTRACER',
    samples: BUDGET.sheet[0],
    denoise: true,
    frame_start: 4,
    frame_end: 96,
    frame_step: 4,
    columns: 6,
    width: 320,
    height: 180,
    time_limit: BUDGET.sheet[1],
  });
  save(path.join(OUT, 'contact_sheet.png'), r.images[0].data);
  record('contact_sheet', started, r.text);
}

async function gif() {
  const started = Date.now();
  const r = await call('render_animation', {
    format: 'GIF',
    camera: 'Showcase Cam',
    engine: 'PATHTRACER',
    samples: BUDGET.gif[0],
    denoise: true,
    frame_start: 1,
    frame_end: 95,
    frame_step: 2,
    width: 480,
    height: 270,
    dither: 'BAYER',
    time_limit: BUDGET.gif[1],
  });
  save(path.join(OUT, 'preview.gif'), r.images[0].data);
  record('gif', started, r.text);
}

async function exportGlb() {
  const started = Date.now();
  const r = await call('export_scene', { format: 'glb' });
  const res = (r.resources ?? []).find((x) => x.blob);
  if (!res) throw new Error(`export_scene returned no file: ${JSON.stringify(r).slice(0, 300)}`);
  const file = save(path.join(OUT, 'scene.glb'), res.blob);
  for (const w of r.text?.warnings ?? []) log(`  export warning: ${typeof w === 'string' ? w : JSON.stringify(w)}`);
  record('export', started, { bytes: statSync(file).size });
}

// ---------------------------------------------------------------------------------------------
log(`mode ${opts.stages ? '--stages' : '--' + opts.mode}: ${[...STAGES].join(', ')}`);
try {
  let sim = null;
  const stage = async (name, fn) => {
    if (!STAGES.has(name)) return;
    const started = Date.now();
    await fn();
    timings[`stage_${name}`] = +((Date.now() - started) / 1000).toFixed(1);
  };
  await stage('scene', buildScene);
  await stage('verify', async () => (sim = await verify()));
  await stage('animate', async () => animateCameras(sim ?? (await verify())));
  await stage('inspect', inspect);
  await stage('bake', bake);
  await stage('preview', preview);
  await stage('still', still);
  await stage('sheet', sheet);
  await stage('gif', gif);
  await stage('export', exportGlb);
} finally {
  await mcp.close();
}
timings.total_seconds = +((Date.now() - t0) / 1000).toFixed(1);
mkdirSync(WORK, { recursive: true });
writeFileSync(path.join(WORK, 'timings.json'), JSON.stringify(timings, null, 2));
log(`done; timings: ${JSON.stringify(timings)}`);
