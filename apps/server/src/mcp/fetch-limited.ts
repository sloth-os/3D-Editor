import { isIP } from 'node:net';

export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

/** Hosts that must never be fetched on behalf of an agent (cloud metadata services). */
function isForbiddenHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'metadata.google.internal' || h === 'metadata' || h === 'fd00:ec2::254') return true;
  if (isIP(h) === 4 && h.startsWith('169.254.')) return true;
  return false;
}

/**
 * Downloads a model file for `import_model`: http(s) only, size capped (checked against
 * Content-Length and while streaming), with a timeout.
 */
export async function fetchLimited(
  rawUrl: string,
  opts: { maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ data: Uint8Array; contentType?: string; url: URL }> {
  const maxBytes = opts.maxBytes ?? MAX_IMPORT_BYTES;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`invalid URL '${rawUrl}'`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('only http and https URLs can be imported');
  if (isForbiddenHost(url.hostname)) throw new Error(`fetching from ${url.hostname} is not allowed`);
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const finalUrl = new URL(res.url || url.toString());
  if (isForbiddenHost(finalUrl.hostname))
    throw new Error(`fetching from ${finalUrl.hostname} is not allowed`);
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error(`file too large (${declared} bytes, limit ${maxBytes})`);
  if (!res.body)
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? undefined,
      url: finalUrl,
    };
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`file too large (more than ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  const data = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    data.set(c, off);
    off += c.byteLength;
  }
  return { data, contentType: res.headers.get('content-type') ?? undefined, url: finalUrl };
}
