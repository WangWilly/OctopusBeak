import { createHash, randomUUID } from "node:crypto";
import type {
  PGliteCanonicalBalanceObservationInput,
  PGliteCanonicalFinancialAccountInput,
  PGliteCanonicalFinancialFactInput,
  PGliteCanonicalSourceEvidence,
} from "./source-admission-validation.ts";
import {
  assertPGliteCanonicalCommitNotCancelled,
  admitPGliteCanonicalFinancialCaptureInTransaction,
  assertPGliteStoredByThisCapture,
  findPGliteFinancialAccountId,
  refreshPGliteAdmittedFinancialProjection,
  findPGliteSourceSubjectId,
  listPGliteExpectedOccurrences,
  type PGliteAdmittedFinancialCapture,
  type PGliteCanonicalCommitOptions,
  type PGliteCanonicalOccurrenceSupersessionInput,
  type PGliteCanonicalOccurrenceWithdrawalInput,
} from "./canonical-source-store.ts";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";
import { canonicalResetRequiredFor } from "./canonical-reset.ts";
import type { CardIdentitySecret } from "../../lib/shared-identity/card-identity-secret.ts";
import { admitCardIdentitySecret } from "./card-identity-secret.ts";
import {
  decodeCreditCardQueryBucket,
  promisesBilledMonotonicity,
} from "../canonical/credit-card-query-inventory.ts";

export type PGliteCanonicalCreditCardAmount = Readonly<{
  coefficient: string;
  scale: number;
}>;

export type PGliteCanonicalCreditCardIdentity = Readonly<{
  accountNaturalKey: string;
  identityMethod: string;
}>;

export type PGliteCanonicalCreditCardInstrument = Readonly<{
  instrumentKey: string;
  cardMask?: string | null;
  role: string;
  lifecycle?: string | null;
  evidenceSourceOccurrenceKey: string;
}>;

export type PGliteCanonicalCreditCardTransaction = PGliteCanonicalFinancialFactInput & Readonly<{
  instrumentKey: string;
  billingStatus: "billed" | "unbilled";
  consumeDate?: string | null;
  postingDate?: string | null;
  effectiveDateBasis?: "consume-date" | "posting-date-fallback";
  statementKey?: string | null;
}>;

export type PGliteCanonicalCreditCardStatement = Readonly<{
  statementKey: string;
  revisionKey: string;
  cycleStart: string;
  cycleEnd: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  balance: PGliteCanonicalCreditCardAmount;
  minimumPayment: PGliteCanonicalCreditCardAmount | null;
  transactionSourceOccurrenceKeys: readonly string[];
  evidenceSourceOccurrenceKey: string;
}>;

export type PGliteCanonicalCreditCardRelation = Readonly<{
  kind: string;
  fromSourceOccurrenceKey: string;
  toSourceOccurrenceKey: string;
  evidenceSourceOccurrenceKey: string;
}>;

export type PGliteCanonicalCreditCardBalanceEstimate = Readonly<{
  kind: "estimate";
  basis: "provider-used-credit" | "credit-limit-minus-available";
  formula: string;
  limit?: PGliteCanonicalCreditCardAmount;
  available?: PGliteCanonicalCreditCardAmount;
}>;

export type PGliteCanonicalCreditCardCaptureRequest = Readonly<{
  capture: PGliteCanonicalSourceEvidence;
  account: PGliteCanonicalFinancialAccountInput;
  identity: PGliteCanonicalCreditCardIdentity;
  instruments: readonly PGliteCanonicalCreditCardInstrument[];
  transactions: readonly PGliteCanonicalCreditCardTransaction[];
  statements: readonly PGliteCanonicalCreditCardStatement[];
  relations?: readonly PGliteCanonicalCreditCardRelation[];
  balance?: Readonly<{
    observation: PGliteCanonicalBalanceObservationInput;
    estimate: PGliteCanonicalCreditCardBalanceEstimate;
  }>;
  requireExistingAccount?: boolean;
}>;

export type PGliteCanonicalCreditCardBalanceCaptureRequest = Readonly<{
  capture: PGliteCanonicalSourceEvidence;
  account: PGliteCanonicalFinancialAccountInput;
  identity: PGliteCanonicalCreditCardIdentity;
  balance: Readonly<{
    observation: PGliteCanonicalBalanceObservationInput;
    estimate: PGliteCanonicalCreditCardBalanceEstimate;
  }>;
}>;

export type PGliteCanonicalCreditCardCommitResult = Readonly<{
  status: "committed";
  captureId: string;
  accountId: string;
  commitSequence: number;
  transactionCount: number;
  instrumentCount: number;
  statementCount: number;
  balanceRevisionCreated: boolean;
  /** Unbilled transactions whose source support this capture withdrew because they vanished. */
  withdrawnTransactionCount: number;
}>;

export class PGliteCanonicalCreditCardAdmissionError extends Error {
  readonly code:
    | "invalid-contract"
    | "identity-conflict"
    | "revision-conflict"
    | "missing-reference"
    | "canonical-reset-required";

  constructor(
    code: PGliteCanonicalCreditCardAdmissionError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PGliteCanonicalCreditCardAdmissionError";
    this.code = code;
  }
}

function fail(code: PGliteCanonicalCreditCardAdmissionError["code"], message: string): never {
  throw new PGliteCanonicalCreditCardAdmissionError(code, message);
}

function uuidBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));
}

function valueText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") fail("invalid-contract", `${label} is required.`);
  return value.trim();
}

function exact(value: PGliteCanonicalCreditCardAmount, label: string): void {
  if (!/^-?(?:0|[1-9]\d*)$/u.test(value.coefficient) || !Number.isSafeInteger(value.scale) || value.scale < 0)
    fail("invalid-contract", `${label} must be an exact non-negative-scale amount.`);
}

function canonicalBalanceInstant(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/u.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return value;
  const milliseconds = Date.parse(value);
  const seconds = Math.floor(milliseconds / 1000);
  const fraction = (match[2] ?? "").padEnd(9, "0").slice(0, 9);
  return `${new Date(seconds * 1000).toISOString().slice(0, 19)}.${fraction}Z`;
}

function balanceObservationKey(observation: PGliteCanonicalBalanceObservationInput): string {
  return `sha256:${createHash("sha256")
    .update(`canonical/depository-balance-observation/v2|${observation.observationKey}|${observation.balanceKind}|${observation.currency}|${canonicalBalanceInstant(observation.effectiveAt)}`)
    .digest("base64url")}`;
}

function isoDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) fail("invalid-contract", `${label} must be YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    fail("invalid-contract", `${label} must be a calendar date in YYYY-MM-DD form.`);
}

function noRawPan(value: unknown, path = "request", seen = new Set<object>()): void {
  if (typeof value === "string") {
    const digits = value.replace(/[ -]/gu, "");
    if (/^\d{13,19}$/u.test(digits)) {
      let sum = 0;
      let alternate = false;
      for (let index = digits.length - 1; index >= 0; index -= 1) {
        let digit = Number(digits[index]);
        if (alternate) {
          digit *= 2;
          if (digit > 9) digit -= 9;
        }
        sum += digit;
        alternate = !alternate;
      }
      if (sum % 10 === 0) fail("invalid-contract", `Raw PAN-like value is forbidden at ${path}.`);
    }
    return;
  }
  if (!value || typeof value !== "object" || value instanceof Uint8Array || seen.has(value)) return;
  seen.add(value);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:full|raw)?pan$/iu.test(key)) fail("invalid-contract", `Raw PAN field is forbidden at ${path}.${key}.`);
    noRawPan(nested, `${path}.${key}`, seen);
  }
}

function validateRequest(request: PGliteCanonicalCreditCardCaptureRequest): void {
  noRawPan(request);
  if (request.account.accountType !== "credit") fail("invalid-contract", "Credit-card capture account must be credit.");
  valueText(request.account.sourceAccountKey, "Credit-card source account key");
  valueText(request.identity.accountNaturalKey, "Credit-card account identity");
  valueText(request.identity.identityMethod, "Credit-card identity method");
  const sourceAccountKey = request.capture.scope.sourceAccountKey ?? request.capture.scope.accountNo;
  if (sourceAccountKey !== request.account.sourceAccountKey) fail("invalid-contract", "Credit-card account key must match source scope.");
  const occurrenceKeys = new Set(request.capture.records.map((record) => record.occurrenceKey));
  const requireOccurrence = (key: string, label: string): void => {
    valueText(key, label);
    if (!occurrenceKeys.has(key)) fail("missing-reference", `${label} is absent from source evidence.`);
  };
  const instrumentKeys = new Set<string>();
  for (const instrument of request.instruments) {
    valueText(instrument.instrumentKey, "Credit-card instrument key");
    if (instrumentKeys.has(instrument.instrumentKey)) fail("invalid-contract", "Credit-card instrument key is duplicated.");
    instrumentKeys.add(instrument.instrumentKey);
    valueText(instrument.role, "Credit-card instrument role");
    if (instrument.cardMask !== undefined && instrument.cardMask !== null && !/^\*{4}\d{4}$/u.test(instrument.cardMask)) fail("invalid-contract", "Credit-card mask must retain only **** plus four digits.");
    requireOccurrence(instrument.evidenceSourceOccurrenceKey, "Credit-card instrument evidence");
  }
  const transactionKeys = new Set<string>();
  const recordsByOccurrence = new Map(
    request.capture.records.map((record) => [record.occurrenceKey, record]),
  );
  const billingStatusesByEconomicGroup = new Map<string, Set<string>>();
  for (const transaction of request.transactions) {
    requireOccurrence(transaction.sourceOccurrenceKey, "Credit-card transaction source occurrence");
    if (transactionKeys.has(transaction.sourceOccurrenceKey)) fail("invalid-contract", "Credit-card transaction occurrence is duplicated.");
    transactionKeys.add(transaction.sourceOccurrenceKey);
    if (!instrumentKeys.has(transaction.instrumentKey)) fail("missing-reference", `Credit-card transaction instrument is missing: ${transaction.instrumentKey}.`);
    if (transaction.billingStatus !== "billed" && transaction.billingStatus !== "unbilled") fail("invalid-contract", "Credit-card billing status is unsupported.");
    if (transaction.consumeDate !== undefined && transaction.consumeDate !== null) isoDate(transaction.consumeDate, "Credit-card consume date");
    if (transaction.postingDate !== undefined && transaction.postingDate !== null) isoDate(transaction.postingDate, "Credit-card posting date");
    if (transaction.effectiveDateBasis !== undefined && transaction.effectiveDateBasis !== "consume-date" && transaction.effectiveDateBasis !== "posting-date-fallback") fail("invalid-contract", "Credit-card effective date basis is unsupported.");
    if (transaction.statementKey !== undefined && transaction.statementKey !== null) valueText(transaction.statementKey, "Credit-card statement key");
    const group = recordsByOccurrence.get(transaction.sourceOccurrenceKey)?.occurrenceGroup;
    if (group) {
      const key = JSON.stringify([group.scopeKey, group.partitionDate, group.fingerprint]);
      const statuses = billingStatusesByEconomicGroup.get(key) ?? new Set<string>();
      statuses.add(transaction.billingStatus);
      billingStatusesByEconomicGroup.set(key, statuses);
    }
  }
  if ([...billingStatusesByEconomicGroup.values()].some((statuses) => statuses.size > 1))
    fail("invalid-contract", "An identical economic transaction cannot appear in billed and unbilled grids in one capture.");
  const statementKeys = new Set<string>();
  for (const statement of request.statements) {
    valueText(statement.statementKey, "Credit-card statement key");
    valueText(statement.revisionKey, "Credit-card statement revision key");
    if (statementKeys.has(statement.statementKey)) fail("invalid-contract", "Credit-card statement key is duplicated.");
    statementKeys.add(statement.statementKey);
    isoDate(statement.cycleStart, "Credit-card statement cycle start");
    isoDate(statement.cycleEnd, "Credit-card statement cycle end");
    isoDate(statement.issueDate, "Credit-card statement issue date");
    isoDate(statement.dueDate, "Credit-card statement due date");
    valueText(statement.currency, "Credit-card statement currency");
    exact(statement.balance, "Credit-card statement balance");
    if (statement.minimumPayment !== null) exact(statement.minimumPayment, "Credit-card statement minimum payment");
    requireOccurrence(statement.evidenceSourceOccurrenceKey, "Credit-card statement evidence");
    for (const key of statement.transactionSourceOccurrenceKeys) {
      if (!transactionKeys.has(key)) fail("missing-reference", `Credit-card statement transaction is missing: ${key}.`);
    }
  }
  for (const relation of request.relations ?? []) {
    valueText(relation.kind, "Credit-card relation kind");
    if (!transactionKeys.has(relation.fromSourceOccurrenceKey) || !transactionKeys.has(relation.toSourceOccurrenceKey)) fail("missing-reference", "Credit-card relation endpoint is missing.");
    requireOccurrence(relation.evidenceSourceOccurrenceKey, "Credit-card relation evidence");
  }
  if (request.balance) validateBalance(request.balance.observation, request.balance.estimate, occurrenceKeys);
}

function validateBalance(observation: PGliteCanonicalBalanceObservationInput, estimate: PGliteCanonicalCreditCardBalanceEstimate, occurrenceKeys: ReadonlySet<string>): void {
  if (observation.balanceKind !== "credit_used") fail("invalid-contract", "Credit-card balance must use credit_used.");
  if (!occurrenceKeys.has(observation.sourceOccurrenceKey)) fail("missing-reference", "Credit-card balance source occurrence is absent.");
  if (estimate.kind !== "estimate" || !valueText(estimate.formula, "Credit-card estimate formula")) fail("invalid-contract", "Credit-card estimate is invalid.");
  if (estimate.basis !== "provider-used-credit" && estimate.basis !== "credit-limit-minus-available") fail("invalid-contract", "Credit-card estimate basis is unsupported.");
  if ((estimate.limit === undefined) !== (estimate.available === undefined)) fail("invalid-contract", "Credit-card estimate components must be paired.");
  if (estimate.limit) exact(estimate.limit, "Credit-card estimate limit");
  if (estimate.available) exact(estimate.available, "Credit-card estimate available");
}

function occurrenceGroupKey(scopeKey: string, partitionDate: string, fingerprint: string): string {
  return JSON.stringify([scopeKey, partitionDate, fingerprint]);
}

/**
 * Per occurrence group, the billed members a prior capture of this contract
 * located in a bucket that promises Billed Monotonicity and that this capture
 * queried again (ADR 0062). Read before admission, which relocates them.
 * A member's billing status is its transaction's latest lifecycle status.
 */
async function listExpectedBilledMembers(
  transaction: PGliteTransaction,
  request: PGliteCanonicalCreditCardCaptureRequest,
): Promise<ReadonlyMap<string, number>> {
  const { capture } = request;
  // Current used-credit observations carry no billing-history inventory.
  if (capture.recordKind === "credit-card-current-used-credit" && request.transactions.length === 0) return new Map();
  const coverage = capture.occurrenceGroupCoverage;
  if (!Array.isArray(coverage) || coverage.length === 0
    || coverage.some((entry) => !Array.isArray(entry.bucketKeys) || entry.bucketKeys.length === 0))
    fail("invalid-contract", "Credit-card capture requires complete queried-bucket inventory.");
  const sourceSubjectId = await findPGliteSourceSubjectId(transaction, capture);
  if (!sourceSubjectId) return new Map();
  const expected: Array<{ groupKey: string; transactionId: string }> = [];
  for (const entry of coverage) {
    for (const occurrence of await listPGliteExpectedOccurrences(transaction, sourceSubjectId, capture.recordKind, entry))
      if (occurrence.transactionId !== null && promisesBilledMonotonicity(decodeCreditCardQueryBucket(occurrence.bucketKey)))
        expected.push({
          groupKey: occurrenceGroupKey(entry.scopeKey, occurrence.partitionDate, occurrence.fingerprint),
          transactionId: occurrence.transactionId,
        });
  }
  if (expected.length === 0) return new Map();
  const latest = await listLatestLifecycle(transaction, expected.map((occurrence) => occurrence.transactionId));
  const billedByGroup = new Map<string, number>();
  for (const occurrence of expected)
    if (latest.get(occurrence.transactionId)?.billingStatus === "billed")
      billedByGroup.set(occurrence.groupKey, (billedByGroup.get(occurrence.groupKey) ?? 0) + 1);
  return billedByGroup;
}

type LatestLifecycle = Readonly<{ billingStatus: "billed" | "unbilled"; instrumentKey: string; direction: string }>;

/**
 * Each transaction's latest lifecycle row: the one written by the latest
 * commit, by commit sequence. It is read by transaction rather than through a
 * Source Record copy, so it holds when the latest copy has no lifecycle row of
 * its own: a new copy whose lifecycle row was skipped as unchanged (ADR 0152). A transaction without a
 * lifecycle row is absent from the result.
 */
async function listLatestLifecycle(
  transaction: PGliteTransaction,
  transactionIds: readonly string[],
): Promise<ReadonlyMap<string, LatestLifecycle>> {
  const ids = [...new Set(transactionIds)];
  if (ids.length === 0) return new Map();
  const rows = await query<{ transaction_id: unknown; billing_status: "billed" | "unbilled"; instrument_key: string; direction: string }>(transaction, `
    SELECT DISTINCT ON (lifecycle.transaction_id)
      lifecycle.transaction_id, lifecycle.billing_status, instrument.instrument_key, revision.direction
    FROM canonical_credit_card_transaction_lifecycle lifecycle
    JOIN canonical_credit_card_instruments instrument ON instrument.instrument_id = lifecycle.instrument_id
    JOIN transaction_revisions revision ON revision.revision_id = lifecycle.revision_id
    JOIN source_captures source_capture ON source_capture.capture_id = lifecycle.capture_id
    JOIN canonical_commits commit_row ON commit_row.commit_id = source_capture.commit_id
    WHERE lifecycle.transaction_id IN (${ids.map(() => "?").join(",")})
    ORDER BY lifecycle.transaction_id, commit_row.commit_sequence DESC, lifecycle.lifecycle_event_id DESC`,
  ids.map((id) => bytes(id)));
  return new Map(rows.map((row) => [idText(row.transaction_id), {
    billingStatus: row.billing_status,
    instrumentKey: row.instrument_key,
    direction: row.direction,
  }]));
}

/**
 * Billed Monotonicity: an expected billed member may not revert to unbilled.
 * An unbilled member appearing beside billed ones is not a violation, and a
 * member that vanished is the generic continuity guard's loss, which admission
 * reports before this runs.
 */
function assertBilledMonotonicity(
  expectedBilled: ReadonlyMap<string, number>,
  request: PGliteCanonicalCreditCardCaptureRequest,
): void {
  const groupsByOccurrence = new Map(request.capture.records.map((record) => [record.occurrenceKey, record.occurrenceGroup]));
  const currentBilled = new Map<string, number>();
  for (const fact of request.transactions) {
    const group = groupsByOccurrence.get(fact.sourceOccurrenceKey);
    if (!group || fact.billingStatus !== "billed") continue;
    const key = occurrenceGroupKey(group.scopeKey, group.partitionDate, group.fingerprint);
    currentBilled.set(key, (currentBilled.get(key) ?? 0) + 1);
  }
  for (const [key, count] of expectedBilled)
    if ((currentBilled.get(key) ?? 0) < count)
      fail("revision-conflict", "Complete credit-card occurrence groups cannot reduce their billed member count.");
}

type VanishedUnbilledMember = Readonly<{ transactionId: string; direction: string; instrumentKey: string }>;
type AppearedBilledMember = Readonly<{ occurrenceKey: string; direction: string }>;

type VanishedUnbilledResolution = Readonly<{
  supersessions: readonly PGliteCanonicalOccurrenceSupersessionInput[];
  withdrawals: readonly PGliteCanonicalOccurrenceWithdrawalInput[];
}>;

/**
 * Resolve each unbilled transaction that vanished from a complete capture.
 *
 * The issuer may rewrite merchant text or finalize an amount at posting,
 * which changes the occurrence key. A vanished member is paired with the
 * billed transaction that replaced it on instrument, consume date, statement
 * membership and direction; only an exactly one-to-one pairing is evidence
 * (ADR 0040).
 *
 * An unpaired member may instead have been cancelled before billing. Its
 * absence withdraws its source support only while its card is still listed
 * and no billed transaction new to this capture shares its consume date;
 * any such row could be its continuation, so the guard keeps rejecting the
 * loss rather than guessing.
 */
async function resolveVanishedUnbilledMembers(
  transaction: PGliteTransaction,
  request: PGliteCanonicalCreditCardCaptureRequest,
): Promise<VanishedUnbilledResolution> {
  const none = { supersessions: [], withdrawals: [] };
  const { capture } = request;
  if (request.transactions.length === 0) return none;
  if (capture.scope.kind !== "bounded-range" || capture.scope.completeness !== "complete-range") return none;
  const sourceSubjectId = await findPGliteSourceSubjectId(transaction, capture);
  if (!sourceSubjectId) return none;
  const currentKeys = new Set(capture.records.map((record) => record.occurrenceKey));
  const vanished: Array<{ scopeKey: string; transactionId: string; partitionDate: string }> = [];
  for (const entry of capture.occurrenceGroupCoverage ?? []) {
    const expected = await listPGliteExpectedOccurrences(transaction, sourceSubjectId, capture.recordKind, entry);
    for (const occurrence of expected) {
      if (occurrence.transactionId === null || currentKeys.has(occurrence.occurrenceKey)) continue;
      vanished.push({ scopeKey: entry.scopeKey, transactionId: occurrence.transactionId, partitionDate: occurrence.partitionDate });
    }
  }
  if (vanished.length === 0) return none;

  const priorByTransaction = await listLatestLifecycle(transaction, vanished.map((member) => member.transactionId));
  const pairKey = (scopeKey: string, instrumentKey: string, partitionDate: string): string =>
    JSON.stringify([scopeKey, instrumentKey, partitionDate]);
  const dateKey = (scopeKey: string, partitionDate: string): string => JSON.stringify([scopeKey, partitionDate]);
  const vanishedUnbilled = new Map<string, Readonly<{ scopeKey: string; partitionDate: string; members: VanishedUnbilledMember[] }>>();
  for (const member of vanished) {
    const prior = priorByTransaction.get(member.transactionId);
    if (!prior || prior.billingStatus !== "unbilled") continue;
    const key = pairKey(member.scopeKey, prior.instrumentKey, member.partitionDate);
    const entry = vanishedUnbilled.get(key) ?? { scopeKey: member.scopeKey, partitionDate: member.partitionDate, members: [] };
    entry.members.push({ transactionId: member.transactionId, direction: prior.direction, instrumentKey: prior.instrumentKey });
    vanishedUnbilled.set(key, entry);
  }
  if (vanishedUnbilled.size === 0) return none;

  const seenBefore = new Set((await query<{ occurrence_key: string }>(transaction, `
    SELECT occurrence_key FROM source_records
    WHERE source_subject_id = ? AND occurrence_key IN (${[...currentKeys].map(() => "?").join(",")})`,
  [sourceSubjectId, ...currentKeys])).map((row) => row.occurrence_key));
  const statementMembers = new Set(request.statements.flatMap((statement) => statement.transactionSourceOccurrenceKeys));
  const recordsByOccurrence = new Map(capture.records.map((record) => [record.occurrenceKey, record]));
  const appearedBilled = new Map<string, AppearedBilledMember[]>();
  const newBilledDates = new Set<string>();
  for (const fact of request.transactions) {
    const group = recordsByOccurrence.get(fact.sourceOccurrenceKey)?.occurrenceGroup;
    if (!group || fact.billingStatus !== "billed" || seenBefore.has(fact.sourceOccurrenceKey)) continue;
    newBilledDates.add(dateKey(group.scopeKey, group.partitionDate));
    if (!statementMembers.has(fact.sourceOccurrenceKey)) continue;
    const key = pairKey(group.scopeKey, fact.instrumentKey, group.partitionDate);
    appearedBilled.set(key, [...(appearedBilled.get(key) ?? []), { occurrenceKey: fact.sourceOccurrenceKey, direction: fact.direction }]);
  }
  const listedInstruments = new Set(request.instruments.map((instrument) => instrument.instrumentKey));
  const supersessions: PGliteCanonicalOccurrenceSupersessionInput[] = [];
  const withdrawals: PGliteCanonicalOccurrenceWithdrawalInput[] = [];
  for (const [key, { scopeKey, partitionDate, members }] of vanishedUnbilled) {
    const successors = appearedBilled.get(key) ?? [];
    if (members.length === 1 && successors.length === 1 && members[0]!.direction === successors[0]!.direction) {
      supersessions.push({ withdrawnTransactionId: members[0]!.transactionId, successorOccurrenceKey: successors[0]!.occurrenceKey });
      continue;
    }
    if (newBilledDates.has(dateKey(scopeKey, partitionDate))) continue;
    for (const member of members)
      if (listedInstruments.has(member.instrumentKey)) withdrawals.push({ withdrawnTransactionId: member.transactionId });
  }
  return { supersessions, withdrawals };
}

/**
 * A transaction withdrawn because its billed successor replaced it (ADR 0040)
 * cannot be listed again: the successor already carries that purchase.
 */
async function assertSupersededMembersStayReplaced(
  transaction: PGliteTransaction,
  request: PGliteCanonicalCreditCardCaptureRequest,
): Promise<void> {
  const keys = request.capture.records.map((record) => record.occurrenceKey);
  if (keys.length === 0) return;
  const sourceSubjectId = await findPGliteSourceSubjectId(transaction, request.capture);
  if (!sourceSubjectId) return;
  const replaced = await first<{ transaction_id: unknown }>(transaction, `
    SELECT assertion.transaction_id
    FROM source_records source_record
    JOIN assertion_provenance provenance ON provenance.source_record_id = source_record.source_record_id
    JOIN assertions assertion ON assertion.assertion_id = provenance.assertion_id
    JOIN canonical_credit_card_relations relation
      ON relation.from_transaction_id = assertion.transaction_id AND relation.relation_kind = 'unbilled_to_billed'
    WHERE source_record.source_subject_id = ? AND source_record.occurrence_key IN (${keys.map(() => "?").join(",")})
      AND assertion.origin = 'source' AND assertion.field_name = 'transaction_revision'
    LIMIT 1`, [sourceSubjectId, ...keys]);
  if (replaced) fail("revision-conflict", "A credit-card transaction replaced by its billed successor was listed again.");
}

async function query<T>(transaction: PGliteTransaction, sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
  let index = 0;
  return (await transaction.query<T>(sql.replace(/\?/gu, () => `$${++index}`), params)).rows;
}

async function first<T>(transaction: PGliteTransaction, sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
  return (await query<T>(transaction, sql, params))[0];
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return Uint8Array.from(value);
  const hex = String(value).replace(/^\\x/u, "").replaceAll("-", "");
  if (/^[0-9a-f]{32}$/iu.test(hex)) return Uint8Array.from(Buffer.from(hex, "hex"));
  throw new Error("PGlite credit-card identity is not a UUID.");
}

function idText(value: unknown): string {
  const hex = Buffer.from(bytes(value)).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase();
}

async function persistIdentity(transaction: PGliteTransaction, namespace: string, accountId: Uint8Array, captureId: Uint8Array, identity: PGliteCanonicalCreditCardIdentity): Promise<void> {
  const existing = await first<{ opaque_identity_key: string; identity_method: string }>(transaction, `SELECT opaque_identity_key, identity_method
    FROM canonical_credit_card_account_identities
    WHERE integration_namespace = ? AND account_id = ?`, [namespace, accountId]);
  if (existing && (existing.opaque_identity_key !== identity.accountNaturalKey || existing.identity_method !== identity.identityMethod)) fail("identity-conflict", "Credit-card account identity changed inside one authority scope.");
  if (!existing)
    await query(transaction, `INSERT INTO canonical_credit_card_account_identities(
      integration_namespace, account_id, opaque_identity_key, identity_method, created_capture_id
    ) VALUES (?, ?, ?, ?, ?)`, [namespace, accountId, identity.accountNaturalKey, identity.identityMethod, captureId]);
}

/** A card details row as a commit compares it with the latest stored one; ids are hex. */
type CardDetails = Readonly<{
  revisionId: string;
  instrumentId: string;
  billingStatus: string;
  consumeDate: string | null;
  postingDate: string | null;
  effectiveDateBasis: string | null;
  statementKey: string | null;
}>;

/** A card lifecycle row as a commit compares it with the latest stored one; ids are hex. */
type CardLifecycle = Readonly<{
  revisionId: string;
  instrumentId: string;
  billingStatus: string;
  statementKey: string | null;
}>;

function cardDetails(input: PGliteCanonicalCreditCardTransaction, revisionId: string, instrumentId: string): CardDetails {
  return {
    revisionId,
    instrumentId,
    billingStatus: input.billingStatus,
    consumeDate: input.consumeDate ?? null,
    postingDate: input.postingDate ?? null,
    effectiveDateBasis: input.effectiveDateBasis ?? null,
    statementKey: input.statementKey ?? null,
  };
}

function cardLifecycle(input: PGliteCanonicalCreditCardTransaction, revisionId: string, instrumentId: string): CardLifecycle {
  return { revisionId, instrumentId, billingStatus: input.billingStatus, statementKey: input.statementKey ?? null };
}

const sameDetails = (stored: CardDetails | null, desired: CardDetails): boolean =>
  stored !== null &&
  stored.revisionId === desired.revisionId &&
  stored.instrumentId === desired.instrumentId &&
  stored.billingStatus === desired.billingStatus &&
  stored.consumeDate === desired.consumeDate &&
  stored.postingDate === desired.postingDate &&
  stored.effectiveDateBasis === desired.effectiveDateBasis &&
  stored.statementKey === desired.statementKey;

const sameLifecycle = (stored: CardLifecycle | null, desired: CardLifecycle): boolean =>
  stored !== null &&
  stored.revisionId === desired.revisionId &&
  stored.instrumentId === desired.instrumentId &&
  stored.billingStatus === desired.billingStatus &&
  stored.statementKey === desired.statementKey;

type StoredCardTransaction = Readonly<{
  latestRevisionId: string;
  details: CardDetails | null;
  lifecycle: CardLifecycle | null;
}>;

/**
 * The latest stored card rows of an account, read before admission. A commit
 * writes a card row only where it differs from these (ADR 0152). The latest
 * row of a key is the one written by the highest commit sequence, as
 * listLatestLifecycle reads it.
 */
type StoredCardRows = Readonly<{
  /** Instrument id by instrument key. */
  instrumentIds: ReadonlyMap<string, string>;
  /** The occurrence key of each instrument's latest evidence, by instrument id. */
  instrumentEvidence: ReadonlyMap<string, string>;
  /** By source sequence. */
  transactions: ReadonlyMap<string, StoredCardTransaction>;
  /** Statement revision id by statement key and revision key. */
  statementRevisionIds: ReadonlyMap<string, string>;
  /** The statement revision of each statement's latest summary evidence, by statement key. */
  statementSummaries: ReadonlyMap<string, string>;
}>;

const statementRevisionKey = (statementKey: string, revisionKey: string): string => JSON.stringify([statementKey, revisionKey]);
const hex = (value: unknown): string => Buffer.from(bytes(value)).toString("hex");
const nullableText = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

async function readStoredCardRows(
  transaction: PGliteTransaction,
  request: PGliteCanonicalCreditCardCaptureRequest,
): Promise<StoredCardRows> {
  const stored = {
    instrumentIds: new Map<string, string>(),
    instrumentEvidence: new Map<string, string>(),
    transactions: new Map<string, StoredCardTransaction>(),
    statementRevisionIds: new Map<string, string>(),
    statementSummaries: new Map<string, string>(),
  };
  const accountId = await findPGliteFinancialAccountId(transaction, request.capture, request.account.sourceAccountKey);
  if (!accountId) return stored;
  const namespace = request.capture.integrationNamespace;
  if (request.instruments.length > 0)
    for (const row of await query<{ instrument_key: string; instrument_id: unknown; evidence_key: string | null }>(transaction, `
      SELECT instrument.instrument_key, instrument.instrument_id, evidence.occurrence_key AS evidence_key
      FROM canonical_credit_card_instruments instrument
      LEFT JOIN LATERAL (
        SELECT source_record.occurrence_key
        FROM canonical_credit_card_instrument_evidence evidence
        JOIN source_records source_record ON source_record.source_record_id = evidence.source_record_id
        JOIN source_captures source_capture ON source_capture.capture_id = evidence.capture_id
        JOIN canonical_commits commit_row ON commit_row.commit_id = source_capture.commit_id
        WHERE evidence.instrument_id = instrument.instrument_id
        ORDER BY commit_row.commit_sequence DESC, evidence.source_record_id DESC
        LIMIT 1
      ) evidence ON TRUE
      WHERE instrument.integration_namespace = ? AND instrument.account_id = ?`, [namespace, accountId])) {
      stored.instrumentIds.set(row.instrument_key, hex(row.instrument_id));
      if (row.evidence_key !== null) stored.instrumentEvidence.set(hex(row.instrument_id), row.evidence_key);
    }
  if (request.transactions.length > 0)
    for (const row of await query<Record<string, unknown>>(transaction, `
      SELECT financial.source_sequence, latest_revision.revision_id AS latest_revision_id,
        details.revision_id AS details_revision_id, details.instrument_id AS details_instrument_id,
        details.billing_status AS details_billing_status, details.consume_date, details.posting_date,
        details.effective_date_basis, details.statement_key AS details_statement_key,
        lifecycle.revision_id AS lifecycle_revision_id, lifecycle.instrument_id AS lifecycle_instrument_id,
        lifecycle.billing_status AS lifecycle_billing_status, lifecycle.statement_key AS lifecycle_statement_key
      FROM financial_transactions financial
      JOIN LATERAL (
        SELECT revision.revision_id FROM transaction_revisions revision
        WHERE revision.transaction_id = financial.transaction_id
        ORDER BY revision.revision_number DESC
        LIMIT 1
      ) latest_revision ON TRUE
      LEFT JOIN LATERAL (
        SELECT detail.* FROM transaction_revisions revision
        JOIN canonical_credit_card_transaction_details detail ON detail.revision_id = revision.revision_id
        JOIN source_captures source_capture ON source_capture.capture_id = detail.capture_id
        JOIN canonical_commits commit_row ON commit_row.commit_id = source_capture.commit_id
        WHERE revision.transaction_id = financial.transaction_id
        ORDER BY commit_row.commit_sequence DESC, detail.source_record_id DESC
        LIMIT 1
      ) details ON TRUE
      LEFT JOIN LATERAL (
        SELECT lifecycle.* FROM canonical_credit_card_transaction_lifecycle lifecycle
        JOIN source_captures source_capture ON source_capture.capture_id = lifecycle.capture_id
        JOIN canonical_commits commit_row ON commit_row.commit_id = source_capture.commit_id
        WHERE lifecycle.integration_namespace = ? AND lifecycle.account_id = financial.account_id
          AND lifecycle.transaction_id = financial.transaction_id
        ORDER BY commit_row.commit_sequence DESC, lifecycle.lifecycle_event_id DESC
        LIMIT 1
      ) lifecycle ON TRUE
      WHERE financial.account_id = ?
        AND financial.source_sequence IN (SELECT jsonb_array_elements_text(?::jsonb))`,
    [namespace, accountId, JSON.stringify(request.transactions.map((fact) => fact.sourceSequence))])) {
      stored.transactions.set(String(row.source_sequence), {
        latestRevisionId: hex(row.latest_revision_id),
        details: row.details_revision_id === null ? null : {
          revisionId: hex(row.details_revision_id),
          instrumentId: hex(row.details_instrument_id),
          billingStatus: String(row.details_billing_status),
          consumeDate: nullableText(row.consume_date),
          postingDate: nullableText(row.posting_date),
          effectiveDateBasis: nullableText(row.effective_date_basis),
          statementKey: nullableText(row.details_statement_key),
        },
        lifecycle: row.lifecycle_revision_id === null ? null : {
          revisionId: hex(row.lifecycle_revision_id),
          instrumentId: hex(row.lifecycle_instrument_id),
          billingStatus: String(row.lifecycle_billing_status),
          statementKey: nullableText(row.lifecycle_statement_key),
        },
      });
    }
  if (request.statements.length > 0)
    for (const row of await query<{ statement_key: string; revision_key: string; statement_revision_id: unknown; summary_revision_id: unknown }>(transaction, `
      SELECT statement.statement_key, revision.revision_key, revision.statement_revision_id,
        summary.statement_revision_id AS summary_revision_id
      FROM canonical_credit_card_statements statement
      JOIN canonical_credit_card_statement_revisions revision ON revision.statement_id = statement.statement_id
      LEFT JOIN LATERAL (
        SELECT evidence.statement_revision_id
        FROM canonical_credit_card_statement_revisions any_revision
        JOIN canonical_credit_card_statement_summary_evidence evidence
          ON evidence.statement_revision_id = any_revision.statement_revision_id
        JOIN source_captures source_capture ON source_capture.capture_id = evidence.capture_id
        JOIN canonical_commits commit_row ON commit_row.commit_id = source_capture.commit_id
        WHERE any_revision.statement_id = statement.statement_id
        ORDER BY commit_row.commit_sequence DESC, evidence.evidence_source_record_id DESC
        LIMIT 1
      ) summary ON TRUE
      WHERE statement.integration_namespace = ? AND statement.account_id = ?
        AND statement.statement_key IN (SELECT jsonb_array_elements_text(?::jsonb))`,
    [namespace, accountId, JSON.stringify(request.statements.map((statement) => statement.statementKey))])) {
      stored.statementRevisionIds.set(statementRevisionKey(row.statement_key, row.revision_key), hex(row.statement_revision_id));
      if (row.summary_revision_id !== null) stored.statementSummaries.set(row.statement_key, hex(row.summary_revision_id));
    }
  return stored;
}

const instrumentEvidenceChanged = (stored: StoredCardRows, instrumentId: string | undefined, input: PGliteCanonicalCreditCardInstrument): boolean =>
  instrumentId === undefined || stored.instrumentEvidence.get(instrumentId) !== input.evidenceSourceOccurrenceKey;

/** A statement revision names its evidence occurrence and may not change it, so the revision decides the summary. */
const statementSummaryChanged = (stored: StoredCardRows, statementRevisionId: string | undefined, input: PGliteCanonicalCreditCardStatement): boolean =>
  statementRevisionId === undefined || stored.statementSummaries.get(input.statementKey) !== statementRevisionId;

/**
 * The occurrences this commit's own card rows will cite, decided before any
 * record is stored, so every other record may be reused (ADR 0152). Each
 * row is compared with the latest stored one under the ids the store already
 * holds; an id the commit has yet to create, such as a new revision, makes
 * the row differ.
 */
function plannedCardCitations(
  request: PGliteCanonicalCreditCardCaptureRequest,
  stored: StoredCardRows,
  supersessions: readonly PGliteCanonicalOccurrenceSupersessionInput[],
): ReadonlySet<string> {
  const cited = new Set<string>();
  for (const input of request.instruments)
    if (instrumentEvidenceChanged(stored, stored.instrumentIds.get(input.instrumentKey), input))
      cited.add(input.evidenceSourceOccurrenceKey);
  for (const input of request.transactions) {
    const prior = stored.transactions.get(input.sourceSequence);
    const instrumentId = stored.instrumentIds.get(input.instrumentKey);
    if (!prior || instrumentId === undefined ||
      !sameDetails(prior.details, cardDetails(input, prior.latestRevisionId, instrumentId)) ||
      !sameLifecycle(prior.lifecycle, cardLifecycle(input, prior.latestRevisionId, instrumentId)))
      cited.add(input.sourceOccurrenceKey);
  }
  for (const input of request.statements)
    if (statementSummaryChanged(stored, stored.statementRevisionIds.get(statementRevisionKey(input.statementKey, input.revisionKey)), input))
      cited.add(input.evidenceSourceOccurrenceKey);
  for (const relation of request.relations ?? []) cited.add(relation.evidenceSourceOccurrenceKey);
  for (const supersession of supersessions) cited.add(supersession.successorOccurrenceKey);
  return cited;
}

type SharedTransaction = Readonly<{
  transactionId: Uint8Array;
  revisionId: Uint8Array;
  sourceRecordId: Uint8Array;
  captureSourceRecordId: Uint8Array;
}>;

async function sharedTransactions(
  transaction: PGliteTransaction,
  accountId: Uint8Array,
  captureId: Uint8Array,
  transactions: readonly PGliteCanonicalCreditCardTransaction[],
  genericResults: readonly { sourceSequence: string; sourceOccurrenceKey: string; transactionId: string; revisionId: string }[],
  sourceRecordByOccurrence: ReadonlyMap<string, Uint8Array>,
): Promise<Map<string, SharedTransaction>> {
  const result = new Map<string, SharedTransaction>();
  for (const input of transactions) {
    const generic = genericResults.find((candidate) => candidate.sourceOccurrenceKey === input.sourceOccurrenceKey);
    if (!generic) fail("missing-reference", `Credit-card transaction was not admitted: ${input.sourceOccurrenceKey}.`);
    const row = await first<{ source_record_id: unknown }>(transaction, `SELECT source_record_id
      FROM transaction_revisions WHERE revision_id = ?`, [bytes(generic.revisionId)]);
    const captureSourceRecordId = sourceRecordByOccurrence.get(input.sourceOccurrenceKey);
    if (!row?.source_record_id || !captureSourceRecordId) fail("missing-reference", `Credit-card transaction evidence is missing: ${input.sourceOccurrenceKey}.`);
    result.set(input.sourceOccurrenceKey, {
      transactionId: bytes(generic.transactionId),
      revisionId: bytes(generic.revisionId),
      sourceRecordId: bytes(row.source_record_id),
      captureSourceRecordId,
    });
  }
  return result;
}

/**
 * Write the command's own rows. An instrument evidence, transaction details,
 * lifecycle or statement summary row is written only where it differs from
 * the latest stored one (ADR 0152), and a row written now cites a record
 * this capture stored, as plannedCardCitations arranged.
 */
async function persistExtensions(
  transaction: PGliteTransaction,
  request: PGliteCanonicalCreditCardCaptureRequest,
  admitted: PGliteAdmittedFinancialCapture,
  stored: StoredCardRows,
): Promise<{ instrumentCount: number; statementCount: number; balanceRevisionCreated: boolean }> {
  const namespace = request.capture.integrationNamespace;
  const { accountId, capture } = admitted;
  const { captureId, sourceRecordIdsByOccurrence: sourceRecordByOccurrence } = capture;
  const cites = (sourceRecordId: Uint8Array, row: string): Uint8Array => {
    assertPGliteStoredByThisCapture(capture, sourceRecordId, row);
    return sourceRecordId;
  };
  await persistIdentity(transaction, namespace, accountId, captureId, request.identity);
  const transactionMap = await sharedTransactions(transaction, accountId, captureId, request.transactions, admitted.result.transactions, sourceRecordByOccurrence);
  const instruments = new Map<string, Uint8Array>();
  for (const input of request.instruments) {
    const evidence = sourceRecordByOccurrence.get(input.evidenceSourceOccurrenceKey);
    if (!evidence) fail("missing-reference", `Credit-card instrument evidence is missing: ${input.instrumentKey}.`);
    const existing = await first<{ instrument_id: unknown; card_mask: string | null; role: string; lifecycle: string | null }>(transaction, `SELECT instrument_id, card_mask, role, lifecycle
      FROM canonical_credit_card_instruments
      WHERE integration_namespace = ? AND account_id = ? AND instrument_key = ?`, [namespace, accountId, input.instrumentKey]);
    const cardMask = input.cardMask ?? null;
    const lifecycle = input.lifecycle ?? null;
    if (existing && (existing.card_mask !== cardMask || existing.role !== input.role || existing.lifecycle !== lifecycle)) fail("identity-conflict", "Credit-card instrument key was reused with changed authority data.");
    const instrumentId = existing?.instrument_id ? bytes(existing.instrument_id) : uuidBytes();
    if (!existing)
      await query(transaction, `INSERT INTO canonical_credit_card_instruments(
        instrument_id, integration_namespace, account_id, instrument_key, card_mask, role, lifecycle
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`, [instrumentId, namespace, accountId, input.instrumentKey, cardMask, input.role, lifecycle]);
    if (instrumentEvidenceChanged(stored, hex(instrumentId), input))
      await query(transaction, `INSERT INTO canonical_credit_card_instrument_evidence(
        instrument_id, integration_namespace, account_id, capture_id, source_record_id
      ) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [instrumentId, namespace, accountId, captureId, cites(evidence, "credit-card instrument evidence")]);
    instruments.set(input.instrumentKey, instrumentId);
  }
  for (const input of request.transactions) {
    const shared = transactionMap.get(input.sourceOccurrenceKey);
    const instrumentId = instruments.get(input.instrumentKey);
    if (!shared || !instrumentId) fail("missing-reference", `Credit-card transaction instrument is missing: ${input.instrumentKey}.`);
    const prior = stored.transactions.get(input.sourceSequence);
    if (!sameDetails(prior?.details ?? null, cardDetails(input, hex(shared.revisionId), hex(instrumentId))))
      await query(transaction, `INSERT INTO canonical_credit_card_transaction_details(
        integration_namespace, account_id, transaction_id, revision_id, source_record_id,
        capture_id, instrument_id, billing_status, consume_date, posting_date,
        effective_date_basis, statement_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [
        namespace, accountId, shared.transactionId, shared.revisionId,
        cites(shared.captureSourceRecordId, "credit-card transaction details"), captureId,
        instrumentId, input.billingStatus, input.consumeDate ?? null, input.postingDate ?? null,
        input.effectiveDateBasis ?? null, input.statementKey ?? null,
      ]);
    if (!sameLifecycle(prior?.lifecycle ?? null, cardLifecycle(input, hex(shared.revisionId), hex(instrumentId))))
      await query(transaction, `INSERT INTO canonical_credit_card_transaction_lifecycle(
        lifecycle_event_id, integration_namespace, account_id, transaction_id, revision_id,
        source_record_id, capture_id, instrument_id, billing_status, statement_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [
        uuidBytes(), namespace, accountId, shared.transactionId, shared.revisionId,
        cites(shared.captureSourceRecordId, "a credit-card lifecycle row"),
        captureId, instrumentId, input.billingStatus, input.statementKey ?? null,
      ]);
  }
  for (const input of request.statements) {
    const evidence = sourceRecordByOccurrence.get(input.evidenceSourceOccurrenceKey);
    if (!evidence) fail("missing-reference", `Credit-card statement evidence is missing: ${input.statementKey}.`);
    const statementIdRow = await first<{ statement_id: unknown }>(transaction, `SELECT statement_id
      FROM canonical_credit_card_statements WHERE integration_namespace = ? AND account_id = ? AND statement_key = ?`, [namespace, accountId, input.statementKey]);
    const statementId = statementIdRow?.statement_id ? bytes(statementIdRow.statement_id) : uuidBytes();
    if (!statementIdRow)
      await query(transaction, `INSERT INTO canonical_credit_card_statements(
        statement_id, integration_namespace, account_id, statement_key
      ) VALUES (?, ?, ?, ?)`, [statementId, namespace, accountId, input.statementKey]);
    const existing = await first<Record<string, unknown>>(transaction, `SELECT * FROM canonical_credit_card_statement_revisions
      WHERE statement_id = ? AND revision_key = ?`, [statementId, input.revisionKey]);
    const desired = input.transactionSourceOccurrenceKeys.map((key) => transactionMap.get(key));
    if (desired.some((entry) => !entry)) fail("missing-reference", `Credit-card statement member is missing: ${input.statementKey}.`);
    if (existing) {
      const same = existing.cycle_start === input.cycleStart && existing.cycle_end === input.cycleEnd && existing.issue_date === input.issueDate && existing.due_date === input.dueDate && existing.currency === input.currency && existing.balance_coefficient === input.balance.coefficient && Number(existing.balance_scale) === input.balance.scale && (existing.minimum_coefficient ?? null) === (input.minimumPayment?.coefficient ?? null) && Number(existing.minimum_scale ?? -1) === (input.minimumPayment?.scale ?? -1) && existing.evidence_source_record_key === input.evidenceSourceOccurrenceKey;
      if (!same) fail("revision-conflict", "Credit-card statement revision key was reused with changed evidence.");
      const members = await query<{ transaction_id: unknown; transaction_revision_id: unknown }>(transaction, `SELECT transaction_id, transaction_revision_id
        FROM canonical_credit_card_statement_memberships WHERE statement_revision_id = ?`, [existing.statement_revision_id]);
      const storedKeys = members.map((row) => `${idText(row.transaction_id)}:${idText(row.transaction_revision_id)}`).sort();
      const desiredKeys = (desired as SharedTransaction[]).map((member) => `${idText(member.transactionId)}:${idText(member.revisionId)}`).sort();
      if (JSON.stringify(storedKeys) !== JSON.stringify(desiredKeys)) fail("revision-conflict", "Credit-card statement revision membership changed.");
    } else {
      const revisionId = uuidBytes();
      const latest = await first<{ n: number | string }>(transaction, "SELECT COALESCE(MAX(revision_number), 0) AS n FROM canonical_credit_card_statement_revisions WHERE statement_id = ?", [statementId]);
      await query(transaction, `INSERT INTO canonical_credit_card_statement_revisions(
        statement_revision_id, statement_id, revision_key, revision_number, created_capture_id,
        cycle_start, cycle_end, issue_date, due_date, currency, balance_coefficient,
        balance_scale, minimum_coefficient, minimum_scale, evidence_source_record_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        revisionId, statementId, input.revisionKey, Number(latest?.n ?? 0) + 1, captureId,
        input.cycleStart, input.cycleEnd, input.issueDate, input.dueDate, input.currency,
        input.balance.coefficient, input.balance.scale, input.minimumPayment?.coefficient ?? null,
        input.minimumPayment?.scale ?? null, input.evidenceSourceOccurrenceKey,
      ]);
      for (const member of desired as SharedTransaction[])
        await query(transaction, `INSERT INTO canonical_credit_card_statement_memberships(
          statement_revision_id, transaction_id, transaction_revision_id, source_record_id
        ) VALUES (?, ?, ?, ?)`, [revisionId, member.transactionId, member.revisionId, member.sourceRecordId]);
    }
    const revision = await first<{ statement_revision_id: unknown }>(transaction, `SELECT statement_revision_id
      FROM canonical_credit_card_statement_revisions WHERE statement_id = ? AND revision_key = ?`, [statementId, input.revisionKey]);
    if (!revision) throw new Error("Credit-card statement revision insert was not visible.");
    if (statementSummaryChanged(stored, hex(revision.statement_revision_id), input))
      await query(transaction, `INSERT INTO canonical_credit_card_statement_summary_evidence(
      statement_revision_id, integration_namespace, account_id, capture_id, evidence_key,
      evidence_source_record_id
    ) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [revision.statement_revision_id, namespace, accountId, captureId, input.evidenceSourceOccurrenceKey, cites(evidence, "credit-card statement summary evidence")]);
  }
  for (const relation of request.relations ?? []) {
    const from = transactionMap.get(relation.fromSourceOccurrenceKey);
    const to = transactionMap.get(relation.toSourceOccurrenceKey);
    const evidence = sourceRecordByOccurrence.get(relation.evidenceSourceOccurrenceKey);
    if (!from || !to || !evidence) fail("missing-reference", "Credit-card relation endpoint or evidence is missing.");
    await query(transaction, `INSERT INTO canonical_credit_card_relations(
      relation_id, integration_namespace, account_id, relation_kind, from_transaction_id,
      to_transaction_id, capture_id, evidence_source_record_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [uuidBytes(), namespace, accountId, relation.kind, from.transactionId, to.transactionId, captureId, cites(evidence, "a credit-card relation")]);
  }
  const balanceRevisionCreated = request.balance
    ? await persistBalanceEstimate(transaction, request.balance, accountId, captureId, sourceRecordByOccurrence)
    : false;
  return { instrumentCount: request.instruments.length, statementCount: request.statements.length, balanceRevisionCreated };
}

async function persistBalanceEstimate(
  transaction: PGliteTransaction,
  balance: NonNullable<PGliteCanonicalCreditCardCaptureRequest["balance"]>,
  accountId: Uint8Array,
  captureId: Uint8Array,
  sourceRecordByOccurrence: ReadonlyMap<string, Uint8Array>,
): Promise<boolean> {
  const sourceRecordId = sourceRecordByOccurrence.get(balance.observation.sourceOccurrenceKey);
  if (!sourceRecordId) fail("missing-reference", "Credit-card balance source record is missing.");
  const revision = await first<{ revision_id: unknown }>(transaction, `SELECT revision.revision_id
    FROM balance_observation_revisions revision
    JOIN balance_observations observation ON observation.observation_id = revision.observation_id
    WHERE observation.account_id = ? AND observation.observation_key = ?
      AND observation.balance_kind = 'credit_used' AND revision.effective_at = ?
    ORDER BY revision.revision_number DESC, revision.commit_id DESC LIMIT 1`, [accountId, balanceObservationKey(balance.observation), canonicalBalanceInstant(balance.observation.effectiveAt)]);
  if (!revision) throw new Error("Credit-card balance revision was not persisted.");
  const estimate = balance.estimate;
  const existing = await first<{ estimate_kind: string; estimate_basis: string; formula: string; component_limit_coefficient: string | null; component_limit_scale: number | string | null; component_available_coefficient: string | null; component_available_scale: number | string | null }>(transaction, "SELECT estimate_kind, estimate_basis, formula, component_limit_coefficient, component_limit_scale, component_available_coefficient, component_available_scale FROM credit_card_balance_estimate_details WHERE revision_id = ?", [revision.revision_id]);
  if (existing) {
    if (existing.estimate_kind !== estimate.kind || existing.estimate_basis !== estimate.basis || existing.formula !== estimate.formula || (existing.component_limit_coefficient ?? null) !== (estimate.limit?.coefficient ?? null) || Number(existing.component_limit_scale ?? -1) !== (estimate.limit?.scale ?? -1) || (existing.component_available_coefficient ?? null) !== (estimate.available?.coefficient ?? null) || Number(existing.component_available_scale ?? -1) !== (estimate.available?.scale ?? -1)) fail("revision-conflict", "Credit-card balance estimate was reused with changed evidence.");
    return false;
  }
  await query(transaction, `INSERT INTO credit_card_balance_estimate_details(
    revision_id, estimate_kind, estimate_basis, formula,
    component_limit_coefficient, component_limit_scale,
    component_available_coefficient, component_available_scale
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [revision.revision_id, estimate.kind, estimate.basis, estimate.formula, estimate.limit?.coefficient ?? null, estimate.limit?.scale ?? null, estimate.available?.coefficient ?? null, estimate.available?.scale ?? null]);
  return true;
}

/** A card commit also knows which Card identity secret derived its identities (ADR 0149). */
export type PGliteCanonicalCreditCardCommitOptions = PGliteCanonicalCommitOptions & Readonly<{
  cardIdentitySecret?: CardIdentitySecret;
  /**
   * @internal Test-only; no app path sets it.
   * `false` stores every record of the capture again, as before ADR 0152,
   * while card rows are still written only where they changed. The reuse
   * check compares a store built this way with one that reuses records.
   */
  reuseSourceRecords?: false;
}>;

export async function commitPGliteCanonicalCreditCardCapture(
  store: PGliteStore,
  request: PGliteCanonicalCreditCardCaptureRequest,
  options: PGliteCanonicalCreditCardCommitOptions = {},
): Promise<PGliteCanonicalCreditCardCommitResult> {
  const input = structuredClone(request);
  validateRequest(input);
  return store.transaction(async (transaction) => {
    const snapshot = input;
    if (await canonicalResetRequiredFor(transaction, snapshot.capture))
      fail("canonical-reset-required", "Credit-card accounts of a superseded identity epoch remain; a Canonical Reset must remove them first.");
    if (!await admitCardIdentitySecret(transaction, snapshot.capture.integrationNamespace, options.cardIdentitySecret))
      fail("canonical-reset-required", "Credit-card accounts derived from an earlier Card identity secret remain; a Canonical Reset must remove them first.");
    const expectedBilled = await listExpectedBilledMembers(transaction, snapshot);
    await assertSupersededMembersStayReplaced(transaction, snapshot);
    const { supersessions, withdrawals } = await resolveVanishedUnbilledMembers(transaction, snapshot);
    const stored = await readStoredCardRows(transaction, snapshot);
    const admitted = await admitPGliteCanonicalFinancialCaptureInTransaction(transaction, {
      capture: snapshot.capture,
      account: snapshot.account,
      transactions: snapshot.transactions,
      balanceObservations: snapshot.balance ? [snapshot.balance.observation] : [],
      requireExistingAccount: snapshot.requireExistingAccount ?? false,
      withdrawalPolicy: "never-infer",
      occurrenceSupersessions: supersessions,
      occurrenceWithdrawals: withdrawals,
    }, options, options.reuseSourceRecords === false ? "any" : plannedCardCitations(snapshot, stored, supersessions));
    assertBilledMonotonicity(expectedBilled, snapshot);
    const generic = admitted.result;
    const sourceRecordByOccurrence = admitted.capture.sourceRecordIdsByOccurrence;
    const extension = await persistExtensions(transaction, snapshot, admitted, stored);
    for (const supersession of supersessions) {
      const successor = generic.transactions.find((result) => result.sourceOccurrenceKey === supersession.successorOccurrenceKey);
      const evidence = sourceRecordByOccurrence.get(supersession.successorOccurrenceKey);
      if (!successor || !evidence) fail("missing-reference", "Credit-card supersession successor was not admitted.");
      assertPGliteStoredByThisCapture(admitted.capture, evidence, "a credit-card supersession relation");
      await query(transaction, `INSERT INTO canonical_credit_card_relations(
        relation_id, integration_namespace, account_id, relation_kind, from_transaction_id,
        to_transaction_id, capture_id, evidence_source_record_id
      ) VALUES (?, ?, ?, 'unbilled_to_billed', ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [
        uuidBytes(), snapshot.capture.integrationNamespace, admitted.accountId,
        bytes(supersession.withdrawnTransactionId), bytes(successor.transactionId), admitted.capture.captureId, evidence,
      ]);
    }
    await refreshPGliteAdmittedFinancialProjection(transaction, [admitted], options, { refreshEnrichmentAll: true });
    assertPGliteCanonicalCommitNotCancelled(options.signal);
    return {
      status: "committed" as const,
      captureId: snapshot.capture.captureId,
      accountId: idText(admitted.accountId),
      commitSequence: generic.commitSequence,
      transactionCount: snapshot.transactions.length,
      instrumentCount: extension.instrumentCount,
      statementCount: extension.statementCount,
      balanceRevisionCreated: extension.balanceRevisionCreated,
      withdrawnTransactionCount: withdrawals.length,
    };
  });
}

export async function commitPGliteCanonicalCreditCardBalanceCapture(
  store: PGliteStore,
  request: PGliteCanonicalCreditCardBalanceCaptureRequest,
  options: PGliteCanonicalCreditCardCommitOptions = {},
): Promise<PGliteCanonicalCreditCardCommitResult> {
  return commitPGliteCanonicalCreditCardCapture(store, {
    ...request,
    instruments: [],
    transactions: [],
    statements: [],
    requireExistingAccount: true,
  }, options);
}

