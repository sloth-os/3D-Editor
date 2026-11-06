import { z } from 'zod';
import type { Vec3, Vec4 } from '../math/types';
import type {
  MaterialData,
  MaterialTextureChannel,
  ProceduralTexture,
  ProceduralType,
  TextureSlot,
  WorldSettings,
} from '../doc/types';
import { defaultProcedural } from '../material/procedural';
import {
  PROCEDURAL_COMMON_PARAMS,
  PROCEDURAL_MAPPINGS,
  PROCEDURAL_TYPE_DOCS,
  PROCEDURAL_TYPES,
  describeProceduralParam,
  describeProceduralParams,
  validateProceduralParams,
} from '../material/procedural-params';
import { MATERIAL_PRESETS, getMaterialPreset, presetMaterialValues } from '../material/presets';
import { MATERIAL_TEXTURE_CHANNELS, channelProcedural } from '../material/surface';
import { skySun } from '../render/sky';
import { defineOperator, type OperatorRegistry } from './registry';
import { OperatorError, type OperatorContext } from './context';
import { activeObject, resolveObjectIds, vec3, vec4 } from './helpers';

/*
 * Operators for material presets, procedural textures and the world sky/mist
 * (material.preset_list, material.preset_apply, material.procedural_set, world.sky_set,
 * world.mist_set). All colours are linear RGB(A), angles radians, distances metres.
 */

const PRESET_IDS = MATERIAL_PRESETS.map((p) => p.id) as [string, ...string[]];
const PRESET_CATEGORIES = [...new Set(MATERIAL_PRESETS.map((p) => p.category))] as [string, ...string[]];
/** Object types that render materials. */
const MATERIAL_OBJECT_TYPES = new Set(['MESH', 'CURVE', 'FONT']);

const color = z.union([vec3, vec4]);

function rgba(c: readonly number[]): Vec4 {
  return [c[0], c[1], c[2], c.length > 3 ? c[3] : 1];
}

function resolveMaterial(ctx: OperatorContext, ref: string): string {
  if (ctx.doc.getMaterial(ref)) return ref;
  const m = ctx.doc.listMaterials().find((x) => x.name === ref);
  if (!m) throw new OperatorError(`Material '${ref}' not found`, 'NOT_FOUND');
  return m.id;
}

/** Puts `material` into slot `slot` of an object (slots are added as needed). */
function assignSlot(ctx: OperatorContext, objectId: string, slot: number, material: string): void {
  const o = ctx.doc.getObject(objectId)!;
  const slots = [...o.material_slots];
  while (slots.length <= slot) slots.push(null);
  slots[slot] = material;
  ctx.doc.updateObject(objectId, { material_slots: slots });
}

/** Material-capable target objects (ids); others are skipped with a warning. */
function materialTargets(ctx: OperatorContext, refs: string[] | undefined): string[] {
  const out: string[] = [];
  for (const id of resolveObjectIds(ctx, refs)) {
    const o = ctx.doc.getObject(id)!;
    if (MATERIAL_OBJECT_TYPES.has(o.type)) out.push(id);
    else ctx.report('WARNING', `Object '${o.name}' (${o.type}) cannot have materials; skipped`);
  }
  return out;
}

function materialRef(ctx: OperatorContext, id: string): { id: string; name: string } {
  return { id, name: ctx.doc.getMaterial(id)?.name ?? '' };
}

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

/**
 * Warns about objects using `materialIds` whose world scale is not 1: OBJECT-mapped procedural
 * textures are sized in object space before the object's scale (like Blender), so their pattern is
 * stretched by that scale.
 */
function warnScaledUsers(ctx: OperatorContext, materialIds: readonly string[], what: string): void {
  if (!materialIds.length) return;
  const ids = new Set(materialIds);
  for (const o of ctx.doc.listObjects()) {
    if (!o.material_slots.some((s) => s !== null && ids.has(s))) continue;
    const m = ctx.doc.worldMatrix(o.id);
    const s = [Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])];
    if (s.every((v) => Math.abs(v - 1) <= 1e-3)) continue;
    ctx.report(
      'WARNING',
      `Object '${o.name}' is scaled by (${s.map(fmt).join(', ')}): ${what} use OBJECT mapping, which is sized in object space before the object's scale, so the pattern is stretched by that scale. Apply the scale (object.transform_apply with scale=true) for true metric sizes.`,
    );
  }
}

