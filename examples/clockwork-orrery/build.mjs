#!/usr/bin/env node
/**
 * Clockwork Orrery — an original brass orrery on a dark marble plinth, built entirely through the
 * 3D editor's MCP server (the same tools an external AI agent uses).
 *
 *   MCP_URL=http://127.0.0.1:8080/mcp node examples/clockwork-orrery/build.mjs [--stages list]
 *
 * Stages (comma separated, default "build,still,anim,export"):
 *   build    delete + recreate the project and build the whole scene (always runs first)
 *   preview  quick raster + low-sample path traced previews into $PREVIEW_DIR (default /tmp)
 *   still    render.png   — final path traced still (1280×720)
 *   anim     preview.gif + contact_sheet.png — 48-frame loop of the mechanism
 *   export   scene.glb    — glTF binary export
 *
 * Mechanism: ONE master channel — the empty "Master Drive", rotation Z keyed linearly 0 → 2π over
 * frames 1 → 49 (anim.keyframes_insert_many) and repeated forever (anim.extrapolation_set CYCLIC).
 * Every moving part reads it through a scripted driver (anim.driver_add):
 *   planet arms   θ = phase + n·m      n = 4, 3, 2, 1 orbits per master turn (12/16/24/48 frames)
 *   planet spin   θ = s·m              (integer turns, so the 48-frame loop is seamless)
 *   gear train    θ_B = φ_B − (T_A/T_B)·(θ_A − φ_A)  for every meshing pair A→B (opposite senses,
 *                 ratio teeth_A/teeth_B; φ chosen so a tooth of A sits in a gap of B)
 * The moon rides a Bezier circle parented to the third planet's arm (FOLLOW_PATH constraint,
 * timed with constraint.followpath_path_animate).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../../scripts/mcp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_NAME = 'clockwork-orrery';
const PREVIEW_DIR = process.env.PREVIEW_DIR ?? path.join(os.tmpdir(), 'clockwork-orrery-previews');
const argStages = (() => {
  const i = process.argv.indexOf('--stages');
  return i >= 0 ? process.argv[i + 1] : process.env.STAGES;
})();
const STAGES = new Set((argStages ?? 'build,still,anim,export').split(',').map((s) => s.trim()));
STAGES.add('build');

const TAU = 2 * Math.PI;
const DEG = Math.PI / 180;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const mod = (a, n) => ((a % n) + n) % n;

// ---------------------------------------------------------------------------------- MCP helpers

const mcp = await connect();
let project = null; // project id once created
const timings = {};
const warnings = [];

function short(v, n = 400) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Calls an MCP tool on the project; logs and rethrows errors with context. */
async function call(tool, args = {}, { quiet = false, withProject = true } = {}) {
  const t0 = Date.now();
  const full = withProject && project ? { project, ...args } : args;
  try {
    const res = await mcp.call(tool, full, {
      onProgress: (p) =>
        process.stderr.write(`    … ${p.message ?? `${p.progress}/${p.total ?? '?'}`}\r`),
    });
    if (!quiet) console.log(`  ✓ ${tool}${args.operator ? ` ${args.operator}` : ''} (${Date.now() - t0} ms)`);
    return res;
  } catch (e) {
    console.error(`  ✗ ${tool}${args.operator ? ` ${args.operator}` : ''}: ${e.message}`);
    console.error(`    args: ${short(args, 1200)}`);
    throw e;
  }
}

/** run_operator → the operator's own result; reports (warnings) are echoed. */
async function op(operator, params = {}, selection) {
  const r = await call('run_operator', { operator, params, ...(selection ? { selection } : {}) });
  for (const rep of r.reports ?? []) {
    const msg = `${operator}: ${rep.type ?? ''} ${rep.message ?? short(rep)}`;
    console.log(`    report ${msg}`);
    if (/WARN|ERROR/i.test(rep.type ?? '')) warnings.push(msg);
  }
  return r.result;
}

