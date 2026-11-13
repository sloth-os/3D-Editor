#!/usr/bin/env node
/**
 * Clockwork Orrery — an original brass orrery on a dark marble plinth, built entirely through the
 * 3D editor's MCP server (the same tools an external AI agent uses).
 *
 *   MCP_URL=http://127.0.0.1:8080/mcp node examples/clockwork-orrery/build.mjs [mode] [--out-dir DIR]
 *
 * Modes (the scene is always rebuilt from scratch first: the project is deleted and recreated, then
 * verified: driven angles, gear ratios, the moon's period, clearance between all moving parts at
 * every frame of the loop, and the framing):
 *   --final        (default) build + verify, then render.png (path traced 1280×720), contact_sheet.png
 *                  (12 path traced frames) and preview.gif (48 path traced frames, 480×270)
 *   --build-only   build + verify only, no renders (about a minute; the per-frame clearance sweep is
 *                  most of it)
 *   --preview      build + verify + quick previews in $PREVIEW_DIR (960×540 RASTER still, 640×360 path
 *                  traced still, RASTER contact sheet); nothing is written next to this script
 *   --export-only  build + verify + scene.glb (glTF binary), no renders
 *   --stages a,b   explicit stage list instead of a mode: build (always), preview, still, anim, export
 *   --out-dir DIR  where render.png / contact_sheet.png / preview.gif / scene.glb are written
 *                  (default: this folder)
 * Any other argument (e.g. "build-only" without the dashes), an unknown stage name, two modes at once
 * or a flag without its value stops the script with exit code 2 before it connects to the server.
 *
 * Mechanism: ONE master channel — the empty "Master Drive", rotation Z keyed linearly 0 → 2π over
 * frames 1 → 49 (anim.keyframes_insert_many) and repeated forever (anim.extrapolation_set CYCLIC).
 * Every rotating part reads it through a scripted driver (anim.driver_add):
 *   planet arms   θ = phase + n·m      n = 4, 3, 2, 1 orbits per master turn (12/16/24/48 frames)
 *   planet spin   θ = s·m              (integer turns, so the 48-frame loop is seamless)
 *   gear train    θ_B = φ_B − (T_A/T_B)·(θ_A − φ_A)  for every meshing pair A→B (opposite senses,
 *                 ratio teeth_A/teeth_B; φ chosen so a tooth of A sits in a gap of B)
 * The moon rides a Bezier circle parented to the third planet's arm (FOLLOW_PATH constraint, timed
 * on its own by constraint.followpath_path_animate: the curve's eval_time is keyed 0 → 100 over 12
 * frames with LINEAR extrapolation, i.e. one orbit every 12 frames, four per master turn).
 * verifyMotion() reads the evaluated transforms back with get_object at several frames and fails
 * the build if any part does not move exactly as designed; verifyClearance() measures the exact
 * surface distances between the moving parts at every frame (scene.measure) and fails on contact.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../../scripts/mcp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_NAME = 'clockwork-orrery';
const PREVIEW_DIR = process.env.PREVIEW_DIR ?? path.join(os.tmpdir(), 'clockwork-orrery-previews');

// ---------------------------------------------------------------------------------- command line

const MODES = {
  '--final': 'build,still,anim',
  '--build-only': 'build',
  '--preview': 'build,preview',
  '--export-only': 'build,export',
};
const STAGE_NAMES = ['build', 'preview', 'still', 'anim', 'export'];
const USAGE = `usage: MCP_URL=http://HOST:PORT/mcp node examples/clockwork-orrery/build.mjs [${Object.keys(MODES).join(' | ')} | --stages ${STAGE_NAMES.join(',')}] [--out-dir DIR]`;

function usageError(msg) {
  console.error(`build.mjs: ${msg}\n${USAGE}`);
  process.exit(2);
}

/** Strict command line: every argument must be a known flag or the value right after one. */
function parseArgs(argv) {
  let mode = null;
  let stageList = null;
  let outDir = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (a in MODES || a === '--stages') {
      if (mode || stageList)
        usageError(`give one mode or --stages, not both (${mode ?? '--stages'} and ${a})`);
      if (a === '--stages') {
        stageList = argv[++i];
        if (!stageList || stageList.startsWith('-')) usageError('--stages needs a comma-separated list');
      } else mode = a;
    } else if (a === '--out-dir') {
      if (outDir) usageError('--out-dir given twice');
      outDir = argv[++i];
      if (!outDir || outDir.startsWith('-')) usageError('--out-dir needs a directory');
    } else usageError(`unknown argument "${a}"`);
  }
  const stages = (stageList ?? MODES[mode ?? '--final']).split(',').map((s) => s.trim());
  const unknown = stages.filter((s) => !STAGE_NAMES.includes(s));
  if (unknown.length)
    usageError(
      `unknown stage(s) ${unknown.map((s) => `"${s}"`).join(', ')} (known: ${STAGE_NAMES.join(', ')})`,
    );
  return { stages: new Set(['build', ...stages]), outDir: path.resolve(outDir ?? HERE) };
}

const { stages: STAGES, outDir: OUT_DIR } = parseArgs(process.argv.slice(2));

const TAU = 2 * Math.PI;
const DEG = Math.PI / 180;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const mod = (a, n) => ((a % n) + n) % n;
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// ---------------------------------------------------------------------------------- MCP helpers

const mcp = await connect();
let project = null; // project id once created
const timings = {};
const warnings = [];

function short(v, n = 400) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Calls an MCP tool on the project; logs and rethrows errors with context (fails the build). */
async function call(tool, args = {}, { quiet = false, withProject = true } = {}) {
  const t0 = Date.now();
  const full = withProject && project ? { project, ...args } : args;
  try {
    const res = await mcp.call(tool, full, {
      onProgress: (p) => process.stderr.write(`    … ${p.message ?? `${p.progress}/${p.total ?? '?'}`}\r`),
    });
    if (!quiet) console.log(`  ✓ ${tool}${args.operator ? ` ${args.operator}` : ''} (${Date.now() - t0} ms)`);
    return res;
  } catch (e) {
    console.error(`  ✗ ${tool}${args.operator ? ` ${args.operator}` : ''}: ${e.message}`);
    console.error(`    args: ${short(args, 1200)}`);
    throw e;
  }
}

function collectReports(operator, reports) {
  for (const rep of reports ?? []) {
    const level = rep.level ?? rep.type ?? '';
    const msg = `${operator}: ${level} ${rep.message ?? short(rep)}`;
    console.log(`    report ${msg}`);
    if (/WARN|ERROR/i.test(level)) warnings.push(msg);
  }
}

/** run_operator → the operator's own result; WARNING/ERROR reports are echoed and collected. */
async function op(operator, params = {}, selection) {
  const r = await call('run_operator', { operator, params, ...(selection ? { selection } : {}) });
  collectReports(operator, r.reports);
  return r.result;
}

/** batch → one undo step; the server fails the call if any operation fails. */
async function batch(label, operations) {
  const r = await call(
    'batch',
    { operations: operations.map(([operator, params]) => ({ operator, params })) },
    { quiet: true },
  );
  const results = r.results ?? [];
  const failed = results.filter((x) => x && x.ok === false);
  console.log(
    `  ✓ batch "${label}": ${operations.length} operators${failed.length ? `, ${failed.length} FAILED` : ''}`,
  );
  if (failed.length || r.ok === false) throw new Error(`batch ${label} failed: ${short(r, 2000)}`);
  results.forEach((x, i) => collectReports(operations[i][0], x?.reports));
  return results.map((x) => x?.result);
}

async function saveImage(res, file) {
  const img = res.images?.[0];
  if (!img) throw new Error(`no image in result: ${short(res)}`);
  await writeFile(file, Buffer.from(img.data, 'base64'));
  return file;
}

// ---------------------------------------------------------------------------------- design

// Plinth (Z up, metres). Octagons are rotated by π/8 so a flat face looks at the camera (−Y).
const BASE = { r: 0.52, h: 0.05 }; // dark wood foot
const PLINTH = { r: 0.47, z0: 0.05, h: 0.13 }; // dark marble
const PLINTH_TOP = PLINTH.z0 + PLINTH.h; // 0.18
const DECK = { r: 0.418, t: 0.008 }; // enamelled dial plate on the marble
const DIAL = { numeralR: 0.393, innerRing: 0.371, outerRing: 0.4135, size: 0.03 };
const DECK_TOP = PLINTH_TOP + DECK.t; // 0.188
const APOTHEM = PLINTH.r * Math.cos(Math.PI / 8); // distance of the flat faces from the axis

// Sun on the central spindle
const SPINDLE = { r: 0.011, top: 0.68 };
const SUN = { r: 0.075, z: 0.735 };

