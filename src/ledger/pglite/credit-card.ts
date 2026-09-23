import { createHash, randomUUID } from "node:crypto";
import type {
  PGliteCanonicalBalanceObservationInput,
  PGliteCanonicalFinancialAccountInput,
  PGliteCanonicalFinancialFactInput,
  PGliteCanonicalSourceEvidence,
} from "./source-admission-validation.ts";
import {
  assertPGliteCanonicalCommitNotCancelled,
  commitPGliteCanonicalFinancialCaptureInTransaction,
  type PGliteCanonicalCommitOptions,
} from "./canonical-source-store.ts";
import { refreshPGliteCurrentProjectionInTransaction } from "./projection.ts";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";
import {
  PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND,
  PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND,
} from "./workflow-commands.ts";

export {
  PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND,
  PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND,
};

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
  /** Worker-local lookup reconciles Fubon unbilled-to-billed source identity. */
  reconcileLifecycle?: "fubon";
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

export type PGliteCanonicalCreditCardCommitCommand = Readonly<{
  kind: typeof PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND;
  request: PGliteCanonicalCreditCardCaptureRequest;
}>;

export type PGliteCanonicalCreditCardBalanceCommand = Readonly<{
  kind: typeof PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND;
  request: PGliteCanonicalCreditCardBalanceCaptureRequest;
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
}>;

export class PGliteCanonicalCreditCardAdmissionError extends Error {
  readonly code:
    | "invalid-contract"
    | "identity-conflict"
    | "revision-conflict"
    | "missing-reference";

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
  }
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

type FubonPriorLifecycle = Readonly<{
  transaction_id: unknown;
  source_sequence: string;
  occurrence_key: string;
  content_hash: string;
  payload_json: string;
  instrument_key: string;
  billing_status: "billed" | "unbilled";
  statement_key: string | null;
  consume_date: string | null;
  posting_date: string | null;
  amount_coefficient: string;
  amount_scale: number | string;
  currency: string;
  direction: string;
  description: string | null;
  original_amount_coefficient: string | null;
  original_amount_scale: number | string | null;
  original_currency: string | null;
}>;

function fubonCompact(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // A retained source payload with invalid JSON is an identity conflict.
  }
  fail("identity-conflict", "Fubon retained transaction evidence is invalid.");
}