/** batch → one undo step; fails loudly if any operation failed. */
async function batch(label, operations) {
  const r = await call('batch', {
    operations: operations.map(([operator, params]) => ({ operator, params })),
  }, { quiet: true });
  const results = r.results ?? r.operations ?? [];
  const failed = results.filter((x) => x && x.ok === false);
  console.log(`  ✓ batch "${label}": ${operations.length} operators${failed.length ? `, ${failed.length} FAILED` : ''}`);
  if (failed.length || r.ok === false) throw new Error(`batch ${label} failed: ${short(r, 2000)}`);
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
const BASE = { r: 0.52, h: 0.05 }; // dark wood
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
// turn n (=> periods 12, 16, 24, 48 frames), spin turns per master turn, start angle.
const PLANETS = [
  { key: 'Ember', R: 0.135, s: 0.021, h: 0.585, p: 0.655, n: 4, spin: 8, phase: 68 * DEG },
  { key: 'Azure', R: 0.205, s: 0.028, h: 0.525, p: 0.63, n: 3, spin: 6, phase: 138 * DEG },
  { key: 'Verdant', R: 0.285, s: 0.034, h: 0.46, p: 0.605, n: 2, spin: 4, phase: 8 * DEG },
  { key: 'Titan', R: 0.37, s: 0.052, h: 0.39, p: 0.575, n: 1, spin: 3, phase: 228 * DEG },
];
const MOON = { orbit: 0.068, r: 0.0115, framesPerOrbit: 12, tilt: 14 * DEG };

// Gear train on the deck: module (pitch diameter per tooth) and tooth depth shared by all gears so
// they mesh. Pitch radius = MODULE·T/2, tip radius = pitch + DEPTH/2.
const MODULE = 0.0066;
const DEPTH = 0.0115;
const CLEAR = 0.0008; // extra centre distance (backlash)
const GEAR_T = 0.012;
const GEAR_Z = DECK_TOP + 0.0012 + GEAR_T / 2;
const GEARS = [
  { name: 'Great Wheel', T: 36, material: 'Brass', spokes: 6 },
  { name: 'Idler Wheel', T: 18, material: 'Gilt', angle: -38 * DEG },
  { name: 'Third Wheel', T: 27, material: 'Brass', spokes: 5, dist: 0.262 },
  { name: 'Pinion', T: 12, material: 'Copper', dist: 0.305 },
];

const MOTTO = 'THE HEAVENS\nKEPT IN BRASS';

// Camera & lights
const FOCUS = [0, -0.03, 0.335];
const CAMERA = { location: [1.3, -2.47, 1.24], lens: 50, fstop: 2.8 };

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
    B.meshesWith = A.name;
  }
  // sanity: neighbours mesh, nothing else collides, everything stays on the deck
  for (let i = 0; i < g.length; i++)
    for (let j = i + 1; j < g.length; j++) {
      const d = Math.hypot(g[i].x - g[j].x, g[i].y - g[j].y);
      const meshing = j === i + 1;
      if (meshing && Math.abs(d - (g[i].rp + g[j].rp + CLEAR)) > 1e-9)
        throw new Error(`gear ${g[i].name}/${g[j].name} centre distance ${d}`);
      if (!meshing && d < g[i].tip + g[j].tip + 0.008)
        throw new Error(`gears ${g[i].name} and ${g[j].name} collide (${d.toFixed(4)} m)`);
    }
  for (const x of g)
    if (Math.hypot(x.x, x.y) + x.tip > DIAL.innerRing - 0.006) throw new Error(`gear ${x.name} runs into the dial ring`);
  return g;
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
    frame_end: 48,
    fps: 24,
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
    exposure: -1.15,
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
  // Presets give physically plausible starting points; each is created once and shared.
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
    // dark marble: near-black stone with pale gold-grey veins (MARBLE factor 0 = vein)
    ['material.procedural_set', {
      material: 'Dark Marble',
      channel: 'base_color',
      procedural: { color_a: [0.26, 0.22, 0.17], color_b: [0.007, 0.0075, 0.009], scale: 3.2, distortion: 2.6, params: { marble_type: 'SHARPER' } },
    }],
    ['material.update', { material: 'Dark Marble', roughness: 0.3, coat_weight: 0 }],
    // dark walnut for the plinth foot, lighter oiled wood for the table
    ['material.procedural_set', {
      material: 'Dark Wood',
      channel: 'base_color',
      procedural: { color_a: [0.022, 0.009, 0.004], color_b: [0.075, 0.032, 0.014] },
    }],
    ['material.update', { material: 'Dark Wood', roughness: 0.38 }],
    ['material.procedural_set', {
      material: 'Table Wood',
      channel: 'base_color',
      procedural: { color_a: [0.045, 0.02, 0.009], color_b: [0.09, 0.043, 0.019], scale: 11, distortion: 0.7, params: { grain: 0.45 } },
    }],
    ['material.update', { material: 'Table Wood', roughness: 0.42 }],
    ['material.new', { name: 'Blued Steel', assign: false, base_color: [0.07, 0.09, 0.16, 1], metallic: 1, roughness: 0.22 }],
    ['material.new', { name: 'Black Enamel', assign: false, base_color: [0.006, 0.006, 0.007, 1], metallic: 0, roughness: 0.3 }],
    ['material.new', { name: 'Midnight Enamel', assign: false, base_color: [0.003, 0.007, 0.03, 1], metallic: 0, roughness: 0.25, coat_weight: 0.5, coat_roughness: 0.08 }],
    // the sun: warm emission with a granulated procedural emission colour
    ['material.new', { name: 'Sun', assign: false, base_color: [1, 0.62, 0.22, 1], emission_color: [1, 0.55, 0.15], emission_strength: 2.4, roughness: 0.5 }],
    ['material.procedural_set', {
      material: 'Sun',
      channel: 'emission',
      procedural: { type: 'NOISE', mapping: 'OBJECT', scale: 38, detail: 5, roughness: 0.55, color_a: [0.95, 0.16, 0.01], color_b: [1, 0.62, 0.16], ramp_low: 0.35, ramp_high: 0.68 },
    }],
    // planets
    ['material.new', { name: 'Verdant', assign: false, base_color: [0.05, 0.2, 0.5, 1], roughness: 0.45 }],
    ['material.procedural_set', {
      material: 'Verdant',
      channel: 'base_color',
      procedural: { type: 'NOISE', mapping: 'OBJECT', scale: 34, detail: 6, roughness: 0.55, color_a: [0.012, 0.05, 0.2], color_b: [0.13, 0.24, 0.07], ramp_low: 0.49, ramp_high: 0.53 },
    }],
    ['material.new', { name: 'Banded Giant', assign: false, base_color: [0.8, 0.55, 0.3, 1], roughness: 0.55 }],
    ['material.procedural_set', {
      material: 'Banded Giant',
      channel: 'base_color',
      procedural: { type: 'WAVE', mapping: 'OBJECT', scale: 7, distortion: 3.5, detail: 3, color_a: [0.7, 0.45, 0.2], color_b: [0.2, 0.07, 0.025], params: { wave_type: 'BANDS', direction: 'Z' } },
    }],
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
  // table top: rotated so the procedural wood rings run along world X (plank-like grain); deep
  // enough that its far edge stays above the frame and the wood fades into the dark
  await op('mesh.primitive_cube_add', { size: 1, name: 'Table', location: [0, 7, -0.025], scale: [0.05, 16, 8], rotation: [0, Math.PI / 2, 0] });
  await op('object.transform_apply', { location: false, rotation: false, scale: true }, { objects: ['Table'] });
  await assign('Table Wood', ['Table']);

  await op('mesh.primitive_cylinder_add', { vertices: 8, radius: BASE.r, depth: BASE.h, name: 'Plinth Base', location: [0, 0, BASE.h / 2], rotation: [0, 0, Math.PI / 8] });
  await op('mesh.primitive_cylinder_add', { vertices: 8, radius: PLINTH.r, depth: PLINTH.h, name: 'Plinth', location: [0, 0, PLINTH.z0 + PLINTH.h / 2], rotation: [0, 0, Math.PI / 8] });
  await op('mesh.primitive_cylinder_add', { vertices: 96, radius: DECK.r, depth: DECK.t, name: 'Deck', location: [0, 0, PLINTH_TOP + DECK.t / 2] });
  // a thin gilt moulding where the marble meets the wood
  await op('mesh.primitive_cylinder_add', { vertices: 8, radius: PLINTH.r + 0.008, depth: 0.012, name: 'Moulding', location: [0, 0, PLINTH.z0 + 0.006], rotation: [0, 0, Math.PI / 8] });
  await call('add_modifier', { object: 'Plinth Base', type: 'BEVEL', params: { width: 0.012, segments: 3, limit_method: 'ANGLE' } });
  await call('add_modifier', { object: 'Plinth', type: 'BEVEL', params: { width: 0.007, segments: 3, limit_method: 'ANGLE' } });
  await call('add_modifier', { object: 'Deck', type: 'BEVEL', params: { width: 0.0025, segments: 2, limit_method: 'ANGLE' } });
  await call('add_modifier', { object: 'Moulding', type: 'BEVEL', params: { width: 0.004, segments: 2, limit_method: 'ANGLE' } });
  await assign('Dark Wood', ['Plinth Base']);
  await assign('Dark Marble', ['Plinth']);
  await assign('Midnight Enamel', ['Deck']);
  await assign('Gilt', ['Moulding']);
  await autoSmooth(['Deck']);
}

