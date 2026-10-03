import { createHash } from "node:crypto";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";
import {
  commitPGliteCanonicalFinancialCapture,
  commitPGliteCanonicalFinancialCaptureInTransaction,
  type PGliteCanonicalCommitOptions,
  type PGliteCanonicalFinancialCommitResult,
  type PGliteCanonicalFinancialCommitRequest,
} from "./canonical-source-store.ts";
import type {
  PGliteCanonicalBalanceObservationInput,
  PGliteCanonicalFinancialAccountInput,
  PGliteCanonicalSourceEvidence,
} from "./source-admission-validation.ts";
import { PGliteCanonicalSourceAdmissionError } from "./source-admission-validation.ts";
import type {
  CanonicalFinancialDepositCapture,
  CanonicalFinancialDepositRecord,
  CanonicalFinancialNonTransactionRecord,
} from "../canonical/canonical-financial-deposit-admission.ts";
import { isNonTransactionRecord } from "../canonical/canonical-financial-deposit-admission.ts";
import {
  requireCanonicalSourceToken,
  validateCanonicalSourceAccountNumber,
  type CanonicalSourceAccountNumber as SourceAccountNumber,
} from "../canonical/canonical-source-evidence.ts";
import { canonicalSourceRouteRegistration, canonicalSourceRuleCombination } from "../canonical/canonical-source-route-registry.ts";
import { FOREIGN_CURRENCY_DEPOSIT_AUTHORITY_METADATA } from "../canonical/foreign-currency-deposit-authorities.ts";
import { PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND } from "./workflow-commands.ts";

/** Named worker command for a typed domestic or foreign-currency deposit run. */
export { PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND };

export type PGliteCanonicalDepositCommitRequest = Readonly<{
  capture: CanonicalFinancialDepositCapture;
  /** Optional balance observations can share this exact source transaction. */
  balanceObservations?: readonly PGliteCanonicalBalanceObservationInput[];
  sourceSyncCursor?: string | null;
  recordedAtUtcUs?: number;
}>;

export type PGliteCanonicalDepositCommitCommand = Readonly<{
  kind: typeof PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND;
  request: PGliteCanonicalDepositCommitRequest;
}>;

export type PGliteCanonicalDepositCommitResult = Readonly<{
  status: "canonical-live";
  captureId: string;
  accountId: string;
  commitSequence: number;
  transactions: PGliteCanonicalFinancialCommitResult["transactions"];
  balanceRevisionCount: number;
  deduplicatedBalanceRevisionCount: number;
}>;

function parseCompactJson(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} compact JSON is invalid.`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${label} compact JSON must be an object.`);
  return parsed as Record<string, unknown>;
}

function pageMetadata(page: CanonicalFinancialDepositCapture["pages"][number]): Record<string, unknown> {
  return parseCompactJson(page.metadataJson, `Page ${page.pageOrdinal}`);
}

function providerAccountNumber(
  capture: CanonicalFinancialDepositCapture,
): SourceAccountNumber | null {
  // `accountNumber` is optional in the canonical financial capture contract.
  // Keep it optional at the worker boundary as well: accountNo/sourceAccountKey
  // is the stable join key, while this object is only a provider-supported
  // display identifier when the adapter has evidence for one.
  return capture.identity.accountNumber ?? null;
}

function sourceAccountKey(capture: CanonicalFinancialDepositCapture): string {
  const key = capture.identity.sourceAccountKey ?? capture.identity.accountNo;
  return text(key, "Source account key");
}

function invalidCapture(message: string): never {
  throw new PGliteCanonicalSourceAdmissionError("invalid-evidence", message);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") invalidCapture(`${label} is required.`);
  return value;
}

function date(value: unknown, label: string): string {
  const normalized = text(value, label);
  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized) ||
    Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized)
    invalidCapture(`${label} must be a valid YYYY-MM-DD date.`);
  return normalized;
}

function amount(value: unknown, label: string): asserts value is { coefficient: string; scale: number } {
  if (!value || typeof value !== "object" ||
    typeof (value as { coefficient?: unknown }).coefficient !== "string" ||
    !/^(?:0|[1-9]\d*)$/u.test((value as { coefficient: string }).coefficient) ||
    !Number.isSafeInteger((value as { scale?: unknown }).scale) ||
    Number((value as { scale: number }).scale) < 0)
    invalidCapture(`${label} must be an exact non-negative coefficient/scale amount.`);
}

function currency(value: unknown, label: string): string {
  const normalized = text(value, label);
  if (!/^[A-Z]{3}$/u.test(normalized) || !Intl.supportedValuesOf("currency").includes(normalized))
    invalidCapture(`${label} must be a valid ISO 4217 currency code.`);
  return normalized;
}

