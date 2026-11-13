import { z } from 'zod';
import type { Vec3 } from '../math/types';
import { STORE_CATEGORIES, type CatalogEntry } from '../store/types';
import { builtinResult, getCatalogEntry } from '../store/catalog';
import { rankCatalog, searchCatalogPage } from '../store/search';
import { insertStoreFiles, normalizeFilePath } from '../store/insert';
import { meshWorldBounds, parseModelParams, takesColor } from '../store/builtin/kit';
import type { OperatorContext } from './context';
import { OperatorError } from './context';
import { defineOperator, safeJsonSchema, type OperatorRegistry } from './registry';
import { pollObjectMode, setSelection, vec3 } from './helpers';

/*
 * Model store operators (CATALOG owns this module; spec §10):
 *
 *   store.add            add a built-in catalog model (root EMPTY + named parts, real size)
 *   store.search         search the built-in catalog (read-only)
 *   store.insert_files   import a downloaded store model's files as one undo step
 *
 * The library is store/ (catalog, search, insert, builtin/*). Models stand with their origin at the
 * base centre, their front facing −Y; both adds select the new root.
 */

const categoryEnum = z
  .enum(STORE_CATEGORIES)
  .describe(
    'Category: people, animals, furniture, props, food, vehicles, nature, architecture, street or sports',
  );
const placement = {
  location: vec3.optional().describe('Where the base centre goes, in metres (default: the 3D cursor)'),
  rotation_deg: z
    .number()
    .min(-3600)
    .max(3600)
    .optional()
    .describe('Rotation about +Z in degrees (0: the front faces −Y) (default 0)'),
  height_m: z
    .number()
    .positive()
    .max(10_000)
    .optional()
    .describe(
      'Overall height in metres; the proportions are kept unless width_m or depth_m is given too ' +
        '(people and animals: their standing height, to the top of the head or the ears, proportions always kept)',
    ),
  width_m: z.number().positive().max(10_000).optional().describe('Width in metres (along X)'),
  depth_m: z.number().positive().max(10_000).optional().describe('Depth in metres (along Y)'),
  name: z.string().min(1).max(64).optional().describe("Name of the root object (default: the model's name)"),
};

/** Where an add puts the model: the location given, else the 3D cursor. */
function placeAt(ctx: OperatorContext, location: readonly number[] | undefined): Vec3 {
  const l = location ?? ctx.state.cursorLocation;
  return [l[0], l[1], l[2]];
}

/** A size in metres to six significant digits (a millimetre model keeps its size). */
const roundSize = (v: number) => (Number.isFinite(v) ? Number(v.toPrecision(6)) : 0);

/**
 * Size (width, depth, height) of a model in world space at the current frame, from its mesh
 * objects as the frame evaluates them: an actor's parts hang from its bones.
 */
function modelSize(ctx: OperatorContext, objects: readonly string[]): Vec3 {
  const b = meshWorldBounds(ctx.doc, objects, ctx.state.frame);
  return b ? [roundSize(b.size[0]), roundSize(b.size[1]), roundSize(b.size[2])] : [0, 0, 0];
}

/** The warnings of a build (BuiltModel: sizes or a colour it could not apply). */
const buildWarnings = (res: unknown): string[] => {
  const w = (res as { warnings?: unknown }).warnings;
  return Array.isArray(w) ? w.filter((x): x is string => typeof x === 'string') : [];
};

/** File paths as store.insert_files keys them (normalizeFilePath), later spellings of one path winning. */
const normalizedFiles = (files: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [path, data] of Object.entries(files)) out[normalizeFilePath(path)] = data;
  return out;
};

/** Names of objects (ids where an object is gone). */
const namesOf = (ctx: OperatorContext, ids: readonly string[]) =>
  ids.map((id) => ctx.doc.getObject(id)?.name ?? id);

/** A catalog entry for a search result or a reply: the store result, its description and parameters. */
function describeEntry(e: CatalogEntry) {
  const params = e.params ? (safeJsonSchema(e.params) as { properties?: Record<string, unknown> }) : null;
  return {
    ...builtinResult(e),
    description: e.description,
    synonyms: [...e.synonyms],
    rig: e.rig,
    /** Whether store.add's `color` recolours it (else it warns and keeps the model's colours). */
    recolorable: takesColor(e),
    ...(e.actor_kind ? { actor_kind: e.actor_kind } : {}),
    ...(params?.properties && Object.keys(params.properties).length ? { params: params.properties } : {}),
  };
}

/** The entry `model` names, else NOT_FOUND naming the closest models. */
function entryOrThrow(model: string): CatalogEntry {
  const entry = getCatalogEntry(model);
  if (entry) return entry;
  const near = rankCatalog(model.replace(/^[a-z]+:/i, '').replace(/[-_]/g, ' '))
    .slice(0, 3)
    .map((r) => `'${r.entry.id}'`);
  throw new OperatorError(
    `No built-in model '${model}'${near.length ? `; did you mean ${near.join(', ')}?` : ''} ` +
      '(store.search lists the models)',
    'NOT_FOUND',
  );
}

