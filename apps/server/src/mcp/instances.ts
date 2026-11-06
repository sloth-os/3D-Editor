import {
  ROOT_COLLECTION_ID,
  decompose4,
  normalizeParticleSettings,
  type EvaluatedInstance,
  type ObjectData,
  type ParticleSystemData,
  type SceneDoc,
} from '@3d-editor/core';
import { evaluateCached, type EvalMode } from './eval-cache';
import { ToolError } from './agent';

/*
 * Read access to the instances an object generates (the get_instances tool): every particle of its
 * particle systems (object.scatter_add, object.particle_system_add) and the objects of an instanced
 * collection (object.collection_instance_add), with the world transform of each instance, in pages.
 * Agents check scatters with it (spacing, nothing on the beach or in the water) without making the
 * instances real.
 */

/** Default and largest page size (instances per call). */
export const DEFAULT_INSTANCE_PAGE = 1000;
export const MAX_INSTANCE_PAGE = 5000;

export interface InstanceListOptions {
  frame: number;
  /** RENDER: the instances renders show (every particle); VIEWPORT: the editor's (display_percentage). */
  source?: EvalMode;
  /** Particle system name or id (default: all of them, and the instanced collection). */
  particle_system?: string;
  offset?: number;
  limit?: number;
  decimals?: number;
}

interface SystemEntry {
  ps: ParticleSystemData;
  shown: boolean;
  instances: number;
  particles: Set<string>;
  min: [number, number, number];
  max: [number, number, number];
}

function rounder(decimals: number): (v: number) => number {
  const f = 10 ** decimals;
  return (v) => {
    if (!Number.isFinite(v)) return v;
    const r = Math.round(v * f) / f;
    return r === 0 ? 0 : r;
  };
}

/** Which particle system (and particle) of `o` an instance belongs to; null for collection instances. */
function particleOf(
  inst: EvaluatedInstance,
  o: ObjectData,
  systems: ReadonlyMap<string, SystemEntry>,
): { system: SystemEntry; particle: string } | null {
  // ids: `${owner}:${system}:${particle}…` for particles (a system id repeated on one object gets
  // `#index`), `${owner}:${source}…` for collection instances
  const rest = inst.id.slice(o.id.length + 1);
  const cut = rest.indexOf(':');
  if (cut < 0) return null;
  const sysPart = rest.slice(0, cut);
  const hash = sysPart.indexOf('#');
  const system = systems.get(hash < 0 ? sysPart : sysPart.slice(0, hash));
  if (!system) return null;
  const tail = rest.slice(cut + 1);
  const end = tail.indexOf(':');
  return { system, particle: end < 0 ? tail : tail.slice(0, end) };
}

