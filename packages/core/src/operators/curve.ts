import { z } from 'zod';
import type { Vec3 } from '../math/types';
import type { CurveData, HandleType, ObjectData, Spline, SplinePoint, SplineType } from '../doc/types';
import { defaultSpline, defaultSplinePoint } from '../doc/defaults';
import type { MeshData } from '../mesh/types';
import { cloneMesh } from '../mesh/types';
import { ANIMATABLE } from '../anim/properties';
import { sanitizeSpline } from '../curve/spline';
import { layoutText, textOutline } from '../curve/text';
import type { EvaluatedScene } from '../eval/evaluate';
import { fcurveKey } from '../doc/scene-doc';
import type { OperatorContext } from './context';
import { OperatorError } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { activeObject, setSelection, vec3 } from './helpers';
import { keyProperty, rekeyAnimated } from './anim';

/*
 * Curve and text operators (curve.*, object.text_add, font.*). Coordinates of spline points are
 * in the curve object's local space; all lengths are metres and angles radians.
 */

const handleType = z.enum(['AUTO', 'VECTOR', 'ALIGNED', 'FREE']);
const splineType = z.enum(['POLY', 'BEZIER', 'NURBS']);

const pointObject = z.object({
  co: vec3.describe("Point position [x, y, z] in the curve object's local space (metres)"),
  handle_left: vec3
    .nullable()
    .optional()
    .describe('BEZIER only: left handle position; giving it without a type makes the handle FREE'),
  handle_right: vec3
    .nullable()
    .optional()
    .describe('BEZIER only: right handle position; giving it without a type makes the handle FREE'),
  handle_left_type: handleType.optional().describe('BEZIER only: left handle type (default: handle_type)'),
  handle_right_type: handleType.optional().describe('BEZIER only: right handle type (default: handle_type)'),
  radius: z
    .number()
    .min(0)
    .optional()
    .describe('Bevel/taper radius multiplier at this point (default 1; 0 = pointed)'),
  tilt: z
    .number()
    .optional()
    .describe('Twist of the bevel/extrusion around the curve direction, radians (default 0)'),
  weight: z.number().positive().optional().describe('NURBS only: control point weight (default 1)'),
});

const pointInput = z.union([vec3, pointObject]);
type PointInput = z.infer<typeof pointInput>;

const pointsDescription =
  "Control points in the curve object's local space: either [x, y, z] triples or objects " +
  '{co, handle_left, handle_right, handle_left_type, handle_right_type, radius, tilt, weight}. POLY splines pass ' +
  'through the points with straight segments, BEZIER splines pass through them smoothly (AUTO handles) or as ' +
  'given by the handles, NURBS splines are pulled towards them.';

const objectRef = z
  .string()
  .optional()
  .describe('Curve or text object id or name (default: the active object)');

const placement = {
  location: vec3.optional().describe('World location of the new object (default: the 3D cursor)'),
  rotation: vec3.optional().describe('Euler XYZ rotation in radians (default [0, 0, 0])'),
  scale: vec3.optional().describe('Scale (default [1, 1, 1])'),
  name: z.string().min(1).optional().describe('Name of the new object (and its data)'),
};

/** Optional curve datablock fields (shared by add operators and curve.properties_set). */
const curveFields = {
  dimensions: z
    .enum(['2D', '3D'])
    .optional()
    .describe(
      '2D curves lie flat in their local XY plane and closed splines can be filled; 3D curves can twist/tilt',
    ),
  resolution_u: z
    .number()
    .int()
    .min(1)
    .max(1024)
    .optional()
    .describe('Samples per segment between control points (default 12)'),
  render_resolution_u: z
    .number()
    .int()
    .min(0)
    .max(1024)
    .optional()
    .describe('Resolution used for final renders (0 = same as resolution_u)'),
  bevel_mode: z
    .enum(['ROUND', 'OBJECT'])
    .optional()
    .describe(
      'ROUND: circular profile of radius bevel_depth; OBJECT: the profile is the shape of bevel_object',
    ),
  bevel_depth: z
    .number()
    .min(0)
    .optional()
    .describe('Radius of the ROUND bevel in metres; > 0 turns the curve into a tube (default 0)'),
  bevel_resolution: z
    .number()
    .int()
    .min(0)
    .max(32)
    .optional()
    .describe('Extra points per quarter circle of the ROUND bevel (default 4)'),
  bevel_object: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Curve object (id or name) whose shape is swept along this curve when bevel_mode is OBJECT; null clears it',
    ),
  bevel_factor_start: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Fraction of the length (0..1) where the bevel/extrusion starts (default 0)'),
  bevel_factor_end: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      'Fraction of the length (0..1) where the bevel/extrusion ends (default 1); animate it to "grow" a curve',
    ),
  extrude: z
    .number()
    .min(0)
    .optional()
    .describe(
      'Extrusion in metres along the curve normal: a ribbon of height 2×extrude, or the half thickness of filled 2D shapes/text',
    ),
  offset: z
    .number()
    .optional()
    .describe(
      'Sideways offset of the bevel/extrusion/fill outline in metres (positive = outward, i.e. bolder for 2D shapes and text)',
    ),
  fill_mode: z
    .enum(['FULL', 'HALF', 'FRONT', 'BACK', 'BOTH', 'NONE'])
    .optional()
    .describe(
      '3D curves: FULL tube, HALF/FRONT/BACK parts of the bevel. 2D curves and text: BOTH/FRONT/BACK cap faces, NONE = outline only',
    ),
  use_fill_caps: z.boolean().optional().describe('Close the open ends of beveled open curves with cap faces'),
  twist_mode: z
    .enum(['Z_UP', 'MINIMUM', 'TANGENT'])
    .optional()
    .describe(
      'Orientation of the bevel along 3D curves: Z_UP keeps it upright, MINIMUM avoids twisting, TANGENT follows the bend',
    ),
  use_path: z.boolean().optional().describe('Allow the curve to be used as a path (Follow Path)'),
  path_duration: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Frames needed to traverse the path (Follow Path)'),
  eval_time: z
    .number()
    .optional()
    .describe('Position along the path in frames, 0..path_duration (Follow Path; animatable)'),
};
type CurveFieldParams = { [K in keyof typeof curveFields]?: z.infer<(typeof curveFields)[K]> };

