import { z } from 'zod';
import * as Y from 'yjs';
import type { Mat4, Vec3 } from '../math/types';
import { decompose4 } from '../math/mat4';
import type { CollectionData, ObjectData, ObjectType, ParticleSystemData } from '../doc/types';
import { ROOT_COLLECTION_ID } from '../doc/types';
import { defaultObject } from '../doc/defaults';
import type { SceneDoc } from '../doc/scene-doc';
import { SceneEvaluator } from '../eval/evaluate';
import { expandInstances } from '../instancing/expand';
import {
  DEFAULT_PARTICLE_SYSTEM_NAME,
  MAX_INSTANCES,
  PARTICLE_SETTING_NAMES,
  ParticleSettingsPatchSchema,
  ParticleSettingsSchema,
  normalizeParticleSettings,
  type ParticleSettings,
  type ParticleSettingsPatch,
} from '../instancing/settings';
import {
  collectionContainsObject,
  collectionMembers,
  wouldCreateInstanceCycle,
} from '../instancing/collections';
import { invertAffine, mulAffine } from '../instancing/matrix';
import type { EvaluatedInstance } from '../instancing/types';
import { newId } from '../util/id';
import { uniqueName } from '../util/names';
import { cloneJson } from '../util/json';
import type { OperatorContext } from './context';
import { OperatorError } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { activeObject, pollObjectMode, resolveObjectIds, setSelection, vec3 } from './helpers';

/*
 * Operators for collection instances and particle systems (scatters):
 *
 *   object.collection_instance_add   empty instancing a collection (Blender Add > Collection Instance)
 *   object.instance_collection_set   set/clear the collection an empty instances
 *   object.particle_system_add       particle system scattering an object/collection over a surface
 *   object.particle_system_update    change settings of a particle system (partial)
 *   object.particle_system_remove    remove a particle system
 *   object.duplicates_make_real      turn instances into real objects sharing data (Blender)
 *   object.scatter_add               agent-friendly scatter of objects/a collection over a surface
 */

/** Maximum number of objects `object.duplicates_make_real` creates in one run. */
export const MAX_MAKE_REAL = 10_000;

const EMITTER_TYPES: ReadonlySet<ObjectType> = new Set(['MESH', 'CURVE', 'FONT']);

const objectRef = (what: string) =>
  z.string().optional().describe(`${what} by id or name (default: the active object)`);
const systemRef = z
  .string()
  .optional()
  .describe('Particle system id or name (may be omitted when the object has exactly one particle system)');

function settingsList(): string {
  return PARTICLE_SETTING_NAMES.join(', ');
}

// ------------------------------------------------------------------ resolution helpers

function resolveObject(ctx: OperatorContext, ref: string | undefined, what: string): ObjectData {
  const o = ref ? ctx.doc.resolveObject(ref) : activeObject(ctx);
  if (!o) {
    if (ref) throw new OperatorError(`Object '${ref}' not found`, 'NOT_FOUND');
    throw new OperatorError(`No active object (pass \`${what}\`)`, 'POLL_FAILED');
  }
  return o;
}

/** Resolves a collection by id or exact name ('root' / 'Scene Collection' resolve to the root). */
function resolveCollection(ctx: OperatorContext, ref: string): CollectionData {
  const all = ctx.doc.listCollections();
  const c = all.find((x) => x.id === ref) ?? all.find((x) => x.name === ref);
  if (!c) {
    const names = all
      .filter((x) => x.id !== ROOT_COLLECTION_ID)
      .map((x) => `'${x.name}'`)
      .join(', ');
    throw new OperatorError(`Collection '${ref}' not found (collections: ${names || 'none'})`, 'NOT_FOUND');
  }
  return c;
}

function instanceableCollection(ctx: OperatorContext, ref: string): CollectionData {
  const c = resolveCollection(ctx, ref);
  if (c.id === ROOT_COLLECTION_ID)
    throw new OperatorError(
      'The Scene Collection cannot be instanced; use a child collection',
      'INVALID_PARAMS',
    );
  return c;
}

function emitterObject(ctx: OperatorContext, ref: string | undefined): ObjectData {
  const o = resolveObject(ctx, ref, 'object');
  if (!EMITTER_TYPES.has(o.type) || !o.data)
    throw new OperatorError(
      `Object '${o.name}' is a ${o.type} object; particle systems need a mesh, curve or text object`,
      'POLL_FAILED',
    );
  return o;
}

