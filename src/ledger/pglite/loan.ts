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
  PGliteCanonicalFinancialFactInput,
  PGliteCanonicalFinancialAccountInput,
  PGliteCanonicalBalanceObservationInput,
} from "./source-admission-validation.ts";
import type {
  LoanBalanceObservationInput,
  LoanCaptureInput,
  LoanCounterpartTransactionInput,
  LoanTransactionInput,
  LoanSourceId,
} from "../canonical/loan-financial.ts";
import type { CanonicalSourceEvidence, CanonicalSourceRecord } from "../canonical/canonical-source-evidence.ts";
import { PGLITE_CANONICAL_LOAN_COMMIT_COMMAND } from "./workflow-commands.ts";

/** Named worker command for a source-admitted loan statement. */
export { PGLITE_CANONICAL_LOAN_COMMIT_COMMAND };

export type PGliteCanonicalLoanCommitRequest = Readonly<{
  capture: LoanCaptureInput;
  recordedAtUtcUs?: number;
}>;

export type PGliteCanonicalLoanCommitCommand = Readonly<{
  kind: typeof PGLITE_CANONICAL_LOAN_COMMIT_COMMAND;
  request: PGliteCanonicalLoanCommitRequest;
}>;

export type PGliteCanonicalLoanCommitResult = Readonly<{
  status: "canonical-live";
  captureId: string;
  accountId: string;
  commitSequence: number;
  transactions: PGliteCanonicalFinancialCommitResult["transactions"];
  counterpartTransactionCount: number;
  balanceObservationCount: number;
  relationCount: number;
}>;

type LoanCaptureContext = {
  capture: PGliteCanonicalSourceCaptureTransactionResult;
  accountId: Uint8Array;
  commitId: Uint8Array;
  sourceConnectionId: Uint8Array;
  identityEpochId: Uint8Array;
};

const TOKEN = /^sha256:[A-Za-z0-9_-]+$/u;
const CONTRACTS: Readonly<Record<LoanSourceId, { route: string; contract: string }>> = {
  fubon: { route: "fubon/loan/canonical-v2", contract: "loan/canonical/v2.fubon" },
  yuanta: { route: "yuanta/loan/canonical-v1", contract: "loan/canonical/v1.yuanta" },
};
const EVENT_MAPPINGS: Readonly<Record<string, { eventKind: LoanTransactionInput["eventKind"]; direction: "inflow" | "outflow" }>> = {
  "LOAN-DISBURSEMENT": { eventKind: "disbursement", direction: "outflow" },
  "LOAN-PAYMENT": { eventKind: "payment", direction: "inflow" },
  "LOAN-INTEREST": { eventKind: "interest", direction: "inflow" },
  "LOAN-FEE": { eventKind: "fee", direction: "inflow" },
};

function fail(message: string): never {
  throw new Error(message);
}

function requireToken(value: string, label: string): string {
  if (!TOKEN.test(value)) fail(`${label} must be an opaque token.`);
  return value;
}

function requireDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) fail(`${label} must be YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    fail(`${label} must be a calendar date.`);
  return value;
}

function requireAmount(value: Readonly<{ coefficient: string; scale: number }>, label: string): void {
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
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value))
      return Uint8Array.from(Buffer.from(value.replaceAll("-", ""), "hex"));
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

function sourceRecord(record: LoanTransactionInput | LoanCounterpartTransactionInput, capture: LoanCaptureInput): CanonicalSourceRecord {
  const compact = "eventEvidence" in record
    ? {
        sourceRecordKey: record.sourceRecordKey,
        occurrenceIndex: record.occurrenceIndex,
        effectiveOn: record.effectiveOn,
        sourceTime: record.sourceTime,
        postingStatus: record.postingStatus,
        eventKind: record.eventKind,
        direction: record.direction,
        amount: record.amount,
        currency: record.currency,
        sourceDescription: record.sourceDescription ?? null,
        principal: record.principal ?? null,
        interest: record.interest ?? null,
        fee: record.fee ?? null,
        eventEvidence: record.eventEvidence,
        componentEvidence: record.componentEvidence ?? null,
        balanceSourceEvidence: record.balanceSourceEvidence ?? [],
      }
    : {
        sourceRecordKey: record.sourceRecordKey,
        occurrenceIndex: record.occurrenceIndex,
        effectiveOn: record.effectiveOn,
        sourceTime: record.sourceTime,
        postingStatus: record.postingStatus,
        direction: record.direction,
        amount: record.amount,
        currency: record.currency,
        description: record.description ?? null,
        sourceEvidence: record.sourceEvidence,
      };
  const content = { ...compact };
  if (capture.sourceId === "fubon" && "eventEvidence" in record) {
    delete content.balanceSourceEvidence;
    delete content.sourceDescription;
  }
  return {
    occurrenceKey: record.sourceRecordKey,
    collisionKey: digest(`${capture.sourceId}:${capture.identity.accountKey}:${record.sourceRecordKey}`),
    providerKey: record.sourceRecordKey,
    contentHash: digest(content),
    compact,
    compactJson: stableJson(compact),
    sequenceLexeme: String(record.occurrenceIndex),
    description: "description" in record
      ? record.description ?? null
      : (record as LoanTransactionInput).sourceDescription ?? null,
  };
}

function captureSource(capture: LoanCaptureInput): CanonicalSourceEvidence {
  const contract = CONTRACTS[capture.sourceId];
  const records = capture.records.map((record) => sourceRecord(record, capture));
  return {
    captureId: capture.captureId,
    integrationNamespace: capture.sourceId,
    sourceConnectionKey: requireToken(capture.identity.sourceConnectionKey, "Loan source connection key"),
    identityEpoch: requireToken(capture.identity.identityEpochKey, "Loan identity epoch key"),
    stream: "loan",
    recordKind: capture.identity.recordKind,
    routeKey: capture.authorityRoute,
    contractVersion: capture.contractVersion,
    subjectDigest: requireToken(capture.identity.subjectDigest, "Loan subject digest"),
    observedAt: capture.observedAt,
    accountNumber: capture.identity.accountNumber ?? null,
    scope: {
      startDate: capture.scope.startDate,
      endDate: capture.scope.endDate,
      dateFormat: "YYYY-MM-DD",
      kind: "bounded-range",
      completeness: "complete-range",
      ruleVersion: capture.scope.completenessRuleVersion,
      completenessBasis: capture.scope.completenessBasis,
      contractFingerprint: digest(`${capture.authorityRoute}:${capture.contractVersion}`),
      preflightFingerprint: digest(capture.captureId),
      pageTerminalPolicy: "last",
      sourceAccountKey: capture.identity.accountKey,
      accountNo: capture.identity.accountKey,
    },
    pages: capture.pages.map((page) => ({
      pageOrdinal: page.pageOrdinal,
      responseCode: page.responseCode,
      terminal: page.terminal,
      rowCount: page.rowCount,
      metadata: { proofKind: page.proofKind },
      responseDigest: digest(`${capture.captureId}:page:${page.pageOrdinal}`),
      proofKind: page.proofKind,
      contractFingerprint: digest(`${capture.authorityRoute}:${capture.contractVersion}`),
      preflightFingerprint: digest(capture.captureId),
      metadataJson: stableJson({ proofKind: page.proofKind }),
    })),
    records,
  };
}

function counterpartSource(capture: LoanCaptureInput, counterpart: LoanCounterpartTransactionInput): CanonicalSourceEvidence {
  const records = [sourceRecord(counterpart, capture)];
  return {
    captureId: counterpart.captureId,
    integrationNamespace: capture.sourceId,
    sourceConnectionKey: counterpart.sourceConnectionKey,
    identityEpoch: counterpart.identityEpochKey,
    stream: counterpart.stream,
    recordKind: counterpart.recordKind,
    routeKey: counterpart.authorityRoute,
    contractVersion: counterpart.contractVersion,
    subjectDigest: counterpart.subjectDigest,
    observedAt: capture.observedAt,
    scope: {
      startDate: capture.scope.startDate,
      endDate: capture.scope.endDate,
      dateFormat: "YYYY-MM-DD",
      kind: "bounded-range",
      completeness: "complete-range",
      ruleVersion: counterpart.contractVersion,
      completenessBasis: capture.scope.completenessBasis,
      contractFingerprint: digest(`${counterpart.authorityRoute}:${counterpart.contractVersion}`),
      preflightFingerprint: digest(`${capture.captureId}:${counterpart.captureId}`),
      pageTerminalPolicy: "last",
      sourceAccountKey: counterpart.accountKey,
      accountNo: counterpart.accountKey,
    },
    pages: [{
      pageOrdinal: 0,
      responseCode: "200",
      terminal: true,
      rowCount: 1,
      metadata: { proofKind: "source-declared-terminal-range" },
      responseDigest: digest(`${counterpart.captureId}:page`),
      proofKind: "source-declared-terminal-range",
      contractFingerprint: digest(`${counterpart.authorityRoute}:${counterpart.contractVersion}`),
      preflightFingerprint: digest(`${capture.captureId}:${counterpart.captureId}`),
      metadataJson: stableJson({ proofKind: "source-declared-terminal-range" }),
    }],
    records,
  };
}

function financialFact(capture: LoanCaptureInput, record: LoanTransactionInput): PGliteCanonicalFinancialFactInput {
  const local = `${record.effectiveOn}T${record.sourceTime.localTime}`;
  const epoch = Date.parse(`${local}+08:00`);
  if (!Number.isFinite(epoch)) fail(`Loan source time for ${record.sourceRecordKey} is invalid.`);
  return {
    sourceOccurrenceKey: record.sourceRecordKey,
    sourceSequence: record.sourceRecordKey,
    amount: record.amount,
    currency: record.currency,
    direction: record.direction,
    postingStatus: record.postingStatus,
    postingOrigin: "human-attested",
    postingBasis: "statement-posted-history",
    postingRuleVersion: capture.authorityRoute,
    description: record.description ?? record.sourceDescription ?? null,
    economicStatus: "normal",
    administrativeState: "active",
    semanticRuleVersion: capture.authorityRoute,
    effectiveOn: record.effectiveOn,
    transactionDateTimeLocal: local,
    timeZone: "Asia/Taipei",
    timePrecision: record.sourceTime.precision,
    timeOrigin: record.sourceTime.timeOrigin,
    effectiveTimeBasis: "source-reported",
    effectiveTimeRuleVersion: capture.authorityRoute,
    utcInstantUtcUs: epoch * 1_000,
  };
}

function counterpartFinancialFact(counterpart: LoanCounterpartTransactionInput, capture: LoanCaptureInput): PGliteCanonicalFinancialFactInput {
  const local = `${counterpart.effectiveOn}T${counterpart.sourceTime.localTime}`;
  const epoch = Date.parse(`${local}+08:00`);
  if (!Number.isFinite(epoch)) fail(`Loan counterpart source time for ${counterpart.sourceRecordKey} is invalid.`);
  return {
    sourceOccurrenceKey: counterpart.sourceRecordKey,
    sourceSequence: counterpart.sourceRecordKey,
    amount: counterpart.amount,
    currency: counterpart.currency,
    direction: counterpart.direction,
    postingStatus: counterpart.postingStatus,
    postingOrigin: "human-attested",
    postingBasis: "statement-posted-history",
    postingRuleVersion: counterpart.authorityRoute,
    description: counterpart.description ?? null,
    economicStatus: "normal",
    administrativeState: "active",
    semanticRuleVersion: counterpart.authorityRoute,
    effectiveOn: counterpart.effectiveOn,
    transactionDateTimeLocal: local,
    timeZone: "Asia/Taipei",
    timePrecision: counterpart.sourceTime.precision,
    timeOrigin: counterpart.sourceTime.timeOrigin,
    effectiveTimeBasis: "transaction-time",
    effectiveTimeRuleVersion: counterpart.authorityRoute,
    utcInstantUtcUs: epoch * 1_000,
  };
}

function balanceObservation(observation: LoanBalanceObservationInput): PGliteCanonicalBalanceObservationInput {
  return {
    observationKey: observation.observationKey,
    balanceKind: observation.balanceKind,
    balance: observation.balance,
    currency: observation.currency,
    effectiveAt: `${observation.effectiveAt}T00:00:00+08:00`,
    effectiveTimeBasis: "source-reported",
    effectiveTimeRuleVersion: observation.effectiveTimeRuleVersion,
    evidenceSourceRecordKey: observation.sourceRecordKey,
    evidenceSourceField: observation.effectiveTimeEvidence.sourceField,
    evidenceSourceValue: observation.effectiveTimeEvidence.value,
    evidenceContractVersion: observation.effectiveTimeEvidence.contractVersion,
    sourceOccurrenceKey: observation.sourceRecordKey,
    evidenceEndpoint: "loan/source-statement",
    evidenceResponseStatus: 200,
    evidenceCachePolicy: "provider-contract",
  };
}

function validateLoanCapture(capture: LoanCaptureInput): void {
  if (!capture || typeof capture !== "object") fail("A loan capture is required.");
  const expected = CONTRACTS[capture.sourceId];
  if (!expected || capture.authorityRoute !== expected.route || capture.contractVersion !== expected.contract)
    fail("Loan route or contract version is unsupported.");
  if (capture.identity.accountType !== "loan" || capture.identity.stream !== "loan" || capture.identity.currency !== "TWD" || capture.identity.recordKind !== `${capture.sourceId}-loan-transaction`)
    fail("Loan account identity is unsupported.");
  for (const [value, label] of [[capture.identity.sourceConnectionKey, "source connection"], [capture.identity.identityEpochKey, "identity epoch"], [capture.identity.accountKey, "account key"], [capture.identity.subjectDigest, "subject digest"], [capture.identity.accountNo, "account number"]] as const)
    requireToken(value, `Loan ${label}`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(capture.observedAt) || !Number.isFinite(Date.parse(capture.observedAt))) fail("Loan observedAt must be RFC3339 UTC.");
  requireDate(capture.scope.startDate, "Loan scope start");
  requireDate(capture.scope.endDate, "Loan scope end");
  if (capture.scope.startDate > capture.scope.endDate || capture.scope.completeness !== "complete-range" || capture.scope.completenessBasis !== "source-declared-terminal-range" || capture.scope.completenessRuleVersion !== expected.contract || capture.scope.terminal !== true || capture.scope.pageCount !== capture.pages.length)
    fail("Loan completeness contract is incomplete.");
  if (!capture.pages.length || capture.pages.some((page, index) => page.pageOrdinal !== index || page.responseCode !== "200" || !Number.isSafeInteger(page.rowCount) || page.rowCount < 0 || (index < capture.pages.length - 1 && page.terminal) || (index === capture.pages.length - 1 && !page.terminal)) || capture.pages.reduce((sum, page) => sum + page.rowCount, 0) !== capture.records.length)
    fail("Loan page evidence does not match source records.");
  const records = new Set<string>();
  for (const record of capture.records) {
    requireToken(record.sourceRecordKey, "Loan source record key");
    if (records.has(record.sourceRecordKey) || !Number.isSafeInteger(record.occurrenceIndex) || record.occurrenceIndex < 1)
      fail("Loan source records must have unique positive occurrence indexes.");
    records.add(record.sourceRecordKey);
    requireDate(record.effectiveOn, "Loan transaction effective date");
    if (!/^\d{2}:\d{2}:\d{2}$/u.test(record.sourceTime.localTime)) fail("Loan source local time is invalid.");
    const [hour, minute, second] = record.sourceTime.localTime.split(":").map(Number);
    if (hour > 23 || minute > 59 || second > 59 || (record.sourceTime.precision === "date" && (record.sourceTime.localTime !== "00:00:00" || record.sourceTime.timeOrigin !== "defaulted_local_midnight")) || (record.sourceTime.precision !== "date" && record.sourceTime.timeOrigin !== "source_reported")) fail("Loan source time semantics are invalid.");
    if (record.effectiveOn < capture.scope.startDate || record.effectiveOn > capture.scope.endDate || record.postingStatus !== "posted" || record.currency !== "TWD")
      fail("Loan transaction falls outside its admitted contract.");
    const mapping = EVENT_MAPPINGS[record.eventEvidence.sourceCode];
    if (!mapping || record.eventEvidence.kind !== "source-coded-loan-event" || record.eventEvidence.sourceRecordKey !== record.sourceRecordKey || record.eventEvidence.contractVersion !== expected.contract || mapping.eventKind !== record.eventKind || mapping.direction !== record.direction)
      fail("Loan event direction requires source-coded contract evidence.");
    requireAmount(record.amount, "Loan transaction amount");
    for (const component of [record.principal, record.interest, record.fee]) if (component) requireAmount(component, "Loan transaction component");
    if ((record.principal || record.interest || record.fee) && (record.componentEvidence?.kind !== "explicit-source-component" || record.componentEvidence.sourceRecordKey !== record.sourceRecordKey || record.componentEvidence.contractVersion !== expected.contract))
      fail("Loan components require explicit source evidence.");
    for (const evidence of record.balanceSourceEvidence ?? []) {
      requireDate(evidence.effectiveAt, "Loan balance source date");
      requireAmount(evidence.balance, "Loan balance source amount");
    }
  }
  const observationKeys = new Set<string>();
  for (const observation of capture.balanceObservations) {
    requireToken(observation.observationKey, "Loan balance observation key");
    if (observationKeys.has(observation.observationKey) || !records.has(observation.sourceRecordKey)) fail("Loan balance observation source evidence is invalid.");
    observationKeys.add(observation.observationKey);
    requireDate(observation.effectiveAt, "Loan balance effective date");
    requireAmount(observation.balance, "Loan balance amount");
    if (observation.currency !== "TWD" || observation.effectiveAt < capture.scope.startDate || observation.effectiveAt > capture.scope.endDate || observation.effectiveTimeEvidence.value !== observation.effectiveAt || observation.effectiveTimeEvidence.sourceRecordKey !== observation.sourceRecordKey)
      fail("Loan balance effective-time evidence is invalid.");
    const source = capture.records.find((record) => record.sourceRecordKey === observation.sourceRecordKey);
    const retained = source?.balanceSourceEvidence?.some((evidence) => evidence.balanceKind === observation.balanceKind && evidence.balance.coefficient === observation.balance.coefficient && evidence.balance.scale === observation.balance.scale && evidence.effectiveAt === observation.effectiveAt);
    if (!retained) fail("Loan balance must match retained source field evidence.");
  }
  for (const counterpart of capture.counterpartTransactions) {
    requireToken(counterpart.sourceRecordKey, "Loan counterpart source record key");
    requireToken(counterpart.accountKey, "Loan counterpart account key");
    requireToken(counterpart.sourceConnectionKey, "Loan counterpart source connection key");
    requireToken(counterpart.identityEpochKey, "Loan counterpart identity epoch key");
    requireToken(counterpart.subjectDigest, "Loan counterpart subject digest");
    requireDate(counterpart.effectiveOn, "Loan counterpart effective date");
    requireAmount(counterpart.amount, "Loan counterpart amount");
    const expectedCounterpartRoute = capture.sourceId === "fubon" ? "fubon/loan/counterpart-deposit-v1" : "yuanta/loan/counterpart-deposit-v1";
    const expectedCounterpartContract = capture.sourceId === "fubon" ? "loan/counterpart/v1.fubon" : "loan/counterpart/v1.yuanta";
    if (counterpart.authorityRoute !== expectedCounterpartRoute || counterpart.contractVersion !== expectedCounterpartContract || counterpart.accountType !== "depository" || counterpart.stream !== "domestic-deposit" || counterpart.recordKind !== `${capture.sourceId}-loan-counterpart-deposit` || counterpart.currency !== "TWD" || counterpart.postingStatus !== "posted" || counterpart.sourceEvidence.kind !== "source-linked-counterpart" || counterpart.sourceEvidence.sourceRecordKey !== counterpart.sourceRecordKey || counterpart.sourceEvidence.contractVersion !== counterpart.contractVersion)
      fail("Loan counterpart requires explicit source linkage evidence.");
  }
  const counterpartByRecord = new Map(capture.counterpartTransactions.map((row) => [row.sourceRecordKey, row]));
  for (const relation of capture.relations) {
    if (relation.kind !== "transfer_counterpart" || relation.fromSourceRecordKey === relation.toSourceRecordKey || !requireToken(relation.fromSourceRecordKey, "Loan relation source") || !requireToken(relation.toSourceRecordKey, "Loan relation target") || !requireToken(relation.fromAccountKey, "Loan relation from account") || !requireToken(relation.toAccountKey, "Loan relation to account") || relation.fromDirection === relation.toDirection)
      fail("Loan relation endpoints are invalid.");
    const fromLoan = capture.records.find((row) => row.sourceRecordKey === relation.fromSourceRecordKey);
    const toLoan = capture.records.find((row) => row.sourceRecordKey === relation.toSourceRecordKey);
    const fromCounterpart = counterpartByRecord.get(relation.fromSourceRecordKey);
    const toCounterpart = counterpartByRecord.get(relation.toSourceRecordKey);
    if (!fromLoan && !fromCounterpart || !toLoan && !toCounterpart || Boolean(fromLoan) === Boolean(toLoan)) fail("Loan relations must connect one loan and one deposit counterpart.");
    const fromAccount = fromLoan ? capture.identity.accountKey : fromCounterpart!.accountKey;
    const toAccount = toLoan ? capture.identity.accountKey : toCounterpart!.accountKey;
    if (relation.fromAccountKey !== fromAccount || relation.toAccountKey !== toAccount) fail("Loan relation endpoint account identity is not evidenced.");
    if ((fromLoan?.direction ?? fromCounterpart?.direction) !== relation.fromDirection || (toLoan?.direction ?? toCounterpart?.direction) !== relation.toDirection) fail("Loan relation source direction is not evidenced.");
    const counterpart = fromCounterpart ?? toCounterpart;
    if (!counterpart || counterpart.sourceConnectionKey !== capture.identity.sourceConnectionKey || relation.evidence.kind !== "explicit-source-linkage" || relation.evidence.contractVersion !== expected.contract || !requireToken(relation.evidence.sourceRecordKey, "Loan relation evidence source") || !requireToken(relation.evidence.relationId, "Loan relation evidence ID") || (relation.evidence.sourceRecordKey !== relation.fromSourceRecordKey && relation.evidence.sourceRecordKey !== relation.toSourceRecordKey) || counterpart.sourceEvidence.relationId !== relation.evidence.relationId) fail("Loan relation requires matching explicit source linkage evidence.");
  }
  const coverage = capture.relationCoverage ?? "not-asserted";
  if (coverage !== "not-asserted" && coverage !== "source-linked-complete") fail("Loan relation coverage is unsupported.");
  if (coverage === "source-linked-complete" && (!capture.counterpartTransactions.length || !capture.relations.length)) fail("Complete loan relation coverage requires counterpart and relation evidence.");
}

async function contextFor(transaction: PGliteTransaction, capture: PGliteCanonicalSourceCaptureTransactionResult): Promise<LoanCaptureContext> {
  const row = await first<{ account_id: unknown; commit_id: unknown; source_connection_id: unknown; identity_epoch_id: unknown }>(transaction, `SELECT scope.account_id, source_capture.commit_id, source_capture.source_connection_id, source_capture.identity_epoch_id
    FROM source_captures source_capture JOIN capture_scopes scope ON scope.capture_id = source_capture.capture_id
    WHERE source_capture.capture_id = ?`, [capture.captureId]);
  if (!row?.account_id) fail("Loan source capture account scope is missing.");
  return {
    capture,
    accountId: bytes(row.account_id, "Loan account"),
    commitId: bytes(row.commit_id, "Loan commit"),
    sourceConnectionId: bytes(row.source_connection_id, "Loan source connection"),
    identityEpochId: bytes(row.identity_epoch_id, "Loan identity epoch"),
  };
}

async function persistIdentity(transaction: PGliteTransaction, context: LoanCaptureContext, identity: { accountKey: string; accountNo: string; accountType: "loan" | "depository"; stream: "loan" | "domestic-deposit" }): Promise<void> {
  const account = await first<{ source_connection_id: unknown; identity_epoch_id: unknown; source_account_key: string; account_type: string; stream: string }>(transaction, "SELECT source_connection_id, identity_epoch_id, source_account_key, account_type, stream FROM financial_accounts WHERE account_id = ?", [context.accountId]);
  if (!account || account.source_account_key !== identity.accountKey || account.account_type !== identity.accountType || account.stream !== identity.stream)
    fail("Loan typed account identity does not match the canonical financial account.");
  const existing = await first<{ account_key: string; account_no: string; account_type: string; stream: string }>(transaction, "SELECT account_key, account_no, account_type, stream FROM loan_account_identities WHERE account_id = ?", [context.accountId]);
  if (existing) {
    if (existing.account_key !== identity.accountKey || existing.account_no !== identity.accountNo || existing.account_type !== identity.accountType || existing.stream !== identity.stream)
      fail("Loan stable account identity overwrite is forbidden.");
    return;
  }
  await query(transaction, `INSERT INTO loan_account_identities(account_id, source_connection_id, identity_epoch_id, created_commit_id, account_key, account_no, account_type, stream) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [context.accountId, context.sourceConnectionId, context.identityEpochId, context.commitId, identity.accountKey, identity.accountNo, identity.accountType, identity.stream]);
}

