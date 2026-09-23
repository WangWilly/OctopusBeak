import { createHash } from "node:crypto";
import { idToString, uuidV7 } from "../canonical/canonical-local-identifier.ts";
import type { CanonicalSourceAccountNumber } from "../canonical/canonical-source-evidence.ts";
import type { PGliteCanonicalFinancialCommitRequest } from "./canonical-source-store.ts";

const CATHAY_INTEGRATION_NAMESPACE = "cathay";
const CATHAY_DOMESTIC_DEPOSIT_STREAM = "domestic-deposit";
const CATHAY_DOMESTIC_DEPOSIT_AUTHORITY = "cathay/domestic-deposit/v1";
const CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE = "Asia/Taipei";
const CATHAY_POSTING_MAPPING = {
  postingStatus: "posted",
  origin: "provider_booked_history",
  basis: "query-status-success-with-accounting-date",
  ruleVersion: "cathay/domestic-deposit/v1",
} as const;
const CATHAY_COMPLETENESS_PROOF = {
  kind: "complete-range",
  basis: "success-status-scope-count-details",
  ruleVersion: "cathay/domestic-deposit/v1",
} as const;

export type CathayValidatedDomesticSync = Readonly<{
  sourceConnectionId: string;
  identityEpoch: string;
  authorityRoute: string;
  stream: string;
  observedAt: string;
  scopes: readonly Readonly<{
    accountNo: string;
    accountNumber: CanonicalSourceAccountNumber | null;
    currency: "TWD";
    startDate: string;
    endDate: string;
    absenceAuthority?: "comparable-complete-range";
    contractFingerprint: string;
    preflightFingerprint: string;
    pages: readonly Readonly<{
      pageOrdinal: number;
      rowCount: number;
      responseDigest: string;
    }>[];
    rows: readonly Readonly<{
      sequence: string;
      accountDate: string;
      transactionDateTime: string;
      description: string | null;
      utcInstantUtcUs: number;
      amount: Readonly<{ coefficient: bigint; scale: number }>;
      direction: "inflow" | "outflow";
      balance: Readonly<{ coefficient: bigint; scale: number }>;
      payload: string;
    }>[];
  }>[];
}>;

export function cathayOpaqueIdentity(value: string): string {
  const normalized = value.trim();
  if (/^sha256:[A-Za-z0-9_-]+$/u.test(normalized)) return normalized;
  return `sha256:${createHash("sha256")
    .update(`cathay/source-identity/v1|${normalized}`, "utf8")
    .digest("base64url")}`;
}

type CathayAdmissionEvidence = PGliteCanonicalFinancialCommitRequest["capture"];

