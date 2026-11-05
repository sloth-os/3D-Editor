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
 * checks the simulation (every domino must topple, in order), renders inspection contact sheets,
 * bakes the simulation to keyframes (and checks the keys reproduce it), renders a path-traced
 * still, a contact sheet and a GIF, and exports a GLB.
 *
 *   MCP_URL=http://127.0.0.1:4504/mcp node examples/domino-cascade/build.mjs
 *
 * Environment:
 *   MCP_URL / MCP_TOKEN  MCP endpoint (default http://127.0.0.1:8080/mcp)
 *   STAGES               comma list of stages to run (default: all, in this order)
 *                        scene, verify, inspect, bake, still, sheet, gif, export
 *                        (preview: quick 640x360 raster + path-traced check images)
 *   WORK_DIR             where inspection images go (default: $TMPDIR/domino-cascade-work)
 *   STILL_SAMPLES / STILL_TIME_LIMIT   final still budget (default 128 spp / 290 s)
 */
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../../scripts/mcp.mjs';

const OUT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = process.env.PROJECT_NAME ?? 'domino-cascade';
const ALL_STAGES = ['scene', 'verify', 'inspect', 'bake', 'still', 'sheet', 'gif', 'export'];
const STAGES = new Set((process.env.STAGES ?? ALL_STAGES.join(',')).split(',').map((s) => s.trim()));
const WORK = process.env.WORK_DIR ?? path.join(os.tmpdir(), 'domino-cascade-work');
const STILL_SAMPLES = Number(process.env.STILL_SAMPLES ?? 128);
const STILL_TIME_LIMIT = Number(process.env.STILL_TIME_LIMIT ?? 290);
const STILL_FRAME = 55; // mid-cascade: the wave front is half way along the S
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
const CAMERA = { location: [1.9, -1.65, 1.8], target: [-0.08, 0.08, TOP + 0.01], lens: 42 };
const FPS = 24;
const FRAME_END = 100; // the last domino lands near frame 81; everything is at rest by ~90

// ---------------------------------------------------------------------------------------------
// MCP helpers
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
    throw new Error(`${tool} ${JSON.stringify(args).slice(0, 300)} failed: ${e.message}`);
  }
}

/**
 * run_operator; returns the operator result and prints warnings. Operators that act on the
 * selection get it explicitly through `select` (unknown parameters such as `objects` would be
 * silently ignored by those operators).
 */
async function op(operator, params = {}, select = null) {
  const r = await call('run_operator', { operator, params, ...(select ? { selection: { objects: select } } : {}) });
  for (const rep of r.reports ?? [])
    if (rep.level !== 'INFO') log(`  ${operator} ${rep.level}: ${rep.message}`);
  return r.result;
}

/** batch of operators as one undo step (chunks of 200). */
async function batch(operations) {
  const results = [];
  for (let i = 0; i < operations.length; i += 200) {
    const r = await call('batch', { operations: operations.slice(i, i + 200) });
    const items = r.results ?? r.operations ?? r;
    if (Array.isArray(items)) {
      for (const it of items) {
        if (it.ok === false) throw new Error(`batch op ${it.operator} failed: ${JSON.stringify(it).slice(0, 500)}`);
        for (const rep of it.reports ?? []) if (rep.level !== 'INFO') log(`  ${it.operator} ${rep.level}: ${rep.message}`);
      }
      results.push(...items);
    } else results.push(r);
  }
  return results;
}