// Planets: orbit radius R, sphere radius s, arm height h, planet centre height p, orbits per master
// turn n (=> periods 12, 16, 24, 48 frames), spin turns per master turn, start angle, material.
// Titan's gilt ring: major / minor radius in planet radii, tilt (Euler XYZ in the arm frame) and
// flattening. The radii are chosen so that the annuli the four assemblies sweep around the spindle
// stay at least MIN_GAP apart (layoutPlanets): two arms can then never touch, at any angle.
const PLANETS = [
  { key: 'Ember', R: 0.125, s: 0.02, h: 0.585, p: 0.655, n: 4, spin: 8, phase: 68 * DEG, material: 'Copper' },
  {
    key: 'Azure',
    R: 0.185,
    s: 0.026,
    h: 0.525,
    p: 0.63,
    n: 3,
    spin: 6,
    phase: 138 * DEG,
    material: 'Azure Glaze',
  },
  {
    key: 'Verdant',
    R: 0.285,
    s: 0.031,
    h: 0.46,
    p: 0.605,
    n: 2,
    spin: 4,
    phase: 8 * DEG,
    material: 'Verdant',
  },
  {
    key: 'Titan',
    R: 0.445,
    s: 0.048,
    h: 0.39,
    p: 0.575,
    n: 1,
    spin: 3,
    phase: 228 * DEG,
    material: 'Banded Giant',
    ring: { major: 1.55, minor: 0.26, tilt: [22 * DEG, 8 * DEG, 0], flatten: 0.14 },
  },
];
const MOON = { planet: 'Verdant', orbit: 0.05, r: 0.0105, framesPerOrbit: 12, tilt: 14 * DEG };
const ARM = { barW: 0.014, barT: 0.006, collarR: 0.019, collarH: 0.016, postR: 0.0034 };
const MIN_GAP = 0.01; // radial gap between the swept annuli of neighbouring planet assemblies (m)
const CLEARANCE = { planets: 0.005, gears: 0.0002 }; // smallest surface distance allowed in verifyClearance
const LOOP = 48; // frames per master turn (frame 49 = frame 1)
const FPS = 24;

// Gear train on the deck: module (pitch diameter per tooth) and tooth depth shared by all gears so
// they mesh. Pitch radius = MODULE·T/2, tip radius = pitch + DEPTH/2. `windows` = lightening holes;
// their count must keep the 48-frame loop seamless: a gear turns T_great/T per loop, which has to
// be a multiple of its symmetry 1/gcd(T, windows) (checked in layoutGears and verifyMotion).
const MODULE = 0.0066;
const DEPTH = 0.0115;
const CLEAR = 0.0008; // extra centre distance (backlash)
const GEAR_T = 0.012;
const GEAR_Z = DECK_TOP + 0.0012 + GEAR_T / 2;
const GEARS = [
  { name: 'Great Wheel', T: 36, material: 'Brass', windows: 6, bore: 0.0125 },
  { name: 'Idler Wheel', T: 18, material: 'Gilt', angle: -38 * DEG, bore: 0.006 },
  { name: 'Third Wheel', T: 27, material: 'Brass', windows: 6, dist: 0.262, bore: 0.006 },
  { name: 'Pinion', T: 12, material: 'Copper', dist: 0.305, bore: 0.006 },
];

const MOTTO = 'THE HEAVENS\nKEPT IN BRASS';

// Camera & lights
const FOCUS = [0, -0.03, 0.335];
const CAMERA = { location: [1.3, -2.47, 1.24], lens: 50, fstop: 4 };
const LIGHTS = [
  // name, location, watts, colour, shape, size, size_y — rectangular soft boxes and a rim strip
  {
    name: 'Key Light',
    location: [-1.25, -1.35, 1.65],
    energy: 280,
    color: [1, 0.8, 0.6],
    shape: 'RECTANGLE',
    size: 1.1,
    size_y: 0.7,
  },
  {
    name: 'Fill Light',
    location: [1.7, -0.75, 0.8],
    energy: 65,
    color: [0.78, 0.86, 1],
    shape: 'DISK',
    size: 1.4,
  },
  {
    name: 'Rim Light',
    location: [0.55, 1.65, 1.35],
    energy: 260,
    color: [1, 0.72, 0.45],
    shape: 'RECTANGLE',
    size: 1.5,
    size_y: 0.32,
  },
  {
    name: 'Top Light',
    location: [0.0, 0.2, 2.2],
    energy: 55,
    color: [1, 0.92, 0.82],
    shape: 'DISK',
    size: 1.2,
  },
];

// ---------------------------------------------------------------------------------- gear maths

function layoutGears() {
  const g = GEARS.map((x) => ({ ...x, rp: (MODULE * x.T) / 2 }));
  g.forEach((x) => (x.tip = x.rp + DEPTH / 2));
  g[0].x = 0;
  g[0].y = 0;
  g[0].phase = 0;
  g[0].k = 1; // turns with the master
  const c01 = g[0].rp + g[1].rp + CLEAR;
  g[1].x = c01 * Math.cos(g[1].angle);
  g[1].y = c01 * Math.sin(g[1].angle);
  // later gears: mesh with the previous one at a chosen distance from the spindle, continuing
  // clockwise around the front of the deck
  for (let i = 2; i < g.length; i++) {
    const prev = g[i - 1];
    const c = prev.rp + g[i].rp + CLEAR;
    const d = Math.hypot(prev.x, prev.y);
    const a = (g[i].dist ** 2 - c ** 2 + d ** 2) / (2 * d);
    const h = Math.sqrt(Math.max(0, g[i].dist ** 2 - a ** 2));
    const ux = prev.x / d;
    const uy = prev.y / d;
    // perpendicular (ux,uy) rotated −90° = clockwise continuation
    g[i].x = a * ux + h * uy;
    g[i].y = a * uy - h * ux;
  }
  // phases and ratios: for each meshing pair A→B a tooth of A faces a gap of B on the centre line
  for (let i = 1; i < g.length; i++) {
    const A = g[i - 1];
    const B = g[i];
    const alpha = Math.atan2(B.y - A.y, B.x - A.x);
    const pA = TAU / A.T;
    const pB = TAU / B.T;
    const tauA = mod((alpha - A.phase) / pA, 1); // 0 = tooth centre of A on the line
    B.phase = mod(alpha + Math.PI - pB * (0.5 - tauA), TAU);
    B.k = (-A.k * A.T) / B.T;
    B.meshesWith = A;
  }
  // sanity: neighbours mesh, nothing else collides, everything stays on the deck, the loop is seamless
  for (let i = 0; i < g.length; i++)
    for (let j = i + 1; j < g.length; j++) {
      const d = Math.hypot(g[i].x - g[j].x, g[i].y - g[j].y);
      const meshing = j === i + 1;
      if (meshing && Math.abs(d - (g[i].rp + g[j].rp + CLEAR)) > 1e-9)
        throw new Error(`gear ${g[i].name}/${g[j].name} centre distance ${d}`);
      if (!meshing && d < g[i].tip + g[j].tip + 0.008)
        throw new Error(`gears ${g[i].name} and ${g[j].name} collide (${d.toFixed(4)} m)`);
    }
  for (const x of g) {
    if (Math.hypot(x.x, x.y) + x.tip > DIAL.innerRing - 0.006)
      throw new Error(`gear ${x.name} runs into the dial ring`);
    x.symmetry = gcd(x.T, x.windows ?? x.T); // rotational symmetry order of teeth + windows
    const turns = Math.abs(x.k); // turns per loop
    if (Math.abs(turns * x.symmetry - Math.round(turns * x.symmetry)) > 1e-9)
      throw new Error(`gear ${x.name} would jump at the loop point (${turns} turns, symmetry ${x.symmetry})`);
  }
  return g;
}

// ---------------------------------------------------------------------------------- planet layout

/**
 * Planet layout check (pure geometry, before any editor call). Each arm carries a "head" — the
 * planet, Titan's ring, Verdant's moon on its orbit — whose horizontal reach from the arm's post is
 * ρ, so the assembly sweeps the annulus [R − ρ, R + ρ] around the spindle. When neighbouring
 * annuli are disjoint, two assemblies cannot touch at any angle: an outer head never reaches an
 * inner post or bar (they lie inside the inner annulus), and every outer bar and collar runs below
 * the inner ones, whose heads sit above their own bars. verifyClearance() then confirms this on the
 * built scene with exact surface distances at every frame.
 */
