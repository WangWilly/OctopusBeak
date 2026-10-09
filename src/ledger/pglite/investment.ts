import { createHash, randomUUID } from "node:crypto";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";
import {
  assertPGliteCanonicalCommitNotCancelled,
  commitPGliteCanonicalFinancialCaptureInTransaction,
  type PGliteCanonicalCommitOptions,
  type PGliteCanonicalFinancialCommitResult,
  type PGliteCanonicalSourceCaptureTransactionResult,
} from "./canonical-source-store.ts";
import { refreshPGliteCurrentProjectionInTransaction } from "./projection.ts";
import type {
  PGliteCanonicalFinancialAccountInput,
  PGliteCanonicalBalanceObservationInput,
  PGliteCanonicalFinancialFactInput,
} from "./source-admission-validation.ts";
import type { InvestmentCaptureInput } from "../canonical/investment-financial.ts";
import { assertInvestmentCashBoundary, assertInvestmentHoldingSourceLots, investmentTransactionDirection, isInvestmentSecurityIdentityValid, PASSBOOK_MOVEMENT_ACTIONS } from "../canonical/investment-financial-admission.ts";
import { TDCC_INVESTMENT_CONTRACT, TDCC_INVESTMENT_ROUTE } from "../canonical/tdcc-investment-contract.ts";
import type { CanonicalSourceEvidence, CanonicalSourceRecord } from "../canonical/canonical-source-evidence.ts";
import { PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND } from "./workflow-commands.ts";

/** Named worker command for a source-admitted investment snapshot. */
export { PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND };

export type PGliteCanonicalInvestmentCommitRequest = Readonly<{
  capture: InvestmentCaptureInput;
  recordedAtUtcUs?: number;
}>;

export type PGliteCanonicalInvestmentCommitCommand = Readonly<{
  kind: typeof PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND;
  request: PGliteCanonicalInvestmentCommitRequest;
}>;

export type PGliteCanonicalInvestmentCommitResult = Readonly<{
  status: "canonical-live";
  captureId: string;
  accountId: string;
  commitSequence: number;
  transactions: PGliteCanonicalFinancialCommitResult["transactions"];
  holdingCount: number;
  investmentTransactionCount: number;
  marginObservationCount: number;
}>;

const TOKEN = /^sha256:[A-Za-z0-9_-]+$/u;
const SOURCES: Readonly<Record<InvestmentCaptureInput["sourceId"], { route: string; contract: string }>> = {
  "yuanta-fund": { route: "yuanta-fund/investment/canonical-v1", contract: "yuanta-fund/investment/canonical-v1" },
  "yuanta-trade": { route: "yuanta-trade/investment/canonical-v1", contract: "yuanta-trade/investment/canonical-v1" },
  maicoin: { route: "maicoin/investment/canonical-v1", contract: "maicoin/investment/canonical-v1" },
  tdcc: { route: TDCC_INVESTMENT_ROUTE, contract: TDCC_INVESTMENT_CONTRACT },
};

function fail(message: string): never {
  throw new Error(message);
}

function requireToken(value: string, label: string): string {
  if (!TOKEN.test(value)) fail(`${label} must be an opaque token.`);
  return value;
}

function date(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) fail(`${label} must be YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    fail(`${label} must be a calendar date.`);
  return value;
}

function rfc3339(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) fail(`${label} must be RFC3339.`);
}

function amount(value: Readonly<{ coefficient: string; scale: number }>, label: string): void {
  if (!/^(?:0|[1-9]\d*)$/u.test(value.coefficient) || !Number.isSafeInteger(value.scale) || value.scale < 0)
    fail(`${label} must be an exact non-negative amount.`);
}

function stableJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => Array.isArray(entry)
    ? entry.map(normalize)
    : entry !== null && typeof entry === "object"
      ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)]))
      : entry;
  return JSON.stringify(normalize(value));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("base64url")}`;
}

function uuidBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));
}

function bytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const result = Uint8Array.from(value);
    if (result.length === 16) return result;
  }
  if (typeof value === "string") {
    const hex = value.replace(/^\\x/u, "");
    if (/^[0-9a-f]{32}$/iu.test(hex)) return Uint8Array.from(Buffer.from(hex, "hex"));
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) return Uint8Array.from(Buffer.from(value.replaceAll("-", ""), "hex"));
  }
  fail(`${label} is not a UUID.`);
}

