import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import * as Y from 'yjs';
import { SceneDoc, defaultShot, setDeskSettings, setShots } from '@3d-editor/core';
import { updatePrefs } from '../src/app/prefs';
import { closeDialog, dialog, openDialog, serverConfig, session as sessionSignal } from '../src/app/store';
import type { ServerConfig } from '../src/app/server-config';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import type { ExportFile, ExportJob } from '../src/io/store-client';
import { DialogHost } from '../src/ui/dialogs/Dialogs';
import {
  browserJobStatusText,
  browserPreviewFile,
  buildExportParams,
  elapsedText,
  estimateExport,
  exportContext,
  exportOutputSize,
  exportSettingsProblem,
  formatBytes,
  formatSeconds,
  groupBrowserFiles,
  groupExportFiles,
  initialSettings,
  jobStatusText,
  previewFile,
  projectOnServer,
  serverExportReason,
  type ExportSettings,
} from '../src/ui/dialogs/ExportVideoDialog';
import {
  browserJob,
  cancelBrowserJob,
  clearBrowserJob,
  startBrowserJob,
  type BrowserJob,
} from '../src/ui/dialogs/browser-export-job';
import {
  BrowserExportError,
  type BrowserExportFile,
  type BrowserExportHooks,
  type BrowserExportRequest,
  type BrowserExportResult,
} from '../src/export';

/*
 * The Export Video window: its fields make the export's parameters (SPEC §9), it estimates the
 * export's frames and length, exports on this device by default (the browser export: progress,
 * Cancel, the files as download links and one zip of all), offers the server where it can export
 * the project (POST …/video-exports, followed with Cancel, files linked with the token), says why
 * this browser cannot export, and lists the project's recent server exports, which can be shown
 * again or deleted.
 */

/** The browser export as the window sees it (its engine is tested in export-engine.test.ts). */
const browser = vi.hoisted(() => ({
  support: { available: true, reason: null as string | null },
  start: null as null | ((req: unknown, hooks: unknown) => Promise<unknown>),
  zipped: [] as unknown[],
  released: [] as string[],
  /** A release that takes a while (deleting an export's directory on disk). */
  releaseWait: null as Promise<void> | null,
}));
vi.mock('../src/export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/export')>();
  return {
    ...actual,
    browserExportSupport: async () => browser.support,
    startBrowserExport: (req: unknown, hooks: unknown) => browser.start!(req, hooks),
    zipExport: async (r: unknown) => {
      browser.zipped.push(r);
      return new Blob(['zip']);
    },
    releaseBrowserExport: async (r: { id: string } | string) => {
      browser.released.push(typeof r === 'string' ? r : r.id);
      if (browser.releaseWait) await browser.releaseWait;
    },
  };
});

const SERVER: ServerConfig = {
  version: 'test',
  features: {
    sync: true,
    mcp: true,
    telemetry: false,
    webdavProxy: false,
    modelStore: true,
    videoExport: true,
  },
  webdav: null,
  persistence: 'memory',
};

/** Shot ids (16 base62 characters, as the document keeps them). */
const WIDE = 'shotWide00000001';
const CLOSE = 'shotClose0000002';

/** A project with two shots through the scene camera: Wide 1–48 and Close 49–72, at 24 fps. */
function projectDoc(shots = true): SceneDoc {
  const doc = SceneDoc.create();
  const camera = doc.listObjects().find((o) => o.type === 'CAMERA')!;
  doc.updateScene({ fps: 24, frame_start: 1, frame_end: 72 });
  if (shots)
    setShots(doc, [
      { ...defaultShot(WIDE, 'Wide', 1, 48), camera: camera.id },
      { ...defaultShot(CLOSE, 'Close', 49, 72), camera: camera.id },
    ]);
  return doc;
}

function fakeSession(doc = projectDoc(), onServer = true): ProjectSession {
  const undo = new Y.UndoManager(doc.sharedTypes(), {
    trackedOrigins: new Set([doc.origin]),
    captureTimeout: 0,
  });
  return {
    id: 'proj-1',
    doc,
    undo,
    state: new EditorStateSignals(),
    view: new ViewState(),
    revision: { value: 0 },
    title: { value: 'Kite Day' },
    provider: onServer ? { enabled: true } : null,
  } as unknown as ProjectSession;
}

const settings = (doc: SceneDoc, patch: Partial<ExportSettings> = {}): ExportSettings => ({
  ...initialSettings(exportContext(doc)),
  ...patch,
});

function file(name: string, kind: ExportFile['kind'], extra: Partial<ExportFile> = {}): ExportFile {
  return {
    name,
    kind,
    bytes: 2048,
    url: `/api/projects/proj-1/video-exports/job-1/files/${name}`,
    sha256: 'x',
    ...extra,
  };
}

const FILES: ExportFile[] = [
  file('sequence.mp4', 'sequence', { frames: 72, duration_s: 3 }),
  file('shot-01-wide.mp4', 'clip', { shot: WIDE, pass: 'beauty', frames: 48, duration_s: 2 }),
  file('shot-02-close.mp4', 'clip', { shot: CLOSE, pass: 'beauty', frames: 24, duration_s: 1 }),
  file('shot-01-wide.png', 'poster', { shot: WIDE }),
  file('sequence.depth.mp4', 'pass', { pass: 'depth', frames: 72 }),
  file('contact-sheet.png', 'contact_sheet'),
  file('manifest.json', 'manifest'),
];