function save(name, data) {
  const file = path.isAbsolute(name) ? name : path.join(WORK, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(data, 'base64'));
  log(`  wrote ${file}`);
  return file;
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers (all placements are computed here and sent as plain numbers)
// ---------------------------------------------------------------------------------------------
const deg = (d) => (d * Math.PI) / 180;

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

/** Domino placements: centre and heading (local +X = direction of fall). */
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

/** Linear sRGB-ish rainbow: HSV -> sRGB -> linear. */
function rainbow(i, n) {
  const h = (i / n) * 0.86; // red .. violet
  const s = 0.82;
  const v = 0.95;
  const f = (k) => {
    const kk = (k + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(kk, 4 - kk, 1));
  };
  const srgb = [f(5), f(3), f(1)];
  return srgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
}

// ---------------------------------------------------------------------------------------------
// Stage: scene
// ---------------------------------------------------------------------------------------------
const layout = dominoLayout();
const chute = chutePath(layout.dominoes[0]);
const dominoNames = layout.dominoes.map((_, i) => `Domino.${String(i + 1).padStart(2, '0')}`);

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

  await call('set_scene_settings', {
    frame_start: 1,
    frame_end: FRAME_END,
    fps: FPS,
    resolution_x: 1280,
    resolution_y: 720,
  });

  // --- table (generator) -----------------------------------------------------------------
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

  // --- dominoes ---------------------------------------------------------------------------
  // one bevelled prototype, then linked copies placed along the S-curve
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
  log(`placed ${DOMINO.count} dominoes`);

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
  await op('curve.add_from_points', {
    name: 'Chute Profile',
    points: prof,
    type: 'POLY',
    cyclic: true,
    dimensions: '2D',
    location: [0, 0, -1],
  });
  const pts = [];
  const stride = 6;
  for (let i = 0; i < chute.dense.length; i += stride) pts.push(chute.dense[i]);
  const last = chute.dense[chute.dense.length - 1];
  if ((chute.dense.length - 1) % stride) pts.push(last);
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
  await op('rigidbody.object_add', {
    objects: ['Chute'],
    type: 'PASSIVE',
    collision_shape: 'MESH',
    friction: 0.4,
    collision_margin: 0.002,
  });

  // --- marble -----------------------------------------------------------------------------
  const startS = 0.035;
  const iStart = Math.round(startS / 0.005);
  const c0 = chute.dense[iStart];
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

  // --- table collider ---------------------------------------------------------------------
  await op('rigidbody.object_add', {
    objects: ['Table'],
    type: 'PASSIVE',
    collision_shape: 'CONVEX_HULL',
    friction: 0.6,
    restitution: 0.1,
    collision_margin: 0.002,
  });

  // --- physics world ----------------------------------------------------------------------
  const world = await op('rigidbody.world_set', {
    frame_start: 1,
    frame_end: FRAME_END,
    substeps_per_frame: 20,
    solver_iterations: 20,
  });
  log(`rigid body world: ${JSON.stringify(world.rigidbody_world)}, step ${world.step_seconds.toFixed(5)} s`);

  await buildProps();
  await lookDev();
  await lightsAndCamera();

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
  const b = blockZ - TOP;
  const size = b / nBlocks;
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
  for (let k = 0; k < nBlocks; k++) {
    await call('add_modifier', { object: `Block.${k + 1}`, type: 'BEVEL', params: { width: 0.004, segments: 2 } });
  }

  // wooden dowels under the chute (stop where the chute floor is)
  const ds = 0.005;
  const dowelAt = [0.2, 0.36, 0.52, 0.68];
  const dowelOps = [];
  dowelAt.forEach((s, k) => {
    const p = chute.dense[Math.round(s / ds)];
    const zTop = p[2] - CHUTE.radius - CHUTE.wall;
    const h = zTop - TOP;
    dowelOps.push({
      operator: 'mesh.primitive_cylinder_add',
      params: { name: `Dowel.${k + 1}`, radius: 0.006, depth: h, vertices: 16, location: [p[0], p[1], TOP + h / 2] },
    });
  });
  await batch(dowelOps);
  // colliders for the props, so a stray marble cannot roll through them
  await op('rigidbody.object_add', {
    objects: [...dowelAt.map((_, k) => `Dowel.${k + 1}`)],
    type: 'PASSIVE',
    collision_shape: 'CYLINDER',
    collision_margin: 0.001,
  });
  await op('rigidbody.object_add', {
    objects: [...Array.from({ length: nBlocks }, (_, k) => `Block.${k + 1}`)],
    type: 'PASSIVE',
    collision_shape: 'BOX',
    collision_margin: 0.001,
  });

  // room: a floor and two plaster walls closing the corner behind the table (x = -3.2, y = 3.2)
  // the floor is rotated a quarter turn so its (object space) boards run along world Y
  await op('mesh.primitive_plane_add', { name: 'Floor', size: 1, location: [0.65, -0.4, 0], rotation: [0, 0, deg(90)], scale: [7.2, 7.7, 1] });
  await op('object.transform_apply', { location: false, rotation: false, scale: true }, ['Floor']);
  await op('mesh.primitive_plane_add', { name: 'Wall', size: 1, location: [0.65, 3.2, 1.6], rotation: [deg(90), 0, 0], scale: [7.7, 3.2, 1] });
  await op('mesh.primitive_plane_add', {
    name: 'Side Wall',
    size: 1,
    location: [-3.2, -0.4, 1.6],
    rotation: [deg(90), 0, deg(90)],
    scale: [7.2, 3.2, 1],
  });
  await op('object.transform_apply', { location: false, rotation: true, scale: true }, ['Wall', 'Side Wall']);
  await op('rigidbody.object_add', { objects: ['Floor'], type: 'PASSIVE', collision_shape: 'BOX', friction: 0.6 });
}