/** Optional text layout fields (FONT objects). */
const textFields = {
  size: z
    .number()
    .positive()
    .optional()
    .describe('Font size: one em in metres (capital letters are 0.7 × size tall; default 1)'),
  space_line: z.number().optional().describe('Line distance in em (default 1)'),
  space_word: z.number().min(0).optional().describe('Width multiplier of spaces (default 1)'),
  space_character: z
    .number()
    .optional()
    .describe('Character spacing factor (default 1; each step of 1 adds 0.5 em between characters)'),
  shear: z.number().min(-1).max(1).optional().describe('Italic slant: x += shear × height (default 0)'),
  align_x: z
    .enum(['LEFT', 'CENTER', 'RIGHT', 'JUSTIFY', 'FLUSH'])
    .optional()
    .describe(
      'Horizontal alignment around the object origin (JUSTIFY/FLUSH stretch lines to the longest line)',
    ),
  align_y: z
    .enum(['TOP_BASELINE', 'TOP', 'CENTER', 'BOTTOM', 'BOTTOM_BASELINE'])
    .optional()
    .describe('Vertical alignment: TOP_BASELINE puts the first baseline at the origin'),
  offset_x: z.number().optional().describe('Horizontal offset of the text in metres'),
  offset_y: z.number().optional().describe('Vertical offset of the text in metres'),
};
type TextFieldParams = { [K in keyof typeof textFields]?: z.infer<(typeof textFields)[K]> };

const TEXT_KEYS = Object.keys(textFields) as (keyof TextFieldParams)[];
const CURVE_KEYS = Object.keys(curveFields) as (keyof CurveFieldParams)[];

// ------------------------------------------------------------------ helpers

function placementOf(
  ctx: OperatorContext,
  p: { location?: number[]; rotation?: number[]; scale?: number[] },
) {
  return {
    location: (p.location ?? ctx.state.cursorLocation) as Vec3,
    rotation_euler: (p.rotation ?? [0, 0, 0]) as Vec3,
    scale: (p.scale ?? [1, 1, 1]) as Vec3,
  };
}

/** Converts an operator point (triple or object) to a spline point. */
function toSplinePoint(input: PointInput, type: SplineType, defaultHandle: HandleType): SplinePoint {
  if (Array.isArray(input)) {
    const p = defaultSplinePoint([input[0], input[1], input[2]]);
    if (type === 'BEZIER') {
      p.handle_left_type = defaultHandle;
      p.handle_right_type = defaultHandle;
    }
    return p;
  }
  const p = defaultSplinePoint([input.co[0], input.co[1], input.co[2]]);
  if (type === 'BEZIER') {
    p.handle_left = input.handle_left ? [...input.handle_left] : null;
    p.handle_right = input.handle_right ? [...input.handle_right] : null;
    p.handle_left_type = input.handle_left_type ?? (p.handle_left ? 'FREE' : defaultHandle);
    p.handle_right_type = input.handle_right_type ?? (p.handle_right ? 'FREE' : defaultHandle);
  }
  if (input.radius !== undefined) p.radius = input.radius;
  if (input.tilt !== undefined) p.tilt = input.tilt;
  if (input.weight !== undefined) p.weight = input.weight;
  return p;
}

const splineOptions = {
  type: splineType
    .default('POLY')
    .describe('POLY (straight segments), BEZIER (smooth, through the points) or NURBS'),
  cyclic: z.boolean().default(false).describe('Close the spline into a loop (use_cyclic_u)'),
  handle_type: handleType
    .default('AUTO')
    .describe('BEZIER: handle type of points given without one (AUTO = smooth, VECTOR = sharp corners)'),
  order_u: z
    .number()
    .int()
    .min(2)
    .max(6)
    .default(4)
    .describe('NURBS: order (degree + 1), clamped to the point count'),
  use_endpoint_u: z
    .boolean()
    .default(true)
    .describe('NURBS: make the spline start and end at its first/last point'),
  use_smooth: z.boolean().default(true).describe('Smooth shading of the bevel/extrusion surface'),
  material_index: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Material slot index used by this spline's faces"),
};

