import { describe, expect, it } from 'vitest';
import type { StreamTargetChunk } from 'mediabunny';
import { StreamMuxer, shotOfFrame, type MuxShot } from '../src/export/mux';
import { mp4Info } from './export-files';

/*
 * The muxing of the browser export's videos from encoded chunks (no WebCodecs: synthetic packets):
 * each chunk goes to the sequence and to its shot's clip, the clips start on key frames, every file
 * has its index before its media data and the BT.709 limited colour box, and the sample tables
 * count the frames.
 */

/** The avcC of a 160×90 High profile stream made by Chromium's encoder. */
const AVCC = Uint8Array.from(
  '01640c0cffe1001267640c0cac18d051af24d40404041e1108d401000468ce3c80fdf8f800'
    .match(/../g)!
    .map((h) => parseInt(h, 16)),
);
const CONFIG: VideoDecoderConfig = {
  codec: 'avc1.64000c',
  codedWidth: 160,
  codedHeight: 90,
  description: AVCC,
};

const chunk = (frame: number, key: boolean) => ({
  data: new Uint8Array([0, 0, 0, 2, key ? 0x65 : 0x41, frame & 0xff]),
  key,
  frame,
});

const SHOTS: MuxShot[] = [
  { start: 0, frames: 3 },
  { start: 3, frames: 2 },
  { start: 5, frames: 4 },
];

/** A positioned-write stream into a growing buffer (an OPFS file stand-in). */
function positionedFile() {
  let buf = new Uint8Array(0);
  let closed = false;
  const writable = new WritableStream<StreamTargetChunk>({
    write(c) {
      const end = c.position + c.data.length;
      if (end > buf.length) {
        const next = new Uint8Array(end);
        next.set(buf);
        buf = next;
      }
      buf.set(c.data, c.position);
    },
    close() {
      closed = true;
    },
  });
  return { writable, bytes: () => buf, closed: () => closed };
}