async function dial() {
  // gilt chapter rings and twelve Roman numerals around the enamelled deck, like a clock dial
  const z = DECK_TOP + 0.0006;
  await op('mesh.primitive_torus_add', { major_radius: DIAL.innerRing, minor_radius: 0.0016, major_segments: 160, minor_segments: 8, name: 'Chapter Ring', location: [0, 0, z], scale: [1, 1, 0.5] });
  await op('mesh.primitive_torus_add', { major_radius: DIAL.outerRing, minor_radius: 0.0026, major_segments: 160, minor_segments: 10, name: 'Dial Rim', location: [0, 0, DECK_TOP], scale: [1, 1, 0.8] });
  await op('object.shade_smooth', {}, { objects: ['Chapter Ring', 'Dial Rim'] });
  const numerals = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
  const names = [];
  for (const [n, body] of numerals.entries()) {
    const theta = Math.PI / 2 - (n * TAU) / 12; // XII at the back (+Y), clockwise like a clock
    const name = `Numeral ${body}`;
    // text lies in XY facing +Z; rotate so the letters' up points away from the centre
    await op('object.text_add', {
      body, size: DIAL.size, align_x: 'CENTER', align_y: 'CENTER', extrude: 0.0006, name,
      location: [r4(DIAL.numeralR * Math.cos(theta)), r4(DIAL.numeralR * Math.sin(theta)), z + 0.0006],
      rotation: [0, 0, r4(theta - Math.PI / 2)],
    });
    names.push(name);
  }
  await op('object.material_assign', { material: 'Gilt', objects: ['Chapter Ring', 'Dial Rim', ...names], slot: 0 });
}