function job(over: Partial<ExportJob> = {}): ExportJob {
  return {
    id: 'job-1',
    project: 'proj-1',
    label: null,
    status: 'queued',
    params: { shots: 'all' },
    created_at: '2026-11-13T10:00:00.000Z',
    started_at: null,
    finished_at: null,
    progress: { frames_done: 0, frames_total: 72, fraction: 0, fps: 0, eta_s: null, shot: null },
    error: null,
    warnings: [],
    files: [],
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe('export parameters', () => {
  beforeEach(() => localStorage.clear());

  it('exports every enabled shot at the scene size by default', () => {
    const doc = projectDoc();
    const s = settings(doc);
    expect(s.shots).toBe('all');
    expect(buildExportParams(s, exportContext(doc))).toEqual({
      shots: 'all',
      quality: 'standard',
      look: 'material',
      passes: ['beauty'],
      codec: 'h264',
      outputs: { sequence: true, clips: true, posters: true, contact_sheet: true },
    });
  });

  it('writes the ticked shots in cut order, sizes, rate, passes and the name', () => {
    const doc = projectDoc();
    const ctx = exportContext(doc);
    const p = buildExportParams(
      settings(doc, {
        shots: 'selected',
        selected: [CLOSE, WIDE],
        resolution: '720x1280',
        fps: 12,
        quality: 'draft',
        look: 'clay',
        passes: ['pose', 'beauty', 'depth'],
        codec: 'vp9',
        outputs: { sequence: false, clips: true, posters: false, contact_sheet: false },
        matchModelDuration: true,
        label: '  take 2  ',
      }),
      ctx,
    );
    expect(p).toEqual({
      shots: [WIDE, CLOSE],
      width: 720,
      height: 1280,
      fps: 12,
      quality: 'draft',
      look: 'clay',
      passes: ['beauty', 'depth', 'pose'],
      codec: 'vp9',
      outputs: { sequence: false, clips: true, posters: false, contact_sheet: false },
      match_model_duration: true,
      label: 'take 2',
    });
    // the scene's rate is the server's default: not sent
    expect(buildExportParams(settings(doc, { fps: 24 }), ctx).fps).toBeUndefined();
    // custom sizes are made even
    const custom = buildExportParams(settings(doc, { resolution: 'custom', width: 161, height: 90 }), ctx);
    expect([custom.width, custom.height]).toEqual([162, 90]);
  });

  it('exports a frame range through a camera when the scene has no shots', () => {
    const doc = projectDoc(false);
    const ctx = exportContext(doc);
    const s = settings(doc);
    expect(s.shots).toBe('range');
    expect(buildExportParams(s, ctx)).toMatchObject({ frame_start: 1, frame_end: 72 });
    expect(buildExportParams(s, ctx).shots).toBeUndefined();
    const cam = ctx.cameras[0].id;
    expect(buildExportParams({ ...s, frameStart: 10, frameEnd: 20, camera: cam }, ctx)).toMatchObject({
      frame_start: 10,
      frame_end: 20,
      camera: cam,
    });
    // a range also with shots, when asked for
    const withShots = projectDoc();
    expect(
      buildExportParams(settings(withShots, { shots: 'range' }), exportContext(withShots)),
    ).toMatchObject({
      frame_start: 1,
      frame_end: 72,
    });
  });

  it('estimates the frames and the length as the server plans them', () => {
    const doc = projectDoc();
    const ctx = exportContext(doc);
    expect(estimateExport(settings(doc), ctx)).toMatchObject({ frames: 72, seconds: 3, fps: 24, shots: 2 });
    expect(estimateExport(settings(doc, { fps: 12 }), ctx)).toMatchObject({ frames: 36, seconds: 3 });
    expect(estimateExport(settings(doc, { shots: 'selected', selected: [CLOSE] }), ctx).frames).toBe(24);
    // the video model's limits: the 2 s shot is trimmed to 1.5 s, the 1 s one stays
    setDeskSettings(doc, { max_shot_s: 1.5 });
    expect(estimateExport(settings(doc, { matchModelDuration: true }), exportContext(doc)).frames).toBe(
      36 + 24,
    );
    expect(
      estimateExport(settings(doc, { resolution: 'custom', width: 160, height: 90 }), ctx),
    ).toMatchObject({
      width: 160,
      height: 90,
    });
  });

  it("sizes the scene's output as the server does (percentage, even, at most 3840 × 2160)", () => {
    const doc = projectDoc();
    doc.updateRender({ resolution_x: 1920, resolution_y: 1080, resolution_percentage: 50 });
    expect(exportOutputSize(settings(doc), exportContext(doc))).toEqual({ width: 960, height: 540 });
    doc.updateRender({ resolution_x: 8000, resolution_y: 4000, resolution_percentage: 100 });
    expect(exportOutputSize(settings(doc), exportContext(doc))).toEqual({ width: 3840, height: 1920 });
    doc.updateRender({ resolution_x: 1001, resolution_y: 501, resolution_percentage: 100 });
    expect(exportOutputSize(settings(doc), exportContext(doc))).toEqual({ width: 1002, height: 502 });
  });

  it('says what keeps settings from exporting', () => {
    const doc = projectDoc();
    const ctx = exportContext(doc);
    expect(exportSettingsProblem(settings(doc), ctx)).toBeNull();
    expect(exportSettingsProblem(settings(doc, { shots: 'selected', selected: [] }), ctx)).toMatch(
      /Tick at least one shot/,
    );
    expect(
      exportSettingsProblem(settings(doc, { shots: 'range', frameStart: 30, frameEnd: 10 }), ctx),
    ).toMatch(/ends \(frame 10\) before it starts \(frame 30\)/);
    expect(exportSettingsProblem(settings(doc, { resolution: 'custom', width: 8, height: 90 }), ctx)).toMatch(
      /between 16 × 16 and 3840 × 2160/,
    );
    expect(exportSettingsProblem(settings(doc, { passes: [] }), ctx)).toMatch(/at least one pass/);
    expect(
      exportSettingsProblem(
        settings(doc, { outputs: { sequence: false, clips: false, posters: false, contact_sheet: false } }),
        ctx,
      ),
    ).toMatch(/at least one output/);
    expect(exportSettingsProblem(settings(doc, { fps: 0 }), ctx)).toMatch(/frame rate/);
    // a range without any camera
    const bare = SceneDoc.create({ empty: true });
    expect(exportSettingsProblem(settings(bare), exportContext(bare))).toMatch(/no camera/);
  });

  it('starts from the settings used last, and from the shots it is opened for', () => {
    const doc = projectDoc();
    localStorage.setItem(
      '3d-editor:export-video',
      JSON.stringify({
        resolution: '854x480',
        quality: 'draft',
        passes: ['depth', 'bogus'],
        codec: 'vp9',
        look: 'x',
      }),
    );
    const s = initialSettings(exportContext(doc), [CLOSE, 'gone']);
    expect(s).toMatchObject({
      resolution: '854x480',
      quality: 'draft',
      passes: ['depth'],
      codec: 'vp9',
      look: 'material',
      shots: 'selected',
      selected: [CLOSE],
    });
    localStorage.setItem('3d-editor:export-video', '{broken');
    expect(initialSettings(exportContext(doc)).quality).toBe('standard');
  });
});

describe('export files and status texts', () => {
  it('groups the files and previews the sequence (else a beauty clip)', () => {
    const g = groupExportFiles(FILES);
    expect(g.sequence.map((f) => f.name)).toEqual(['sequence.mp4']);
    expect(g.clips).toHaveLength(2);
    expect(g.posters.map((f) => f.name)).toEqual(['shot-01-wide.png']);
    expect(g.passes.map((f) => f.name)).toEqual(['sequence.depth.mp4']);
    expect(g.contactSheet).toHaveLength(1);
    expect(g.manifest).toHaveLength(1);
    expect(previewFile(FILES)?.name).toBe('sequence.mp4');
    expect(previewFile(FILES.filter((f) => f.kind !== 'sequence'))?.name).toBe('shot-01-wide.mp4');
    expect(previewFile([file('m.json', 'manifest')])).toBeNull();
  });

  it('formats lengths and sizes', () => {
    expect(formatSeconds(4.44)).toBe('4.4 s');
    expect(formatSeconds(65)).toBe('1:05');
    expect(formatSeconds(3725)).toBe('1:02:05');
    expect(formatSeconds(Number.NaN)).toBe('–');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('describes each state of a job', () => {
    const name = (id: string) => (id === WIDE ? 'Wide' : id);
    expect(jobStatusText(job(), name)).toMatch(/Waiting/);
    expect(
      jobStatusText(
        job({
          status: 'running',
          progress: { frames_done: 3, frames_total: 72, fraction: 0.04, fps: 2.5, eta_s: 27.6, shot: WIDE },
        }),
        name,
      ),
    ).toBe('Rendering frame 4 of 72 · 2.5 frames/s · about 27.6 s left · shot Wide');
    expect(jobStatusText(job({ status: 'encoding' }), name)).toMatch(/Encoding/);
    expect(jobStatusText(job({ status: 'done' }), name)).toBe('Done: 72 frames');
    expect(jobStatusText(job({ status: 'failed', error: 'ffmpeg exited 1' }), name)).toBe(
      'Failed: ffmpeg exited 1',
    );
    // how long it ran, worded so it is not read as the video's length
    expect(elapsedText('running', 12.34)).toBe('12.3 s so far');
    expect(elapsedText('encoding', 75)).toBe('1:15 so far');
    expect(elapsedText('done', 29)).toBe('took 29.0 s');
    expect(elapsedText('cancelled', 3)).toBe('after 3.0 s');
    expect(elapsedText('failed', 3)).toBe('after 3.0 s');
  });

  it('says why the server cannot export the project', () => {
    expect(serverExportReason(null, true)).toMatch(/without its server/);
    expect(
      serverExportReason({ ...SERVER, features: { ...SERVER.features, videoExport: false } }, true),
    ).toMatch(/did not find ffmpeg/);
    expect(
      serverExportReason({ ...SERVER, features: { ...SERVER.features, videoExport: undefined } }, true),
    ).toMatch(/too old/);
    expect(serverExportReason(SERVER, false)).toMatch(/kept only in this browser/);
    expect(serverExportReason(SERVER, true)).toBeNull();
    expect(projectOnServer({ provider: null })).toBe(false);
    expect(projectOnServer({ provider: { enabled: false } } as unknown as ProjectSession)).toBe(false);
    expect(projectOnServer({ provider: { enabled: true } } as unknown as ProjectSession)).toBe(true);
  });

  it("groups a device export's files, previews its sequence and describes its states", () => {
    const f = (
      name: string,
      kind: BrowserExportFile['kind'],
      pass: string | null = null,
    ): BrowserExportFile => ({
      name,
      kind,
      pass,
      shot: null,
      mime: '',
      size: 1,
      sha256: '',
      frames: null,
      duration_s: null,
      blob: async () => new Blob([]),
    });
    const files = [
      f('shot-01-wide.mp4', 'clip', 'beauty'),
      f('shot-01-wide.png', 'poster'),
      f('shot-01-wide.still.png', 'still'),
      f('contact-sheet.png', 'contact_sheet'),
      f('sequence.mp4', 'sequence', 'beauty'),
      f('sequence.mask.mp4', 'sequence', 'mask'),
      f('sequence.mask.zip', 'frames', 'mask'),
      f('manifest.json', 'manifest'),
    ];
    const g = groupBrowserFiles(files);
    expect(g.sequence.map((x) => x.name)).toEqual(['sequence.mp4']);
    expect(g.passes.map((x) => x.name)).toEqual(['sequence.mask.mp4', 'sequence.mask.zip']);
    expect(g.stills.map((x) => x.name)).toEqual(['shot-01-wide.still.png']);
    expect(browserPreviewFile(files)?.name).toBe('sequence.mp4');
    expect(browserPreviewFile(files.filter((x) => x.kind !== 'sequence'))?.name).toBe('shot-01-wide.mp4');
    const j = (over: Partial<BrowserJob>): BrowserJob => ({
      id: 1,
      project: 'p',
      projectName: 'P',
      shotNames: {},
      label: null,
      status: 'running',
      progress: null,
      fps: 0,
      startedAt: 0,
      finishedAt: null,
      result: null,
      urls: {},
      error: null,
      ...over,
    });
    const name = (id: string) => (id === WIDE ? 'Wide' : id);
    expect(browserJobStatusText(j({}), name)).toBe('Preparing the render workers…');
    expect(
      browserJobStatusText(
        j({ progress: { phase: 'render', done: 3, total: 72, shot: WIDE }, fps: 2.5 }),
        name,
      ),
    ).toBe('Rendering frame 4 of 72 · 2.5 frames/s · about 27.6 s left · shot Wide');
    expect(browserJobStatusText(j({ progress: { phase: 'encode', done: 0, total: 2 } }), name)).toBe(
      'Finishing the videos…',
    );
    expect(browserJobStatusText(j({ progress: { phase: 'finish', done: 1, total: 2 } }), name)).toBe(
      'Writing the contact sheet and the manifest…',
    );
    expect(
      browserJobStatusText(
        j({ status: 'done', result: { manifest: { frames: 72 } } as BrowserExportResult }),
        name,
      ),
    ).toBe('Done: 72 frames');
    expect(browserJobStatusText(j({ status: 'cancelled' }), name)).toBe('Cancelled');
    expect(browserJobStatusText(j({ status: 'failed', error: 'out of memory' }), name)).toBe(
      'Failed: out of memory',
    );
  });
});

describe('Export Video window', () => {
  /** The server's answers: the jobs it holds and what the next status requests return. */
  let jobs: ExportJob[];
  let statusAnswers: ExportJob[];
  let posted: unknown[];
  let deleted: string[];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://editor.test');
    const method = init?.method ?? 'GET';
    if (u.pathname === '/api/projects/proj-1/video-exports' && method === 'GET')
      return json({ exports: jobs });
    if (u.pathname === '/api/projects/proj-1/video-exports' && method === 'POST') {
      posted.push(JSON.parse(String(init?.body)));
      const j = job({ status: 'queued' });
      jobs = [j, ...jobs];
      return json(j, 202);
    }
    const m = /^\/api\/projects\/proj-1\/video-exports\/([^/]+)$/.exec(u.pathname);
    if (m && method === 'DELETE') {
      deleted.push(m[1]);
      const j = jobs.find((x) => x.id === m[1]) ?? job();
      jobs = jobs.filter((x) => x.id !== m[1]);
      return json({ ...j, status: 'cancelled' });
    }
    if (m && method === 'GET') {
      expect(u.searchParams.get('wait')).toBe('1');
      const next = statusAnswers.length > 1 ? statusAnswers.shift()! : statusAnswers[0];
      return json(next);
    }
    return json({ error: `unexpected ${method} ${url}` }, 404);
  });

  const byTestId = (c: Element, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const open = async (props: Record<string, unknown> = {}) => {
    const r = render(<DialogHost />);
    await act(() => openDialog('export-video', props));
    return r;
  };

  let urls = 0;
  beforeEach(() => {
    localStorage.clear();
    jobs = [];
    statusAnswers = [];
    posted = [];
    deleted = [];
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    serverConfig.value = SERVER;
    sessionSignal.value = fakeSession();
    updatePrefs((p) => ({ ...p, sync: { ...p.sync, serverUrl: '', token: 'tk' } }));
    browser.support = { available: true, reason: null };
    browser.start = null;
    browser.zipped = [];
    browser.released = [];
    browser.releaseWait = null;
    browserJob.value = null;
    URL.createObjectURL = vi.fn(() => `blob:test/${++urls}`);
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(async () => {
    cleanup();
    closeDialog();
    vi.unstubAllGlobals();
    serverConfig.value = null;
    sessionSignal.value = null;
    updatePrefs((p) => ({ ...p, sync: { ...p.sync, token: '' } }));
    await clearBrowserJob();
    browserJob.value = null;
  });

  /** A finished browser export of the project's two shots. */
  const browserResult = (): BrowserExportResult => {
    const f = (
      name: string,
      kind: BrowserExportFile['kind'],
      o: Partial<BrowserExportFile> = {},
    ): BrowserExportFile => ({
      name,
      kind,
      pass: null,
      shot: null,
      mime: 'video/mp4',
      size: 4096,
      sha256: 'ab',
      frames: null,
      duration_s: null,
      blob: async () => new Blob([name]),
      ...o,
    });
    return {
      id: 'local-1',
      files: [
        f('shot-01-wide.mp4', 'clip', { pass: 'beauty', shot: WIDE, frames: 48, duration_s: 2 }),
        f('shot-02-close.mp4', 'clip', { pass: 'beauty', shot: CLOSE, frames: 24, duration_s: 1 }),
        f('shot-01-wide.png', 'poster', { shot: WIDE, mime: 'image/png' }),
        f('contact-sheet.png', 'contact_sheet', { mime: 'image/png' }),
        f('sequence.mp4', 'sequence', { pass: 'beauty', frames: 72, duration_s: 3 }),
        f('manifest.json', 'manifest', { mime: 'application/json' }),
      ],
      manifest: { frames: 72, project: { id: 'proj-1', name: 'Kite Day' } },
      shots: [
        { id: WIDE, slug: 'shot-01-wide', frames: 48 },
        { id: CLOSE, slug: 'shot-02-close', frames: 24 },
      ],
      warnings: ['codec vp9: this browser cannot encode VP9 at 1920×1080, so the videos are H.264 MP4'],
    };
  };

  it('exports on this device without a server, and offers the server only where it can export the project', async () => {
    serverConfig.value = null;
    const { container } = await open();
    await waitFor(() => expect(byTestId(container, 'export-video-settings')).not.toBeNull());
    expect(byTestId(container, 'export-video-where')).toBeNull();
    expect(byTestId(container, 'export-video-recent')).toBeNull();
    expect(byTestId(container, 'export-video-where-hint')!.textContent).toMatch(
      /^This device renders the project/,
    );
    await waitFor(() =>
      expect((byTestId(container, 'export-video-start') as HTMLButtonElement).disabled).toBe(false),
    );
    // a server without ffmpeg: no server choice, its earlier exports still listed
    serverConfig.value = { ...SERVER, features: { ...SERVER.features, videoExport: false } };
    await waitFor(() => expect(byTestId(container, 'export-video-recent')).not.toBeNull());
    expect(byTestId(container, 'export-video-where')).toBeNull();
    // a project kept only in this browser: no server choice, no list
    cleanup();
    closeDialog();
    serverConfig.value = SERVER;
    sessionSignal.value = fakeSession(projectDoc(), false);
    const second = await open();
    await waitFor(() => expect(byTestId(second.container, 'export-video-settings')).not.toBeNull());
    expect(byTestId(second.container, 'export-video-where')).toBeNull();
    expect(byTestId(second.container, 'export-video-recent')).toBeNull();
  });

  it('exports on this device: progress, the files as links, one zip of all', async () => {
    let finish!: (r: BrowserExportResult) => void;
    let hooks!: BrowserExportHooks;
    const requests: BrowserExportRequest[] = [];
    browser.start = (req, h) => {
      requests.push(req as BrowserExportRequest);
      hooks = h as BrowserExportHooks;
      return new Promise((resolve) => (finish = resolve));
    };
    const { container } = await open();
    await waitFor(() =>
      expect(byTestId(container, 'export-video-where-device')!.getAttribute('aria-pressed')).toBe('true'),
    );
    fireEvent.click(byTestId(container, 'export-video-quality-draft')!);
    await waitFor(() =>
      expect((byTestId(container, 'export-video-start') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(byTestId(container, 'export-video-start')!);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].params).toEqual({
      shots: 'all',
      quality: 'draft',
      look: 'material',
      passes: ['beauty'],
      codec: 'h264',
      outputs: { sequence: true, clips: true, posters: true, contact_sheet: true },
    });
    expect(requests[0].update).toBeInstanceOf(Uint8Array);
    // the snapshot is the project's document
    const copy = new Y.Doc();
    Y.applyUpdate(copy, requests[0].update);
    expect(new SceneDoc(copy).listObjects().length).toBe(sessionSignal.value!.doc.listObjects().length);
    expect(requests[0].project).toEqual({ id: 'proj-1', name: 'Kite Day' });
    expect(posted).toEqual([]);
    await act(() => hooks.onProgress!({ phase: 'prepare', done: 1, total: 3 }));
    expect(byTestId(container, 'export-video-status')!.textContent).toMatch(/^Preparing the render workers…/);
    await act(() => hooks.onProgress!({ phase: 'render', done: 3, total: 72, shot: WIDE }));
    expect(byTestId(container, 'export-video-status')!.textContent).toMatch(
      /^Rendering frame 4 of 72 · shot Wide/,
    );
    expect(byTestId(container, 'export-video-progress')!.getAttribute('aria-valuenow')).toBe('4');
    expect(byTestId(container, 'export-video-cancel')).not.toBeNull();
    await act(async () => finish(browserResult()));
    await waitFor(() => expect(byTestId(container, 'export-video-files')).not.toBeNull());
    const link = byTestId(container, 'export-video-file-sequence.mp4') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toMatch(/^blob:test\//);
    expect(link.getAttribute('download')).toBe('sequence.mp4');
    expect(byTestId(container, 'export-video-file-shot-01-wide.mp4')!.parentElement!.textContent).toContain(
      'Wide',
    );
    expect((byTestId(container, 'export-video-preview') as HTMLVideoElement).getAttribute('src')).toBe(
      link.getAttribute('href'),
    );
    expect(byTestId(container, 'export-video-warnings')!.textContent).toContain('codec vp9');
    expect(byTestId(container, 'export-video-status')!.textContent).toMatch(/^Done: 72 frames · took /);
    const clicked: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    fireEvent.click(byTestId(container, 'export-video-download-all')!);
    await waitFor(() => expect(clicked).toEqual(['kite-day-export.zip']));
    expect(browser.zipped).toHaveLength(1);
    click.mockRestore();
    // a new export releases the files of this one
    fireEvent.click(byTestId(container, 'export-video-new')!);
    expect(byTestId(container, 'export-video-settings')).not.toBeNull();
    browser.start = () => new Promise(() => {});
    fireEvent.click(byTestId(container, 'export-video-start')!);
    await waitFor(() => expect(browser.released).toEqual(['local-1']));
  });

  it('cancels an export on this device', async () => {
    browser.start = (_req, h) =>
      new Promise((_resolve, reject) => {
        const signal = (h as BrowserExportHooks).signal!;
        signal.addEventListener('abort', () =>
          reject(new BrowserExportError('The export was cancelled', 'CANCELLED')),
        );
      });
    const { container } = await open();
    await waitFor(() =>
      expect((byTestId(container, 'export-video-start') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(byTestId(container, 'export-video-start')!);
    await waitFor(() => expect(byTestId(container, 'export-video-cancel')).not.toBeNull());
    fireEvent.click(byTestId(container, 'export-video-cancel')!);
    await waitFor(() =>
      expect(byTestId(container, 'export-video-status')!.textContent).toMatch(/^Cancelled/),
    );
    expect(byTestId(container, 'export-video-new')).not.toBeNull();
  });

  it('says why this browser cannot export, and offers the server where it can', async () => {
    browser.support = {
      available: false,
      reason: 'This browser has no WebCodecs video encoder (VideoEncoder).',
    };
    const { container } = await open();
    await waitFor(() => expect(byTestId(container, 'export-video-browser-unsupported')).not.toBeNull());
    expect(byTestId(container, 'export-video-browser-unsupported')!.textContent).toContain('no WebCodecs');
    expect((byTestId(container, 'export-video-start') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(byTestId(container, 'export-video-use-server')!);
    expect(byTestId(container, 'export-video-where-server')!.getAttribute('aria-pressed')).toBe('true');
    expect(byTestId(container, 'export-video-browser-unsupported')).toBeNull();
    statusAnswers = [job({ status: 'queued' })];
    fireEvent.click(byTestId(container, 'export-video-start')!);
    await waitFor(() => expect(posted).toHaveLength(1));
    // without the server, only the reason
    cleanup();
    closeDialog();
    serverConfig.value = null;
    const second = await open();
    await waitFor(() =>
      expect(byTestId(second.container, 'export-video-browser-unsupported')).not.toBeNull(),
    );
    expect(byTestId(second.container, 'export-video-use-server')).toBeNull();
  });

  it('starts an export on the server with the chosen settings, follows it and links its files', async () => {
    const { container } = await open();
    await waitFor(() => expect(byTestId(container, 'export-video-settings')).not.toBeNull());
    fireEvent.click(byTestId(container, 'export-video-where-server')!);
    expect(byTestId(container, 'export-video-where-hint')!.textContent).toMatch(
      /^The server renders the project/,
    );
    expect(byTestId(container, 'export-video-estimate')!.textContent).toContain(
      '72 frames · 3.0 s at 24 fps',
    );
    fireEvent.change(byTestId(container, 'export-video-resolution')!, { target: { value: '854x480' } });
    fireEvent.click(byTestId(container, 'export-video-quality-draft')!);
    fireEvent.click(byTestId(container, 'export-video-pass-depth')!);
    expect(byTestId(container, 'export-video-estimate')!.textContent).toContain('854 × 480');
    statusAnswers = [
      job({
        status: 'running',
        started_at: '2026-11-13T10:00:01.000Z',
        progress: { frames_done: 3, frames_total: 72, fraction: 3 / 72, fps: 2.5, eta_s: 27.6, shot: WIDE },
      }),
      job({
        status: 'done',
        started_at: '2026-11-13T10:00:01.000Z',
        finished_at: '2026-11-13T10:00:30.000Z',
        progress: { frames_done: 72, frames_total: 72, fraction: 1, fps: 2.5, eta_s: 0, shot: null },
        files: FILES,
      }),
    ];
    fireEvent.click(byTestId(container, 'export-video-start')!);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      shots: 'all',
      quality: 'draft',
      look: 'material',
      passes: ['beauty', 'depth'],
      codec: 'h264',
      outputs: { sequence: true, clips: true, posters: true, contact_sheet: true },
      width: 854,
      height: 480,
    });
    await waitFor(() =>
      expect(byTestId(container, 'export-video-status')?.textContent).toContain(
        'Rendering frame 4 of 72 · 2.5 frames/s · about 27.6 s left · shot Wide',
      ),
    );
    expect(byTestId(container, 'export-video-progress')!.getAttribute('aria-valuenow')).toBe('4');
    expect(byTestId(container, 'export-video-cancel')).not.toBeNull();
    await waitFor(() => expect(byTestId(container, 'export-video-files')).not.toBeNull(), { timeout: 4000 });
    const link = byTestId(container, 'export-video-file-sequence.mp4') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(
      '/api/projects/proj-1/video-exports/job-1/files/sequence.mp4?token=tk',
    );
    expect(link.getAttribute('download')).toBe('sequence.mp4');
    for (const f of FILES) expect(byTestId(container, `export-video-file-${f.name}`)).not.toBeNull();
    expect(byTestId(container, 'export-video-file-shot-01-wide.mp4')!.parentElement!.textContent).toContain(
      'Wide',
    );
    const video = byTestId(container, 'export-video-preview') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe(
      '/api/projects/proj-1/video-exports/job-1/files/sequence.mp4?token=tk',
    );
    // how long the server took, from its own start and end times
    expect(byTestId(container, 'export-video-status')!.textContent).toBe('Done: 72 frames · took 29.0 s');
    // back to the settings for another export
    fireEvent.click(byTestId(container, 'export-video-new')!);
    expect(byTestId(container, 'export-video-settings')).not.toBeNull();
    // the settings are remembered for the next window
    expect(JSON.parse(localStorage.getItem('3d-editor:export-video')!)).toMatchObject({
      resolution: '854x480',
      quality: 'draft',
      passes: ['beauty', 'depth'],
    });
  });

  it('cancels a running export', async () => {
    jobs = [job({ status: 'running', progress: { ...job().progress, frames_done: 10, fraction: 10 / 72 } })];
    statusAnswers = [jobs[0]];
    const { container } = await open();
    // the export that runs is followed as the window opens
    await waitFor(() => expect(byTestId(container, 'export-video-cancel')).not.toBeNull());
    fireEvent.click(byTestId(container, 'export-video-cancel')!);
    await waitFor(() => expect(deleted).toEqual(['job-1']));
    await waitFor(() => expect(byTestId(container, 'export-video-status')!.textContent).toBe('Cancelled'));
    expect(byTestId(container, 'export-video-new')).not.toBeNull();
  });

  it('shows a recent export again and deletes one with a second click', async () => {
    jobs = [
      job({ id: 'job-1', status: 'done', label: 'Take 1', files: FILES }),
      job({ id: 'job-2', status: 'failed', error: 'server restarted while the export ran' }),
    ];
    const { container } = await open();
    await waitFor(() => expect(byTestId(container, 'export-video-recent-job-1')).not.toBeNull());
    expect(byTestId(container, 'export-video-recent-job-1')!.textContent).toContain('Take 1');
    expect(byTestId(container, 'export-video-recent-job-1')!.textContent).toContain(
      formatBytes(FILES.length * 2048),
    );
    fireEvent.click(byTestId(container, 'export-video-open-job-1')!);
    await waitFor(() => expect(byTestId(container, 'export-video-files')).not.toBeNull());
    const del = byTestId(container, 'export-video-delete-job-2')!;
    fireEvent.click(del);
    expect(del.textContent).toBe('Delete?');
    expect(deleted).toEqual([]);
    fireEvent.click(del);
    await waitFor(() => expect(deleted).toEqual(['job-2']));
    await waitFor(() => expect(byTestId(container, 'export-video-recent-job-2')).toBeNull());
    // deleting the export shown leaves its view
    fireEvent.click(byTestId(container, 'export-video-delete-job-1')!);
    fireEvent.click(byTestId(container, 'export-video-delete-job-1')!);
    await waitFor(() => expect(byTestId(container, 'export-video-settings')).not.toBeNull());
  });

  it('exports the shots ticked, opened for the selected shots', async () => {
    const { container } = await open({ shots: [CLOSE] });
    await waitFor(() => expect(byTestId(container, 'export-video-shot-list')).not.toBeNull());
    fireEvent.click(byTestId(container, 'export-video-where-server')!);
    expect(byTestId(container, 'export-video-shots-selected')!.getAttribute('aria-pressed')).toBe('true');
    expect(byTestId(container, 'export-video-estimate')!.textContent).toContain('24 frames · 1.0 s');
    fireEvent.click(byTestId(container, `export-video-shot-${CLOSE}`)!);
    expect(byTestId(container, 'export-video-problem')!.textContent).toMatch(/Tick at least one shot/);
    expect((byTestId(container, 'export-video-start') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(byTestId(container, `export-video-shot-${WIDE}`)!);
    statusAnswers = [job({ status: 'queued' })];
    fireEvent.click(byTestId(container, 'export-video-start')!);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0] as { shots: string[] }).shots).toEqual([WIDE]);
    await waitFor(() => expect(byTestId(container, 'export-video-status')!.textContent).toMatch(/Waiting/));
  });

  it('shows what the server refused', async () => {
    const { container } = await open();
    await waitFor(() => expect(byTestId(container, 'export-video-start')).not.toBeNull());
    fireEvent.click(byTestId(container, 'export-video-where-server')!);
    fetchMock.mockImplementationOnce(async () =>
      json({ error: "Project 'proj-1' not found", code: 'NOT_FOUND' }, 404),
    );
    // the list request at open already happened: the next request is the start
    fireEvent.click(byTestId(container, 'export-video-start')!);
    await waitFor(() => expect(byTestId(container, 'export-video-error')).not.toBeNull());
    expect(byTestId(container, 'export-video-error')!.textContent).toContain('kept only in this browser');
    expect(byTestId(container, 'export-video-settings')).not.toBeNull();
  });

  it('closes on Escape, and an export on the server goes on and is followed again', async () => {
    const { container } = await open();
    await waitFor(() => expect(byTestId(container, 'export-video-settings')).not.toBeNull());
    fireEvent.click(byTestId(container, 'export-video-where-server')!);
    statusAnswers = [job({ status: 'running' })];
    fireEvent.click(byTestId(container, 'export-video-start')!);
    await waitFor(() => expect(byTestId(container, 'export-video-cancel')).not.toBeNull());
    expect(dialog.value).toBe('export-video');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(dialog.value).toBeNull();
    // nothing was cancelled; the window opened again follows the export
    expect(deleted).toEqual([]);
    cleanup();
    const again = await open();
    await waitFor(() => expect(byTestId(again.container, 'export-video-cancel')).not.toBeNull());
    expect(byTestId(again.container, 'export-video-job')!.getAttribute('data-where')).toBeNull();
  });

  /** An export on this device that runs until it is cancelled (its hooks kept). */
  const endless = () => {
    const runs: { req: BrowserExportRequest; hooks: BrowserExportHooks }[] = [];
    browser.start = (req, h) => {
      const hooks = h as BrowserExportHooks;
      runs.push({ req: req as BrowserExportRequest, hooks });
      return new Promise((_resolve, reject) =>
        hooks.signal!.addEventListener('abort', () =>
          reject(new BrowserExportError('The export was cancelled', 'CANCELLED')),
        ),
      );
    };
    return runs;
  };

  it('closes during an export on this device, which goes on and is followed again', async () => {
    const runs = endless();
    const first = await open();
    await waitFor(() =>
      expect((byTestId(first.container, 'export-video-start') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(byTestId(first.container, 'export-video-start')!);
    await waitFor(() => expect(runs).toHaveLength(1));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(dialog.value).toBeNull();
    expect(runs[0].hooks.signal!.aborted).toBe(false);
    cleanup();
    const again = await open();
    await waitFor(() =>
      expect(byTestId(again.container, 'export-video-job')!.getAttribute('data-status')).toBe('running'),
    );
    await act(() => runs[0].hooks.onProgress!({ phase: 'render', done: 9, total: 72, shot: CLOSE }));
    expect(byTestId(again.container, 'export-video-status')!.textContent).toMatch(
      /^Rendering frame 10 of 72 · shot Close/,
    );
    fireEvent.click(byTestId(again.container, 'export-video-cancel')!);
    expect(runs[0].hooks.signal!.aborted).toBe(true);
    await waitFor(() =>
      expect(byTestId(again.container, 'export-video-status')!.textContent).toMatch(/^Cancelled/),
    );
  });

  it('starts one export on this device at a time: a double press starts one, a second start is refused', async () => {
    const runs = endless();
    const { container } = await open();
    await waitFor(() =>
      expect((byTestId(container, 'export-video-start') as HTMLButtonElement).disabled).toBe(false),
    );
    const button = byTestId(container, 'export-video-start')!;
    // two presses before the window renders again
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(byTestId(container, 'export-video-cancel')).not.toBeNull());
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(runs).toHaveLength(1);
    expect(byTestId(container, 'export-video-error')).toBeNull();
    expect(byTestId(container, 'export-video-job')!.getAttribute('data-status')).toBe('running');
    // a start from code while it runs is refused, naming the export
    await expect(startBrowserJob(sessionSignal.value!, { shots: 'all' }, null)).rejects.toThrow(
      'An export of Kite Day is running on this device: wait for it, or cancel it first.',
    );
    expect(runs).toHaveLength(1);
    fireEvent.click(byTestId(container, 'export-video-cancel')!);
    await waitFor(() => expect(byTestId(container, 'export-video-new')).not.toBeNull());
  });

  it("refuses a second start while the previous export's files are deleted, and releases them once", async () => {
    // a finished export whose files take a while to delete (its directory on disk)
    let finish!: (r: BrowserExportResult) => void;
    browser.start = () => new Promise((resolve) => (finish = resolve));
    const session = sessionSignal.value!;
    const first = startBrowserJob(session, { shots: 'all' }, null);
    await waitFor(() => expect(typeof finish).toBe('function'));
    finish(browserResult());
    await first;
    expect(browserJob.value?.status).toBe('done');
    const oldUrls = Object.values(browserJob.value!.urls);
    let deleted!: () => void;
    browser.releaseWait = new Promise<void>((r) => (deleted = r));
    const runs = endless();
    // two starts while the files are deleted: the second is refused at once
    const a = startBrowserJob(session, { shots: 'all' }, null);
    await expect(startBrowserJob(session, { shots: 'all' }, null)).rejects.toThrow(
      /^An export of Kite Day is running on this device/,
    );
    expect(browserJob.value?.status).toBe('running');
    deleted();
    await waitFor(() => expect(runs).toHaveLength(1));
    expect(browser.released).toEqual(['local-1']);
    expect(
      vi
        .mocked(URL.revokeObjectURL)
        .mock.calls.map(([u]) => u)
        .sort(),
    ).toEqual([...oldUrls].sort());
    // the snapshot was taken when the export was asked for, not after the delete
    expect(runs[0].req.update).toBeInstanceOf(Uint8Array);
    cancelBrowserJob();
    await a;
    expect(browserJob.value?.status).toBe('cancelled');
  });

  it("revokes the previous export's object URLs when a new export starts", async () => {
    let finish!: (r: BrowserExportResult) => void;
    browser.start = () => new Promise((resolve) => (finish = resolve));
    const { container } = await open();
    await waitFor(() =>
      expect((byTestId(container, 'export-video-start') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(byTestId(container, 'export-video-start')!);
    await waitFor(() => expect(typeof finish).toBe('function'));
    await act(async () => finish(browserResult()));
    await waitFor(() => expect(byTestId(container, 'export-video-files')).not.toBeNull());
    const urls = Object.values(browserJob.value!.urls);
    expect(urls).toHaveLength(browserResult().files.length);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    endless();
    fireEvent.click(byTestId(container, 'export-video-new')!);
    fireEvent.click(byTestId(container, 'export-video-start')!);
    await waitFor(() => expect(browser.released).toEqual(['local-1']));
    expect(
      vi
        .mocked(URL.revokeObjectURL)
        .mock.calls.map(([u]) => u)
        .sort(),
    ).toEqual([...urls].sort());
  });

  it('shows why an export on this device failed', async () => {
    browser.start = async () => {
      throw new BrowserExportError(
        'The export was not started: it needs about 3.1 GB of memory with one render worker, more than the 2.0 GB a render may use in this tab',
        'OUT_OF_MEMORY',
      );
    };
    const { container } = await open();
    await waitFor(() =>
      expect((byTestId(container, 'export-video-start') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(byTestId(container, 'export-video-start')!);
    await waitFor(() =>
      expect(byTestId(container, 'export-video-job')!.getAttribute('data-status')).toBe('failed'),
    );
    const status = byTestId(container, 'export-video-status')!;
    expect(status.className).toBe('error-text');
    expect(status.textContent).toMatch(
      /^Failed: The export was not started: it needs about 3\.1 GB of memory/,
    );
    expect(byTestId(container, 'export-video-new')).not.toBeNull();
  });

  it("shows another project's running export in this project's window, with its progress and Cancel", async () => {
    const runs = endless();
    const first = await open();
    await waitFor(() =>
      expect((byTestId(first.container, 'export-video-start') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(byTestId(first.container, 'export-video-start')!);
    await waitFor(() => expect(runs).toHaveLength(1));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    cleanup();
    // another project opens in the tab (no reload: the export goes on)
    const other = projectDoc(false);
    sessionSignal.value = {
      ...fakeSession(other),
      id: 'proj-2',
      title: { value: 'Other' },
    } as unknown as ProjectSession;
    const second = await open();
    await waitFor(() => expect(byTestId(second.container, 'export-video-job')).not.toBeNull());
    expect(byTestId(second.container, 'export-video-start')).toBeNull();
    expect(byTestId(second.container, 'export-video-other-project')!.textContent).toBe(
      'This export is of Kite Day: this tab runs one export on this device at a time.',
    );
    // its shots are named as in its project
    await act(() => runs[0].hooks.onProgress!({ phase: 'render', done: 3, total: 72, shot: WIDE }));
    expect(byTestId(second.container, 'export-video-status')!.textContent).toMatch(
      /^Rendering frame 4 of 72 · shot Wide/,
    );
    fireEvent.click(byTestId(second.container, 'export-video-cancel')!);
    expect(runs[0].hooks.signal!.aborted).toBe(true);
    await waitFor(() =>
      expect(byTestId(second.container, 'export-video-status')!.textContent).toMatch(/^Cancelled/),
    );
    // the export it followed stays shown until New Export; cancelled, it kept no files to release
    expect(byTestId(second.container, 'export-video-other-project')!.textContent).toBe(
      'This export was of Kite Day.',
    );
    fireEvent.click(byTestId(second.container, 'export-video-new')!);
    expect(byTestId(second.container, 'export-video-settings')).not.toBeNull();
  });

  it("says another project's finished export keeps its files until the next export, and a failed one none", async () => {
    const outcomes: { resolve(r: BrowserExportResult): void; reject(e: Error): void }[] = [];
    browser.start = () => new Promise((resolve, reject) => outcomes.push({ resolve, reject }));
    /** Kite Day's export starts; another project's window then follows it. */
    const followed = async () => {
      sessionSignal.value = fakeSession();
      const first = await open();
      // Kite Day's window shows its last export: New Export offers the settings again
      const again = byTestId(first.container, 'export-video-new');
      if (again) fireEvent.click(again);
      await waitFor(() =>
        expect((byTestId(first.container, 'export-video-start') as HTMLButtonElement).disabled).toBe(false),
      );
      fireEvent.click(byTestId(first.container, 'export-video-start')!);
      await waitFor(() => expect(browserJob.value?.status).toBe('running'));
      fireEvent.keyDown(document.body, { key: 'Escape' });
      cleanup();
      sessionSignal.value = {
        ...fakeSession(projectDoc(false)),
        id: 'proj-2',
        title: { value: 'Other' },
      } as unknown as ProjectSession;
      const other = await open();
      await waitFor(() => expect(byTestId(other.container, 'export-video-job')).not.toBeNull());
      return other;
    };
    // finished: its files stay until the next export starts
    const done = await followed();
    await act(async () => outcomes[0].resolve(browserResult()));
    await waitFor(() =>
      expect(byTestId(done.container, 'export-video-job')!.getAttribute('data-status')).toBe('done'),
    );
    expect(byTestId(done.container, 'export-video-other-project')!.textContent).toBe(
      'This export was of Kite Day; its files are released when the next export starts.',
    );
    fireEvent.keyDown(document.body, { key: 'Escape' });
    cleanup();
    // failed: it deleted its files when it ended
    const failed = await followed();
    await act(async () => outcomes[1].reject(new BrowserExportError('the render worker stopped', 'FAILED')));
    await waitFor(() =>
      expect(byTestId(failed.container, 'export-video-job')!.getAttribute('data-status')).toBe('failed'),
    );
    expect(byTestId(failed.container, 'export-video-other-project')!.textContent).toBe(
      'This export was of Kite Day.',
    );
  });

  it("says in the Quality buttons' tooltip how the export that would run encodes", async () => {
    const { container } = await open();
    await waitFor(() => expect(byTestId(container, 'export-video-settings')).not.toBeNull());
    const title = () => byTestId(container, 'export-video-quality')!.getAttribute('title');
    // this device: a bit rate (1920×1080 at 24 fps, standard), no CRF
    expect(title()).toBe(
      '2 samples, shadows and ambient occlusion; this device encodes H.264 at 3.7 Mbit/s (0.09 bits per pixel and frame at 1280×720)',
    );
    fireEvent.click(byTestId(container, 'export-video-codec-vp9')!);
    expect(title()).toMatch(
      /; this device encodes VP9 at quantizer 33 \(where the browser has no VP9 encoder, H\.264 at /,
    );
    fireEvent.click(byTestId(container, 'export-video-where-server')!);
    expect(title()).toBe('2 samples, shadows and ambient occlusion; the server encodes VP9 at CRF 33');
    fireEvent.click(byTestId(container, 'export-video-codec-h264')!);
    fireEvent.click(byTestId(container, 'export-video-quality-high')!);
    expect(title()).toBe(
      '4 samples up to 1280×720 (else 2), shadows and ambient occlusion; the server encodes H.264 at CRF 18 (x264 preset slow)',
    );
  });
});