/** The instances `o` generates at a frame (see the get_instances tool description). */
export function listInstances(
  scene: SceneDoc,
  o: ObjectData,
  opts: InstanceListOptions,
): Record<string, unknown> {
  const mode: EvalMode = opts.source ?? 'RENDER';
  const decimals = Math.max(0, Math.min(6, Math.round(opts.decimals ?? 4)));
  const round = rounder(decimals);
  const limit = Math.max(1, Math.min(MAX_INSTANCE_PAGE, Math.round(opts.limit ?? DEFAULT_INSTANCE_PAGE)));
  const offset = Math.max(0, Math.round(opts.offset ?? 0));
  const instancesCollection = o.instance_type === 'COLLECTION' && !!o.instance_collection;
  if (!o.particle_systems.length && !instancesCollection)
    throw new ToolError(
      `'${o.name}' generates no instances: it has no particle systems (object.scatter_add, object.particle_system_add) and does not instance a collection (object.collection_instance_add).`,
    );

  const systems = new Map<string, SystemEntry>();
  for (const ps of o.particle_systems)
    systems.set(ps.id, {
      ps,
      shown: mode === 'RENDER' ? ps.show_render : ps.show_viewport,
      instances: 0,
      particles: new Set(),
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity],
    });
  let only: SystemEntry | null = null;
  if (opts.particle_system !== undefined) {
    const ref = opts.particle_system;
    only =
      systems.get(ref) ??
      [...systems.values()].find((s) => s.ps.name === ref) ??
      [...systems.values()].find((s) => s.ps.name.toLowerCase() === ref.toLowerCase()) ??
      null;
    if (!only)
      throw new ToolError(
        o.particle_systems.length
          ? `'${o.name}' has no particle system '${ref}'. Its particle systems: ${o.particle_systems.map((p) => `'${p.name}'`).join(', ')}.`
          : `'${o.name}' has no particle systems (it instances a collection); leave particle_system out.`,
      );
  }

  const ev = evaluateCached(scene, opts.frame, mode);
  const owner = ev.byId.get(o.id);
  const collection = instancesCollection
    ? (scene.getCollection(o.instance_collection!)?.name ??
      (o.instance_collection === ROOT_COLLECTION_ID ? 'Scene Collection' : o.instance_collection))
    : null;
  const name = (id: string) => ev.byId.get(id)?.name ?? scene.getObject(id)?.name ?? id;

  const listed: Record<string, unknown>[] = [];
  let total = 0;
  let collectionInstances = 0;
  for (const inst of ev.instances) {
    if (inst.ownerId !== o.id) continue;
    const of = particleOf(inst, o, systems);
    if (of) {
      const s = of.system;
      s.instances++;
      s.particles.add(of.particle);
      const m = inst.matrix;
      for (let k = 0; k < 3; k++) {
        s.min[k] = Math.min(s.min[k], m[12 + k]);
        s.max[k] = Math.max(s.max[k], m[12 + k]);
      }
    } else collectionInstances++;
    if (only && of?.system !== only) continue;
    const index = total++;
    if (index < offset || index >= offset + limit) continue;
    const t = decompose4(inst.matrix);
    const particle = of ? Number(of.particle) : NaN;
    listed.push({
      ...(of
        ? { system: of.system.ps.name, particle: Number.isFinite(particle) ? particle : of.particle }
        : { collection }),
      source: name(inst.sourceId),
      location: t.location.map(round),
      rotation_euler: t.rotation.map(round),
      scale: t.scale.map(round),
    });
  }

  const hidden = owner ? (mode === 'RENDER' ? !owner.renderVisible : !owner.visible) : false;
  const problems = ev.errors
    .filter((e) => e.source === `instances:${o.id}` || e.source === 'instances')
    .map((e) => e.message);
  const out: Record<string, unknown> = {
    object: o.name,
    frame: ev.frame,
    source: mode,
    space: 'WORLD',
    ...(o.particle_systems.length
      ? {
          particle_systems: o.particle_systems.map((ps) => {
            const s = systems.get(ps.id)!;
            const { settings } = normalizeParticleSettings(ps.settings);
            return {
              name: ps.name,
              instance_type: settings.instance_type,
              ...(settings.instance_type === 'COLLECTION'
                ? {
                    instance_collection: settings.instance_collection
                      ? (scene.getCollection(settings.instance_collection)?.name ??
                        settings.instance_collection)
                      : null,
                  }
                : {
                    instance_object: settings.instance_object ? name(settings.instance_object) : null,
                  }),
              count: settings.count,
              particles: s.particles.size,
              instances: s.instances,
              ...(s.instances ? { location_bounds: { min: s.min.map(round), max: s.max.map(round) } } : {}),
              ...(s.shown
                ? {}
                : {
                    shown: false,
                    note: `show_${mode === 'RENDER' ? 'render' : 'viewport'} is off: no instances in ${mode === 'RENDER' ? 'renders' : 'the viewport'}`,
                  }),
            };
          }),
        }
      : {}),
    ...(instancesCollection
      ? { instance_collection: collection, collection_instances: collectionInstances }
      : {}),
    total,
    range: { offset: Math.min(offset, total), count: listed.length },
    ...(hidden
      ? {
          emitter_hidden: true,
          hidden_note: `'${o.name}' is hidden in ${mode === 'RENDER' ? 'renders (hide_render)' : 'the viewport'}; its instances follow it, so they are not shown either`,
        }
      : {}),
    ...(problems.length ? { problems } : {}),
    layout:
      'instances[i]: {system, particle} (particle systems) or {collection} (collection instance), the instanced source object and its world location (m), rotation_euler (radians, XYZ) and scale',
    instances: listed,
  };
  if (offset + listed.length < total) {
    out.truncated = true;
    out.next = { offset: offset + listed.length };
  }
  return out;
}