function sourceTime(
  record: CanonicalFinancialDepositRecord,
  defaults?: Pick<CanonicalFinancialDepositCapture["semantics"], "timePrecision" | "timeOrigin" | "effectiveTimeBasis">,
  compact?: Record<string, unknown>,
): void {
  const value = record.sourceTime;
  const localDate = date(value.localDate, "Financial record source date");
  if (!/^\d{2}:\d{2}(?::\d{2})?$/u.test(value.localTime)) invalidCapture("Financial record source time must be HH:mm or HH:mm:ss.");
  const [hour, minute, second = 0] = value.localTime.split(":").map(Number);
  if (hour! > 23 || minute! > 59 || second > 59) invalidCapture("Financial record source time is invalid.");
  if (value.timeZone !== "Asia/Taipei") invalidCapture("Financial record time zone must be Asia/Taipei.");
  const precision = value.precision ?? defaults?.timePrecision;
  const timeOrigin = value.timeOrigin ?? defaults?.timeOrigin;
  if (precision !== "date" && precision !== "minute" && precision !== "second")
    invalidCapture("Financial record time precision is invalid.");
  if ((precision === "minute" && second !== 0) ||
    (precision === "second" && value.localTime.length !== 8) ||
    (precision === "date" && (hour !== 0 || minute !== 0 || second !== 0)))
    invalidCapture("Financial record source time does not match its precision.");
  if (timeOrigin !== "source_reported" && timeOrigin !== "defaulted_local_midnight")
    invalidCapture("Financial record time origin is invalid.");
  if (precision !== "date" && timeOrigin === "defaulted_local_midnight")
    invalidCapture("Only date precision may default to local midnight.");
  if (precision === "date" && timeOrigin !== "defaulted_local_midnight")
    invalidCapture("Date precision must use the defaulted local midnight time origin.");
  const expectedEpoch = Date.parse(`${localDate}T${value.localTime}+08:00`);
  if (!Number.isSafeInteger(value.epochMilliseconds) || value.epochMilliseconds !== expectedEpoch)
    invalidCapture("Financial record source instant does not match its local time evidence.");
  date(record.effectiveOn, "Financial record effective date");
  if (defaults?.effectiveTimeBasis === "accounting") {
    if (compact?.accountingDate !== undefined
      ? compact.accountingDate !== record.effectiveOn
      : record.effectiveOn !== localDate)
      invalidCapture("Financial record effective date does not match accounting evidence.");
  } else if (record.effectiveOn !== localDate) {
    invalidCapture("Financial record effective date does not match source time.");
  }
  if (record.transactionDateTimeLocal !== `${localDate}T${value.localTime}`)
    invalidCapture("Financial record local timestamp does not match source time.");
}

type DepositRouteProfile = Readonly<{
  postingOrigin: string;
  postingBasis: string;
  effectiveTimeBasis: string;
  currency?: string;
  postingStatus?: string;
  timeZone?: string;
  timePrecision?: string;
  completeness?: "complete-range" | "single-page";
  completenessBasis?: string;
  completenessRuleVersion?: string;
  absenceAuthority?: string | null;
  withdrawalPolicy?: "allow-inference" | "never-infer";
  integrationNamespace?: string;
  stream?: string;
  recordKind?: string;
  accountType?: string;
  contractVersion?: string;
  requireProviderGuaranteedFalse?: boolean;
  absenceAuthorityOnlyWhenEmpty?: boolean;
}>;