function cathaySyncAdmissionEvidence(
  input: CathayValidatedDomesticSync,
  sourceConnectionKey: string,
  identityEpoch: string,
): CathayAdmissionEvidence {
  const first = input.scopes[0]!;
  const subjectDigest = cathayOpaqueIdentity(
    [
      "cathay/domestic-deposit/subject/v1",
      sourceConnectionKey,
      identityEpoch,
      ...input.scopes.map((scope) => scope.accountNo).sort(),
    ].join("|"),
  );
  const pages = input.scopes.flatMap((scope) =>
    scope.pages.map((page) => ({
      pageOrdinal: 0,
      responseCode: "200" as const,
      rowCount: page.rowCount,
      terminal: false,
      metadata: {
        source: "cathay",
        accountNo: scope.accountNo,
        scopeStart: scope.startDate,
        scopeEnd: scope.endDate,
        pageOrdinal: page.pageOrdinal,
        responseDigest: page.responseDigest,
      },
      responseDigest: page.responseDigest,
      proofKind: CATHAY_COMPLETENESS_PROOF.basis,
      contractFingerprint: cathayOpaqueIdentity(scope.contractFingerprint),
      preflightFingerprint: cathayOpaqueIdentity(scope.preflightFingerprint),
    })),
  );
  pages.forEach((page, index) => {
    page.pageOrdinal = index;
    page.terminal = index === pages.length - 1;
  });
  const records = input.scopes.flatMap((scope) =>
    scope.rows.map((row) => ({
      occurrenceKey: cathayOpaqueIdentity(
        `cathay/domestic-deposit/occurrence/v1|${scope.accountNo}|${row.sequence}|${row.payload}`,
      ),
      collisionKey: cathayOpaqueIdentity(
        `cathay/domestic-deposit/collision/v1|${scope.accountNo}|${row.sequence}|${row.payload}`,
      ),
      providerKey: cathayOpaqueIdentity(
        `cathay/domestic-deposit/provider/v1|${scope.accountNo}|${row.sequence}`,
      ),
      contentHash: cathayOpaqueIdentity(
        `cathay/domestic-deposit/content/v1|${scope.accountNo}|${row.payload}`,
      ),
      compact: JSON.parse(row.payload) as Record<string, unknown>,
      sequenceLexeme:
        input.scopes.length === 1
          ? row.sequence
          : `${scope.accountNo}:${row.sequence}`,
      description: row.description,
    })),
  );
  const captureStart = [...input.scopes]
    .map((scope) => scope.startDate)
    .sort()[0]!;
  const captureEnd = [...input.scopes]
    .map((scope) => scope.endDate)
    .sort()
    .at(-1)!;
  return {
    captureId: idToString(uuidV7()),
    integrationNamespace: CATHAY_INTEGRATION_NAMESPACE,
    sourceConnectionKey,
    identityEpoch,
    stream: input.stream,
    recordKind: "cathay-domestic-deposit",
    routeKey: input.authorityRoute,
    contractVersion: "v1",
    subjectDigest,
    observedAt: input.observedAt,
    accountNumber: first.accountNumber,
    scope: {
      startDate: captureStart,
      endDate: captureEnd,
      dateFormat: "YYYY-MM-DD",
      kind: "bounded-range",
      completeness: CATHAY_COMPLETENESS_PROOF.kind,
      ruleVersion: CATHAY_COMPLETENESS_PROOF.ruleVersion,
      completenessBasis: CATHAY_COMPLETENESS_PROOF.basis,
      ...(first.absenceAuthority
        ? { absenceAuthority: first.absenceAuthority }
        : {}),
      sourceAccountKey:
        input.scopes.length === 1 ? first.accountNo : null,
      accountNo: input.scopes.length === 1 ? first.accountNo : null,
    },
    pages,
    records,
  };
}

/** Build the serializable PGlite request from the validator's admitted result. */
export function buildCathayDomesticFinancialRequestsForPGlite(
  input: CathayValidatedDomesticSync,
): PGliteCanonicalFinancialCommitRequest[] {
  const sourceConnectionKey = cathayOpaqueIdentity(input.sourceConnectionId);
  const identityEpoch = cathayOpaqueIdentity(input.identityEpoch);
  return input.scopes.map((scope) => {
    const capture = cathaySyncAdmissionEvidence(
      { ...input, scopes: [scope] },
      sourceConnectionKey,
      identityEpoch,
    );
    const transactions = scope.rows.map((row, index) => ({
      sourceOccurrenceKey: capture.records[index]!.occurrenceKey,
      sourceSequence: row.sequence,
      amount: {
        coefficient: row.amount.coefficient.toString(),
        scale: row.amount.scale,
      },
      balanceAfter: {
        coefficient: row.balance.coefficient.toString(),
        scale: row.balance.scale,
      },
      currency: scope.currency,
      direction: row.direction,
      postingStatus: CATHAY_POSTING_MAPPING.postingStatus,
      postingOrigin: CATHAY_POSTING_MAPPING.origin,
      postingBasis: CATHAY_POSTING_MAPPING.basis,
      postingRuleVersion: CATHAY_POSTING_MAPPING.ruleVersion,
      description: row.description,
      economicStatus: "normal" as const,
      administrativeState: "active" as const,
      semanticRuleVersion: CATHAY_POSTING_MAPPING.ruleVersion,
      effectiveOn: row.accountDate,
      transactionDateTimeLocal: row.transactionDateTime,
      timeZone: CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE as "Asia/Taipei",
      timePrecision: "second" as const,
      timeOrigin: "source_reported" as const,
      effectiveTimeBasis: "accounting" as const,
      effectiveTimeRuleVersion: CATHAY_POSTING_MAPPING.ruleVersion,
      utcInstantUtcUs: row.utcInstantUtcUs,
    }));
    return {
      capture: { ...capture, accountNumber: scope.accountNumber },
      account: {
        sourceAccountKey: scope.accountNo,
        accountNo: scope.accountNumber?.value ?? null,
        accountType: "depository",
        currency: scope.currency,
      },
      accountIdentifier: scope.accountNumber,
      transactions,
      withdrawalPolicy:
        scope.absenceAuthority === "comparable-complete-range"
          ? "allow-inference"
          : "never-infer",
    };
  });
}
