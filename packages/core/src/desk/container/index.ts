/*
 * The desk's container: framing (magic, version, codec, header, payload), deterministic and bounded
 * gzip, and SHA-256. Library unit files (desk/units) are written and read with it.
 */
export {
  CONTAINER_ERROR_CODES,
  CONTAINER_PREFIX_BYTES,
  ContainerError,
  UNIT_MAGIC,
  readContainerPrefix,
  writeContainer,
  type ContainerCodec,
  type ContainerErrorCode,
  type ContainerPrefix,
} from './framing';
export { INFLATE_SLICE_BYTES, gunzipBounded, gzipDeterministic, normalizeGzipHeader } from './gzip';
export { bytesToHexLower, sha256Bytes, sha256Hex, sha256HexOfText } from './digest';