async function reconcileFubonLifecycle(
  transaction: PGliteTransaction,
  request: PGliteCanonicalCreditCardCaptureRequest,
): Promise<PGliteCanonicalCreditCardCaptureRequest> {
  if (request.reconcileLifecycle !== "fubon") return request;
  if (request.capture.integrationNamespace !== "fubon")
    fail("invalid-contract", "Fubon lifecycle reconciliation requires Fubon evidence.");
  const account = await first<{ account_id: unknown }>(transaction, `
    SELECT account.account_id FROM financial_accounts account
    JOIN source_connections connection_scope
      ON connection_scope.source_connection_id = account.source_connection_id
    JOIN identity_epochs epoch ON epoch.identity_epoch_id = account.identity_epoch_id
    WHERE connection_scope.integration_namespace = 'fubon'
      AND connection_scope.source_connection_key = ?
      AND epoch.epoch_key = ? AND account.stream = 'credit-card'
      AND account.source_account_key = ? LIMIT 1`,
    [request.capture.sourceConnectionKey, request.capture.identityEpoch,
      request.account.sourceAccountKey]);
  if (!account?.account_id) return request;
  const rows = await query<FubonPriorLifecycle>(transaction, `
    SELECT lifecycle.transaction_id, financial_transaction.source_sequence,
      source_record.occurrence_key, source_record.content_hash,
      source_record.payload_json, instrument.instrument_key,
      lifecycle.billing_status, lifecycle.statement_key,
      detail.consume_date, detail.posting_date,
      revision.amount_coefficient, revision.amount_scale, revision.currency,
      revision.direction, revision.description,
      conversion.original_amount_coefficient,
      conversion.original_amount_scale, conversion.original_currency
    FROM canonical_credit_card_transaction_lifecycle lifecycle
    JOIN financial_transactions financial_transaction
      ON financial_transaction.transaction_id = lifecycle.transaction_id
    JOIN canonical_credit_card_transaction_details detail
      ON detail.revision_id = lifecycle.revision_id
     AND detail.source_record_id = lifecycle.source_record_id
    JOIN transaction_revisions revision ON revision.revision_id = lifecycle.revision_id
    JOIN source_records source_record ON source_record.source_record_id = lifecycle.source_record_id
    JOIN canonical_credit_card_instruments instrument ON instrument.instrument_id = lifecycle.instrument_id
    LEFT JOIN transaction_conversion_evidence conversion
      ON conversion.transaction_id = lifecycle.transaction_id
     AND conversion.revision_id = lifecycle.revision_id
    JOIN source_captures source_capture ON source_capture.capture_id = lifecycle.capture_id
    JOIN canonical_commits commit_row ON commit_row.commit_id = source_capture.commit_id
    WHERE lifecycle.account_id = ?
    ORDER BY commit_row.commit_sequence DESC, lifecycle.lifecycle_event_id DESC`,
    [account.account_id]);
  const latest = new Map<string, FubonPriorLifecycle>();
  for (const row of rows) {
    const key = idText(row.transaction_id);
    if (!latest.has(key)) latest.set(key, row);
  }
  const records = new Map(request.capture.records.map((record) => [record.occurrenceKey, record]));
  const replacements = new Map<string, FubonPriorLifecycle>();
  const claimed = new Set<string>();
  for (const incoming of request.transactions) {
    const source = records.get(incoming.sourceOccurrenceKey);
    if (!source) fail("missing-reference", "Fubon transaction source evidence is missing.");
    const occurrenceIndex = source.compact.occurrenceIndex;
    const foreign = incoming.conversionEvidence;
    const candidates = [...latest.values()].filter((row) => {
      const compact = fubonCompact(row.payload_json);
      return row.instrument_key === incoming.instrumentKey
        && row.consume_date === (incoming.consumeDate ?? null)
        && row.posting_date === (incoming.postingDate ?? null)
        && row.amount_coefficient === incoming.amount.coefficient
        && Number(row.amount_scale) === incoming.amount.scale
        && row.currency === incoming.currency
        && row.direction === incoming.direction
        && row.description === (incoming.description ?? null)
        && (row.original_amount_coefficient ?? null) === (foreign?.originalAmount?.coefficient ?? null)
        && (row.original_amount_scale === null ? null : Number(row.original_amount_scale)) === (foreign?.originalAmount?.scale ?? null)
        && row.original_currency === (foreign?.originalCurrency ?? null)
        && compact.occurrenceIndex === occurrenceIndex;
    });
    const priorUnbilled = candidates.filter((candidate) => candidate.billing_status === "unbilled"
      && !candidate.statement_key);
    const priorBilled = candidates.filter((candidate) => candidate.billing_status === "billed");
    if (incoming.billingStatus === "unbilled" && priorBilled.length > 0)
      fail("revision-conflict", "Fubon billing lifecycle cannot regress from billed to unbilled.");
    if (incoming.billingStatus !== "billed") continue;
    const incomingScope = source.compact.sourceScopeKey ?? null;
    const matchingBilled = priorBilled.filter((candidate) => {
      if (candidate.statement_key !== (incoming.statementKey ?? null)) return false;
      const scope = fubonCompact(candidate.payload_json).sourceScopeKey ?? null;
      return scope === incomingScope || (incomingScope !== null && scope === null);
    });
    if (priorUnbilled.length > 1 || matchingBilled.length > 1 ||
      (priorUnbilled.length > 0 && matchingBilled.length > 0))
      fail("identity-conflict", "Fubon billed transaction matches ambiguous prior occurrences.");
    const prior = matchingBilled[0] ?? priorUnbilled[0];
    if (!prior) continue;
    if (claimed.has(prior.source_sequence))
      fail("identity-conflict", "Fubon prior transaction was claimed by multiple rows.");
    claimed.add(prior.source_sequence);
    replacements.set(incoming.sourceOccurrenceKey, prior);
  }
  if (replacements.size === 0) return request;
  const key = (value: string): string => replacements.get(value)?.occurrence_key ?? value;
  return {
    ...request,
    capture: {
      ...request.capture,
      records: request.capture.records.map((record) => {
        const prior = replacements.get(record.occurrenceKey);
        return prior ? {
          ...record,
          occurrenceKey: prior.occurrence_key,
          collisionKey: prior.occurrence_key,
          contentHash: prior.content_hash,
          compact: fubonCompact(prior.payload_json),
          compactJson: prior.payload_json,
        } : record;
      }),
    },
    instruments: request.instruments.map((instrument) => ({
      ...instrument, evidenceSourceOccurrenceKey: key(instrument.evidenceSourceOccurrenceKey),
    })),
    transactions: request.transactions.map((item) => ({
      ...item,
      sourceOccurrenceKey: key(item.sourceOccurrenceKey),
      sourceSequence: replacements.get(item.sourceOccurrenceKey)?.source_sequence ?? item.sourceSequence,
    })),
    statements: request.statements.map((statement) => ({
      ...statement,
      transactionSourceOccurrenceKeys: statement.transactionSourceOccurrenceKeys.map(key),
      evidenceSourceOccurrenceKey: key(statement.evidenceSourceOccurrenceKey),
    })),
    relations: request.relations?.map((relation) => ({
      ...relation,
      fromSourceOccurrenceKey: key(relation.fromSourceOccurrenceKey),
      toSourceOccurrenceKey: key(relation.toSourceOccurrenceKey),
      evidenceSourceOccurrenceKey: key(relation.evidenceSourceOccurrenceKey),
    })),
  };
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

async function persistExtensions(
  transaction: PGliteTransaction,
  request: PGliteCanonicalCreditCardCaptureRequest,
  namespace: string,
  accountId: Uint8Array,
  captureId: Uint8Array,
  genericResults: readonly { sourceSequence: string; sourceOccurrenceKey: string; transactionId: string; revisionId: string }[],
  sourceRecordByOccurrence: ReadonlyMap<string, Uint8Array>,
): Promise<{ instrumentCount: number; statementCount: number; balanceRevisionCreated: boolean }> {
  await persistIdentity(transaction, namespace, accountId, captureId, request.identity);
  const transactionMap = await sharedTransactions(transaction, accountId, captureId, request.transactions, genericResults, sourceRecordByOccurrence);
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
    await query(transaction, `INSERT INTO canonical_credit_card_instrument_evidence(
      instrument_id, integration_namespace, account_id, capture_id, source_record_id
    ) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [instrumentId, namespace, accountId, captureId, evidence]);
    instruments.set(input.instrumentKey, instrumentId);
  }
  for (const input of request.transactions) {
    const shared = transactionMap.get(input.sourceOccurrenceKey);
    const instrumentId = instruments.get(input.instrumentKey);
    if (!shared || !instrumentId) fail("missing-reference", `Credit-card transaction instrument is missing: ${input.instrumentKey}.`);
    const existing = await first<{ instrument_id: unknown; billing_status: string; consume_date: string | null; posting_date: string | null; effective_date_basis: string | null }>(transaction, `SELECT instrument_id, billing_status, consume_date, posting_date, effective_date_basis
      FROM canonical_credit_card_transaction_details WHERE revision_id = ? AND source_record_id = ?`, [shared.revisionId, shared.captureSourceRecordId]);
    if (existing && (Buffer.from(bytes(existing.instrument_id)).compare(instrumentId) !== 0 || existing.billing_status !== input.billingStatus || (existing.consume_date ?? null) !== (input.consumeDate ?? null) || (existing.posting_date ?? null) !== (input.postingDate ?? null) || (existing.effective_date_basis ?? null) !== (input.effectiveDateBasis ?? null))) fail("revision-conflict", "Credit-card transaction revision was reused with changed authority data.");
    await query(transaction, `INSERT INTO canonical_credit_card_transaction_details(
      integration_namespace, account_id, transaction_id, revision_id, source_record_id,
      capture_id, instrument_id, billing_status, consume_date, posting_date,
      effective_date_basis, statement_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [
      namespace, accountId, shared.transactionId, shared.revisionId, shared.captureSourceRecordId, captureId,
      instrumentId, input.billingStatus, input.consumeDate ?? null, input.postingDate ?? null,
      input.effectiveDateBasis ?? null, input.statementKey ?? null,
    ]);
    await query(transaction, `INSERT INTO canonical_credit_card_transaction_lifecycle(
      lifecycle_event_id, integration_namespace, account_id, transaction_id, revision_id,
      source_record_id, capture_id, instrument_id, billing_status, statement_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [
      uuidBytes(), namespace, accountId, shared.transactionId, shared.revisionId, shared.captureSourceRecordId,
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
      const stored = await query<{ transaction_id: unknown; transaction_revision_id: unknown }>(transaction, `SELECT transaction_id, transaction_revision_id
        FROM canonical_credit_card_statement_memberships WHERE statement_revision_id = ?`, [existing.statement_revision_id]);
      const storedKeys = stored.map((row) => `${idText(row.transaction_id)}:${idText(row.transaction_revision_id)}`).sort();
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
    await query(transaction, `INSERT INTO canonical_credit_card_statement_summary_evidence(
      statement_revision_id, integration_namespace, account_id, capture_id, evidence_key,
      evidence_source_record_id
    ) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [bytes(revision.statement_revision_id), namespace, accountId, captureId, input.evidenceSourceOccurrenceKey, evidence]);
  }
  for (const relation of request.relations ?? []) {
    const from = transactionMap.get(relation.fromSourceOccurrenceKey);
    const to = transactionMap.get(relation.toSourceOccurrenceKey);
    const evidence = sourceRecordByOccurrence.get(relation.evidenceSourceOccurrenceKey);
    if (!from || !to || !evidence) fail("missing-reference", "Credit-card relation endpoint or evidence is missing.");
    await query(transaction, `INSERT INTO canonical_credit_card_relations(
      relation_id, integration_namespace, account_id, relation_kind, from_transaction_id,
      to_transaction_id, capture_id, evidence_source_record_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [uuidBytes(), namespace, accountId, relation.kind, from.transactionId, to.transactionId, captureId, evidence]);
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

export async function commitPGliteCanonicalCreditCardCapture(
  store: PGliteStore,
  request: PGliteCanonicalCreditCardCaptureRequest,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalCreditCardCommitResult> {
  const input = structuredClone(request);
  validateRequest(input);
  return store.transaction(async (transaction) => {
    const snapshot = await reconcileFubonLifecycle(transaction, input);
    validateRequest(snapshot);
    const generic = await commitPGliteCanonicalFinancialCaptureInTransaction(transaction, {
      capture: snapshot.capture,
      account: snapshot.account,
      transactions: snapshot.transactions,
      balanceObservations: snapshot.balance ? [snapshot.balance.observation] : [],
      requireExistingAccount: snapshot.requireExistingAccount ?? false,
      withdrawalPolicy: "never-infer",
    }, { ...options, skipProjection: true });
    const admittedCapture = await first<{ capture_id: unknown; commit_id: unknown; account_id: unknown }>(transaction, `SELECT capture.capture_id, capture.commit_id, scope.account_id
      FROM source_captures capture
      JOIN capture_scopes scope ON scope.capture_id = capture.capture_id
      WHERE capture.capture_key = ?`, [snapshot.capture.captureId]);
    if (!admittedCapture?.capture_id || !admittedCapture.commit_id || !admittedCapture.account_id) throw new Error("Credit-card source capture scope was not attached to an account.");
    const sourceRecords = await query<{ occurrence_key: string; source_record_id: unknown }>(transaction, "SELECT occurrence_key, source_record_id FROM source_records WHERE capture_id = ?", [admittedCapture.capture_id]);
    const sourceRecordByOccurrence = new Map(sourceRecords.map((row) => [row.occurrence_key, bytes(row.source_record_id)]));
    const extension = await persistExtensions(transaction, snapshot, snapshot.capture.integrationNamespace, bytes(admittedCapture.account_id), bytes(admittedCapture.capture_id), generic.transactions, sourceRecordByOccurrence);
    await (options.projection ?? refreshPGliteCurrentProjectionInTransaction)(transaction, {
      commitId: bytes(admittedCapture.commit_id),
      cutoffSequence: generic.commitSequence,
      captureIds: [bytes(admittedCapture.capture_id)],
      transactionIds: generic.transactions.map((result) => bytes(Buffer.from(result.transactionId.replaceAll("-", ""), "hex"))),
      refreshEnrichmentAll: true,
    });
    assertPGliteCanonicalCommitNotCancelled(options.signal);
    return {
      status: "committed" as const,
      captureId: snapshot.capture.captureId,
      accountId: idText(admittedCapture.account_id),
      commitSequence: generic.commitSequence,
      transactionCount: snapshot.transactions.length,
      instrumentCount: extension.instrumentCount,
      statementCount: extension.statementCount,
      balanceRevisionCreated: extension.balanceRevisionCreated,
    };
  });
}

export async function commitPGliteCanonicalCreditCardBalanceCapture(
  store: PGliteStore,
  request: PGliteCanonicalCreditCardBalanceCaptureRequest,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalCreditCardCommitResult> {
  return commitPGliteCanonicalCreditCardCapture(store, {
    ...request,
    instruments: [],
    transactions: [],
    statements: [],
    requireExistingAccount: true,
  }, options);
}

export function executePGliteCanonicalCreditCardCommand(
  store: PGliteStore,
  command: PGliteCanonicalCreditCardCommitCommand | PGliteCanonicalCreditCardBalanceCommand,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalCreditCardCommitResult> {
  return command.kind === PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND
    ? commitPGliteCanonicalCreditCardBalanceCapture(store, command.request, options)
    : commitPGliteCanonicalCreditCardCapture(store, command.request, options);
}