const DOMESTIC_DEPOSIT_ROUTE_PROFILES: Readonly<Record<string, DepositRouteProfile>> = {
  "cathay/domestic-deposit/v1": {
    postingOrigin: "provider_booked_history",
    postingBasis: "query-status-success-with-accounting-date",
    effectiveTimeBasis: "accounting",
  },
  "linebank/domestic-deposit/human-attested-v13": {
    postingOrigin: "human_attested_history",
    postingBasis: "human-attested-formally-posted",
    effectiveTimeBasis: "transaction-time",
  },
  "fubon/domestic-deposit/human-attested-v1": {
    postingOrigin: "human-attested",
    postingBasis: "statement-posted-history",
    effectiveTimeBasis: "transaction-time",
  },
  "yuanta/domestic-deposit/human-attested-v2": {
    postingOrigin: "human-attested",
    postingBasis: "statement-posted-history",
    effectiveTimeBasis: "transaction-time",
    currency: "TWD",
    postingStatus: "posted",
    timeZone: "Asia/Taipei",
    timePrecision: "second",
    completeness: "complete-range",
    completenessBasis: "exact-ui-range-terminal-download",
    completenessRuleVersion: "yuanta/domestic-deposit/human-attested-v2",
    absenceAuthority: "provider-explicit-no-data",
    withdrawalPolicy: "never-infer",
    integrationNamespace: "yuanta",
    stream: "domestic-deposit",
    recordKind: "yuanta-domestic-deposit",
    accountType: "depository",
    contractVersion: "human-attested-v2",
    requireProviderGuaranteedFalse: true,
  },
  "hncb/domestic-deposit/human-attested-v1": {
    postingOrigin: "human-attested",
    postingBasis: "statement-posted-history",
    effectiveTimeBasis: "transaction-time",
    currency: "TWD",
    postingStatus: "posted",
    timeZone: "Asia/Taipei",
    timePrecision: "second",
    completeness: "complete-range",
    completenessBasis: "exact-ui-range-terminal-export",
    completenessRuleVersion: "hncb/domestic-deposit/human-attested-v1",
    absenceAuthority: "provider-explicit-no-data",
    withdrawalPolicy: "never-infer",
    integrationNamespace: "hncb",
    stream: "domestic-deposit",
    recordKind: "hncb-domestic-deposit",
    accountType: "depository",
    contractVersion: "human-attested-v1",
    requireProviderGuaranteedFalse: true,
  },
  "ctbc/domestic-deposit/human-attested-v1": {
    postingOrigin: "human-attested",
    postingBasis: "statement-posted-history",
    effectiveTimeBasis: "accounting",
    currency: "TWD",
    postingStatus: "posted",
    timeZone: "Asia/Taipei",
    timePrecision: "second",
    completeness: "complete-range",
    completenessBasis: "all-visible-ranges-terminal-next-key-empty",
    completenessRuleVersion: "ctbc/domestic-deposit/human-attested-v1",
    absenceAuthority: "provider-explicit-no-data",
    withdrawalPolicy: "never-infer",
    integrationNamespace: "ctbc",
    stream: "domestic-deposit",
    recordKind: "ctbc-domestic-deposit",
    accountType: "depository",
    contractVersion: "human-attested-v1",
    requireProviderGuaranteedFalse: true,
    absenceAuthorityOnlyWhenEmpty: true,
  },
  "sinopac/domestic-deposit/human-attested-v1": {
    postingOrigin: "human-attested",
    postingBasis: "statement-posted-history",
    effectiveTimeBasis: "transaction-time",
    currency: "TWD",
    postingStatus: "posted",
    timeZone: "Asia/Taipei",
    timePrecision: "minute",
    completeness: "complete-range",
    completenessBasis: "bounded-terminal-query",
    completenessRuleVersion: "sinopac/domestic-deposit/human-attested-v1",
    absenceAuthority: "provider-explicit-no-data",
    withdrawalPolicy: "never-infer",
    integrationNamespace: "sinopac",
    stream: "domestic-deposit",
    recordKind: "sinopac-domestic-deposit",
    accountType: "depository",
    contractVersion: "human-attested-v1",
    requireProviderGuaranteedFalse: true,
    absenceAuthorityOnlyWhenEmpty: true,
  },
  "post/domestic-deposit/human-attested-v1": {
    postingOrigin: "human-attested",
    postingBasis: "statement-posted-history",
    effectiveTimeBasis: "accounting",
    currency: "TWD",
    postingStatus: "posted",
    timeZone: "Asia/Taipei",
    timePrecision: "second",
    completeness: "complete-range",
    completenessBasis: "accepted-range-terminal-http-200-nonempty-item",
    completenessRuleVersion: "post/domestic-deposit/human-attested-v1",
    withdrawalPolicy: "never-infer",
    integrationNamespace: "post",
    stream: "domestic-deposit",
    recordKind: "post-domestic-deposit",
    accountType: "depository",
    contractVersion: "human-attested-v1",
    requireProviderGuaranteedFalse: true,
  },
};

function financialRouteProfile(routeKey: string): DepositRouteProfile | undefined {
  const domestic = DOMESTIC_DEPOSIT_ROUTE_PROFILES[routeKey];
  if (domestic) return domestic;
  const foreign = Object.values(FOREIGN_CURRENCY_DEPOSIT_AUTHORITY_METADATA).find(
    (metadata) => metadata.authorityRoute === routeKey,
  );
  if (!foreign) return undefined;
  return {
    postingOrigin: foreign.postingOrigin,
    postingBasis: "statement-posted-history",
    effectiveTimeBasis: "transaction-time",
    postingStatus: "posted",
    timeZone: "Asia/Taipei",
    completeness: "complete-range",
    completenessBasis: "foreign-currency-terminal-complete-range",
    completenessRuleVersion: foreign.contractVersion,
    absenceAuthority: "provider-explicit-no-data",
    withdrawalPolicy: "never-infer",
    integrationNamespace: foreign.integrationNamespace,
    stream: "foreign-currency-deposit",
    recordKind: foreign.recordKind,
    accountType: "depository",
    contractVersion: foreign.contractVersion,
    requireProviderGuaranteedFalse: true,
  };
}