/** Particle systems of an object (an empty list for missing or corrupt data). */
function systemsOf(o: ObjectData): ParticleSystemData[] {
  return Array.isArray(o.particle_systems)
    ? o.particle_systems.filter((p) => !!p && typeof p === 'object')
    : [];
}

function findSystem(o: ObjectData, ref: string | undefined): number {
  const list = systemsOf(o);
  if (!ref) {
    if (list.length === 1) return 0;
    if (list.length === 0) throw new OperatorError(`Object '${o.name}' has no particle systems`, 'NOT_FOUND');
    throw new OperatorError(
      `Object '${o.name}' has ${list.length} particle systems (${list.map((p) => `'${p.name}'`).join(', ')}); pass particle_system`,
      'INVALID_PARAMS',
    );
  }
  let i = list.findIndex((p) => p.id === ref);
  if (i < 0) i = list.findIndex((p) => p.name === ref);
  if (i < 0) {
    const have = list.map((p) => `'${p.name}'`).join(', ') || 'none';
    throw new OperatorError(
      `Particle system '${ref}' not found on '${o.name}' (systems: ${have})`,
      'NOT_FOUND',
    );
  }
  return i;
}

/**
 * Merges a settings patch into `current`, resolving object/collection references (ids or names) to
 * ids, and validates the result.
 */
function mergeSettings(
  ctx: OperatorContext,
  emitter: ObjectData,
  current: ParticleSettings,
  patch: ParticleSettingsPatch | undefined,
): ParticleSettings {
  const merged: Record<string, unknown> = { ...cloneJson(current) };
  for (const [k, v] of Object.entries(patch ?? {})) if (v !== undefined) merged[k] = cloneJson(v);
  if (patch?.instance_object !== undefined) {
    const ref = patch.instance_object;
    if (ref === null || ref === '') merged.instance_object = null;
    else {
      const obj = ctx.doc.resolveObject(ref);
      if (!obj) throw new OperatorError(`instance_object '${ref}' not found`, 'NOT_FOUND');
      if (obj.id === emitter.id)
        throw new OperatorError('instance_object cannot be the emitter itself', 'INVALID_PARAMS');
      merged.instance_object = obj.id;
    }
  }
  if (patch?.instance_collection !== undefined) {
    const ref = patch.instance_collection;
    merged.instance_collection = ref === null || ref === '' ? null : instanceableCollection(ctx, ref).id;
  }
  if (patch?.instance_weights !== undefined) {
    merged.instance_weights = patch.instance_weights.map((w) => {
      const obj = ctx.doc.resolveObject(w.object);
      if (!obj) throw new OperatorError(`instance_weights: object '${w.object}' not found`, 'NOT_FOUND');
      return { object: obj.id, weight: w.weight };
    });
  }
  if (patch && 'instance_object' in patch && patch.instance_object && patch.instance_type === undefined)
    merged.instance_type = 'OBJECT';
  if (
    patch &&
    'instance_collection' in patch &&
    patch.instance_collection &&
    patch.instance_type === undefined
  )
    merged.instance_type = 'COLLECTION';
  const res = ParticleSettingsSchema.safeParse(merged);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `${i.path.join('.') || '(settings)'}: ${i.message}`).join('; ');
    throw new OperatorError(`Invalid particle settings: ${msg}`, 'INVALID_PARAMS');
  }
  const s = res.data as ParticleSettings;
  if (s.vertex_group_density && emitter.type === 'MESH' && emitter.data) {
    const groups = ctx.doc.getVertexGroups(emitter.data);
    if (!groups.some((g) => g.name === s.vertex_group_density))
      throw new OperatorError(
        `Vertex group '${s.vertex_group_density}' not found on '${emitter.name}' (groups: ${
          groups.map((g) => `'${g.name}'`).join(', ') || 'none'
        })`,
        'NOT_FOUND',
      );
  }
  return s;
}

/**
 * Evaluates the scene at the current frame (viewport modifiers) and expands every instance,
 * ignoring display_percentage. `physics` runs the rigid body simulation up to the frame.
 */