async function textPlate() {
  const faceY = -APOTHEM; // front face of the marble octagon
  const plate = { w: 0.3, h: 0.096, t: 0.006, z: PLINTH.z0 + PLINTH.h / 2 };
  const plateFront = faceY - plate.t;
  await op('mesh.primitive_cube_add', { size: 1, name: 'Motto Plate', location: [0, faceY - plate.t / 2, plate.z], scale: [plate.w, plate.t, plate.h] });
  await op('object.transform_apply', { location: false, rotation: false, scale: true }, { objects: ['Motto Plate'] });
  await call('add_modifier', { object: 'Motto Plate', type: 'BEVEL', params: { width: 0.0018, segments: 2, limit_method: 'ANGLE' } });
  await assign('Plate Brass', ['Motto Plate']);

  // the motto as real text, sized from the measured layout so it fits the plate with a margin
  const extrude = 0.002;
  let t = await op('object.text_add', {
    body: MOTTO, size: 0.032, align_x: 'CENTER', align_y: 'CENTER', extrude, space_character: 1.2, space_line: 1.3,
    name: 'Motto', location: [0, plateFront, plate.z], rotation: [Math.PI / 2, 0, 0],
  });
  const maxWidth = plate.w - 0.06;
  if (t.width > maxWidth || t.height > plate.h - 0.03) {
    const size = 0.032 * Math.min(maxWidth / t.width, (plate.h - 0.03) / t.height);
    t = await op('font.text_set', { object: 'Motto', size });
    console.log(`    motto resized to ${size.toFixed(4)} m em → width ${t.width} m`);
  }
  // engrave: bake the text to a mesh and subtract it (2 mm deep) from the plate
  await op('object.convert', { target: 'MESH', keep_original: false }, { objects: ['Motto'] });
  await call('add_modifier', { object: 'Motto Plate', name: 'Engraving', type: 'BOOLEAN', params: { operation: 'DIFFERENCE', object: 'Motto' } });
  // black wax filling the engraving, 0.6 mm below the plate surface
  await call('duplicate_object', { object: 'Motto', name: 'Motto Fill', offset: [0, extrude + 0.0006, 0] });
  await op('data.set_property', { kind: 'objects', target: 'Motto', values: { hide_render: true, hide_viewport: true } });
  await op('data.set_property', { kind: 'objects', target: 'Motto Fill', values: { hide_render: false, hide_viewport: false } });
  await assign('Black Enamel', ['Motto Fill']);
  // four domed screws
  const screws = [];
  for (const [i, sx] of [-1, 1].entries()) {
    const name = `Plate Screw ${i + 1}`;
    await op('mesh.primitive_uv_sphere_add', { segments: 16, ring_count: 8, radius: 0.0055, name, location: [sx * (plate.w / 2 - 0.012), plateFront, plate.z], scale: [1, 0.45, 1] });
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
      teeth: x.T, radius: r4(x.tip), tooth_depth: DEPTH, thickness: GEAR_T, bore: x === g[0] ? 0.0125 : 0.006,
      name: x.name, location: [r4(x.x), r4(x.y), GEAR_Z], rotation: [0, 0, x.phase], materials: false,
    });
    console.log(`    ${x.name}: T=${x.T} tip r=${x.tip.toFixed(4)} at (${x.x.toFixed(4)}, ${x.y.toFixed(4)}) phase ${(x.phase / DEG).toFixed(2)}° ratio ${x.k.toFixed(4)} → ${res.vertices} verts`);
    // lightening windows ("spokes") cut with a boolean and applied
    if (x.spokes) {
      const cutters = [];
      const rIn = 0.0125 + 0.012;
      const rOut = x.rp - DEPTH / 2 - 0.012;
      const rc = (rIn + rOut) / 2;
      const hole = Math.min((rOut - rIn) / 2, rc * Math.sin(Math.PI / x.spokes) - 0.008);
      for (let s = 0; s < x.spokes; s++) {
        const a = x.phase + Math.PI / x.spokes + (s * TAU) / x.spokes;
        const name = `${x.name} Cutter ${s + 1}`;
        await op('mesh.primitive_cylinder_add', { vertices: 32, radius: hole, depth: GEAR_T * 3, name, location: [x.x + rc * Math.cos(a), x.y + rc * Math.sin(a), GEAR_Z] });
        cutters.push(name);
      }
      await op('object.join', {}, { objects: cutters, active: cutters[0] });
      await call('add_modifier', { object: x.name, name: 'Windows', type: 'BOOLEAN', params: { operation: 'DIFFERENCE', object: cutters[0] } });
      await call('apply_modifier', { object: x.name, modifier: 'Windows' });
      await call('delete_objects', { objects: [cutters[0]] });
    }
    await assign(x.material, [x.name]);
    await autoSmooth([x.name], 30 * DEG);
    // arbor: blued steel pin with a domed cap (the great wheel sits on the spindle instead)
    if (x !== g[0]) {
      await op('mesh.primitive_cylinder_add', { vertices: 24, radius: 0.0075, depth: GEAR_T + 0.016, name: `${x.name} Arbor`, location: [x.x, x.y, DECK_TOP + (GEAR_T + 0.016) / 2] });
      await op('mesh.primitive_uv_sphere_add', { segments: 24, ring_count: 12, radius: 0.0095, name: `${x.name} Cap`, location: [x.x, x.y, DECK_TOP + GEAR_T + 0.016], scale: [1, 1, 0.55] });
      await assign('Blued Steel', [`${x.name} Arbor`, `${x.name} Cap`]);
      await autoSmooth([`${x.name} Arbor`]);
      await op('object.shade_smooth', {}, { objects: [`${x.name} Cap`] });
    }
  }
  return g;
}