function validateFinancialRouteSemantics(
  capture: CanonicalFinancialDepositCapture,
): void {
  const profile = financialRouteProfile(capture.authorityRoute);
  if (!profile) invalidCapture("Authority route is not a supported financial deposit route.");
  const mismatches: string[] = [];
  if (!canonicalSourceRuleCombination(
    capture.authorityRoute,
    capture.contractVersion,
    capture.semantics.postingRuleVersion,
    capture.semantics.semanticRuleVersion,
    capture.semantics.effectiveTimeRuleVersion,
  )) mismatches.push("financial rule combination");
  if (capture.semantics.postingOrigin !== profile.postingOrigin) mismatches.push("posting origin");
  if (capture.semantics.postingBasis !== profile.postingBasis) mismatches.push("posting basis");
  if (capture.semantics.effectiveTimeBasis !== profile.effectiveTimeBasis) mismatches.push("effective time basis");
  if (profile.currency !== undefined && capture.identity.currency !== profile.currency) mismatches.push("currency");
  if (profile.postingStatus !== undefined && capture.semantics.postingStatus !== profile.postingStatus) mismatches.push("posting status");
  if (profile.timeZone !== undefined && capture.semantics.timeZone !== profile.timeZone) mismatches.push("time zone");
  if (profile.timePrecision !== undefined && capture.semantics.timePrecision !== profile.timePrecision) mismatches.push("time precision");
  if (profile.completeness !== undefined && capture.scope.completeness !== profile.completeness) mismatches.push("completeness");
  if (profile.completenessBasis !== undefined && capture.scope.completenessBasis !== profile.completenessBasis) mismatches.push("completeness basis");
  if (profile.completenessRuleVersion !== undefined && capture.scope.completenessRuleVersion !== profile.completenessRuleVersion) mismatches.push("completeness rule version");
  if (profile.absenceAuthority !== undefined) {
    const expected = profile.absenceAuthorityOnlyWhenEmpty && capture.records.length > 0 ? null : profile.absenceAuthority;
    if (capture.scope.absenceAuthority !== expected) mismatches.push("absence authority");
  }
  if (profile.withdrawalPolicy !== undefined && capture.scope.withdrawalPolicy !== profile.withdrawalPolicy) mismatches.push("withdrawal policy");
  if (profile.integrationNamespace !== undefined && capture.identity.integrationNamespace !== profile.integrationNamespace) mismatches.push("integration namespace");
  if (profile.stream !== undefined && capture.identity.stream !== profile.stream) mismatches.push("stream");
  if (profile.recordKind !== undefined && capture.identity.recordKind !== profile.recordKind) mismatches.push("record kind");
  if (profile.accountType !== undefined && capture.identity.accountType !== profile.accountType) mismatches.push("account type");
  if (profile.contractVersion !== undefined && capture.contractVersion !== profile.contractVersion) mismatches.push("contract version");
  if (profile.requireProviderGuaranteedFalse &&
    (capture.semantics.providerGuaranteed === true ||
      capture.semantics.occurrenceProviderGuaranteed === true ||
      (capture.semantics.providerGuaranteed !== false && capture.semantics.occurrenceProviderGuaranteed !== false)))
    mismatches.push("provider guarantees");
  if (mismatches.length > 0) invalidCapture(`Financial capture does not match its route profile: ${mismatches.join(", ")}.`);
}

/**
 * Revalidate the serialized deposit capture at the worker boundary.  The
 * SQLite writer's WeakSet admission brand cannot cross IPC, so these checks
 * intentionally run before any PGlite transaction is opened.
 */