const splineOverrides = {
  type: splineType.optional().describe('Change the spline type'),
  cyclic: z.boolean().optional().describe('Open or close the spline'),
  handle_type: handleType
    .optional()
    .describe('BEZIER: handle type of points given without one (default AUTO)'),
  order_u: z.number().int().min(2).max(6).optional().describe('NURBS order'),
  use_endpoint_u: z.boolean().optional().describe('NURBS: pass through the end points'),
  resolution_u: z
    .number()
    .int()
    .min(0)
    .max(1024)
    .optional()
    .describe('Per-spline resolution (0 = the curve resolution)'),
  use_smooth: z.boolean().optional().describe('Smooth shading of the surface'),
  material_index: z.number().int().min(0).optional().describe('Material slot index'),
};

function buildSpline(
  points: PointInput[],
  o: {
    type: SplineType;
    cyclic: boolean;
    handle_type: HandleType;
    order_u: number;
    use_endpoint_u: boolean;
    use_smooth: boolean;
    material_index: number;
    resolution_u?: number;
  },
): Spline {
  const s = defaultSpline(
    o.type,
    points.map((p) => toSplinePoint(p, o.type, o.handle_type)),
  );
  s.use_cyclic_u = o.cyclic;
  s.order_u = o.order_u;
  s.use_endpoint_u = o.use_endpoint_u;
  s.use_smooth = o.use_smooth;
  s.material_index = o.material_index;
  if (o.resolution_u !== undefined) s.resolution_u = o.resolution_u;
  return s;
}

/** Resolves the curve/text object an operator works on. */
function curveTarget(
  ctx: OperatorContext,
  ref: string | undefined,
  kinds: ('CURVE' | 'FONT')[] = ['CURVE', 'FONT'],
): { object: ObjectData; curve: CurveData } {
  const o = ref ? ctx.doc.resolveObject(ref) : activeObject(ctx);
  if (!o) {
    if (ref) throw new OperatorError(`Object '${ref}' not found`, 'NOT_FOUND');
    throw new OperatorError('No active object (pass `object`)', 'POLL_FAILED');
  }
  if (!kinds.includes(o.type as 'CURVE' | 'FONT') || !o.data) {
    throw new OperatorError(
      `Object '${o.name}' is a ${o.type} object, expected ${kinds.join(' or ')}`,
      'POLL_FAILED',
    );
  }
  const curve = ctx.doc.getCurve(o.data);
  if (!curve) throw new OperatorError(`Curve data of '${o.name}' is missing`, 'NOT_FOUND');
  return { object: o, curve };
}

/** Validates and converts curve field params to a datablock patch (resolves bevel_object). */
function curvePatch(ctx: OperatorContext, owner: string | null, p: CurveFieldParams): Partial<CurveData> {
  const patch: Record<string, unknown> = {};
  for (const k of CURVE_KEYS) if (p[k] !== undefined) patch[k] = p[k];
  if (p.bevel_object !== undefined) {
    if (p.bevel_object === null || p.bevel_object === '') patch.bevel_object = null;
    else {
      const b = ctx.doc.resolveObject(p.bevel_object);
      if (!b) throw new OperatorError(`Bevel object '${p.bevel_object}' not found`, 'NOT_FOUND');
      if (b.type !== 'CURVE')
        throw new OperatorError(`Bevel object '${b.name}' must be a curve object`, 'INVALID_PARAMS');
      if (owner && b.id === owner)
        throw new OperatorError('A curve cannot use itself as bevel object', 'INVALID_PARAMS');
      patch.bevel_object = b.id;
      if (p.bevel_mode === undefined) patch.bevel_mode = 'OBJECT';
    }
  }
  return patch as Partial<CurveData>;
}

function textPatch(p: TextFieldParams & { body?: string }): Partial<CurveData> {
  const patch: Record<string, unknown> = {};
  for (const k of TEXT_KEYS) if (p[k] !== undefined) patch[k] = p[k];
  if (p.body !== undefined) patch.body = p.body;
  return patch as Partial<CurveData>;
}

/** Re-keys animated curve channels that were edited so the edit stays visible. */
function rekeyCurve(ctx: OperatorContext, curveId: string, patch: Partial<CurveData>): void {
  const animatable = Object.keys(patch).filter((k) => k in ANIMATABLE.curve);
  if (animatable.length) rekeyAnimated(ctx, 'curve', curveId, animatable);
}

function addCurveObject(
  ctx: OperatorContext,
  type: 'CURVE' | 'FONT',
  name: string,
  data: Partial<CurveData>,
  place: { location?: number[]; rotation?: number[]; scale?: number[] },
): { object: string; name: string; curve: string } {
  const curveId = ctx.doc.addCurve({ ...data, name });
  const id = ctx.doc.addObject({ type, name, data: curveId, ...placementOf(ctx, place) });
  setSelection(ctx, [id], id);
  return { object: id, name: ctx.doc.getObject(id)!.name, curve: curveId };
}

function pollAdd(ctx: OperatorContext): true | string {
  return ctx.state.mode === 'OBJECT' ? true : 'Adding curves and text requires Object Mode';
}

