/*
 * The desk's container framing, shared by library unit files (desk/units) and, in a later version,
 * the desk state (apps/web/src/embed/state.ts keeps its own copy of the same layout for now):
 *
 *   bytes 0–7    magic (UNIT_MAGIC for a unit: "3DUNIT\r\n")
 *   byte  8      container version
 *   byte  9      payload codec: 0 none, 1 gzip
 *   bytes 10–11  0
 *   bytes 12–15  header length (uint32, little-endian)
 *   header       UTF-8 JSON
 *   payload      the body, gzipped when the codec says so
 *
 * The header is read without the payload, so a file is recognized (and refused) before anything is
 * unpacked. Everything here is plain TypeScript (no DOM, no Node API): it runs in the desk's page,
 * its staging worker and Node.
 */

/** The first bytes of a library unit file: "3DUNIT\r\n" (defined only here). */
export const UNIT_MAGIC: Readonly<Uint8Array> = new Uint8Array([
  0x33, 0x44, 0x55, 0x4e, 0x49, 0x54, 0x0d, 0x0a,
]);

/** Bytes before the header: magic, version, codec, two zero bytes, header length. */
export const CONTAINER_PREFIX_BYTES = 16;

/** How a container's payload is stored. */
export type ContainerCodec = 'gzip' | null;

/** Why a container does not read (or cannot be written). */
export const CONTAINER_ERROR_CODES = [
  /** Too short for a prefix, or another magic: not a file of this kind. */
  'not_ours',
  /** A container version this code does not read. */
  'version',
  /** A codec byte other than 0 or 1, or bytes 10–11 not zero. */
  'codec',
  /** The header is longer than the reader allows. */
  'header_too_large',
  /** The file ends before its header does, or before its payload unpacks in full. */
  'cut_short',
  /** The header is not UTF-8 JSON. */
  'bad_header',
  /** The payload does not unpack, unpacks to more or less than it says, or fails its checksum. */
  'corrupt',
  /** The payload would unpack to more than this runtime can hold. */
  'too_large',
] as const;
export type ContainerErrorCode = (typeof CONTAINER_ERROR_CODES)[number];

/** The one error the container code throws, with a code saying why. */
export class ContainerError extends Error {
  constructor(
    readonly code: ContainerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ContainerError';
  }
}

/**
 * A container: the prefix (magic, `version`, the codec byte), the header bytes and the payload as
 * given (gzip it first for codec 'gzip'). The same inputs give the same bytes.
 */
export function writeContainer(o: {
  magic: Readonly<Uint8Array>;
  version: number;
  codec: ContainerCodec;
  header: Uint8Array;
  payload: Uint8Array;
}): Uint8Array {
  if (o.magic.length !== 8) throw new RangeError('a container magic is 8 bytes');
  if (!Number.isInteger(o.version) || o.version < 1 || o.version > 255)
    throw new RangeError('a container version is an integer from 1 to 255');
  const out = new Uint8Array(CONTAINER_PREFIX_BYTES + o.header.length + o.payload.length);
  out.set(o.magic, 0);
  out[8] = o.version;
  out[9] = o.codec === 'gzip' ? 1 : 0;
  new DataView(out.buffer).setUint32(12, o.header.length, true);
  out.set(o.header, CONTAINER_PREFIX_BYTES);
  out.set(o.payload, CONTAINER_PREFIX_BYTES + o.header.length);
  return out;
}

/** A container's prefix and header, read without touching its payload. */
export interface ContainerPrefix {
  version: number;
  codec: ContainerCodec;
  /** The header's bytes (a view into the file). */
  headerBytes: Uint8Array;
  /** The header, parsed from UTF-8 JSON (not validated: the caller checks its shape). */
  header: unknown;
  /** The payload (a view into the file), still packed when the codec is gzip. */
  payload: Uint8Array;
}

/**
 * Reads a container's prefix and header: the magic must be `magic`, the version one of `versions`
 * and the header at most `maxHeaderBytes`. Throws a ContainerError (not_ours, version, codec,
 * header_too_large, cut_short, bad_header).
 */
export function readContainerPrefix(
  bytes: Uint8Array,
  o: { magic: Readonly<Uint8Array>; versions: readonly number[]; maxHeaderBytes: number },
): ContainerPrefix {
  if (bytes.length < CONTAINER_PREFIX_BYTES || o.magic.some((b, i) => bytes[i] !== b))
    throw new ContainerError('not_ours', 'not a file of this kind (its first bytes differ)');
  const version = bytes[8];
  if (!o.versions.includes(version))
    throw new ContainerError(
      'version',
      `its container is version ${version}; this reads ${o.versions.join(' and ')}`,
    );
  if ((bytes[9] !== 0 && bytes[9] !== 1) || bytes[10] !== 0 || bytes[11] !== 0)
    throw new ContainerError('codec', 'it is packed in an unknown way');
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true);
  if (headerLength > o.maxHeaderBytes)
    throw new ContainerError(
      'header_too_large',
      `its header is ${headerLength} bytes, over the ${o.maxHeaderBytes} it may have`,
    );
  if (CONTAINER_PREFIX_BYTES + headerLength > bytes.length)
    throw new ContainerError('cut_short', 'it ends before its header does');
  const headerBytes = bytes.subarray(CONTAINER_PREFIX_BYTES, CONTAINER_PREFIX_BYTES + headerLength);
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headerBytes));
  } catch {
    throw new ContainerError('bad_header', 'its header is not UTF-8 JSON');
  }
  return {
    version,
    codec: bytes[9] === 1 ? 'gzip' : null,
    headerBytes,
    header,
    payload: bytes.subarray(CONTAINER_PREFIX_BYTES + headerLength),
  };
}