/** Materials: rainbow glossy plastic dominoes, oak table, aluminium chute, glass marble. */
async function lookDev() {
  // dominoes: one glossy plastic material per domino, hues running through the rainbow
  const matOps = dominoNames.map((name, i) => ({
    operator: 'material.preset_apply',
    params: { preset: 'glossy_plastic', objects: [name], name: `Plastic ${String(i + 1).padStart(2, '0')}`, base_color: [...rainbow(i, DOMINO.count), 1] },
  }));
  await batch(matOps);

  // table top: satin oak boards (BRICK pattern = planks with a random tone each and hairline
  // seams) with a fine growth-ring bump
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
      params: {
        plane: 'XY',
        brick_width: 1.3,
        row_height: 0.1875,
        mortar_size: 0.0012,
        mortar_smooth: 0.3,
        offset: 0.37,
        mortar_r: 0.05,
        mortar_g: 0.025,
        mortar_b: 0.01,
      },
    },
  });
  await op('material.procedural_set', {
    material: 'Wood',
    channel: 'normal',
    replace: true,
    procedural: {
      type: 'WOOD',
      mapping: 'OBJECT',
      scale: 60,
      detail: 1,
      distortion: 0.6,
      color_a: [0, 0, 0, 1],
      color_b: [1, 1, 1, 1],
      params: { wood_type: 'RINGS', wave_profile: 'SAW', grain: 0, offset_y: 6, bump_distance: 0.0002 },
    },
  });
  await op('material.update', { material: 'Wood Dark', base_color: [0.09, 0.045, 0.02, 1], roughness: 0.5 });

  // chute: brushed aluminium; dowels and blocks: light wood / painted toy blocks
  await call('set_material', { object: 'Chute', name: 'Satin Aluminium', base_color: [0.86, 0.87, 0.88, 1], metallic: 1, roughness: 0.28 });
  await op('material.preset_apply', {
    preset: 'wood',
    objects: ['Dowel.1', 'Dowel.2', 'Dowel.3', 'Dowel.4'],
    name: 'Beech',
    base_color: [0.62, 0.42, 0.24, 1],
  });
  await op('material.procedural_set', {
    material: 'Beech',
    channel: 'base_color',
    procedural: { color_a: [0.45, 0.28, 0.14, 1], color_b: [0.7, 0.5, 0.3, 1] },
  });
  const blockColors = [
    [0.55, 0.035, 0.02],
    [0.8, 0.42, 0.02],
    [0.02, 0.13, 0.5],
  ];
  for (let k = 0; k < 3; k++)
    await call('set_material', { object: `Block.${k + 1}`, name: `Toy Block ${k + 1}`, base_color: [...blockColors[k], 1], roughness: 0.5 });

  // marble: clear glass with a faint blue tint
  await op('material.preset_apply', { preset: 'clear_glass', objects: ['Marble'], name: 'Marble Glass', base_color: [0.05, 0.25, 0.85, 1] });

  // room
  await call('set_material', { object: 'Wall', name: 'Plaster', base_color: [0.42, 0.36, 0.3, 1], roughness: 0.92 });
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

/** Window-like key light, soft fill, dim warm world, 50 mm camera with depth of field. */
async function lightsAndCamera() {
  await call('set_scene_settings', {
    environment: 'STUDIO',
    environment_strength: 0.15,
    engine: 'PATHTRACER',
    samples: 128,
    max_bounces: 6,
    use_denoising: true,
    view_transform: 'AGX',
    exposure: -0.6,
  });
  // Light/camera data blocks cannot be addressed by data.set_property through MCP (their ids are
  // not exposed), so numeric data fields are set by keying them once with insert_keyframe.
  const setData = (object, property, value) => call('insert_keyframe', { object, property, value, frame: 1 });
  // key: big warm area light on the left (its mirror highlight falls off the front of the table)
  await op('object.light_add', { type: 'AREA', name: 'Key Light', energy: 650, color: [1.0, 0.86, 0.7], location: [-2.4, -0.5, 2.2] });
  await setData('Key Light', 'data.size', 1.3);
  await op('object.look_at', { objects: ['Key Light'], point: [0.0, 0.0, TOP] });
  // rim: cooler, from the back right, for highlights on the domino edges
  await op('object.light_add', { type: 'AREA', name: 'Rim Light', energy: 260, color: [0.78, 0.86, 1.0], location: [1.6, 2.1, 1.7] });
  await setData('Rim Light', 'data.size', 1.0);
  await op('object.look_at', { objects: ['Rim Light'], point: [0.1, 0.0, TOP] });

  // camera (depth of field cannot be enabled through MCP, see README)
  await op('object.camera_add', { name: 'Camera', lens: CAMERA.lens, location: CAMERA.location });
  await op('object.look_at', { objects: ['Camera'], point: CAMERA.target });
  // a second camera close to the chute, used for the marble-run inspection sheet
  await op('object.camera_add', { name: 'Ramp Cam', lens: 35, location: [-0.3, -0.42, 1.12] });
  await op('object.look_at', { objects: ['Ramp Cam'], point: [-0.88, 0.28, TOP + 0.09] });
  await call('set_active_camera', { camera: 'Camera' });
}