// ---------------------------------------------------------------- procedural texture input

const proceduralParamsDoc = PROCEDURAL_TYPES.map((t) => `${t}: ${describeProceduralParams(t)}`).join('.\n');
const commonParamsDoc = PROCEDURAL_COMMON_PARAMS.map(describeProceduralParam).join('; ');

/**
 * Per-type defaults of a shared field, generated from the type defaults: the most common value and
 * the exceptions, e.g. "5 (GRADIENT 1, MARBLE 2, WOOD 8)".
 */
function typeDefaultsDoc(field: 'scale' | 'detail' | 'roughness' | 'distortion'): string {
  const values = PROCEDURAL_TYPES.map((t) => [t, defaultProcedural(t)[field]] as const);
  const counts = new Map<number, number>();
  for (const [, v] of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const exceptions = values.filter(([, v]) => v !== common).map(([t, v]) => `${t} ${v}`);
  return exceptions.length ? `${common} (${exceptions.join(', ')})` : `${common}`;
}

const proceduralInput = z.object({
  type: z
    .enum(PROCEDURAL_TYPES as [ProceduralType, ...ProceduralType[]])
    .optional()
    .describe(
      `Texture type (default: the channel's current type, else NOISE). ${PROCEDURAL_TYPES.map(
        (t) => `${t}: ${PROCEDURAL_TYPE_DOCS[t]}`,
      ).join('. ')}.`,
    ),
  mapping: z
    .enum(PROCEDURAL_MAPPINGS as ['GENERATED', 'OBJECT', 'UV'])
    .optional()
    .describe(
      "Texture coordinates (default GENERATED): GENERATED = undeformed position normalised to the object's base-mesh bounding box (0..1 per axis; the pattern stretches with the object's proportions and sticks to the surface under deformation); OBJECT = object-space (local) position in metres before the object's scale, as in Blender: a scaled object stretches the pattern by its scale, so apply the scale (object.transform_apply scale=true) for true metric sizes; UV = the mesh UV map (u, v, 0).",
    ),
  scale: z
    .number()
    .min(-1e6)
    .max(1e6)
    .optional()
    .describe(
      `Coordinate multiplier: pattern repetitions per coordinate unit (per metre of object space for OBJECT, per bounding box for GENERATED, per UV unit for UV). Type defaults: ${typeDefaultsDoc('scale')}.`,
    ),
  detail: z
    .number()
    .min(0)
    .max(15)
    .optional()
    .describe(
      `Noise octaves 0..15 (NOISE; WAVE, MARBLE and WOOD distortion noise; fractional values blend in one more octave) or MAGIC depth 0..10; unused by VORONOI, CHECKER, GRADIENT and BRICK. Type defaults: ${typeDefaultsDoc('detail')}.`,
    ),
  roughness: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      `Amplitude falloff between noise octaves 0..1 (higher = grainier; same users as detail). Type defaults: ${typeDefaultsDoc('roughness')}.`,
    ),
  distortion: z
    .number()
    .min(-1000)
    .max(1000)
    .optional()
    .describe(
      `Domain warp (NOISE, VORONOI), noise distortion amount (WAVE, MARBLE turbulence, WOOD ring wobble) or folding (MAGIC); unused by CHECKER, GRADIENT and BRICK. Type defaults: ${typeDefaultsDoc('distortion')}.`,
    ),
  color_a: color
    .optional()
    .describe(
      'Linear RGB(A) colour at ramp factor 0 (ramp_low). Scalar channels (roughness, metallic, alpha, bump height) use the red component.',
    ),
  color_b: color.optional().describe('Linear RGB(A) colour at ramp factor 1 (ramp_high).'),
  ramp_low: z
    .number()
    .min(-1e3)
    .max(1e3)
    .optional()
    .describe(
      'Colour ramp stop of color_a: texture factor at which the colour is exactly color_a (default 0). Factors beyond the stops keep the nearest stop colour; ramp_low > ramp_high inverts the ramp.',
    ),
  ramp_high: z
    .number()
    .min(-1e3)
    .max(1e3)
    .optional()
    .describe(
      'Colour ramp stop of color_b: texture factor at which the colour is exactly color_b (default 1).',
    ),
  seed: z
    .number()
    .int()
    .optional()
    .describe('Integer random seed (default 0): different seeds give different patterns.'),
  params: z
    .record(z.string(), z.union([z.number(), z.string(), z.null()]))
    .optional()
    .describe(
      `Type-specific options as { key: value }, merged into the existing ones (a null value removes a key; unknown keys, wrong kinds and out-of-range values are rejected). "Scaled texture units" = texture coordinate × scale.\n${proceduralParamsDoc}.\nAll types: ${commonParamsDoc}.`,
    ),
});

