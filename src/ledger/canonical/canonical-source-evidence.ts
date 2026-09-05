/**
 * Provider-neutral source evidence contract.
 *
 * This module defines the provider-facing evidence data contract. Runtime
 * validation, branding, and persistence belong to Source Capture Admission.
 */
export const CANONICAL_SOURCE_STAGE = "durable-source-evidence" as const;
export const CANONICAL_SOURCE_ADMISSION = "blocked" as const;

const OPAQUE_SOURCE_TOKEN = /^sha256:[A-Za-z0-9_-]+$/;

export type CanonicalSourcePage = {
  pageOrdinal: number;
  responseCode: "200";
  rowCount: number;
  terminal: boolean;
  metadata: Record<string, unknown>;
  /** Optional provider-preserved page fields used by financial commits. */
  responseDigest?: string;
  proofKind?: string;
  contractFingerprint?: string;
  preflightFingerprint?: string;
  metadataJson?: string;
};

export type CanonicalSourceRecord = {
  occurrenceKey: string;
  collisionKey?: string;
  providerKey: string;
  contentHash: string;
  compact: Record<string, unknown>;
  /** Optional provider-preserved fields used by an embedded financial commit. */
  sequenceLexeme?: string;
  description?: string | null;
  compactJson?: string;
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
    /** Financial adapters retain the existing ISO date representation. */
    dateFormat?: "YYYYMMDD" | "YYYY-MM-DD";
    kind: "bounded-range" | "point-in-time";
    completeness: "complete-range" | "single-page";
    ruleVersion: string;
    /** Optional provider-preserved scope proof fields used by financial commits. */
    completenessBasis?: string;
    contractFingerprint?: string;
    preflightFingerprint?: string;
    /** Some provider grids mark every independently terminal page. */
    pageTerminalPolicy?: "last" | "each";
    absenceAuthority?: CanonicalSourceAbsenceAuthority;
    accountNo?: string | null;
    accountId?: Uint8Array | null;
  };
  pages: CanonicalSourcePage[];
  records: CanonicalSourceRecord[];
};

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
