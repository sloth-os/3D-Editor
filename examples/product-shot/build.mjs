#!/usr/bin/env node
/**
 * "Vellune": an original perfume product shot, built from scratch through the 3D editor's MCP
 * server with the same tools an external AI agent uses.
 *
 *   MCP_URL=http://127.0.0.1:4505/mcp node examples/product-shot/build.mjs [mode] [options]
 *
 * Modes (default --final):
 *   --build-only    delete and rebuild the project, verify it, no renders
 *   --preview       rebuild + quick previews (RASTER 640x360, path traced 640x360 <= 60 s) into --out-dir
 *                   (default /tmp/product-shot-previews)
 *   --final         rebuild + render.png + turntable (contact_sheet.png, preview.gif) into this directory
 *   --still         rebuild + render.png only
 *   --anim          rebuild + contact_sheet.png and preview.gif only
 *   --export-only   rebuild + scene.glb only (no renders)
 * Options:
 *   --out-dir <dir>      where outputs go (default: this directory, or the preview directory)
 *   --samples <n>        samples per pixel of the final still (default 256)
 *   --min-samples <n>    fail instead of writing render.png if the time limit stops the still below
 *                        this many samples (default: half of --samples)
 *   --time-limit <s>     wall-clock budget of the final still in seconds (default 450)
 *   --anim-samples <n>   samples per pixel of the GIF frames (default 16; the contact sheet uses 2x)
 * Every output is checked before it is written, so a failed render never replaces a good file.
 * Environment: MCP_URL (default http://127.0.0.1:8080/mcp), MCP_TOKEN; MODE=<mode> is accepted as
 * an alias of the mode flag.
 *
 * Every object, material, light, the camera, the animation and the renders are made by MCP tool
 * calls; the script only computes numbers (profile points, label layout, camera placement), checks
 * the results and saves the files the server returns. Any tool error stops the build.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../../scripts/mcp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = 'product-shot';

// ------------------------------------------------------------------ command line

const MODES = ['build-only', 'preview', 'final', 'still', 'anim', 'export-only'];
const ALIASES = { build: 'build-only', export: 'export-only', full: 'final' };

function parseArgs(argv) {
  const opts = { mode: null, outDir: null, samples: 256, minSamples: null, timeLimit: 450, animSamples: 16 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // A value flag must be followed by its value: `--out-dir` with the path forgotten must not
    // silently fall back to this directory (and overwrite the committed outputs).
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      i++;
      return v;
    };
    const num = () => {
      const v = value();
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${a} needs a positive number, got ${v}`);
      return n;
    };
    const mode = a.replace(/^--/, '');
    if (MODES.includes(mode)) {
      if (opts.mode && opts.mode !== mode) throw new Error(`choose one mode, got --${opts.mode} and ${a}`);
      opts.mode = mode;
    } else if (a === '--out-dir') opts.outDir = path.resolve(value());
    else if (a === '--samples') opts.samples = num();
    else if (a === '--min-samples') opts.minSamples = num();
    else if (a === '--time-limit') opts.timeLimit = num();
    else if (a === '--anim-samples') opts.animSamples = num();
    else throw new Error(`unknown argument ${a} (modes: ${MODES.map((m) => `--${m}`).join(' ')})`);
  }
  if (!opts.mode && process.env.MODE) {
    const m = ALIASES[process.env.MODE] ?? process.env.MODE;
    if (!MODES.includes(m)) throw new Error(`unknown MODE=${process.env.MODE}`);
    opts.mode = m;
  }
  opts.mode ??= 'final';
  opts.outDir ??= opts.mode === 'preview' ? '/tmp/product-shot-previews' : HERE;
  // The still is refused (render.png is left untouched) when the time limit stops it below this.
  opts.minSamples ??= Math.ceil(opts.samples / 2);
  if (opts.minSamples > opts.samples) throw new Error('--min-samples is larger than --samples');
  return opts;
}

const OPTS = parseArgs(process.argv.slice(2));

const PI = Math.PI;
const r6 = (v) => Math.round(v * 1e6) / 1e6;

// ------------------------------------------------------------------ design constants (metres, Z up)

/** Octagonal flacon: the profile lies in the vertical plane at 22.5° so a flat facet faces -Y. */
const TH0 = PI / 8;
const BOTTLE = {
  R: 0.038, // circumradius of the octagon (before the X stretch)
  f: 0.004, // outer bottom fillet
  Hs: 0.072, // top of the straight side wall
  rn: 0.0105, // neck radius
  Hsh: 0.016, // shoulder height
  Hn: 0.096, // top of the neck (hidden under the cap)
  t: 0.0032, // glass wall thickness
  base: 0.014, // thick glass base
  fi: 0.005, // inner bottom fillet
  scaleX: 1.2, // elongated octagon: a wider front facet for the label
  steps: 8, // SCREW steps = number of facets
};
const LIQUID = { gap: 0.0004, level: 0.062 };
const PEDESTAL = { radius: 0.085, height: 0.05, fillet: 0.004 };
/**
 * The bottle stands on the plinth with a 0.2 mm air gap (about half a pixel in render.png). If the
 * glass bottom and the marble top shared a plane, rays refracted through the thick glass base could
 * leave the glass in that plane and miss the plinth top, leaving a grainy grey band in the base.
 */
