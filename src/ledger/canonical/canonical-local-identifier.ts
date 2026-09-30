import { randomBytes } from "node:crypto";

/**
 * The canonical local identifier is an in-process UUID value.  Its binary
 * representation is intentionally kept independent from the schema lifecycle
 * so domain readers and writers do not need to import physical schema code
 * merely to normalise an identifier.
 */
export type CanonicalId = Buffer;

/** Create a UUIDv7 identifier using the current wall-clock milliseconds. */
export function uuidV7(): CanonicalId {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Date.now());
  for (let index = 0; index < 6; index += 1)
    bytes[index] = Number((timestamp >> BigInt(40 - index * 8)) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes;
}

/** Convert a 16-byte local identifier to its canonical UUID spelling. */
export function idToString(value: unknown): string {
  const bytes = value instanceof Uint8Array ? Buffer.from(value) : undefined;
  if (!bytes || bytes.length !== 16)
    throw new Error("Canonical ID must be a 16-byte UUID blob.");
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Parse a canonical UUID spelling into the local binary representation. */
export function idFromString(value: string): CanonicalId {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new Error("Canonical ID must be a UUID string.");
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

/**
 * Validate and copy a value before it crosses a SQLite binding seam.  A copy
 * prevents callers from mutating an input buffer after it has been accepted
 * as a canonical identifier.
 */
export function blob(value: unknown): CanonicalId {
  return value instanceof Uint8Array && value.byteLength === 16
    ? Buffer.from(value)
    : (() => {
        throw new Error("Expected a 16-byte canonical ID blob.");
      })();
}

/** Compare two identifier representations without exposing their encoding. */
export function canonicalIdsEqual(left: unknown, right: unknown): boolean {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array))
    return false;
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}
