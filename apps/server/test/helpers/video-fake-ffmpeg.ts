import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/*
 * A fake ffmpeg for unit tests of video exports (never the real one there): a small Node script
 * behind a shell wrapper, given to the server as FFMPEG_PATH. `-version` and `-encoders` answer
 * like ffmpeg; any other command reads its stdin to the end and writes a placeholder file to every
 * output path (arguments ending in .mp4/.mkv/.webm/.png/.jpg that do not follow -i), whose text
 * names the file and the bytes read. Every call is logged as a JSON line. Environment knobs:
 * FAKE_FFMPEG_FAIL (outputs containing it fail with exit code 1), FAKE_FFMPEG_DELAY_MS (each call
 * waits that long before writing), FAKE_FFMPEG_NO_X264 (no libx264 in -encoders),
 * FAKE_FFMPEG_HEAD (the placeholder also names the first 8 bytes read, in hex: ` head=…`).
 */

const SCRIPT = `
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = process.env.FAKE_FFMPEG_LOG;
if (log) fs.appendFileSync(log, JSON.stringify(args) + '\\n');
if (args.includes('-version')) { process.stdout.write('ffmpeg version 0.0-fake\\n'); process.exit(0); }
if (args.includes('-encoders')) {
  const lines = [' V....D libvpx-vp9  fake VP9', ' V....D libx264rgb  fake H.264 RGB', ' V....D png  fake PNG'];
  if (!process.env.FAKE_FFMPEG_NO_X264) lines.push(' V....D libx264  fake H.264');
  process.stdout.write('Encoders:\\n ------\\n' + lines.join('\\n') + '\\n');
  process.exit(0);
}
const outputs = args.filter((a, i) => /\\.(mp4|mkv|webm|png|jpg)$/.test(a) && args[i - 1] !== '-i');
const fromPipe = args.includes('pipe:0');
let bytes = 0;
let head = Buffer.alloc(0);
const finish = () => {
  const fail = process.env.FAKE_FFMPEG_FAIL;
  if (fail && outputs.some((o) => o.includes(fail))) { process.stderr.write('fake failure for ' + fail + '\\n'); process.exit(1); }
  const delay = Number(process.env.FAKE_FFMPEG_DELAY_MS || 0);
  const tail = process.env.FAKE_FFMPEG_HEAD ? ' head=' + head.toString('hex') : '';
  setTimeout(() => {
    for (const o of outputs) fs.writeFileSync(o, 'fake ' + require('node:path').basename(o) + ' ' + bytes + tail + '\\n');
    process.exit(0);
  }, delay);
};
if (fromPipe) {
  process.stdin.on('data', (c) => {
    if (head.length < 8) head = Buffer.concat([head, c.subarray(0, 8 - head.length)]);
    bytes += c.length;
  });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
} else finish();
`;

export interface FakeFfmpeg {
  /** The executable (a shell script running the fake with this Node). */
  path: string;
  /** Where the calls are logged (one JSON array of arguments per line). */
  log: string;
  /** The logged calls so far. */
  calls(): Promise<string[][]>;
}

/** Writes a fake ffmpeg into a new temporary directory. */
export async function makeFakeFfmpeg(): Promise<FakeFfmpeg> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-ffmpeg-'));
  const script = path.join(dir, 'fake-ffmpeg.cjs');
  const log = path.join(dir, 'calls.log');
  await writeFile(script, SCRIPT);
  const exe = path.join(dir, 'ffmpeg');
  await writeFile(
    exe,
    `#!/bin/sh\nFAKE_FFMPEG_LOG="\${FAKE_FFMPEG_LOG:-${log}}" exec "${process.execPath}" "${script}" "$@"\n`,
  );
  await chmod(exe, 0o755);
  return {
    path: exe,
    log,
    async calls() {
      const text = await readFile(log, 'utf8').catch(() => '');
      return text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]);
    },
  };
}