/** Quick previews of the current state (raster and a short path trace). */
async function preview(tag = 'preview', frame = 50) {
  const r = await call('render_image', { width: 640, height: 360, engine: 'RASTER', frame });
  save(`${tag}-raster.png`, r.images[0].data);
  const p = await call('render_image', { width: 640, height: 360, engine: 'PATHTRACER', samples: 24, time_limit: 60, frame });
  save(`${tag}-pt.png`, p.images[0].data);
  log(`  path trace: ${JSON.stringify(p.text).slice(0, 300)}`);
}

// ---------------------------------------------------------------------------------------------
// Stage: verify (every domino topples, in order)
// ---------------------------------------------------------------------------------------------
async function verify() {
  const fallFrame = new Array(DOMINO.count).fill(null);
  const tilt = new Array(DOMINO.count).fill(0);
  let marbleTrack = [];
  for (let f = 1; f <= FRAME_END; f += 2) {
    const r = await op('rigidbody.describe', { frame: f });
    for (const b of r.objects) {
      if (b.name === 'Marble') marbleTrack.push([f, ...b.world_location.map((v) => +v.toFixed(3))]);
      const i = dominoNames.indexOf(b.name);
      if (i < 0) continue;
      // tilt of the local Z axis from vertical (rotation XYZ euler)
      const [rx, ry] = b.world_rotation_euler;
      const zAxisZ = Math.cos(rx) * Math.cos(ry);
      const a = Math.acos(Math.max(-1, Math.min(1, zAxisZ)));
      tilt[i] = a;
      if (fallFrame[i] === null && a > deg(45)) fallFrame[i] = f;
    }
  }
  const fallen = fallFrame.filter((f) => f !== null).length;
  let inOrder = true;
  for (let i = 1; i < DOMINO.count; i++)
    if (fallFrame[i] !== null && fallFrame[i - 1] !== null && fallFrame[i] < fallFrame[i - 1]) inOrder = false;
  log(`marble track (frame, x, y, z): ${JSON.stringify(marbleTrack.filter((_, k) => k % 3 === 0))}`);
  log(`fall frames: ${JSON.stringify(fallFrame)}`);
  log(`final tilt (deg): ${JSON.stringify(tilt.map((a) => Math.round((a * 180) / Math.PI)))}`);
  log(`${fallen}/${DOMINO.count} dominoes toppled; in order: ${inOrder}`);
  return { fallFrame, fallen, inOrder };
}

