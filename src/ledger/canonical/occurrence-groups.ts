import { createHash } from "node:crypto";
import { isOpaqueCanonicalSourceToken } from "./canonical-source-evidence.ts";

export type CanonicalOccurrenceGroup = Readonly<{
  scopeKey: string;
  fingerprint: string;
  partitionDate: string;
  ordinal: number;
}>;

/** Complete date coverage that makes an occurrence group's count comparable. */
export type CanonicalOccurrenceGroupCoverage = Readonly<{
  /** Stable semantic/source account scope, independent of query buckets. */
  scopeKey: string;
  startDate: string;
  endDate: string;
  contractVersion: string;
  /**
   * Exact complete query inventory, including empty source buckets. When
   * present, group counts are comparable only against captures with this
   * same whole inventory; date bounds do not stand in for query membership.
   */
  bucketKeys?: readonly string[];
}>;

export type AssignedOccurrenceSlot<T> = Readonly<{
  row: T;
  occurrenceKey: string;
  collisionKey: string;
  group: CanonicalOccurrenceGroup;
}>;

export type AssignOccurrenceSlotsInput<T> = Readonly<{
  rows: readonly T[];
  /** Completeness is established by the source adapter's capture contract. */
  complete: boolean;
  fingerprint: (row: T) => string;
  partitionDate: (row: T) => string;
  /** Stable identity for a comparable source bucket, independent of query dates. */
  scopeKey: (row: T) => string;
  /** Optional provider-specific occurrence key, with the 1-based group ordinal. */
  key?: (row: T, ordinal: number) => string;
  /** Optional stable fence used to reject contradictory financial claims. */
  collisionKey?: (row: T, ordinal: number) => string;
}>;

export type OccurrenceGroupCaptureAmbiguity = Readonly<{
  billingStatusConflict: boolean;
  queryBucketConflict: boolean;
}>;

/**
 * Detect indistinguishable transactions split across incompatible source
 * billing states or collection buckets. Providers supply the semantic
 * fingerprint and source bucket because those contracts differ by adapter.
 */
export function findOccurrenceGroupCaptureAmbiguity<T>(input: Readonly<{
  rows: readonly T[];
  fingerprint: (row: T) => string;
  billingStatus: (row: T) => string;
  bucketKey: (row: T) => string;
}>): OccurrenceGroupCaptureAmbiguity {
  const byFingerprint = new Map<string, { billingStatuses: Set<string>; bucketKeys: Set<string> }>();
  for (const row of input.rows) {
    const fingerprint = input.fingerprint(row);
    const entry = byFingerprint.get(fingerprint) ?? {
      billingStatuses: new Set<string>(),
      bucketKeys: new Set<string>(),
    };
    entry.billingStatuses.add(input.billingStatus(row));
    entry.bucketKeys.add(input.bucketKey(row));
    byFingerprint.set(fingerprint, entry);
  }
  return {
    billingStatusConflict: [...byFingerprint.values()].some((entry) => entry.billingStatuses.size > 1),
    queryBucketConflict: [...byFingerprint.values()].some((entry) => entry.bucketKeys.size > 1),
  };
}

/**
 * Assigns stable slots within complete semantic groups.
 *
 * The caller proves the capture is complete and removes only transport-level
 * duplicates supported by source evidence before calling this function. Rows
 * that are equal by content remain separate occurrences and receive separate
 * ordinals. Collection order is used only to order indistinguishable members
 * of the same group; it is never part of the default occurrence key.
 */
export function assignOccurrenceSlots<T>(
  input: AssignOccurrenceSlotsInput<T>,
): readonly AssignedOccurrenceSlot<T>[] {
  if (!input.complete)
    throw new Error("Occurrence slots require a complete source capture.");
  if (!Array.isArray(input.rows))
    throw new Error("Occurrence rows must be an array.");

  const counts = new Map<string, number>();
  const occurrenceKeys = new Set<string>();
  const collisionKeys = new Set<string>();
  const result: AssignedOccurrenceSlot<T>[] = [];
  for (const row of input.rows) {
    const scopeKey = input.scopeKey(row);
    if (!isOpaqueCanonicalSourceToken(scopeKey))
      throw new Error("Occurrence group scope key must be an opaque source token.");
    const fingerprint = input.fingerprint(row);
    if (!isOpaqueCanonicalSourceToken(fingerprint))
      throw new Error("Occurrence group fingerprint must be an opaque source token.");
    const date = input.partitionDate(row);
    if (!isIsoCalendarDate(date))
      throw new Error("Occurrence group partition date must be a valid YYYY-MM-DD date.");

    const groupKey = JSON.stringify([scopeKey, date, fingerprint]);
    const ordinal = (counts.get(groupKey) ?? 0) + 1;
    counts.set(groupKey, ordinal);
    const occurrenceKey = input.key?.(row, ordinal) ??
      occurrenceSlotToken([scopeKey, fingerprint, date, ordinal]);
    const collisionKey = input.collisionKey?.(row, ordinal) ?? occurrenceKey;
    if (!isOpaqueCanonicalSourceToken(occurrenceKey))
      throw new Error("Occurrence key must be an opaque source token.");
    if (!isOpaqueCanonicalSourceToken(collisionKey))
      throw new Error("Occurrence collision key must be an opaque source token.");
    if (occurrenceKeys.has(occurrenceKey))
      throw new Error("Occurrence keys must be unique within a capture.");
    if (collisionKeys.has(collisionKey))
      throw new Error("Occurrence collision keys must be unique within a capture.");
    occurrenceKeys.add(occurrenceKey);
    collisionKeys.add(collisionKey);

    result.push({
      row,
      occurrenceKey,
      collisionKey,
      group: { scopeKey, fingerprint, partitionDate: date, ordinal },
    });
  }
  return result;
}

function occurrenceSlotToken(parts: readonly (string | number)[]): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(parts), "utf8")
    .digest("base64url")}`;
}

/** Derive the stable financial source key for an admitted occurrence slot. */
export function canonicalOccurrenceGroupKey(
  group: CanonicalOccurrenceGroup,
): string {
  return occurrenceSlotToken([
    group.scopeKey,
    group.fingerprint,
    group.partitionDate,
    group.ordinal,
  ]);
}

/** Stable serialization used only to compare complete query inventories. */
export function canonicalOccurrenceGroupBucketInventory(
  bucketKeys: readonly string[],
): string {
  const sorted = [...bucketKeys].sort((left, right) => left.localeCompare(right));
  if (new Set(sorted).size !== sorted.length)
    throw new Error("Occurrence-group bucket inventory cannot contain duplicates.");
  return JSON.stringify(sorted);
}

function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