describe('stream muxer', () => {
  it('finds the shot of each output frame', () => {
    expect([0, 1, 2, 3, 4, 5, 8].map((f) => shotOfFrame(SHOTS, f))).toEqual([0, 0, 0, 1, 1, 2, 2]);
    expect(shotOfFrame([{ start: 0, frames: 1 }], 0)).toBe(0);
  });

  it('cuts one clip per shot from the chunks and writes the sequence of all of them', async () => {
    const clips: [number, Uint8Array][] = [];
    const m = new StreamMuxer({
      muxCodec: 'avc',
      container: 'mp4',
      fps: { num: 24, den: 1 },
      frames: 9,
      shots: SHOTS,
      sequence: 'memory',
      clips: true,
      onClip: async (shot, bytes) => void clips.push([shot, bytes]),
    });
    const keys = new Set([0, 3, 5, 7]);
    for (let f = 0; f < 9; f++) await m.add(chunk(f, keys.has(f)), f === 0 ? CONFIG : null);
    const seq = await m.finish();
    expect(clips.map(([s]) => s)).toEqual([0, 1, 2]);
    const counts = clips.map(([, b]) => mp4Info(b));
    expect(counts.map((c) => c.samples)).toEqual([3, 2, 4]);
    // each clip starts on a key frame; the third has one more inside (frame 7 = its sample 3)
    expect(counts.map((c) => c.sync)).toEqual([[1], [1], [1, 3]]);
    const info = mp4Info(seq!);
    expect(info.samples).toBe(9);
    expect(info.sync).toEqual([1, 4, 6, 8]);
    for (const c of [...counts, info]) {
      expect(c.order).toEqual(['ftyp', 'moov', 'mdat']);
      expect(c.colr).toEqual({ type: 'nclx', primaries: 1, transfer: 1, matrix: 1, fullRange: false });
      expect(c.avcC).toEqual(AVCC);
      expect(c.timescale).toBe(24);
      expect(new Set(c.durations)).toEqual(new Set([1]));
    }
  });

  it('keeps NTSC timing exact (1001/30000 s per frame)', async () => {
    const m = new StreamMuxer({
      muxCodec: 'avc',
      container: 'mp4',
      fps: { num: 30000, den: 1001 },
      frames: 4,
      shots: [{ start: 0, frames: 4 }],
      sequence: 'memory',
      clips: false,
      onClip: async () => {},
    });
    for (let f = 0; f < 4; f++) await m.add(chunk(f, f === 0), f === 0 ? CONFIG : null);
    const info = mp4Info((await m.finish())!);
    expect(info.timescale).toBe(30000);
    expect(info.durations).toEqual([1001, 1001, 1001, 1001]);
  });

  it('writes a sequence to a positioned stream with its index reserved at the start', async () => {
    const file = positionedFile();
    const m = new StreamMuxer({
      muxCodec: 'avc',
      container: 'mp4',
      fps: { num: 25, den: 1 },
      frames: 9,
      shots: SHOTS,
      sequence: file.writable,
      clips: false,
      onClip: async () => {},
    });
    for (let f = 0; f < 9; f++) await m.add(chunk(f, f === 0 || f === 3 || f === 5), f === 0 ? CONFIG : null);
    expect(await m.finish()).toBeNull();
    expect(file.closed()).toBe(true);
    const info = mp4Info(file.bytes());
    expect(info.order.indexOf('moov')).toBeLessThan(info.order.indexOf('mdat'));
    expect(info.samples).toBe(9);
    expect(info.sync).toEqual([1, 4, 6]);
  });

  it('refuses a clip that would not start on a key frame', async () => {
    const m = new StreamMuxer({
      muxCodec: 'avc',
      container: 'mp4',
      fps: { num: 24, den: 1 },
      frames: 9,
      shots: SHOTS,
      sequence: null,
      clips: true,
      onClip: async () => {},
    });
    for (let f = 0; f < 3; f++) await m.add(chunk(f, f === 0), f === 0 ? CONFIG : null);
    await expect(m.add(chunk(3, false), null)).rejects.toThrow(
      /shot 2's clip would not start on a key frame/,
    );
    await m.cancel();
  });

  it('refuses chunks outside the export, a missing decoder configuration and a changed one', async () => {
    const make = () =>
      new StreamMuxer({
        muxCodec: 'avc',
        container: 'mp4',
        fps: { num: 24, den: 1 },
        frames: 2,
        shots: [{ start: 0, frames: 2 }],
        sequence: 'memory',
        clips: true,
        onClip: async () => {},
      });
    await expect(make().add(chunk(2, true), CONFIG)).rejects.toThrow(/frame 3 of an export of 2/);
    await expect(make().add(chunk(0, true), null)).rejects.toThrow(/no decoder configuration/);
    const m = make();
    await m.add(chunk(0, true), CONFIG);
    await expect(m.add(chunk(1, true), { ...CONFIG, description: AVCC.slice(0, 20) })).rejects.toThrow(
      /changed its decoder configuration/,
    );
    // the same configuration again is fine
    const n = make();
    await n.add(chunk(0, true), CONFIG);
    await n.add(chunk(1, false), { ...CONFIG, description: AVCC.slice() });
    expect(mp4Info((await n.finish())!).samples).toBe(2);
  });

  it('fails a file that did not get all its frames', async () => {
    const m = new StreamMuxer({
      muxCodec: 'avc',
      container: 'mp4',
      fps: { num: 24, den: 1 },
      frames: 5,
      shots: [
        { start: 0, frames: 3 },
        { start: 3, frames: 2 },
      ],
      sequence: 'memory',
      clips: true,
      onClip: async () => {},
    });
    for (let f = 0; f < 4; f++) await m.add(chunk(f, f === 0 || f === 3), f === 0 ? CONFIG : null);
    await expect(m.finish()).rejects.toThrow(/shot 2's clip got 1 of its 2 frames/);
  });
});
