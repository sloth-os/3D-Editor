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
  buildExportParams,
  elapsedText,
  estimateExport,
  exportContext,
  exportOutputSize,
  exportSettingsProblem,
  exportUnavailableReason,
  formatBytes,
  formatSeconds,
  groupExportFiles,
  initialSettings,
  jobStatusText,
  previewFile,
  type ExportSettings,
} from '../src/ui/dialogs/ExportVideoDialog';

/*
 * The Export Video window: its fields make the body of POST …/video-exports (SPEC §9), it estimates
 * the export's frames and length, follows the job (frames, speed, time left, shot) with Cancel,
 * lists the files as download links (with the token) and previews the sequence; the project's
 * recent exports can be shown again or deleted; without a server or ffmpeg it says why.
 */

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

function fakeSession(doc = projectDoc()): ProjectSession {
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

  it('says why this editor cannot export', () => {
    expect(exportUnavailableReason(null, true)).toMatch(/runs on the editor server/);
    expect(
      exportUnavailableReason({ ...SERVER, features: { ...SERVER.features, videoExport: false } }, true),
    ).toMatch(/did not find ffmpeg/);
    expect(
      exportUnavailableReason({ ...SERVER, features: { ...SERVER.features, videoExport: undefined } }, true),
    ).toMatch(/too old/);
    expect(exportUnavailableReason(SERVER, false)).toMatch(/Open a project/);
    expect(exportUnavailableReason(SERVER, true)).toBeNull();
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
  });
  afterEach(() => {
    cleanup();
    closeDialog();
    vi.unstubAllGlobals();
    serverConfig.value = null;
    sessionSignal.value = null;
    updatePrefs((p) => ({ ...p, sync: { ...p.sync, token: '' } }));
  });

  it('says why it cannot export without a server or without ffmpeg', async () => {
    serverConfig.value = null;
    const { container } = await open();
    expect(byTestId(container, 'export-video-unavailable')!.textContent).toMatch(/runs on the editor server/);
    expect(byTestId(container, 'export-video-start')).toBeNull();
    serverConfig.value = { ...SERVER, features: { ...SERVER.features, videoExport: false } };
    await waitFor(() =>
      expect(byTestId(container, 'export-video-unavailable')!.textContent).toMatch(/ffmpeg/),
    );
    // the exports made before are still listed
    await waitFor(() => expect(byTestId(container, 'export-video-recent')).not.toBeNull());
    expect(byTestId(container, 'export-video-start')).toBeNull();
  });

  it('starts the export with the chosen settings, follows it and links its files', async () => {
    const { container } = await open();
    await waitFor(() => expect(byTestId(container, 'export-video-settings')).not.toBeNull());
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
    fetchMock.mockImplementationOnce(async () =>
      json({ error: "Project 'proj-1' not found", code: 'NOT_FOUND' }, 404),
    );
    // the list request at open already happened: the next request is the start
    fireEvent.click(byTestId(container, 'export-video-start')!);
    await waitFor(() => expect(byTestId(container, 'export-video-error')).not.toBeNull());
    expect(byTestId(container, 'export-video-error')!.textContent).toContain('kept only in this browser');
    expect(byTestId(container, 'export-video-settings')).not.toBeNull();
  });

  it('closes on Escape (the export goes on on the server)', async () => {
    await open();
    expect(dialog.value).toBe('export-video');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(dialog.value).toBeNull();
  });
});