async function sunAndSpindle() {
  const len = SPINDLE.top - DECK_TOP;
  await op('mesh.primitive_cylinder_add', { vertices: 32, radius: SPINDLE.r, depth: len, name: 'Spindle', location: [0, 0, DECK_TOP + len / 2] });
  // hub where the spindle meets the great wheel, and a gilt cup holding the sun
  await op('mesh.primitive_cylinder_add', { vertices: 48, radius: 0.026, depth: 0.022, name: 'Hub', location: [0, 0, GEAR_Z + GEAR_T / 2 + 0.011] });
  await op('mesh.primitive_cone_add', { vertices: 48, radius1: 0.014, radius2: 0.04, depth: 0.05, name: 'Sun Cup', location: [0, 0, SUN.z - SUN.r * 0.62 - 0.012] });
  await op('mesh.primitive_uv_sphere_add', { segments: 64, ring_count: 32, radius: SUN.r, name: 'Sun', location: [0, 0, SUN.z] });
  await assign('Brass', ['Spindle', 'Hub']);
  await assign('Gilt', ['Sun Cup']);
  await assign('Sun', ['Sun']);
  await autoSmooth(['Spindle', 'Hub', 'Sun Cup']);
  await op('object.shade_smooth', {}, { objects: ['Sun'] });
}