const BOTTLE_LIFT = 0.0002;
const Z_BOTTLE = PEDESTAL.height + BOTTLE_LIFT;
const APOTHEM = BOTTLE.R * Math.cos(PI / BOTTLE.steps); // distance of the front facet from the axis
const FACE_Y = -APOTHEM; // front facet plane (the bottle is not rotated, only stretched along X)
const LABEL = {
  w: 0.03, // plate width and height
  h: 0.027,
  cz: 0.04, // centre height above the bottle base
  corner: 0.0022,
  thick: 0.0002,
  frameInset: 0.0015, // the gold frame line runs 1.5 mm inside the plate edge ...
  frameBevel: 0.00011, // ... as a 0.22 mm round tube
  nameSize: 0.0046,
  minNameMargin: 0.0025, // clear space between the name and the frame on each side
  // vertical layout (offsets from the label centre): emblem, name baseline, rule, subline baseline
  emblemZ: 0.0064,
  nameZ: -0.0028,
  ruleZ: -0.0056,
  sublineZ: -0.009,
};
const LABEL_CENTER = [0, FACE_Y - 2 * LABEL.thick, Z_BOTTLE + LABEL.cz];

/** Still camera; the turntable orbits this camera around TARGET, so frame 1 is the still. */
const CAMERA = {
  azimuth: -PI / 2 - 0.14,
  distance: 1.05,
  elevation: 0.15,
  target: [0, 0, 0.095],
  lens: 85,
  fstop: 4,
};
const camPos = () => {
  const { azimuth: a, distance: d, elevation: e, target: t } = CAMERA;
  return [
    r6(t[0] + d * Math.cos(e) * Math.cos(a)),
    r6(t[1] + d * Math.cos(e) * Math.sin(a)),
    r6(t[2] + d * Math.sin(e)),
  ];
};
const LOOP = { frame_start: 1, frame_end: 36, fps: 24 };
const BACKDROP_COLOR = [0.08, 0.022, 0.028]; // deep wine red: gold and amber glow against it
/**
 * Objects that turn with the turntable camera: on screen the bottle and its pedestal spin in a
 * fixed studio. The focus point stays in front of the bottle at label depth.
 */
const STUDIO_RIG = [
  'Cyclorama',
  'Key Softbox',
  'Fill Strip',
  'Rim Strip',
  'Backdrop Glow',
  'Reflector Card',
  'Column',
  'Gold Sphere',
  'Pearl',
  'Pearl Small',
  'Pearl Tiny',
  'Focus Point',
];

// ------------------------------------------------------------------ MCP helpers

