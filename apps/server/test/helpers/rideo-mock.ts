import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { z } from 'zod';
import { cameraMoveOf, toEditor } from '@3d-editor/core';

/*
 * A stand-in for the rideo routes the bridge uses, faithful to rideo's own (docs/api/rest.md,
 * packages/server/src/http/routes.ts, domain/{projects,storyboard,story,clips}.ts and the schemas in
 * packages/shared/src/schemas): errors are RFC 9457 problem details with rideo's codes; a missing
 * document answers 422 validation_error "no document at <path>" (projects.ts getDoc), an unknown
 * project 404 not_found, a malformed project id 422 (routes.ts IdParam); the blocking route answers
 * {blocking, state, draft, issues, lines}; a PUT of the blocking of an approved clip answers 409
 * conflict, and a stored blocking gives each shot its camera's lens and, when the shot has no move
 * yet, the move its blocked camera's end makes (storyboard.ts setBlocking); an upload with a probe
 * makes a ready video resource (201); a shot PATCH is parsed as rideo parses it, with its camera
 * through CameraSchema.partial() (whose framing and movement still default to medium and static,
 * zod 4) merged over the shot's, and validates its motion reference against the project's
 * resources (story.ts addResource, clips.ts updateShot); GET /api/config lists the video models'
 * limits (`setVideoModels`). What rideo computes with its solver (the completed draft's cameras,
 * issues, blocking lines) is simplified: the draft of a clip without blocking is the cast in a row
 * 1.2 m apart with a front camera, and issues and lines are what the test sets (`setIssues`,
 * `setLines`), else none and a placeholder line.
 *
 * Use it in-process as the bridge's fetch (`mock.fetch`), or as a real server (`await mock.listen()`).
 */

const PROJECT_ID = /^prj_[0-9a-z]{10,32}$/;
const ID = /^[a-z]{3}_[0-9a-z]{10,32}$/;
const MOVES = new Set([
  'locked_off',
  'push_in',
  'pull_out',
  'dolly_left',
  'dolly_right',
  'pan_left',
  'pan_right',
  'tilt_up',
  'tilt_down',
  'tracking_follow',
  'steadicam_walk',
  'orbit_left',
  'orbit_right',
  'crane_up',
  'crane_down',
  'whip_pan',
  'handheld',
  'dolly_zoom',
  'drone_flyover',
  'rack_focus',
]);
const PALETTE = ['#ff8a3d', '#3d8bff', '#3dbe6b', '#a35bff', '#f2c230', '#ff5fa2', '#2ec4c4', '#e5484d'];

/** rideo's CameraSchema (packages/shared/src/schemas/clip.ts), zod 4 like rideo's. */
export const RideoCameraSchema = z.object({
  framing: z
    .enum([
      'extreme_wide',
      'wide',
      'medium',
      'medium_close',
      'close_up',
      'extreme_close_up',
      'over_shoulder',
      'pov',
      'insert',
    ])
    .default('medium'),
  movement: z
    .enum([
      'static',
      'pan',
      'tilt',
      'dolly_in',
      'dolly_out',
      'tracking',
      'handheld',
      'crane',
      'zoom',
      'orbit',
    ])
    .default('static'),
  lensMm: z.number().int().min(8).max(800).nullish(),
  aperture: z.number().min(0.7).max(32).nullish(),
  move: z.enum([...MOVES] as [string, ...string[]]).nullish(),
});

/** The camera of rideo's ShotUpdateInputSchema (schemas/api.ts): CameraSchema.partial(). */
export const RideoCameraUpdateSchema = RideoCameraSchema.partial();

type Doc = Record<string, any>;

/** One rideo project of the mock: its documents by kind and id. */
export interface MockProject {
  project: Doc;
  clips: Map<string, Doc>;
  characters: Map<string, Doc>;
  elements: Map<string, Doc>;
  resources: Map<string, Doc>;
}

