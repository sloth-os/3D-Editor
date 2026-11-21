/*
 * The one error library units throw, with a stable code saying why. The desk maps them to the
 * protocol's refusals (docs/embedding.md, "Library units"): UNIT_NOT_A_UNIT, UNIT_CORRUPT and
 * UNIT_BAD_RECORD are 'unreadable', UNIT_VERSION and UNIT_SCHEMA_NEWER 'too_new', UNIT_TOO_LARGE
 * 'too_large'; the others are mistakes of the caller (a bad spec or key, a missing or taken id).
 */

export const UNIT_ERROR_CODES = [
  /** Not a unit file (another magic, too short, another format in the header). */
  'UNIT_NOT_A_UNIT',
  /** A container or header version this desk does not read. */
  'UNIT_VERSION',
  /** Written by a newer desk: a newer document schema, or block kinds this desk does not know. */
  'UNIT_SCHEMA_NEWER',
  /** Over a limit: the file (32 MiB), its header (64 KiB) or its unpacked body (128 MiB). */
  'UNIT_TOO_LARGE',
  /** The file does not unpack, fails its digest, or its header or body does not read. */
  'UNIT_CORRUPT',
  /** A record of the body is malformed: a dangling reference, a bad source id, a reserved value. */
  'UNIT_BAD_RECORD',
  /** What was asked does not make a unit (a missing name, a figure that is not an actor …). */
  'UNIT_BAD_SPEC',
  /** The unit would hold nothing. */
  'UNIT_EMPTY',
  /** An instance key that does not match UNIT_KEY_PATTERN. */
  'UNIT_BAD_KEY',
  /** The object named is not there, or is not an instance root. */
  'UNIT_NOT_FOUND',
  /** A unit of another kind than the instance it should update or replace. */
  'UNIT_KIND_MISMATCH',
  /** An instance with this key is already in the document. */
  'UNIT_INSTANCE_EXISTS',
  /** An id the unit's parts derive to is taken by something else. */
  'UNIT_ID_TAKEN',
] as const;
export type UnitErrorCode = (typeof UNIT_ERROR_CODES)[number];

export class UnitError extends Error {
  constructor(
    readonly code: UnitErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UnitError';
  }
}