function layoutPlanets() {
  const heads = PLANETS.map((P) => {
    let rho = P.s;
    let dip = P.s; // how far the head reaches below the planet centre
    if (P.ring) {
      const reach = P.s * (P.ring.major + P.ring.minor);
      const tilt = Math.acos(Math.cos(P.ring.tilt[0]) * Math.cos(P.ring.tilt[1])); // ring plane vs. horizontal
      rho = Math.max(rho, reach);
      dip = Math.max(dip, reach * Math.sin(tilt) + P.s * P.ring.minor * P.ring.flatten);
    }
    if (P.key === MOON.planet) {
      rho = Math.max(rho, MOON.orbit + MOON.r);
      dip = Math.max(dip, MOON.orbit * Math.sin(MOON.tilt) + MOON.r);
    }
    return { key: P.key, R: P.R, h: P.h, rIn: P.R - rho, rOut: P.R + rho, bottom: P.p - dip };
  });
  const fail = (msg) => {
    throw new Error(`planet layout: ${msg}`);
  };
  if (heads[0].rIn - SUN.r < MIN_GAP) fail(`${heads[0].key} reaches the sun`);
  for (const [i, x] of heads.entries()) {
    if (x.bottom < x.h + ARM.barT / 2 + MIN_GAP)
      fail(`${x.key} hangs down to its own arm (bottom ${x.bottom.toFixed(3)} m)`);
    if (i === 0) continue;
    const inner = heads[i - 1];
    const gap = x.rIn - inner.rOut;
    if (gap < MIN_GAP)
      fail(
        `${inner.key} (r ${inner.rIn.toFixed(3)}–${inner.rOut.toFixed(3)} m) and ${x.key} (r ${x.rIn.toFixed(3)}–${x.rOut.toFixed(3)} m) overlap or nearly do (gap ${gap.toFixed(4)} m)`,
      );
    if (inner.h - x.h < ARM.collarH + MIN_GAP)
      fail(`the arms of ${inner.key} and ${x.key} are too close in height`);
  }
  for (const x of heads)
    console.log(
      `    ${x.key.padEnd(8)} sweeps r ${x.rIn.toFixed(4)}–${x.rOut.toFixed(4)} m (z ≥ ${x.bottom.toFixed(3)} m above its arm at ${x.h} m)`,
    );
  return heads;
}

// ---------------------------------------------------------------------------------- build

async function resetProject() {
  const list = await call('list_projects', {}, { withProject: false, quiet: true });
  const projects = Array.isArray(list) ? list : (list.projects ?? []);
  for (const p of projects.filter((x) => x.name === PROJECT_NAME)) {
    console.log(`  deleting existing project ${p.id}`);
    await call('delete_project', { project: p.id, confirm: true }, { withProject: false });
  }
  const created = await call('create_project', { name: PROJECT_NAME, empty: true }, { withProject: false });
  project = created.id;
  console.log(`  project ${project}  editor: ${created.editor_url}`);
}

async function sceneSettings() {
  await call('set_scene_settings', {
    frame_start: 1,
    frame_end: LOOP,
    fps: FPS,
    frame_current: 1,
    resolution_x: 1280,
    resolution_y: 720,
    resolution_percentage: 100,
    engine: 'PATHTRACER',
    samples: 128,
    max_bounces: 6,
    use_denoising: true,
    // STANDARD keeps the sun saturated and the stone dark (AgX lifts blacks and whitens the sun)
    view_transform: 'STANDARD',
    exposure: -1.1,
    // a warm, very dark backdrop; the procedural photo studio only lights and reflects
    world_color: [0.012, 0.009, 0.007],
    world_strength: 1,
    environment: 'STUDIO',
    environment_strength: 0.07,
  });
  await op('data.set_property', {
    kind: 'world',
    values: { show_environment_background: false, environment_rotation: 200 * DEG },
  });
}

async function materials() {
  // Presets give physically plausible starting points; each material is created once and shared.
  const presets = [
    ['Brass', 'brass'],
    ['Polished Brass', 'brass'],
    ['Plate Brass', 'brass'],
    ['Gilt', 'gold'],
    ['Copper', 'copper'],
    ['Dark Marble', 'marble'],
    ['Dark Wood', 'wood'],
    ['Table Wood', 'wood'],
    ['Moon Silver', 'silver'],
    ['Azure Glaze', 'ceramic'],
  ];
  for (const [name, preset] of presets) {
    await op('material.new', { name, assign: false });
    await op('material.preset_apply', { preset, material: name });
  }
  await batch('material tweaks', [
    ['material.update', { material: 'Polished Brass', roughness: 0.14 }],
    ['material.update', { material: 'Plate Brass', roughness: 0.42 }],
    ['material.update', { material: 'Brass', roughness: 0.26 }],
    ['material.update', { material: 'Azure Glaze', base_color: [0.025, 0.11, 0.42, 1] }],
    // dark marble: near-black stone with sparse warm-white veins. MARBLE factor 0 = vein; the ramp
    // ends at 0.26 with EASE, so everything outside the thin vein bands is the black colour_b.
    [
      'material.procedural_set',
      {
        material: 'Dark Marble',
        channel: 'base_color',
        replace: true,
        procedural: {
          type: 'MARBLE',
          mapping: 'OBJECT',
          scale: 3.8,
          distortion: 4.2,
          detail: 6,
          roughness: 0.55,
          color_a: [0.44, 0.4, 0.33],
          color_b: [0.006, 0.0062, 0.0068],
          ramp_low: 0,
          ramp_high: 0.26,
          params: { marble_type: 'SHARP', ramp_interpolation: 'EASE' },
        },
      },
    ],
    ['material.update', { material: 'Dark Marble', roughness: 0.18, coat_weight: 0 }],
    // dark walnut for the plinth foot, oiled wood with growth rings and fibre streaks for the table
    [
      'material.procedural_set',
      {
        material: 'Dark Wood',
        channel: 'base_color',
        procedural: { color_a: [0.022, 0.009, 0.004], color_b: [0.075, 0.032, 0.014] },
      },
    ],
    ['material.update', { material: 'Dark Wood', roughness: 0.38 }],
    [
      'material.procedural_set',
      {
        material: 'Table Wood',
        channel: 'base_color',
        replace: true,
        procedural: {
          type: 'WOOD',
          mapping: 'OBJECT',
          scale: 7,
          distortion: 1.4,
          detail: 4,
          roughness: 0.55,
          color_a: [0.032, 0.014, 0.006],
          color_b: [0.095, 0.045, 0.019],
          params: { wood_type: 'RINGS', grain: 0.7, offset_x: 0.35 },
        },
      },
    ],
    ['material.update', { material: 'Table Wood', roughness: 0.42 }],
    [
      'material.new',
      { name: 'Blued Steel', assign: false, base_color: [0.07, 0.09, 0.16, 1], metallic: 1, roughness: 0.22 },
    ],
    [
      'material.new',
      {
        name: 'Black Enamel',
        assign: false,
        base_color: [0.006, 0.006, 0.007, 1],
        metallic: 0,
        roughness: 0.3,
      },
    ],
    [
      'material.new',
      {
        name: 'Midnight Enamel',
        assign: false,
        base_color: [0.003, 0.007, 0.03, 1],
        metallic: 0,
        roughness: 0.25,
        coat_weight: 0.5,
        coat_roughness: 0.08,
      },
    ],
    // the sun: a near-black diffuse base (so the studio lights do not wash it out) under a warm,
    // granulated procedural emission
    [
      'material.new',
      {
        name: 'Sun',
        assign: false,
        base_color: [0.02, 0.008, 0.002, 1],
        emission_color: [1, 0.55, 0.15],
        emission_strength: 3.0,
        roughness: 0.6,
      },
    ],
    [
      'material.procedural_set',
      {
        material: 'Sun',
        channel: 'emission',
        procedural: {
          type: 'NOISE',
          mapping: 'OBJECT',
          scale: 38,
          detail: 5,
          roughness: 0.55,
          color_a: [0.95, 0.16, 0.01],
          color_b: [1, 0.62, 0.16],
          ramp_low: 0.35,
          ramp_high: 0.68,
        },
      },
    ],
    // planets
    ['material.new', { name: 'Verdant', assign: false, base_color: [0.05, 0.2, 0.5, 1], roughness: 0.45 }],
    [
      'material.procedural_set',
      {
        material: 'Verdant',
        channel: 'base_color',
        procedural: {
          type: 'NOISE',
          mapping: 'OBJECT',
          scale: 34,
          detail: 6,
          roughness: 0.55,
          color_a: [0.012, 0.05, 0.2],
          color_b: [0.13, 0.24, 0.07],
          ramp_low: 0.49,
          ramp_high: 0.53,
        },
      },
    ],
    [
      'material.new',
      { name: 'Banded Giant', assign: false, base_color: [0.8, 0.55, 0.3, 1], roughness: 0.55 },
    ],
    [
      'material.procedural_set',
      {
        material: 'Banded Giant',
        channel: 'base_color',
        procedural: {
          type: 'WAVE',
          mapping: 'OBJECT',
          scale: 7,
          distortion: 3.5,
          detail: 3,
          color_a: [0.7, 0.45, 0.2],
          color_b: [0.2, 0.07, 0.025],
          params: { wave_type: 'BANDS', direction: 'Z' },
        },
      },
    ],
  ]);
}

/** Smooth the round parts: flat caps, smooth sides. */
async function autoSmooth(objects, angle = 40 * DEG) {
  await op('object.shade_auto_smooth', { angle }, { objects, active: objects[0] });
}

async function assign(material, objects) {
  await op('object.material_assign', { material, objects, slot: 0 });
}