export function registerStoreOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'store.add',
      label: 'Add Model',
      description:
        'Add a built-in catalog model at its real size (or the size given): an EMPTY root with named parts, the ' +
        'origin at the base centre, the front facing −Y; vehicles have body, wheel.FL/FR/BL/BR and steer.FL/FR ' +
        'parts, people and animals are actors. store.search lists the models. Returns {root, objects, ' +
        'dimensions_m, warnings, entry}.',
      category: 'Store',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        model: z
          .string()
          .min(1)
          .max(200)
          .describe("Catalog id of a built-in model ('coffee_table' or 'builtin:coffee_table')"),
        ...placement,
        scale: z
          .number()
          .positive()
          .max(1000)
          .optional()
          .describe('Uniform scale of the real size (default 1; ignored when a size is given)'),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
          .describe(
            "Main colour '#rrggbb' (default: the model's own); a model whose search result says " +
              'recolorable: false keeps its colours and warns',
          ),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("The model's own parameters (store.search lists them per model)"),
      }),
      execute(ctx, p) {
        const entry = entryOrThrow(p.model);
        // checked before anything is added (the build checks again)
        parseModelParams({ id: entry.id, params: entry.params }, p.params);
        const res = entry.build(ctx.doc, {
          location: placeAt(ctx, p.location),
          rotation_deg: p.rotation_deg,
          height_m: p.height_m,
          width_m: p.width_m,
          depth_m: p.depth_m,
          scale: p.scale,
          color: p.color,
          name: p.name,
          params: p.params,
        });
        const warnings = buildWarnings(res);
        for (const w of warnings) ctx.report('WARNING', w);
        setSelection(ctx, [res.root], res.root);
        return {
          root: res.root,
          name: ctx.doc.getObject(res.root)?.name ?? res.root,
          objects: res.objects,
          names: namesOf(ctx, res.objects),
          dimensions_m: modelSize(ctx, res.objects),
          warnings,
          entry: describeEntry(entry),
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'store.search',
      label: 'Search Models',
      description:
        'Search the built-in model catalog by keywords over names, tags, synonyms and categories (read-only; the ' +
        "server's store_search also searches online providers). Returns {results, total} best first.",
      category: 'Store',
      undo: false,
      schema: z.object({
        query: z.string().max(200).optional().describe('Words to look for (default: every model, by name)'),
        category: categoryEnum.optional(),
        limit: z.number().int().min(1).max(100).default(20).describe('Most results to return'),
        offset: z.number().int().min(0).max(100_000).default(0).describe('Results to skip (paging)'),
      }),
      execute(_ctx, p) {
        const page = searchCatalogPage(p.query ?? '', {
          category: p.category ?? null,
          limit: p.limit,
          offset: p.offset,
        });
        return {
          results: page.entries.map(describeEntry),
          total: page.total,
          offset: p.offset,
          limit: p.limit,
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'store.insert_files',
      label: 'Insert Model Files',
      description:
        "Import a downloaded store model's files (glb, gltf with its buffers and textures, or obj with its mtl and " +
        'textures) as one undo step: wrapped in an EMPTY root, scaled to the size given, else to the dimensions_m ' +
        'of its entry, else kept at the size of its file when that is believable for its category (ten times ' +
        'off or more: read as centimetres, inches or millimetres, or scaled to the usual size of its category, ' +
        'with a warning), origin at the base centre, put on the ground, with its licence and attribution ' +
        'recorded as custom properties. Cameras and lights the file brings are left out (a warning names ' +
        'them). Returns {root, objects, dimensions_m, warnings}.',
      category: 'Store',
      poll: pollObjectMode,
      schema: z.object({
        entry: z
          .object({
            id: z.string().min(1).max(400).describe("Store id of the model ('<provider>:<id>')"),
            name: z.string().max(200).describe('Model name'),
            provider: z.string().min(1).max(64).describe('Provider id (khronos, polyhaven, sketchfab …)'),
            license: z
              .object({
                spdx: z.string().max(64).describe("SPDX id of the licence (e.g. 'CC0-1.0', 'CC-BY-4.0')"),
                url: z.string().max(2000).nullable().describe('Licence URL'),
                attribution: z
                  .string()
                  .max(2000)
                  .nullable()
                  .describe('Attribution text the licence asks for'),
              })
              .describe('Licence of the model'),
            author: z.string().max(400).nullable().describe('Author'),
            source_url: z.string().max(2000).nullable().describe("The model's page"),
            dimensions_m: z
              .tuple([z.number().positive(), z.number().positive(), z.number().positive()])
              .optional()
              .describe('Real size in metres (width, depth, height) when the provider gives it'),
            category: categoryEnum.optional(),
          })
          .describe('The store search result the files are of'),
        format: z.enum(['glb', 'gltf', 'obj']).describe('Format of the main file'),
        // paths are normalized here (normalizeFilePath: './', '\\', a leading '/'), so the memory
        // estimate finds the main file the way the insert does
        files: z
          .record(z.string(), z.string())
          .describe(
            'File contents by path, base64: the main file and the buffers, textures and materials it names',
          )
          .overwrite(normalizedFiles),
        main: z
          .string()
          .min(1)
          .max(1000)
          .describe('Path of the main file in `files`')
          .overwrite(normalizeFilePath),
        ...placement,
      }),
      execute(ctx, p) {
        const res = insertStoreFiles(ctx.doc, {
          ...p,
          location: placeAt(ctx, p.location),
          frame: ctx.state.frame,
        });
        for (const w of res.warnings) ctx.report('WARNING', w);
        setSelection(ctx, [res.root], res.root);
        return {
          root: res.root,
          name: ctx.doc.getObject(res.root)?.name ?? res.root,
          objects: res.objects,
          names: namesOf(ctx, res.objects),
          dimensions_m: res.dimensions_m.map(roundSize),
          warnings: res.warnings,
        };
      },
    }),
  );
}
