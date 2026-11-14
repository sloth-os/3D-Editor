import type { z } from 'zod';
import { ToolError } from '../mcp/agent';
import {
  RIDEO_ID_PATTERN,
  RIDEO_PROJECT_ID_PATTERN,
  blockingViewSchema,
  probeSchema,
  problemSchema,
  rideoCharacterSchema,
  rideoClipSchema,
  rideoConfigSchema,
  rideoElementSchema,
  rideoProjectSchema,
  rideoResourceSchema,
  type RideoBlockingView,
  type RideoCharacter,
  type RideoClip,
  type RideoConfig,
  type RideoElement,
  type RideoProbe,
  type RideoProject,
  type RideoResource,
} from './schemas';

/*
 * A typed client of the rideo REST routes the bridge uses (rideo docs/api/rest.md,
 * packages/server/src/http/routes.ts):
 *   GET   /api/config                                   the gateway's video models and their limits
 *   GET   /api/projects/:id/docs/project.json | clips/<id>.json | characters/<id>.json | elements/<id>.json
 *   GET   /api/projects/:id/clips/:clipId/blocking      {blocking, state, draft, issues, lines}
 *   PUT   /api/projects/:id/clips/:clipId/blocking      {blocking, fix}  (409 for an approved clip)
 *   POST  /api/projects/:id/uploads                     multipart: file, poster, kind, role, name, meta
 *   PATCH /api/projects/:id/clips/:clipId/shots/:shotId {motionReference, camera}
 * Bearer auth, answers validated with zod, 429 and 503 (rideo's storage_offline is retryable) retried
 * with exponential backoff or the server's Retry-After, and every failure a RideoError that names the
 * request, rideo's status, code and detail (never the token). rideo has no "get clip" route: documents
 * are read through /docs, and a missing document answers 422 validation_error ("no document at …").
 */

/** Attempts after the first for a 429 or 503 answer (and for a network failure of an idempotent request). */
export const DEFAULT_RETRIES = 4;
/** First wait before a retry (ms); it doubles each time up to {@link MAX_BACKOFF_MS}. */
export const DEFAULT_BACKOFF_MS = 500;
export const MAX_BACKOFF_MS = 8000;
/** Longest Retry-After the client honours (ms); longer ones are cut to it. */
export const MAX_RETRY_AFTER_MS = 30_000;
/** How long a JSON request may take, and an upload (the clip goes up in the body). */
export const REQUEST_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 300_000;
/** Characters of rideo's error detail kept in messages. */
const DETAIL_CHARS = 300;

/** A failed rideo request. */
export class RideoError extends Error {
  constructor(
    message: string,
    /** e.g. 'GET /api/projects/prj_…/docs/project.json' */
    readonly request: string,
    /** rideo's HTTP status (null: no answer: unreachable, timed out or stopped). */
    readonly status: number | null,
    /** rideo's problem code (validation_error, conflict, not_found …), when it gave one. */
    readonly code: string | null = null,
    /** rideo's problem detail, cut to a few hundred characters. */
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'RideoError';
  }
}

/**
 * The ToolError a rideo failure becomes in the tools and routes, coded by what the caller can do
 * about it (only an outage is UPSTREAM, which REST answers 503 and agents retry):
 *  - 401 and 403, a token rideo refuses or a role that does not allow it: NEEDS_KEY;
 *  - 404, an unknown project, clip or shot, and 422 to a document read ("no document at …"): NOT_FOUND;
 *  - another 400 or 422, a request rideo does not accept: INVALID_PARAMS;
 *  - 409, a clip whose state does not allow it (approved): POLL_FAILED;
 *  - 5xx, a 429 still there after the retries, no answer at all: UPSTREAM.
 */
