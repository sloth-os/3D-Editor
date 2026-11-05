#!/usr/bin/env node
/**
 * "Vellune" — an original perfume product shot, built from scratch through the 3D editor's MCP
 * server (the same tools an external AI agent uses).
 *
 *   MCP_URL=http://127.0.0.1:4505/mcp node examples/product-shot/build.mjs
 *
 * Environment:
 *   MCP_URL      MCP endpoint (default http://127.0.0.1:8080/mcp, see scripts/mcp.mjs)
 *   MODE         full (default): build + final still + turntable + glb export
 *                build: only build the project; preview: build + quick previews into PREVIEW_DIR
 *                still / anim / export: build + only that output
 *   PREVIEW_DIR  where MODE=preview writes its PNGs (default /tmp/product-shot-previews)
 *   OUT_DIR      where final outputs go (default: this directory)
 *
 * Everything (geometry, materials, lights, camera, animation) is created by MCP tool calls; the
 * script only computes numbers (profile points, label layout) and saves the returned files.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../../scripts/mcp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT_DIR ?? HERE;
const MODE = process.env.MODE ?? 'full';
const PREVIEW_DIR = process.env.PREVIEW_DIR ?? '/tmp/product-shot-previews';
const PROJECT = 'product-shot';

const PI = Math.PI;
const r6 = (v) => Math.round(v * 1e6) / 1e6;

// ------------------------------------------------------------------ design constants (metres)

/** Octagonal bottle: the profile lies in the plane at 22.5° so a flat facet faces the camera (-Y). */
const TH0 = PI / 8;
const BOTTLE = {
  R: 0.038, // circumradius of the octagon at the shoulder line
  f: 0.004, // outer bottom fillet
  Hs: 0.072, // top of the straight side wall
  rn: 0.0105, // neck radius
  Hsh: 0.016, // shoulder height
  Hn: 0.096, // top of the neck
  t: 0.0032, // glass wall thickness
  base: 0.014, // thick glass base
  fi: 0.005, // inner bottom fillet
  scaleX: 1.2, // elongated octagon: wider front facet for the label
  steps: 8,
};
const LIQUID = { gap: 0.0004, level: 0.062 };
const PEDESTAL = { radius: 0.085, height: 0.05 };
const Z_BOTTLE = PEDESTAL.height; // the bottle stands on the pedestal
const APOTHEM = BOTTLE.R * Math.cos(PI / BOTTLE.steps); // distance of the front facet from the axis
const FACE_Y = -APOTHEM; // front facet plane (object space = world space, the bottle is not rotated)
const LABEL = { w: 0.03, h: 0.027, cz: 0.04, corner: 0.0022, thick: 0.0002 };
/** Still camera; the turntable orbits the same camera around TARGET, so frame 1 matches the still. */
const CAMERA = { azimuth: -PI / 2 - 0.14, distance: 1.05, elevation: 0.15, target: [0, 0, 0.095], lens: 85, fstop: 4 };
const camPos = () => {
  const { azimuth: a, distance: d, elevation: e, target: t } = CAMERA;
  return [r6(t[0] + d * Math.cos(e) * Math.cos(a)), r6(t[1] + d * Math.cos(e) * Math.sin(a)), r6(t[2] + d * Math.sin(e))];
};
const BACKDROP_COLOR = [0.2, 0.085, 0.078];
/** Objects that turn with the turntable camera (everything except the bottle and its pedestal). */
const STUDIO_RIG = ['Cyclorama', 'Key Softbox', 'Fill Panel', 'Rim Strip', 'Column', 'Gold Sphere', 'Pearl', 'Pearl Small', 'Pearl Tiny'];

// ------------------------------------------------------------------ helpers