async function plinth() {
  // table top: rotated so the procedural wood rings run along world X (plank-like grain); 24 m wide
  // (X ±12) and 16 m deep (Y −1…15), so none of its edges enters the frame and the wood fades into
  // the dark (verifyFraming checks that the four image corners see the table top)
  await op('mesh.primitive_cube_add', {
    size: 1,
    name: 'Table',
    location: [0, 7, -0.025],
    scale: [0.05, 16, 24],
    rotation: [0, Math.PI / 2, 0],
  });
  await op(
    'object.transform_apply',
    { location: false, rotation: false, scale: true },
    { objects: ['Table'] },
  );
  await assign('Table Wood', ['Table']);

  await op('mesh.primitive_cylinder_add', {
    vertices: 8,
    radius: BASE.r,
    depth: BASE.h,
    name: 'Plinth Base',
    location: [0, 0, BASE.h / 2],
    rotation: [0, 0, Math.PI / 8],
  });
  await op('mesh.primitive_cylinder_add', {
    vertices: 8,
    radius: PLINTH.r,
    depth: PLINTH.h,
    name: 'Plinth',
    location: [0, 0, PLINTH.z0 + PLINTH.h / 2],
    rotation: [0, 0, Math.PI / 8],
  });
  await op('mesh.primitive_cylinder_add', {
    vertices: 96,
    radius: DECK.r,
    depth: DECK.t,
    name: 'Deck',
    location: [0, 0, PLINTH_TOP + DECK.t / 2],
  });
  // a thin gilt moulding where the marble meets the wood
  await op('mesh.primitive_cylinder_add', {
    vertices: 8,
    radius: PLINTH.r + 0.008,
    depth: 0.012,
    name: 'Moulding',
    location: [0, 0, PLINTH.z0 + 0.006],
    rotation: [0, 0, Math.PI / 8],
  });
  await call('add_modifier', {
    object: 'Plinth Base',
    type: 'BEVEL',
    params: { width: 0.012, segments: 3, limit_method: 'ANGLE' },
  });
  await call('add_modifier', {
    object: 'Plinth',
    type: 'BEVEL',
    params: { width: 0.007, segments: 3, limit_method: 'ANGLE' },
  });
  await call('add_modifier', {
    object: 'Deck',
    type: 'BEVEL',
    params: { width: 0.0025, segments: 2, limit_method: 'ANGLE' },
  });
  await call('add_modifier', {
    object: 'Moulding',
    type: 'BEVEL',
    params: { width: 0.004, segments: 2, limit_method: 'ANGLE' },
  });
  await assign('Dark Wood', ['Plinth Base']);
  await assign('Dark Marble', ['Plinth']);
  await assign('Midnight Enamel', ['Deck']);
  await assign('Gilt', ['Moulding']);
  await autoSmooth(['Deck']);
}

async function dial() {
  // gilt chapter rings and twelve Roman numerals around the enamelled deck, like a clock dial
  const z = DECK_TOP + 0.0006;
  await op('mesh.primitive_torus_add', {
    major_radius: DIAL.innerRing,
    minor_radius: 0.0016,
    major_segments: 160,
    minor_segments: 8,
    name: 'Chapter Ring',
    location: [0, 0, z],
    scale: [1, 1, 0.5],
  });
  await op('mesh.primitive_torus_add', {
    major_radius: DIAL.outerRing,
    minor_radius: 0.0026,
    major_segments: 160,
    minor_segments: 10,
    name: 'Dial Rim',
    location: [0, 0, DECK_TOP],
    scale: [1, 1, 0.8],
  });
  await op('object.shade_smooth', {}, { objects: ['Chapter Ring', 'Dial Rim'] });
  const numerals = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
  const names = [];
  for (const [n, body] of numerals.entries()) {
    const theta = Math.PI / 2 - (n * TAU) / 12; // XII at the back (+Y), clockwise like a clock
    const name = `Numeral ${body}`;
    // text lies in XY facing +Z; rotate so the letters' up points away from the centre
    await op('object.text_add', {
      body,
      size: DIAL.size,
      align_x: 'CENTER',
      align_y: 'CENTER',
      extrude: 0.0006,
      name,
      location: [r4(DIAL.numeralR * Math.cos(theta)), r4(DIAL.numeralR * Math.sin(theta)), z + 0.0006],
      rotation: [0, 0, r4(theta - Math.PI / 2)],
    });
    names.push(name);
  }
  await op('object.material_assign', {
    material: 'Gilt',
    objects: ['Chapter Ring', 'Dial Rim', ...names],
    slot: 0,
  });
}

async function textPlate() {
  const faceY = -APOTHEM; // front face of the marble octagon
  const plate = { w: 0.3, h: 0.096, t: 0.006, z: PLINTH.z0 + PLINTH.h / 2 };
  const plateFront = faceY - plate.t;
  await op('mesh.primitive_cube_add', {
    size: 1,
    name: 'Motto Plate',
    location: [0, faceY - plate.t / 2, plate.z],
    scale: [plate.w, plate.t, plate.h],
  });
  await op(
    'object.transform_apply',
    { location: false, rotation: false, scale: true },
    { objects: ['Motto Plate'] },
  );
  await call('add_modifier', {
    object: 'Motto Plate',
    type: 'BEVEL',
    params: { width: 0.0018, segments: 2, limit_method: 'ANGLE' },
  });
  await assign('Plate Brass', ['Motto Plate']);

  // the motto as real text, sized from the measured layout so it fits the plate with a margin
  const extrude = 0.002;
  let t = await op('object.text_add', {
    body: MOTTO,
    size: 0.032,
    align_x: 'CENTER',
    align_y: 'CENTER',
    extrude,
    space_character: 1.2,
    space_line: 1.3,
    name: 'Motto',
    location: [0, plateFront, plate.z],
    rotation: [Math.PI / 2, 0, 0],
  });
  const maxWidth = plate.w - 0.06;
  if (t.width > maxWidth || t.height > plate.h - 0.03) {
    const size = 0.032 * Math.min(maxWidth / t.width, (plate.h - 0.03) / t.height);
    t = await op('font.text_set', { object: 'Motto', size });
    console.log(`    motto resized to ${size.toFixed(4)} m em → width ${t.width} m`);
  }
  // engrave: bake the text to a mesh and subtract it (2 mm deep) from the plate
  await op('object.convert', { target: 'MESH', keep_original: false }, { objects: ['Motto'] });
  await call('add_modifier', {
    object: 'Motto Plate',
    name: 'Engraving',
    type: 'BOOLEAN',
    params: { operation: 'DIFFERENCE', object: 'Motto' },
  });
  // black wax filling the engraving, 0.6 mm below the plate surface
  await call('duplicate_object', { object: 'Motto', name: 'Motto Fill', offset: [0, extrude + 0.0006, 0] });
  await op('data.set_property', {
    kind: 'objects',
    target: 'Motto',
    values: { hide_render: true, hide_viewport: true },
  });
  await op('data.set_property', {
    kind: 'objects',
    target: 'Motto Fill',
    values: { hide_render: false, hide_viewport: false },
  });
  await assign('Black Enamel', ['Motto Fill']);
  // two domed screws
  const screws = [];
  for (const [i, sx] of [-1, 1].entries()) {
    const name = `Plate Screw ${i + 1}`;
    await op('mesh.primitive_uv_sphere_add', {
      segments: 16,
      ring_count: 8,
      radius: 0.0055,
      name,
      location: [sx * (plate.w / 2 - 0.012), plateFront, plate.z],
      scale: [1, 0.45, 1],
    });
    screws.push(name);
  }
  await op('object.shade_smooth', {}, { objects: screws });
  await assign('Gilt', screws);
  const plateInfo = await call('get_object', { object: 'Motto Plate' }, { quiet: true });
  console.log(`    plate evaluated: ${short(plateInfo.data?.evaluated ?? plateInfo.data)}`);
}