function validateDepositCapture(capture: CanonicalFinancialDepositCapture): void {
  if (!capture || typeof capture !== "object") invalidCapture("A financial deposit capture object is required.");
  text(capture.captureId, "Capture ID");
  text(capture.authorityRoute, "Authority route");
  text(capture.contractVersion, "Contract version");
  text(capture.identity.integrationNamespace, "Integration namespace");
  text(capture.identity.sourceConnectionKey, "Source connection key");
  text(capture.identity.identityEpochKey, "Identity epoch key");
  text(capture.identity.stream, "Financial stream");
  text(capture.identity.recordKind, "Financial record kind");
  text(capture.identity.accountNo, "Financial account number");
  if (capture.identity.sourceAccountKey !== undefined &&
    capture.identity.sourceAccountKey !== capture.identity.accountNo)
    invalidCapture("Source account key and compatibility accountNo disagree.");
  sourceAccountKey(capture);
  if (capture.identity.accountType !== "depository") invalidCapture("PGlite deposit commands require a depository account.");
  const accountNumber = providerAccountNumber(capture);
  if (accountNumber) {
    validateCanonicalSourceAccountNumber(accountNumber);
    if (accountNumber.kind !== "depository-account") invalidCapture("Deposit account-number evidence must be depository-account.");
    if (!/^\d{6,24}$/u.test(accountNumber.value)) invalidCapture("Depository account numbers must be complete provider-reported digits.");
  }
  if (capture.identity.stream !== "domestic-deposit" && capture.identity.stream !== "foreign-currency-deposit")
    invalidCapture("PGlite deposit commands support domestic and foreign-currency deposit streams only.");
  if (capture.identity.currency === "MULTI") invalidCapture("Financial account currency cannot use the MULTI sentinel.");
  if (capture.identity.currency !== null) currency(capture.identity.currency, "Financial account currency");
  const route = canonicalSourceRouteRegistration(capture.authorityRoute);
  if (!route) invalidCapture("Authority route is not registered.");
  if (route.integrationNamespace !== capture.identity.integrationNamespace || route.stream !== capture.identity.stream || !route.contractVersions.includes(capture.contractVersion))
    invalidCapture("Capture identity does not match its authority route registration.");
  if (route.completenessRuleVersions && !route.completenessRuleVersions.includes(capture.scope.completenessRuleVersion))
    invalidCapture("Capture completeness rule does not match its authority route registration.");
  validateFinancialRouteSemantics(capture);
  requireCanonicalSourceToken(capture.identity.sourceConnectionKey, "Source connection key");
  requireCanonicalSourceToken(capture.identity.identityEpochKey, "Identity epoch key");
  requireCanonicalSourceToken(capture.identity.subjectDigest, "Subject digest");
  validateCanonicalSourceAccountNumber(capture.identity.accountNumber);
  date(capture.scope.startDate, "Capture start date");
  date(capture.scope.endDate, "Capture end date");
  if (capture.scope.startDate > capture.scope.endDate) invalidCapture("Capture scope is inverted.");
  if (!Number.isSafeInteger(capture.scope.pageCount) || capture.scope.pageCount < 1 || capture.pages.length !== capture.scope.pageCount)
    invalidCapture("Capture page count does not match scope.");
  if (!capture.pages.length) invalidCapture("At least one capture page is required.");
  text(capture.scope.completenessBasis, "Completeness basis");
  text(capture.scope.completenessRuleVersion, "Completeness rule version");
  requireCanonicalSourceToken(capture.scope.contractFingerprint, "Contract fingerprint");
  requireCanonicalSourceToken(capture.scope.preflightFingerprint, "Preflight fingerprint");
  if (capture.scope.withdrawalPolicy !== undefined && capture.scope.withdrawalPolicy !== "allow-inference" && capture.scope.withdrawalPolicy !== "never-infer")
    invalidCapture("Capture withdrawal policy is invalid.");
  if (!Number.isFinite(Date.parse(capture.observedAt))) invalidCapture("Observed at must be RFC3339.");
  if (capture.semantics.timeZone !== "Asia/Taipei") invalidCapture("Financial time zone must be Asia/Taipei.");
  if (capture.semantics.postingStatus !== "posted" && capture.semantics.postingStatus !== "pending") invalidCapture("Financial posting status is invalid.");
  if (capture.semantics.economicStatus !== "normal" && capture.semantics.economicStatus !== "canceled" && capture.semantics.economicStatus !== "refund" && capture.semantics.economicStatus !== "reversal") invalidCapture("Financial economic status is invalid.");
  if (capture.semantics.administrativeState !== "active" && capture.semantics.administrativeState !== "deleted" && capture.semantics.administrativeState !== "purged") invalidCapture("Financial administrative state is invalid.");
  if (typeof capture.semantics.requireBalance !== "boolean") invalidCapture("Financial balance requirement is invalid.");
  for (const [index, page] of capture.pages.entries()) {
    if (page.pageOrdinal !== index || page.pageOrdinal < 0 || page.pageOrdinal >= capture.scope.pageCount) invalidCapture("Capture page ordinal is invalid.");
    if (page.responseCode !== "200" && page.responseCode !== "204") invalidCapture("Capture page response code is invalid.");
    if (!Number.isSafeInteger(page.rowCount) || page.rowCount < 0 || (page.responseCode === "204" && page.rowCount !== 0)) invalidCapture("Capture page row count is invalid.");
  }
  const nonTransactionRecords = capture.nonTransactionRecords ?? [];
  if (nonTransactionRecords.length > 0 && (!nonTransactionRecords.every((record) => record.recordType === "statement-evidence") || capture.scope.withdrawalPolicy !== "never-infer"))
    invalidCapture("Deposit statement evidence requires a never-infer capture scope.");
  let capturedRowCount = 0;
  for (const page of capture.pages) capturedRowCount += page.rowCount;
  if (capturedRowCount !== capture.records.length + nonTransactionRecords.length)
    invalidCapture("Capture page row count does not match admitted records.");
  const occurrences = new Set<string>();
  const collisions = new Set<string>();
  const foreign = capture.identity.stream === "foreign-currency-deposit";
  for (const record of capture.records) {
    requireCanonicalSourceToken(record.occurrenceKey, "Occurrence key");
    requireCanonicalSourceToken(record.collisionKey, "Collision key");
    if (record.providerKey !== "human-attested:no-provider-key") requireCanonicalSourceToken(record.providerKey, "Provider key");
    if (record.humanAttestedOccurrenceKey !== undefined) invalidCapture("Human-attested occurrence identity is unsupported for deposits.");
    requireCanonicalSourceToken(record.contentHash, "Content hash");
    if (occurrences.has(record.occurrenceKey) || collisions.has(record.collisionKey)) invalidCapture("Duplicate source occurrence or collision identity.");
    occurrences.add(record.occurrenceKey);
    collisions.add(record.collisionKey);
    text(record.sequenceLexeme, "Financial source sequence");
    const compact = parseCompactJson(record.compactJson, `Record ${record.occurrenceKey}`);
    amount(record.amount, "Financial transaction amount");
    if (record.balanceAfter !== null) amount(record.balanceAfter, "Financial balance amount");
    currency(record.currency, "Financial transaction currency");
    if (record.direction !== "inflow" && record.direction !== "outflow") invalidCapture("Financial transaction direction is invalid.");
    if (capture.semantics.requireBalance && record.balanceAfter === null) invalidCapture("Financial record lacks an exact balance.");
    sourceTime(record, capture.semantics, compact);
    if (foreign) {
      const expectedHash = `sha256:${createHash("sha256").update(record.compactJson).digest("base64url")}`;
      if (record.contentHash !== expectedHash) invalidCapture("Foreign financial content hash does not match compact source payload.");
      if (compact.direction !== record.direction || compact.currency !== record.currency || JSON.stringify(compact.amount) !== JSON.stringify(record.amount) || JSON.stringify(compact.balanceAfter) !== JSON.stringify(record.balanceAfter))
        invalidCapture("Foreign compact source payload does not match canonical financial facts.");
    }
  }
  for (const record of nonTransactionRecords) {
    requireCanonicalSourceToken(record.occurrenceKey, "Non-transaction occurrence key");
    requireCanonicalSourceToken(record.collisionKey, "Non-transaction collision key");
    if (record.providerKey !== "human-attested:no-provider-key") requireCanonicalSourceToken(record.providerKey, "Non-transaction provider key");
    requireCanonicalSourceToken(record.contentHash, "Non-transaction content hash");
    if (occurrences.has(record.occurrenceKey) || collisions.has(record.collisionKey)) invalidCapture("Duplicate source occurrence or collision identity.");
    occurrences.add(record.occurrenceKey);
    collisions.add(record.collisionKey);
    text(record.sequenceLexeme, "Non-transaction source sequence");
    parseCompactJson(record.compactJson, `Non-transaction record ${record.occurrenceKey}`);
  }
}

