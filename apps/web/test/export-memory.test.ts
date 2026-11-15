import { describe, expect, it } from 'vitest';
import { WORKER_BASE_BYTES, type TabMemory } from '../src/render/memory';
import {
  ENCODER_BYTES,
  FINISH_COPIES,
  MAX_BYTES_AHEAD,
  WORKER_SLACK_BYTES,
  fewerWorkersWarning,
  frameReplyBytes,
  framesInFlight,
  pageNeeds,
  planExportWorkers,
  workerNeeds,
  type PageNeedsInput,
} from '../src/export/memory';
import { browserExportSupport, type SupportEnvironment } from '../src/export/support';

/*
 * How many render workers a browser export starts (the tab's memory and heap), its refusals, and
 * whether this browser can export at all (secure page, workers, WebCodecs, an H.264 encoder).
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

const tab = (o: Partial<TabMemory> = {}): TabMemory => ({
  budget: 4 * GB,
  heapLimit: 4 * GB,
  heapUsed: 0,
  deviceGB: 8,
  held: { total: 0, heap: 0 },
  ...o,
});

const page = (o: Partial<PageNeedsInput> = {}): PageNeedsInput => ({
  width: 1280,
  height: 720,
  fps: 24,
  quality: 'draft',
  codec: 'h264',
  videoStreams: 1,
  lossless: 0,
  frames: 240,
  longestShot: 48,
  shots: 5,
  outputs: { sequence: true, clips: true, posters: true, stills: false },
  onDisk: true,
  workers: 4,
  ...o,
});

describe('export memory', () => {
  it('counts a worker as its base, scene, buffers, frame in flight and slack', () => {
    const w = workerNeeds({ scene: 100 * MB, buffers: 50 * MB, frame: 10 * MB });
    expect(w.total).toBe(WORKER_BASE_BYTES + 160 * MB + WORKER_SLACK_BYTES);
    expect(w.heap).toBe(WORKER_BASE_BYTES + 100 * MB);
  });

  it('counts the page: encoders, frames ahead, clips with the copies finishing them; every file when nothing goes to disk', () => {
    const px = 1280 * 720;
    // 1,106,000 bit/s at 24 fps: 5,760.4 bytes per frame
    const perFrame = 1_106_000 / 8 / 24;
    const onDisk = pageNeeds(page());
    // the longest shot's clip as it is finished: its samples, the MP4 written, its trimmed copy
    expect(FINISH_COPIES).toEqual({ mp4: 3, webm: 2 });
    expect(onDisk).toBe(
      Math.ceil(
        ENCODER_BYTES.base +
          ENCODER_BYTES.perPixel * px +
          2 * 4 * frameReplyBytes(1280, 720, 1, 0) +
          perFrame * 48 * 3,
      ),
    );
    // in memory: the clip's Blob besides, every clip's Blob, the sequence's samples and, as it is
    // finished, its MP4, trimmed copy and Blob; the posters
    const inMemory = pageNeeds(page({ onDisk: false }));
    expect(inMemory - onDisk).toBeCloseTo(perFrame * (48 + 240 + 240 + 3 * 240) + 5 * px * 4, -1);
    // WebM (VP9, counted at 1.5 times H.264's bit rate): written as it goes, two copies when finished
    const vp9 = pageNeeds(
      page({ codec: 'vp9', outputs: { sequence: false, clips: true, posters: false, stills: false } }),
    );
    const bare = pageNeeds(
      page({ outputs: { sequence: false, clips: false, posters: false, stills: false } }),
    );
    expect(vp9 - bare).toBeCloseTo(1.5 * perFrame * 48 * 2, -1);
    // the frame archives without a disk: each, and the one being finished twice
    const archives = pageNeeds(
      page({
        onDisk: false,
        lossless: 2,
        videoStreams: 0,
        outputs: { sequence: false, clips: false, posters: false, stills: false },
      }),
    );
    const none = pageNeeds(
      page({
        onDisk: false,
        lossless: 0,
        videoStreams: 0,
        outputs: { sequence: false, clips: false, posters: false, stills: false },
      }),
    );
    expect(archives - none).toBeCloseTo(
      3 * 240 * px * 0.5 + 2 * 4 * (frameReplyBytes(1280, 720, 0, 2) - frameReplyBytes(1280, 720, 0, 0)),
      -1,
    );
    // a segment's rigid body matrices
    expect(pageNeeds(page({ physics: 10 * MB })) - onDisk).toBe(10 * MB);
    // frames ahead are capped
    const ahead = page({
      width: 3840,
      height: 2160,
      workers: 64,
      videoStreams: 0,
      lossless: 2,
      outputs: { sequence: false, clips: false, posters: false, stills: false },
    });
    expect(2 * 64 * frameReplyBytes(3840, 2160, 0, 2)).toBeGreaterThan(MAX_BYTES_AHEAD);
    expect(pageNeeds(ahead)).toBe(MAX_BYTES_AHEAD);
    // but the frame rendering always counts, whatever its size (7680×4320 with every pass: 316 MB)
    const huge = frameReplyBytes(7680, 4320, 6, 2);
    expect(Math.round(huge / MB)).toBe(316);
    const eight = { ...ahead, width: 7680, height: 4320, videoStreams: 6, lossless: 2, workers: 1 };
    expect(pageNeeds(eight)).toBe(6 * (ENCODER_BYTES.base + ENCODER_BYTES.perPixel * 7680 * 4320) + huge);
  });

  it('starts no more workers than frames can be in flight at once', () => {
    // 3840×2160 with every pass: six I420 streams and two PNG passes, 79 MB a frame: one at a time
    const all = frameReplyBytes(3840, 2160, 6, 2);
    expect(Math.round(all / MB)).toBe(79);
    expect(framesInFlight(all)).toBe(1);
    expect(framesInFlight(frameReplyBytes(2560, 1440, 6, 2))).toBe(3);
    expect(framesInFlight(frameReplyBytes(1280, 720, 1, 0))).toBe(
      Math.floor(MAX_BYTES_AHEAD / frameReplyBytes(1280, 720, 1, 0)),
    );
    expect(framesInFlight(10, 25)).toBe(2);
    expect(framesInFlight(Infinity)).toBe(1);
  });

  it("counts the first worker's rigid body simulation once, and what the tab's other renders hold", () => {
    const worker = { total: 500 * MB, heap: 300 * MB };
    expect(
      planExportWorkers({ worker, page: 100 * MB, maxWorkers: 8, memory: tab(), onDisk: true }).workers,
    ).toBe(7);
    // the simulation's frames: in the first worker only
    expect(
      planExportWorkers({
        worker,
        first: { total: 1024 * MB, heap: 1024 * MB },
        page: 100 * MB,
        maxWorkers: 8,
        memory: tab(),
        onDisk: true,
      }).workers,
    ).toBe(5);
    const simulated = planExportWorkers({
      worker,
      first: { total: 3.5 * GB, heap: 0 },
      page: 100 * MB,
      maxWorkers: 8,
      memory: tab(),
      onDisk: true,
    });
    expect(simulated.workers).toBe(0);
    expect(simulated.refusal).toMatch(
      /^The export was not started: it needs about 4\.1 GB of memory with one render worker \(3\.5 GB of it the rigid body simulation's frames\), more than the 4\.0 GB a render may use in this tab/,
    );
    // other renders and exports of the tab: their memory and their heaps
    const held = planExportWorkers({
      worker,
      page: 100 * MB,
      maxWorkers: 8,
      memory: tab({ held: { total: 3.5 * GB, heap: 0 } }),
      onDisk: true,
    });
    expect(held.workers).toBe(0);
    expect(held.refusal).toMatch(
      /more than the 0\.5 GB a render may use in this tab \(half the device memory the browser reports, 8 GB, at most 4\.0 GB, less 3\.5 GB the other renders and exports running in it hold\), and running out of memory would end the tab\. Wait for the other renders and exports running in this tab to end, or lower the resolution or the passes, or the triangles of the scene, or export on the server where one is available\.$/,
    );
    expect(
      planExportWorkers({
        worker,
        page: 100 * MB,
        maxWorkers: 8,
        memory: tab({ held: { total: 2 * GB, heap: 0 } }),
        onDisk: true,
      }).workers,
    ).toBe(3);
    const heap = planExportWorkers({
      worker: { total: 100 * MB, heap: 1 * GB },
      page: 0,
      maxWorkers: 8,
      memory: tab({ held: { total: 0, heap: 2.5 * GB } }),
      onDisk: true,
    });
    expect(heap.workers).toBe(0);
    expect(heap.refusal).toMatch(
      /and the page and the other renders and exports running in it are estimated to use 2\.50 GB\), and running out of memory would end the tab\. Wait for the other renders/,
    );
    // without a disk
    expect(
      planExportWorkers({
        worker: { total: 100 * MB, heap: 1 * GB },
        page: 0,
        maxWorkers: 8,
        memory: tab({ held: { total: 0, heap: 2.5 * GB } }),
        onDisk: false,
      }).refusal,
    ).toMatch(
      /This browser cannot write the files to disk, so they are kept in memory: wait for the other renders and exports running in this tab to end, or export fewer frames, or lower the resolution or the passes, or export on the server where one is available\.$/,
    );
  });

  it('starts as many workers as the budget and the heap hold', () => {
    const worker = { total: 500 * MB, heap: 300 * MB };
    expect(planExportWorkers({ worker, page: 100 * MB, maxWorkers: 8, memory: tab(), onDisk: true })).toEqual(
      {
        workers: 7,
        limited: true,
        refusal: null,
      },
    );
    expect(planExportWorkers({ worker, page: 100 * MB, maxWorkers: 4, memory: tab(), onDisk: true })).toEqual(
      {
        workers: 4,
        limited: false,
        refusal: null,
      },
    );
    // the heap: a render may fill min(85 %, limit − 136 MB) of it, less the page's own
    const heapBound = planExportWorkers({
      worker,
      page: 0,
      maxWorkers: 8,
      memory: tab({ budget: 16 * GB, heapLimit: 2 * GB, heapUsed: 500 * MB }),
      onDisk: true,
    });
    expect(heapBound.workers).toBe(Math.floor((2 * GB * 0.85 - 500 * MB) / (300 * MB)));
  });

  it('refuses with the figures when not even one worker fits', () => {
    const budget = planExportWorkers({
      worker: { total: 3 * GB, heap: 100 * MB },
      page: 500 * MB,
      maxWorkers: 4,
      memory: tab({ budget: 2 * GB, deviceGB: 4 }),
      onDisk: true,
    });
    expect(budget.workers).toBe(0);
    expect(budget.refusal).toBe(
      'The export was not started: it needs about 3.5 GB of memory with one render worker, more than the 2.0 GB a render may use in this tab (half the device memory the browser reports, 4 GB, at most 4.0 GB), and running out of memory would end the tab. Lower the resolution or the passes, or the triangles of the scene, or export on the server where one is available.',
    );
    const heap = planExportWorkers({
      worker: { total: 1 * GB, heap: 3 * GB },
      page: 0,
      maxWorkers: 4,
      memory: tab({ budget: 8 * GB, heapUsed: 512 * MB }),
      onDisk: false,
    });
    expect(heap.workers).toBe(0);
    expect(heap.refusal).toMatch(
      /^The export was not started: its render worker needs about 3\.00 GB of JavaScript heap for the scene, more than the [\d.]+ GB the tab has left for it \(a render may fill [\d.]+ GB of its heap, and the page is estimated to use 0\.50 GB\), and running out of memory would end the tab\. This browser cannot write the files to disk, so they are kept in memory: export fewer frames/,
    );
    expect(fewerWorkersWarning(2, 8)).toBe(
      "This tab's memory holds 2 of the 8 render workers this device could use: the export renders on 2, more slowly",
    );
  });
});

describe('browser export support', () => {
  const env = (o: Partial<SupportEnvironment> = {}): SupportEnvironment => ({
    secure: true,
    workers: true,
    webCodecs: true,
    probe: async () => true,
    ...o,
  });

  it('is available with a secure page, workers and an H.264 encoder', async () => {
    expect(await browserExportSupport({ width: 1280, height: 720, fps: 24 }, env())).toEqual({
      available: true,
      reason: null,
    });
  });

  it('says why not', async () => {
    const no = async (o: Partial<SupportEnvironment>) =>
      (await browserExportSupport({ width: 1280, height: 720, fps: 24 }, env(o))).reason;
    expect(await no({ secure: false })).toMatch(/needs a secure page \(HTTPS, or localhost\)/);
    expect(await no({ workers: false })).toMatch(/cannot run Web Workers/);
    expect(await no({ webCodecs: false })).toMatch(/no WebCodecs video encoder \(VideoEncoder\)/);
    const asked: string[] = [];
    expect(
      await no({
        probe: async (c) => {
          asked.push(`${c.codec} ${c.width}x${c.height}`);
          return false;
        },
      }),
    ).toBe(
      'This browser cannot encode H.264 video of 1280×720 at 24 fps (its encoder takes none of the High, Main and Baseline profiles at that size): lower the resolution or the frame rate.',
    );
    expect(asked).toEqual(['avc1.64001f 1280x720', 'avc1.4d001f 1280x720', 'avc1.42e01f 1280x720']);
    // odd sizes are asked as the export rounds them (even)
    await browserExportSupport(
      { width: 853, height: 479, fps: 30 },
      env({ probe: async (c) => (asked.push(`${c.width}x${c.height}`), true) }),
    );
    expect(asked.at(-1)).toBe('854x480');
  });
});