const t0 = Date.now();
const timings = [];
const warnings = [];
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s]`, ...a);

const mcp = await connect();

/** Calls an MCP tool on the project; a tool error stops the build with the tool name and arguments. */
async function call(tool, args = {}) {
  try {
    return await mcp.call(tool, { project: PROJECT, ...args });
  } catch (e) {
    throw new Error(`${tool} failed: ${e.message}\n  args: ${JSON.stringify(args).slice(0, 600)}`, {
      cause: e,
    });
  }
}

function noteReports(operator, reports = []) {
  for (const rep of reports)
    if (rep.level !== 'INFO') {
      warnings.push(`${operator}: ${rep.level} ${rep.message}`);
      log(`  ${operator}: ${rep.level} ${rep.message}`);
    }
}

/** Runs one operator; logs its warnings and returns the operator result. */
async function op(operator, params = {}, selection) {
  const r = await call('run_operator', { operator, params, ...(selection ? { selection } : {}) });
  noteReports(operator, r.reports);
  if (!r.ok) throw new Error(`${operator} reported failure: ${JSON.stringify(r.reports)}`);
  return r.result;
}

/** Runs operators as one undo step; returns their results in order. */
async function batch(operations) {
  const r = await call('batch', { operations });
  if (!r.ok || r.failed) throw new Error(`batch failed: ${JSON.stringify(r).slice(0, 1500)}`);
  for (const x of r.results) noteReports(x.operator, x.reports);
  return r.results.map((x) => x.result);
}

async function step(name, fn) {
  const s = Date.now();
  log(`-> ${name}`);
  const res = await fn();
  const ms = Date.now() - s;
  timings.push({ step: name, seconds: Math.round(ms / 100) / 10 });
  log(`   done: ${name} (${(ms / 1000).toFixed(1)} s)`);
  return res;
}

function check(cond, message) {
  if (!cond) throw new Error(`verification failed: ${message}`);
}

// ------------------------------------------------------------------ geometry helpers

/** Points of an elliptical arc (start point excluded) in the (r, z) profile plane. */
function arc(cr, cz, rr, rz, a0, a1, n) {
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cr + rr * Math.cos(a), cz + rz * Math.sin(a)]);
  }
  return pts;
}

/** (r, z) profile -> 3D points in the vertical plane at angle `th` around Z. */
const toPlane = (rz, th = 0) => rz.map(([r, z]) => [r6(r * Math.cos(th)), r6(r * Math.sin(th)), r6(z)]);

/** Rounded rectangle outline (centred, in the local XY plane). */
function roundedRect(w, h, rad, n = 5) {
  const pts = [];
  const cx = w / 2 - rad;
  const cy = h / 2 - rad;
  const corners = [
    [cx, cy, 0],
    [-cx, cy, PI / 2],
    [-cx, -cy, PI],
    [cx, -cy, (3 * PI) / 2],
  ];
  for (const [x, y, a0] of corners)
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((PI / 2) * i) / n;
      pts.push([r6(x + rad * Math.cos(a)), r6(y + rad * Math.sin(a)), 0]);
    }
  return pts;
}

/** Crescent moon outline (tips at (0, ±h), opening towards +X), rotated by `tilt`. */
function crescent(h, d, tilt, n = 16) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = PI / 2 + (PI * i) / n; // outer half circle, top tip -> left -> bottom tip
    pts.push([h * Math.cos(a), h * Math.sin(a)]);
  }
  const r2 = Math.hypot(d, h);
  const aS = Math.atan2(-h, -d) + 2 * PI;
  const aE = Math.atan2(h, -d);
  for (let i = 1; i < n; i++) {
    const a = aS + ((aE - aS) * i) / n; // inner arc, bottom tip -> top tip
    pts.push([d + r2 * Math.cos(a), r2 * Math.sin(a)]);
  }
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  return pts.map(([x, y]) => [r6(x * c - y * s), r6(x * s + y * c), 0]);
}

// ------------------------------------------------------------------ lathe profiles (r, z)

/** Glass wall and base: outer wall, domed shoulder, neck lip, inner cavity, thick base. */
function bottleProfile() {
  const { R, f, Hs, rn, Hsh, Hn, t, base, fi } = BOTTLE;
  const rni = rn - t;
  return [
    [0, 0],
    [R - f, 0],
    ...arc(R - f, f, f, f, -PI / 2, 0, 6), // outer bottom fillet -> (R, f)
    [R, Hs],
    ...arc(rn, Hs, R - rn, Hsh, 0, PI / 2, 14), // domed shoulder -> (rn, Hs + Hsh)
    [rn, Hn],
    [rni, Hn], // lip (hidden under the cap)
    [rni, Hs + Hsh - t],
    ...arc(rni, Hs, R - rn, Hsh - t, PI / 2, 0, 14), // inner shoulder -> (R - t, Hs)
    [R - t, base + fi],
    ...arc(R - t - fi, base + fi, fi, fi, 0, -PI / 2, 6), // inner bottom fillet
    [0, base],
  ];
}

/** The perfume follows the cavity with a thin air gap (the path tracer has no nested dielectrics). */
function liquidProfile() {
  const { R, t, base, fi } = BOTTLE;
  const g = LIQUID.gap;
  return [
    [0, base + g],
    [R - t - fi, base + g],
    ...arc(R - t - fi, base + fi, fi - g, fi - g, -PI / 2, 0, 6),
    [R - t - g, LIQUID.level],
    [0, LIQUID.level],
  ];
}

/** Stepped cap: a collar over the neck, the tall octagonal body and a softly rounded top. */
function capProfile() {
  return [
    [0, 0],
    [0.0128, 0],
    [0.0128, 0.0048],
    [0.0168, 0.0052],
    [0.0176, 0.006],
    [0.0176, 0.0368],
    [0.017, 0.0384],
    [0.0154, 0.0396],
    [0.012, 0.0402],
    [0, 0.0402],
  ];
}

/**
 * A disc or column with rounded rims (fillet radius f) and a flat top, as a lathe profile. A BEVEL
 * modifier on a cylinder gives the same shape, but it stretches the cylinder's UVs across the seam
 * between cap and side, which spoils the marble baked into scene.glb (see README).
 */
function roundedDisc(radius, height, f, { bottomFillet = true, n = 6 } = {}) {
  const bottom = bottomFillet ? [[radius - f, 0], ...arc(radius - f, f, f, f, -PI / 2, 0, n)] : [[radius, 0]];
  return [
    [0, 0],
    ...bottom,
    [radius, height - f],
    ...arc(radius - f, height - f, f, f, 0, PI / 2, n),
    [0, height],
  ];
}

/**
 * Expected evaluated vertex count of every lathe, for verifyScene(): a full SCREW turn makes `steps`
 * rings of the profile, and the profile points on the axis merge into one vertex each.
 */
const LATHES = new Map();

/**
 * Lathe: a POLY profile curve (wire, no bevel) with a SCREW modifier around its local Z axis, and
 * optionally SMOOTH_BY_ANGLE to keep facet edges sharp. `steps` is used for viewport AND renders.
 */
async function revolve(name, profile, { steps, location, scale, th = 0, smoothAngle = null }) {
  const onAxis = profile.filter(([r]) => r === 0).length;
  LATHES.set(name, steps * (profile.length - onAxis) + onAxis);
  await op('curve.add_from_points', {
    name,
    points: toPlane(profile, th),
    type: 'POLY',
    dimensions: '3D',
    location,
    ...(scale ? { scale } : {}),
  });
  await call('add_modifier', {
    object: name,
    type: 'SCREW',
    name: 'Lathe',
    params: {
      axis: 'Z',
      angle: 2 * PI,
      steps,
      render_steps: steps,
      use_merge_vertices: true,
      merge_threshold: 1e-5,
    },
  });
  if (smoothAngle != null)
    await call('add_modifier', {
      object: name,
      type: 'SMOOTH_BY_ANGLE',
      name: 'Facets',
      params: { angle: smoothAngle },
    });
}

// ------------------------------------------------------------------ build stages

async function freshProject() {
  const projects = await mcp.call('list_projects', {});
  const list = Array.isArray(projects) ? projects : (projects.projects ?? []);
  for (const p of list)
    if (p.name === PROJECT) {
      log(`   deleting existing project ${p.id}`);
      await mcp.call('delete_project', { project: p.id, confirm: true });
    }
  const created = await mcp.call('create_project', { name: PROJECT, empty: true });
  log(`   project ${created.id} -> ${created.editor_url}`);
  return created;
}

async function sceneSettings() {
  await call('set_scene_settings', {
    ...LOOP,
    resolution_x: 1280,
    resolution_y: 720,
    engine: 'PATHTRACER',
    samples: 256,
    max_bounces: 10, // glass walls + perfume = 6 refractions before the backdrop is reached
    use_denoising: true,
    view_transform: 'NEUTRAL', // Khronos PBR Neutral: faithful product colours
    exposure: 0,
    environment: 'STUDIO',
    environment_strength: 0.2, // a subtle studio environment for reflections in glass and gold
    world_color: [0.05, 0.045, 0.04],
    world_strength: 1,
  });
}

async function buildStudio() {
  // Cyclorama: an open 2D profile (floor -> 26 cm cove -> wall) extruded sideways into a seamless sweep.
  const R = 0.26;
  const back = 0.62;
  const prof = [
    [-0.75, 0, 0],
    [back - R, 0, 0],
  ];
  for (let i = 1; i < 14; i++) {
    const a = -PI / 2 + (i / 14) * (PI / 2);
    prof.push([r6(back - R + R * Math.cos(a)), r6(R + R * Math.sin(a)), 0]);
  }
  prof.push([back, R, 0], [back, 1.0, 0]);
  await op('curve.add_from_points', {
    name: 'Cyclorama',
    points: prof,
    type: 'POLY',
    dimensions: '2D',
    extrude: 0.8, // half width: a 1.6 m wide sweep
    // local X -> world +Y (depth), local Y -> world +Z (height), local Z -> world X (width)
    rotation: [PI / 2, 0, PI / 2],
    location: [0, 0, 0],
  });
  await call('set_material', {
    object: 'Cyclorama',
    name: 'Backdrop Paper',
    base_color: BACKDROP_COLOR,
    roughness: 0.92,
  });

  // Marble pedestal: a revolved profile with 4 mm round rims, procedural marble.
  const { radius, height, fillet } = PEDESTAL;
  await revolve('Pedestal', roundedDisc(radius, height, fillet), { steps: 128, location: [0, 0, 0] });
  await op('material.preset_apply', { preset: 'marble', objects: ['Pedestal'], name: 'Carrara Marble' });
  await op('material.procedural_set', {
    material: 'Carrara Marble',
    channel: 'base_color',
    procedural: { scale: 9, color_a: [0.4, 0.4, 0.41], color_b: [0.8, 0.79, 0.76], distortion: 2.6 },
  });
  // Polished stone: a full clear coat mirrors the bottle softly in the plinth top.
  await op('material.update', { material: 'Carrara Marble', coat_weight: 1, coat_roughness: 0.06 });
}

async function buildBottle() {
  const loc = [0, 0, Z_BOTTLE];
  const lathe = { steps: BOTTLE.steps, th: TH0, scale: [BOTTLE.scaleX, 1, 1], smoothAngle: 0.6 };
  await revolve('Bottle', bottleProfile(), { ...lathe, location: loc });
  await call('set_material', {
    object: 'Bottle',
    name: 'Bottle Glass',
    base_color: [0.965, 0.985, 1.0], // a faint cool tint
    transmission: 1,
    roughness: 0.0,
    ior: 1.5,
    metallic: 0,
  });
  await revolve('Perfume', liquidProfile(), { ...lathe, location: loc });
  await call('set_material', {
    object: 'Perfume',
    name: 'Perfume',
    base_color: [1.0, 0.84, 0.55], // amber
    transmission: 1,
    roughness: 0.0,
    ior: 1.36,
  });
  const capZ = Z_BOTTLE + BOTTLE.Hs + BOTTLE.Hsh + 0.0003;
  await revolve('Cap', capProfile(), { ...lathe, location: [0, 0, capZ] });
  await op('material.preset_apply', { preset: 'gold', objects: ['Cap'], name: 'Polished Gold' });
  await op('material.update', { material: 'Polished Gold', roughness: 0.14 });
}

/** The front label: six curve/text objects + materials + parenting, as ONE batch (one undo step). */
async function buildLabel() {
  const { w, h, cz, corner, thick } = LABEL;
  const zc = Z_BOTTLE + cz;
  const yPlate = FACE_Y - 0.00006 - thick; // back face 0.06 mm in front of the glass
  const yFront = yPlate - thick; // front face of the plate
  const rot = [PI / 2, 0, 0]; // local +Z (front) -> world -Y, local +Y -> world +Z
  const ink = 0.00012; // half thickness of the gold relief
  const yInk = yFront - 0.00003 - ink;
  const flat = { type: 'POLY', cyclic: true, dimensions: '2D', fill_mode: 'BOTH', rotation: rot };
  const gold = ['Label Frame', 'Emblem', 'Label Name', 'Label Rule', 'Label Subline'];
  const res = await batch([
    // black enamel plate: a filled, extruded rounded rectangle
    {
      operator: 'curve.add_from_points',
      params: {
        ...flat,
        name: 'Label',
        points: roundedRect(w, h, corner),
        extrude: thick,
        location: [0, yPlate, zc],
      },
    },
    // thin gold frame: a closed 3D outline with a round bevel
    {
      operator: 'curve.add_from_points',
      params: {
        name: 'Label Frame',
        points: roundedRect(w - 2 * LABEL.frameInset, h - 2 * LABEL.frameInset, corner * 0.6),
        type: 'POLY',
        cyclic: true,
        dimensions: '3D',
        bevel_depth: LABEL.frameBevel,
        bevel_resolution: 1,
        location: [0, yFront - 0.00012, zc],
        rotation: rot,
      },
    },
    // crescent emblem ("lune")
    {
      operator: 'curve.add_from_points',
      params: {
        ...flat,
        name: 'Emblem',
        points: crescent(0.0026, 0.0016, -0.35),
        extrude: ink,
        location: [0, yInk, zc + LABEL.emblemZ],
      },
    },
    // the name, about as wide as the subline, with 2.8 mm of air to the frame on each side
    {
      operator: 'object.text_add',
      params: {
        body: 'VELLUNE',
        name: 'Label Name',
        size: LABEL.nameSize,
        extrude: ink,
        align_x: 'CENTER',
        space_character: 1.15,
        location: [0, yInk, zc + LABEL.nameZ],
        rotation: rot,
      },
    },
    {
      operator: 'curve.add_from_points',
      params: {
        ...flat,
        name: 'Label Rule',
        points: roundedRect(0.011, 0.00028, 0.00013, 2),
        extrude: ink,
        location: [0, yInk, zc + LABEL.ruleZ],
      },
    },
    {
      operator: 'object.text_add',
      params: {
        body: 'EAU DE PARFUM',
        name: 'Label Subline',
        size: 0.0019,
        extrude: ink * 0.7,
        align_x: 'CENTER',
        space_character: 1.6,
        location: [0, yInk, zc + LABEL.sublineZ],
        rotation: rot,
      },
    },
    {
      operator: 'material.new',
      params: {
        name: 'Black Enamel',
        assign: false,
        base_color: [0.012, 0.012, 0.014, 1],
        roughness: 0.32,
        coat_weight: 1,
        coat_roughness: 0.04,
      },
    },
    { operator: 'object.material_assign', params: { material: 'Black Enamel', objects: ['Label'] } },
    { operator: 'material.preset_apply', params: { preset: 'gold', objects: gold, name: 'Gold Leaf' } },
    { operator: 'material.update', params: { material: 'Gold Leaf', roughness: 0.28 } },
    { operator: 'object.parent_to', params: { objects: ['Label', ...gold], parent: 'Bottle' } },
  ]);
  // object.text_add returns the layout width (glyph cells); verifyScene() measures the geometry.
  log(
    `   text layout widths: name ${(res[3].width * 1000).toFixed(1)} mm, subline ${(res[5].width * 1000).toFixed(1)} mm (label ${w * 1000} mm)`,
  );
}

/** Light with its shape and size given directly to object.light_add (via add_object), then aimed. */
async function light(name, type, { location, aimAt, ...settings }) {
  await call('add_object', { type: 'light', light_type: type, name, params: settings, location });
  await op('object.look_at', { objects: [name], point: aimAt });
}

/**
 * Three-point studio lighting with area lights (power in W), a background light, a reflector card
 * and the dim STUDIO environment. Area lights are invisible to the camera but show up in
 * reflections, so the strips and the card are placed where the octagonal facets mirror them.
 */
async function buildLights() {
  // Key: a large warm softbox high front-left: soft light on the label, cap and pedestal.
  await light('Key Softbox', 'AREA', {
    location: [-0.5, -0.36, 0.46],
    aimAt: [0, 0, 0.1],
    energy: 12,
    color: [1.0, 0.95, 0.88],
    shape: 'RECTANGLE',
    size: 0.75,
    size_y: 0.85,
  });
  // Fill: a cool vertical strip on the right, mirrored by the front-right facet as a bright stripe.
  await light('Fill Strip', 'AREA', {
    location: [0.45, -0.02, 0.13],
    aimAt: [0, -0.02, 0.12],
    energy: 2.5,
    color: [0.88, 0.93, 1.0],
    shape: 'RECTANGLE',
    size: 0.12,
    size_y: 0.6,
  });
  // Rim: a narrow strip behind on the left that outlines the glass, cap and pedestal edges.
  await light('Rim Strip', 'AREA', {
    location: [-0.3, 0.3, 0.2],
    aimAt: [0, 0, 0.11],
    energy: 8,
    color: [1.0, 0.97, 0.93],
    shape: 'RECTANGLE',
    size: 0.1,
    size_y: 0.5,
  });
  // Background light: a soft warm spot pooled on the cove right behind the bottle. The camera sees
  // this glow through the perfume, which makes the liquid shine amber (a "rising moon" halo).
  await light('Backdrop Glow', 'SPOT', {
    location: [0, 0.12, 0.38],
    aimAt: [0.07, 0.46, 0],
    energy: 70,
    color: [1.0, 0.85, 0.7],
    spot_size: 0.7,
    spot_blend: 0.9,
    shadow_soft_size: 0.05,
  });
  // Reflector card: a weak, wide strip behind the camera, low and to its right, where the cap's
  // polished front facet looks. It adds almost no light to the scene, but that facet mirrors it as a
  // soft gold gradient instead of the dark space around the camera (it would read as a black hole).
  await light('Reflector Card', 'AREA', {
    location: [0.17, -1.25, 0.2],
    aimAt: [0, 0, 0.16],
    energy: 0.5,
    color: [1.0, 0.97, 0.92],
    shape: 'RECTANGLE',
    size: 0.9,
    size_y: 0.3,
  });
}

/** Props (one batch): a marble column with a gold sphere behind, three pearls in front. */
async function buildProps() {
  // The column is revolved like the pedestal (rounded top rim).
  await revolve('Column', roundedDisc(0.045, 0.1, 0.0025, { bottomFillet: false }), {
    steps: 96,
    location: [0.24, 0.33, 0],
  });
  const pearls = [
    ['Pearl', 0.012, [-0.135, -0.02]],
    ['Pearl Small', 0.008, [-0.108, -0.046]],
    ['Pearl Tiny', 0.0055, [-0.157, -0.052]],
  ];
  const names = pearls.map((p) => p[0]);
  await batch([
    { operator: 'object.material_assign', params: { material: 'Carrara Marble', objects: ['Column'] } },
    {
      operator: 'mesh.primitive_uv_sphere_add',
      params: {
        name: 'Gold Sphere',
        segments: 64,
        ring_count: 32,
        radius: 0.018,
        location: [0.24, 0.33, 0.118],
      },
    },
    ...pearls.map(([name, radius, [x, y]]) => ({
      operator: 'mesh.primitive_uv_sphere_add',
      params: { name, segments: 48, ring_count: 24, radius, location: [x, y, radius] },
    })),
    { operator: 'object.select', params: { objects: ['Gold Sphere', ...names] } },
    { operator: 'object.shade_smooth', params: {} },
    { operator: 'object.material_assign', params: { material: 'Polished Gold', objects: ['Gold Sphere'] } },
    {
      operator: 'material.preset_apply',
      params: { preset: 'porcelain', objects: names, name: 'Pearl White' },
    },
    {
      operator: 'material.update',
      params: {
        material: 'Pearl White',
        base_color: [0.9, 0.86, 0.8, 1],
        roughness: 0.22,
        coat_weight: 1,
        coat_roughness: 0.03,
        sheen_weight: 0.4,
      },
    },
  ]);
}

/**
 * Camera with depth of field: 85 mm at f/4, focused on the "Focus Point" empty at the centre of
 * the label (camera.properties_set dof_focus_object). The empty turns with the turntable camera,
 * so the focus stays on the front of the bottle during the spin.
 */
async function buildCamera() {
  const pos = camPos();
  await call('add_object', {
    type: 'empty',
    name: 'Focus Point',
    params: { type: 'SPHERE', radius: 0.004 },
    location: LABEL_CENTER,
  });
  await call('add_object', { type: 'camera', name: 'Camera', params: { lens: CAMERA.lens }, location: pos });
  await op('object.look_at', { objects: ['Camera'], point: CAMERA.target });
  await call('set_active_camera', { camera: 'Camera' });
  const r = await op('camera.properties_set', {
    object: 'Camera',
    dof_use: true,
    dof_focus_object: 'Focus Point',
    dof_aperture_fstop: CAMERA.fstop,
    clip_start: 0.05,
    clip_end: 20,
  });
  // The result reports the evaluated focus distance: the depth of the Focus Point (label centre).
  const cam = r.cameras[0];
  log(
    `   camera at ${JSON.stringify(pos)}: ${cam.lens} mm, f/${cam.dof_aperture_fstop}, focus ${cam.dof_focus_distance} m on ${cam.dof_focus_object}`,
  );
  check(
    Math.abs(cam.dof_focus_distance - dist(pos, LABEL_CENTER)) < 2e-3,
    `focus distance ${cam.dof_focus_distance} m, expected the label depth ${dist(pos, LABEL_CENTER)} m`,
  );
}

/**
 * Turntable: anim.turntable orbits the still camera around the bottle (same radius, height and start
 * angle, so frame 1 is the still). The backdrop, lights, props and the focus point are parented to
 * the pivot, so they turn with the camera: on screen the bottle and its pedestal spin in a fixed studio.
 */
async function buildTurntable() {
  const { distance: d, elevation: e, azimuth: a, target } = CAMERA;
  const tt = await op('anim.turntable', {
    camera: 'Camera',
    center: target,
    radius: r6(d * Math.cos(e)),
    height: r6(d * Math.sin(e)),
    start_angle: a,
    frame_start: LOOP.frame_start,
    frame_end: LOOP.frame_end,
    set_frame_range: true,
  });
  log(
    `   turntable: pivot ${tt.pivot_name}, radius ${tt.radius}, height ${tt.height}, ${tt.loop_frames} frames`,
  );
  await op('object.parent_to', { objects: STUDIO_RIG, parent: tt.pivot_name });
  return tt;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Checks the built scene: no evaluation problems, every lathe produced the expected geometry, the
 * bottle stands just above the plinth, the label sits on the front facet with room around the name,
 * the camera orbits seamlessly (get_object at several frames) and the depth of field stays focused
 * at label depth.
 */
async function verifyScene() {
  const s = await call('get_scene', {});
  log(`   scene: ${JSON.stringify(s.counts)}`);
  check(!s.problems?.length, `scene problems ${JSON.stringify(s.problems)}`);

  // Lathe results (SCREW on wire curves): exactly `steps` rings of each profile.
  const objs = {};
  for (const [name, vertices] of LATHES) {
    objs[name] = await call('get_object', { object: name });
    const ev = objs[name].data.evaluated;
    check(
      ev?.vertices === vertices && ev.faces > 0,
      `${name} lathe: ${JSON.stringify(ev)}, expected ${vertices} vertices`,
    );
  }
  log(`   lathes: ${[...LATHES.keys()].map((k) => `${k} ${objs[k].data.evaluated.vertices} v`).join(', ')}`);
  const { Bottle: bottle, Pedestal: ped } = objs;
  const bs = bottle.world_bounds.size;
  log(`   bottle size ${bs.map((v) => (v * 100).toFixed(1)).join(' x ')} cm`);
  check(Math.abs(bs[2] - BOTTLE.Hn) < 1e-3 && bs[0] > bs[1], `bottle bounds ${JSON.stringify(bs)}`);
  const pedTop = ped.world_bounds.max[2];
  check(Math.abs(pedTop - PEDESTAL.height) < 1e-6, `pedestal top ${pedTop} != ${PEDESTAL.height}`);
  const lift = bottle.world_bounds.min[2] - pedTop;
  check(
    Math.abs(lift - BOTTLE_LIFT) < 1e-6,
    `bottle base ${lift * 1000} mm above the plinth, expected 0.2 mm`,
  );
  const label = await call('get_object', { object: 'Label' });
  const gap = FACE_Y - label.world_bounds.max[1];
  check(gap > 0 && gap < 2e-4, `label not on the front facet (gap ${gap})`);
  // The name keeps clear space to the frame on both sides (inner edge of the frame tube).
  const name = await call('get_object', { object: 'Label Name' });
  const inner = LABEL.w / 2 - LABEL.frameInset - LABEL.frameBevel;
  const margin = inner - Math.max(-name.world_bounds.min[0], name.world_bounds.max[0]);
  log(
    `   label name ${(name.world_bounds.size[0] * 1000).toFixed(1)} mm wide, ${(margin * 1000).toFixed(2)} mm from the frame`,
  );
  check(margin >= LABEL.minNameMargin, `the label name is ${margin * 1000} mm from the frame`);

  // Turntable: camera radius/height constant, quarter turn every 9 frames, frame 37 == frame 1.
  const loopLen = LOOP.frame_end - LOOP.frame_start + 1;
  const rows = [];
  for (const f of [1, 10, 19, 28, 37]) {
    const cam = await call('get_object', { object: 'Camera', frame: f });
    const fp = await call('get_object', { object: 'Focus Point', frame: f });
    const card = await call('get_object', { object: 'Reflector Card', frame: f });
    const p = cam.world_location;
    const az = Math.atan2(p[1] - CAMERA.target[1], p[0] - CAMERA.target[0]);
    const expected = CAMERA.azimuth + (2 * PI * (f - LOOP.frame_start)) / loopLen;
    const dAz = Math.atan2(Math.sin(az - expected), Math.cos(az - expected));
    const radius = Math.hypot(p[0] - CAMERA.target[0], p[1] - CAMERA.target[1]);
    rows.push({
      f,
      cam: p,
      az: +az.toFixed(4),
      dAz: +dAz.toFixed(5),
      focus: cam.data.dof_focus_distance,
      toFocus: +dist(p, fp.world_location).toFixed(4),
      toCard: +dist(p, card.world_location).toFixed(4),
    });
    check(Math.abs(dAz) < 1e-3, `camera azimuth at frame ${f}: ${az} vs ${expected}`);
    check(
      Math.abs(radius - CAMERA.distance * Math.cos(CAMERA.elevation)) < 1e-3,
      `camera radius at frame ${f}: ${radius}`,
    );
    check(cam.data.dof_use === true, 'depth of field is off');
  }
  log(`   turntable check: ${JSON.stringify(rows)}`);
  const focus = rows.map((r) => r.focus);
  check(Math.max(...focus) - Math.min(...focus) < 1e-3, `focus distance changes during the loop: ${focus}`);
  // The reflector card travels with the camera (same distance at every frame).
  const toCard = rows.map((r) => r.toCard);
  check(
    Math.max(...toCard) - Math.min(...toCard) < 1e-3,
    `the reflector card does not follow the camera: ${toCard}`,
  );
  check(dist(rows[0].cam, rows[4].cam) < 1e-6, 'the loop is not seamless (frame 37 != frame 1)');
  // The bottle itself never moves.
  const b19 = await call('get_object', { object: 'Bottle', frame: 19 });
  check(dist(b19.world_location, [0, 0, Z_BOTTLE]) < 1e-9, 'the bottle moves');
  return s;
}

// ------------------------------------------------------------------ outputs

/** Writes the first image / embedded resource of a tool result (or downloads its link). */
async function saveFile(result, file) {
  let buf = null;
  const img = result.images?.[0];
  const res = result.resources?.find((x) => x.blob);
  if (img?.data) buf = Buffer.from(img.data, 'base64');
  else if (res) buf = Buffer.from(res.blob, 'base64');
  else if (result.links?.[0]?.uri?.startsWith('http')) {
    const r = await fetch(result.links[0].uri);
    if (!r.ok) throw new Error(`download ${result.links[0].uri}: HTTP ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
  }
  if (!buf) throw new Error(`no file in result: ${JSON.stringify(result).slice(0, 400)}`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, buf);
  const info = typeof result.text === 'string' ? result.text : JSON.stringify(result.text ?? {});
  log(`   wrote ${file} (${(buf.length / 1024).toFixed(0)} KiB) ${info.slice(0, 500)}`);
  return result.text;
}