function asSourceRecord(
  record: CanonicalFinancialDepositRecord | CanonicalFinancialNonTransactionRecord,
): PGliteCanonicalSourceEvidence["records"][number] {
  return {
    occurrenceKey: record.occurrenceKey,
    collisionKey: record.collisionKey,
    providerKey: record.providerKey,
    contentHash: record.contentHash,
    compact: parseCompactJson(record.compactJson, `Record ${record.occurrenceKey}`),
    compactJson: record.compactJson,
    sequenceLexeme: record.sequenceLexeme,
    description: record.description ?? null,
    ...(!isNonTransactionRecord(record) && record.occurrenceGroup
      ? { occurrenceGroup: record.occurrenceGroup }
      : {}),
  };
}

export function financialSourceEvidenceFromCapture(
  capture: CanonicalFinancialDepositCapture,
): PGliteCanonicalSourceEvidence {
  const sourceAccountKeyValue = sourceAccountKey(capture);
  const pages = capture.pages.map((page) => ({
    pageOrdinal: page.pageOrdinal,
    responseCode: page.responseCode as "200" | "204",
    terminal: page.terminal,
    rowCount: page.rowCount,
    responseDigest: page.responseDigest,
    proofKind: page.proofKind,
    contractFingerprint: page.contractFingerprint,
    preflightFingerprint: page.preflightFingerprint,
    metadata: pageMetadata(page),
    metadataJson: page.metadataJson,
  }));
  const records = [
    ...capture.records,
    // Preserve every non-transaction assertion as source evidence.  Holding
    // observations and statement evidence are both part of the canonical
    // capture; only monetary records are projected into financial facts below.
    ...(capture.nonTransactionRecords ?? []),
  ].map(asSourceRecord);
  return {
    captureId: capture.captureId,
    integrationNamespace: capture.identity.integrationNamespace,
    sourceConnectionKey: capture.identity.sourceConnectionKey,
    identityEpoch: capture.identity.identityEpochKey,
    stream: capture.identity.stream,
    recordKind: capture.identity.recordKind,
    routeKey: capture.authorityRoute,
    contractVersion: capture.contractVersion,
    occurrenceGroupCoverage: capture.occurrenceGroupCoverage,
    subjectDigest: capture.identity.subjectDigest,
    observedAt: capture.observedAt,
    accountNumber: providerAccountNumber(capture),
    scope: {
      startDate: capture.scope.startDate,
      endDate: capture.scope.endDate,
      dateFormat: "YYYY-MM-DD",
      kind: capture.scope.scopeKind,
      completeness: capture.scope.completeness,
      ruleVersion: capture.scope.completenessRuleVersion,
      completenessBasis: capture.scope.completenessBasis,
      contractFingerprint: capture.scope.contractFingerprint,
      preflightFingerprint: capture.scope.preflightFingerprint,
      pageTerminalPolicy: capture.pages.every((page) => page.terminal) ? "each" : "last",
      absenceAuthority: capture.scope.absenceAuthority === null
        ? undefined
        : capture.scope.absenceAuthority as "comparable-complete-range" | "provider-explicit-no-data",
      sourceAccountKey: sourceAccountKeyValue,
      accountNo: capture.identity.accountNo,
    },
    pages,
    records,
  };
}

