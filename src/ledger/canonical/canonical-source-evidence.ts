/**
 * Provider-neutral source evidence contract.
 *
 * This module owns admission only: it proves that a capture is compact,
 * complete enough to persist, and safe to compare. SQLite lifecycle and
 * persistence remain separate capabilities.
 */
export const CANONICAL_SOURCE_STAGE = "durable-source-evidence" as const;
export const CANONICAL_SOURCE_ADMISSION = "blocked" as const;

const CANONICAL_SOURCE_RUNTIME_BRAND = Symbol(
  "canonical-source-runtime-validated-v8",
);
const OPAQUE_SOURCE_TOKEN = /^sha256:[A-Za-z0-9_-]+$/;
const SOURCE_DATE = /^\d{8}$/;
const FORBIDDEN_SOURCE_KEY =
  /raw|header|cookie|password|secret|credential|token/i;

export type CanonicalSourcePage = {
  pageOrdinal: number;
  responseCode: "200";
  rowCount: number;
  terminal: boolean;
  metadata: Record<string, unknown>;
};

export type CanonicalSourceRecord = {
  occurrenceKey: string;
  collisionKey?: string;
  providerKey: string;
  contentHash: string;
  compact: Record<string, unknown>;
};

export type CanonicalSourceAbsenceAuthority =
  | "comparable-complete-range"
  | "provider-explicit-no-data";

export type CanonicalSourceEvidence = {
  captureId: string;
  integrationNamespace: string;
  sourceConnectionKey: string;
  identityEpoch: string;
  stream: string;
  recordKind: string;
  routeKey: string;
  contractVersion: string;
  subjectDigest: string;
  observedAt: string;
  scope: {
    startDate: string;
    endDate: string;
    kind: "bounded-range" | "point-in-time";
    completeness: "complete-range" | "single-page";
    ruleVersion: string;
    absenceAuthority?: CanonicalSourceAbsenceAuthority;
  };
  pages: CanonicalSourcePage[];
  records: CanonicalSourceRecord[];
};

export type CanonicalValidatedSourceEvidence = CanonicalSourceEvidence & {
  readonly __runtimeValidatedSourceEvidence: "canonical-source-v8";
};

export class CanonicalSourceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalSourceConflictError";
  }
}