const results = {};

async function previews() {
  const raster = await call('render_image', { engine: 'RASTER', width: 640, height: 360, frame: 1 });
  results.raster = await saveFile(raster, path.join(OPTS.outDir, 'raster.png'));
  const pt = await call('render_image', {
    engine: 'PATHTRACER',
    width: 640,
    height: 360,
    samples: 64,
    time_limit: 60,
    denoise: true,
    frame: 1,
  });
  results.pathtraced = await saveFile(pt, path.join(OPTS.outDir, 'pathtraced.png'));
}

/**
 * Final still: 1280x720 path traced and denoised, bounded by a wall-clock budget. If the budget
 * stops it below --min-samples (a slower or busier machine), the build fails and the existing
 * render.png is kept instead of being replaced by a noisier one.
 */
async function finalStill() {
  const r = await call('render_image', {
    engine: 'PATHTRACER',
    width: 1280,
    height: 720,
    samples: OPTS.samples,
    denoise: true,
    time_limit: OPTS.timeLimit,
    frame: 1,
  });
  const { samples, time_limit_reached: cut } = r.text;
  if (cut)
    log(`   the ${OPTS.timeLimit} s time limit stopped the still at ${samples} of ${OPTS.samples} samples`);
  check(
    samples >= OPTS.minSamples,
    `render.png reached only ${samples} of ${OPTS.samples} samples in ${OPTS.timeLimit} s (minimum ${OPTS.minSamples}); ` +
      'not written: raise --time-limit or lower --samples / --min-samples',
  );
  results.still = await saveFile(r, path.join(OPTS.outDir, 'render.png'));
}

