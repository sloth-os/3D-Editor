import { describe, expect, it } from 'vitest';
import { gzipSync } from 'fflate';
import {
  CONTAINER_PREFIX_BYTES,
  ContainerError,
  INFLATE_SLICE_BYTES,
  UNIT_MAGIC,
  gunzipBounded,
  gzipDeterministic,
  normalizeGzipHeader,
  readContainerPrefix,
  sha256Hex,
  writeContainer,
} from '../src/desk/container';

/*
 * The desk's container (desk/container): the 16-byte prefix and header, deterministic gzip, the
 * bounded inflate (one buffer of exactly the declared size, 4 KiB slices, one member, CRC and size
 * checked) and SHA-256.
 */

const enc = new TextEncoder();
const bytes = (n: number, seed = 1) => {
  const b = new Uint8Array(n);
  let x = seed || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    b[i] = x & 0xff;
  }
  return b;
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof ContainerError ? err.code : `not a ContainerError: ${String(err)}`;
  }
  return 'no error';
};

describe('the container prefix', () => {
  it('writes magic, version, codec, zeros and the header length, and reads them back', () => {
    const header = enc.encode('{"a":1}');
    const payload = bytes(10);
    const file = writeContainer({ magic: UNIT_MAGIC, version: 1, codec: 'gzip', header, payload });
    expect([...file.subarray(0, 8)]).toEqual([0x33, 0x44, 0x55, 0x4e, 0x49, 0x54, 0x0d, 0x0a]);
    expect(new TextDecoder().decode(file.subarray(0, 6))).toBe('3DUNIT');
    expect([file[8], file[9], file[10], file[11]]).toEqual([1, 1, 0, 0]);
    expect(new DataView(file.buffer).getUint32(12, true)).toBe(header.length);
    const p = readContainerPrefix(file, { magic: UNIT_MAGIC, versions: [1], maxHeaderBytes: 1024 });
    expect(p).toMatchObject({ version: 1, codec: 'gzip', header: { a: 1 } });
    expect([...p.payload]).toEqual([...payload]);
    expect(CONTAINER_PREFIX_BYTES).toBe(16);
  });

  it('refuses another magic, version, codec, a long header, a cut header and a header that is not JSON', () => {
    const ok = writeContainer({
      magic: UNIT_MAGIC,
      version: 1,
      codec: null,
      header: enc.encode('{}'),
      payload: bytes(4),
    });
    const read = (b: Uint8Array, versions = [1], max = 64) =>
      readContainerPrefix(b, { magic: UNIT_MAGIC, versions, maxHeaderBytes: max });
    const with_ = (i: number, v: number) => {
      const b = ok.slice();
      b[i] = v;
      return b;
    };
    expect(code(() => read(ok.subarray(0, 10)))).toBe('not_ours');
    expect(code(() => read(with_(0, 0x34)))).toBe('not_ours');
    expect(code(() => read(with_(8, 2)))).toBe('version');
    expect(code(() => read(with_(8, 2), [1, 2]))).toBe('no error');
    expect(code(() => read(with_(9, 7)))).toBe('codec');
    expect(code(() => read(with_(10, 1)))).toBe('codec');
    const long = writeContainer({
      magic: UNIT_MAGIC,
      version: 1,
      codec: null,
      header: enc.encode(`"${'x'.repeat(100)}"`),
      payload: bytes(1),
    });
    expect(code(() => read(long))).toBe('header_too_large');
    expect(code(() => read(long.subarray(0, 40), [1], 1000))).toBe('cut_short');
    const bad = writeContainer({
      magic: UNIT_MAGIC,
      version: 1,
      codec: null,
      header: new Uint8Array([0xff, 0xfe]),
      payload: bytes(1),
    });
    expect(code(() => read(bad))).toBe('bad_header');
  });
});

describe('deterministic gzip', () => {
  it('gives the same bytes every time, with zero time, level hint 0 and system 255', () => {
    const body = bytes(100_000, 7);
    const a = gzipDeterministic(body);
    const b = gzipDeterministic(body.slice());
    expect([...a]).toEqual([...b]);
    expect([...a.subarray(0, 10)]).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]);
    // a writer that sets a time and a system byte normalizes to the same header
    const other = normalizeGzipHeader(gzipSync(body, { level: 6, mtime: Date.UTC(2020, 1, 1) }));
    expect([...other]).toEqual([...a]);
  });
});

describe('the bounded inflate', () => {
  it('unpacks into exactly the declared size, in 4 KiB slices', () => {
    const body = bytes(300_000, 3);
    const gz = gzipDeterministic(body);
    expect(gz.length).toBeGreaterThan(INFLATE_SLICE_BYTES * 10);
    expect(INFLATE_SLICE_BYTES).toBe(4096);
    const out = gunzipBounded(gz, body.length);
    expect(out.length).toBe(body.length);
    expect(out.buffer.byteLength).toBe(body.length);
    expect(sha256Hex(out)).toBe(sha256Hex(body));
    expect(gunzipBounded(gzipDeterministic(new Uint8Array(0)), 0).length).toBe(0);
  });

  it('refuses more or fewer bytes than declared, a second member, a bad checksum and garbage', () => {
    const body = bytes(5000, 5);
    const gz = gzipDeterministic(body);
    expect(code(() => gunzipBounded(gz, body.length - 1))).toBe('corrupt');
    expect(code(() => gunzipBounded(gz, body.length + 1))).toBe('corrupt');
    // a bomb is refused at the first slice past the declared size, not unpacked to its end
    const bomb = gzipDeterministic(new Uint8Array(32 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(() => gunzipBounded(bomb, 1024)).toThrow(/unpacks to more than it says/);
    expect(() => gunzipBounded(gz, body.length + 1)).toThrow(/fewer bytes than it says/);
    const two = new Uint8Array(gz.length * 2);
    two.set(gz, 0);
    two.set(gz, gz.length);
    expect(code(() => gunzipBounded(two, body.length))).toBe('corrupt');
    expect(code(() => gunzipBounded(two, body.length * 2))).toBe('corrupt');
    const crc = gz.slice();
    crc[crc.length - 8] ^= 0xff;
    expect(code(() => gunzipBounded(crc, body.length))).toBe('corrupt');
    expect(code(() => gunzipBounded(bytes(100), 100))).toBe('corrupt');
    expect(code(() => gunzipBounded(gz.subarray(0, 12), body.length))).toBe('corrupt');
    expect(code(() => gunzipBounded(gz.subarray(0, gz.length - 20), body.length))).toBe('corrupt');
  });
});

describe('SHA-256', () => {
  it('matches the standard vectors', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(enc.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
