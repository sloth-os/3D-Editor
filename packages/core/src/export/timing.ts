/*
 * The frame rate of an export's videos as an exact rational: NTSC rates (23.976, 29.97, 59.94 …) are
 * N × 1000 / 1001, whole rates N / 1, others N / 1000. The server passes it to ffmpeg (-framerate,
 * clip cut times); the browser export's MP4 files use it as their time base (a frame lasts `den`
 * ticks of a `num` Hz clock), so frame times and durations are exact in both.
 */

/** A frame rate as a rational (NTSC rates exact: 23.976 → 24000/1001). */
export function fpsRational(fps: number): { num: number; den: number; text: string } {
  if (!(Number.isFinite(fps) && fps > 0)) throw new Error(`invalid frame rate ${fps}`);
  for (const base of [24, 30, 48, 60, 120]) {
    const ntsc = (base * 1000) / 1001;
    if (Math.abs(fps - ntsc) < 0.0015) return { num: base * 1000, den: 1001, text: `${base * 1000}/1001` };
  }
  if (Math.abs(fps - Math.round(fps)) < 1e-9) {
    const n = Math.round(fps);
    return { num: n, den: 1, text: `${n}/1` };
  }
  const num = Math.round(fps * 1000);
  return { num, den: 1000, text: `${num}/1000` };
}

/** The exact rate of a rational (frames per second). */
export function fpsValue(r: { num: number; den: number }): number {
  return r.num / r.den;
}