async function gearTrain() {
  const g = layoutGears();
  for (const x of g) {
    const res = await op('object.generate_gear', {
      teeth: x.T,
      radius: r4(x.tip),
      tooth_depth: DEPTH,
      thickness: GEAR_T,
      bore: x.bore,
      name: x.name,
      location: [r4(x.x), r4(x.y), GEAR_Z],
      rotation: [0, 0, x.phase],
      materials: false,
    });
    console.log(
      `    ${x.name}: T=${x.T} tip r=${x.tip.toFixed(4)} at (${x.x.toFixed(4)}, ${x.y.toFixed(4)}) phase ${(x.phase / DEG).toFixed(2)}° ratio ${x.k.toFixed(4)} → ${res.vertices} verts`,
    );
    // lightening windows cut with a boolean and applied; spaced evenly so the gear keeps a
    // rotational symmetry of gcd(teeth, windows)
    if (x.windows) {
      const cutters = [];
      const rIn = x.bore + 0.012;
      const rOut = x.rp - DEPTH / 2 - 0.012;
      const rc = (rIn + rOut) / 2;
      const hole = Math.min((rOut - rIn) / 2, rc * Math.sin(Math.PI / x.windows) - 0.008);
      for (let s = 0; s < x.windows; s++) {
        const a = x.phase + Math.PI / x.windows + (s * TAU) / x.windows;
        const name = `${x.name} Cutter ${s + 1}`;
        await op('mesh.primitive_cylinder_add', {
          vertices: 32,
          radius: hole,
          depth: GEAR_T * 3,
          name,
          location: [x.x + rc * Math.cos(a), x.y + rc * Math.sin(a), GEAR_Z],
        });
        cutters.push(name);
      }
      await op('object.join', {}, { objects: cutters, active: cutters[0] });
      await call('add_modifier', {
        object: x.name,
        name: 'Windows',
        type: 'BOOLEAN',
        params: { operation: 'DIFFERENCE', object: cutters[0] },
      });
      await call('apply_modifier', { object: x.name, modifier: 'Windows' });
      await call('delete_objects', { objects: [cutters[0]] });
    }
    await assign(x.material, [x.name]);
    await autoSmooth([x.name], 30 * DEG);
    // arbor: blued steel pin with a domed cap (the great wheel sits on the spindle instead)
    if (x !== g[0]) {
      await op('mesh.primitive_cylinder_add', {
        vertices: 24,
        radius: 0.0075,
        depth: GEAR_T + 0.016,
        name: `${x.name} Arbor`,
        location: [x.x, x.y, DECK_TOP + (GEAR_T + 0.016) / 2],
      });
      await op('mesh.primitive_uv_sphere_add', {
        segments: 24,
        ring_count: 12,
        radius: 0.0095,
        name: `${x.name} Cap`,
        location: [x.x, x.y, DECK_TOP + GEAR_T + 0.016],
        scale: [1, 1, 0.55],
      });
      await assign('Blued Steel', [`${x.name} Arbor`, `${x.name} Cap`]);
      await autoSmooth([`${x.name} Arbor`]);
      await op('object.shade_smooth', {}, { objects: [`${x.name} Cap`] });
    }
  }
  return g;
}

async function sunAndSpindle() {
  const len = SPINDLE.top - DECK_TOP;
  await op('mesh.primitive_cylinder_add', {
    vertices: 32,
    radius: SPINDLE.r,
    depth: len,
    name: 'Spindle',
    location: [0, 0, DECK_TOP + len / 2],
  });
  // hub where the spindle meets the great wheel, and a gilt cup holding the sun
  await op('mesh.primitive_cylinder_add', {
    vertices: 48,
    radius: 0.026,
    depth: 0.022,
    name: 'Hub',
    location: [0, 0, GEAR_Z + GEAR_T / 2 + 0.011],
  });
  await op('mesh.primitive_cone_add', {
    vertices: 48,
    radius1: 0.014,
    radius2: 0.04,
    depth: 0.05,
    name: 'Sun Cup',
    location: [0, 0, SUN.z - SUN.r * 0.62 - 0.012],
  });
  await op('mesh.primitive_uv_sphere_add', {
    segments: 64,
    ring_count: 32,
    radius: SUN.r,
    name: 'Sun',
    location: [0, 0, SUN.z],
  });
  await assign('Brass', ['Spindle', 'Hub']);
  await assign('Gilt', ['Sun Cup']);
  await assign('Sun', ['Sun']);
  await autoSmooth(['Spindle', 'Hub', 'Sun Cup']);
  await op('object.shade_smooth', {}, { objects: ['Sun'] });
  // a warm lamp inside the sun (radius just larger than the sphere, so it shines out of it) lights
  // the planets' sun-facing sides like the lamp of a real orrery; lights are invisible to the camera
  await op('object.light_add', {
    type: 'POINT',
    name: 'Sun Lamp',
    location: [0, 0, SUN.z],
    energy: 40,
    color: [1, 0.62, 0.3],
    shadow_soft_size: SUN.r + 0.01,
  });
}

async function planetArms() {
  for (const P of PLANETS) {
    const pivot = `${P.key} Pivot`;
    const arm = `${P.key} Arm`;
    await call('add_object', { type: 'empty', name: pivot, location: [0, 0, P.h], params: { radius: 0.05 } });
    // arm = collar on the spindle + flat bar + upright post + cup, joined into one mesh
    const barLen = P.R + 0.004;
    await op('mesh.primitive_cube_add', {
      size: 1,
      name: arm,
      location: [barLen / 2, 0, P.h],
      scale: [barLen, ARM.barW, ARM.barT],
    });
    await op('object.transform_apply', { location: false, rotation: false, scale: true }, { objects: [arm] });
    const parts = [
      [
        'mesh.primitive_cylinder_add',
        {
          vertices: 40,
          radius: ARM.collarR,
          depth: ARM.collarH,
          name: `${arm} Collar`,
          location: [0, 0, P.h],
        },
      ],
      [
        'mesh.primitive_cylinder_add',
        {
          vertices: 24,
          radius: ARM.postR,
          depth: P.p - P.h - P.s * 0.6,
          name: `${arm} Post`,
          location: [P.R, 0, P.h + (P.p - P.h - P.s * 0.6) / 2],
        },
      ],
      [
        'mesh.primitive_cylinder_add',
        { vertices: 32, radius: 0.0065, depth: 0.004, name: `${arm} Boss`, location: [P.R, 0, P.h + 0.0042] },
      ],
      [
        'mesh.primitive_cone_add',
        {
          vertices: 32,
          radius1: 0.0034,
          radius2: P.s * 0.5,
          depth: P.s * 0.42,
          name: `${arm} Cup`,
          location: [P.R, 0, P.p - P.s * 0.72],
        },
      ],
    ];
    await batch(`${P.key} arm parts`, parts);
    await op('object.join', {}, { objects: [arm, ...parts.map((p) => p[1].name)], active: arm });
    await assign('Polished Brass', [arm]);
    await autoSmooth([arm]);
    await op('mesh.primitive_uv_sphere_add', {
      segments: 48,
      ring_count: 24,
      radius: P.s,
      name: P.key,
      location: [P.R, 0, P.p],
    });
    await op('object.shade_smooth', {}, { objects: [P.key] });
    await assign(P.material, [P.key]);
    const children = [arm, P.key];
    if (P.ring) {
      // a flat gilt ring around the giant (on the arm, so it orbits but does not spin)
      const ring = `${P.key} Ring`;
      await op('mesh.primitive_torus_add', {
        major_radius: P.s * P.ring.major,
        minor_radius: P.s * P.ring.minor,
        major_segments: 72,
        minor_segments: 16,
        name: ring,
        location: [P.R, 0, P.p],
        rotation: P.ring.tilt,
        scale: [1, 1, P.ring.flatten],
      });
      await op('object.shade_smooth', {}, { objects: [ring] });
      await assign('Gilt', [ring]);
      children.push(ring);
    }
    if (P.key === MOON.planet) {
      // the moon's orbit: a thin brass Bezier circle around the planet; the moon follows it
      await op('curve.primitive_bezier_circle_add', {
        radius: MOON.orbit,
        name: 'Moon Orbit',
        location: [P.R, 0, P.p],
        rotation: [MOON.tilt, 0, 0],
        bevel_depth: 0.0011,
        bevel_resolution: 3,
        resolution_u: 24,
      });
      await op('curve.switch_direction', { object: 'Moon Orbit' }, { objects: ['Moon Orbit'] }); // prograde (counter-clockwise)
      await op('object.material_assign', { material: 'Polished Brass', objects: ['Moon Orbit'], slot: 0 });
      children.push('Moon Orbit');
    }
    await call('set_parent', { objects: children, parent: pivot });
  }
  // the moon itself (unparented; Follow Path carries it along the orbit, which rides on the arm)
  await op('mesh.primitive_uv_sphere_add', {
    segments: 32,
    ring_count: 16,
    radius: MOON.r,
    name: 'Moon',
    location: [0, 0, 0],
  });
  await op('object.shade_smooth', {}, { objects: ['Moon'] });
  await assign('Moon Silver', ['Moon']);
  const c = await op('object.constraint_add', { object: 'Moon', type: 'FOLLOW_PATH', target: 'Moon Orbit' });
  if (c.errors?.length) throw new Error(`Follow Path errors: ${short(c.errors)}`);
  const anim = await op('constraint.followpath_path_animate', {
    object: 'Moon',
    constraint: c.name,
    frame_start: 1,
    length: MOON.framesPerOrbit,
  });
  console.log(`    moon path animation: ${short(anim)}`);
}

/** Expected driven rotation (Z) of every moving part as a function of the master angle m. */
function drivenParts(gears) {
  const parts = [];
  for (const P of PLANETS) {
    parts.push({ object: `${P.key} Pivot`, phase: r4(P.phase), k: P.n, kExpr: `${P.n}`, symmetry: 1 });
    parts.push({ object: P.key, phase: 0, k: P.spin, kExpr: `${P.spin}`, symmetry: 1 });
  }
  // a simple gear train: gear i turns T_great/T_i as fast as the great wheel, the sign alternating
  for (const x of gears)
    parts.push({
      object: x.name,
      phase: r4(x.phase),
      k: x.k,
      kExpr: x === gears[0] ? '1' : `${gears[0].T}/${x.T}`,
      symmetry: x.symmetry,
    });
  parts.push({ object: 'Hub', phase: 0, k: 1, kExpr: '1', symmetry: 1 });
  parts.push({ object: 'Sun', phase: 0, k: -1, kExpr: '1', symmetry: 1 });
  return parts;
}

