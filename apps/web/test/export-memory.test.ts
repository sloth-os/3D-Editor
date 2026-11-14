import { describe, expect, it } from 'vitest';
import { WORKER_BASE_BYTES, type TabMemory } from '../src/render/memory';
import {
  ENCODER_BYTES,
  MAX_BYTES_AHEAD,
  WORKER_SLACK_BYTES,
  fewerWorkersWarning,
  frameReplyBytes,
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

  it('counts the page: encoders, frames ahead, clips; every file when nothing goes to disk', () => {
    const px = 1280 * 720;
    // 1,106,000 bit/s at 24 fps: 5,760.4 bytes per frame
    const perFrame = 1_106_000 / 8 / 24;
    const onDisk = pageNeeds(page());
    expect(onDisk).toBe(
      Math.ceil(
        ENCODER_BYTES.base +
          ENCODER_BYTES.perPixel * px +
          2 * 4 * frameReplyBytes(1280, 720, 1, 0) +
          perFrame * 48,
      ),
    );
    const inMemory = pageNeeds(page({ onDisk: false }));
    expect(inMemory - onDisk).toBeCloseTo(perFrame * (2 * 240 - 48) + 5 * px * 4, -1);
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