async function planetArms() {
  const planetMaterials = { Ember: 'Copper', Azure: 'Azure Glaze', Verdant: 'Verdant', Titan: 'Banded Giant' };
  for (const [i, P] of PLANETS.entries()) {
    const pivot = `${P.key} Pivot`;
    const arm = `${P.key} Arm`;
    await call('add_object', { type: 'empty', name: pivot, location: [0, 0, P.h], params: { radius: 0.05 } });
    // arm = collar on the spindle + flat bar + upright post + cup, joined into one mesh
    const barLen = P.R + 0.004;
    await op('mesh.primitive_cube_add', { size: 1, name: arm, location: [barLen / 2, 0, P.h], scale: [barLen, 0.014, 0.006] });
    await op('object.transform_apply', { location: false, rotation: false, scale: true }, { objects: [arm] });
    const parts = [
      ['mesh.primitive_cylinder_add', { vertices: 40, radius: 0.019, depth: 0.016, name: `${arm} Collar`, location: [0, 0, P.h] }],
      ['mesh.primitive_cylinder_add', { vertices: 24, radius: 0.0034, depth: P.p - P.h - P.s * 0.6, name: `${arm} Post`, location: [P.R, 0, P.h + (P.p - P.h - P.s * 0.6) / 2] }],
      ['mesh.primitive_cylinder_add', { vertices: 32, radius: 0.0065, depth: 0.004, name: `${arm} Boss`, location: [P.R, 0, P.h + 0.0042] }],
      ['mesh.primitive_cone_add', { vertices: 32, radius1: 0.0034, radius2: P.s * 0.5, depth: P.s * 0.42, name: `${arm} Cup`, location: [P.R, 0, P.p - P.s * 0.72] }],
    ];
    await batch(`${P.key} arm parts`, parts);
    await op('object.join', {}, { objects: [arm, ...parts.map((p) => p[1].name)], active: arm });
    await assign('Polished Brass', [arm]);
    await autoSmooth([arm]);
    await op('mesh.primitive_uv_sphere_add', { segments: 48, ring_count: 24, radius: P.s, name: P.key, location: [P.R, 0, P.p] });
    await op('object.shade_smooth', {}, { objects: [P.key] });
    await assign(planetMaterials[P.key], [P.key]);
    const children = [arm, P.key];
    if (P.key === 'Titan') {
      // a flat gilt ring around the giant (on the arm, so it orbits but does not spin)
      await op('mesh.primitive_torus_add', { major_radius: P.s * 1.72, minor_radius: P.s * 0.36, major_segments: 72, minor_segments: 16, name: 'Titan Ring', location: [P.R, 0, P.p], rotation: [22 * DEG, 8 * DEG, 0], scale: [1, 1, 0.14] });
      await op('object.shade_smooth', {}, { objects: ['Titan Ring'] });
      await assign('Gilt', ['Titan Ring']);
      children.push('Titan Ring');
    }
    if (P.key === 'Verdant') {
      // the moon's orbit: a thin brass Bezier circle around the planet; the moon follows it
      await op('curve.primitive_bezier_circle_add', {
        radius: MOON.orbit, name: 'Moon Orbit', location: [P.R, 0, P.p], rotation: [MOON.tilt, 0, 0],
        bevel_depth: 0.0011, bevel_resolution: 3, resolution_u: 24,
      });
      await op('curve.switch_direction', { object: 'Moon Orbit' }, { objects: ['Moon Orbit'] }); // prograde (counter-clockwise)
      await op('object.material_assign', { material: 'Polished Brass', objects: ['Moon Orbit'], slot: 0 });
      children.push('Moon Orbit');
    }
    await call('set_parent', { objects: children, parent: pivot });
  }
  // the moon itself (unparented; Follow Path puts it on the orbit in world space)
  await op('mesh.primitive_uv_sphere_add', { segments: 32, ring_count: 16, radius: MOON.r, name: 'Moon', location: [0, 0, 0] });
  await op('object.shade_smooth', {}, { objects: ['Moon'] });
  await assign('Moon Silver', ['Moon']);
  const c = await op('object.constraint_add', { object: 'Moon', type: 'FOLLOW_PATH', target: 'Moon Orbit' });
  if (c.errors?.length) throw new Error(`Follow Path errors: ${short(c.errors)}`);
  const anim = await op('constraint.followpath_path_animate', { object: 'Moon', constraint: c.name, frame_start: 1, length: MOON.framesPerOrbit });
  console.log(`    moon path animation: ${short(anim)}`);
}

async function mechanism(gears) {
  // ONE master channel
  await call('add_object', { type: 'empty', name: 'Master Drive', location: [0, 0, 0.1], params: { radius: 0.1 } });
  const keys = await op('anim.keyframes_insert_many', {
    target: 'Master Drive', path: 'rotation_euler', index: 2, frames: [1, 49], values: [0, TAU], interpolation: 'LINEAR',
  });
  const ex = await op('anim.extrapolation_set', { objects: ['Master Drive'], type: 'CYCLIC', path: 'rotation_euler', index: 2 });
  console.log(`    master: ${short(keys)}; extrapolation ${short(ex)}`);
  const v = [{ name: 'm', target: 'Master Drive', path: 'rotation_euler', index: 2 }];
  const drivers = [];
  for (const P of PLANETS) {
    drivers.push(['anim.driver_add', { target: `${P.key} Pivot`, path: 'rotation_euler', index: 2, expression: `${r4(P.phase)} + ${P.n} * m`, variables: v }]);
    drivers.push(['anim.driver_add', { target: P.key, path: 'rotation_euler', index: 2, expression: `${P.spin} * m`, variables: v }]);
  }
  for (const x of gears) {
    // θ = φ + k·m with k = ±T_master/T (sign alternates along the train)
    const k = x.k === 1 ? '' : `${x.k < 0 ? '-' : '+'} ${r4(Math.abs(x.k))} * `;
    const expr = x.k === 1 ? `${r4(x.phase)} + m` : `${r4(x.phase)} ${k}m`;
    drivers.push(['anim.driver_add', { target: x.name, path: 'rotation_euler', index: 2, expression: expr, variables: v }]);
  }
  drivers.push(['anim.driver_add', { target: 'Hub', path: 'rotation_euler', index: 2, expression: 'm', variables: v }]);
  drivers.push(['anim.driver_add', { target: 'Sun', path: 'rotation_euler', index: 2, expression: '-m', variables: v }]);
  const res = await batch('drivers', drivers);
  const bad = res.flatMap((r) => r?.drivers ?? []).filter((d) => d.error);
  if (bad.length) throw new Error(`driver errors: ${short(bad)}`);
}

