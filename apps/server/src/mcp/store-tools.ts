import { z } from 'zod';
import { MAX_STORE_RESULTS, STORE_CATEGORIES, insertReply } from '../store';
import { ToolError } from './agent';
import { EDIT, READ_ONLY, baseUrl, projectArg, vec3, type ToolContext, type ToolRegistrar } from './tool-kit';

/*
 * The model store tools (SPEC §10). The handlers read ctx.store when they run (registration reads
 * nothing of ctx). store_add inserts with the agent's own undo history: the store prepares the core
 * operator call (store.add for a built-in model, store.insert_files with the downloaded files for
 * an external one) and the agent runs it in its project (one undo step, synced live).
 */

const size = (what: string) =>
  z.number().positive().max(1000).optional().describe(`${what} in metres (the model is scaled to it)`);

export function registerStoreTools(tool: ToolRegistrar, ctx: ToolContext): void {
  tool(
    'store_search',
    {
      title: 'Search model store',
      description:
        "Search the model store by words and category: built-in procedural models (furniture, nature, props, vehicles, buildings; people and animals as rigged actors) and external providers (Khronos glTF samples, Poly Haven, Sketchfab, Poly Pizza, JSON catalogs). Results give the id ('<provider>:<id>'), licence, author, size and whether the model can be downloaded; nothing is downloaded before store_add. providers says how each provider answered (timeouts, missing keys); pass next_cursor as cursor for the next page.",
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    {
      query: z
        .string()
        .max(200)
        .optional()
        .describe('Words to find in names, tags and categories, e.g. "oak tree" or "picnic basket"'),
      category: z.enum(STORE_CATEGORIES).optional().describe('Only models of this category'),
      providers: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe('Providers to search, e.g. ["builtin", "polyhaven"] (default: every configured one)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_STORE_RESULTS)
        .default(20)
        .describe(`Results per page (1–${MAX_STORE_RESULTS})`),
      cursor: z.string().min(1).max(4000).optional().describe('next_cursor of the previous page'),
    },
    async (a, extra) => {
      const res = await ctx.store.search(a, { signal: extra.signal });
      // the thumbnail routes as links on this server (they need the server's token like any route)
      const origin = baseUrl(extra);
      return {
        ...res,
        results: res.results.map((r) => ({
          ...r,
          thumbnail_url: r.thumbnail_url && origin ? `${origin}${r.thumbnail_url}` : r.thumbnail_url,
        })),
      };
    },
  );

  tool(
    'store_add',
    {
      title: 'Add store model',
      description:
        "Insert a store model (an id from store_search) into the project as one undo step: wrapped in an EMPTY root with its origin at the base centre, standing on the ground at location (default: the 3D cursor), turned by rotation_deg about Z and scaled to height_m, width_m or depth_m when given; its licence and author are recorded on the root. params builds a built-in model with its own parameters (store_search lists them). External models are downloaded (and cached) first: NOT_DOWNLOADABLE when the licence or provider does not allow it, NEEDS_KEY when the server lacks the provider's key.",
      annotations: { ...EDIT, openWorldHint: true },
    },
    {
      project: projectArg,
      model: z
        .string()
        .min(1)
        .max(500)
        .describe("Model id from store_search ('<provider>:<id>', e.g. 'builtin:oak-tree')"),
      location: vec3.optional().describe('Where its base centre goes (default: the 3D cursor)'),
      rotation_deg: z
        .number()
        .min(-3600)
        .max(3600)
        .optional()
        .describe('Rotation about Z in degrees (models face −Y)'),
      height_m: size('Height'),
      width_m: size('Width (X)'),
      depth_m: size('Depth (Y)'),
      name: z.string().min(1).max(64).optional().describe('Name of the root object'),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, 'expected a colour as #rrggbb')
        .optional()
        .describe('Main colour as #rrggbb (built-in models)'),
      params: z
        .record(z.string().min(1).max(64), z.unknown())
        .optional()
        .describe(
          "The model's own parameters (built-in models; its store_search result lists them as JSON schema, e.g. {seats: 2} for builtin:sofa)",
        ),
    },
    async ({ project, model, ...opts }, extra) => {
      // the project first: an unknown project fails before anything is downloaded; its document is
      // what the memory check counts before the model's files are read
      const target = await ctx.agent.project(project);
      const call = await ctx.store.prepareInsert(model, opts, { signal: extra.signal, doc: target.scene });
      // again after the download (cached): the session may have let the project go meanwhile
      const p = await ctx.agent.project(project);
      const res = p.run(call.operator, call.params);
      if (!res.ok) throw new ToolError(`${call.operator} failed: ${res.error ?? 'unknown error'}`, res.code);
      // the operator's result once (without the catalog entry and warnings core's store.add repeats),
      // the model's credit with its thumbnail as a link on this server, like store_search's
      const warnings = [
        ...call.warnings,
        ...res.reports.filter((r) => r.level !== 'INFO').map((r) => r.message),
      ];
      return { ...insertReply(res.result, call.entry, warnings, baseUrl(extra)) };
    },
  );
}