/** Driver expression θ = φ ± k·m, e.g. "2.3736 - 36/18 * m". */
function driverExpression({ phase, k, kExpr }) {
  const term = kExpr === '1' ? 'm' : `${kExpr} * m`;
  if (!phase) return k < 0 ? `-${term}` : term;
  return `${phase} ${k < 0 ? '-' : '+'} ${term}`;
}

async function mechanism(gears) {
  // ONE master channel
  await call('add_object', {
    type: 'empty',
    name: 'Master Drive',
    location: [0, 0, 0.1],
    params: { radius: 0.1 },
  });
  const keys = await op('anim.keyframes_insert_many', {
    target: 'Master Drive',
    path: 'rotation_euler',
    index: 2,
    frames: [1, LOOP + 1],
    values: [0, TAU],
    interpolation: 'LINEAR',
  });
  const ex = await op('anim.extrapolation_set', {
    objects: ['Master Drive'],
    type: 'CYCLIC',
    path: 'rotation_euler',
    index: 2,
  });
  console.log(`    master: ${short(keys)}; extrapolation ${short(ex)}`);
  const v = [{ name: 'm', target: 'Master Drive', path: 'rotation_euler', index: 2 }];
  const drivers = drivenParts(gears).map((part) => {
    const expression = driverExpression(part);
    console.log(`    ${part.object.padEnd(14)} θ = ${expression}`);
    return [
      'anim.driver_add',
      { target: part.object, path: 'rotation_euler', index: 2, expression, variables: v },
    ];
  });
  const res = await batch('drivers', drivers);
  const bad = res.flatMap((r) => r?.drivers ?? []).filter((d) => d.error);
  if (bad.length) throw new Error(`driver errors: ${short(bad)}`);
}

async function lightsAndCamera() {
  await call('add_object', { type: 'empty', name: 'Focus', location: FOCUS, params: { radius: 0.05 } });
  // warm studio: rectangular soft boxes and a rim strip (shape/size set directly on the new lights)
  for (const L of LIGHTS) {
    const { name, location, ...settings } = L;
    await op('object.light_add', { type: 'AREA', name, location, ...settings });
  }
  await op('object.track_set', { type: 'TRACKTO', target: 'Focus', objects: LIGHTS.map((l) => l.name) });
  // a low kicker that grazes the plinth front so the engraved plate reads
  await op('object.light_add', {
    type: 'AREA',
    name: 'Plate Kicker',
    location: [-0.35, -1.45, 0.3],
    energy: 22,
    color: [1, 0.85, 0.7],
    shape: 'RECTANGLE',
    size: 0.5,
    size_y: 0.2,
  });
  await op('object.track_set', { type: 'TRACKTO', target: 'Motto Plate', objects: ['Plate Kicker'] });
  // camera with depth of field focused on the Focus empty (middle of the planet ring) at every frame
  await op('object.camera_add', {
    name: 'Camera',
    location: CAMERA.location,
    lens: CAMERA.lens,
    dof_use: true,
    dof_focus_object: 'Focus',
    dof_aperture_fstop: CAMERA.fstop,
  });
  await op('object.track_set', { type: 'TRACKTO', target: 'Focus', objects: ['Camera'] });
  await call('set_active_camera', { camera: 'Camera' });
  const cam = await call('get_object', { object: 'Camera' }, { quiet: true });
  console.log(`    camera: ${short(cam.data, 400)}`);
  if (!cam.data?.dof_use) throw new Error('camera depth of field is not enabled');
}

// ---------------------------------------------------------------------------------- verification

/** get_scene problems: any evaluation error fails the build. */
async function verifyScene() {
  const scene = await call('get_scene', { frame: 1 }, { quiet: true });
  console.log(`  scene: ${short(scene.counts, 400)}`);
  const problems = scene.problems ?? [];
  if (problems.length) throw new Error(`scene problems: ${short(problems, 2000)}`);
  return scene;
}

/**
 * Reads the EVALUATED transforms back with get_object at several frames and checks the mechanism:
 * every driven angle, the gear ratios and opposite senses of meshing pairs, the planets' orbit
 * radii, the moon's path around its planet, and that frame 49 looks exactly like frame 1.
 */
async function verifyMotion(gears) {
  const frames = [1, 4, 7, 13, 25, 37, LOOP + 1];
  const master = (f) => (TAU * (f - 1)) / LOOP; // linear key 0 → 2π over frames 1 → 49
  const parts = drivenParts(gears);
  const angle = {}; // object → frame → evaluated rotation Z
  const errors = [];
  const check = (cond, msg) => {
    if (!cond) errors.push(msg);
  };
  for (const part of parts) {
    angle[part.object] = {};
    for (const f of frames) {
      const o = await call('get_object', { object: part.object, frame: f }, { quiet: true });
      const z = o.rotation_euler[2];
      angle[part.object][f] = z;
      const want = part.phase + part.k * master(f);
      check(Math.abs(z - want) < 2e-3, `${part.object} f${f}: rotation ${z.toFixed(4)} ≠ ${want.toFixed(4)}`);
      // the driver overrides the document value, which get_object lists as `stored`
      if (f === 13)
        check(
          Array.isArray(o.stored?.rotation_euler),
          `${part.object}: no stored rotation reported next to the driven one`,
        );
    }
    // seamless loop: the turn over 48 frames is a multiple of the part's visual symmetry
    const turns = (angle[part.object][LOOP + 1] - angle[part.object][1]) / TAU;
    check(
      Math.abs(turns * part.symmetry - Math.round(turns * part.symmetry)) < 1e-3,
      `${part.object} turns ${turns} per loop: seam`,
    );
  }
  // meshing pairs: opposite senses, speed ratio teeth_A / teeth_B
  const pairs = [];
  for (const B of gears.filter((x) => x.meshesWith)) {
    const A = B.meshesWith;
    for (const f of [7, 13]) {
      const dA = angle[A.name][f] - angle[A.name][1];
      const dB = angle[B.name][f] - angle[B.name][1];
      const ratio = dB / dA;
      check(Math.sign(dA) === -Math.sign(dB), `${A.name}/${B.name} turn the same way`);
      check(Math.abs(ratio + A.T / B.T) < 1e-3, `${A.name}/${B.name} ratio ${ratio} ≠ −${A.T}/${B.T}`);
      if (f === 13)
        pairs.push(
          `${A.name} ${A.T}T → ${B.name} ${B.T}T: Δθ ${dA.toFixed(3)} → ${dB.toFixed(3)} rad (ratio ${ratio.toFixed(4)} = −${A.T}/${B.T})`,
        );
    }
  }
  // planets stay on their orbits (world position at radius R from the spindle)
  for (const P of PLANETS)
    for (const f of [1, 7, 13]) {
      const o = await call('get_object', { object: P.key, frame: f }, { quiet: true });
      const r = Math.hypot(o.world_location[0], o.world_location[1]);
      check(Math.abs(r - P.R) < 1e-3, `${P.key} f${f}: orbit radius ${r.toFixed(4)} ≠ ${P.R}`);
    }
  // the moon: on its orbit around its planet, one prograde orbit every 12 frames. The orbit rides on
  // the planet's arm, so the moon's position is taken relative to the planet, turned back into the
  // arm's frame (minus the pivot angle) and then into the tilted orbit plane, where its angle must
  // advance by 360°·Δf/12: a quarter orbit at frames 4, 7, 10, a full one at 13, 25 and 49.
  const moonFrames = [1, 4, 7, 10, 13, 25, LOOP + 1];
  const moonAngle = {};
  for (const f of moonFrames) {
    const m = await call('get_object', { object: 'Moon', frame: f }, { quiet: true });
    const p = await call('get_object', { object: MOON.planet, frame: f }, { quiet: true });
    const rel = m.world_location.map((x, i) => x - p.world_location[i]);
    const pivot = `${MOON.planet} Pivot`;
    const a = -(
      angle[pivot][f] ??
      (await call('get_object', { object: pivot, frame: f }, { quiet: true })).rotation_euler[2]
    );
    const ax = rel[0] * Math.cos(a) - rel[1] * Math.sin(a);
    const ay = rel[0] * Math.sin(a) + rel[1] * Math.cos(a);
    const oy = ay * Math.cos(MOON.tilt) + rel[2] * Math.sin(MOON.tilt); // undo the orbit's tilt about the arm
    const oz = -ay * Math.sin(MOON.tilt) + rel[2] * Math.cos(MOON.tilt);
    const d = Math.hypot(...rel);
    check(
      Math.abs(d - MOON.orbit) < 1.5e-3,
      `Moon f${f}: ${d.toFixed(4)} m from ${MOON.planet} ≠ ${MOON.orbit}`,
    );
    check(Math.abs(oz) < 1e-3, `Moon f${f}: ${oz.toFixed(4)} m off its orbit plane`);
    moonAngle[f] = Math.atan2(oy, ax);
  }
  const moonSteps = [];
  for (const f of moonFrames.slice(1)) {
    const want = mod(((f - 1) / MOON.framesPerOrbit) * TAU, TAU);
    const got = mod(moonAngle[f] - moonAngle[1], TAU);
    const err = Math.min(Math.abs(got - want), TAU - Math.abs(got - want));
    const shown = got > TAU - 1e-3 ? got - TAU : got; // 359.99° → −0.01°
    check(
      err < 1.5 * DEG,
      `Moon f${f}: ${(shown / DEG).toFixed(1)}° along its orbit since frame 1 ≠ ${(want / DEG).toFixed(1)}°`,
    );
    const orbits = (f - 1) / MOON.framesPerOrbit;
    moonSteps.push(
      `f${f} ${(shown / DEG).toFixed(1)}°${Number.isInteger(orbits) ? ` (${orbits} orbit${orbits > 1 ? 's' : ''})` : ''}`,
    );
  }
  for (const line of pairs) console.log(`    ${line}`);
  const fmt = (o) => [1, 13, 25, LOOP + 1].map((f) => r4(angle[o][f])).join(' / ');
  for (const o of [
    'Ember Pivot',
    'Azure Pivot',
    'Verdant Pivot',
    'Titan Pivot',
    'Great Wheel',
    'Idler Wheel',
    'Third Wheel',
    'Pinion',
  ])
    console.log(`    ${o.padEnd(14)} θ at frames 1/13/25/49: ${fmt(o)}`);
  console.log(
    `    moon ${MOON.orbit} m from ${MOON.planet}; angle along its orbit (arm frame) since frame 1: ${moonSteps.join(', ')} → one orbit every ${MOON.framesPerOrbit} frames`,
  );
  if (errors.length) throw new Error(`motion check failed:\n  ${errors.join('\n  ')}`);
  console.log(
    `  ✓ motion verified: ${parts.length} driven parts × ${frames.length} frames, ${pairs.length} meshing pairs, moon period, seamless ${LOOP}-frame loop`,
  );
}