function idText(value: Uint8Array): string {
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function query<T>(transaction: PGliteTransaction, sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
  let index = 0;
  return (await transaction.query<T>(sql.replace(/\?/gu, () => `$${++index}`), params)).rows;
}

async function first<T>(transaction: PGliteTransaction, sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
  return (await query<T>(transaction, sql, params))[0];
}

function recordEnvelope(capture: InvestmentCaptureInput, record: { sourceRecordKey: string; description?: string | null; occurrenceGroup?: InvestmentCaptureInput["transactions"][number]["occurrenceGroup"] }, compact: Record<string, unknown>, index: number): CanonicalSourceRecord {
  return {
    occurrenceKey: record.sourceRecordKey,
    ...(record.occurrenceGroup ? { occurrenceGroup: record.occurrenceGroup } : {}),
    collisionKey: digest(`${capture.sourceId}:${capture.identity.accountKey}:${record.sourceRecordKey}`),
    providerKey: record.sourceRecordKey,
    contentHash: digest(compact),
    compact,
    compactJson: stableJson(compact),
    sequenceLexeme: String(index + 1),
    description: record.description ?? null,
  };
}

function sourceRecords(capture: InvestmentCaptureInput): CanonicalSourceRecord[] {
  const records: CanonicalSourceRecord[] = [];
  for (const [index, holding] of capture.holdings.entries()) {
    const { measurementKey: _measurementKey, observedAt: _observedAt, lineage: _lineage, ...sourceFact } = holding;
    records.push(recordEnvelope(capture, holding, { ...sourceFact,
      ...(holding.lineage.sourceLots ? { sourceLots: holding.lineage.sourceLots } : {}),
      kind: "holding-measurement" }, index));
  }
  for (const [index, transaction] of capture.transactions.entries()) {
    const { transactionKey: _transactionKey, ...sourceFact } = transaction;
    records.push(recordEnvelope(capture, transaction, { kind: "investment-transaction", ...sourceFact }, capture.holdings.length + index));
  }
  for (const movement of capture.passbookMovements ?? [])
    records.push(recordEnvelope(capture, movement, { kind: "passbook-movement", ...movement }, records.length));
  if (capture.margin?.kind === "embedded")
    records.push(recordEnvelope(capture, capture.margin, { ...capture.margin, kind: "margin-balance" }, records.length));
  return records;
}

function captureSource(capture: InvestmentCaptureInput): CanonicalSourceEvidence {
  const source = SOURCES[capture.sourceId];
  const records = sourceRecords(capture);
  const contractFingerprint = digest(`investment-contract:${capture.contractVersion}`);
  const preflightFingerprint = digest(`investment-capture:${capture.captureId}`);
  const sourceScope = capture.scope.transactionHistory ?? {
    startDate: capture.scope.effectiveOn,
    endDate: capture.scope.effectiveOn,
  };
  return {
    captureId: capture.captureId,
    integrationNamespace: capture.sourceId,
    sourceConnectionKey: capture.identity.sourceConnectionKey,
    identityEpoch: capture.identity.identityEpochKey,
    stream: "investment",
    recordKind: "investment-source-record",
    routeKey: capture.authorityRoute,
    contractVersion: capture.contractVersion,
    subjectDigest: digest(`${capture.sourceId}:${capture.identity.sourceConnectionKey}:${capture.identity.identityEpochKey}:${capture.identity.accountKey}`),
    ...(capture.occurrenceGroupCoverage
      ? { occurrenceGroupCoverage: capture.occurrenceGroupCoverage }
      : {}),
    observedAt: capture.observedAt,
    accountNumber: capture.identity.accountNumber ?? null,
    scope: {
      startDate: sourceScope.startDate,
      endDate: sourceScope.endDate,
      dateFormat: "YYYY-MM-DD",
      kind: capture.scope.transactionHistory ? "bounded-range" : "point-in-time",
      completeness: "complete-range",
      ruleVersion: capture.contractVersion,
      completenessBasis: "source-reported-complete-investment-snapshot",
      contractFingerprint,
      preflightFingerprint,
      pageTerminalPolicy: "last",
      sourceAccountKey: capture.identity.accountKey,
      accountNo: capture.identity.accountKey,
    },
    pages: [{
      pageOrdinal: 0,
      responseCode: "200",
      terminal: true,
      rowCount: records.length,
      metadata: { observedAt: capture.observedAt, rowCount: records.length },
      responseDigest: digest(`investment-page:${capture.captureId}`),
      proofKind: "source-declared-terminal-grid",
      contractFingerprint,
      preflightFingerprint,
      metadataJson: stableJson({ observedAt: capture.observedAt, rowCount: records.length }),
    }],
    records,
  };
}

function financialFact(capture: InvestmentCaptureInput, transaction: InvestmentCaptureInput["transactions"][number]): PGliteCanonicalFinancialFactInput {
  const local = `${transaction.effectiveOn}T00:00:00`;
  const epoch = Date.parse(`${local}+08:00`);
  if (!Number.isFinite(epoch)) fail("Investment transaction effective time is invalid.");
  // ADR 0006: booked transaction money retains its source denomination even
  // when the investment account reports its overall value in another currency.
  const money = transaction.cashEffect;
  return {
    sourceOccurrenceKey: transaction.sourceRecordKey,
    sourceSequence: transaction.sourceRecordKey,
    amount: money,
    currency: money.currency,
    direction: investmentTransactionDirection(transaction.action),
    postingStatus: "posted",
    postingOrigin: "provider_booked_history",
    postingBasis: "statement-posted-history",
    postingRuleVersion: capture.contractVersion,
    description: transaction.description ?? null,
    economicStatus: "normal",
    administrativeState: "active",
    semanticRuleVersion: capture.contractVersion,
    effectiveOn: transaction.effectiveOn,
    transactionDateTimeLocal: local,
    timeZone: "Asia/Taipei",
    timePrecision: "date",
    timeOrigin: "defaulted_local_midnight",
    effectiveTimeBasis: "source-reported",
    effectiveTimeRuleVersion: capture.contractVersion,
    utcInstantUtcUs: epoch * 1_000,
  };
}

function marginFact(capture: InvestmentCaptureInput): PGliteCanonicalFinancialFactInput | null {
  if (capture.margin?.kind !== "embedded") return null;
  const local = `${capture.margin.effectiveOn}T00:00:00`;
  const epoch = Date.parse(`${local}+08:00`);
  const money = capture.margin.amount;
  return {
    sourceOccurrenceKey: capture.margin.sourceRecordKey,
    sourceSequence: capture.margin.sourceRecordKey,
    amount: money,
    currency: money.currency,
    direction: "outflow",
    postingStatus: "posted",
    postingOrigin: "provider_booked_history",
    postingBasis: "statement-posted-history",
    postingRuleVersion: capture.contractVersion,
    description: null,
    economicStatus: "normal",
    administrativeState: "active",
    semanticRuleVersion: capture.contractVersion,
    effectiveOn: capture.margin.effectiveOn,
    transactionDateTimeLocal: local,
    timeZone: "Asia/Taipei",
    timePrecision: "date",
    timeOrigin: "defaulted_local_midnight",
    effectiveTimeBasis: "source-reported",
    effectiveTimeRuleVersion: capture.contractVersion,
    utcInstantUtcUs: epoch * 1_000,
  };
}

function independentMarginBalanceSource(capture: InvestmentCaptureInput): {
  source: CanonicalSourceEvidence;
  account: PGliteCanonicalFinancialAccountInput;
  observation: PGliteCanonicalBalanceObservationInput;
} | null {
  const margin = capture.margin;
  if (margin?.kind !== "independent-account") return null;
  const contractVersion = `${capture.sourceId}/investment/margin-credit-canonical-v1`;
  const sourceRecord: CanonicalSourceRecord = {
    occurrenceKey: margin.sourceRecordKey,
    collisionKey: digest(`${capture.sourceId}:${margin.accountKey}:${margin.sourceRecordKey}`),
    providerKey: margin.sourceRecordKey,
    contentHash: digest({ ...margin, recordKind: "independent-margin-credit" }),
    compact: { ...margin, recordKind: "independent-margin-credit" },
    compactJson: stableJson({ ...margin, recordKind: "independent-margin-credit" }),
    sequenceLexeme: "1",
    description: null,
  };
  const contractFingerprint = digest(`investment-margin-credit:${contractVersion}`);
  return {
    source: {
      captureId: `${capture.captureId}:margin-credit`,
      integrationNamespace: capture.sourceId,
      sourceConnectionKey: capture.identity.sourceConnectionKey,
      identityEpoch: capture.identity.identityEpochKey,
      stream: "investment-margin",
      recordKind: "investment-margin-credit",
      routeKey: contractVersion,
      contractVersion,
      subjectDigest: digest(`${capture.sourceId}:${capture.identity.sourceConnectionKey}:${capture.identity.identityEpochKey}:${margin.accountKey}`),
      observedAt: capture.observedAt,
      accountNumber: null,
      scope: {
        startDate: margin.effectiveOn,
        endDate: margin.effectiveOn,
        dateFormat: "YYYY-MM-DD",
        kind: "bounded-range",
        completeness: "complete-range",
        ruleVersion: contractVersion,
        completenessBasis: "source-reported-independent-margin-balance",
        contractFingerprint,
        preflightFingerprint: digest(`investment-margin-credit:${capture.captureId}`),
        pageTerminalPolicy: "last",
        sourceAccountKey: margin.accountKey,
        accountNo: null,
      },
      pages: [{
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: 1,
        metadata: { effectiveOn: margin.effectiveOn },
        responseDigest: digest(`investment-margin-credit-page:${capture.captureId}`),
        proofKind: "source-reported-independent-margin-account",
        contractFingerprint,
        preflightFingerprint: digest(`investment-margin-credit:${capture.captureId}`),
        metadataJson: stableJson({ effectiveOn: margin.effectiveOn }),
      }],
      records: [sourceRecord],
    },
    account: {
      sourceAccountKey: margin.accountKey,
      accountNo: null,
      accountType: margin.accountType,
      currency: margin.amount.currency,
    },
    observation: {
      observationKey: digest(`${capture.sourceId}:${margin.accountKey}:margin-balance:${margin.accountType}`),
      balanceKind: margin.accountType === "loan" ? "loan_outstanding" : "credit_used",
      balance: margin.amount,
      currency: margin.amount.currency,
      effectiveAt: `${margin.effectiveOn}T00:00:00+08:00`,
      effectiveTimeBasis: "source-reported",
      effectiveTimeRuleVersion: contractVersion,
      evidenceSourceRecordKey: margin.sourceRecordKey,
      evidenceSourceField: "margin-balance",
      evidenceSourceValue: stableJson(margin.amount),
      evidenceContractVersion: contractVersion,
      sourceOccurrenceKey: margin.sourceRecordKey,
    },
  };
}

function validateCapture(capture: InvestmentCaptureInput): void {
  if (!capture || typeof capture !== "object") fail("An investment capture is required.");
  const expected = SOURCES[capture.sourceId];
  if (!expected || capture.authorityRoute !== expected.route || capture.contractVersion !== expected.contract)
    fail("Investment route or contract version is unsupported.");
  rfc3339(capture.observedAt, "Investment observedAt");
  for (const [value, label] of [[capture.identity.sourceConnectionKey, "source connection"], [capture.identity.identityEpochKey, "identity epoch"], [capture.identity.accountKey, "account key"]] as const)
    requireToken(value, `Investment ${label}`);
  if (!/^[A-Z]{3}$/u.test(capture.identity.reportingCurrency)) fail("Investment reporting currency is invalid.");
  date(capture.scope.effectiveOn, "Investment effective date");
  const transactionHistory = capture.scope.transactionHistory;
  if (transactionHistory) {
    const startDate = date(transactionHistory.startDate, "Investment history start date");
    const endDate = date(transactionHistory.endDate, "Investment history end date");
    if (!transactionHistory.complete || startDate > endDate)
      fail("Investment transaction history range is incomplete or inverted.");
  }
  if (capture.occurrenceGroupCoverage !== undefined && !transactionHistory)
    fail("Investment occurrence groups require a complete transaction-history range.");
  for (const coverage of capture.occurrenceGroupCoverage ?? []) {
    const startDate = date(coverage.startDate, "Investment occurrence coverage start date");
    const endDate = date(coverage.endDate, "Investment occurrence coverage end date");
    if (
      coverage.contractVersion !== capture.contractVersion ||
      startDate > endDate ||
      startDate < transactionHistory!.startDate ||
      endDate > transactionHistory!.endDate
    )
      fail("Investment occurrence coverage does not fit its complete history scope.");
  }
  const securities = new Set<string>();
  for (const security of capture.securities) {
    if (!isInvestmentSecurityIdentityValid(capture, security) || securities.has(security.securityKey))
      fail("Investment Security identity is outside its source contract.");
    securities.add(security.securityKey);
    if (security.nameEvidence && (security.nameEvidence.contractVersion !== `${capture.sourceId}/security-name/source-reported-v1` || ![...capture.holdings, ...capture.transactions].some((row) => row.securityKey === security.securityKey && row.sourceRecordKey === security.nameEvidence!.sourceRecordKey)))
      fail("Investment Security name evidence is not source-bound.");
  }
  const sourceRecords = new Set<string>();
  for (const holding of capture.holdings) {
    requireToken(holding.measurementKey, "Investment measurement key");
    requireToken(holding.measurementSubjectKey, "Investment measurement subject key");
    requireToken(holding.sourceRecordKey, "Investment holding source record key");
    if (sourceRecords.has(holding.sourceRecordKey)) fail("Investment source record keys must be unique.");
    sourceRecords.add(holding.sourceRecordKey);
    if (!securities.has(holding.securityKey) || (!holding.quantity && !holding.valuation) || holding.effectiveOn !== capture.scope.effectiveOn || Date.parse(holding.observedAt) !== Date.parse(capture.observedAt) || holding.effectiveTimeEvidence.kind !== "source-reported-as-of" || holding.effectiveTimeEvidence.sourceRecordKey !== holding.sourceRecordKey || holding.effectiveTimeEvidence.value !== holding.effectiveOn || holding.effectiveTimeEvidence.contractVersion !== capture.contractVersion)
      fail("Investment holding evidence is incomplete.");
    if (holding.quantity) amount(holding.quantity, "Investment holding quantity");
    if (holding.valuation) amount(holding.valuation, "Investment holding valuation");
    if (holding.cost) amount(holding.cost, "Investment holding cost");
    if (holding.correction) {
      requireToken(holding.correction.ofMeasurementKey, "Investment correction target");
      requireToken(holding.correction.stableCorrectionKey, "Investment correction proof");
      requireToken(holding.correction.sourceRecordKey, "Investment correction source");
      requireToken(holding.correction.targetSourceRecordKey, "Investment correction target source");
      date(holding.correction.priorEffectiveOn, "Investment correction prior date");
      const expectedProof = digest([
        "investment-holding-correction",
        capture.contractVersion,
        holding.sourceRecordKey,
        holding.correction.targetSourceRecordKey,
        holding.measurementSubjectKey,
        holding.effectiveOn,
      ].join("\u0000"));
      if (holding.correction.proofKind !== "source-stable-correction-key" || holding.correction.contractVersion !== capture.contractVersion || holding.correction.sourceRecordKey !== holding.sourceRecordKey || holding.correction.priorEffectiveOn !== holding.effectiveOn || holding.correction.stableCorrectionKey !== expectedProof)
        fail("Investment holding correction proof is invalid.");
    }
  }
  for (const transaction of capture.transactions) {
    requireToken(transaction.sourceRecordKey, "Investment transaction source record key");
    if (sourceRecords.has(transaction.sourceRecordKey)) fail("Investment source record keys must be unique.");
    sourceRecords.add(transaction.sourceRecordKey);
    requireToken(transaction.transactionKey, "Investment transaction key");
    if (!securities.has(transaction.securityKey) || !["buy", "sell", "corporate_action_in", "corporate_action_out", "dividend"].includes(transaction.action)) fail("Investment transaction identity is unsupported.");
    amount(transaction.quantity, "Investment transaction quantity");
    amount(transaction.cashEffect, "Investment transaction cash effect");
    date(transaction.effectiveOn, "Investment transaction effective date");
    if (transaction.occurrenceGroup) {
      requireToken(transaction.occurrenceGroup.scopeKey, "Investment occurrence scope key");
      requireToken(transaction.occurrenceGroup.fingerprint, "Investment occurrence fingerprint");
      const partitionDate = date(transaction.occurrenceGroup.partitionDate, "Investment occurrence date");
      if (!Number.isSafeInteger(transaction.occurrenceGroup.ordinal) || transaction.occurrenceGroup.ordinal < 1)
        fail("Investment occurrence ordinal must be a positive safe integer.");
      if (!(capture.occurrenceGroupCoverage ?? []).some((coverage) =>
        coverage.scopeKey === transaction.occurrenceGroup!.scopeKey &&
        coverage.contractVersion === capture.contractVersion &&
        partitionDate >= coverage.startDate && partitionDate <= coverage.endDate,
      )) fail("Investment occurrence group is missing complete coverage.");
    }
    if (transaction.fundingEvidence.sourceRecordKey !== transaction.sourceRecordKey) fail("Investment funding evidence must cite its transaction source record.");
    if (transaction.fundingEvidence.kind === "source-linked-account") {
      requireToken(transaction.fundingEvidence.fundingAccountKey, "Investment funding account key");
      requireToken(transaction.fundingEvidence.sourceLinkageKey, "Investment funding linkage key");
      requireToken(transaction.fundingEvidence.settlementGroupKey, "Investment funding settlement group key");
      date(transaction.fundingEvidence.settlementEffectiveOn, "Investment funding settlement date");
      if (!/^\d{6,20}$/u.test(transaction.fundingEvidence.fundingAccountNumber.replaceAll(/[-\s]/gu, "")) || transaction.fundingEvidence.contractVersion !== capture.contractVersion || !["single-transaction", "account-currency-date-net"].includes(transaction.fundingEvidence.settlementModel)) fail("Investment funding account evidence is outside its contract.");
    } else if (transaction.fundingEvidence.kind === "source-settlement-contract") {
      if (capture.sourceId !== "yuanta-trade" || transaction.fundingEvidence.linkageContractVersion !== "yuanta/foreign-settlement/linkage-v1" || transaction.fundingEvidence.settlementMarket !== "us-equity" || transaction.fundingEvidence.settlementMarketContractVersion !== "yuanta/foreign-settlement/market-v2" || transaction.fundingEvidence.settlementModel !== "account-currency-date-net" || transaction.fundingEvidence.contractVersion !== "yuanta/foreign-settlement/human-attested-v1" || !["52", "53", "54"].includes(transaction.fundingEvidence.sourceMarketCode)) fail("Investment source settlement contract is unsupported.");
      requireToken(transaction.fundingEvidence.sourceLinkageKey, "Investment settlement linkage key");
    } else if (transaction.fundingEvidence.kind !== "unresolved") fail("Investment funding evidence kind is unsupported.");
  }
  assertInvestmentCashBoundary(capture);
  const movementKeys = new Set<string>();
  for (const movement of capture.passbookMovements ?? []) {
    requireToken(movement.sourceRecordKey, "Passbook movement source record key");
    requireToken(movement.movementKey, "Passbook movement key");
    if (sourceRecords.has(movement.sourceRecordKey) || movementKeys.has(movement.movementKey)) fail("Passbook movement keys must be unique.");
    sourceRecords.add(movement.sourceRecordKey);
    movementKeys.add(movement.movementKey);
    if (!securities.has(movement.securityKey) || !PASSBOOK_MOVEMENT_ACTIONS.includes(movement.action)) fail("Passbook movement identity is unsupported.");
    amount(movement.quantity, "Passbook movement quantity");
    if (!transactionHistory) fail("Passbook movements require a complete transaction-history range.");
    for (const value of [date(movement.tradeOn, "Passbook movement trade date"), date(movement.postedOn, "Passbook movement posted date")])
      if (value < transactionHistory.startDate || value > transactionHistory.endDate) fail("Passbook movement falls outside its history range.");
  }
  if (capture.margin?.kind === "embedded") {
    requireToken(capture.margin.sourceRecordKey, "Investment margin source record key");
    date(capture.margin.effectiveOn, "Investment margin effective date");
    amount(capture.margin.amount, "Investment margin amount");
  }
  if (capture.margin?.kind === "independent-account") {
    requireToken(capture.margin.accountKey, "Investment margin account key");
    requireToken(capture.margin.sourceRecordKey, "Investment margin source record key");
    date(capture.margin.effectiveOn, "Investment margin effective date");
    amount(capture.margin.amount, "Investment independent margin amount");
    if (capture.margin.identityEvidence.kind !== "producer-margin-account-id" || !capture.margin.identityEvidence.producerAccountId.trim() || capture.margin.sourceEventCode !== "LOAN-DISBURSEMENT") fail("Investment independent margin identity is unsupported.");
  }
}

type InvestmentContext = {
  capture: PGliteCanonicalSourceCaptureTransactionResult;
  accountId: Uint8Array;
  commitId: Uint8Array;
};

async function contextFor(transaction: PGliteTransaction, source: PGliteCanonicalSourceCaptureTransactionResult): Promise<InvestmentContext> {
  const row = await first<{ account_id: unknown; commit_id: unknown }>(transaction, `SELECT scope.account_id, source_capture.commit_id
    FROM source_captures source_capture JOIN capture_scopes scope ON scope.capture_id = source_capture.capture_id
    WHERE source_capture.capture_id = ?`, [source.captureId]);
  if (!row?.account_id) fail("Investment source capture account scope is missing.");
  return { capture: source, accountId: bytes(row.account_id, "Investment account"), commitId: bytes(row.commit_id, "Investment commit") };
}

async function persistExtensions(transaction: PGliteTransaction, context: InvestmentContext, capture: InvestmentCaptureInput, result: PGliteCanonicalFinancialCommitResult): Promise<void> {
  await query(transaction, `INSERT INTO investment_captures(capture_id, commit_id, source_id, contract_version) VALUES (?, ?, ?, ?) ON CONFLICT(capture_id) DO NOTHING`, [context.capture.captureId, context.commitId, capture.sourceId, capture.contractVersion]);
  await query(transaction, `INSERT INTO investment_accounts(account_id, source_connection_id, identity_epoch_id, source_id, account_key, account_type, account_subtype) VALUES (?, ?, ?, ?, ?, 'investment', ?) ON CONFLICT(account_id) DO NOTHING`, [context.accountId, (await first<{ source_connection_id: unknown }>(transaction, "SELECT source_connection_id FROM financial_accounts WHERE account_id = ?", [context.accountId]))?.source_connection_id, (await first<{ identity_epoch_id: unknown }>(transaction, "SELECT identity_epoch_id FROM financial_accounts WHERE account_id = ?", [context.accountId]))?.identity_epoch_id, capture.sourceId, capture.identity.accountKey, capture.identity.accountSubtype ?? null]);
  const records = context.capture.sourceRecordIdsByOccurrence;
  const securities = new Map<string, Uint8Array>();
  for (const security of capture.securities) {
    const prior = await first<{ security_id: unknown; producer_security_id: string; name: string | null; ticker: string | null; currency: string; security_type: string }>(transaction, "SELECT security_id, producer_security_id, name, ticker, currency, security_type FROM investment_securities WHERE source_id = ? AND security_key = ?", [capture.sourceId, security.securityKey]);
    if (prior && (prior.producer_security_id !== security.producerSecurityId || prior.name !== (security.name ?? null) || prior.ticker !== (security.ticker ?? null) || prior.currency !== security.currency || prior.security_type !== (security.securityType ?? "other"))) fail("Immutable investment Security evidence changed.");
    const securityId = prior?.security_id ? bytes(prior.security_id, "Investment Security") : uuidBytes();
    if (!prior) await query(transaction, `INSERT INTO investment_securities(security_id, source_id, security_key, producer_security_id, name, ticker, currency, security_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [securityId, capture.sourceId, security.securityKey, security.producerSecurityId, security.name ?? null, security.ticker ?? null, security.currency, security.securityType ?? "other"]);
    securities.set(security.securityKey, securityId);
    if (security.nameEvidence && security.name !== undefined) {
      const sourceRecordId = records.get(security.nameEvidence.sourceRecordKey);
      if (!sourceRecordId) fail("Investment Security name source record is missing.");
      await query(transaction, `INSERT INTO investment_security_name_observations(security_id, capture_id, commit_id, source_record_id, contract_version, name) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(security_id, capture_id) DO NOTHING`, [securityId, context.capture.captureId, context.commitId, sourceRecordId, security.nameEvidence.contractVersion, security.name]);
    }
  }
  const securityId = (key: string): Uint8Array => securities.get(key) ?? fail("Investment Security extension is missing.");
  for (const holding of capture.holdings) {
    const sourceRecordId = records.get(holding.sourceRecordKey);
    if (!sourceRecordId) fail("Investment holding source record is missing.");
    const security = securityId(holding.securityKey);
    const exact = await first<{ observation_id: unknown }>(transaction, `SELECT observation_id FROM investment_holding_observations WHERE account_id = ? AND measurement_key = ? AND security_id = ? AND effective_on = ? AND quantity_coefficient IS NOT DISTINCT FROM ? AND quantity_scale IS NOT DISTINCT FROM ? AND valuation_coefficient IS NOT DISTINCT FROM ? AND valuation_scale IS NOT DISTINCT FROM ? AND valuation_currency IS NOT DISTINCT FROM ? AND cost_coefficient IS NOT DISTINCT FROM ? AND cost_scale IS NOT DISTINCT FROM ? AND cost_currency IS NOT DISTINCT FROM ? LIMIT 1`, [context.accountId, holding.measurementKey, security, holding.effectiveOn, holding.quantity?.coefficient ?? null, holding.quantity?.scale ?? null, holding.valuation?.coefficient ?? null, holding.valuation?.scale ?? null, holding.valuation?.currency ?? null, holding.cost?.coefficient ?? null, holding.cost?.scale ?? null, holding.cost?.currency ?? null]);
    if (exact) continue;
    let prior: { observation_id: unknown; revision_number: number | string; source_record_id: unknown; security_id: unknown; effective_on: string; target_source_record_key?: string } | undefined;
    if (holding.correction) {
      prior = await first<typeof prior & { target_source_record_key?: string }>(transaction, "SELECT observation.observation_id, observation.revision_number, observation.source_record_id, observation.security_id, observation.effective_on, source_record.occurrence_key AS target_source_record_key FROM investment_holding_observations observation JOIN source_records source_record ON source_record.source_record_id = observation.source_record_id WHERE observation.account_id = ? AND observation.measurement_key = ? AND observation.is_current = 1", [context.accountId, holding.correction.ofMeasurementKey]);
      if (!prior || !Buffer.from(bytes(prior.security_id, "Investment Security")).equals(Buffer.from(security)) || prior.effective_on !== holding.correction.priorEffectiveOn || prior.target_source_record_key !== holding.correction.targetSourceRecordKey) fail("Investment holding correction target is invalid.");
      await query(transaction, "UPDATE investment_holding_observations SET is_current = 0 WHERE observation_id = ?", [prior.observation_id]);
    } else {
      const current = await first<typeof prior>(transaction, "SELECT observation_id, revision_number, source_record_id, security_id, effective_on FROM investment_holding_observations WHERE account_id = ? AND measurement_key = ? AND is_current = 1 ORDER BY revision_number DESC LIMIT 1", [context.accountId, holding.measurementKey]);
      if (current) {
        prior = current;
        await query(transaction, "UPDATE investment_holding_observations SET is_current = 0 WHERE observation_id = ?", [current.observation_id]);
      }
    }
    await query(transaction, `INSERT INTO investment_holding_observations(observation_id, capture_id, commit_id, account_id, security_id, source_record_id, measurement_key, correction_of_observation_id, revision_number, is_current, quantity_coefficient, quantity_scale, valuation_coefficient, valuation_scale, valuation_currency, cost_coefficient, cost_scale, cost_currency, effective_on, observed_at, lineage_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [uuidBytes(), context.capture.captureId, context.commitId, context.accountId, security, sourceRecordId, holding.correction?.ofMeasurementKey ?? holding.measurementKey, prior?.observation_id ?? null, Number(prior?.revision_number ?? 0) + 1, holding.quantity?.coefficient ?? null, holding.quantity?.scale ?? null, holding.valuation?.coefficient ?? null, holding.valuation?.scale ?? null, holding.valuation?.currency ?? null, holding.cost?.coefficient ?? null, holding.cost?.scale ?? null, holding.cost?.currency ?? null, holding.effectiveOn, holding.observedAt, stableJson({ ...holding.lineage, measurementSubjectKey: holding.measurementSubjectKey, correction: holding.correction ?? null, effectiveTimeEvidence: holding.effectiveTimeEvidence })]);
  }
  const resultByOccurrence = new Map(result.transactions.map((row) => [row.sourceOccurrenceKey, row]));
  for (const investmentTransaction of capture.transactions) {
    const committed = resultByOccurrence.get(investmentTransaction.sourceRecordKey);
    const sourceRecordId = records.get(investmentTransaction.sourceRecordKey);
    if (!committed || !sourceRecordId) fail("Investment transaction source result is missing.");
    const security = securityId(investmentTransaction.securityKey);
    const expected = {
      security,
      action: investmentTransaction.action,
      quantityCoefficient: investmentTransaction.quantity.coefficient,
      quantityScale: investmentTransaction.quantity.scale,
      cashCoefficient: investmentTransaction.cashEffect.coefficient,
      cashScale: investmentTransaction.cashEffect.scale,
      cashCurrency: investmentTransaction.cashEffect.currency,
      effectiveOn: investmentTransaction.effectiveOn,
      fundingEvidenceJson: stableJson(investmentTransaction.fundingEvidence),
    };
    const existing = await first<{ security_id: unknown; action: string; quantity_coefficient: string; quantity_scale: number | string; cash_coefficient: string; cash_scale: number | string; cash_currency: string; effective_on: string; funding_evidence_json: string }>(transaction, "SELECT security_id, action, quantity_coefficient, quantity_scale, cash_coefficient, cash_scale, cash_currency, effective_on, funding_evidence_json FROM investment_transactions WHERE transaction_id = ?", [bytes(committed.transactionId, "Investment transaction")]);
    if (existing) {
      if (!Buffer.from(bytes(existing.security_id, "Investment Security")).equals(Buffer.from(expected.security)) || existing.action !== expected.action || existing.quantity_coefficient !== expected.quantityCoefficient || Number(existing.quantity_scale) !== expected.quantityScale || existing.cash_coefficient !== expected.cashCoefficient || Number(existing.cash_scale) !== expected.cashScale || existing.cash_currency !== expected.cashCurrency || existing.effective_on !== expected.effectiveOn || existing.funding_evidence_json !== expected.fundingEvidenceJson) fail("Investment transaction extension conflicts with prior canonical evidence.");
      continue;
    }
    await query(transaction, `INSERT INTO investment_transactions(transaction_id, capture_id, commit_id, account_id, security_id, source_record_id, action, quantity_coefficient, quantity_scale, cash_coefficient, cash_scale, cash_currency, effective_on, funding_evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [bytes(committed.transactionId, "Investment transaction"), context.capture.captureId, context.commitId, context.accountId, expected.security, sourceRecordId, expected.action, expected.quantityCoefficient, expected.quantityScale, expected.cashCoefficient, expected.cashScale, expected.cashCurrency, expected.effectiveOn, expected.fundingEvidenceJson]);
  }
  for (const movement of capture.passbookMovements ?? []) {
    const sourceRecordId = records.get(movement.sourceRecordKey);
    if (!sourceRecordId) fail("Passbook movement source record is missing.");
    const security = securityId(movement.securityKey);
    const existing = await first<{ security_id: unknown; action: string; quantity_coefficient: string; quantity_scale: number | string; trade_on: string; posted_on: string }>(transaction, "SELECT security_id, action, quantity_coefficient, quantity_scale, trade_on, posted_on FROM investment_passbook_movements WHERE account_id = ? AND movement_key = ?", [context.accountId, movement.movementKey]);
    if (existing) {
      if (!Buffer.from(bytes(existing.security_id, "Investment Security")).equals(Buffer.from(security)) || existing.action !== movement.action || existing.quantity_coefficient !== movement.quantity.coefficient || Number(existing.quantity_scale) !== movement.quantity.scale || existing.trade_on !== movement.tradeOn || existing.posted_on !== movement.postedOn) fail("Passbook movement conflicts with prior canonical evidence.");
      continue;
    }
    await query(transaction, `INSERT INTO investment_passbook_movements(movement_id, capture_id, commit_id, account_id, security_id, source_record_id, movement_key, action, quantity_coefficient, quantity_scale, trade_on, posted_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [uuidBytes(), context.capture.captureId, context.commitId, context.accountId, security, sourceRecordId, movement.movementKey, movement.action, movement.quantity.coefficient, movement.quantity.scale, movement.tradeOn, movement.postedOn]);
  }
  if (capture.margin?.kind === "embedded") {
    const sourceRecordId = records.get(capture.margin.sourceRecordKey);
    if (!sourceRecordId) fail("Investment margin source record is missing.");
    const existing = await first<{ observation_id: unknown }>(transaction, "SELECT observation_id FROM investment_margin_balance_observations WHERE account_id = ? AND effective_on = ? AND coefficient = ? AND scale = ? AND currency = ?", [context.accountId, capture.margin.effectiveOn, capture.margin.amount.coefficient, capture.margin.amount.scale, capture.margin.amount.currency]);
    if (!existing) await query(transaction, `INSERT INTO investment_margin_balance_observations(observation_id, capture_id, commit_id, account_id, source_record_id, balance_kind, coefficient, scale, currency, effective_on) VALUES (?, ?, ?, ?, ?, 'margin_loan', ?, ?, ?, ?)`, [uuidBytes(), context.capture.captureId, context.commitId, context.accountId, sourceRecordId, capture.margin.amount.coefficient, capture.margin.amount.scale, capture.margin.amount.currency, capture.margin.effectiveOn]);
  }
}

function account(capture: InvestmentCaptureInput): PGliteCanonicalFinancialAccountInput {
  return {
    sourceAccountKey: capture.identity.accountKey,
    accountNo: capture.identity.accountNumber?.value ?? null,
    accountType: "investment",
    currency: capture.identity.reportingCurrency,
    ...(capture.identity.institutionKey ? { institutionKey: capture.identity.institutionKey } : {}),
  };
}

export async function commitPGliteCanonicalInvestmentCapture(
  store: PGliteStore,
  request: PGliteCanonicalInvestmentCommitRequest,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalInvestmentCommitResult> {
  const snapshot = structuredClone(request);
  validateCapture(snapshot.capture);
  for (const holding of snapshot.capture.holdings) assertInvestmentHoldingSourceLots(snapshot.capture.sourceId, holding);
  return store.transaction(async (transaction) => {
    const margin = marginFact(snapshot.capture);
    const result = await commitPGliteCanonicalFinancialCaptureInTransaction(transaction, {
      capture: captureSource(snapshot.capture),
      account: account(snapshot.capture),
      accountIdentifier: snapshot.capture.identity.accountNumber ?? null,
      transactions: [...snapshot.capture.transactions.map((row) => financialFact(snapshot.capture, row)), ...(margin ? [margin] : [])],
      withdrawalPolicy: "never-infer",
      recordedAtUtcUs: snapshot.recordedAtUtcUs ?? options.recordedAtUtcUs,
    }, { ...options, skipProjection: true });
    const source = await first<{ capture_id: unknown; scope_id: unknown; commit_id: unknown; source_connection_id: unknown; identity_epoch_id: unknown }>(transaction, "SELECT source_capture.capture_id, scope.scope_id, source_capture.commit_id, source_capture.source_connection_id, source_capture.identity_epoch_id FROM source_captures source_capture JOIN capture_scopes scope ON scope.capture_id = source_capture.capture_id WHERE source_capture.capture_key = ?", [snapshot.capture.captureId]);
    if (!source) fail("Investment source capture context is missing.");
    const sourceRecords = await query<{ occurrence_key: string; source_record_id: unknown }>(transaction, "SELECT occurrence_key, source_record_id FROM source_records WHERE capture_id = ?", [source.capture_id]);
    const captureResult: PGliteCanonicalSourceCaptureTransactionResult = {
      receipt: { captureId: snapshot.capture.captureId, knowledgePoint: result.commitSequence },
      captureId: bytes(source.capture_id, "Investment capture"),
      scopeId: bytes(source.scope_id, "Investment scope"),
      commitId: bytes(source.commit_id, "Investment commit"),
      sourceConnectionId: bytes(source.source_connection_id, "Investment source connection"),
      identityEpochId: bytes(source.identity_epoch_id, "Investment identity epoch"),
      sourceSubjectId: bytes((await first<{ source_subject_id: unknown }>(transaction, "SELECT source_subject_id FROM source_captures WHERE capture_id = ?", [source.capture_id]))?.source_subject_id, "Investment subject"),
      sourceRecordIds: sourceRecords.map((row) => bytes(row.source_record_id, "Investment source record")),
      sourceRecordIdsByOccurrence: new Map(sourceRecords.map((row) => [row.occurrence_key, bytes(row.source_record_id, "Investment source record")])),
    };
    const context = await contextFor(transaction, captureResult);
    await persistExtensions(transaction, context, snapshot.capture, result);
    const marginBalance = independentMarginBalanceSource(snapshot.capture);
    if (marginBalance)
      await commitPGliteCanonicalFinancialCaptureInTransaction(transaction, {
        capture: marginBalance.source,
        account: marginBalance.account,
        transactions: [],
        balanceObservations: [marginBalance.observation],
        withdrawalPolicy: "never-infer",
        recordedAtUtcUs: snapshot.recordedAtUtcUs ?? options.recordedAtUtcUs,
      }, { ...options, skipProjection: true });
    const captureKeys = [
      snapshot.capture.captureId,
      ...(marginBalance ? [marginBalance.source.captureId] : []),
    ];
    const committedCaptures = await query<{
      capture_id: unknown;
      commit_id: unknown;
      commit_sequence: number | string;
    }>(transaction, `SELECT source_capture.capture_id, source_capture.commit_id,
                             commit_row.commit_sequence
                        FROM source_captures source_capture
                        JOIN canonical_commits commit_row
                          ON commit_row.commit_id = source_capture.commit_id
                       WHERE source_capture.capture_key IN (${captureKeys.map(() => "?").join(",")})`, captureKeys);
    const latestCapture = committedCaptures.reduce((latest, candidate) =>
      Number(candidate.commit_sequence) >= Number(latest.commit_sequence) ? candidate : latest,
    );
    await (options.projection ?? refreshPGliteCurrentProjectionInTransaction)(transaction, {
      commitId: bytes(latestCapture.commit_id, "Investment projection commit"),
      cutoffSequence: Number(latestCapture.commit_sequence),
      captureIds: committedCaptures.map((capture) => bytes(capture.capture_id, "Investment projection capture")),
      transactionIds: result.transactions.map((row) => bytes(row.transactionId, "Investment transaction")),
    });
    assertPGliteCanonicalCommitNotCancelled(options.signal);
    return {
      status: "canonical-live" as const,
      captureId: snapshot.capture.captureId,
      accountId: idText(context.accountId),
      commitSequence: result.commitSequence,
      transactions: result.transactions,
      holdingCount: snapshot.capture.holdings.length,
      investmentTransactionCount: snapshot.capture.transactions.length,
      marginObservationCount: snapshot.capture.margin ? 1 : 0,
    };
  });
}

export function executePGliteCanonicalInvestmentCommand(
  store: PGliteStore,
  command: PGliteCanonicalInvestmentCommitCommand | PGliteCanonicalInvestmentCommitRequest,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalInvestmentCommitResult> {
  return commitPGliteCanonicalInvestmentCapture(store, "kind" in command ? command.request : command, options);
}