// ---------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------
// Stage: inspect — contact sheets of the live simulation at several stages + per-object checks
// ---------------------------------------------------------------------------------------------
async function inspect() {
  const stages = [
    { name: 'sim-1-marble-run', camera: 'Ramp Cam', frame_start: 1, frame_end: 31, frame_step: 2 },
    { name: 'sim-2-cascade', camera: 'Camera', frame_start: 27, frame_end: 87, frame_step: 4 },
  ];
  for (const st of stages) {
    const r = await call('render_animation', {
      format: 'CONTACT_SHEET',
      engine: 'RASTER',
      camera: st.camera,
      width: 320,
      frame_start: st.frame_start,
      frame_end: st.frame_end,
      frame_step: st.frame_step,
      columns: 4,
      time_limit: 120,
    });
    save(path.join(WORK, `${st.name}.png`), r.images[0].data);
  }
  // spot checks with get_object at a few frames (evaluated, i.e. simulated, world locations)
  for (const [name, frames] of [
    ['Marble', [1, 12, 24, 30]],
    [dominoNames[0], [20, 40]],
    [dominoNames[29], [40, 60]],
    [dominoNames[59], [70, 95]],
  ]) {
    const locs = [];
    for (const f of frames) {
      const o = await call('get_object', { object: name, frame: f });
      locs.push(`f${f}: [${o.world_location.map((v) => v.toFixed(3)).join(', ')}]`);
    }
    log(`  ${name}: ${locs.join('  ')}`);
  }
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
  const r = await op('rigidbody.bake_to_keyframes', {
    objects: [...dominoNames, 'Marble'],
    frame_start: 1,
    frame_end: FRAME_END,
    step: 1,
  });
  const keys = r.objects ?? r.baked ?? r;
  log(`baked: ${JSON.stringify(keys).slice(0, 400)}`);
  let worst = 0;
  for (const f of probe)
    for (const n of names) {
      const o = await call('get_object', { object: n, frame: f });
      const a = before[`${n}@${f}`];
      const d = Math.hypot(...o.world_location.map((v, k) => v - a[k]));
      worst = Math.max(worst, d);
    }
  log(`baked keys vs simulation: max position difference ${(worst * 1000).toFixed(3)} mm`);
  if (worst > 0.002) throw new Error('baked keyframes do not reproduce the simulation');
  const scene = await call('get_scene', { max_objects: 1 });
  log(`scene after bake: ${JSON.stringify(scene.counts)}; problems: ${JSON.stringify(scene.problems ?? [])}`);
}

// ---------------------------------------------------------------------------------------------
// Final outputs
// ---------------------------------------------------------------------------------------------
async function still() {
  const started = Date.now();
  const r = await call('render_image', {
    width: 1280,
    height: 720,
    engine: 'PATHTRACER',
    samples: STILL_SAMPLES,
    denoise: true,
    time_limit: STILL_TIME_LIMIT,
    frame: STILL_FRAME,
  });
  save(path.join(OUT, 'render.png'), r.images[0].data);
  timings.still = { seconds: (Date.now() - started) / 1000, ...r.text };
  log(`  still: ${JSON.stringify(r.text)}`);
}

async function sheet() {
  const started = Date.now();
  const r = await call('render_animation', {
    format: 'CONTACT_SHEET',
    engine: 'PATHTRACER',
    samples: 6,
    denoise: true,
    frame_start: 4,
    frame_end: 96,
    frame_step: 4,
    columns: 6,
    width: 320,
    height: 180,
    time_limit: 400,
  });
  save(path.join(OUT, 'contact_sheet.png'), r.images[0].data);
  timings.contact_sheet = { seconds: (Date.now() - started) / 1000, ...r.text };
  log(`  contact sheet: ${JSON.stringify(r.text).slice(0, 400)}`);
}

async function gif() {
  const started = Date.now();
  const r = await call('render_animation', {
    format: 'GIF',
    engine: 'PATHTRACER',
    samples: 4,
    denoise: true,
    frame_start: 1,
    frame_end: 95,
    frame_step: 2,
    width: 480,
    height: 270,
    dither: 'BAYER',
    time_limit: 600,
  });
  save(path.join(OUT, 'preview.gif'), r.images[0].data);
  timings.gif = { seconds: (Date.now() - started) / 1000, ...r.text };
  log(`  gif: ${JSON.stringify(r.text).slice(0, 400)}`);
}

async function exportGlb() {
  const r = await call('export_scene', { format: 'glb' });
  const res = (r.resources ?? []).find((x) => x.blob);
  if (!res) throw new Error(`export_scene returned no file: ${JSON.stringify(r).slice(0, 300)}`);
  const file = save(path.join(OUT, 'scene.glb'), res.blob);
  log(`  scene.glb: ${(statSync(file).size / 1e6).toFixed(2)} MB`);
}

// ---------------------------------------------------------------------------------------------
try {
  if (STAGES.has('scene')) await buildScene();
  if (STAGES.has('verify')) {
    const v = await verify();
    if (v.fallen !== DOMINO.count || !v.inOrder) throw new Error('the cascade is incomplete or out of order');
  }
  if (STAGES.has('preview')) await preview(process.env.PREVIEW_TAG ?? 'preview', Number(process.env.PREVIEW_FRAME ?? STILL_FRAME));
  if (STAGES.has('inspect')) await inspect();
  if (STAGES.has('bake')) await bake();
  if (STAGES.has('still')) await still();
  if (STAGES.has('sheet')) await sheet();
  if (STAGES.has('gif')) await gif();
  if (STAGES.has('export')) await exportGlb();
} finally {
  await mcp.close();
}
log(`done; render timings: ${JSON.stringify(timings)}`);