function splineIndexOf(curve: CurveData, index: number): number {
  const n = Array.isArray(curve.splines) ? curve.splines.length : 0;
  if (!Number.isInteger(index) || index < 0 || index >= n)
    throw new OperatorError(
      `Spline index ${index} out of range (the curve has ${n} splines)`,
      'INVALID_PARAMS',
    );
  return index;
}

function scaledPoint(co: Vec3, r: number, extra: Partial<SplinePoint> = {}): SplinePoint {
  return { ...defaultSplinePoint([co[0] * r, co[1] * r, co[2] * r]), ...extra };
}

// ------------------------------------------------------------------ conversion

/** Mesh (vertices + loose edges) from flat segment pairs, merging shared end points. */
function wireMesh(lines: Float32Array): MeshData {
  const positions: number[] = [];
  const looseEdges: number[] = [];
  const index = new Map<string, number>();
  const vertexOf = (x: number, y: number, z: number): number => {
    const key = `${x},${y},${z}`;
    let v = index.get(key);
    if (v === undefined) {
      v = positions.length / 3;
      positions.push(x, y, z);
      index.set(key, v);
    }
    return v;
  };
  for (let i = 0; i + 5 < lines.length; i += 6) {
    const a = vertexOf(lines[i], lines[i + 1], lines[i + 2]);
    const b = vertexOf(lines[i + 3], lines[i + 4], lines[i + 5]);
    if (a !== b) looseEdges.push(a, b);
  }
  return {
    positions,
    faces: [],
    faceMaterials: [],
    faceSmooth: [],
    uvs: null,
    colors: null,
    edgeAttrs: {},
    looseEdges,
  };
}

/** Removes a curve datablock that no object uses any more (and its animation curves). */
function dropOrphanCurve(ctx: OperatorContext, curveId: string): void {
  if (ctx.doc.dataUsers(curveId) > 0) return;
  for (const fc of ctx.doc.listFCurves(curveId))
    if (fc.target_type === 'curve') ctx.doc.removeFCurve(fcurveKey(fc));
  for (const d of ctx.doc.listDrivers(curveId))
    if (d.target_type === 'curve') ctx.doc.removeDriver(fcurveKey(d));
  ctx.doc.map('curves').delete(curveId);
}

/**
 * Converts a CURVE/FONT object (Blender's Object ▸ Convert). target MESH bakes the evaluated
 * geometry (surface, or the wire as loose edges when there is none; modifiers applied) into a mesh,
 * keeping name, transform and material slots. target CURVE turns text into a 2D curve of glyph
 * outlines (POLY splines) keeping its fill/extrude/bevel settings. Returns the converted object.
 */
export function convertCurveObject(
  ctx: OperatorContext,
  o: ObjectData,
  target: 'MESH' | 'CURVE',
  ev: EvaluatedScene,
  keepOriginal = false,
): { object: string; name: string; type: 'MESH' | 'CURVE' } | null {
  if ((o.type !== 'CURVE' && o.type !== 'FONT') || !o.data) return null;
  const curveId = o.data;
  if (target === 'CURVE') {
    if (o.type !== 'FONT') return null;
    const text = ev.byId.get(o.id)?.curve ?? ctx.doc.getCurve(curveId);
    if (!text) return null;
    const outline = textOutline(text);
    const splines = outline.contours.map((c) => {
      const s = defaultSpline(
        'POLY',
        c.map(([x, y]) => defaultSplinePoint([x, y, 0])),
      );
      s.use_cyclic_u = true;
      return s;
    });
    const data: Partial<CurveData> = { ...text, splines, dimensions: '2D', body: '' };
    delete (data as { id?: string }).id;
    const newCurve = ctx.doc.addCurve({ ...data, name: text.name });
    let id = o.id;
    if (keepOriginal) {
      const { id: _i, name, ...rest } = o;
      id = ctx.doc.addObject({ ...rest, type: 'CURVE', name, data: newCurve });
    } else {
      ctx.doc.updateObject(o.id, { type: 'CURVE', data: newCurve });
      dropOrphanCurve(ctx, curveId);
    }
    return { object: id, name: ctx.doc.getObject(id)!.name, type: 'CURVE' };
  }
  const e = ev.byId.get(o.id);
  let mesh: MeshData | null = e?.mesh ? cloneMesh(e.mesh) : null;
  if (!mesh && e?.lines && e.lines.length >= 6) mesh = wireMesh(e.lines);
  if (!mesh)
    mesh = {
      positions: [],
      faces: [],
      faceMaterials: [],
      faceSmooth: [],
      uvs: null,
      colors: null,
      edgeAttrs: {},
      looseEdges: [],
    };
  const meshName = ctx.doc.getCurve(curveId)?.name ?? o.name;
  const meshId = ctx.doc.addMesh(meshName, mesh);
  let id = o.id;
  if (keepOriginal) {
    const { id: _i, name, ...rest } = o;
    id = ctx.doc.addObject({ ...rest, type: 'MESH', name, data: meshId, modifiers: [] });
  } else {
    ctx.doc.updateObject(o.id, { type: 'MESH', data: meshId, modifiers: [] });
    dropOrphanCurve(ctx, curveId);
  }
  return { object: id, name: ctx.doc.getObject(id)!.name, type: 'MESH' };
}