export function requireCanonicalSourceText(
  value: unknown,
  label: string,
): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required.`);
  return value.trim();
}

export function requireCanonicalSourceToken(
  value: unknown,
  label: string,
): string {
  const token = requireCanonicalSourceText(value, label);
  if (!OPAQUE_SOURCE_TOKEN.test(token))
    throw new Error(`${label} must be an opaque token.`);
  return token;
}

function requireSourceDate(value: unknown, label: string): string {
  const text = requireCanonicalSourceText(value, label);
  if (!SOURCE_DATE.test(text)) throw new Error(`${label} must be YYYYMMDD.`);
  const date = new Date(
    Date.UTC(
      Number(text.slice(0, 4)),
      Number(text.slice(4, 6)) - 1,
      Number(text.slice(6, 8)),
    ),
  );
  if (
    date.getUTCFullYear() !== Number(text.slice(0, 4)) ||
    date.getUTCMonth() !== Number(text.slice(4, 6)) - 1 ||
    date.getUTCDate() !== Number(text.slice(6, 8))
  )
    throw new Error(`${label} must be a calendar date.`);
  return text;
}

function assertCompactSourceValue(value: unknown, path: string): void {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error(`${path} contains a non-exact number.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertCompactSourceValue(entry, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (FORBIDDEN_SOURCE_KEY.test(key))
        throw new Error(`${path}.${key} is not compact source evidence.`);
      assertCompactSourceValue(entry, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path} contains an unsupported value.`);
}

export function stableCanonicalSourceJson(
  value: Record<string, unknown>,
): string {
  const canonicalize = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(canonicalize)
      : entry !== null && typeof entry === "object"
        ? Object.fromEntries(
            Object.entries(entry as Record<string, unknown>)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, nested]) => [key, canonicalize(nested)]),
          )
        : entry;
  return JSON.stringify(canonicalize(value));
}

export function validateCanonicalSourceEvidence(
  evidence: CanonicalSourceEvidence,
): void {
  requireCanonicalSourceText(evidence.captureId, "Capture ID");
  requireCanonicalSourceText(
    evidence.integrationNamespace,
    "Integration namespace",
  );
  requireCanonicalSourceToken(
    evidence.sourceConnectionKey,
    "Source connection key",
  );
  requireCanonicalSourceToken(evidence.identityEpoch, "Identity epoch");
  requireCanonicalSourceText(evidence.stream, "Stream");
  requireCanonicalSourceText(evidence.recordKind, "Record kind");
  requireCanonicalSourceText(evidence.routeKey, "Authority route");
  requireCanonicalSourceText(evidence.contractVersion, "Contract version");
  requireCanonicalSourceToken(evidence.subjectDigest, "Subject digest");
  if (!Number.isFinite(Date.parse(evidence.observedAt)))
    throw new Error("Observed at must be RFC3339.");
  const start = requireSourceDate(evidence.scope.startDate, "Scope start");
  const end = requireSourceDate(evidence.scope.endDate, "Scope end");
  if (start > end) throw new Error("Scope start must not be after scope end.");
  if (
    evidence.scope.kind !== "bounded-range" &&
    evidence.scope.kind !== "point-in-time"
  )
    throw new Error("Source scope kind is unsupported.");
  if (
    evidence.scope.absenceAuthority !== undefined &&
    evidence.scope.absenceAuthority !== "comparable-complete-range" &&
    evidence.scope.absenceAuthority !== "provider-explicit-no-data"
  )
    throw new Error("Source absence authority is unsupported.");
  requireCanonicalSourceText(
    evidence.scope.ruleVersion,
    "Completeness rule version",
  );
  if (!Array.isArray(evidence.pages) || evidence.pages.length === 0)
    throw new Error("At least one source page is required.");
  let rowCount = 0;
  evidence.pages.forEach((page, index) => {
    if (
      page.pageOrdinal !== index ||
      page.responseCode !== "200" ||
      page.terminal !== (index === evidence.pages.length - 1)
    )
      throw new Error(
        "Source page sequence/status/terminal marker is inconsistent.",
      );
    if (!Number.isSafeInteger(page.rowCount) || page.rowCount < 0)
      throw new Error("Source page row count is invalid.");
    assertCompactSourceValue(page.metadata, `page[${index}].metadata`);
    rowCount += page.rowCount;
  });
  if (!Array.isArray(evidence.records) || rowCount !== evidence.records.length)
    throw new Error("Source page counts do not match compact records.");
  const occurrences = new Set<string>();
  evidence.records.forEach((record, index) => {
    requireCanonicalSourceToken(
      record.occurrenceKey,
      `Record ${index} occurrence key`,
    );
    if (record.collisionKey !== undefined)
      requireCanonicalSourceToken(
        record.collisionKey,
        `Record ${index} collision key`,
      );
    requireCanonicalSourceToken(
      record.providerKey,
      `Record ${index} provider key`,
    );
    requireCanonicalSourceToken(
      record.contentHash,
      `Record ${index} content hash`,
    );
    if (occurrences.has(record.occurrenceKey))
      throw new CanonicalSourceConflictError(
        "Duplicate occurrence in one capture.",
      );
    occurrences.add(record.occurrenceKey);
    if (
      !record.compact ||
      typeof record.compact !== "object" ||
      Array.isArray(record.compact)
    )
      throw new Error(`Record ${index} compact payload must be an object.`);
    assertCompactSourceValue(record.compact, `record[${index}].compact`);
  });
}

export function isAdmittedCanonicalSourceEvidence(
  evidence: CanonicalSourceEvidence,
): evidence is CanonicalValidatedSourceEvidence {
  return (
    (
      evidence as CanonicalSourceEvidence & {
        [CANONICAL_SOURCE_RUNTIME_BRAND]?: true;
      }
    )[CANONICAL_SOURCE_RUNTIME_BRAND] === true
  );
}

export function admitCanonicalSourceEvidence(
  evidence: CanonicalSourceEvidence,
): CanonicalValidatedSourceEvidence {
  validateCanonicalSourceEvidence(evidence);
  Object.defineProperty(evidence, CANONICAL_SOURCE_RUNTIME_BRAND, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return evidence as CanonicalValidatedSourceEvidence;
}