type ProceduralInput = z.infer<typeof proceduralInput>;

/** Shared (type-independent) params kept when the texture type changes. */
const COMMON_KEYS = new Set(PROCEDURAL_COMMON_PARAMS.map((p) => p.key));

function buildProcedural(
  existing: ProceduralTexture | null,
  input: ProceduralInput,
  replace: boolean,
): ProceduralTexture {
  const type = input.type ?? existing?.type ?? 'NOISE';
  let base: ProceduralTexture;
  if (replace || !existing) base = defaultProcedural(type);
  else if (existing.type === type) base = { ...existing, params: { ...(existing.params ?? {}) } };
  else {
    // new type: keep colours, mapping, ramp, seed and common params; type defaults for the rest
    const params: Record<string, number | string> = {};
    for (const [k, v] of Object.entries(existing.params ?? {})) if (COMMON_KEYS.has(k)) params[k] = v;
    base = defaultProcedural(type, {
      mapping: existing.mapping,
      color_a: existing.color_a,
      color_b: existing.color_b,
      ramp_low: existing.ramp_low,
      ramp_high: existing.ramp_high,
      seed: existing.seed,
      params,
    });
  }
  const out: ProceduralTexture = { ...base, type };
  if (input.mapping !== undefined) out.mapping = input.mapping;
  if (input.scale !== undefined) out.scale = input.scale;
  if (input.detail !== undefined) out.detail = input.detail;
  if (input.roughness !== undefined) out.roughness = input.roughness;
  if (input.distortion !== undefined) out.distortion = input.distortion;
  if (input.color_a !== undefined) out.color_a = rgba(input.color_a);
  if (input.color_b !== undefined) out.color_b = rgba(input.color_b);
  if (input.ramp_low !== undefined) out.ramp_low = input.ramp_low;
  if (input.ramp_high !== undefined) out.ramp_high = input.ramp_high;
  if (input.seed !== undefined) out.seed = input.seed;
  const params: Record<string, number | string> = { ...(base.params ?? {}) };
  for (const [k, v] of Object.entries(input.params ?? {})) {
    if (v === null) delete params[k];
    else params[k] = v;
  }
  const problems = validateProceduralParams(type, params);
  if (problems.length)
    throw new OperatorError(`Invalid procedural params: ${problems.join('; ')}`, 'INVALID_PARAMS');
  out.params = params;
  return out;
}

// ---------------------------------------------------------------- sky presets

type SkyPatch = Partial<
  Pick<
    WorldSettings,
    | 'sky_zenith_color'
    | 'sky_horizon_color'
    | 'sky_ground_color'
    | 'sun_elevation'
    | 'sun_intensity'
    | 'sun_size'
    | 'sun_color'
  >
>;

const deg = (d: number) => (d * Math.PI) / 180;