function toFinancialAccount(
  capture: CanonicalFinancialDepositCapture,
): PGliteCanonicalFinancialAccountInput {
  if (capture.identity.stream !== "domestic-deposit" && capture.identity.stream !== "foreign-currency-deposit")
    throw new Error("PGlite deposit commands support domestic and foreign-currency deposit streams only.");
  if (capture.identity.accountType !== "depository")
    throw new Error("PGlite deposit commands require a depository account.");
  const accountNumber = providerAccountNumber(capture);
  const sourceAccountKeyValue = sourceAccountKey(capture);
  return {
    sourceAccountKey: sourceAccountKeyValue,
    accountNo: accountNumber?.value ?? null,
    accountType: "depository",
    currency: capture.identity.currency,
  };
}

export function financialFactsFromCapture(
  capture: CanonicalFinancialDepositCapture,
): PGliteCanonicalFinancialCommitRequest["transactions"] {
  return capture.records.map((record) => {
    const timePrecision = record.sourceTime.precision ?? capture.semantics.timePrecision;
    const timeOrigin = record.sourceTime.timeOrigin ?? capture.semantics.timeOrigin;
    const utcInstantUtcUs = record.sourceTime.epochMilliseconds * 1_000;
    if (!Number.isSafeInteger(utcInstantUtcUs))
      throw new Error(`Deposit record ${record.occurrenceKey} has an unsafe UTC instant.`);
    return {
      sourceOccurrenceKey: record.occurrenceKey,
      // Capture-local ordering is source lineage, not durable transaction identity.
      sourceSequence: record.occurrenceKey,
      amount: record.amount,
      // Keep the provider's running balance attached to the typed fact as
      // well as the immutable source-record payload.  The generic baseline
      // has no transaction-row balance column, so source_records remain the
      // durable projection for this per-row field.
      balanceAfter: record.balanceAfter,
      currency: record.currency,
      direction: record.direction as "inflow" | "outflow",
      postingStatus: capture.semantics.postingStatus as "pending" | "posted",
      postingOrigin: capture.semantics.postingOrigin,
      postingBasis: capture.semantics.postingBasis,
      postingRuleVersion: capture.semantics.postingRuleVersion,
      description: record.description ?? null,
      economicStatus: capture.semantics.economicStatus as "normal" | "canceled" | "refund" | "reversal",
      administrativeState: capture.semantics.administrativeState as "active" | "deleted" | "purged",
      semanticRuleVersion: capture.semantics.semanticRuleVersion,
      effectiveOn: record.effectiveOn,
      transactionDateTimeLocal: record.transactionDateTimeLocal,
      timeZone: "Asia/Taipei" as const,
      timePrecision: timePrecision as "date" | "minute" | "second",
      timeOrigin: timeOrigin as "source_reported" | "defaulted_local_midnight",
      effectiveTimeBasis: capture.semantics.effectiveTimeBasis as "accounting" | "transaction-time" | "source-reported",
      effectiveTimeRuleVersion: capture.semantics.effectiveTimeRuleVersion,
      utcInstantUtcUs,
      conversionEvidence: record.conversionEvidence
        ? {
            originalAmount: record.conversionEvidence.originalAmount,
            originalCurrency: record.conversionEvidence.originalCurrency,
            bookedAmount: record.conversionEvidence.bookedAmount,
            bookedCurrency: record.conversionEvidence.bookedCurrency,
            sourceReportedRate: record.conversionEvidence.sourceReportedRate,
            impliedRate: record.conversionEvidence.impliedRate,
            comparison: record.conversionEvidence.comparison,
            feeAmount: record.conversionEvidence.feeAmount ?? null,
            feeCurrency: record.conversionEvidence.feeCurrency ?? null,
            evidenceOrigin: record.conversionEvidence.evidenceOrigin,
          }
        : null,
    };
  });
}