async function persistFacts(transaction: PGliteTransaction, context: LoanCaptureContext, capture: LoanCaptureInput, result: PGliteCanonicalFinancialCommitResult): Promise<void> {
  const resultByOccurrence = new Map(result.transactions.map((row) => [row.sourceOccurrenceKey, row]));
  for (const record of capture.records) {
    const committed = resultByOccurrence.get(record.sourceRecordKey);
    if (!committed) fail("Loan transaction result is missing a source occurrence.");
    const sourceRecordId = context.capture.sourceRecordIdsByOccurrence.get(record.sourceRecordKey);
    if (!sourceRecordId) fail("Loan typed fact source record is missing.");
    const existing = await first<Record<string, unknown>>(transaction, "SELECT * FROM loan_transaction_facts WHERE revision_id = ?", [bytes(committed.revisionId, "Loan revision")]);
    const expected = [record.occurrenceIndex, record.eventKind, record.eventEvidence.sourceCode, record.eventEvidence.contractVersion, record.principal?.coefficient ?? null, record.principal?.scale ?? null, record.interest?.coefficient ?? null, record.interest?.scale ?? null, record.fee?.coefficient ?? null, record.fee?.scale ?? null, record.componentEvidence?.sourceRecordKey ?? null, record.componentEvidence?.contractVersion ?? null];
    if (existing) {
      const actual = [Number(existing.occurrence_index), existing.event_kind, existing.event_source_code, existing.event_evidence_contract_version, existing.principal_coefficient ?? null, existing.principal_scale == null ? null : Number(existing.principal_scale), existing.interest_coefficient ?? null, existing.interest_scale == null ? null : Number(existing.interest_scale), existing.fee_coefficient ?? null, existing.fee_scale == null ? null : Number(existing.fee_scale), existing.component_evidence_source_record_key ?? null, existing.component_evidence_contract_version ?? null];
      if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("Typed loan transaction facts cannot be overwritten.");
      continue;
    }
    await query(transaction, `INSERT INTO loan_transaction_facts(transaction_id, revision_id, source_record_id, capture_id, commit_id, occurrence_index, event_kind, event_source_code, event_evidence_contract_version, principal_coefficient, principal_scale, interest_coefficient, interest_scale, fee_coefficient, fee_scale, component_evidence_source_record_key, component_evidence_contract_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [bytes(committed.transactionId, "Loan transaction"), bytes(committed.revisionId, "Loan revision"), sourceRecordId, context.capture.captureId, context.commitId, ...expected]);
  }
}

async function persistRelations(transaction: PGliteTransaction, context: LoanCaptureContext, capture: LoanCaptureInput, counterpartContexts: ReadonlyMap<string, LoanCaptureContext>, results: ReadonlyMap<string, PGliteCanonicalFinancialCommitResult>): Promise<void> {
  for (const relation of capture.relations) {
    const endpoint = (sourceRecordKey: string): { context: LoanCaptureContext; transactionId: Uint8Array; accountKey: string; direction: "inflow" | "outflow" } => {
      const own = results.get(capture.captureId)?.transactions.find((row) => row.sourceOccurrenceKey === sourceRecordKey);
      if (own) return { context, transactionId: bytes(own.transactionId, "Loan relation transaction"), accountKey: capture.identity.accountKey, direction: relation.fromSourceRecordKey === sourceRecordKey ? relation.fromDirection : relation.toDirection };
      for (const [captureId, counterpart] of counterpartContexts) {
        const result = results.get(captureId)?.transactions.find((row) => row.sourceOccurrenceKey === sourceRecordKey);
        if (result) {
          const input = capture.counterpartTransactions.find((row) => row.captureId === captureId && row.sourceRecordKey === sourceRecordKey);
          if (!input) break;
          return { context: counterpart, transactionId: bytes(result.transactionId, "Loan relation transaction"), accountKey: input.accountKey, direction: relation.fromSourceRecordKey === sourceRecordKey ? relation.fromDirection : relation.toDirection };
        }
      }
      fail("Loan relation endpoint transaction is missing.");
    };
    const from = endpoint(relation.fromSourceRecordKey);
    const to = endpoint(relation.toSourceRecordKey);
    const relationKey = digest(["loan-relation-v11", Buffer.from(from.context.sourceConnectionId).toString("hex"), Buffer.from(from.context.accountId).toString("hex"), Buffer.from(from.transactionId).toString("hex"), Buffer.from(to.context.accountId).toString("hex"), Buffer.from(to.transactionId).toString("hex")].join(":"));
    const existing = await first<{ relation_id: unknown; from_account_id: unknown; to_account_id: unknown; from_transaction_id: unknown; to_transaction_id: unknown }>(transaction, "SELECT relation_id, from_account_id, to_account_id, from_transaction_id, to_transaction_id FROM transaction_relations WHERE account_id = ? AND relation_key = ?", [context.accountId, relationKey]);
    const relationId = existing?.relation_id ? bytes(existing.relation_id, "Loan relation") : uuidBytes();
    if (existing) {
      const same = [existing.from_account_id, existing.to_account_id, existing.from_transaction_id, existing.to_transaction_id].every((value, index) => Buffer.from(bytes(value, "Loan relation endpoint")).equals(Buffer.from([from.context.accountId, to.context.accountId, from.transactionId, to.transactionId][index]!)));
      if (!same) fail("Loan transfer relation identity overwrite is forbidden.");
    } else {
      await query(transaction, `INSERT INTO transaction_relations(relation_id, account_id, source_connection_id, identity_epoch_id, commit_id, relation_key, relation_kind, from_account_id, to_account_id, from_source_record_key, to_source_record_key, from_transaction_id, to_transaction_id, from_direction, to_direction, evidence_source_record_key, evidence_relation_id, evidence_contract_version, from_identity_epoch_id, to_identity_epoch_id) VALUES (?, ?, ?, ?, ?, ?, 'transfer_counterpart', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [relationId, context.accountId, context.sourceConnectionId, context.identityEpochId, context.commitId, relationKey, from.context.accountId, to.context.accountId, relation.fromSourceRecordKey, relation.toSourceRecordKey, from.transactionId, to.transactionId, relation.fromDirection, relation.toDirection, relation.evidence.sourceRecordKey, relation.evidence.relationId, relation.evidence.contractVersion, from.context.identityEpochId, to.context.identityEpochId]);
    }
    const evidenceContext = capture.counterpartTransactions.find((row) => row.sourceRecordKey === relation.evidence.sourceRecordKey)?.captureId;
    const evidenceCapture = evidenceContext ? counterpartContexts.get(evidenceContext)?.capture : context.capture;
    const evidenceRecordId = evidenceCapture?.sourceRecordIdsByOccurrence.get(relation.evidence.sourceRecordKey);
    if (!evidenceRecordId) fail("Loan relation evidence source record is missing.");
    if (!evidenceCapture) fail("Loan relation evidence capture is missing.");
    await query(transaction, `INSERT INTO transaction_relation_provenance(relation_id, source_record_id, capture_id, commit_id, evidence_source_record_key, evidence_relation_id, evidence_contract_version) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [relationId, evidenceRecordId, evidenceCapture.captureId, context.commitId, relation.evidence.sourceRecordKey, relation.evidence.relationId, relation.evidence.contractVersion]);
  }
}

function loanAccount(capture: LoanCaptureInput): PGliteCanonicalFinancialAccountInput {
  return {
    sourceAccountKey: capture.identity.accountKey,
    accountNo: capture.identity.accountNumber?.value ?? null,
    accountType: "loan",
    currency: "TWD",
  };
}

function counterpartAccount(counterpart: LoanCounterpartTransactionInput): PGliteCanonicalFinancialAccountInput {
  return { sourceAccountKey: counterpart.accountKey, accountNo: null, accountType: "depository", currency: "TWD" };
}

/** Commit an independent loan spine inside a caller-owned transaction. */
export async function commitPGliteCanonicalLoanCaptureInTransaction(
  transaction: PGliteTransaction,
  request: PGliteCanonicalLoanCommitRequest,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalLoanCommitResult> {
  const snapshot = structuredClone(request);
  validateLoanCapture(snapshot.capture);
    const main = await commitPGliteCanonicalFinancialCaptureInTransaction(transaction, {
      capture: captureSource(snapshot.capture),
      account: loanAccount(snapshot.capture),
      accountIdentifier: snapshot.capture.identity.accountNumber ?? null,
      transactions: snapshot.capture.records.map((record) => financialFact(snapshot.capture, record)),
      balanceObservations: snapshot.capture.balanceObservations.map(balanceObservation),
      withdrawalPolicy: "never-infer",
      recordedAtUtcUs: snapshot.recordedAtUtcUs ?? options.recordedAtUtcUs,
    }, { ...options, skipProjection: true });
    const mainContext = await contextFor(transaction, (await first<{ capture_id: unknown }>(transaction, "SELECT capture_id FROM source_captures WHERE capture_key = ?", [snapshot.capture.captureId])) ? {
      ...await (async () => {
        const source = await first<{ capture_id: unknown; commit_id: unknown; source_connection_id: unknown; identity_epoch_id: unknown }>(transaction, "SELECT capture_id, commit_id, source_connection_id, identity_epoch_id FROM source_captures WHERE capture_key = ?", [snapshot.capture.captureId]);
        if (!source) fail("Loan source capture context is missing.");
        const sourceRecords = await query<{ occurrence_key: string; source_record_id: unknown }>(transaction, "SELECT occurrence_key, source_record_id FROM source_records WHERE capture_id = ?", [source.capture_id]);
        return {
          receipt: { captureId: snapshot.capture.captureId, knowledgePoint: main.commitSequence },
          captureId: bytes(source.capture_id, "Loan capture"),
          scopeId: bytes((await first<{ scope_id: unknown }>(transaction, "SELECT scope_id FROM capture_scopes WHERE capture_id = ?", [source.capture_id]))?.scope_id, "Loan scope"),
          commitId: bytes(source.commit_id, "Loan commit"),
          sourceConnectionId: bytes(source.source_connection_id, "Loan source connection"),
          identityEpochId: bytes(source.identity_epoch_id, "Loan identity epoch"),
          sourceSubjectId: bytes((await first<{ source_subject_id: unknown }>(transaction, "SELECT source_subject_id FROM source_captures WHERE capture_id = ?", [source.capture_id]))?.source_subject_id, "Loan subject"),
          sourceRecordIds: sourceRecords.map((row) => bytes(row.source_record_id, "Loan source record")),
          sourceRecordIdsByOccurrence: new Map(sourceRecords.map((row) => [row.occurrence_key, bytes(row.source_record_id, "Loan source record")])),
        } satisfies PGliteCanonicalSourceCaptureTransactionResult;
      })(),
    } : fail("Loan source capture context is missing."));
    await persistIdentity(transaction, mainContext, { accountKey: snapshot.capture.identity.accountKey, accountNo: snapshot.capture.identity.accountNo, accountType: "loan", stream: "loan" });
    await persistFacts(transaction, mainContext, snapshot.capture, main);

    const counterpartContexts = new Map<string, LoanCaptureContext>();
    const resultByCapture = new Map<string, PGliteCanonicalFinancialCommitResult>([[snapshot.capture.captureId, main]]);
    for (const counterpart of snapshot.capture.counterpartTransactions) {
      const source = counterpartSource(snapshot.capture, counterpart);
      const result = await commitPGliteCanonicalFinancialCaptureInTransaction(transaction, {
        capture: source,
        account: counterpartAccount(counterpart),
        transactions: [counterpartFinancialFact(counterpart, snapshot.capture)],
        withdrawalPolicy: "never-infer",
        recordedAtUtcUs: options.recordedAtUtcUs,
      }, { ...options, skipProjection: true });
      const raw = await first<{ capture_id: unknown; commit_id: unknown; source_connection_id: unknown; identity_epoch_id: unknown; source_subject_id: unknown; scope_id: unknown }>(transaction, "SELECT source_capture.capture_id, source_capture.commit_id, source_capture.source_connection_id, source_capture.identity_epoch_id, source_capture.source_subject_id, scope.scope_id FROM source_captures source_capture JOIN capture_scopes scope ON scope.capture_id = source_capture.capture_id WHERE source_capture.capture_key = ?", [counterpart.captureId]);
      if (!raw) fail("Loan counterpart source capture context is missing.");
      const sourceRecords = await query<{ occurrence_key: string; source_record_id: unknown }>(transaction, "SELECT occurrence_key, source_record_id FROM source_records WHERE capture_id = ?", [raw.capture_id]);
      const context: LoanCaptureContext = {
        capture: {
          receipt: { captureId: counterpart.captureId, knowledgePoint: result.commitSequence },
          captureId: bytes(raw.capture_id, "Loan counterpart capture"),
          scopeId: bytes(raw.scope_id, "Loan counterpart scope"),
          commitId: bytes(raw.commit_id, "Loan counterpart commit"),
          sourceConnectionId: bytes(raw.source_connection_id, "Loan counterpart source connection"),
          identityEpochId: bytes(raw.identity_epoch_id, "Loan counterpart identity epoch"),
          sourceSubjectId: bytes(raw.source_subject_id, "Loan counterpart subject"),
          sourceRecordIds: sourceRecords.map((row) => bytes(row.source_record_id, "Loan counterpart record")),
          sourceRecordIdsByOccurrence: new Map(sourceRecords.map((row) => [row.occurrence_key, bytes(row.source_record_id, "Loan counterpart record")])),
        },
        accountId: bytes(raw.capture_id, "unused"),
        commitId: bytes(raw.commit_id, "Loan counterpart commit"),
        sourceConnectionId: bytes(raw.source_connection_id, "Loan counterpart source connection"),
        identityEpochId: bytes(raw.identity_epoch_id, "Loan counterpart identity epoch"),
      };
      const accountRow = await first<{ account_id: unknown }>(transaction, "SELECT scope.account_id FROM capture_scopes scope JOIN source_captures source_capture ON source_capture.capture_id = scope.capture_id WHERE source_capture.capture_key = ?", [counterpart.captureId]);
      if (!accountRow?.account_id) fail("Loan counterpart account scope is missing.");
      context.accountId = bytes(accountRow.account_id, "Loan counterpart account");
      counterpartContexts.set(counterpart.captureId, context);
      resultByCapture.set(counterpart.captureId, result);
      await persistIdentity(transaction, context, { accountKey: counterpart.accountKey, accountNo: counterpart.accountNo, accountType: "depository", stream: "domestic-deposit" });
    }
    await persistRelations(transaction, mainContext, snapshot.capture, counterpartContexts, resultByCapture);
    const allContexts = [mainContext, ...counterpartContexts.values()];
    const latestContext = allContexts.reduce((latest, candidate) =>
      candidate.capture.receipt.knowledgePoint >= latest.capture.receipt.knowledgePoint
        ? candidate
        : latest,
    );
    await (options.projection ?? refreshPGliteCurrentProjectionInTransaction)(transaction, {
      commitId: latestContext.commitId,
      cutoffSequence: latestContext.capture.receipt.knowledgePoint,
      captureIds: allContexts.map((context) => context.capture.captureId),
      transactionIds: resultByCapture.size === 0
        ? []
        : [...resultByCapture.values()].flatMap((result) => result.transactions.map((row) => bytes(row.transactionId, "Loan transaction"))),
    });
    assertPGliteCanonicalCommitNotCancelled(options.signal);
    return {
      status: "canonical-live" as const,
      captureId: snapshot.capture.captureId,
      accountId: idText(mainContext.accountId),
      commitSequence: main.commitSequence,
      transactions: main.transactions,
      counterpartTransactionCount: snapshot.capture.counterpartTransactions.length,
      balanceObservationCount: snapshot.capture.balanceObservations.length,
      relationCount: snapshot.capture.relations.length,
    };
}

export async function commitPGliteCanonicalLoanCapture(
  store: PGliteStore,
  request: PGliteCanonicalLoanCommitRequest,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalLoanCommitResult> {
  return store.transaction((transaction) =>
    commitPGliteCanonicalLoanCaptureInTransaction(transaction, request, options),
  );
}

export function executePGliteCanonicalLoanCommand(
  store: PGliteStore,
  command: PGliteCanonicalLoanCommitCommand | PGliteCanonicalLoanCommitRequest,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalLoanCommitResult> {
  return commitPGliteCanonicalLoanCapture(store, "kind" in command ? command.request : command, options);
}