function evaluateInstances(
  ctx: OperatorContext,
  physics: boolean,
): {
  instances: EvaluatedInstance[];
  errors: { objectId: string; message: string }[];
  objects: Map<string, Mat4>;
} {
  const doc = ctx.doc;
  const ev = new SceneEvaluator(doc).evaluate(ctx.state.frame, { noPhysics: !physics });
  const res = expandInstances({
    doc,
    frame: ctx.state.frame,
    forRender: false,
    fullDisplay: true,
    objects: ev.objects,
    byId: ev.byId,
  });
  return { ...res, objects: new Map(ev.objects.map((o) => [o.id, o.worldMatrix])) };
}

/** Particle/instance counts and problems of one particle system (all particles, viewport settings). */
function systemReport(
  ctx: OperatorContext,
  emitterId: string,
  sys: ParticleSystemData,
): { particles: number; instances: number; errors: string[] } {
  const { instances, errors } = evaluateInstances(ctx, false);
  const prefix = `${emitterId}:${sys.id}:`;
  const pids = new Set<string>();
  let count = 0;
  for (const inst of instances) {
    if (inst.ownerId !== emitterId || !inst.id.startsWith(prefix)) continue;
    count++;
    const rest = inst.id.slice(prefix.length);
    const cut = rest.indexOf(':');
    pids.add(cut < 0 ? rest : rest.slice(0, cut));
  }
  const tag = `Particle system '${sys.name}': `;
  return {
    particles: pids.size,
    instances: count,
    errors: errors.filter((e) => e.objectId === emitterId && e.message.startsWith(tag)).map((e) => e.message),
  };
}

function writeSystems(ctx: OperatorContext, o: ObjectData, systems: ParticleSystemData[]): void {
  ctx.doc.updateObject(o.id, { particle_systems: systems });
}

/** Blender-style unique names for many new objects at once (amortized O(1) per name). */
function namer(doc: SceneDoc): (base: string) => string {
  const taken = new Set<string>();
  for (const y of doc.map('objects').values()) taken.add(String((y as Y.Map<unknown>).get('name') ?? ''));
  const cursor = new Map<string, number>();
  return (base) => {
    const clean = (base || 'Object').trim() || 'Object';
    if (!taken.has(clean)) {
      taken.add(clean);
      return clean;
    }
    const stem = clean.replace(/\.\d{3,}$/, '');
    let i = cursor.get(stem) ?? 1;
    let name = `${stem}.${String(i).padStart(3, '0')}`;
    while (taken.has(name)) name = `${stem}.${String(++i).padStart(3, '0')}`;
    cursor.set(stem, i + 1);
    taken.add(name);
    return name;
  };
}

/** Adds many objects in the current transaction without the per-object name scan of `addObject`. */
function addObjectsBulk(
  doc: SceneDoc,
  inits: (Partial<ObjectData> & { type: ObjectType; name: string })[],
): string[] {
  const unique = namer(doc);
  const objects = doc.map('objects');
  const ids: string[] = [];
  doc.transact(() => {
    for (const init of inits) {
      const id = newId();
      const fields: Record<string, unknown> = { ...defaultObject(init.type, id, init.name), ...init };
      fields.name = unique(init.name);
      const y = new Y.Map<unknown>();
      objects.set(id, y);
      y.set('id', id);
      for (const [k, v] of Object.entries(fields)) {
        if (k === 'id' || v === undefined) continue;
        y.set(k, v instanceof Uint8Array ? v : cloneJson(v));
      }
      ids.push(id);
    }
  });
  return ids;
}

function hideObject(ctx: OperatorContext, id: string): void {
  ctx.doc.updateObject(id, { hide_viewport: true, hide_render: true });
}

// ------------------------------------------------------------------ operators