/**
 * Exact clearance between the moving parts at every frame of the loop: scene.measure with
 * surface_distance (at most 8 objects per call) on groups that together cover every pair of
 * different assemblies — the four planet arms (planet, arm, ring, moon orbit and moon), the sun and
 * the four wheels. Contacts inside one assembly (a planet in its cup, the moon threaded on its wire)
 * are by design and skipped; any other pair closer than CLEARANCE fails the build.
 */
async function verifyClearance() {
  const assembly = {}; // object name → assembly
  for (const P of PLANETS) {
    const objs = [
      P.key,
      `${P.key} Arm`,
      ...(P.ring ? [`${P.key} Ring`] : []),
      ...(P.key === MOON.planet ? ['Moon Orbit', 'Moon'] : []),
    ];
    for (const o of objs) assembly[o] = P.key;
  }
  assembly.Sun = 'Sun';
  for (const x of GEARS) assembly[x.name] = x.name;
  const members = (key) => Object.keys(assembly).filter((o) => assembly[o] === key);
  const [E, A, V, T] = PLANETS.map((P) => members(P.key));
  const groups = [
    [...E, ...A, ...V],
    [...V, ...T, 'Sun'],
    [...E, ...A, ...T, 'Sun'],
    GEARS.map((x) => x.name),
  ];
  // every pair of different assemblies must be measured in at least one group of ≤ 8 objects
  const covered = new Set(groups.flatMap((g) => g.flatMap((a) => g.map((b) => `${a}|${b}`))));
  const names = Object.keys(assembly);
  for (const a of names)
    for (const b of names) {
      const sameKind = GEARS.some((x) => x.name === a) === GEARS.some((x) => x.name === b); // gears sit far below the arms
      if (assembly[a] !== assembly[b] && sameKind && !covered.has(`${a}|${b}`))
        throw new Error(`clearance groups miss ${a} / ${b}`);
    }
  if (groups.some((g) => g.length > 8))
    throw new Error('scene.measure takes at most 8 objects for surface distances');

  const worst = new Map(); // "a / b" → closest {d, f}
  const failures = [];
  const t0 = Date.now();
  for (let f = 1; f <= LOOP; f++)
    for (const objects of groups) {
      const res = await call(
        'run_operator',
        { operator: 'scene.measure', params: { objects, frame: f, surface_distance: true } },
        { quiet: true },
      );
      for (const p of res.result?.distances ?? []) {
        if (assembly[p.a_name] === assembly[p.b_name]) continue;
        const key = [p.a_name, p.b_name].sort().join(' / ');
        const d = p.surface_distance;
        if (typeof d !== 'number')
          throw new Error(`scene.measure gave no surface distance for ${key}: ${short(p)}`);
        const w = worst.get(key);
        if (!w || d < w.d) worst.set(key, { d, f });
        const limit = GEARS.some((x) => x.name === p.a_name) ? CLEARANCE.gears : CLEARANCE.planets;
        if (p.intersecting || d < limit)
          failures.push(`f${f} ${key}: ${p.intersecting ? 'INTERSECTING' : `${(d * 1000).toFixed(2)} mm`}`);
      }
    }
  const closest = [...worst.entries()].sort((a, b) => a[1].d - b[1].d);
  for (const [key, w] of closest.slice(0, 8))
    console.log(`    closest: ${key.padEnd(28)} ${(w.d * 1000).toFixed(1)} mm at frame ${w.f}`);
  if (failures.length)
    throw new Error(`clearance check failed (${failures.length}):\n  ${failures.slice(0, 40).join('\n  ')}`);
  console.log(
    `  ✓ clearance verified: ${worst.size} pairs of moving parts × ${LOOP} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s (planets ≥ ${CLEARANCE.planets * 1000} mm, gear teeth never cross)`,
  );
}

/**
 * Framing: the table must fill the whole frame, so no edge of it can show. The camera's axes come
 * from its evaluated world rotation (Track To on the Focus empty); rays through the four image
 * corners (36 mm sensor across the 16:9 image) must hit the top face of the table.
 */
async function verifyFraming() {
  const cam = await call('get_object', { object: 'Camera', frame: 1 }, { quiet: true });
  const [ex, ey, ez] = cam.world_transform.rotation_euler; // XYZ Euler: R = Rz·Ry·Rx
  const rot = ([x, y, z]) => {
    [y, z] = [y * Math.cos(ex) - z * Math.sin(ex), y * Math.sin(ex) + z * Math.cos(ex)];
    [x, z] = [x * Math.cos(ey) + z * Math.sin(ey), -x * Math.sin(ey) + z * Math.cos(ey)];
    [x, y] = [x * Math.cos(ez) - y * Math.sin(ez), x * Math.sin(ez) + y * Math.cos(ez)];
    return [x, y, z];
  };
  const right = rot([1, 0, 0]);
  const up = rot([0, 1, 0]);
  const fwd = rot([0, 0, -1]);
  const tx = 18 / CAMERA.lens;
  const ty = (tx * 720) / 1280;
  const seen = [];
  for (const [sx, sy, label] of [
    [-1, 1, 'top left'],
    [1, 1, 'top right'],
    [-1, -1, 'bottom left'],
    [1, -1, 'bottom right'],
  ]) {
    const direction = fwd.map((v, i) => v + sx * tx * right[i] + sy * ty * up[i]);
    const r = await call(
      'run_operator',
      {
        operator: 'scene.raycast',
        params: { origin: cam.world_location, direction, objects: ['Table'], frame: 1 },
      },
      { quiet: true },
    );
    const hit = r.result;
    if (!hit?.hit || hit.normal[2] < 0.99)
      throw new Error(`framing: the ${label} image corner does not see the table top (${short(hit)})`);
    seen.push(`${label} (${hit.point.map((v) => v.toFixed(2)).join(', ')})`);
  }
  console.log(`  ✓ framing: all four image corners see the table top: ${seen.join('; ')}`);
}

// ---------------------------------------------------------------------------------- renders

async function renderStill(file, opts) {
  const t0 = Date.now();
  const res = await call('render_image', { width: 1280, height: 720, frame: 1, ...opts });
  timings[path.basename(file)] = { ms: Date.now() - t0, info: res.text };
  for (const w of res.text?.warnings ?? []) warnings.push(`${path.basename(file)}: ${w}`);
  await saveImage(res, file);
  console.log(`    → ${file} ${short(res.text, 400)}`);
  return res.text;
}