/** Ready-made skies (applied before the explicit values of world.sky_set). */
const SKY_PRESETS: Record<string, SkyPatch> = {
  NOON: {
    sun_elevation: deg(70),
    sun_intensity: 3.5,
    sky_zenith_color: [0.1, 0.26, 0.66],
    sky_horizon_color: [0.6, 0.73, 0.9],
    sky_ground_color: [0.2, 0.18, 0.15],
    sun_color: [1, 0.97, 0.92],
    sun_size: deg(0.545),
  },
  CLEAR_DAY: {
    sun_elevation: deg(35),
    sun_intensity: 3,
    sky_zenith_color: [0.12, 0.28, 0.65],
    sky_horizon_color: [0.62, 0.74, 0.88],
    sky_ground_color: [0.18, 0.16, 0.14],
    sun_color: [1, 0.95, 0.88],
    sun_size: deg(0.545),
  },
  MORNING: {
    sun_elevation: deg(12),
    sun_intensity: 3,
    sky_zenith_color: [0.14, 0.27, 0.6],
    sky_horizon_color: [0.75, 0.74, 0.78],
    sky_ground_color: [0.17, 0.15, 0.13],
    sun_color: [1, 0.93, 0.82],
    sun_size: deg(0.545),
  },
  SUNSET: {
    sun_elevation: deg(2),
    sun_intensity: 3,
    sky_zenith_color: [0.12, 0.22, 0.55],
    sky_horizon_color: [0.85, 0.62, 0.5],
    sky_ground_color: [0.15, 0.12, 0.1],
    sun_color: [1, 0.9, 0.75],
    sun_size: deg(0.6),
  },
  DUSK: {
    sun_elevation: deg(-4),
    sun_intensity: 3,
    sky_zenith_color: [0.1, 0.16, 0.45],
    sky_horizon_color: [0.75, 0.55, 0.55],
    sky_ground_color: [0.1, 0.09, 0.09],
    sun_color: [1, 0.85, 0.7],
    sun_size: deg(0.6),
  },
  NIGHT: {
    sun_elevation: deg(-25),
    sun_intensity: 0,
    sky_zenith_color: [0.1, 0.16, 0.4],
    sky_horizon_color: [0.3, 0.35, 0.5],
    sky_ground_color: [0.08, 0.08, 0.09],
    sun_color: [1, 1, 1],
    sun_size: deg(0.545),
  },
  OVERCAST: {
    sun_elevation: deg(50),
    sun_intensity: 0.4,
    sky_zenith_color: [0.55, 0.57, 0.6],
    sky_horizon_color: [0.75, 0.76, 0.78],
    sky_ground_color: [0.18, 0.17, 0.16],
    sun_color: [1, 1, 1],
    sun_size: deg(25),
  },
};
const SKY_PRESET_IDS = Object.keys(SKY_PRESETS) as [string, ...string[]];

/** Mist density (FogExp2) reaching 95 % at a view depth: 1 − exp(−(ρd)²) = 0.95. */
const MIST_95 = Math.sqrt(Math.log(20));

function skyState(world: WorldSettings) {
  const sun = skySun(world);
  return {
    environment: world.environment,
    show_environment_background: world.show_environment_background,
    strength: world.strength,
    environment_strength: world.environment_strength,
    sky_zenith_color: world.sky_zenith_color,
    sky_horizon_color: world.sky_horizon_color,
    sky_ground_color: world.sky_ground_color,
    sun_elevation: world.sun_elevation,
    sun_rotation: world.sun_rotation,
    sun_intensity: world.sun_intensity,
    sun_size: world.sun_size,
    sun_color: world.sun_color,
    sun_direction: sun.direction.map((v) => Math.round(v * 1e6) / 1e6),
    sun_irradiance: sun.irradiance.map((v) => Math.round(v * 1e4) / 1e4),
  };
}

// ---------------------------------------------------------------- registration

