/*
 * Serving the files of video exports over HTTP: their media types, strong ETags (from the SHA-256
 * every file records) and single byte ranges (players and rideo fetch MP4 clips with Range
 * requests; a request with several ranges gets the whole file, as RFC 9110 allows).
 */

const TYPES: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  json: 'application/json',
};

/** The media type of an export file by its extension. */
export function contentTypeOf(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  return TYPES[ext] ?? 'application/octet-stream';
}

/** A strong ETag from a file's SHA-256 (hex). */
export function etagOf(sha256: string): string {
  return `"${sha256}"`;
}

/**
 * The byte range a Range header asks for in a file of `size` bytes: `{start, end}` (inclusive),
 * 'unsatisfiable' (answer 416), or null (no usable single range: answer the whole file).
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null; // several ranges or another unit: the whole file
  const [, a, b] = m;
  if (!a && !b) return null;
  if (!a) {
    // the last `b` bytes
    const n = Number(b);
    if (!(n > 0) || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (!Number.isSafeInteger(start) || start >= size) return 'unsatisfiable';
  const end = b ? Math.min(size - 1, Number(b)) : size - 1;
  if (!Number.isSafeInteger(end) || end < start) return b && Number(b) < start ? null : 'unsatisfiable';
  return { start, end };
}

/** Whether an If-None-Match header matches the ETag (weak comparison, `*` matches anything). */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const strip = (t: string) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => strip(t) === '*' || strip(t) === strip(etag));
}