async function previews() {
  await mkdir(PREVIEW_DIR, { recursive: true });
  await renderStill(path.join(PREVIEW_DIR, 'raster.png'), { width: 960, height: 540, engine: 'RASTER' });
  await renderStill(path.join(PREVIEW_DIR, 'pt-preview.png'), {
    width: 640,
    height: 360,
    engine: 'PATHTRACER',
    samples: 16,
    time_limit: 60,
  });
  const sheet = await call('render_animation', {
    format: 'CONTACT_SHEET',
    frame_start: 1,
    frame_end: LOOP,
    frame_step: 4,
    width: 320,
    height: 180,
    columns: 4,
    engine: 'RASTER',
    time_limit: 120,
  });
  await saveImage(sheet, path.join(PREVIEW_DIR, 'raster-sheet.png'));
  console.log(`    → ${PREVIEW_DIR}/raster-sheet.png ${short(sheet.text, 300)}`);
}

async function finalStill() {
  // path traced 1280×720 still; sampling stops at 160 spp or after 470 s, whichever comes first
  return renderStill(path.join(OUT_DIR, 'render.png'), {
    engine: 'PATHTRACER',
    samples: 160,
    denoise: true,
    time_limit: 470,
  });
}

async function animation() {
  // path traced frames with few samples; the denoiser cleans every frame (also frames that stop early)
  const common = { frame_start: 1, frame_end: LOOP, engine: 'PATHTRACER', denoise: true, max_bounces: 4 };
  let t0 = Date.now();
  const sheet = await call('render_animation', {
    ...common,
    format: 'CONTACT_SHEET',
    frame_step: 4,
    width: 320,
    height: 180,
    columns: 4,
    samples: 12,
    time_limit: 240,
  });
  timings['contact_sheet.png'] = { ms: Date.now() - t0, info: sheet.text };
  await saveImage(sheet, path.join(OUT_DIR, 'contact_sheet.png'));
  console.log(`    → contact_sheet.png ${short(sheet.text, 400)}`);
  // GIF: 8 spp with the largest budget render_animation allows (600 s, i.e. a 37.5 s share per frame
  // on each of 3 threads; a frame needs ~9 s on an idle core, ~25 s on a busy machine), so every
  // frame reaches the same sample count: with the fixed seed the static parts are then identical in
  // every frame (frames cut short at a lower count would shimmer). Dropped frames fail the build;
  // frames that stopped sampling early (undersampled_frames) are reported as a warning.
  t0 = Date.now();
  const gif = await call('render_animation', {
    ...common,
    format: 'GIF',
    width: 480,
    height: 270,
    samples: 8,
    fps: 16,
    dither: 'BAYER',
    time_limit: 600,
  });
  timings['preview.gif'] = { ms: Date.now() - t0, info: gif.text };
  await saveImage(gif, path.join(OUT_DIR, 'preview.gif'));
  console.log(`    → preview.gif ${short(gif.text, 400)}`);
  for (const [file, r] of [
    ['contact_sheet.png', sheet],
    ['preview.gif', gif],
  ]) {
    const info = r.text ?? {};
    for (const w of info.warnings ?? []) warnings.push(`${file}: ${w}`);
    if (info.truncated) throw new Error(`${file}: animation truncated: ${short(info)}`);
    const s = info.samples_reached ?? {};
    console.log(
      `    ${file}: ${info.frame_count} frames, samples per pixel reached min ${s.min} / mean ${s.mean} / max ${s.max} of ${info.requested_samples}`,
    );
    if (info.undersampled_frames?.length)
      warnings.push(
        `${file}: frames ${info.undersampled_frames.join(', ')} stopped sampling early (time budget)`,
      );
    else console.log(`    ${file}: every frame reached its full samples`);
  }
}

/** The JSON chunk of a binary glTF (12-byte header, then the JSON chunk's length, type and data). */
function glbJson(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67 || buf.readUInt32LE(16) !== 0x4e4f534a)
    throw new Error('scene.glb is not a binary glTF');
  return JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
}

async function exportGlb(gears) {
  // The glTF exporter samples the evaluated scene once per frame of the scene's frame range, so the
  // live drivers and the moon's Follow Path constraint export as they are (as keyframed node
  // rotations and the moon's translation); where a path curves between frames (the moon's fast
  // orbit) it adds keys between the frames. The range is extended to frame 49 (= frame 1) for the
  // export, so the clip ends where it starts and loops seamlessly, and set back to 1–48 afterwards.
  const t0 = Date.now();
  let res;
  await call('set_scene_settings', { frame_end: LOOP + 1 });
  try {
    res = await call('export_scene', { format: 'glb' });
  } finally {
    await call('set_scene_settings', { frame_end: LOOP });
  }
  const info = res.text ?? {};
  const blob = res.resources?.find((r) => r.blob)?.blob;
  if (!blob) throw new Error(`export returned no file: ${short(res)}`);
  for (const w of info.warnings ?? []) warnings.push(`export: ${short(w)}`);
  const buf = Buffer.from(blob, 'base64');
  // check the file: one clip that animates every driven part and the moon, every channel keyed at
  // least once per frame 1–49 (channels of curved paths also between frames)
  const gltf = glbJson(buf);
  const anim = gltf.animations?.[0];
  const inputs = (anim?.samplers ?? []).map((s) => gltf.accessors[s.input]);
  const keys = inputs.map((a) => a.count);
  const badInput = inputs.find(
    (a) => a.count < LOOP + 1 || Math.abs(a.min[0]) > 1e-6 || Math.abs(a.max[0] - LOOP / FPS) > 1e-3,
  );
  const animated = new Set((anim?.channels ?? []).map((c) => gltf.nodes[c.target.node].name));
  const missing = [...drivenParts(gears).map((p) => p.object), 'Moon'].filter((o) => !animated.has(o));
  if (!inputs.length || badInput || missing.length)
    throw new Error(
      `scene.glb animation: ${badInput ? `${badInput.count} keys from ${badInput.min?.[0]} to ${badInput.max?.[0]} s` : `${inputs.length} samplers`} (want at least ${LOOP + 1} keys from 0 to ${LOOP / FPS} s); not animated: ${missing.join(', ') || 'none'}`,
    );
  const extra = (anim.channels ?? [])
    .filter((c) => keys[c.sampler] > LOOP + 1)
    .map((c) => `${gltf.nodes[c.target.node].name} ${c.target.path} ${keys[c.sampler]}`);
  console.log(
    `    scene.glb: ${gltf.nodes.length} nodes, ${gltf.meshes.length} meshes, ${gltf.materials.length} materials, ${gltf.images?.length ?? 0} baked texture images, ` +
      `1 animation: ${anim.channels.length} channels on ${animated.size} nodes × ${LOOP + 1} keys (frames 1–${LOOP + 1}, ${(LOOP / FPS).toFixed(3)} s)` +
      `${extra.length ? `, keys between frames: ${extra.join(', ')}` : ''}; export ${info.elapsed_ms} ms`,
  );
  await writeFile(path.join(OUT_DIR, 'scene.glb'), buf);
  timings['scene.glb'] = { ms: Date.now() - t0, bytes: buf.length };
  console.log(`    → scene.glb ${(buf.length / 1e6).toFixed(2)} MB`);
}

// ---------------------------------------------------------------------------------- main

const T0 = Date.now();
try {
  console.log(`stages: ${[...STAGES].join(', ')}  outputs: ${OUT_DIR}`);
  await mkdir(OUT_DIR, { recursive: true });
  console.log('● planet layout (swept annuli)');
  layoutPlanets();
  console.log('● project');
  await resetProject();
  console.log('● scene settings & materials');
  await sceneSettings();
  await materials();
  console.log('● plinth, dial, motto plate');
  await plinth();
  await dial();
  await textPlate();
  console.log('● gear train');
  const gears = await gearTrain();
  console.log('● sun, spindle, planets, moon');
  await sunAndSpindle();
  await planetArms();
  console.log('● mechanism (master channel + drivers)');
  await mechanism(gears);
  console.log('● lights & camera');
  await lightsAndCamera();
  console.log('● verify');
  await verifyScene();
  await verifyMotion(gears);
  await verifyClearance();
  await verifyFraming();
  timings.build = { ms: Date.now() - T0 };
  if (STAGES.has('preview')) {
    console.log('● previews');
    await previews();
  }
  if (STAGES.has('still')) {
    console.log('● final still');
    await finalStill();
  }
  if (STAGES.has('anim')) {
    console.log('● animation');
    await animation();
  }
  if (STAGES.has('export')) {
    console.log('● export');
    await exportGlb(gears);
  }
  console.log(`\nDone in ${((Date.now() - T0) / 1000).toFixed(1)} s. Project ${project}`);
  console.log(
    'timings:',
    JSON.stringify(
      Object.fromEntries(
        Object.entries(timings).map(([k, v]) => [
          k,
          { s: r4(v.ms / 1000), ...(v.bytes ? { bytes: v.bytes } : {}), ...(v.info ? { info: v.info } : {}) },
        ]),
      ),
      null,
      1,
    ),
  );
  if (warnings.length) console.log(`warnings (${warnings.length}):\n  ${warnings.join('\n  ')}`);
} catch (e) {
  console.error(`\nBUILD FAILED after ${((Date.now() - T0) / 1000).toFixed(1)} s: ${e.message}`);
  process.exitCode = 1;
} finally {
  await mcp.close();
}
