import { requireCanonicalSourceText, requireCanonicalSourceToken } from "./canonical-source-evidence.ts";
import { canonicalOccurrenceGroupBucketInventory, type CanonicalOccurrenceGroup, type CanonicalOccurrenceGroupCoverage } from "./occurrence-groups.ts";

export class CanonicalOccurrenceGroupConflictError extends Error {
  constructor(message: string) { super(message); this.name = "CanonicalOccurrenceGroupConflictError"; }
}

type OccurrenceRecord = Readonly<{
  occurrenceGroup?: CanonicalOccurrenceGroup;
  occurrenceGroupBucketKey?: string;
}>;

/** Shared capture-local proof. Route and financial-fact authority remain at each boundary. */
export function assertCanonicalOccurrenceGroupEvidence(input: Readonly<{
  records: readonly OccurrenceRecord[];
  coverage?: readonly CanonicalOccurrenceGroupCoverage[];
  scopeStart: string;
  scopeEnd: string;
  contractVersion: string;
  coverageMode?: "queried-buckets";
  // Financial adapters validate transaction records; generic evidence also carries observations.
  requireRecordGroups: boolean;
}>): void {
  const coverage = input.coverage;
  if (coverage === undefined) {
    if (input.records.some(record => record.occurrenceGroup !== undefined || record.occurrenceGroupBucketKey !== undefined))
      throw new Error("Occurrence group records require complete coverage evidence.");
    return;
  }
  if (!Array.isArray(coverage) || coverage.length === 0)
    throw new Error("Occurrence group coverage must contain at least one source bucket.");
  const coverageRanges: Array<Readonly<{
    scopeKey: string;
    startDate: string;
    endDate: string;
    contractVersion: string;
    bucketKeys?: readonly string[];
    bucketInventoryJson?: string;
  }>> = [];
  const queriedBucketScopes = new Set<string>();
  for (let index = 0; index < coverage.length; index += 1) {
    const entry = coverage[index];
    if (!entry || typeof entry !== "object")
      throw new Error(`Occurrence group coverage ${index} is invalid.`);
    requireCanonicalSourceToken(entry.scopeKey, `Occurrence group coverage ${index} scope key`);
    requireCanonicalSourceText(entry.contractVersion, `Occurrence group coverage ${index} contract version`);
    if (entry.contractVersion !== input.contractVersion)
      throw new Error("Occurrence group coverage contract version must match the source contract.");
    const startDate = requireOccurrenceDate(entry.startDate, `Occurrence group coverage ${index} start`);
    const endDate = requireOccurrenceDate(entry.endDate, `Occurrence group coverage ${index} end`);
    if (startDate > endDate)
      throw new Error(`Occurrence group coverage ${index} start must not be after its end.`);
    if (startDate < input.scopeStart || endDate > input.scopeEnd)
      throw new Error(`Occurrence group coverage ${index} must be inside the source scope.`);
    if (coverageRanges.some((prior) =>
      prior.scopeKey === entry.scopeKey &&
      startDate <= prior.endDate && prior.startDate <= endDate
    ))
      throw new Error("Occurrence group coverage ranges for one source bucket cannot overlap.");
    const bucketKeys = entry.bucketKeys;
    if (input.coverageMode === "queried-buckets") {
      if (queriedBucketScopes.has(entry.scopeKey))
        throw new Error("Queried-bucket coverage must contain one complete inventory per scope.");
      queriedBucketScopes.add(entry.scopeKey);
      if (!Array.isArray(bucketKeys) || bucketKeys.length === 0)
        throw new Error("This source route requires a complete queried-bucket inventory.");
      for (const [bucketIndex, bucketKey] of bucketKeys.entries())
        requireCanonicalSourceText(
          bucketKey,
          `Occurrence group coverage ${index} bucket ${bucketIndex}`,
        );
    } else if (bucketKeys !== undefined) {
      throw new Error("Queried-bucket coverage is not registered for this source route.");
    }
    let bucketInventoryJson: string | undefined;
    if (bucketKeys !== undefined) {
      try {
        bucketInventoryJson = canonicalOccurrenceGroupBucketInventory(bucketKeys);
      } catch {
        throw new Error("Occurrence group bucket inventory contains duplicate keys.");
      }
    }
    coverageRanges.push({
      scopeKey: entry.scopeKey,
      startDate,
      endDate,
      contractVersion: entry.contractVersion,
      ...(bucketKeys === undefined ? {} : { bucketKeys, bucketInventoryJson }),
    });
  }

  const ordinalsByGroup = new Map<string, Set<number>>();
  const bucketsByGroup = new Map<string, string>();
  for (const [index, record] of input.records.entries()) {
    const group = record.occurrenceGroup;
    if (group === undefined) {
      if (input.requireRecordGroups)
        throw new Error("Financial record lacks its required semantic occurrence group.");
      if (record.occurrenceGroupBucketKey !== undefined)
        throw new Error("Only grouped source records may carry bucket provenance.");
      continue;
    }
    if (!group || typeof group !== "object")
      throw new Error(`Record ${index} occurrence group is invalid.`);
    requireCanonicalSourceToken(group.scopeKey, `Record ${index} occurrence group scope key`);
    requireCanonicalSourceToken(group.fingerprint, `Record ${index} occurrence group fingerprint`);
    const partitionDate = requireOccurrenceDate(group.partitionDate, `Record ${index} occurrence group date`);
    if (!Number.isSafeInteger(group.ordinal) || group.ordinal < 1)
      throw new Error(`Record ${index} occurrence group ordinal must be a positive integer.`);
    const coveringRanges = coverageRanges.filter((range) =>
      range.scopeKey === group.scopeKey &&
      (range.bucketInventoryJson !== undefined
        ? typeof record.occurrenceGroupBucketKey === "string" &&
          range.bucketKeys?.includes(record.occurrenceGroupBucketKey) === true
        : range.startDate <= partitionDate && partitionDate <= range.endDate)
    );
    if (coveringRanges.length !== 1)
      throw new Error(`Record ${index} occurrence group is not covered by exactly one complete source bucket.`);
    if (input.coverageMode === "queried-buckets" && typeof record.occurrenceGroupBucketKey !== "string")
      throw new Error(`Record ${index} must identify its queried source bucket.`);
    if (input.coverageMode !== "queried-buckets" && record.occurrenceGroupBucketKey !== undefined)
      throw new Error(`Record ${index} has unregistered queried-bucket provenance.`);
    const groupKey = JSON.stringify([group.scopeKey, partitionDate, group.fingerprint]);
    if (input.coverageMode === "queried-buckets") {
      const bucketKey = record.occurrenceGroupBucketKey!;
      const previousBucket = bucketsByGroup.get(groupKey);
      if (previousBucket !== undefined && previousBucket !== bucketKey)
        throw new CanonicalOccurrenceGroupConflictError(
          "An indistinguishable occurrence group cannot span source query buckets.",
        );
      bucketsByGroup.set(groupKey, bucketKey);
    }
    const ordinals = ordinalsByGroup.get(groupKey) ?? new Set<number>();
    if (ordinals.has(group.ordinal))
      throw new CanonicalOccurrenceGroupConflictError(
        "Occurrence group ordinal is duplicated in one capture.",
      );
    ordinals.add(group.ordinal);
    ordinalsByGroup.set(groupKey, ordinals);
  }
  for (const ordinals of ordinalsByGroup.values()) {
    const sortedOrdinals = [...ordinals].sort((left, right) => left - right);
    if (sortedOrdinals.some((ordinal, index) => ordinal !== index + 1))
      throw new CanonicalOccurrenceGroupConflictError(
        "Occurrence group ordinals must be contiguous from one.",
      );
  }
}

function requireOccurrenceDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    throw new Error(label + " must be a valid YYYY-MM-DD date.");
  const parsed = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value)
    throw new Error(label + " must be a valid YYYY-MM-DD date.");
  return value;
}