export function rideoToolError(err: RideoError): ToolError {
  const status = err.status;
  if (status === 401 || status === 403) return new ToolError(err.message, 'NEEDS_KEY');
  if (status === 404) return new ToolError(err.message, 'NOT_FOUND');
  if (status === 422 && /^GET \S*\/docs\//.test(err.request)) return new ToolError(err.message, 'NOT_FOUND');
  if (status === 400 || status === 422) return new ToolError(err.message, 'INVALID_PARAMS');
  if (status === 409) return new ToolError(err.message, 'POLL_FAILED');
  return new ToolError(err.message, 'UPSTREAM');
}

/** A file to upload as a rideo resource (POST /uploads). */
export interface RideoUpload {
  /** The clip's bytes (sent as a Blob of type video/mp4). */
  file: Uint8Array;
  filename: string;
  /** The first frame as JPEG (rideo stores posters as image/jpeg), or null. */
  poster?: Uint8Array | null;
  name: string;
  probe: RideoProbe;
}

/**
 * A shot's camera as a PATCH sends it: the whole camera. rideo parses the PATCH's camera with
 * CameraSchema.partial() (api.ts ShotUpdateInputSchema), which in zod 4 still fills in the defaults
 * of the fields left out (framing 'medium', movement 'static'), and merges the result over the
 * shot's camera (clips.ts updateShot): a camera of `{move}` alone would reset the shot's framing and
 * movement. So framing and movement are required here, sent as the shot has them.
 */
export interface RideoCameraPatch {
  framing: string;
  movement: string;
  lensMm?: number | null;
  aperture?: number | null;
  move?: string | null;
  [field: string]: unknown;
}

/** What a shot PATCH may change (rideo api.ts ShotUpdateInputSchema, partial). */
export interface RideoShotPatch {
  motionReference?: { resourceId: string; mode: 'motion' | 'pose' | 'camera' } | null;
  camera?: RideoCameraPatch;
}

export interface RideoClientOptions {
  /** rideo's base URL (with its subpath, if any); a trailing /api is accepted. */
  url: string;
  /** Bearer token (RIDEO_API_TOKEN or an agent token rdo_…); null: no Authorization header. */
  token?: string | null;
  fetchImpl?: typeof fetch;
  retries?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  /** Waits between attempts (tests make it instant); rejects when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Stops every request of the client (the server shuts down, the caller went away). */
  signal?: AbortSignal;
}

/**
 * The origin and path rideo is served under, without trailing slashes or a trailing /api (paths are
 * appended as /api/…). Throws INVALID_PARAMS for anything but an http(s) URL without credentials.
 */
export function rideoBaseUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new ToolError(
      `rideo url '${url}' is not a URL (expected http(s)://host[/subpath])`,
      'INVALID_PARAMS',
    );
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new ToolError(
      `rideo url must be http or https, not ${u.protocol.replace(/:$/, '')}`,
      'INVALID_PARAMS',
    );
  if (u.username || u.password)
    throw new ToolError(
      'rideo url must not carry credentials: pass the token as rideo.token',
      'INVALID_PARAMS',
    );
  const pathname = u.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
  return `${u.origin}${pathname}`;
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const done = () => {
      signal?.removeEventListener('abort', stop);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/** The wait a Retry-After header asks for (seconds or an HTTP date), capped; null without one. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const s = header.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.min(MAX_RETRY_AFTER_MS, Math.round(Number(s) * 1000));
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, t - now)) : null;
}

/** A short text of an error body: rideo's problem detail, else the body's text without markup. */
function summary(text: string): { code: string | null; detail: string | null } {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON (a proxy's HTML page …)
  }
  const p = problemSchema.safeParse(parsed);
  if (p.success && (p.data.detail || p.data.code || p.data.title)) {
    const errors = (p.data.errors ?? [])
      .slice(0, 3)
      .map((e) => {
        const o = e as { path?: unknown; message?: unknown };
        return typeof o?.message === 'string' ? `${o.path ? `${String(o.path)}: ` : ''}${o.message}` : null;
      })
      .filter((e): e is string => !!e);
    const detail = [p.data.detail ?? p.data.title ?? '', ...errors].filter(Boolean).join('; ');
    return { code: p.data.code ?? null, detail: detail ? detail.slice(0, DETAIL_CHARS) : null };
  }
  const plain = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { code: null, detail: plain ? plain.slice(0, DETAIL_CHARS) : null };
}

/** What to add to a message so the caller knows what to do about a status. */
function hint(status: number, code: string | null): string {
  if (status === 401) return ' (check RIDEO_TOKEN or pass rideo.token)';
  if (status === 403) return " (the token's role in that rideo project does not allow it)";
  if (status === 503 && code === 'storage_offline')
    return ' (the rideo project is kept in a browser with no tab open: open it in rideo and try again)';
  return '';
}

/** The rideo routes the bridge uses (see the module comment). */
export class RideoClient {
  readonly baseUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly signal: AbortSignal | undefined;

  constructor(opts: RideoClientOptions) {
    this.baseUrl = rideoBaseUrl(opts.url);
    this.token = opts.token?.trim() || null;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.retries = Math.max(0, opts.retries ?? DEFAULT_RETRIES);
    this.backoffMs = Math.max(0, opts.backoffMs ?? DEFAULT_BACKOFF_MS);
    this.maxBackoffMs = Math.max(this.backoffMs, opts.maxBackoffMs ?? MAX_BACKOFF_MS);
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.uploadTimeoutMs = opts.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS;
    this.sleep = opts.sleep ?? sleepFor;
    this.signal = opts.signal;
  }

  /** project.json: the settings (fps, resolution, aspect ratio, the desk's settings). */
  project(projectId: string): Promise<RideoProject> {
    return this.get(`${this.projectPath(projectId)}/docs/project.json`, rideoProjectSchema);
  }

  /** /api/config: the studio's configuration, read for its video models' duration limits. */
  config(): Promise<RideoConfig> {
    return this.get('/api/config', rideoConfigSchema);
  }

  /** clips/<id>.json: the clip's shots (durations, cameras, cast, layout, references, boards). */
  clip(projectId: string, clipId: string): Promise<RideoClip> {
    return this.get(
      `${this.projectPath(projectId)}/docs/clips/${this.id(clipId, 'clip')}.json`,
      rideoClipSchema,
    );
  }

  /** characters/<id>.json */
  character(projectId: string, characterId: string): Promise<RideoCharacter> {
    return this.get(
      `${this.projectPath(projectId)}/docs/characters/${this.id(characterId, 'character')}.json`,
      rideoCharacterSchema,
    );
  }

  /** elements/<id>.json */
  element(projectId: string, elementId: string): Promise<RideoElement> {
    return this.get(
      `${this.projectPath(projectId)}/docs/elements/${this.id(elementId, 'element')}.json`,
      rideoElementSchema,
    );
  }

  /** The clip's blocking as rideo's desk shows it: stored blocking, state, completed draft, issues, lines. */
  blocking(projectId: string, clipId: string): Promise<RideoBlockingView> {
    return this.get(this.blockingPath(projectId, clipId), blockingViewSchema);
  }

  /**
   * Stores a SceneBlocking v1 as the clip's blocking (`fix: false` keeps its cameras where they are)
   * and answers the view of it; 409 conflict when the clip is approved, 422 when it does not validate.
   */
  putBlocking(
    projectId: string,
    clipId: string,
    blocking: Record<string, unknown>,
    opts: { fix?: boolean } = {},
  ): Promise<RideoBlockingView> {
    return this.send('PUT', this.blockingPath(projectId, clipId), blockingViewSchema, {
      json: { blocking, fix: opts.fix ?? false },
      idempotent: true,
    });
  }

  /**
   * Uploads a clip as a video resource (role reference) with its probe, so rideo makes it ready at
   * once, and its poster; 201 with the Resource. Never retried after a network failure (it could
   * have been stored), only for 429 and 503 answers.
   */
  upload(projectId: string, up: RideoUpload): Promise<RideoResource> {
    const probe = probeSchema.parse(up.probe);
    const form = () => {
      const f = new FormData();
      // the bytes are never shared memory (files read from disk)
      f.append('file', new Blob([up.file as Uint8Array<ArrayBuffer>], { type: 'video/mp4' }), up.filename);
      if (up.poster?.length)
        f.append(
          'poster',
          new Blob([up.poster as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }),
          'poster.jpg',
        );
      f.append('kind', 'video');
      f.append('role', 'reference');
      f.append('name', up.name.slice(0, 300));
      f.append('meta', JSON.stringify({ probe }));
      return f;
    };
    return this.send('POST', `${this.projectPath(projectId)}/uploads`, rideoResourceSchema, {
      form,
      idempotent: false,
      timeoutMs: this.uploadTimeoutMs,
    });
  }

  /** Changes a shot (its motion reference and camera move); answers the clip. */
  patchShot(projectId: string, clipId: string, shotId: string, patch: RideoShotPatch): Promise<RideoClip> {
    const path = `${this.projectPath(projectId)}/clips/${this.id(clipId, 'clip')}/shots/${this.id(shotId, 'shot')}`;
    return this.send('PATCH', path, rideoClipSchema, { json: patch, idempotent: true });
  }

  // ---------------------------------------------------------------- requests

  private projectPath(projectId: string): string {
    if (!RIDEO_PROJECT_ID_PATTERN.test(projectId))
      throw new ToolError(
        `'${projectId}' is not a rideo project id (prj_ followed by 10–32 letters or digits)`,
        'INVALID_PARAMS',
      );
    return `/api/projects/${projectId}`;
  }

  private id(id: string, what: string): string {
    if (!RIDEO_ID_PATTERN.test(id))
      throw new ToolError(
        `'${id}' is not a rideo ${what} id (a 3-letter prefix, _ and 10–32 letters or digits)`,
        'INVALID_PARAMS',
      );
    return id;
  }

  private blockingPath(projectId: string, clipId: string): string {
    return `${this.projectPath(projectId)}/clips/${this.id(clipId, 'clip')}/blocking`;
  }

  private get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return this.send('GET', path, schema, { idempotent: true });
  }

  private backoff(attempt: number): number {
    return Math.min(this.maxBackoffMs, this.backoffMs * 2 ** attempt);
  }

  private async send<T>(
    method: 'GET' | 'PUT' | 'POST' | 'PATCH',
    path: string,
    schema: z.ZodType<T>,
    opts: { json?: unknown; form?: () => FormData; idempotent: boolean; timeoutMs?: number },
  ): Promise<T> {
    const what = `${method} ${path}`;
    const url = `${this.baseUrl}${path}`;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    for (let attempt = 0; ; attempt++) {
      if (this.signal?.aborted) throw new RideoError(`the request ${what} to rideo was stopped`, what, null);
      const headers: Record<string, string> = { accept: 'application/json' };
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      let body: string | FormData | undefined;
      if (opts.json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(opts.json);
      } else if (opts.form) body = opts.form();
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, body, signal });
      } catch (err) {
        if (this.signal?.aborted)
          throw new RideoError(`the request ${what} to rideo was stopped`, what, null);
        const timedOut = timeout.aborted;
        if (opts.idempotent && attempt < this.retries) {
          await this.wait(this.backoff(attempt), what);
          continue;
        }
        const cause =
          err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
        throw new RideoError(
          timedOut
            ? `rideo did not answer ${what} within ${Math.round(timeoutMs / 1000)} s`
            : `rideo at ${this.baseUrl} could not be reached for ${what}: ${cause}`,
          what,
          null,
        );
      }
      if ((res.status === 429 || res.status === 503) && attempt < this.retries) {
        const wait = retryAfterMs(res.headers.get('retry-after')) ?? this.backoff(attempt);
        await res.body?.cancel().catch(() => undefined);
        await this.wait(wait, what);
        continue;
      }
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        const { code, detail } = summary(text);
        throw new RideoError(
          `rideo answered ${res.status}${code ? ` ${code}` : ''} to ${what}${detail ? `: ${detail}` : ''}${hint(res.status, code)}`,
          what,
          res.status,
          code,
          detail,
        );
      }
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        throw new RideoError(`rideo answered ${what} with something that is not JSON`, what, res.status);
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; ');
        throw new RideoError(`rideo answered ${what} with an unexpected body (${issues})`, what, res.status);
      }
      return parsed.data;
    }
  }

  private async wait(ms: number, what: string): Promise<void> {
    try {
      await this.sleep(ms, this.signal);
    } catch {
      throw new RideoError(`the request ${what} to rideo was stopped`, what, null);
    }
  }
}