// ------------------------------------------------------------------ operators

export function registerCurveOperators(reg: OperatorRegistry): void {
  const primitive = (
    id: string,
    label: string,
    description: string,
    defaultName: string,
    make: (radius: number) => Spline,
    extra: Partial<CurveData> = {},
  ) =>
    reg.register(
      defineOperator({
        id,
        label,
        description,
        category: 'Add',
        redoable: true,
        schema: z.object({
          radius: z.number().positive().default(1).describe('Size of the primitive in metres (default 1)'),
          ...placement,
          ...curveFields,
        }),
        poll: pollAdd,
        execute(ctx, p) {
          const { radius, location, rotation, scale, name, ...fields } = p;
          const data = { ...extra, ...curvePatch(ctx, null, fields), splines: [make(radius)] };
          const r = addCurveObject(ctx, 'CURVE', name ?? defaultName, data, { location, rotation, scale });
          return { ...r, splines: 1, points: data.splines[0].points.length };
        },
      }),
    );

  primitive(
    'curve.primitive_bezier_curve_add',
    'Bezier Curve',
    "Add a Bezier curve object (Blender's default S-shaped curve: two points at x = ±radius with ALIGNED handles). " +
      'Returns {object, name, curve}. Give bevel_depth/extrude to make it a tube or ribbon.',
    'BezierCurve',
    (r) =>
      defaultSpline('BEZIER', [
        scaledPoint([-1, 0, 0], r, {
          handle_left: [-1.5 * r, -0.5 * r, 0],
          handle_right: [-0.5 * r, 0.5 * r, 0],
          handle_left_type: 'ALIGNED',
          handle_right_type: 'ALIGNED',
        }),
        scaledPoint([1, 0, 0], r, {
          handle_left: [0, 0, 0],
          handle_right: [2 * r, 0, 0],
          handle_left_type: 'ALIGNED',
          handle_right_type: 'ALIGNED',
        }),
      ]),
  );
  primitive(
    'curve.primitive_bezier_circle_add',
    'Bezier Circle',
    'Add a Bezier circle of the given radius in the local XY plane (4 points with AUTO handles, closed). ' +
      'Set dimensions "2D" to fill it, bevel_depth for a torus-like tube. Returns {object, name, curve}.',
    'BezierCircle',
    (r) => {
      const s = defaultSpline('BEZIER', [
        scaledPoint([-1, 0, 0], r),
        scaledPoint([0, 1, 0], r),
        scaledPoint([1, 0, 0], r),
        scaledPoint([0, -1, 0], r),
      ]);
      s.use_cyclic_u = true;
      return s;
    },
  );
  primitive(
    'curve.primitive_nurbs_curve_add',
    'Nurbs Curve',
    'Add a NURBS curve (4 control points forming an arch, order 4, not touching its end points). Returns {object, name, curve}.',
    'NurbsCurve',
    (r) => {
      const s = defaultSpline('NURBS', [
        scaledPoint([-1.5, 0, 0], r),
        scaledPoint([-1, 1, 0], r),
        scaledPoint([1, 1, 0], r),
        scaledPoint([1.5, 0, 0], r),
      ]);
      s.order_u = 4;
      s.use_endpoint_u = false;
      return s;
    },
  );
  primitive(
    'curve.primitive_nurbs_circle_add',
    'Nurbs Circle',
    'Add a closed NURBS circle (8 control points on a square, corner weights √½) of the given radius. Returns {object, name, curve}.',
    'NurbsCircle',
    (r) => {
      const square: [number, number][] = [
        [0, -1],
        [-1, -1],
        [-1, 0],
        [-1, 1],
        [0, 1],
        [1, 1],
        [1, 0],
        [1, -1],
      ];
      const s = defaultSpline(
        'NURBS',
        square.map(([x, y], i) => scaledPoint([x, y, 0], r, { weight: i % 2 ? Math.SQRT1_2 : 1 })),
      );
      s.use_cyclic_u = true;
      s.order_u = 4;
      return s;
    },
  );
  primitive(
    'curve.primitive_nurbs_path_add',
    'Path',
    'Add a NURBS path (5 points along X from −2×radius to +2×radius, order 5, endpoint), the usual target of ' +
      'Follow Path constraints and Curve modifiers. Returns {object, name, curve}.',
    'NurbsPath',
    (r) => {
      const s = defaultSpline(
        'NURBS',
        [-2, -1, 0, 1, 2].map((x) => scaledPoint([x, 0, 0], r)),
      );
      s.order_u = 5;
      s.use_endpoint_u = true;
      return s;
    },
    { use_path: true, dimensions: '3D' },
  );

  const fromPoints = (id: string, label: string, description: string, fixedType?: SplineType) =>
    reg.register(
      defineOperator({
        id,
        label,
        description,
        category: 'Add',
        redoable: true,
        schema: z.object({
          points: z.array(pointInput).min(1).describe(pointsDescription),
          ...(fixedType ? {} : { type: splineOptions.type }),
          cyclic: splineOptions.cyclic,
          handle_type: splineOptions.handle_type,
          order_u: splineOptions.order_u,
          use_endpoint_u: splineOptions.use_endpoint_u,
          use_smooth: splineOptions.use_smooth,
          ...placement,
          ...curveFields,
        }),
        poll: pollAdd,
        execute(ctx, p: Record<string, any>) {
          const {
            points,
            type,
            cyclic,
            handle_type,
            order_u,
            use_endpoint_u,
            use_smooth,
            location,
            rotation,
            scale,
            name,
            ...fields
          } = p;
          const st: SplineType = fixedType ?? type;
          const spline = buildSpline(points, {
            type: st,
            cyclic,
            handle_type,
            order_u,
            use_endpoint_u,
            use_smooth,
            material_index: 0,
          });
          const data = { ...curvePatch(ctx, null, fields as CurveFieldParams), splines: [spline] };
          const r = addCurveObject(ctx, 'CURVE', name ?? 'Curve', data, { location, rotation, scale });
          return { ...r, splines: 1, points: spline.points.length, type: st };
        },
      }),
    );
  fromPoints(
    'curve.add_from_points',
    'Curve From Points',
    'Create a curve object from a list of points (agent-friendly). type POLY (straight segments, default), BEZIER ' +
      '(smooth curve through the points) or NURBS; cyclic closes it. Curve fields (bevel_depth, extrude, ' +
      'dimensions, fill_mode, …) can be set directly. Points are in object space; the object is placed at ' +
      '`location` (default: the 3D cursor). Returns {object, name, curve, points}.',
  );
  fromPoints(
    'curve.primitive_poly_add',
    'Poly Curve',
    'Create a POLY curve (straight segments) through the given points — curve.add_from_points with type POLY. ' +
      'Returns {object, name, curve, points}.',
    'POLY',
  );

  reg.register(
    defineOperator({
      id: 'curve.spline_add',
      label: 'Add Spline',
      description:
        'Append a new spline (POLY/BEZIER/NURBS, open or cyclic) to an existing curve object. For 2D curves, closed ' +
        'splines inside other closed splines become holes of the fill. Returns {spline_index, spline_count}.',
      category: 'Curve',
      schema: z.object({
        object: objectRef,
        points: z.array(pointInput).min(1).describe(pointsDescription),
        ...splineOptions,
        resolution_u: z
          .number()
          .int()
          .min(0)
          .max(1024)
          .default(0)
          .describe('Per-spline resolution (0 = the curve resolution)'),
      }),
      execute(ctx, p) {
        const { curve } = curveTarget(ctx, p.object, ['CURVE']);
        const spline = buildSpline(p.points, p);
        const splines = [...(Array.isArray(curve.splines) ? curve.splines : []), spline];
        ctx.doc.updateCurve(curve.id, { splines });
        return { spline_index: splines.length - 1, spline_count: splines.length };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'curve.spline_set_points',
      label: 'Set Spline Points',
      description:
        "Replace the points of one spline of a curve object (co, handles, radius, tilt, weight), optionally changing the spline's type, " +
        'cyclic flag and other settings. Use it to reshape curves precisely. Returns {spline_index, point_count}.',
      category: 'Curve',
      schema: z.object({
        object: objectRef,
        spline_index: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe('Index of the spline to change (default 0)'),
        points: z.array(pointInput).min(1).describe(pointsDescription),
        ...splineOverrides,
      }),
      execute(ctx, p) {
        const { curve } = curveTarget(ctx, p.object, ['CURVE']);
        const i = splineIndexOf(curve, p.spline_index);
        const old = sanitizeSpline(curve.splines[i]);
        const spline = buildSpline(p.points, {
          type: p.type ?? old.type,
          cyclic: p.cyclic ?? old.use_cyclic_u,
          handle_type: p.handle_type ?? 'AUTO',
          order_u: p.order_u ?? old.order_u,
          use_endpoint_u: p.use_endpoint_u ?? old.use_endpoint_u,
          use_smooth: p.use_smooth ?? old.use_smooth,
          material_index: p.material_index ?? old.material_index,
          resolution_u: p.resolution_u ?? old.resolution_u,
        });
        const splines = curve.splines.slice();
        splines[i] = spline;
        ctx.doc.updateCurve(curve.id, { splines });
        return { spline_index: i, point_count: spline.points.length };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'curve.spline_remove',
      label: 'Remove Spline',
      description: 'Remove one spline (by index) from a curve object. Returns {spline_count}.',
      category: 'Curve',
      schema: z.object({
        object: objectRef,
        spline_index: z.number().int().min(0).describe('Index of the spline to remove'),
      }),
      execute(ctx, p) {
        const { curve } = curveTarget(ctx, p.object, ['CURVE']);
        const i = splineIndexOf(curve, p.spline_index);
        const splines = curve.splines.filter((_, k) => k !== i);
        ctx.doc.updateCurve(curve.id, { splines });
        return { spline_count: splines.length };
      },
    }),
  );

  const splineEdit = (
    id: string,
    label: string,
    description: string,
    shape: z.ZodRawShape,
    edit: (s: Spline, p: Record<string, any>) => Spline,
  ) =>
    reg.register(
      defineOperator({
        id,
        label,
        description,
        category: 'Curve',
        schema: z.object({
          object: objectRef,
          spline_index: z.number().int().min(-1).default(-1).describe('Spline to change (-1 = every spline)'),
          ...shape,
        }),
        execute(ctx, p: Record<string, any>) {
          const { curve } = curveTarget(ctx, p.object, ['CURVE']);
          const all = p.spline_index === -1;
          if (!all) splineIndexOf(curve, p.spline_index);
          const splines = curve.splines.map((s, k) =>
            all || k === p.spline_index ? edit(sanitizeSpline(s), p) : s,
          );
          ctx.doc.updateCurve(curve.id, { splines });
          return { changed: all ? splines.length : 1 };
        },
      }),
    );
  splineEdit(
    'curve.switch_direction',
    'Switch Direction',
    'Reverse the direction of splines (point order and handles swapped); affects bevel_factor, tilt direction and ' +
      'paths. Returns {changed}.',
    {},
    (s) => ({
      ...s,
      points: s.points
        .slice()
        .reverse()
        .map((pt) => ({
          ...pt,
          handle_left: pt.handle_right,
          handle_right: pt.handle_left,
          handle_left_type: pt.handle_right_type,
          handle_right_type: pt.handle_left_type,
        })),
    }),
  );
  splineEdit(
    'curve.cyclic_toggle',
    'Toggle Cyclic',
    'Open or close splines. With `cyclic` omitted the state is toggled. Returns {changed}.',
    { cyclic: z.boolean().optional().describe('true = close, false = open (default: toggle)') },
    (s, p) => ({ ...s, use_cyclic_u: p.cyclic ?? !s.use_cyclic_u }),
  );
  splineEdit(
    'curve.handle_type_set',
    'Set Handle Type',
    'Set the handle type of the points of BEZIER splines (AUTO smooth, VECTOR corner, ALIGNED/FREE use the stored ' +
      'handles; missing stored handles fall back to AUTO). `points` limits it to some point indices. Returns {changed}.',
    {
      type: handleType.describe('New handle type for both sides'),
      points: z.array(z.number().int().min(0)).optional().describe('Point indices to change (default: all)'),
    },
    (s, p) => ({
      ...s,
      points: s.points.map((pt, i) =>
        !p.points || p.points.includes(i)
          ? { ...pt, handle_left_type: p.type, handle_right_type: p.type }
          : pt,
      ),
    }),
  );

  reg.register(
    defineOperator({
      id: 'curve.properties_set',
      label: 'Set Curve Properties',
      description:
        'Set geometry properties of a curve or text object (bevel_depth, bevel_resolution, bevel_mode/bevel_object, ' +
        'bevel_factor_start/end, extrude, offset, fill_mode, use_fill_caps, twist_mode, dimensions, resolution_u, ' +
        'path settings). Only the given fields change. Animated fields are re-keyed at the current frame. ' +
        'Returns the new values.',
      category: 'Curve',
      schema: z.object({ object: objectRef, ...curveFields }),
      execute(ctx, p) {
        const { object, ...fields } = p;
        const { object: o, curve } = curveTarget(ctx, object);
        const patch = curvePatch(ctx, o.id, fields as CurveFieldParams);
        if (Object.keys(patch).length === 0) throw new OperatorError('No properties given', 'INVALID_PARAMS');
        ctx.doc.updateCurve(curve.id, patch);
        rekeyCurve(ctx, curve.id, patch);
        const now = ctx.doc.getCurve(curve.id)!;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(patch)) out[k] = (now as unknown as Record<string, unknown>)[k];
        return out;
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'curve.keyframe_insert',
      label: 'Insert Curve Keyframe',
      description:
        "Insert a keyframe on an animatable property of a curve or text object's data: bevel_depth, " +
        'bevel_factor_start, bevel_factor_end, extrude, offset, eval_time, size, space_line, space_word, ' +
        'space_character, shear, offset_x, offset_y, or a spline point channel such as "splines[0].points[2].co", ' +
        '"splines[0].points[2].radius" or ".tilt". The F-curve key is "curve:<curve id>:<path>:<index>" (use it with ' +
        'anim.keyframes_move / anim.keyframes_remove). Returns {inserted, curve, fcurves}.',
      category: 'Animation',
      schema: z.object({
        object: objectRef,
        path: z
          .string()
          .min(1)
          .describe('Data path of the property, e.g. "bevel_factor_end" or "splines[0].points[1].co"'),
        index: z
          .number()
          .int()
          .min(-1)
          .default(-1)
          .describe('Channel of vector properties (0 = x, 1 = y, 2 = z); -1 keys all'),
        frame: z.number().optional().describe('Frame to key (default: the current frame)'),
        value: z.number().optional().describe('Value to key (default: the current value of the property)'),
        interpolation: z
          .enum(['CONSTANT', 'LINEAR', 'BEZIER'])
          .default('BEZIER')
          .describe('Interpolation from this keyframe to the next'),
      }),
      execute(ctx, p) {
        const { curve } = curveTarget(ctx, p.object);
        const frame = p.frame ?? ctx.state.frame;
        const inserted = keyProperty(ctx, 'curve', curve.id, p.path, frame, {
          index: p.index,
          value: p.value,
          interpolation: p.interpolation,
        });
        const fcurves = ctx.doc
          .listFCurves(curve.id)
          .filter((fc) => fc.target_type === 'curve' && fc.path === p.path)
          .map((fc) => fcurveKey(fc));
        return { inserted, curve: curve.id, fcurves };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.text_add',
      label: 'Text',
      description:
        'Add a text object (Blender FONT) using the built-in geometric sans-serif font. The text lies in the local XY ' +
        'plane facing +Z with its first baseline at the origin (TOP_BASELINE). size = em height in metres (capitals ' +
        'are 0.7 × size); extrude gives thickness (total 2 × extrude), bevel_depth rounds the edges. Supports printable ' +
        'ASCII and Latin-1 letters; "\\n" starts a new line. Returns {object, name, curve, lines, width, height, bounds}.',
      category: 'Add',
      redoable: true,
      schema: z.object({
        body: z.string().default('Text').describe('Text content ("\\n" for new lines)'),
        size: z.number().positive().default(1).describe('Font size: one em in metres (default 1)'),
        align_x: z
          .enum(['LEFT', 'CENTER', 'RIGHT', 'JUSTIFY', 'FLUSH'])
          .default('LEFT')
          .describe('Horizontal alignment around the object origin (default LEFT)'),
        align_y: z
          .enum(['TOP_BASELINE', 'TOP', 'CENTER', 'BOTTOM', 'BOTTOM_BASELINE'])
          .default('TOP_BASELINE')
          .describe('Vertical alignment (default TOP_BASELINE: first baseline at the origin)'),
        extrude: z
          .number()
          .min(0)
          .default(0)
          .describe('Half thickness of the letters in metres (default 0 = flat)'),
        bevel_depth: z.number().min(0).default(0).describe('Rounded edge radius in metres (default 0)'),
        bevel_resolution: z.number().int().min(0).max(32).default(4).describe('Bevel smoothness (default 4)'),
        offset: z.number().default(0).describe('Make letters bolder (> 0) or thinner (< 0), metres'),
        fill_mode: z
          .enum(['BOTH', 'FRONT', 'BACK', 'NONE'])
          .default('BOTH')
          .describe('Cap faces: BOTH (default), FRONT, BACK or NONE (outlines only)'),
        space_line: textFields.space_line,
        space_word: textFields.space_word,
        space_character: textFields.space_character,
        shear: textFields.shear,
        offset_x: textFields.offset_x,
        offset_y: textFields.offset_y,
        resolution_u: z
          .number()
          .int()
          .min(1)
          .max(64)
          .default(12)
          .describe('Smoothness of the letter curves (default 12)'),
        ...placement,
      }),
      poll: pollAdd,
      execute(ctx, p) {
        const { location, rotation, scale, name, ...rest } = p;
        const data: Partial<CurveData> = { ...textPatch(rest), dimensions: '2D' };
        for (const k of [
          'align_x',
          'align_y',
          'extrude',
          'bevel_depth',
          'bevel_resolution',
          'offset',
          'fill_mode',
          'resolution_u',
        ] as const)
          (data as Record<string, unknown>)[k] = rest[k];
        const r = addCurveObject(ctx, 'FONT', name ?? 'Text', data, { location, rotation, scale });
        const layout = layoutText(ctx.doc.getCurve(r.curve)!);
        const b = layout.bounds;
        return {
          ...r,
          lines: layout.lineCount,
          width: b.max[0] - b.min[0],
          height: b.max[1] - b.min[1],
          bounds: { min: b.min, max: b.max },
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'font.text_set',
      label: 'Set Text',
      description:
        'Change the text (body) and/or text layout properties (size, spacing, shear, alignment, offsets) of a text ' +
        'object. Geometry (extrude, bevel, fill) is set with curve.properties_set. Returns {body, lines, width, height, bounds}.',
      category: 'Text',
      schema: z.object({
        object: objectRef,
        body: z.string().optional().describe('New text content ("\\n" for new lines)'),
        append: z
          .boolean()
          .default(false)
          .describe('Append `body` to the current text instead of replacing it'),
        ...textFields,
      }),
      execute(ctx, p) {
        const { object, append, ...fields } = p;
        const { curve } = curveTarget(ctx, object, ['FONT']);
        const patch = textPatch(fields);
        if (append && fields.body !== undefined) patch.body = (curve.body ?? '') + fields.body;
        if (Object.keys(patch).length === 0) throw new OperatorError('Nothing to change', 'INVALID_PARAMS');
        ctx.doc.updateCurve(curve.id, patch);
        rekeyCurve(ctx, curve.id, patch);
        const now = ctx.doc.getCurve(curve.id)!;
        const layout = layoutText(now);
        const b = layout.bounds;
        return {
          body: now.body,
          lines: layout.lineCount,
          width: b.max[0] - b.min[0],
          height: b.max[1] - b.min[1],
          bounds: { min: b.min, max: b.max },
        };
      },
    }),
  );
}