export function registerShadingOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'material.preset_list',
      label: 'List Material Presets',
      description:
        'List the built-in physically plausible material presets (metals, plastics, glass, water, ceramics, stone, wood, fabrics, emissive, ground, patterns). Returns { presets: [{ id, name, category, description, base_color, metallic, roughness, transmission, emission_strength, procedural_channels }], categories }. Apply one with material.preset_apply.',
      category: 'Material',
      undo: false,
      schema: z.object({
        category: z
          .enum(PRESET_CATEGORIES)
          .optional()
          .describe(`Only presets of this category (default: all). One of ${PRESET_CATEGORIES.join(', ')}.`),
      }),
      execute(_ctx, p) {
        const presets = MATERIAL_PRESETS.filter((x) => !p.category || x.category === p.category).map((x) => {
          const v = presetMaterialValues(x);
          return {
            id: x.id,
            name: x.name,
            category: x.category,
            description: x.description,
            base_color: v.base_color,
            metallic: v.metallic,
            roughness: v.roughness,
            transmission: v.transmission,
            emission_strength: v.emission_strength,
            procedural_channels: MATERIAL_TEXTURE_CHANNELS.filter((ch) => channelProcedural(v, ch)),
          };
        });
        return { presets, categories: PRESET_CATEGORIES };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'material.preset_apply',
      label: 'Apply Material Preset',
      description:
        "Apply a built-in material preset (ids from material.preset_list). Default: create ONE new material from the preset and put it into slot `slot` of every target object (objects by id or exact name; default: the selected objects; MESH, CURVE and FONT objects only). mode OVERWRITE instead rewrites the material already in that slot of each target; `material` rewrites an existing material in place. Overwriting resets every principled value and texture slot to the preset (the name is kept). Procedural presets use OBJECT mapping with real-world pattern sizes in metres of object space, i.e. before the object's scale (as in Blender): on a scaled object (e.g. a cube scaled to a wall) the pattern stretches with the scale, so apply the scale first (object.transform_apply scale=true); a WARNING is reported for every scaled user. Returns { preset, materials: [{ id, name }], objects: [ids] }.",
      category: 'Material',
      schema: z.object({
        preset: z.enum(PRESET_IDS).describe(`Preset id: ${PRESET_IDS.join(', ')}.`),
        objects: z
          .array(z.string())
          .optional()
          .describe(
            'Target objects (ids or exact names). Default: the selected objects; with `material` the default is none (only the material is overwritten).',
          ),
        material: z
          .string()
          .optional()
          .describe(
            'Existing material (id or exact name) to overwrite in place (all its users change); also assigned to `objects` when given.',
          ),
        mode: z
          .enum(['NEW', 'OVERWRITE'])
          .default('NEW')
          .describe(
            'NEW (default): one new material for all targets. OVERWRITE: rewrite the material in slot `slot` of each target (empty slots get a new material).',
          ),
        slot: z
          .number()
          .int()
          .min(0)
          .max(255)
          .default(0)
          .describe('Material slot index on the target objects (default 0; slots are added as needed).'),
        name: z
          .string()
          .min(1)
          .optional()
          .describe('Name of a newly created material (default: the preset name; made unique).'),
        base_color: color
          .optional()
          .describe(
            'Optional linear RGB(A) override of the preset base colour (a procedural base colour texture, if the preset has one, still takes precedence).',
          ),
      }),
      execute(ctx, p) {
        const preset = getMaterialPreset(p.preset);
        if (!preset) throw new OperatorError(`Unknown preset '${p.preset}'`, 'INVALID_PARAMS');
        const values = presetMaterialValues(preset);
        if (p.base_color) values.base_color = rgba(p.base_color);
        const materials: string[] = [];
        const targets = p.material && !p.objects?.length ? [] : materialTargets(ctx, p.objects);
        const overwrite = (id: string) => {
          if (materials.includes(id)) return;
          ctx.doc.updateMaterial(id, values as Partial<MaterialData>);
          materials.push(id);
        };
        let created: string | null = null;
        const create = () => {
          if (!created) {
            created = ctx.doc.addMaterial({ ...values, name: p.name ?? preset.name });
            materials.push(created);
          }
          return created;
        };
        if (p.material) {
          const id = resolveMaterial(ctx, p.material);
          overwrite(id);
          for (const o of targets) assignSlot(ctx, o, p.slot, id);
        } else if (p.mode === 'NEW') {
          const id = create();
          for (const o of targets) assignSlot(ctx, o, p.slot, id);
        } else {
          for (const o of targets) {
            const cur = ctx.doc.getObject(o)!.material_slots[p.slot];
            if (cur && ctx.doc.getMaterial(cur)) overwrite(cur);
            else assignSlot(ctx, o, p.slot, create());
          }
        }
        if (MATERIAL_TEXTURE_CHANNELS.some((ch) => channelProcedural(values, ch)?.mapping === 'OBJECT'))
          warnScaledUsers(ctx, materials, `the procedural textures of preset '${preset.id}'`);
        return {
          preset: preset.id,
          materials: materials.map((id) => materialRef(ctx, id)),
          objects: targets,
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'material.procedural_set',
      label: 'Set Procedural Texture',
      description:
        "Set (or clear) the procedural texture of a material channel. The texture's ramp colour drives the channel like a texture plugged into a Principled BSDF input: base_color RGB replaces the base colour (its alpha multiplies the alpha), emission RGB replaces the emission colour (only visible with material emission_strength > 0, which still scales it), metallic/roughness/alpha use the red component (alpha only has an effect when the material blend_method is CLIP or BLEND; set it with material.update), normal uses the red component as a bump height (× params.bump_distance m × material normal_strength). Given fields are merged into the channel's existing procedural texture (unless replace=true); changing the type keeps colours, mapping, ramp, seed and common params. An image texture in the same slot is kept but ignored while the procedural is set. Line and vein widths come from the colour ramp, not from the type options: for thin MARBLE veins set ramp_low 0, ramp_high ≈ 0.25 (0.2–0.3) and params.ramp_interpolation EASE (thin color_a veins on color_b stone; with the default 0..1 ramp marble looks like a soft, cloudy mix of both colours), and narrow the ramp the same way for thin WAVE or WOOD lines. WARNING reports flag settings without a visible effect (OPAQUE alpha, zero emission strength, OBJECT mapping on scaled objects). Evaluated identically by the viewport, the CPU renderers and the path tracer; glTF export bakes it to PNG. Returns { material: { id, name }, channel, procedural }.",
      category: 'Material',
      schema: z.object({
        material: z
          .string()
          .optional()
          .describe('Material id or exact name. Default: the material in slot `slot` of the active object.'),
        slot: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe('Slot of the active object used when `material` is omitted (default 0).'),
        channel: z
          .enum(MATERIAL_TEXTURE_CHANNELS as [MaterialTextureChannel, ...MaterialTextureChannel[]])
          .default('base_color')
          .describe(
            'Texture channel: base_color (default), metallic, roughness, normal (bump), emission or alpha.',
          ),
        procedural: proceduralInput
          .nullable()
          .describe(
            'Procedural texture fields to set, or null to remove the procedural texture from the channel (an image in the slot is kept).',
          ),
        replace: z
          .boolean()
          .default(false)
          .describe(
            "Start from the type defaults instead of merging with the channel's current procedural texture (default false).",
          ),
      }),
      execute(ctx, p) {
        let id: string;
        if (p.material) id = resolveMaterial(ctx, p.material);
        else {
          const o = activeObject(ctx);
          const ref = o?.material_slots[p.slot];
          if (!o) throw new OperatorError('No material given and no active object', 'INVALID_PARAMS');
          if (!ref || !ctx.doc.getMaterial(ref))
            throw new OperatorError(
              `Active object '${o.name}' has no material in slot ${p.slot}`,
              'NOT_FOUND',
            );
          id = ref;
        }
        const m = ctx.doc.getMaterial(id)!;
        const textures: MaterialData['textures'] = { ...(m.textures ?? {}) };
        const slot: TextureSlot | null = textures[p.channel] ?? null;
        const existing = channelProcedural(m, p.channel);
        if (p.procedural === null) {
          if (!existing) ctx.report('INFO', `Channel ${p.channel} has no procedural texture`);
          else if (slot?.image) textures[p.channel] = { ...slot, procedural: null };
          else delete textures[p.channel];
          ctx.doc.updateMaterial(id, { textures });
          return { material: materialRef(ctx, id), channel: p.channel, procedural: null };
        }
        const tex = buildProcedural(existing, p.procedural, p.replace);
        // an image in the slot is kept (the procedural takes precedence while it is set)
        textures[p.channel] = {
          image: slot?.image ?? '',
          scale: slot?.scale ?? [1, 1],
          offset: slot?.offset ?? [0, 0],
          procedural: tex,
        };
        ctx.doc.updateMaterial(id, { textures });
        // channels without a visible effect in the material's current setup
        if (p.channel === 'alpha' && m.blend_method !== 'CLIP' && m.blend_method !== 'BLEND')
          ctx.report(
            'WARNING',
            `Material '${m.name}' uses blend_method OPAQUE, which ignores alpha: the alpha texture has no visible effect until blend_method is CLIP (cut-outs at alpha_threshold) or BLEND (material.update)`,
          );
        if (p.channel === 'emission' && !(m.emission_strength > 0))
          ctx.report(
            'WARNING',
            `Material '${m.name}' has emission_strength 0: the emission texture has no visible effect until emission_strength > 0 (material.update)`,
          );
        if (tex.mapping === 'OBJECT' && existing?.mapping !== 'OBJECT')
          warnScaledUsers(ctx, [id], `procedural textures`);
        return { material: materialRef(ctx, id), channel: p.channel, procedural: tex };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'world.sky_set',
      label: 'Set Sky',
      description:
        "Use the analytic procedural sky as the world (environment SKY) and/or change it: optional preset (NOON, CLEAR_DAY, MORNING, SUNSET, DUSK, NIGHT, OVERCAST; presets keep sun_rotation) then explicit values. The sky lights the scene (sky ambient + its sun as a directional light of sun_intensity W/m², reddened near the horizon) and is the render background; sky radiance is scaled by world strength × environment_strength in every renderer. Sun direction (Blender's Sky Texture convention): elevation above the horizon, rotation = azimuth counter-clockwise from +Y seen from above (0 → sun towards +Y, π/2 → −X, π → −Y, 3π/2 → +X); the unit vector towards the sun is (−cos(e)·sin(r), cos(e)·cos(r), sin(e)). For front light on a scene seen from Blender's default camera (at −Y, +X) use rotation ≈ 3.9 (225°). Returns the sky settings with sun_direction (unit vector towards the sun) and sun_irradiance (W/m² per channel after extinction).",
      category: 'World',
      schema: z.object({
        preset: z
          .enum(SKY_PRESET_IDS)
          .optional()
          .describe(
            `Sky preset applied before the explicit values: ${SKY_PRESET_IDS.join(', ')} (default: none).`,
          ),
        zenith_color: vec3
          .optional()
          .describe(
            'Linear RGB sky colour straight up for a midday sun (default unchanged; doc default [0.12, 0.28, 0.65]).',
          ),
        horizon_color: vec3
          .optional()
          .describe(
            'Linear RGB sky colour at the horizon (default unchanged; doc default [0.62, 0.74, 0.88]).',
          ),
        ground_color: vec3
          .optional()
          .describe(
            'Linear RGB colour below the horizon (default unchanged; doc default [0.18, 0.16, 0.14]).',
          ),
        sun_elevation: z
          .number()
          .min(-Math.PI / 2)
          .max(Math.PI / 2)
          .optional()
          .describe(
            'Sun height above the horizon in radians, −π/2..π/2 (e.g. 0.61 = 35°; ≤ 0 = sunset/twilight/night; default unchanged).',
          ),
        sun_rotation: z
          .number()
          .min(-1000)
          .max(1000)
          .optional()
          .describe(
            "Sun azimuth in radians, counter-clockwise from +Y seen from above like Blender's Sky Texture (0 → sun towards +Y, π/2 → −X, π → −Y, 3π/2 → +X; default unchanged).",
          ),
        sun_intensity: z
          .number()
          .min(0)
          .max(1e5)
          .optional()
          .describe(
            'Sun irradiance in W/m² at normal incidence (like a SUN lamp energy; doc default 3; 0 = no sun).',
          ),
        sun_size: z
          .number()
          .min(0)
          .max(Math.PI / 2)
          .optional()
          .describe(
            'Angular diameter of the sun disc in radians, 0..π/2 (doc default 0.0095 = 0.545°; larger = softer shadows and a bigger disc).',
          ),
        sun_color: vec3
          .optional()
          .describe('Linear RGB sun colour before atmospheric reddening (default unchanged).'),
        strength: z
          .number()
          .min(0)
          .max(1e5)
          .optional()
          .describe('World strength multiplying the sky and its sun (default unchanged; doc default 1).'),
        show_background: z
          .boolean()
          .optional()
          .describe(
            'Show the sky as the render background (world show_environment_background). Default: true when this call switches the environment to SKY, otherwise unchanged.',
          ),
        enable: z
          .boolean()
          .default(true)
          .describe(
            'Set the world environment to SKY (default true); false only edits the stored sky values.',
          ),
      }),
      execute(ctx, p) {
        const before = ctx.doc.getWorld();
        const patch: Partial<WorldSettings> = { ...(p.preset ? SKY_PRESETS[p.preset] : {}) };
        const v3 = (c: readonly number[]): Vec3 => [c[0], c[1], c[2]];
        if (p.zenith_color) patch.sky_zenith_color = v3(p.zenith_color);
        if (p.horizon_color) patch.sky_horizon_color = v3(p.horizon_color);
        if (p.ground_color) patch.sky_ground_color = v3(p.ground_color);
        if (p.sun_elevation !== undefined) patch.sun_elevation = p.sun_elevation;
        if (p.sun_rotation !== undefined) patch.sun_rotation = p.sun_rotation;
        if (p.sun_intensity !== undefined) patch.sun_intensity = p.sun_intensity;
        if (p.sun_size !== undefined) patch.sun_size = p.sun_size;
        if (p.sun_color) patch.sun_color = v3(p.sun_color);
        if (p.strength !== undefined) patch.strength = p.strength;
        if (p.enable) patch.environment = 'SKY';
        if (p.show_background !== undefined) patch.show_environment_background = p.show_background;
        else if (p.enable && before.environment !== 'SKY') patch.show_environment_background = true;
        ctx.doc.updateWorld(patch);
        return skyState(ctx.doc.getWorld());
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'world.mist_set',
      label: 'Set Mist',
      description:
        "Set the world mist (distance fog) used by the viewport (Material Preview/Rendered), the CPU renderers and the path tracer: surfaces blend towards the mist colour by 1 − exp(−(density × view depth)²) (quadratic near the camera like Blender's default mist falloff, saturating smoothly; the background is not fogged). Give density, or distance (the depth in metres where the mist reaches 95 %). density 0 disables. Returns { mist_density, mist_color, distance_95 }.",
      category: 'World',
      schema: z.object({
        density: z
          .number()
          .min(0)
          .max(1000)
          .optional()
          .describe('Mist density in 1/m (0 = off; default unchanged; e.g. 0.02 → 95 % mist at ≈ 87 m).'),
        distance: z
          .number()
          .positive()
          .max(1e7)
          .optional()
          .describe(
            'Alternative to density: view depth in metres where the mist reaches 95 % (density = 1.731 / distance).',
          ),
        color: vec3
          .optional()
          .describe('Linear RGB mist colour (default unchanged; doc default [0.7, 0.75, 0.8]).'),
      }),
      execute(ctx, p) {
        if (p.density !== undefined && p.distance !== undefined)
          throw new OperatorError('Give either density or distance, not both', 'INVALID_PARAMS');
        const patch: Partial<WorldSettings> = {};
        if (p.density !== undefined) patch.mist_density = p.density;
        if (p.distance !== undefined) patch.mist_density = MIST_95 / p.distance;
        if (p.color) patch.mist_color = [p.color[0], p.color[1], p.color[2]];
        if (Object.keys(patch).length) ctx.doc.updateWorld(patch);
        const w = ctx.doc.getWorld();
        return {
          mist_density: w.mist_density,
          mist_color: w.mist_color,
          distance_95: w.mist_density > 0 ? MIST_95 / w.mist_density : null,
        };
      },
    }),
  );
}