export function registerInstancingOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'object.collection_instance_add',
      label: 'Collection Instance',
      description:
        'Add an empty that instances a collection (Blender Add > Collection Instance): every object of the collection ' +
        "and its child collections appears at the empty's transform, relative to the collection's instance_offset " +
        '(instance world matrix = empty world · translate(-instance_offset) · object world). Hidden source collections ' +
        'and objects are still instanced. Returns the new empty id and name.',
      category: 'Add',
      redoable: true,
      schema: z.object({
        collection: z
          .string()
          .describe('Collection to instance, by id or exact name (not the Scene Collection)'),
        name: z.string().optional().describe('Name of the new empty (default: the collection name)'),
        location: vec3.optional().describe('World location in metres (default: the 3D cursor)'),
        rotation: vec3.optional().describe('Euler XYZ rotation in radians (default [0, 0, 0])'),
        scale: vec3.optional().describe('Scale (default [1, 1, 1])'),
      }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const c = instanceableCollection(ctx, p.collection);
        const id = ctx.doc.addObject({
          type: 'EMPTY',
          name: p.name?.trim() || c.name,
          empty_display_type: 'PLAIN_AXES',
          instance_type: 'COLLECTION',
          instance_collection: c.id,
          location: (p.location ?? ctx.state.cursorLocation) as Vec3,
          rotation_euler: (p.rotation ?? [0, 0, 0]) as Vec3,
          scale: (p.scale ?? [1, 1, 1]) as Vec3,
        });
        setSelection(ctx, [id], id);
        return { object: id, name: ctx.doc.getObject(id)!.name, collection: c.id, collection_name: c.name };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.instance_collection_set',
      label: 'Set Instance Collection',
      description:
        "Make an empty instance a collection (sets instance_type 'COLLECTION' and instance_collection), or clear it " +
        "with collection null or '' (instance_type 'NONE'). Fails when the collection (or anything instanced from it) " +
        'contains the empty itself.',
      category: 'Object',
      schema: z.object({
        object: objectRef('Empty'),
        collection: z
          .string()
          .nullable()
          .describe("Collection by id or exact name; null or '' clears the collection instance"),
      }),
      execute(ctx, p) {
        const o = resolveObject(ctx, p.object, 'object');
        if (o.type !== 'EMPTY')
          throw new OperatorError(
            `Only empties can instance a collection ('${o.name}' is a ${o.type} object); use object.collection_instance_add`,
            'POLL_FAILED',
          );
        if (p.collection === null || p.collection === '') {
          ctx.doc.updateObject(o.id, { instance_type: 'NONE', instance_collection: null });
          return { object: o.id, collection: null };
        }
        const c = instanceableCollection(ctx, p.collection);
        if (wouldCreateInstanceCycle(ctx.doc, o.id, c.id))
          throw new OperatorError(
            `Collection '${c.name}' contains '${o.name}' (directly or through nested instances); instancing it would recurse`,
            'INVALID_PARAMS',
          );
        ctx.doc.updateObject(o.id, { instance_type: 'COLLECTION', instance_collection: c.id });
        return { object: o.id, collection: c.id, collection_name: c.name };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.particle_system_add',
      label: 'Add Particle System',
      description:
        'Add a particle system to a mesh, curve or text object: a static scatter of `count` particles over the surface ' +
        '(emit_from FACE), vertices or volume, each instancing `instance_object` (instance_type OBJECT) or objects of ' +
        '`instance_collection` (COLLECTION). Deterministic for a given seed. Settings use Blender names; omitted ' +
        `settings take their defaults (count 1000, JITTERED, particle_size 1, rotation_mode NORMAL). Valid settings: ${settingsList()}. ` +
        'Returns the system id/name, the number of particles and instances, and any problems (errors).',
      category: 'Object',
      redoable: true,
      schema: z.object({
        object: objectRef('Emitter (mesh, curve or text object)'),
        name: z
          .string()
          .optional()
          .describe(`Name of the system (made unique; default '${DEFAULT_PARTICLE_SYSTEM_NAME}')`),
        settings: ParticleSettingsPatchSchema.optional().describe(
          'Particle settings to set (others keep defaults)',
        ),
        show_viewport: z.boolean().default(true).describe('Show the instances in the viewport'),
        show_render: z.boolean().default(true).describe('Show the instances in renders and exports'),
      }),
      execute(ctx, p) {
        const o = emitterObject(ctx, p.object);
        const settings = mergeSettings(
          ctx,
          o,
          ParticleSettingsSchema.parse({}) as ParticleSettings,
          p.settings,
        );
        const names = new Set(systemsOf(o).map((s) => s.name));
        const sys: ParticleSystemData = {
          id: newId(),
          name: uniqueName(p.name?.trim() || DEFAULT_PARTICLE_SYSTEM_NAME, names),
          show_viewport: p.show_viewport,
          show_render: p.show_render,
          settings: settings as unknown as Record<string, unknown>,
        };
        writeSystems(ctx, o, [...systemsOf(o), sys]);
        return { object: o.id, particle_system: sys.id, name: sys.name, ...systemReport(ctx, o.id, sys) };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.particle_system_update',
      label: 'Update Particle System',
      description:
        'Change a particle system: `settings` is a partial patch (only the given fields change; object/collection ' +
        'references by id or name), plus optional name, show_viewport and show_render. ' +
        `Valid settings: ${settingsList()}. Returns the particle and instance counts and any problems (errors).`,
      category: 'Object',
      redoable: true,
      schema: z.object({
        object: objectRef('Emitter'),
        particle_system: systemRef,
        settings: ParticleSettingsPatchSchema.optional().describe('Settings to change'),
        name: z.string().optional().describe('New name (kept unique on the object)'),
        show_viewport: z.boolean().optional().describe('Show the instances in the viewport'),
        show_render: z.boolean().optional().describe('Show the instances in renders and exports'),
      }),
      execute(ctx, p) {
        const o = emitterObject(ctx, p.object);
        const i = findSystem(o, p.particle_system);
        const systems = cloneJson(systemsOf(o));
        const cur = systems[i];
        const current = normalizeParticleSettings(cur.settings).settings;
        const next: ParticleSystemData = {
          ...cur,
          settings: mergeSettings(ctx, o, current, p.settings) as unknown as Record<string, unknown>,
        };
        if (p.name?.trim())
          next.name = uniqueName(
            p.name.trim(),
            new Set(systems.filter((_, k) => k !== i).map((s) => s.name)),
          );
        if (p.show_viewport !== undefined) next.show_viewport = p.show_viewport;
        if (p.show_render !== undefined) next.show_render = p.show_render;
        systems[i] = next;
        writeSystems(ctx, o, systems);
        return { object: o.id, particle_system: next.id, name: next.name, ...systemReport(ctx, o.id, next) };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.particle_system_remove',
      label: 'Remove Particle System',
      description: 'Remove a particle system (id or name) from an object. Returns the removed id and name.',
      category: 'Object',
      schema: z.object({ object: objectRef('Emitter'), particle_system: systemRef }),
      execute(ctx, p) {
        const o = resolveObject(ctx, p.object, 'object');
        const i = findSystem(o, p.particle_system);
        const systems = systemsOf(o);
        const removed = systems[i];
        writeSystems(
          ctx,
          o,
          systems.filter((_, k) => k !== i),
        );
        return { object: o.id, removed: removed.id, name: removed.name, remaining: systems.length - 1 };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.duplicates_make_real',
      label: 'Make Instances Real',
      description:
        'Turn the instances of the given (default: selected) instancers — collection instance empties and particle ' +
        'emitters — into real objects at the current frame (Blender object.duplicates_make_real). The new objects ' +
        "share their source's object data (linked duplicates), keep its modifiers and materials, are visible and go " +
        "into the instancer's collection. Afterwards collection instances are switched off (instance_type NONE) and " +
        `particle systems are hidden (show_viewport/show_render false). At most ${MAX_MAKE_REAL} objects per run; ` +
        'every particle is used (display_percentage ignored). Returns the new object ids, which become the selection.',
      category: 'Object',
      schema: z.object({
        objects: z
          .array(z.string())
          .optional()
          .describe('Instancers by id or name (default: the selected objects)'),
        use_base_parent: z
          .boolean()
          .default(false)
          .describe('Parent the new objects to their instancer (world transforms are kept)'),
      }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const ids = resolveObjectIds(ctx, p.objects);
        const instancers = ids
          .map((id) => ctx.doc.getObject(id)!)
          .filter(
            (o) =>
              (o.instance_type === 'COLLECTION' && !!o.instance_collection) ||
              systemsOf(o).some((s) => s.show_viewport !== false || s.show_render !== false),
          );
        if (!instancers.length)
          throw new OperatorError(
            'No instancers given or selected (collection instances or particle emitters)',
            'POLL_FAILED',
          );
        const owners = new Set(instancers.map((o) => o.id));
        const { instances, objects } = evaluateInstances(ctx, true);
        const mine = instances.filter((i) => owners.has(i.ownerId));
        if (mine.length > MAX_MAKE_REAL)
          throw new OperatorError(
            `Making ${mine.length} instances real exceeds the limit of ${MAX_MAKE_REAL} objects; reduce the particle count first`,
            'FAILED',
          );
        const sources = new Map<string, ObjectData | null>();
        const inverse = new Map<string, Mat4 | null>();
        const inits: (Partial<ObjectData> & { type: ObjectType; name: string })[] = [];
        for (const inst of mine) {
          if (!sources.has(inst.sourceId)) sources.set(inst.sourceId, ctx.doc.getObject(inst.sourceId));
          const src = sources.get(inst.sourceId);
          if (!src) continue;
          const owner = instancers.find((o) => o.id === inst.ownerId)!;
          let parent: string | null = null;
          let m = inst.matrix;
          if (p.use_base_parent) {
            const world = objects.get(owner.id);
            if (!inverse.has(owner.id)) inverse.set(owner.id, world ? invertAffine(world) : null);
            const inv = inverse.get(owner.id);
            if (inv) {
              m = mulAffine(inv, inst.matrix);
              parent = owner.id;
            }
          }
          const d = decompose4(m);
          const { id: _id, ...rest } = src;
          inits.push({
            ...cloneJson(rest),
            name: src.name,
            parent,
            parent_type: 'OBJECT',
            parent_bone: '',
            collection: owner.collection,
            location: d.location,
            rotation_euler: d.rotation,
            scale: d.scale,
            hide_viewport: false,
            hide_render: false,
            hide_select: false,
            constraints: [],
            particle_systems: [],
            instance_type: 'NONE',
            instance_collection: null,
            modifiers: src.modifiers.map((mod) => ({ ...cloneJson(mod), id: newId() })),
          });
        }
        const created = addObjectsBulk(ctx.doc, inits);
        for (const o of instancers) {
          if (o.instance_type === 'COLLECTION') ctx.doc.updateObject(o.id, { instance_type: 'NONE' });
          const systems = systemsOf(o);
          if (systems.length)
            ctx.doc.updateObject(o.id, {
              particle_systems: systems.map((s) => ({ ...s, show_viewport: false, show_render: false })),
            });
        }
        if (created.length) setSelection(ctx, created, created[created.length - 1]);
        ctx.report('INFO', `Made ${created.length} instance(s) real`);
        return { objects: created, count: created.length, instancers: instancers.map((o) => o.id) };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.scatter_add',
      label: 'Scatter Objects',
      description:
        'Scatter objects over a surface (agent-friendly particle system): creates a particle system on `surface` ' +
        'that instances `objects` (one object, or several picked at random — they are moved into a new collection ' +
        'unless they already form one collection) ' +
        'or a `collection`, with count/seed and size/rotation randomisation. Instances stand on the surface with ' +
        'their +Z axis along the surface normal (align_to_normal) or world up. By default the sources are hidden so ' +
        'only the scattered copies show. Returns the particle system, the number of particles/instances and problems.',
      category: 'Object',
      redoable: true,
      schema: z.object({
        surface: z
          .string()
          .optional()
          .describe('Surface object (mesh, curve or text) by id or name (default: active object)'),
        objects: z
          .array(z.string())
          .optional()
          .describe('Objects to scatter by id or name (give either objects or collection)'),
        collection: z.string().optional().describe('Collection whose objects are scattered, by id or name'),
        count: z.number().int().min(1).max(MAX_INSTANCES).default(100).describe('Number of instances'),
        seed: z.number().int().default(0).describe('Random seed (change for a different arrangement)'),
        size: z.number().min(0).max(1e5).default(1).describe('Scale of every instance (1 = original size)'),
        size_random: z
          .number()
          .min(0)
          .max(1)
          .default(0)
          .describe('Random size reduction 0..1 (0.5: sizes 50%..100%)'),
        align_to_normal: z
          .boolean()
          .default(true)
          .describe(
            'true: +Z follows the surface normal; false: instances stay upright (world +Z), e.g. trees on hills',
          ),
        rotation_random: z
          .number()
          .min(0)
          .max(1)
          .default(0)
          .describe('Random tilt 0..1 (1 = fully random orientation)'),
        heading_random: z
          .number()
          .min(0)
          .max(1)
          .default(1)
          .describe('Random spin around the up axis 0..1 (1 = any heading)'),
        min_distance: z
          .number()
          .min(0)
          .max(1e5)
          .default(0)
          .describe(
            'Minimum distance between instances in metres (0 = off); fewer are placed when the surface is full',
          ),
        distribution: z
          .enum(['RANDOM', 'JITTERED'])
          .default('RANDOM')
          .describe('RANDOM: natural random scatter; JITTERED: even coverage'),
        emit_from: z
          .enum(['FACE', 'VERT', 'VOLUME'])
          .default('FACE')
          .describe('Surface, vertices or inside volume'),
        vertex_group: z
          .string()
          .optional()
          .describe('Vertex group of the surface mesh that scales the density (0..1)'),
        whole_collection: z
          .boolean()
          .default(false)
          .describe('collection only: place the whole collection at every point instead of one object'),
        hide_sources: z
          .boolean()
          .default(true)
          .describe('Hide the source objects/collection (viewport and render) so only the instances show'),
        name: z.string().default('Scatter').describe('Name of the particle system'),
      }),
      execute(ctx, p) {
        const surface = emitterObject(ctx, p.surface);
        if (!!p.objects?.length === !!p.collection)
          throw new OperatorError('Give either `objects` or `collection` to scatter', 'INVALID_PARAMS');
        const patch: ParticleSettingsPatch = {
          count: p.count,
          seed: p.seed,
          emit_from: p.emit_from,
          distribution: p.distribution,
          use_even_distribution: true,
          particle_size: p.size,
          size_random: p.size_random,
          rotation_mode: p.align_to_normal ? 'NORMAL' : 'GLOBAL_Z',
          rotation_factor_random: p.rotation_random,
          phase_factor: 0,
          phase_factor_random: 2 * p.heading_random,
          min_distance: p.min_distance,
          use_collection_pick_random: true,
          use_whole_collection: p.whole_collection,
          use_modifier_stack: true,
          vertex_group_density: p.vertex_group ?? '',
        };
        let collectionId: string | null = null;
        let hidden: string[] = [];
        if (p.objects?.length) {
          const ids = [...new Set(resolveObjectIds(ctx, p.objects))];
          if (ids.includes(surface.id))
            throw new OperatorError('The surface cannot scatter itself', 'INVALID_PARAMS');
          if (ids.length === 1) {
            patch.instance_type = 'OBJECT';
            patch.instance_object = ids[0];
          } else {
            // reuse a collection holding exactly these objects (e.g. from an earlier scatter of the same set)
            const first = ctx.doc.getObject(ids[0])!.collection;
            const members = first === ROOT_COLLECTION_ID ? [] : collectionMembers(ctx.doc, first);
            const same =
              members.length === ids.length &&
              members.every((m) => ids.includes(m.id)) &&
              !!ctx.doc.getCollection(first);
            if (same) collectionId = first;
            else {
              collectionId = ctx.doc.addCollection({ name: `${p.name} Sources`, parent: ROOT_COLLECTION_ID });
              for (const id of ids) ctx.doc.updateObject(id, { collection: collectionId });
            }
            patch.instance_type = 'COLLECTION';
            patch.instance_collection = collectionId;
          }
          if (p.hide_sources) {
            if (collectionId)
              ctx.doc.updateCollection(collectionId, { hide_viewport: true, hide_render: true });
            else for (const id of ids) hideObject(ctx, id);
            hidden = ids;
          }
        } else {
          const c = instanceableCollection(ctx, p.collection!);
          collectionId = c.id;
          patch.instance_type = 'COLLECTION';
          patch.instance_collection = c.id;
          if (p.hide_sources) {
            if (collectionContainsObject(ctx.doc, c.id, surface.id)) {
              // keep the surface visible: hide the other objects instead of the collection
              for (const o of ctx.doc.listObjects())
                if (o.id !== surface.id && collectionContainsObject(ctx.doc, c.id, o.id)) {
                  hideObject(ctx, o.id);
                  hidden.push(o.id);
                }
            } else ctx.doc.updateCollection(c.id, { hide_viewport: true, hide_render: true });
          }
        }
        const settings = mergeSettings(
          ctx,
          surface,
          ParticleSettingsSchema.parse({}) as ParticleSettings,
          patch,
        );
        const names = new Set(systemsOf(surface).map((s) => s.name));
        const sys: ParticleSystemData = {
          id: newId(),
          name: uniqueName(p.name.trim() || 'Scatter', names),
          show_viewport: true,
          show_render: true,
          settings: settings as unknown as Record<string, unknown>,
        };
        writeSystems(ctx, surface, [...systemsOf(surface), sys]);
        setSelection(ctx, [surface.id], surface.id);
        return {
          object: surface.id,
          particle_system: sys.id,
          name: sys.name,
          instance_type: settings.instance_type,
          instance_object: settings.instance_object,
          collection: collectionId,
          hidden,
          ...systemReport(ctx, surface.id, sys),
        };
      },
    }),
  );
}
