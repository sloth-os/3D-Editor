import { z } from 'zod';
import { STORE_CATEGORIES } from '../store/types';
import { OperatorError } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { pollObjectMode, vec3 } from './helpers';

/*
 * Model store operators (CATALOG owns this module; spec §10):
 *
 *   store.add            add a built-in catalog model (root EMPTY + named parts, real size)
 *   store.search         search the built-in catalog (read-only)
 *   store.insert_files   import a downloaded store model's files as one undo step
 *
 * The library is store/ (catalog, search, insert). FOUNDATION wrote the ids, schemas and
 * defaults; every operator throws until CATALOG implements it. Models stand with their origin at
 * the base centre, their front facing −Y.
 */

function notImplemented(id: string): () => never {
  return () => {
    throw new OperatorError(`${id} is not implemented yet`, 'FAILED');
  };
}

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
    .describe('Height in metres; the proportions are kept unless width_m or depth_m is given too'),
  width_m: z.number().positive().max(10_000).optional().describe('Width in metres (along X)'),
  depth_m: z.number().positive().max(10_000).optional().describe('Depth in metres (along Y)'),
  name: z.string().min(1).max(64).optional().describe("Name of the root object (default: the model's name)"),
};

export function registerStoreOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'store.add',
      label: 'Add Model',
      description:
        'Add a built-in catalog model at its real size (or the size given): an EMPTY root with named parts, the ' +
        'origin at the base centre, the front facing −Y; vehicles have body, wheel.FL/FR/BL/BR and steer.FL/FR ' +
        'parts, people and animals are actors. store.search lists the models. Returns {root, objects, entry}.',
      category: 'Store',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        model: z
          .string()
          .min(1)
          .max(200)
          .describe("Catalog id of a built-in model ('oak_tree' or 'builtin:oak_tree')"),
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
          .describe("Main colour '#rrggbb' (default: the model's own)"),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("The model's own parameters (store.search lists them per model)"),
      }),
      execute: notImplemented('store.add'),
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
      execute: notImplemented('store.search'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'store.insert_files',
      label: 'Insert Model Files',
      description:
        "Import a downloaded store model's files (glb, gltf with its buffers and textures, or obj with its mtl and " +
        'textures) as one undo step: wrapped in an EMPTY root, scaled to the size given (else its real size), ' +
        'origin at the base centre, put on the ground, with its licence and attribution recorded as custom ' +
        'properties. Returns {root, objects, warnings}.',
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
        files: z
          .record(z.string(), z.string())
          .describe(
            'File contents by path, base64: the main file and the buffers, textures and materials it names',
          ),
        main: z.string().min(1).max(1000).describe('Path of the main file in `files`'),
        ...placement,
      }),
      execute: notImplemented('store.insert_files'),
    }),
  );
}
