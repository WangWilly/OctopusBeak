import { createHash } from "node:crypto";

/**
 * SHA-256 of a domain label and its values, each value preceded by a NUL
 * byte, as a `sha256:` base64url token. Every deposit admission derives its
 * identity, fence, occurrence, and content tokens this way, so the bytes are
 * part of each frozen identity formula (ADR 0035).
 */
export function canonicalDigest(domain: string, ...values: readonly string[]): `sha256:${string}` {
  const hash = createHash("sha256").update(domain);
  for (const value of values) hash.update("\0").update(value);
  return `sha256:${hash.digest("base64url")}`;
}