/**
 * Light and camera datablocks cannot be addressed by name in data.set_property and no tool returns
 * their ids, so read the id from a temporary driver (anim.driver_add returns target_id).
 */
async function dataBlockId(object, targetType, pathName, value) {
  const r = await op('anim.driver_add', { target_type: targetType, target: object, path: pathName, expression: String(value) });
  const id = r.drivers?.[0]?.target_id;
  await op('anim.driver_remove', { target_type: targetType, target: object, path: pathName });
  if (!id) throw new Error(`no ${targetType} datablock id for ${object}`);
  return id;
}

async function lightsAndCamera() {
  await call('add_object', { type: 'empty', name: 'Focus', location: FOCUS, params: { radius: 0.05 } });
  const lights = [
    // name, location, energy W, colour, size (m)
    ['Key Light', [-1.25, -1.35, 1.65], 260, [1, 0.8, 0.6], 0.9],
    ['Fill Light', [1.7, -0.75, 0.8], 70, [0.78, 0.86, 1], 1.4],
    ['Rim Light', [0.55, 1.65, 1.35], 240, [1, 0.72, 0.45], 0.7],
    ['Top Light', [0.0, 0.2, 2.2], 60, [1, 0.92, 0.82], 1.2],
  ];
  for (const [name, location, energy, color, size] of lights) {
    await call('add_object', { type: 'light', light_type: 'AREA', name, location, params: { energy, color } });
    const id = await dataBlockId(name, 'light', 'energy', energy);
    await op('data.set_property', { kind: 'lights', target: id, values: { size, shape: 'DISK' } });
  }
  await op('object.track_set', { type: 'TRACKTO', target: 'Focus', objects: lights.map((l) => l[0]) });
  // a low kicker that grazes the plinth front so the engraved plate reads
  await call('add_object', { type: 'light', light_type: 'AREA', name: 'Plate Kicker', location: [-0.35, -1.45, 0.3], params: { energy: 22, color: [1, 0.85, 0.7] } });
  await op('data.set_property', { kind: 'lights', target: await dataBlockId('Plate Kicker', 'light', 'energy', 22), values: { size: 0.45, shape: 'DISK' } });
  await op('object.track_set', { type: 'TRACKTO', target: 'Motto Plate', objects: ['Plate Kicker'] });
  await call('add_object', { type: 'camera', name: 'Camera', location: CAMERA.location, params: { lens: CAMERA.lens } });
  await op('object.track_set', { type: 'TRACKTO', target: 'Focus', objects: ['Camera'] });
  await call('set_active_camera', { camera: 'Camera' });
  const camId = await dataBlockId('Camera', 'camera', 'lens', CAMERA.lens);
  // focus on the middle of the planet ring (the Focus empty the camera tracks)
  const focusDist = Math.hypot(...CAMERA.location.map((c, i) => c - FOCUS[i]));
  await op('data.set_property', {
    kind: 'cameras', target: camId,
    values: { dof_use: true, dof_focus_distance: r4(focusDist), dof_aperture_fstop: CAMERA.fstop },
  });
  console.log(`    camera focus distance ${focusDist.toFixed(3)} m at f/${CAMERA.fstop}`);
}

async function verify() {
  const scene = await call('get_scene', { frame: 1 }, { quiet: true });
  const problems = scene.problems ?? [];
  console.log(`  scene: ${short(scene.counts, 300)}`);
  if (problems.length) {
    console.log(`  ⚠ problems: ${short(problems, 2000)}`);
    warnings.push(...problems.map((p) => `problem: ${short(p)}`));
  }
  // check the mechanism moves as designed: driven values at a few frames
  for (const f of [1, 13, 25]) {
    await op('scene.frame_set', { frame: f });
    const list = await op('anim.driver_list', {});
    const vals = Object.fromEntries((list.drivers ?? []).map((d) => [d.target_name, r4(d.value)]));
    console.log(`    frame ${f}: ${short(vals, 600)}`);
  }
  await op('scene.frame_set', { frame: 1 });
  return scene;
}

// ---------------------------------------------------------------------------------- renders