function normalizeRequest(
  request: PGliteCanonicalDepositCommitRequest | CanonicalFinancialDepositCapture,
): PGliteCanonicalDepositCommitRequest {
  if ("capture" in request) return request;
  return { capture: request };
}

function toFinancialRequest(
  request: PGliteCanonicalDepositCommitRequest,
): PGliteCanonicalFinancialCommitRequest {
  const capture = request.capture;
  validateDepositCapture(capture);
  const source = financialSourceEvidenceFromCapture(capture);
  return {
    capture: source,
    account: toFinancialAccount(capture),
    accountIdentifier: providerAccountNumber(capture),
    transactions: financialFactsFromCapture(capture),
    balanceObservations: request.balanceObservations ?? [],
    withdrawalPolicy: capture.scope.withdrawalPolicy ?? "allow-inference",
    sourceSyncCursor: request.sourceSyncCursor,
    recordedAtUtcUs: request.recordedAtUtcUs,
  };
}

async function readDepositCommit(
  store: Pick<PGliteStore, "query">,
  request: PGliteCanonicalDepositCommitRequest,
  result: PGliteCanonicalFinancialCommitResult,
): Promise<PGliteCanonicalDepositCommitResult> {
  const rows = await store.query<{
    account_id: unknown;
    capture_id: unknown;
    balance_revision_count: number | string;
  }>(
    `SELECT scope.account_id, source_capture.capture_id,
            COUNT(balance_revision.revision_id)::int AS balance_revision_count
       FROM source_captures source_capture
       JOIN capture_scopes scope ON scope.capture_id = source_capture.capture_id
       LEFT JOIN balance_observation_revisions balance_revision
         ON balance_revision.capture_id = source_capture.capture_id
      WHERE source_capture.capture_key = $1
      GROUP BY scope.account_id, source_capture.capture_id`,
    [request.capture.captureId],
  );
  const row = rows.rows[0];
  if (!row?.account_id) throw new Error("PGlite deposit commit did not retain its account scope.");
  const toUuid = (value: unknown): string => {
    const bytes = value instanceof Uint8Array || Buffer.isBuffer(value)
      ? Buffer.from(value).toString("hex")
      : String(value).replace(/^\\x/u, "");
    return `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-${bytes.slice(12, 16)}-${bytes.slice(16, 20)}-${bytes.slice(20, 32)}`;
  };
  const balanceRevisionCount = Number(row.balance_revision_count);
  return {
    status: "canonical-live",
    captureId: result.captureId,
    accountId: toUuid(row.account_id),
    commitSequence: result.commitSequence,
    transactions: result.transactions,
    balanceRevisionCount,
    deduplicatedBalanceRevisionCount:
      (request.balanceObservations?.length ?? 0) - balanceRevisionCount,
  };
}

/** Commit a domestic or foreign-currency deposit capture on the worker store. */
export async function commitPGliteCanonicalDepositCapture(
  store: PGliteStore,
  request: PGliteCanonicalDepositCommitRequest | CanonicalFinancialDepositCapture,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalDepositCommitResult> {
  const normalized = normalizeRequest(request);
  const result = await commitPGliteCanonicalFinancialCapture(
    store,
    toFinancialRequest(normalized),
    options,
  );
  return readDepositCommit(store, normalized, result);
}

/** Compose deposit evidence with another domain inside one owner transaction. */
export async function commitPGliteCanonicalDepositCaptureInTransaction(
  transaction: PGliteTransaction,
  request: PGliteCanonicalDepositCommitRequest | CanonicalFinancialDepositCapture,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalDepositCommitResult> {
  const normalized = normalizeRequest(request);
  const result = await commitPGliteCanonicalFinancialCaptureInTransaction(
    transaction,
    toFinancialRequest(normalized),
    options,
  );
  return readDepositCommit(transaction, normalized, result);
}

/** Execute a serializable named deposit command on the worker-owned store. */
export function executePGliteCanonicalDepositCommit(
  store: PGliteStore,
  command:
    | PGliteCanonicalDepositCommitCommand
    | PGliteCanonicalDepositCommitRequest
    | CanonicalFinancialDepositCapture,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalDepositCommitResult> {
  const request = "kind" in command ? command.request : command;
  return commitPGliteCanonicalDepositCapture(store, request, options);
}