/**
 * A render_animation result must contain every requested frame, each sampled to at least half of the
 * requested samples (the time limit stops slow frames early); checked before the file is written.
 */
function checkFrames(what, info, expected, samples) {
  check(
    !info.truncated && info.frame_count === expected,
    `${what}: ${info.frame_count}/${expected} frames, truncated ${info.truncated}; not written`,
  );
  const reached = info.samples_reached;
  log(
    `   ${what}: ${info.frame_count} frames, samples per pixel min ${reached?.min} / mean ${reached?.mean} of ${samples}` +
      (info.undersampled_frames?.length ? `, undersampled frames ${info.undersampled_frames.join(' ')}` : ''),
  );
  check(
    reached && reached.min >= Math.ceil(samples / 2),
    `${what}: a frame reached only ${reached?.min} of ${samples} samples; not written`,
  );
}

/** Turntable: a 12-tile contact sheet of the loop, then the full 36-frame loop as a GIF. */
async function turntableOutputs() {
  const loopLen = LOOP.frame_end - LOOP.frame_start + 1;
  const sheet = await call('render_animation', {
    format: 'CONTACT_SHEET',
    engine: 'PATHTRACER',
    frame_start: LOOP.frame_start,
    frame_end: LOOP.frame_end,
    frame_step: 3,
    width: 320,
    height: 180,
    columns: 4,
    samples: OPTS.animSamples * 2,
    denoise: true,
    time_limit: 300,
  });
  checkFrames('contact sheet', sheet.text, Math.ceil(loopLen / 3), OPTS.animSamples * 2);
  results.contact_sheet = await saveFile(sheet, path.join(OPTS.outDir, 'contact_sheet.png'));
  const gif = await call('render_animation', {
    format: 'GIF',
    engine: 'PATHTRACER',
    frame_start: LOOP.frame_start,
    frame_end: LOOP.frame_end,
    width: 480,
    height: 270,
    samples: OPTS.animSamples,
    denoise: true,
    time_limit: 600,
    fps: 12,
    dither: 'BAYER',
  });
  checkFrames('GIF', gif.text, loopLen, OPTS.animSamples);
  results.gif = await saveFile(gif, path.join(OPTS.outDir, 'preview.gif'));
}