async function renderStill(file, opts) {
  const t0 = Date.now();
  const res = await call('render_image', { width: 1280, height: 720, frame: 1, ...opts });
  timings[path.basename(file)] = { ms: Date.now() - t0, info: res.text };
  await saveImage(res, file);
  console.log(`    → ${file} ${short(res.text, 300)}`);
  return res.text;
}

async function previews() {
  await mkdir(PREVIEW_DIR, { recursive: true });
  await renderStill(path.join(PREVIEW_DIR, 'pt-preview.png'), { width: 960, height: 540, engine: 'PATHTRACER', samples: 16, time_limit: 120 });
}

async function finalStill() {
  return renderStill(path.join(HERE, 'render.png'), { engine: 'PATHTRACER', samples: 128, denoise: true, time_limit: 295 });
}

async function animation() {
  // few samples, so every frame finishes its share of the budget (frames stopped at 1 spp are not denoised)
  const common = { frame_start: 1, frame_end: 48, width: 480, height: 270, engine: 'PATHTRACER', samples: 4, denoise: true, max_bounces: 4 };
  let t0 = Date.now();
  const sheet = await call('render_animation', { ...common, format: 'CONTACT_SHEET', frame_step: 4, width: 320, height: 180, columns: 4, samples: 8, time_limit: 150 });
  timings['contact_sheet.png'] = { ms: Date.now() - t0, info: sheet.text };
  await saveImage(sheet, path.join(HERE, 'contact_sheet.png'));
  console.log(`    → contact_sheet.png ${short(sheet.text, 300)}`);
  t0 = Date.now();
  const gif = await call('render_animation', { ...common, format: 'GIF', fps: 16, dither: 'BAYER', time_limit: 295 });
  timings['preview.gif'] = { ms: Date.now() - t0, info: gif.text };
  await saveImage(gif, path.join(HERE, 'preview.gif'));
  console.log(`    → preview.gif ${short(gif.text, 300)}`);
}

async function exportGlb() {
  // glTF cannot carry drivers or constraints: bake the driven rotations and the moon's path into
  // keyframes (one batch = one undo step), export, then undo the bake so the project keeps its
  // live drivers and Follow Path constraint.
  const t0 = Date.now();
  const list = await op('anim.driver_list', {});
  const driven = [...new Set((list.drivers ?? []).map((d) => d.target_name))];
  const baked = await batch('bake for export', [
    ['anim.bake_transforms', { objects: driven, frame_start: 1, frame_end: 49, step: 1, channels: ['rotation_euler'] }],
    ['anim.bake_transforms', { objects: ['Moon'], frame_start: 1, frame_end: 49, step: 1, channels: ['location'], clear_constraints: true }],
  ]);
  console.log(`    baked ${baked.flatMap((r) => r?.objects ?? []).length} objects`);
  let buf;
  try {
    const res = await call('export_scene', { format: 'glb' });
    const blob = res.resources?.find((r) => r.blob)?.blob;
    if (!blob) throw new Error(`export returned no file: ${short(res)}`);
    buf = Buffer.from(blob, 'base64');
  } finally {
    const u = await call('undo', {});
    const back = await op('anim.driver_list', {});
    console.log(`    undo bake: ${short(u)} → ${back.drivers?.length} drivers live again`);
    if ((back.drivers?.length ?? 0) < driven.length)
      warnings.push('undo after export did not restore every driver');
  }
  await writeFile(path.join(HERE, 'scene.glb'), buf);
  timings['scene.glb'] = { ms: Date.now() - t0, bytes: buf.length };
  console.log(`    → scene.glb ${(buf.length / 1e6).toFixed(2)} MB`);
}

// ---------------------------------------------------------------------------------- main

const T0 = Date.now();
try {
  console.log('● project');
  await resetProject();
  console.log('● scene settings & materials');
  await sceneSettings();
  await materials();
  console.log('● plinth');
  await plinth();
  await dial();
  await textPlate();
  console.log('● gear train');
  const gears = await gearTrain();
  console.log('● sun, spindle, planets');
  await sunAndSpindle();
  await planetArms();
  console.log('● mechanism (master channel + drivers)');
  await mechanism(gears);
  console.log('● lights & camera');
  await lightsAndCamera();
  console.log('● verify');
  await verify();
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
    await exportGlb();
  }
  console.log(`\nDone in ${((Date.now() - T0) / 1000).toFixed(1)} s. Project ${project}`);
  console.log('timings:', JSON.stringify(Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, { s: r4(v.ms / 1000), ...(v.bytes ? { bytes: v.bytes } : {}), ...(v.info ? { info: v.info } : {}) }])), null, 1));
  if (warnings.length) console.log(`warnings (${warnings.length}):\n  ${warnings.join('\n  ')}`);
} finally {
  await mcp.close();
}