export interface MockRequestLog {
  method: string;
  path: string;
  status: number;
  authorization: string | null;
}

export interface MockUpload {
  project: string;
  fields: Record<string, string>;
  file: { filename: string; type: string; bytes: Uint8Array } | null;
  poster: { filename: string; type: string; bytes: Uint8Array } | null;
  status: number;
  resource: Doc | null;
}

export interface MockFailure {
  method?: string;
  /** Matched against the path (without the query). */
  path: RegExp;
  status: number;
  code?: string;
  detail?: string;
  /** How many requests fail (default 1). */
  times?: number;
  retryAfter?: string;
}

/** rideo's ids: a prefix and 16 base32 characters (deterministic here). */
export function rideoId(prefix: string, n: number): string {
  return `${prefix}_${n.toString(36).padStart(16, '0')}`;
}

function problem(status: number, code: string, detail: string, errors: unknown[] = []): Response {
  const title = code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return new Response(
    JSON.stringify({ type: `urn:rideo:problem:${code}`, title, status, detail, code, errors }),
    {
      status,
      headers: { 'content-type': 'application/problem+json' },
    },
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const isObject = (v: unknown): v is Doc => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** Why a SceneBlocking v1 does not validate (a subset of rideo's SceneBlockingSchema), or null. */
export function blockingProblem(b: Doc): string | null {
  if (b.version !== undefined && b.version !== 1) return 'version: Invalid input: expected 1';
  const actors = b.actors ?? [];
  if (!Array.isArray(actors) || actors.length > 8) return 'actors: at most 8 actors';
  for (const [i, a] of actors.entries()) {
    if (!isObject(a) || typeof a.id !== 'string' || !ID.test(String(a.characterId)))
      return `actors.${i}: an actor needs an id and a characterId`;
    if (!/^#[0-9a-fA-F]{6}$/.test(String(a.color))) return `actors.${i}.color: a #rrggbb colour`;
    if (!num(a.x, -500, 500) || !num(a.z, -500, 500)) return `actors.${i}: x and z within ±500`;
    if (a.heightM !== undefined && !num(a.heightM, 0.3, 4)) return `actors.${i}.heightM: 0.3–4`;
  }
  const props = b.props ?? [];
  if (!Array.isArray(props) || props.length > 16) return 'props: at most 16 props';
  if (b.set !== undefined) {
    if (!isObject(b.set)) return 'set: an object';
    const lm = b.set.landmarks ?? [];
    if (!Array.isArray(lm) || lm.length > 24) return 'set.landmarks: at most 24';
  }
  const shots = b.shots ?? {};
  if (!isObject(shots)) return 'shots: a record';
  for (const [id, s] of Object.entries(shots)) {
    const c = isObject(s) ? s.camera : null;
    if (!isObject(c)) return `shots.${id}.camera: required`;
    for (const k of ['x', 'z', 'targetX', 'targetZ'])
      if (!num(c[k], -500, 500)) return `shots.${id}.camera.${k}: within ±500`;
    for (const k of ['y', 'targetY']) if (!num(c[k], -10, 200)) return `shots.${id}.camera.${k}: −10…200`;
    if (!num(c.lensMm, 8, 800)) return `shots.${id}.camera.lensMm: 8–800`;
  }
  return null;
}

/** The move of the library a blocked camera's end makes (blocking/index.ts cameraMoveOf), or null. */
function blockedMove(c: Doc): string | null {
  const end = c.end;
  if (!isObject(end)) return null;
  const at = (p: Doc) => ({
    position: toEditor({ x: p.x, y: p.y, z: p.z }),
    target: toEditor({ x: p.targetX, y: p.targetY, z: p.targetZ }),
  });
  return cameraMoveOf(at(c), at(end));
}

/** The fixture: a 16:9 project (160×90 at 24 fps) with a kite scene of three short shots. */
export function kiteFixture(opts: { deskEnabled?: boolean; blocked?: boolean } = {}) {
  const ids = {
    project: rideoId('prj', 1),
    clip: rideoId('clp', 2),
    rosie: rideoId('chr', 3),
    clover: rideoId('chr', 4),
    kite: rideoId('ele', 5),
    meadow: rideoId('ele', 6),
    s1: rideoId('sht', 7),
    s2: rideoId('sht', 8),
    s3: rideoId('sht', 9),
    scene: rideoId('scn', 10),
  };
  const at = '2026-11-01T10:00:00.000Z';
  const lock = { locked: true, version: 1 };
  const project: Doc = {
    schemaVersion: 1,
    id: ids.project,
    kind: 'story',
    title: 'Kite day',
    createdAt: at,
    brief: { prompt: 'Rosie flies a kite while Clover watches', attachmentResourceIds: [], adapted: null },
    settings: {
      aspectRatio: '16:9',
      resolution: { width: 160, height: 90 },
      fps: 24,
      blocking: { enabled: opts.deskEnabled ?? true, layoutImage: true },
    },
    workflow: { stage: 'production', approvals: {} },
    access: null,
  };
  const character = (id: string, name: string, summary: string, identity: Doc): Doc => ({
    id,
    name,
    role: 'protagonist',
    summary,
    identity: { age: '', gender: '', build: '', face: '', hair: '', eyes: '', skin: '', ...identity },
    wardrobe: [],
    references: [],
    seed: 7,
    lock,
  });
  const element = (id: string, kind: string, name: string, description: string): Doc => ({
    id,
    kind,
    name,
    description,
    aliases: [],
    references: [],
    seed: 9,
    lock,
  });
  const shot = (id: string, index: number, durationSec: number, camera: Doc, extra: Doc = {}): Doc => ({
    id,
    index,
    description: `Shot ${index + 1} of the kite scene`,
    action: '',
    camera: { framing: 'medium', movement: 'static', ...camera },
    characterIds: [ids.rosie, ids.clover],
    elementIds: [ids.kite, ids.meadow],
    wardrobe: {},
    dialogue: [],
    durationSec,
    continuity: 'cut',
    endState: '',
    layout: [],
    promptOverride: null,
    negativePrompt: null,
    startFrame: { mode: 'auto', resourceId: null },
    endFrame: { mode: 'none', description: '', resourceId: null },
    motionReference: null,
    seed: null,
    status: 'planned',
    takes: [],
    selectedTakeId: null,
    board: null,
    lastError: null,
    ...extra,
  });
  const cam = (x: number, y: number, z: number, ty: number, lensMm: number, end: Doc | null = null) => ({
    x,
    y,
    z,
    targetX: 0,
    targetY: ty,
    targetZ: 0,
    lensMm,
    end,
  });
  const blocking: Doc = {
    version: 1,
    source: 'user',
    updatedAt: at,
    set: {
      width: 12,
      depth: 10,
      ground: 'meadow grass',
      interior: false,
      sun: { azimuthDeg: 135, elevationDeg: 40 },
      landmarks: [
        {
          id: 'l1',
          label: 'meadow',
          shape: 'box',
          x: 0,
          z: -4,
          width: 10,
          depth: 1,
          height: 0.3,
          rotationDeg: 0,
          color: '#7fae5a',
          elementId: ids.meadow,
        },
      ],
    },
    actors: [
      {
        id: 'a1',
        characterId: ids.rosie,
        color: PALETTE[0],
        heightM: 1.2,
        x: -0.8,
        z: 0,
        facingDeg: 0,
        pose: 'stand',
      },
      {
        id: 'a2',
        characterId: ids.clover,
        color: PALETTE[1],
        heightM: 1.3,
        x: 1,
        z: 0,
        facingDeg: 270,
        pose: 'stand',
      },
    ],
    props: [
      {
        id: 'p1',
        elementId: ids.kite,
        label: 'kite',
        x: -0.6,
        z: 0.2,
        size: 0.8,
        color: '#e5484d',
        heldBy: ids.rosie,
      },
    ],
    shots: {
      [ids.s1]: {
        marks: {},
        camera: cam(0, 1.5, 6, 1, 24),
        spec: { subjects: [], angle: 'front', height: 'eye', move: 'none' },
      },
      [ids.s2]: {
        marks: { [ids.rosie]: { x: -0.8, z: 0, facingDeg: 20, pose: 'walk', toX: 0.4, toZ: 0.6 } },
        camera: cam(0.5, 1.3, 3, 1, 50, { x: 0.5, y: 1.3, z: 2, targetX: 0, targetY: 1, targetZ: 0 }),
        spec: { subjects: [ids.rosie], angle: 'three_quarter_left', height: 'eye', move: 'push_in' },
      },
      [ids.s3]: {
        marks: {},
        camera: cam(-2, 1.4, 4, 1.1, 35),
        spec: { subjects: [], angle: 'three_quarter_right', height: 'eye', move: 'none' },
      },
    },
  };
  const clip: Doc = {
    id: ids.clip,
    index: 0,
    sceneId: ids.scene,
    title: 'Kite in the meadow',
    status: 'planned',
    shots: [
      shot(ids.s1, 0, 0.5, { framing: 'wide', lensMm: 24 }),
      shot(ids.s2, 1, 0.5, { framing: 'medium', movement: 'dolly_in', lensMm: 50, move: 'push_in' }),
      shot(ids.s3, 2, 0.5, { framing: 'medium', lensMm: 35 }),
    ],
    approvedAt: null,
    approvedBy: null,
    notes: '',
    review: null,
    blocking: opts.blocked === false ? null : blocking,
    boardReview: null,
  };
  const data: MockProject = {
    project,
    clips: new Map([[ids.clip, clip]]),
    characters: new Map([
      [ids.rosie, character(ids.rosie, 'Rosie', 'A young panda who loves kites', { height: '1.2 m' })],
      [ids.clover, character(ids.clover, 'Clover', 'A small grey pony, Rosie’s friend', { build: 'pony' })],
    ]),
    elements: new Map([
      [ids.kite, element(ids.kite, 'prop', 'Kite', 'A red diamond kite with a long tail')],
      [ids.meadow, element(ids.meadow, 'location', 'Meadow', 'A wide summer meadow')],
    ]),
    resources: new Map(),
  };
  return { ids, data, blocking };
}

/** The rideo mock (see the module comment). */
export class RideoMock {
  readonly projects = new Map<string, MockProject>();
  readonly requests: MockRequestLog[] = [];
  readonly uploads: MockUpload[] = [];
  readonly puts: { project: string; clip: string; body: Doc }[] = [];
  readonly patches: { project: string; clip: string; shot: string; body: Doc }[] = [];
  /** Blocking lines rideo answers, by clip and shot id (what rideo's solver would compute). */
  readonly lines = new Map<string, Record<string, string | null>>();
  /** Blocking issues rideo answers, by clip (what rideo's checks would find). */
  readonly issues = new Map<string, Doc[]>();
  /** GET /api/config's video models (null: the route answers 404, as an older rideo). */
  videoModels: { id: string; limits?: Doc | null }[] | null = null;
  private failures: (MockFailure & { left: number })[] = [];
  private server: Server | null = null;
  private counter = 100;
  url = '';

  /** `token`: the Bearer token every request must carry (null: none). */
  constructor(public token: string | null = null) {}

  add(p: MockProject): MockProject {
    this.projects.set(p.project.id as string, p);
    return p;
  }

  /** Makes the next matching requests fail with a status (429/503 with Retry-After …). */
  failNext(f: MockFailure): void {
    this.failures.push({ ...f, left: f.times ?? 1 });
  }

  setLines(clip: string, lines: Record<string, string | null>): void {
    this.lines.set(clip, lines);
  }

  /** rideo's issues of a clip's blocking (BlockingIssueSchema: code, severity, shotId, characterId, message). */
  setIssues(clip: string, issues: Doc[]): void {
    this.issues.set(clip, issues);
  }

  /** The video models GET /api/config lists, with their limits (gateway ModelLimitsEntry). */
  setVideoModels(models: { id: string; limits?: Doc | null }[] | null): void {
    this.videoModels = models;
  }

  /** The fetch of the bridge, served in-process. */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    let res: Response;
    try {
      res = await this.route(req);
    } catch (err) {
      res = problem(500, 'internal_error', err instanceof Error ? err.message : String(err));
    }
    this.requests.push({
      method: req.method,
      path: new URL(req.url).pathname,
      status: res.status,
      authorization: req.headers.get('authorization'),
    });
    return res;
  };

  /** Serves the mock on 127.0.0.1 (a free port); returns its base URL. */
  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.serve(req)
        .then(async (r) => {
          res.writeHead(r.status, Object.fromEntries(r.headers));
          res.end(Buffer.from(await r.arrayBuffer()));
        })
        .catch((err: unknown) => {
          res.writeHead(500);
          res.end(String(err));
        });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    this.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    return this.url;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private async serve(req: IncomingMessage): Promise<Response> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    return this.fetch(`http://mock${req.url ?? '/'}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
  }

  private nextId(prefix: string): string {
    return rideoId(prefix, ++this.counter);
  }

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    for (const f of this.failures)
      if (f.left > 0 && f.path.test(path) && (!f.method || f.method === req.method)) {
        f.left--;
        const res = problem(
          f.status,
          f.code ?? (f.status === 503 ? 'storage_offline' : 'rate_limited'),
          f.detail ?? 'try again',
        );
        if (f.retryAfter !== undefined) res.headers.set('retry-after', f.retryAfter);
        return res;
      }
    if (this.token && req.headers.get('authorization') !== `Bearer ${this.token}`)
      return problem(401, 'unauthorized', 'not signed in, or a missing, wrong, revoked or expired token');
    if (/^(?:\/[^/]+)*?\/api\/config$/.test(path) && req.method === 'GET')
      return this.videoModels
        ? json({ version: 'mock', features: {}, models: { image: [], video: this.videoModels, music: [] } })
        : problem(404, 'not_found', `route ${req.method} ${path} not found`);
    // rideo under a subpath serves /<subpath>/api/… (docs/design/subpath.md)
    const m = /^(?:\/[^/]+)*?\/api\/projects\/([^/]+)\/(.+)$/.exec(path);
    if (!m) return problem(404, 'not_found', `route ${req.method} ${path} not found`);
    const [, projectId, rest] = m;
    if (!PROJECT_ID.test(projectId))
      return problem(422, 'validation_error', 'Request validation failed', [
        { path: 'id', message: 'Invalid string: must match pattern /^prj_[0-9a-z]{10,32}$/' },
      ]);
    const p = this.projects.get(projectId);
    if (!p) return problem(404, 'not_found', `project ${projectId} not found`);

    if (req.method === 'GET' && rest.startsWith('docs/')) return this.getDoc(p, rest.slice(5));
    let r = /^clips\/([^/]+)\/blocking$/.exec(rest);
    if (r && req.method === 'GET') {
      const clip = p.clips.get(r[1]);
      return clip ? json(this.view(p, clip)) : problem(404, 'not_found', `clip ${r[1]} not found`);
    }
    if (r && req.method === 'PUT') return this.putBlocking(p, r[1], await req.json().catch(() => null));
    if (rest === 'uploads' && req.method === 'POST') return this.upload(p, req);
    r = /^clips\/([^/]+)\/shots\/([^/]+)$/.exec(rest);
    if (r && req.method === 'PATCH') return this.patchShot(p, r[1], r[2], await req.json().catch(() => null));
    return problem(404, 'not_found', `route ${req.method} ${path} not found`);
  }

  private getDoc(p: MockProject, docPath: string): Response {
    let doc: Doc | undefined;
    const m = /^(clips|characters|elements|resources)\/([^/]+)\.json$/.exec(docPath);
    if (docPath === 'project.json') doc = p.project;
    else if (m) {
      const maps = { clips: p.clips, characters: p.characters, elements: p.elements, resources: p.resources };
      doc = maps[m[1] as keyof typeof maps].get(m[2]);
    }
    return doc ? json(doc) : problem(422, 'validation_error', `no document at ${docPath}`);
  }

  /** The cast of a clip in order of first appearance (rideo blockingCast). */
  private cast(clip: Doc): string[] {
    const out: string[] = [];
    for (const s of [...(clip.shots as Doc[])].sort((a, b) => a.index - b.index))
      for (const id of s.characterIds as string[]) if (!out.includes(id)) out.push(id);
    return out;
  }

  private view(p: MockProject, clip: Doc): Doc {
    const cast = this.cast(clip).filter((id) => p.characters.has(id));
    const stored = clip.blocking as Doc | null;
    const shots = clip.shots as Doc[];
    let state: 'missing' | 'incomplete' | 'ready' = 'ready';
    if (!stored) state = 'missing';
    else if (
      shots.some((s) => !stored.shots?.[s.id]) ||
      cast.some((id) => !(stored.actors as Doc[]).some((a) => a.characterId === id))
    )
      state = 'incomplete';
    const draft: Doc = stored
      ? structuredClone(stored)
      : {
          version: 1,
          source: 'user',
          updatedAt: new Date().toISOString(),
          set: {
            width: 12,
            depth: 10,
            ground: 'ground',
            interior: false,
            sun: { azimuthDeg: 135, elevationDeg: 40 },
            landmarks: [],
          },
          actors: cast.map((id, i) => ({
            id: `a${i + 1}`,
            characterId: id,
            color: PALETTE[i % PALETTE.length],
            heightM: 1.7,
            x: (i - (cast.length - 1) / 2) * 1.2,
            z: 0,
            facingDeg: 0,
            pose: 'stand',
          })),
          props: [],
          shots: {},
        };
    for (const s of shots)
      draft.shots[s.id] ??= {
        marks: {},
        camera: { x: 0, y: 1.6, z: 4, targetX: 0, targetY: 1.2, targetZ: 0, lensMm: 35, end: null },
        spec: null,
      };
    const set = this.lines.get(clip.id as string);
    const lines = Object.fromEntries(
      shots.map((s) => [
        s.id,
        set && Object.hasOwn(set, s.id)
          ? set[s.id]
          : (s.characterIds as string[]).length
            ? `Blocking: mock line of ${s.id}.`
            : null,
      ]),
    );
    return { blocking: stored, state, draft, issues: this.issues.get(clip.id as string) ?? [], lines };
  }

  private putBlocking(p: MockProject, clipId: string, body: unknown): Response {
    if (
      !isObject(body) ||
      !isObject(body.blocking) ||
      (body.fix !== undefined && typeof body.fix !== 'boolean')
    )
      return problem(422, 'validation_error', 'Request validation failed', [
        { path: 'blocking', message: 'Invalid input: expected record, received undefined' },
      ]);
    const why = blockingProblem(body.blocking);
    if (why) return problem(422, 'validation_error', `invalid blocking: ${why}`);
    const clip = p.clips.get(clipId);
    if (!clip) return problem(404, 'not_found', `clip ${clipId} not found`);
    if (clip.status === 'approved')
      return problem(
        409,
        'conflict',
        `clip ${(clip.index as number) + 1} is approved; unapprove it to change its blocking`,
      );
    this.puts.push({ project: p.project.id as string, clip: clipId, body: structuredClone(body) });
    clip.blocking = {
      ...structuredClone(body.blocking),
      version: 1,
      updatedAt: new Date().toISOString(),
      source: 'user',
    };
    // the shot's lens is its camera's on the desk; a blocked move is its move when it has none
    // (storyboard.ts setBlocking)
    for (const s of clip.shots as Doc[]) {
      const c = clip.blocking.shots?.[s.id]?.camera;
      if (!isObject(c)) continue;
      if (typeof c.lensMm === 'number') s.camera = { ...s.camera, lensMm: Math.round(c.lensMm) };
      const move = blockedMove(c);
      if (move && !s.camera.move) s.camera = { ...s.camera, move };
    }
    return json(this.view(p, clip));
  }

  private async upload(p: MockProject, req: Request): Promise<Response> {
    const rec: MockUpload = {
      project: p.project.id as string,
      fields: {},
      file: null,
      poster: null,
      status: 0,
      resource: null,
    };
    this.uploads.push(rec);
    const fail = (res: Response) => {
      rec.status = res.status;
      return res;
    };
    if (!(req.headers.get('content-type') ?? '').startsWith('multipart/form-data'))
      return fail(problem(422, 'validation_error', 'multipart field "file" is required'));
    const form = await req.formData();
    for (const [k, v] of form.entries()) {
      if (typeof v === 'string') rec.fields[k] = v;
      else {
        const part = { filename: v.name, type: v.type, bytes: new Uint8Array(await v.arrayBuffer()) };
        // the first part of a name wins (routes.ts receiveUpload)
        if (k === 'file') rec.file ??= part;
        if (k === 'poster') rec.poster ??= part;
      }
    }
    if (!rec.file) return fail(problem(422, 'validation_error', 'multipart field "file" is required'));
    let meta: Doc;
    try {
      meta = {
        ...(rec.fields.kind ? { kind: rec.fields.kind } : {}),
        ...(rec.fields.role ? { role: rec.fields.role } : {}),
        ...(rec.fields.name ? { name: rec.fields.name } : {}),
        ...(rec.fields.meta ? (JSON.parse(rec.fields.meta) as Doc) : {}),
      };
    } catch {
      return fail(problem(500, 'internal_error', 'Unexpected token in JSON'));
    }
    const probe = meta.probe as Doc | undefined;
    if (
      probe !== undefined &&
      (!isObject(probe) ||
        typeof probe.formatName !== 'string' ||
        !num(probe.durationSec, 0, Number.MAX_VALUE) ||
        typeof probe.hasVideo !== 'boolean' ||
        typeof probe.hasAudio !== 'boolean' ||
        (probe.fps !== undefined && !num(probe.fps, 1e-9, 1000)) ||
        (probe.width !== undefined && !(Number.isInteger(probe.width) && probe.width > 0)))
    )
      return fail(
        problem(422, 'validation_error', 'Request validation failed', [
          { path: 'probe', message: 'Invalid input' },
        ]),
      );
    const mime = rec.file.type || 'application/octet-stream';
    const kind =
      (meta.kind as string | undefined) ??
      (mime.startsWith('video/')
        ? 'video'
        : mime.startsWith('image/')
          ? 'image'
          : mime.startsWith('audio/')
            ? 'audio'
            : null);
    if (!kind) return fail(problem(422, 'validation_error', `unsupported media type ${mime}`));
    if (probe && kind === 'video' && !probe.hasVideo)
      return fail(problem(422, 'validation_error', 'the file has no video stream'));
    const hash = createHash('sha256').update(rec.file.bytes).digest('hex');
    const name = (meta.name as string | undefined) || rec.file.filename;
    const ext = mime === 'video/mp4' ? 'mp4' : mime === 'image/jpeg' ? 'jpg' : 'bin';
    const media: Doc = {
      path: `media/uploads/${name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 48)}-${hash.slice(0, 12)}.${ext}`,
      hash,
      mime,
      size: rec.file.bytes.length,
    };
    if (probe) {
      if (probe.width) media.width = probe.width;
      if (probe.height) media.height = probe.height;
      media.durationSec = probe.durationSec;
      media.hasAudio = probe.hasAudio;
      if (probe.fps && mime.startsWith('video/')) media.fps = probe.fps;
      if (probe.videoCodec && probe.hasVideo) media.videoCodec = probe.videoCodec;
    }
    if (rec.poster)
      media.poster = { path: `media/posters/${hash.slice(0, 12)}-poster.jpg`, mime: 'image/jpeg' };
    const resource: Doc = {
      id: this.nextId('res'),
      kind,
      role: (meta.role as string | undefined) ?? (kind === 'video' ? 'reference' : 'reference'),
      name,
      media,
      createdAt: new Date().toISOString(),
      origin: 'upload',
      status: kind !== 'image' && !probe ? 'processing' : 'ready',
    };
    p.resources.set(resource.id as string, resource);
    rec.resource = resource;
    rec.status = 201;
    return json(resource, 201);
  }

  private patchShot(p: MockProject, clipId: string, shotId: string, body: unknown): Response {
    if (!isObject(body))
      return problem(422, 'validation_error', 'Request validation failed', [
        { path: '', message: 'Invalid input: expected object' },
      ]);
    const issues: { path: string; message: string }[] = [];
    const mr = body.motionReference;
    if (mr !== undefined && mr !== null) {
      if (!isObject(mr) || !ID.test(String(mr.resourceId)))
        issues.push({ path: 'motionReference.resourceId', message: 'invalid id' });
      else if (
        mr.mode !== undefined &&
        !['motion', 'pose', 'camera', 'performance'].includes(String(mr.mode))
      )
        issues.push({ path: 'motionReference.mode', message: 'Invalid option' });
    }
    // the camera as rideo parses it: CameraSchema.partial() fills framing and movement in when the
    // body leaves them out, and the result is merged over the shot's camera (clips.ts updateShot)
    let camera: Doc | null = null;
    if (body.camera !== undefined) {
      const parsed = RideoCameraUpdateSchema.safeParse(body.camera);
      if (parsed.success) camera = parsed.data;
      else
        for (const i of parsed.error.issues)
          issues.push({ path: ['camera', ...i.path].join('.'), message: i.message });
    }
    if (issues.length) return problem(422, 'validation_error', 'Request validation failed', issues);
    const clip = p.clips.get(clipId);
    if (!clip) return problem(404, 'not_found', `clip ${clipId} not found`);
    const shot = (clip.shots as Doc[]).find((s) => s.id === shotId);
    if (!shot) return problem(404, 'not_found', `shot ${shotId} not found`);
    if (isObject(mr)) {
      const r = p.resources.get(String(mr.resourceId));
      if (!r) return problem(404, 'not_found', `resource ${String(mr.resourceId)} not found`);
      if (r.kind !== 'video')
        return problem(
          422,
          'validation_error',
          `the motion reference must be a video resource, not ${r.kind}`,
        );
      if (r.status !== 'ready')
        return problem(422, 'validation_error', `the motion reference: resource ${r.name} is not ready`);
    }
    this.patches.push({
      project: p.project.id as string,
      clip: clipId,
      shot: shotId,
      body: structuredClone(body),
    });
    const known = [
      'description',
      'action',
      'characterIds',
      'elementIds',
      'durationSec',
      'continuity',
      'motionReference',
      'seed',
    ];
    for (const k of known)
      if (body[k] !== undefined)
        shot[k] =
          k === 'motionReference' && isObject(mr)
            ? { resourceId: mr.resourceId, mode: mr.mode ?? 'motion' }
            : body[k];
    if (camera) shot.camera = { ...shot.camera, ...camera };
    if (shot.index === 0) shot.continuity = 'cut';
    return json(clip);
  }
}