const t0 = Date.now();
const timings = [];
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s]`, ...a);

const mcp = await connect();

/** Calls an MCP tool on the project; errors carry the tool name and arguments. */
async function call(tool, args = {}) {
  try {
    return await mcp.call(tool, { project: PROJECT, ...args });
  } catch (e) {
    throw new Error(`${tool} failed: ${e.message}\n  args: ${JSON.stringify(args).slice(0, 600)}`);
  }
}

/** Runs one operator; logs its warnings and returns the operator result. */
async function op(operator, params = {}, selection) {
  const r = await call('run_operator', { operator, params, ...(selection ? { selection } : {}) });
  for (const rep of r.reports ?? []) if (rep.level !== 'INFO') log(`  ${operator}: ${rep.level} ${rep.message}`);
  if (!r.ok) throw new Error(`${operator} reported failure: ${JSON.stringify(r.reports)}`);
  return r.result;
}

/** Runs operators as one undo step; returns their results in order. */
async function batch(operations) {
  const r = await call('batch', { operations });
  if (!r.ok || r.failed) throw new Error(`batch failed: ${JSON.stringify(r).slice(0, 1500)}`);
  for (const x of r.results)
    for (const rep of x.reports ?? []) if (rep.level !== 'INFO') log(`  ${x.operator}: ${rep.level} ${rep.message}`);
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

/** Points of an elliptical arc (start point excluded) in the (r, z) profile plane. */
function arc(cr, cz, rr, rz, a0, a1, n) {
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cr + rr * Math.cos(a), cz + rz * Math.sin(a)]);
  }
  return pts;
}

/** (r, z) profile -> 3D points in the vertical plane at angle TH0 around Z. */
const toPlane = (rz) => rz.map(([r, z]) => [r6(r * Math.cos(TH0)), r6(r * Math.sin(TH0)), r6(z)]);

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

// ------------------------------------------------------------------ profiles

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
 * Lathe workflow: profile curve -> mesh (object.convert) -> SCREW modifier (+ smooth by angle).
 * The SCREW modifier does nothing on a plain wire curve here, hence the conversion.
 */
async function revolve(name, profile, { steps = BOTTLE.steps, location, scaleX = 1, smoothAngle = 0.6 } = {}) {
  await op('curve.add_from_points', {
    name,
    points: toPlane(profile),
    type: 'POLY',
    dimensions: '3D',
    location,
    scale: [scaleX, 1, 1],
  });
  await op('object.convert', { target: 'MESH' }, { objects: [name] });
  await call('add_modifier', {
    object: name,
    type: 'SCREW',
    name: 'Lathe',
    params: { axis: 'Z', angle: 2 * PI, steps, render_steps: steps, use_merge_vertices: true, merge_threshold: 1e-5 },
  });
  await call('add_modifier', { object: name, type: 'SMOOTH_BY_ANGLE', name: 'Facets', params: { angle: smoothAngle } });
}

/** Light/camera datablock ids are not exposed by get_object; anim.driver_add reports them. */
async function dataId(targetType, object, probePath) {
  const r = await op('anim.driver_add', { target_type: targetType, target: object, path: probePath, expression: '0' });
  const id = r.drivers[0].target_id;
  await op('anim.driver_remove', { target_type: targetType, target: id, path: probePath });
  return id;
}

async function aim(objects, point) {
  await op('object.look_at', { objects, point });
}

// ------------------------------------------------------------------ build

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
    frame_start: 1,
    frame_end: 36,
    fps: 24,
    resolution_x: 1280,
    resolution_y: 720,
    engine: 'PATHTRACER',
    samples: 128,
    max_bounces: 8, // glass walls + perfume = 6 refractions before the backdrop
    use_denoising: true,
    view_transform: 'NEUTRAL', // Khronos PBR Neutral: faithful product colours
    exposure: 0,
    environment: 'STUDIO',
    environment_strength: 0.2,
    world_color: [0.05, 0.045, 0.04],
    world_strength: 1,
  });
}

async function buildStudio() {
  // Cyclorama: an open 2D curve (floor -> cove -> wall) extruded sideways into a seamless sweep.
  const R = 0.26;
  const back = 0.62;
  const prof = [[-0.75, 0, 0], [back - R, 0, 0]];
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

  // Marble pedestal: bevelled cylinder with the procedural marble preset.
  await call('add_object', {
    type: 'cylinder',
    name: 'Pedestal',
    params: { vertices: 128, radius: PEDESTAL.radius, depth: PEDESTAL.height },
    location: [0, 0, PEDESTAL.height / 2],
  });
  await call('add_modifier', {
    object: 'Pedestal',
    type: 'BEVEL',
    name: 'Soft Edge',
    params: { width: 0.004, segments: 4, limit_method: 'ANGLE', angle_limit: 0.6 },
  });
  await op('object.shade_auto_smooth', { angle: 0.6 }, { objects: ['Pedestal'] });
  await op('material.preset_apply', { preset: 'marble', objects: ['Pedestal'], name: 'Carrara Marble' });
  await op('material.procedural_set', {
    material: 'Carrara Marble',
    channel: 'base_color',
    procedural: { scale: 9, color_a: [0.4, 0.4, 0.41], color_b: [0.8, 0.79, 0.76], distortion: 2.6 },
  });
}

async function buildBottle() {
  const loc = [0, 0, Z_BOTTLE];
  await revolve('Bottle', bottleProfile(), { location: loc, scaleX: BOTTLE.scaleX });
  await call('set_material', {
    object: 'Bottle',
    name: 'Bottle Glass',
    base_color: [0.965, 0.985, 1.0],
    transmission: 1,
    roughness: 0.0,
    ior: 1.5,
    metallic: 0,
  });
  await revolve('Perfume', liquidProfile(), { location: loc, scaleX: BOTTLE.scaleX });
  await call('set_material', {
    object: 'Perfume',
    name: 'Perfume',
    base_color: [1.0, 0.87, 0.64],
    transmission: 1,
    roughness: 0.0,
    ior: 1.36,
  });
  const capZ = Z_BOTTLE + BOTTLE.Hs + BOTTLE.Hsh + 0.0003;
  await revolve('Cap', capProfile(), { location: [0, 0, capZ], scaleX: BOTTLE.scaleX });
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
      params: { ...flat, name: 'Label', points: roundedRect(w, h, corner), extrude: thick, location: [0, yPlate, zc] },
    },
    // thin gold frame: a closed 3D outline with a round bevel
    {
      operator: 'curve.add_from_points',
      params: {
        name: 'Label Frame',
        points: roundedRect(w - 0.003, h - 0.003, corner * 0.6),
        type: 'POLY',
        cyclic: true,
        dimensions: '3D',
        bevel_depth: 0.00011,
        bevel_resolution: 1,
        location: [0, yFront - 0.00012, zc],
        rotation: rot,
      },
    },
    // crescent emblem ("lune")
    {
      operator: 'curve.add_from_points',
      params: { ...flat, name: 'Emblem', points: crescent(0.0026, 0.0016, -0.35), extrude: ink, location: [0, yInk, zc + 0.0072] },
    },
    {
      operator: 'object.text_add',
      params: {
        body: 'VELLUNE',
        name: 'Label Name',
        size: 0.0056,
        extrude: ink,
        align_x: 'CENTER',
        space_character: 1.15,
        location: [0, yInk, zc - 0.0022],
        rotation: rot,
      },
    },
    {
      operator: 'curve.add_from_points',
      params: { ...flat, name: 'Label Rule', points: roundedRect(0.011, 0.00028, 0.00013, 2), extrude: ink, location: [0, yInk, zc - 0.0048] },
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
        location: [0, yInk, zc - 0.0082],
        rotation: rot,
      },
    },
    {
      operator: 'material.new',
      params: { name: 'Black Enamel', assign: false, base_color: [0.012, 0.012, 0.014, 1], roughness: 0.32, coat_weight: 1, coat_roughness: 0.04 },
    },
    { operator: 'object.material_assign', params: { material: 'Black Enamel', objects: ['Label'] } },
    { operator: 'material.preset_apply', params: { preset: 'gold', objects: gold, name: 'Gold Leaf' } },
    { operator: 'material.update', params: { material: 'Gold Leaf', roughness: 0.28 } },
    { operator: 'object.parent_to', params: { objects: ['Label', ...gold], parent: 'Bottle' } },
  ]);
  log(`   label name width ${(res[3].width * 1000).toFixed(1)} mm, subline ${(res[5].width * 1000).toFixed(1)} mm (label ${w * 1000} mm)`);
}

/** Area light: added, aimed, then shaped through its datablock (see dataId). */
async function areaLight(name, { location, aimAt, energy, color, shape, size, sizeY }) {
  await call('add_object', { type: 'light', light_type: 'AREA', name, params: { energy, color }, location });
  await aim([name], aimAt);
  const id = await dataId('light', name, 'energy');
  await op('data.set_property', { kind: 'lights', target: id, values: { shape, size, size_y: sizeY ?? size } });
}

async function buildLights() {
  // Three-point studio lighting with area lights (power in W) + the dim STUDIO environment.
  await areaLight('Key Softbox', {
    location: [-0.5, -0.36, 0.46],
    aimAt: [0, 0, 0.1],
    energy: 12,
    color: [1.0, 0.95, 0.88],
    shape: 'RECTANGLE',
    size: 0.75,
    sizeY: 0.85,
  });
  await areaLight('Fill Panel', {
    location: [0.52, -0.5, 0.2],
    aimAt: [0, 0, 0.09],
    energy: 2.2,
    color: [0.88, 0.93, 1.0],
    shape: 'SQUARE',
    size: 0.6,
  });
  // Side-back strip for the glass edges; placed so its emitting half-space does not end on the
  // visible backdrop (an area light close to the wall drew a hard light/dark boundary there).
  await areaLight('Rim Strip', {
    location: [0.42, 0.14, 0.16],
    aimAt: [0, 0, 0.11],
    energy: 6,
    color: [1.0, 0.97, 0.93],
    shape: 'RECTANGLE',
    size: 0.08,
    sizeY: 0.5,
  });
}

/** Props (one batch): a marble column with a gold sphere behind, three pearls in front. */
async function buildProps() {
  const pearls = [
    ['Pearl', 0.012, [-0.135, -0.02]],
    ['Pearl Small', 0.008, [-0.108, -0.046]],
    ['Pearl Tiny', 0.0055, [-0.157, -0.052]],
  ];
  const names = pearls.map((p) => p[0]);
  await batch([
    {
      operator: 'mesh.primitive_cylinder_add',
      params: { name: 'Column', vertices: 96, radius: 0.045, depth: 0.1, location: [0.24, 0.33, 0.05] },
    },
    {
      operator: 'object.modifier_add',
      params: {
        object: 'Column',
        type: 'BEVEL',
        name: 'Soft Edge',
        params: { width: 0.002, segments: 3, limit_method: 'ANGLE', angle_limit: 0.6 },
      },
    },
    { operator: 'object.shade_auto_smooth', params: { angle: 0.6 } }, // acts on the selection (the column)
    { operator: 'object.material_assign', params: { material: 'Carrara Marble', objects: ['Column'] } },
    {
      operator: 'mesh.primitive_uv_sphere_add',
      params: { name: 'Gold Sphere', segments: 64, ring_count: 32, radius: 0.018, location: [0.24, 0.33, 0.118] },
    },
    ...pearls.map(([name, radius, [x, y]]) => ({
      operator: 'mesh.primitive_uv_sphere_add',
      params: { name, segments: 48, ring_count: 24, radius, location: [x, y, radius] },
    })),
    { operator: 'object.select', params: { objects: ['Gold Sphere', ...names] } },
    { operator: 'object.shade_smooth', params: {} },
    { operator: 'object.material_assign', params: { material: 'Polished Gold', objects: ['Gold Sphere'] } },
    { operator: 'material.preset_apply', params: { preset: 'porcelain', objects: names, name: 'Pearl White' } },
    { operator: 'material.update', params: { material: 'Pearl White', coat_weight: 1, coat_roughness: 0.05, roughness: 0.3 } },
  ]);
}

async function buildCamera() {
  const pos = camPos();
  await call('add_object', { type: 'camera', name: 'Camera', params: { lens: CAMERA.lens }, location: pos });
  await aim(['Camera'], CAMERA.target);
  await call('set_active_camera', { camera: 'Camera' });
  // Depth of field focused on the label: distance along the view axis.
  const dir = CAMERA.target.map((v, i) => v - pos[i]);
  const len = Math.hypot(...dir);
  const label = [0, FACE_Y, Z_BOTTLE + LABEL.cz];
  const focus = label.reduce((acc, v, i) => acc + (v - pos[i]) * dir[i], 0) / len;
  const id = await dataId('camera', 'Camera', 'lens');
  await op('data.set_property', {
    kind: 'cameras',
    target: id,
    values: { dof_use: true, dof_focus_distance: r6(focus), dof_aperture_fstop: CAMERA.fstop },
  });
  log(`   camera at ${JSON.stringify(pos)}, focus ${focus.toFixed(3)} m at f/${CAMERA.fstop}`);
}

/**
 * Turntable: anim.turntable orbits the still camera around the bottle (same radius, height and start
 * angle, so frame 1 is the still). The backdrop, lights and props are parented to the pivot, so
 * they turn with the camera: on screen the bottle and its pedestal spin in a fixed studio.
 */
async function buildTurntable() {
  const { distance: d, elevation: e, azimuth: a, target } = CAMERA;
  const tt = await op('anim.turntable', {
    camera: 'Camera',
    center: target,
    radius: r6(d * Math.cos(e)),
    height: r6(d * Math.sin(e)),
    start_angle: a,
    frame_start: 1,
    frame_end: 36,
    set_frame_range: true,
  });
  log(`   turntable: pivot ${tt.pivot_name}, radius ${tt.radius}, height ${tt.height}`);
  await op('object.parent_to', {
    objects: STUDIO_RIG,
    parent: tt.pivot_name,
  });
  return tt;
}

async function checkScene() {
  const s = await call('get_scene', {});
  log(`   scene: ${JSON.stringify(s.counts)}`);
  if (s.problems?.length) log(`   PROBLEMS: ${JSON.stringify(s.problems)}`);
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
  log(`   wrote ${file} (${(buf.length / 1024).toFixed(0)} KiB) ${info.slice(0, 400)}`);
  return result.text;
}

async function previews() {
  await mkdir(PREVIEW_DIR, { recursive: true });
  const raster = await call('render_image', { engine: 'RASTER', width: 640, height: 360 });
  await saveFile(raster, path.join(PREVIEW_DIR, 'raster.png'));
  const pt = await call('render_image', {
    engine: 'PATHTRACER',
    width: Number(process.env.PW ?? 480),
    height: Number(process.env.PH ?? 270),
    samples: Number(process.env.PS ?? 24),
    time_limit: Number(process.env.PT ?? 60),
    denoise: true,
  });
  await saveFile(pt, path.join(PREVIEW_DIR, 'pathtraced.png'));
}

const results = {};

/** Final still: 1280x720 path traced, denoised, bounded to 300 s of wall-clock time. */
async function finalStill() {
  const r = await call('render_image', {
    engine: 'PATHTRACER',
    width: 1280,
    height: 720,
    samples: Number(process.env.FINAL_SAMPLES ?? 96),
    denoise: true,
    time_limit: Number(process.env.FINAL_TIME ?? 300),
    frame: 1,
  });
  results.still = await saveFile(r, path.join(OUT, 'render.png'));
}

/** Turntable: a 12-tile contact sheet of the loop and the full 36-frame loop as a GIF. */
async function turntableOutputs() {
  const sheet = await call('render_animation', {
    format: 'CONTACT_SHEET',
    engine: 'PATHTRACER',
    frame_start: 1,
    frame_end: 36,
    frame_step: 3,
    width: 320,
    height: 180,
    columns: 4,
    samples: 16,
    denoise: true,
    time_limit: 240,
  });
  results.contact_sheet = await saveFile(sheet, path.join(OUT, 'contact_sheet.png'));
  const gif = await call('render_animation', {
    format: 'GIF',
    engine: 'PATHTRACER',
    frame_start: 1,
    frame_end: 36,
    width: 384,
    height: 216,
    samples: 8,
    denoise: true,
    time_limit: 300,
    fps: 12,
    dither: 'BAYER',
  });
  results.gif = await saveFile(gif, path.join(OUT, 'preview.gif'));
}

async function exportGlb() {
  const r = await call('export_scene', { format: 'glb' });
  results.glb = await saveFile(r, path.join(OUT, 'scene.glb'));
}

// ------------------------------------------------------------------ main

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
  await step('check scene', checkScene);
  if (MODE === 'preview') await step('previews', previews);
  if (MODE === 'full' || MODE === 'still') await step('final still (render.png)', finalStill);
  if (MODE === 'full' || MODE === 'anim') await step('turntable renders', turntableOutputs);
  if (MODE === 'full' || MODE === 'export') await step('glTF export (scene.glb)', exportGlb);
} finally {
  log('timings', JSON.stringify(timings));
  if (Object.keys(results).length) log('results', JSON.stringify(results));
  await mcp.close();
}