async function exportGlb() {
  const r = await call('export_scene', { format: 'glb' });
  results.glb = await saveFile(r, path.join(OPTS.outDir, 'scene.glb'));
}

// ------------------------------------------------------------------ main

const { mode } = OPTS;
log(`mode --${mode}, outputs -> ${OPTS.outDir}`);
try {
  await step('fresh project', freshProject);
  await step('scene settings', sceneSettings);
  await step('studio (cyclorama + pedestal)', buildStudio);
  await step('bottle, perfume and cap', buildBottle);
  await step('label', buildLabel);
  await step('lights', buildLights);
  await step('props', buildProps);
  await step('camera', buildCamera);
  await step('turntable rig', buildTurntable);
  await step('verify scene', verifyScene);
  if (mode === 'preview') await step('previews', previews);
  if (mode === 'final' || mode === 'still') await step('final still (render.png)', finalStill);
  if (mode === 'final' || mode === 'anim') await step('turntable renders', turntableOutputs);
  if (mode === 'export-only') await step('glTF export (scene.glb)', exportGlb);
} finally {
  log('timings', JSON.stringify(timings));
  if (warnings.length) log(`warnings (${warnings.length})`, JSON.stringify(warnings));
  if (Object.keys(results).length) log('results', JSON.stringify(results));
  await mcp.close();
}
