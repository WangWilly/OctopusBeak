import { createHash, randomUUID } from "node:crypto";
import type { InvestmentFundingEvidence } from "../canonical/investment-financial.ts";
import {
  admitCounterpartyAccountEvidence,
  type TransactionCounterpartyAccountEvidenceInput,
} from "../canonical/counterparty-account-evidence.ts";
import {
  assertPGliteCanonicalCommitNotCancelled,
  type PGliteCanonicalCommitOptions,
} from "./canonical-source-store.ts";
import { refreshPGliteCurrentProjectionInTransaction } from "./projection.ts";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

/**
 * Relation resolution is a worker-owned command.  The request contains only
 * source keys and provider evidence identifiers; a transaction capability or
 * callback never crosses this boundary.
 */
export const PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND =
  "canonical.loan-repayment-relations.resolve" as const;
export const PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND =
  "canonical.investment-funding-relations.resolve" as const;

export type PGliteCanonicalExplicitLoanRelationLink = Readonly<{
  fromCaptureId: string;
  fromSourceRecordKey: string;
  toCaptureId: string;
  toSourceRecordKey: string;
  relationId: string;
  contractVersion: string;
  evidenceSourceRecordKey?: string;
}>;

export type PGliteCanonicalLoanRelationResolutionRequest = Readonly<{
  sourceConnectionKey: string;
  integrationNamespace?: string;
  observedAt?: string;
  requiredCoverage?: { complete: boolean };
  explicitLinks?: readonly PGliteCanonicalExplicitLoanRelationLink[];
  /** Source evidence is admitted in the same worker transaction as resolution. */
  counterpartyEvidence?: readonly TransactionCounterpartyAccountEvidenceInput[];
}>;

export type PGliteCanonicalLoanRelationResolutionCommand = Readonly<{
  kind: typeof PGLITE_CANONICAL_LOAN_RELATIONS_RESOLVE_COMMAND;
  request: PGliteCanonicalLoanRelationResolutionRequest;
}>;

export type PGliteCanonicalLoanRelationResolutionResult = Readonly<{
  status: "canonical-live";
  outcome: "changed" | "unchanged" | "no-admission";
  resolutionId: string | null;
  exactRelationIds: readonly string[];
  settlementGroupIds: readonly string[];
  reason?: string;
  warnings: readonly string[];
}>;

export type PGliteCanonicalInvestmentRelationResolutionRequest = Readonly<{
  sourceConnectionKey?: string;
  observedAt?: string;
}>;

export type PGliteCanonicalInvestmentRelationResolutionCommand = Readonly<{
  kind: typeof PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND;
  request: PGliteCanonicalInvestmentRelationResolutionRequest;
}>;

export type PGliteCanonicalInvestmentRelationResolutionResult = Readonly<{
  status: "canonical-live";
  outcome: "changed" | "unchanged" | "no-admission";
  resolutionId: string | null;
  resolved: number;
  noAdmission: number;
  reasons: readonly string[];
  warnings: readonly string[];
}>;

type Row = Readonly<Record<string, unknown>>;

async function query<T>(
  transaction: PGliteTransaction,
  sql: string,
  params: readonly unknown[] = [],
): Promise<readonly T[]> {
  let index = 0;
  const postgresSql = sql.replace(/\?/gu, () => `$${++index}`);
  return (await transaction.query<T>(postgresSql, params)).rows;
}

async function first<T>(
  transaction: PGliteTransaction,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | undefined> {
  return (await query<T>(transaction, sql, params))[0];
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
    const hexValue = value.replace(/^\\x/u, "");
    if (/^[0-9a-f]{32}$/iu.test(hexValue))
      return Uint8Array.from(Buffer.from(hexValue, "hex"));
  }
  throw new Error(`${label} is not a canonical UUID.`);
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function id(value: unknown, label: string): string {
  const valueBytes = bytes(value, label);
  const valueHex = hex(valueBytes);
  return `${valueHex.slice(0, 8)}-${valueHex.slice(8, 12)}-${valueHex.slice(12, 16)}-${valueHex.slice(16, 20)}-${valueHex.slice(20)}`;
}

function digest(...parts: readonly string[]): string {
  return `sha256:${createHash("sha256").update(parts.join("\u0000")).digest("base64url")}`;
}

function inList(values: readonly unknown[]): string {
  return values.length === 0 ? "NULL" : values.map(() => "?").join(",");
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required.`);
  return value.trim();
}

function canonicalAmountKey(coefficient: string, scale: number): string {
  let integer: bigint;
  try {
    integer = BigInt(coefficient);
  } catch {
    return `${coefficient}:${scale}`;
  }
  let normalizedScale = scale;
  while (normalizedScale > 0 && integer % 10n === 0n) {
    integer /= 10n;
    normalizedScale -= 1;
  }
  return `${integer.toString()}:${normalizedScale}`;
}

function exactAmountEquals(
  leftCoefficient: string,
  leftScale: number,
  rightCoefficient: string,
  rightScale: number,
): boolean {
  return canonicalAmountKey(leftCoefficient, leftScale) ===
    canonicalAmountKey(rightCoefficient, rightScale);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function relationCommit(
  transaction: PGliteTransaction,
  authorityRoute: string,
  options: PGliteCanonicalCommitOptions,
): Promise<Readonly<{ id: Uint8Array; sequence: number }>> {
  const latest = await first<{ sequence: number | string; recorded_at_utc_us: number | string }>(
    transaction,
    `SELECT COALESCE(MAX(commit_sequence), 0) AS sequence,
            COALESCE(MAX(recorded_at_utc_us), 0) AS recorded_at_utc_us
       FROM canonical_commits`,
  );
  const sequence = Number(latest?.sequence ?? 0) + 1;
  const now = options.recordedAtUtcUs ?? options.clock?.() ?? Date.now() * 1_000;
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("PGlite relation resolution clock returned an invalid timestamp.");
  const recordedAt = Math.max(now, Number(latest?.recorded_at_utc_us ?? 0) + 1);
  const commitId = uuidBytes();
  await query(
    transaction,
    `INSERT INTO canonical_commits(
       commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind
     ) VALUES (?, ?, ?, ?, 'relation_resolution')`,
    [commitId, sequence, recordedAt, authorityRoute],
  );
  return { id: commitId, sequence };
}

type Connection = Readonly<{
  id: Uint8Array;
  namespace: string;
}>;

async function sourceConnection(
  transaction: PGliteTransaction,
  sourceConnectionKey: string,
  integrationNamespace?: string,
): Promise<Connection> {
  const row = await first<Row>(
    transaction,
    `SELECT source_connection_id, integration_namespace
       FROM source_connections
      WHERE source_connection_key = ?
        AND (?::text IS NULL OR integration_namespace = ?)
      ORDER BY integration_namespace
      LIMIT 1`,
    [sourceConnectionKey, integrationNamespace ?? null, integrationNamespace ?? null],
  );
  if (!row) throw new Error("PGlite relation source connection was not found.");
  return {
    id: bytes(row.source_connection_id, "Relation source connection"),
    namespace: String(row.integration_namespace),
  };
}

type RelationTransaction = Readonly<{
  transactionId: Uint8Array;
  revisionId: Uint8Array;
  accountId: Uint8Array;
  sourceRecordId: Uint8Array;
  captureId: Uint8Array;
  captureKey: string;
  sourceConnectionId: Uint8Array;
  identityEpochId: Uint8Array;
  sourceRecordKey: string;
  accountType: string;
  stream: string;
  direction: "inflow" | "outflow";
  eventKind: string | null;
  effectiveOn: string;
  amountCoefficient: string;
  amountScale: number;
  currency: string;
  scopeStart: string;
  scopeEnd: string;
  completeness: string;
  terminal: boolean;
  observedAt: string;
}>;

async function readCurrentRelationTransactions(
  transaction: PGliteTransaction,
  connection: Connection,
): Promise<RelationTransaction[]> {
  const rows = await query<Row>(
    transaction,
    `SELECT DISTINCT ON (current_row.transaction_id)
            current_row.transaction_id, current_row.revision_id,
            financial.account_id, revision.source_record_id,
            revision.capture_id, source_capture.capture_key,
            account.source_connection_id, account.identity_epoch_id,
            source_record.occurrence_key, account.account_type, account.stream,
            revision.direction, loan_fact.event_kind,
            revision.effective_on, revision.amount_coefficient,
            revision.amount_scale, revision.currency,
            scope.scope_start, scope.scope_end, scope.completeness, scope.terminal,
            source_capture.observed_at
       FROM current_transactions current_row
       JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id
       JOIN financial_transactions financial ON financial.transaction_id = current_row.transaction_id
       JOIN financial_accounts account ON account.account_id = financial.account_id
       JOIN source_records source_record
         ON source_record.source_record_id = revision.source_record_id
        AND source_record.capture_id = revision.capture_id
       JOIN source_captures source_capture ON source_capture.capture_id = revision.capture_id
       LEFT JOIN loan_transaction_facts loan_fact ON loan_fact.revision_id = revision.revision_id
       LEFT JOIN source_record_scopes record_scope
         ON record_scope.source_record_id = source_record.source_record_id
        AND record_scope.capture_id = source_record.capture_id
       LEFT JOIN capture_scopes scope
         ON scope.scope_id = record_scope.scope_id
        AND scope.capture_id = record_scope.capture_id
       WHERE account.source_connection_id = ?
       ORDER BY current_row.transaction_id, scope.scope_id NULLS LAST`,
    [connection.id],
  );
  return rows.map((row) => ({
    transactionId: bytes(row.transaction_id, "Relation transaction"),
    revisionId: bytes(row.revision_id, "Relation revision"),
    accountId: bytes(row.account_id, "Relation account"),
    sourceRecordId: bytes(row.source_record_id, "Relation source record"),
    captureId: bytes(row.capture_id, "Relation capture"),
    captureKey: String(row.capture_key),
    sourceConnectionId: bytes(row.source_connection_id, "Relation source connection"),
    identityEpochId: bytes(row.identity_epoch_id, "Relation identity epoch"),
    sourceRecordKey: String(row.occurrence_key),
    accountType: String(row.account_type),
    stream: String(row.stream),
    direction: String(row.direction) as "inflow" | "outflow",
    eventKind: row.event_kind == null ? null : String(row.event_kind),
    effectiveOn: String(row.effective_on),
    amountCoefficient: String(row.amount_coefficient),
    amountScale: Number(row.amount_scale),
    currency: String(row.currency),
    scopeStart: String(row.scope_start ?? ""),
    scopeEnd: String(row.scope_end ?? ""),
    completeness: String(row.completeness ?? ""),
    terminal: Number(row.terminal ?? 0) === 1 || row.terminal === true,
    observedAt: String(row.observed_at),
  }));
}

function completeCoverage(rows: readonly RelationTransaction[]): boolean {
  return rows.length > 0 && rows.every((row) =>
    row.completeness === "complete-range" && row.terminal &&
    validDate(row.scopeStart) && validDate(row.scopeEnd),
  );
}

type LoanPlan =
  | Readonly<{
      kind: "exact";
      deposit: RelationTransaction;
      loan: RelationTransaction;
      supportKind: "explicit-source-linkage" | "verified-repayment-destination" | "fixed-institution-note";
      supportKey: string;
      evidenceSourceRecordKey: string;
      evidenceRelationId: string;
      evidenceContractVersion: string;
      evidenceJson: Record<string, unknown>;
    }>
  | Readonly<{
      kind: "group";
      members: readonly RelationTransaction[];
      supportKind: "verified-repayment-destination" | "fixed-institution-note";
      supportKey: string;
      evidenceSourceRecordKey: string;
      evidenceRelationId: string;
      evidenceContractVersion: string;
      evidenceJson: Record<string, unknown>;
    }>;

function loanRows(
  rows: readonly RelationTransaction[],
): { loans: RelationTransaction[]; deposits: RelationTransaction[] } {
  return {
    loans: rows.filter((row) => row.accountType === "loan" &&
      (row.eventKind === "payment" || row.eventKind === "interest") &&
      row.direction === "inflow"),
    deposits: rows.filter((row) => row.accountType === "depository" && row.direction === "outflow"),
  };
}

function uniqueTransactions(rows: readonly RelationTransaction[]): RelationTransaction[] {
  return [...new Map(rows.map((row) => [hex(row.transactionId), row])).values()];
}

function loanPlanKey(plan: LoanPlan): string {
  return plan.kind === "exact"
    ? ["exact", hex(plan.deposit.transactionId), hex(plan.loan.transactionId), plan.supportKey].join("\u0000")
    : ["group", ...plan.members.map((row) => hex(row.transactionId)).sort(), plan.supportKey].join("\u0000");
}

async function relationEvidence(
  transaction: PGliteTransaction,
  connection: Connection,
): Promise<readonly Row[]> {
  return query<Row>(
    transaction,
    `SELECT evidence.*, source_capture.observed_at AS evidence_observed_at
       FROM transaction_counterparty_account_evidence evidence
       JOIN source_captures source_capture ON source_capture.capture_id = evidence.capture_id
      WHERE evidence.source_connection_id = ?
        AND evidence.purpose = 'loan_repayment'`,
    [connection.id],
  );
}

function buildLoanEvidencePlans(
  rows: { loans: readonly RelationTransaction[]; deposits: readonly RelationTransaction[] },
  evidence: readonly Row[],
): LoanPlan[] {
  const depositsByDigest = new Map<string, RelationTransaction[]>();
  const loansByDigest = new Map<string, RelationTransaction[]>();
  const evidenceByDigest = new Map<string, Row>();
  for (const item of evidence) {
    const digestValue = String(item.value_digest);
    evidenceByDigest.set(digestValue, item);
    const transactionId = item.transaction_id == null ? null : bytes(item.transaction_id, "Evidence transaction");
    const accountId = item.account_id == null ? null : bytes(item.account_id, "Evidence account");
    if (item.evidence_kind === "transaction-counterparty-account" && item.role === "beneficiary" && transactionId) {
      const deposit = rows.deposits.find((candidate) => hex(candidate.transactionId) === hex(transactionId));
      if (deposit)
        depositsByDigest.set(digestValue, [...(depositsByDigest.get(digestValue) ?? []), deposit]);
    }
    if (transactionId || accountId) {
      const matchingLoans = rows.loans.filter((candidate) =>
        (transactionId && hex(candidate.transactionId) === hex(transactionId)) ||
        (accountId && hex(candidate.accountId) === hex(accountId)),
      );
      if (matchingLoans.length > 0)
        loansByDigest.set(digestValue, [...(loansByDigest.get(digestValue) ?? []), ...matchingLoans]);
    }
  }
  const plans: LoanPlan[] = [];
  for (const [valueDigest, rawDeposits] of depositsByDigest) {
    const deposits = uniqueTransactions(rawDeposits);
    const loans = uniqueTransactions(loansByDigest.get(valueDigest) ?? []);
    const support = evidenceByDigest.get(valueDigest);
    if (!support || deposits.length === 0 || loans.length === 0) continue;
    if (deposits.length === 1 && loans.length === 1) {
      const deposit = deposits[0]!;
      const loan = loans[0]!;
      plans.push({
        kind: "exact",
        deposit,
        loan,
        supportKind: "verified-repayment-destination",
        supportKey: digest("verified-repayment-destination/v1", valueDigest, deposit.sourceRecordKey, loan.sourceRecordKey),
        evidenceSourceRecordKey: deposit.sourceRecordKey,
        evidenceRelationId: valueDigest,
        evidenceContractVersion: String(support.contract_version),
        evidenceJson: {
          kind: "verified-repayment-destination",
          accountDigest: valueDigest,
          evidenceVersion: "counterparty-account/v1",
          amountDateComparison: `${deposit.effectiveOn}:${loan.effectiveOn}:${deposit.currency}`,
        },
      });
    } else {
      const members = [...deposits, ...loans];
      plans.push({
        kind: "group",
        members,
        supportKind: "verified-repayment-destination",
        supportKey: digest("verified-repayment-settlement-group/v1", valueDigest, ...members.map((row) => hex(row.transactionId)).sort()),
        evidenceSourceRecordKey: deposits[0]!.sourceRecordKey,
        evidenceRelationId: valueDigest,
        evidenceContractVersion: String(support.contract_version),
        evidenceJson: {
          kind: "verified-repayment-destination",
          accountDigest: valueDigest,
          evidenceVersion: "counterparty-account/v1",
          ambiguous: true,
          collectiveMembership: true,
        },
      });
    }
  }
  return plans;
}

function dateOffset(deposit: string, loan: string): number | null {
  if (!validDate(deposit) || !validDate(loan)) return null;
  return Math.round((Date.parse(`${loan}T00:00:00Z`) - Date.parse(`${deposit}T00:00:00Z`)) / 86_400_000);
}

function noteOffsets(value: unknown): readonly number[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as { allowedSignedDayOffsets?: unknown };
    return Array.isArray(parsed.allowedSignedDayOffsets)
      ? parsed.allowedSignedDayOffsets.filter((item): item is number => Number.isSafeInteger(item))
      : [];
  } catch {
    return [];
  }
}

async function buildLoanNotePlans(
  transaction: PGliteTransaction,
  rows: { loans: readonly RelationTransaction[]; deposits: readonly RelationTransaction[] },
): Promise<LoanPlan[]> {
  if (rows.deposits.length === 0 || rows.loans.length === 0) return [];
  const noteRows = await query<Row>(
    transaction,
    `SELECT evidence.*, source_capture.observed_at AS evidence_observed_at
       FROM institution_repayment_note_evidence evidence
       JOIN source_captures source_capture ON source_capture.capture_id = evidence.capture_id
      WHERE evidence.transaction_id IN (${inList(rows.deposits.map((row) => row.transactionId))})
        AND evidence.live_verified = 1`,
    rows.deposits.map((row) => row.transactionId),
  );
  const plans: LoanPlan[] = [];
  for (const note of noteRows) {
    const depositId = bytes(note.transaction_id, "Note deposit transaction");
    const deposit = rows.deposits.find((row) => hex(row.transactionId) === hex(depositId));
    if (!deposit) continue;
    const candidates = rows.loans.filter((loan) =>
      loan.currency === deposit.currency &&
      exactAmountEquals(loan.amountCoefficient, loan.amountScale, deposit.amountCoefficient, deposit.amountScale) &&
      noteOffsets(note.date_contract_json).includes(dateOffset(deposit.effectiveOn, loan.effectiveOn) ?? Number.NaN),
    );
    if (candidates.length !== 1) continue;
    const loan = candidates[0]!;
    plans.push({
      kind: "exact",
      deposit,
      loan,
      supportKind: "fixed-institution-note",
      supportKey: digest("fixed-institution-note-support/v1", id(note.note_evidence_id, "Note evidence"), deposit.sourceRecordKey, loan.sourceRecordKey),
      evidenceSourceRecordKey: deposit.sourceRecordKey,
      evidenceRelationId: id(note.note_evidence_id, "Note evidence"),
      evidenceContractVersion: String(note.contract_version),
      evidenceJson: {
        kind: "fixed-institution-note",
        evidenceVersion: String(note.evidence_version),
        patternId: String(note.pattern_id),
        noteEvidenceId: id(note.note_evidence_id, "Note evidence"),
        signedCalendarDayOffset: dateOffset(deposit.effectiveOn, loan.effectiveOn),
      },
    });
  }
  return plans;
}

async function endpointForExplicitLink(
  transaction: PGliteTransaction,
  connection: Connection,
  captureKey: string,
  sourceRecordKey: string,
): Promise<RelationTransaction> {
  const row = await first<Row>(
    transaction,
    `SELECT current_row.transaction_id, current_row.revision_id,
            financial.account_id, revision.source_record_id, revision.capture_id,
            source_capture.capture_key, account.source_connection_id,
            account.identity_epoch_id, source_record.occurrence_key,
            account.account_type, account.stream, revision.direction,
            loan_fact.event_kind, revision.effective_on,
            revision.amount_coefficient, revision.amount_scale, revision.currency,
            scope.scope_start, scope.scope_end, scope.completeness, scope.terminal,
            source_capture.observed_at
       FROM current_transactions current_row
       JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id
       JOIN financial_transactions financial ON financial.transaction_id = current_row.transaction_id
       JOIN financial_accounts account ON account.account_id = financial.account_id
       JOIN source_records source_record
         ON source_record.source_record_id = revision.source_record_id
        AND source_record.capture_id = revision.capture_id
       JOIN source_captures source_capture ON source_capture.capture_id = revision.capture_id
       LEFT JOIN loan_transaction_facts loan_fact ON loan_fact.revision_id = revision.revision_id
       LEFT JOIN source_record_scopes record_scope
         ON record_scope.source_record_id = source_record.source_record_id
        AND record_scope.capture_id = source_record.capture_id
       LEFT JOIN capture_scopes scope ON scope.scope_id = record_scope.scope_id
      WHERE source_capture.capture_key = ?
        AND source_record.occurrence_key = ?
        AND account.source_connection_id = ?
      LIMIT 1`,
    [captureKey, sourceRecordKey, connection.id],
  );
  if (!row) throw new Error("Explicit loan relation endpoint is not a current transaction.");
  const [result] = await readCurrentRelationTransactions(transaction, connection);
  // Reuse the same decoder while retaining the endpoint row selected by the
  // capture/occurrence pair; this avoids trusting caller-chosen UUIDs.
  return {
    transactionId: bytes(row.transaction_id, "Explicit relation transaction"),
    revisionId: bytes(row.revision_id, "Explicit relation revision"),
    accountId: bytes(row.account_id, "Explicit relation account"),
    sourceRecordId: bytes(row.source_record_id, "Explicit relation source record"),
    captureId: bytes(row.capture_id, "Explicit relation capture"),
    captureKey: String(row.capture_key),
    sourceConnectionId: bytes(row.source_connection_id, "Explicit relation source connection"),
    identityEpochId: bytes(row.identity_epoch_id, "Explicit relation identity epoch"),
    sourceRecordKey: String(row.occurrence_key),
    accountType: String(row.account_type),
    stream: String(row.stream),
    direction: String(row.direction) as "inflow" | "outflow",
    eventKind: row.event_kind == null ? null : String(row.event_kind),
    effectiveOn: String(row.effective_on),
    amountCoefficient: String(row.amount_coefficient),
    amountScale: Number(row.amount_scale),
    currency: String(row.currency),
    scopeStart: String(row.scope_start ?? ""),
    scopeEnd: String(row.scope_end ?? ""),
    completeness: String(row.completeness ?? ""),
    terminal: Number(row.terminal ?? 0) === 1 || row.terminal === true,
    observedAt: String(row.observed_at),
  };
}

function assertLoanPair(
  left: RelationTransaction,
  right: RelationTransaction,
): { deposit: RelationTransaction; loan: RelationTransaction } {
  const deposit = left.accountType === "depository" ? left : right;
  const loan = left.accountType === "loan" ? left : right;
  if (deposit.accountType !== "depository" || deposit.direction !== "outflow" ||
      loan.accountType !== "loan" || loan.direction !== "inflow" ||
      (loan.eventKind !== "payment" && loan.eventKind !== "interest"))
    throw new Error("Loan repayment relations require one deposit outflow and one loan payment.");
  if (hex(deposit.sourceConnectionId) !== hex(loan.sourceConnectionId))
    throw new Error("Loan relation endpoints must share a source connection.");
  return { deposit, loan };
}

async function explicitLoanPlans(
  transaction: PGliteTransaction,
  connection: Connection,
  links: readonly PGliteCanonicalExplicitLoanRelationLink[],
): Promise<LoanPlan[]> {
  return Promise.all(links.map(async (link) => {
    const from = await endpointForExplicitLink(transaction, connection, text(link.fromCaptureId, "Explicit relation capture"), text(link.fromSourceRecordKey, "Explicit relation source record"));
    const to = await endpointForExplicitLink(transaction, connection, text(link.toCaptureId, "Explicit relation capture"), text(link.toSourceRecordKey, "Explicit relation source record"));
    const pair = assertLoanPair(from, to);
    const evidenceSourceRecordKey = link.evidenceSourceRecordKey ?? pair.deposit.sourceRecordKey;
    if (evidenceSourceRecordKey !== pair.deposit.sourceRecordKey && evidenceSourceRecordKey !== pair.loan.sourceRecordKey)
      throw new Error("Explicit relation evidence must cite one endpoint source record.");
    return {
      kind: "exact",
      deposit: pair.deposit,
      loan: pair.loan,
      supportKind: "explicit-source-linkage",
      supportKey: digest("explicit-relation-support/v1", text(link.relationId, "Explicit relation ID"), pair.deposit.sourceRecordKey, pair.loan.sourceRecordKey),
      evidenceSourceRecordKey,
      evidenceRelationId: text(link.relationId, "Explicit relation ID"),
      evidenceContractVersion: text(link.contractVersion, "Explicit relation contract version"),
      evidenceJson: {
        kind: "explicit-source-linkage",
        evidenceVersion: text(link.contractVersion, "Explicit relation contract version"),
        relationId: text(link.relationId, "Explicit relation ID"),
        fromSourceRecordKey: pair.deposit.sourceRecordKey,
        toSourceRecordKey: pair.loan.sourceRecordKey,
      },
    } satisfies LoanPlan;
  }));
}

async function currentLoanRelationScope(
  transaction: PGliteTransaction,
  sourceConnectionId: Uint8Array,
): Promise<Readonly<{ relationIds: Set<string>; groupIds: Set<string> }>> {
  const relationRows = await query<Row>(
    transaction,
    `SELECT DISTINCT ON (relation.relation_id)
            relation.relation_id, event.event_kind
       FROM transaction_relations relation
       LEFT JOIN loan_repayment_relation_events event ON event.relation_id = relation.relation_id
       LEFT JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
      WHERE relation.source_connection_id = ?
      ORDER BY relation.relation_id, event_commit.commit_sequence DESC NULLS LAST,
               encode(event.event_id, 'hex') DESC NULLS LAST`,
    [sourceConnectionId],
  );
  const groupRows = await query<Row>(
    transaction,
    `SELECT DISTINCT ON (group_row.settlement_group_id)
            group_row.settlement_group_id, event.event_kind
       FROM loan_repayment_settlement_groups group_row
       LEFT JOIN loan_repayment_relation_events event ON event.settlement_group_id = group_row.settlement_group_id
       LEFT JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
      WHERE group_row.source_connection_id = ?
      ORDER BY group_row.settlement_group_id, event_commit.commit_sequence DESC NULLS LAST,
               encode(event.event_id, 'hex') DESC NULLS LAST`,
    [sourceConnectionId],
  );
  return {
    relationIds: new Set(relationRows.filter((row) => row.event_kind === "observed").map((row) => hex(bytes(row.relation_id, "Current relation")))),
    groupIds: new Set(groupRows.filter((row) => row.event_kind === "observed").map((row) => hex(bytes(row.settlement_group_id, "Current group")))),
  };
}

async function refreshCurrentLoanRelationTables(
  transaction: PGliteTransaction,
  sourceConnection: Connection,
  generationCommitId: Uint8Array,
  generationId: number,
): Promise<void> {
  await query(
    transaction,
    `DELETE FROM current_loan_relations
      WHERE generation_id = ?
        AND relation_id IN (SELECT relation_id FROM transaction_relations WHERE source_connection_id = ?)`,
    [generationId, sourceConnection.id],
  );
  await query(
    transaction,
    `DELETE FROM current_loan_repayment_settlement_groups
      WHERE generation_id = ?
        AND settlement_group_id IN (SELECT settlement_group_id FROM loan_repayment_settlement_groups WHERE source_connection_id = ?)`,
    [generationId, sourceConnection.id],
  );
  await query(
    transaction,
    `INSERT INTO current_loan_relations(generation_id, relation_id, projection_commit_id, relation_commit_id)
     SELECT ?, relation.relation_id, ?, relation.commit_id
       FROM transaction_relations relation
      WHERE relation.source_connection_id = ?
        AND COALESCE((
          SELECT event.event_kind
            FROM loan_repayment_relation_events event
            JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
           WHERE event.relation_id = relation.relation_id
           ORDER BY event_commit.commit_sequence DESC, encode(event.event_id, 'hex') DESC
           LIMIT 1
        ), 'withdrawn') = 'observed'`,
    [generationId, generationCommitId, sourceConnection.id],
  );
  await query(
    transaction,
    `INSERT INTO current_loan_repayment_settlement_groups(generation_id, settlement_group_id, projection_commit_id)
     SELECT ?, group_row.settlement_group_id, ?
       FROM loan_repayment_settlement_groups group_row
      WHERE group_row.source_connection_id = ?
        AND COALESCE((
          SELECT event.event_kind
            FROM loan_repayment_relation_events event
            JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
           WHERE event.settlement_group_id = group_row.settlement_group_id
           ORDER BY event_commit.commit_sequence DESC, encode(event.event_id, 'hex') DESC
           LIMIT 1
        ), 'withdrawn') = 'observed'`,
    [generationId, generationCommitId, sourceConnection.id],
  );
}

async function activeLoanRelationIds(
  transaction: PGliteTransaction,
  sourceConnection: Connection,
): Promise<Readonly<{ relations: readonly Row[]; groups: readonly Row[] }>> {
  const relations = await query<Row>(
    transaction,
    `SELECT relation.relation_id, relation.from_transaction_id, relation.to_transaction_id,
            latest.event_kind, latest.support_kind, latest.support_key
       FROM transaction_relations relation
       JOIN LATERAL (
         SELECT event.event_kind, event.support_kind, event.support_key
           FROM loan_repayment_relation_events event
           JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
          WHERE event.relation_id = relation.relation_id
          ORDER BY event_commit.commit_sequence DESC, encode(event.event_id, 'hex') DESC
          LIMIT 1
       ) latest ON true
      WHERE relation.source_connection_id = ? AND latest.event_kind = 'observed'`,
    [sourceConnection.id],
  );
  const groups = await query<Row>(
    transaction,
    `SELECT group_row.settlement_group_id, latest.event_kind, latest.support_kind,
            latest.support_key, member.transaction_id
       FROM loan_repayment_settlement_groups group_row
       JOIN loan_repayment_settlement_group_members member
         ON member.settlement_group_id = group_row.settlement_group_id
       JOIN LATERAL (
         SELECT event.event_kind, event.support_kind, event.support_key
           FROM loan_repayment_relation_events event
           JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
          WHERE event.settlement_group_id = group_row.settlement_group_id
          ORDER BY event_commit.commit_sequence DESC, encode(event.event_id, 'hex') DESC
          LIMIT 1
       ) latest ON true
      WHERE group_row.source_connection_id = ? AND latest.event_kind = 'observed'`,
    [sourceConnection.id],
  );
  return { relations, groups };
}

async function persistLoanPlan(
  transaction: PGliteTransaction,
  plan: LoanPlan,
  resolutionId: Uint8Array,
  commitId: Uint8Array,
): Promise<Readonly<{ relationId?: Uint8Array; groupId?: Uint8Array; endpointIds: readonly string[] }>> {
  if (plan.kind === "exact") {
    const relationKey = digest(
      "loan-relation-v11",
      hex(plan.loan.sourceConnectionId),
      hex(plan.loan.accountId),
      hex(plan.deposit.transactionId),
      hex(plan.loan.accountId),
      hex(plan.loan.transactionId),
    );
    const existing = await first<Row>(transaction, "SELECT relation_id, from_account_id, to_account_id, from_transaction_id, to_transaction_id FROM transaction_relations WHERE relation_key = ?", [relationKey]);
    const relationId = existing ? bytes(existing.relation_id, "Loan relation") : uuidBytes();
    if (existing) {
      const expected = [plan.deposit.accountId, plan.loan.accountId, plan.deposit.transactionId, plan.loan.transactionId];
      const actual = [existing.from_account_id, existing.to_account_id, existing.from_transaction_id, existing.to_transaction_id].map((value) => bytes(value, "Loan relation endpoint"));
      if (actual.some((value, index) => hex(value) !== hex(expected[index]!)))
        throw new Error("Loan relation identity overwrite is forbidden.");
    } else {
      await query(
        transaction,
        `INSERT INTO transaction_relations(
           relation_id, account_id, source_connection_id, identity_epoch_id, commit_id,
           relation_key, relation_kind, from_account_id, to_account_id,
           from_source_record_key, to_source_record_key, from_transaction_id,
           to_transaction_id, from_direction, to_direction, evidence_source_record_key,
           evidence_relation_id, evidence_contract_version, from_identity_epoch_id,
           to_identity_epoch_id
         ) VALUES (?, ?, ?, ?, ?, ?, 'transfer_counterpart', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [relationId, plan.deposit.accountId, plan.deposit.sourceConnectionId, plan.loan.identityEpochId, commitId,
          relationKey, plan.deposit.accountId, plan.loan.accountId, plan.deposit.sourceRecordKey,
          plan.loan.sourceRecordKey, plan.deposit.transactionId, plan.loan.transactionId,
          plan.deposit.direction, plan.loan.direction, plan.evidenceSourceRecordKey,
          plan.evidenceRelationId, plan.evidenceContractVersion, plan.deposit.identityEpochId,
          plan.loan.identityEpochId],
      );
    }
    await query(
      transaction,
      `INSERT INTO transaction_relation_provenance(
         relation_id, source_record_id, capture_id, commit_id,
         evidence_source_record_key, evidence_relation_id, evidence_contract_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [relationId, plan.deposit.sourceRecordKey === plan.evidenceSourceRecordKey ? plan.deposit.sourceRecordId : plan.loan.sourceRecordId,
        plan.deposit.sourceRecordKey === plan.evidenceSourceRecordKey ? plan.deposit.captureId : plan.loan.captureId,
        commitId, plan.evidenceSourceRecordKey, plan.evidenceRelationId, plan.evidenceContractVersion],
    );
    await query(
      transaction,
      `INSERT INTO loan_repayment_relation_events(
         event_id, resolution_id, relation_id, settlement_group_id, event_kind,
         support_kind, support_key, supersedes_relation_id, supersedes_group_id,
         evidence_json, commit_id
       ) VALUES (?, ?, ?, NULL, 'observed', ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT DO NOTHING`,
      [uuidBytes(), resolutionId, relationId, plan.supportKind, plan.supportKey, JSON.stringify(plan.evidenceJson), commitId],
    );
    return { relationId, endpointIds: [hex(plan.deposit.transactionId), hex(plan.loan.transactionId)] };
  }
  const groupKey = digest("loan-settlement-group-v1", hex(plan.members[0]!.sourceConnectionId), plan.supportKey, ...plan.members.map((member) => hex(member.transactionId)).sort());
  const existing = await first<Row>(transaction, "SELECT settlement_group_id FROM loan_repayment_settlement_groups WHERE group_key = ?", [groupKey]);
  const groupId = existing ? bytes(existing.settlement_group_id, "Loan settlement group") : uuidBytes();
  if (!existing) {
    await query(transaction, `INSERT INTO loan_repayment_settlement_groups(settlement_group_id, source_connection_id, group_key, resolver_version, created_commit_id) VALUES (?, ?, ?, 'loan-repayment-relation/v1', ?)`, [groupId, plan.members[0]!.sourceConnectionId, groupKey, commitId]);
    for (const member of plan.members)
      await query(transaction, `INSERT INTO loan_repayment_settlement_group_members(settlement_group_id, transaction_id, member_kind, source_record_id, capture_id, commit_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [groupId, member.transactionId, member.accountType === "loan" ? "loan_payment" : "deposit_outflow", member.sourceRecordId, member.captureId, commitId]);
  }
  await query(
    transaction,
    `INSERT INTO loan_repayment_relation_events(
       event_id, resolution_id, relation_id, settlement_group_id, event_kind,
       support_kind, support_key, supersedes_relation_id, supersedes_group_id,
       evidence_json, commit_id
     ) VALUES (?, ?, NULL, ?, 'observed', ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [uuidBytes(), resolutionId, groupId, plan.supportKind, plan.supportKey, JSON.stringify(plan.evidenceJson), commitId],
  );
  return { groupId, endpointIds: plan.members.map((member) => hex(member.transactionId)) };
}

async function supersedeLoanOverlaps(
  transaction: PGliteTransaction,
  sourceConnection: Connection,
  plan: LoanPlan,
  resolutionId: Uint8Array,
  commitId: Uint8Array,
  replacementRelationId?: Uint8Array,
  replacementGroupId?: Uint8Array,
): Promise<number> {
  if (plan.kind !== "exact") return 0;
  const endpointIds = new Set([hex(plan.deposit.transactionId), hex(plan.loan.transactionId)]);
  const active = await activeLoanRelationIds(transaction, sourceConnection);
  let count = 0;
  for (const row of active.relations) {
    const relationId = bytes(row.relation_id, "Relation");
    if (replacementRelationId && hex(relationId) === hex(replacementRelationId)) continue;
    if (!endpointIds.has(hex(bytes(row.from_transaction_id, "Relation endpoint"))) || !endpointIds.has(hex(bytes(row.to_transaction_id, "Relation endpoint")))) continue;
    await query(transaction, `INSERT INTO loan_repayment_relation_events(event_id, resolution_id, relation_id, settlement_group_id, event_kind, support_kind, support_key, supersedes_relation_id, supersedes_group_id, evidence_json, commit_id) VALUES (?, ?, ?, NULL, 'superseded', 'explicit-source-linkage', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [uuidBytes(), resolutionId, relationId, String(row.support_key), replacementRelationId ?? null, replacementGroupId ?? null, JSON.stringify({ supersededBy: "relation-resolution" }), commitId]);
    count += 1;
  }
  const seenGroups = new Set<string>();
  for (const row of active.groups) {
    const groupKey = hex(bytes(row.settlement_group_id, "Settlement group"));
    if (seenGroups.has(groupKey) || (replacementGroupId && groupKey === hex(replacementGroupId)) || !endpointIds.has(hex(bytes(row.transaction_id, "Group member")))) continue;
    seenGroups.add(groupKey);
    const members = await query<Row>(transaction, "SELECT transaction_id FROM loan_repayment_settlement_group_members WHERE settlement_group_id = ?", [bytes(row.settlement_group_id, "Settlement group")]);
    if (members.length !== endpointIds.size || members.some((member) => !endpointIds.has(hex(bytes(member.transaction_id, "Group member"))))) continue;
    await query(transaction, `INSERT INTO loan_repayment_relation_events(event_id, resolution_id, relation_id, settlement_group_id, event_kind, support_kind, support_key, supersedes_relation_id, supersedes_group_id, evidence_json, commit_id) VALUES (?, ?, NULL, ?, 'superseded', 'verified-repayment-destination', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [uuidBytes(), resolutionId, bytes(row.settlement_group_id, "Settlement group"), String(row.support_key), replacementRelationId ?? null, replacementGroupId ?? null, JSON.stringify({ supersededBy: "relation-resolution" }), commitId]);
    count += 1;
  }
  return count;
}

async function withdrawStaleLoanGroups(
  transaction: PGliteTransaction,
  sourceConnection: Connection,
  desired: ReadonlySet<string>,
  resolutionId: Uint8Array,
  commitId: Uint8Array,
): Promise<number> {
  const active = await activeLoanRelationIds(transaction, sourceConnection);
  let count = 0;
  const seen = new Set<string>();
  for (const row of active.groups) {
    const groupId = hex(bytes(row.settlement_group_id, "Settlement group"));
    if (seen.has(groupId) || desired.has(groupId) || row.support_kind !== "verified-repayment-destination") continue;
    seen.add(groupId);
    await query(transaction, `INSERT INTO loan_repayment_relation_events(event_id, resolution_id, relation_id, settlement_group_id, event_kind, support_kind, support_key, supersedes_relation_id, supersedes_group_id, evidence_json, commit_id) VALUES (?, ?, NULL, ?, 'withdrawn', ?, ?, NULL, NULL, ?, ?) ON CONFLICT DO NOTHING`, [uuidBytes(), resolutionId, bytes(row.settlement_group_id, "Settlement group"), String(row.support_kind), String(row.support_key), JSON.stringify({ withdrawn: "complete-resolution-no-longer-supported" }), commitId]);
    count += 1;
  }
  return count;
}

async function admitLoanCounterpartyEvidence(
  transaction: PGliteTransaction,
  input: TransactionCounterpartyAccountEvidenceInput,
): Promise<void> {
  const capture = await first<Row>(transaction,
    `SELECT capture.capture_id, capture.commit_id, capture.source_connection_id,
            capture.identity_epoch_id, connection.source_connection_key,
            connection.integration_namespace, epoch.epoch_key
       FROM source_captures capture
       JOIN source_connections connection ON connection.source_connection_id = capture.source_connection_id
       JOIN identity_epochs epoch ON epoch.identity_epoch_id = capture.identity_epoch_id
      WHERE capture.capture_key = ?`, [text(input.captureId, "Evidence capture")]);
  if (!capture) throw new Error("Counterparty evidence capture was not found.");
  const admitted = admitCounterpartyAccountEvidence(input, String(capture.integration_namespace));
  if (admitted.sourceConnectionKey !== capture.source_connection_key
    || admitted.identityEpochKey !== capture.epoch_key)
    throw new Error("Counterparty evidence source scope does not match its capture.");
  const captureId = bytes(capture.capture_id, "Evidence capture");
  const sourceRecord = await first<Row>(transaction,
    `SELECT source_record_id FROM source_records
      WHERE capture_id = ? AND occurrence_key = ?`,
    [captureId, admitted.sourceRecordKey]);
  if (!sourceRecord) throw new Error("Counterparty evidence source record was not found.");
  const sourceRecordId = bytes(sourceRecord.source_record_id, "Evidence source record");
  const account = await first<Row>(transaction,
    `SELECT account_id FROM financial_accounts
      WHERE source_connection_id = ? AND identity_epoch_id = ?
        AND source_account_key = ?`,
    [capture.source_connection_id, capture.identity_epoch_id, input.accountKey ?? ""]);
  const scopedAccountId = account ? bytes(account.account_id, "Evidence account") : null;
  const revision = await first<Row>(transaction,
    `SELECT transaction_id FROM transaction_revisions
      WHERE source_record_id = ? ORDER BY revision_number DESC LIMIT 1`,
    [sourceRecordId]);
  let transactionId = revision ? bytes(revision.transaction_id, "Evidence transaction") : null;
  if (!transactionId && scopedAccountId) {
    const replay = await first<Row>(transaction,
      `SELECT transaction_id FROM financial_transactions
        WHERE account_id = ? AND source_sequence = ? LIMIT 1`,
      [scopedAccountId, admitted.sourceRecordKey]);
    if (replay) transactionId = bytes(replay.transaction_id, "Replayed evidence transaction");
  }
  const accountScopedMandate = admitted.evidenceKind === "repayment-mandate" && Boolean(input.accountKey);
  if (accountScopedMandate) transactionId = null;
  const accountId = transactionId ? null : scopedAccountId;
  if (!transactionId && !accountId)
    throw new Error("Counterparty evidence needs a transaction or captured account.");
  const evidenceId = createHash("sha256")
    .update([
      "counterparty-account-evidence-id/v1", hex(captureId),
      transactionId ? hex(transactionId) : "", accountId ? hex(accountId) : "",
      admitted.sourceRecordKey, admitted.accountDigest, admitted.role,
      admitted.purpose, admitted.scope ?? "", admitted.evidenceKind,
      admitted.contractVersion,
    ].join("\u0000"))
    .digest().subarray(0, 16);
  const prior = await first<Row>(transaction,
    `SELECT source_value, normalized_value, value_digest
       FROM transaction_counterparty_account_evidence WHERE evidence_id = ?`,
    [evidenceId]);
  if (prior && (prior.source_value !== admitted.sourceValue
    || prior.normalized_value !== admitted.normalizedAccountValue
    || prior.value_digest !== admitted.accountDigest))
    throw new Error("Counterparty evidence overwrite is forbidden.");
  if (!prior) await query(transaction,
    `INSERT INTO transaction_counterparty_account_evidence(
      evidence_id, transaction_id, account_id, source_record_id, capture_id,
      source_connection_id, identity_epoch_id, source_value, normalized_value,
      value_digest, role, purpose, scope, evidence_kind, source_field,
      contract_version, effective_start_date, effective_end_date, created_commit_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [evidenceId, transactionId, accountId, sourceRecordId, captureId,
      capture.source_connection_id, capture.identity_epoch_id, admitted.sourceValue,
      admitted.normalizedAccountValue, admitted.accountDigest, admitted.role,
      admitted.purpose, admitted.scope ?? null, admitted.evidenceKind,
      admitted.sourceField, admitted.contractVersion,
      admitted.effectiveStartDate ?? null, admitted.effectiveEndDate ?? null,
      capture.commit_id]);
  await query(transaction,
    `INSERT INTO counterparty_account_evidence_support(
      evidence_id, source_record_id, capture_id, commit_id
    ) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [evidenceId, sourceRecordId, captureId, capture.commit_id]);
}

async function resolveLoanRelationsInTransaction(
  transaction: PGliteTransaction,
  request: PGliteCanonicalLoanRelationResolutionRequest,
  options: PGliteCanonicalCommitOptions,
): Promise<PGliteCanonicalLoanRelationResolutionResult> {
  assertPGliteCanonicalCommitNotCancelled(options.signal);
  const connection = await sourceConnection(transaction, text(request.sourceConnectionKey, "Relation source connection"), request.integrationNamespace);
  for (const evidence of request.counterpartyEvidence ?? []) {
    assertPGliteCanonicalCommitNotCancelled(options.signal);
    await admitLoanCounterpartyEvidence(transaction, evidence);
  }
  const current = loanRows(await readCurrentRelationTransactions(transaction, connection));
  if (request.requiredCoverage?.complete === false) {
    return noAdmissionLoanResolution(transaction, connection, request, "required-capture-coverage-is-incomplete", options);
  }
  const explicit = request.explicitLinks && request.explicitLinks.length > 0;
  const evidence = explicit ? [] : await relationEvidence(transaction, connection);
  const plans = explicit
    ? await explicitLoanPlans(transaction, connection, request.explicitLinks!)
    : evidence.length > 0
      ? buildLoanEvidencePlans(current, evidence)
      : await buildLoanNotePlans(transaction, current);
  const participants = plans.flatMap((plan) => plan.kind === "exact" ? [plan.deposit, plan.loan] : [...plan.members]);
  if (!explicit && participants.length > 0 && !completeCoverage(participants))
    return noAdmissionLoanResolution(transaction, connection, request, "required-capture-coverage-is-incomplete", options);
  if (plans.length === 0)
    return noAdmissionLoanResolution(transaction, connection, request, "no-evidence-backed-admission", options);
  const resolutionKey = digest("pglite-loan-repayment-resolution/v1", hex(connection.id), ...plans.map(loanPlanKey).sort());
  const existing = await first<Row>(transaction, "SELECT resolution_id, outcome FROM loan_repayment_resolution_runs WHERE resolution_key = ?", [resolutionKey]);
  if (existing) {
    const observed = await query<Row>(transaction, "SELECT relation_id, settlement_group_id FROM loan_repayment_relation_events WHERE resolution_id = ? AND event_kind = 'observed'", [existing.resolution_id]);
    return {
      status: "canonical-live",
      outcome: "unchanged",
      resolutionId: id(existing.resolution_id, "Loan resolution"),
      exactRelationIds: observed.filter((row) => row.relation_id != null).map((row) => id(row.relation_id, "Loan relation")),
      settlementGroupIds: observed.filter((row) => row.settlement_group_id != null).map((row) => id(row.settlement_group_id, "Settlement group")),
      warnings: [],
    };
  }
  const commit = await relationCommit(transaction, "canonical/loan-repayment-relation-resolution-v1", options);
  const resolutionId = uuidBytes();
  await query(transaction, `INSERT INTO loan_repayment_resolution_runs(resolution_id, resolution_key, source_connection_id, resolver_version, coverage_state, outcome, reason, observed_at, commit_id) VALUES (?, ?, ?, 'loan-repayment-relation/v1', 'complete', 'changed', NULL, ?, ?)`, [resolutionId, resolutionKey, connection.id, request.observedAt ?? new Date().toISOString(), commit.id]);
  const exactRelationIds: string[] = [];
  const settlementGroupIds: string[] = [];
  let changed = false;
  for (const plan of plans) {
    const persisted = await persistLoanPlan(transaction, plan, resolutionId, commit.id);
    if (persisted.relationId) exactRelationIds.push(id(persisted.relationId, "Loan relation"));
    if (persisted.groupId) settlementGroupIds.push(id(persisted.groupId, "Settlement group"));
    changed = true;
    await supersedeLoanOverlaps(transaction, connection, plan, resolutionId, commit.id, persisted.relationId, persisted.groupId);
  }
  const desiredGroups = new Set(settlementGroupIds.map((value) => value.replaceAll("-", "")));
  if (!explicit) changed = (await withdrawStaleLoanGroups(transaction, connection, desiredGroups, resolutionId, commit.id)) > 0 || changed;
  if (!changed)
    await query(transaction, "UPDATE loan_repayment_resolution_runs SET outcome = 'unchanged' WHERE resolution_id = ?", [resolutionId]);
  const generation = await first<{ generation_id: number | string }>(transaction, "SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1");
  if (!generation) throw new Error("Active PGlite projection generation is missing.");
  await refreshCurrentLoanRelationTables(transaction, connection, commit.id, Number(generation.generation_id));
  const affected = current.deposits.concat(current.loans).map((row) => row.transactionId);
  await (options.projection ?? refreshPGliteCurrentProjectionInTransaction)(transaction, {
    commitId: commit.id,
    cutoffSequence: commit.sequence,
    transactionIds: affected,
  });
  assertPGliteCanonicalCommitNotCancelled(options.signal);
  return {
    status: "canonical-live",
    outcome: changed ? "changed" : "unchanged",
    resolutionId: id(resolutionId, "Loan resolution"),
    exactRelationIds,
    settlementGroupIds,
    warnings: [],
  };
}

async function noAdmissionLoanResolution(
  transaction: PGliteTransaction,
  connection: Connection,
  request: PGliteCanonicalLoanRelationResolutionRequest,
  reason: string,
  options: PGliteCanonicalCommitOptions,
): Promise<PGliteCanonicalLoanRelationResolutionResult> {
  const key = digest("pglite-loan-repayment-no-admission-v1", hex(connection.id), reason, request.observedAt ?? "");
  const existing = await first<Row>(transaction, "SELECT resolution_id FROM loan_repayment_resolution_runs WHERE resolution_key = ?", [key]);
  if (existing)
    return { status: "canonical-live", outcome: "unchanged", resolutionId: id(existing.resolution_id, "Loan resolution"), exactRelationIds: [], settlementGroupIds: [], reason, warnings: [reason] };
  const commit = await relationCommit(transaction, "canonical/loan-repayment-relation-resolution-v1", options);
  const resolutionId = uuidBytes();
  await query(transaction, `INSERT INTO loan_repayment_resolution_runs(resolution_id, resolution_key, source_connection_id, resolver_version, coverage_state, outcome, reason, observed_at, commit_id) VALUES (?, ?, ?, 'loan-repayment-relation/v1', ?, 'no-admission', ?, ?, ?)`, [resolutionId, key, connection.id, request.requiredCoverage?.complete === false ? "incomplete" : "complete", reason, request.observedAt ?? new Date().toISOString(), commit.id]);
  assertPGliteCanonicalCommitNotCancelled(options.signal);
  return { status: "canonical-live", outcome: "no-admission", resolutionId: id(resolutionId, "Loan resolution"), exactRelationIds: [], settlementGroupIds: [], reason, warnings: [reason] };
}

export async function resolvePGliteCanonicalLoanRepaymentRelations(
  store: PGliteStore,
  request: PGliteCanonicalLoanRelationResolutionRequest,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalLoanRelationResolutionResult> {
  return store.transaction((transaction) => resolveLoanRelationsInTransaction(transaction, structuredClone(request), options));
}

export function executePGliteCanonicalLoanRelationCommand(
  store: PGliteStore,
  command: PGliteCanonicalLoanRelationResolutionCommand | PGliteCanonicalLoanRelationResolutionRequest,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalLoanRelationResolutionResult> {
  return resolvePGliteCanonicalLoanRepaymentRelations(store, "kind" in command ? command.request : command, options);
}

/* ------------------------------------------------------------------------- *
 * Investment funding resolution
 * ------------------------------------------------------------------------- */

type InvestmentRow = Readonly<{
  transactionId: Uint8Array;
  investmentAccountId: Uint8Array;
  sourceRecordId: Uint8Array;
  captureId: Uint8Array;
  sourceConnectionId: Uint8Array;
  sourceRecordKey: string;
  action: "buy" | "sell";
  effectiveOn: string;
  cashCoefficient: string;
  cashScale: number;
  cashCurrency: string;
  fundingEvidence: InvestmentFundingEvidence;
  complete: boolean;
}>;

type FundingCandidate = Readonly<{
  accountId: Uint8Array;
  transactionId: Uint8Array;
  sourceRecordId: Uint8Array;
  coefficient: string;
  scale: number;
  currency: string;
}>;

const YUANTA_SETTLEMENT_CONTRACT = "yuanta/foreign-settlement/human-attested-v1";
const YUANTA_SETTLEMENT_LINKAGE = "yuanta/foreign-settlement/linkage-v1";
const YUANTA_SETTLEMENT_MARKET = "yuanta/foreign-settlement/market-v2";
const YUANTA_SETTLEMENT_MARKET_US_EQUITY = "us-equity";
const YUANTA_SETTLEMENT_HOLIDAYS = new Set([
  "2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
  "2026-02-20", "2026-02-27", "2026-04-03", "2026-04-06", "2026-05-01",
  "2026-06-19", "2026-09-25", "2026-10-09",
]);

function addSettlementBusinessDays(effectiveOn: string, action: "buy" | "sell", market: string): string | null {
  if (market !== YUANTA_SETTLEMENT_MARKET_US_EQUITY || effectiveOn < "2026-01-01" || effectiveOn > "2026-12-31") return null;
  const date = new Date(`${effectiveOn}T00:00:00Z`);
  const days = action === "buy" ? 1 : 2;
  let count = 0;
  while (count < days) {
    date.setUTCDate(date.getUTCDate() + 1);
    const candidate = date.toISOString().slice(0, 10);
    if (candidate > "2026-12-31") return null;
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !YUANTA_SETTLEMENT_HOLIDAYS.has(candidate)) count += 1;
  }
  return date.toISOString().slice(0, 10);
}

function parseFundingEvidence(value: unknown): InvestmentFundingEvidence | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as InvestmentFundingEvidence;
    if (!parsed || typeof parsed !== "object" || typeof parsed.kind !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readInvestmentRows(
  transaction: PGliteTransaction,
  sourceConnectionKey?: string,
): Promise<InvestmentRow[]> {
  const rows = await query<Row>(
    transaction,
    `SELECT investment.transaction_id, investment.account_id,
            investment.source_record_id, investment.capture_id,
            investment.source_record_id, investment.action,
            investment.cash_coefficient, investment.cash_scale,
            investment.cash_currency, investment.effective_on,
            investment.funding_evidence_json, source_record.occurrence_key,
            source_capture.source_connection_id,
            scope.completeness, scope.terminal
       FROM investment_transactions investment
       JOIN investment_accounts account ON account.account_id = investment.account_id
       JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
       JOIN source_records source_record ON source_record.source_record_id = investment.source_record_id
       JOIN source_captures source_capture ON source_capture.capture_id = investment.capture_id
       LEFT JOIN source_record_scopes record_scope
         ON record_scope.source_record_id = investment.source_record_id
        AND record_scope.capture_id = investment.capture_id
       LEFT JOIN capture_scopes scope ON scope.scope_id = record_scope.scope_id
      WHERE (?::text IS NULL OR connection.source_connection_key = ?)
        AND investment.action IN ('buy','sell')
      ORDER BY investment.account_id, investment.effective_on, investment.transaction_id`,
    [sourceConnectionKey ?? null, sourceConnectionKey ?? null],
  );
  return rows.flatMap((row) => {
    const fundingEvidence = parseFundingEvidence(row.funding_evidence_json);
    if (!fundingEvidence) return [];
    return [{
      transactionId: bytes(row.transaction_id, "Investment transaction"),
      investmentAccountId: bytes(row.account_id, "Investment account"),
      sourceRecordId: bytes(row.source_record_id, "Investment source record"),
      captureId: bytes(row.capture_id, "Investment capture"),
      sourceConnectionId: bytes(row.source_connection_id, "Investment source connection"),
      sourceRecordKey: String(row.occurrence_key),
      action: String(row.action) as "buy" | "sell",
      effectiveOn: String(row.effective_on),
      cashCoefficient: String(row.cash_coefficient),
      cashScale: Number(row.cash_scale),
      cashCurrency: String(row.cash_currency),
      fundingEvidence,
      complete: String(row.completeness) === "complete-range" && (Number(row.terminal) === 1 || row.terminal === true),
    } satisfies InvestmentRow];
  });
}

function parseSourcePayload(value: unknown): Readonly<{ linkageKey: string; linkageContract: string; transactionInfo: string }> {
  try {
    const parsed: unknown = JSON.parse(String(value));
    const record = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    const source = record.sourcePayload !== null && typeof record.sourcePayload === "object" && !Array.isArray(record.sourcePayload)
      ? record.sourcePayload as Record<string, unknown>
      : record;
    return {
      linkageKey: typeof source.settlementLinkageKey === "string" ? source.settlementLinkageKey.trim() : "",
      linkageContract: typeof source.settlementLinkageContractVersion === "string" ? source.settlementLinkageContractVersion.trim() : "",
      transactionInfo: typeof source.transactionInfo === "string" ? source.transactionInfo.trim() : "",
    };
  } catch {
    return { linkageKey: "", linkageContract: "", transactionInfo: "" };
  }
}

async function readFundingCandidates(
  transaction: PGliteTransaction,
  effectiveOn: string,
  currency: string,
  direction: "inflow" | "outflow",
  expectedCoefficient: string,
  expectedScale: number,
  linkageKey: string,
): Promise<FundingCandidate[]> {
  const rows = await query<Row>(
    transaction,
    `SELECT current_row.transaction_id, revision.source_record_id,
            financial.account_id, revision.amount_coefficient,
            revision.amount_scale, revision.currency, revision.description,
            source_record.payload_json, scope.completeness, scope.terminal
       FROM current_transactions current_row
       JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id
       JOIN financial_transactions financial ON financial.transaction_id = current_row.transaction_id
       JOIN financial_accounts account ON account.account_id = financial.account_id
       JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
       JOIN source_records source_record ON source_record.source_record_id = revision.source_record_id
       LEFT JOIN source_record_scopes record_scope ON record_scope.source_record_id = source_record.source_record_id
       LEFT JOIN capture_scopes scope ON scope.scope_id = record_scope.scope_id
      WHERE connection.integration_namespace = 'yuanta'
        AND account.stream = 'foreign-currency-deposit'
        AND account.account_type = 'depository'
        AND revision.effective_on = ?
        AND revision.direction = ?
        AND revision.currency = ?
        AND revision.posting_status = 'posted'
        AND revision.economic_status = 'normal'
        AND revision.administrative_state = 'active'`,
    [effectiveOn, direction, currency],
  );
  const description = direction === "outflow" ? "複委託扣" : "複委託入";
  const transactionInfo = direction === "outflow" ? "淨額扣" : "淨額入";
  return rows.flatMap((row) => {
    const payload = parseSourcePayload(row.payload_json);
    const account = text(String(row.account_id ?? ""), "Funding account");
    if (String(row.description) !== description || payload.transactionInfo !== transactionInfo ||
        payload.linkageKey !== linkageKey || payload.linkageContract !== YUANTA_SETTLEMENT_LINKAGE ||
        String(row.completeness) !== "complete-range" || !(Number(row.terminal) === 1 || row.terminal === true) ||
        !exactAmountEquals(String(row.amount_coefficient), Number(row.amount_scale), expectedCoefficient, expectedScale)) return [];
    return [{
      accountId: bytes(row.account_id, "Funding account"),
      transactionId: bytes(row.transaction_id, "Funding transaction"),
      sourceRecordId: bytes(row.source_record_id, "Funding source record"),
      coefficient: String(row.amount_coefficient),
      scale: Number(row.amount_scale),
      currency: String(row.currency),
    } satisfies FundingCandidate];
  });
}

function investmentGroupKey(row: InvestmentRow): string | null {
  if (row.fundingEvidence.kind === "unresolved")
    return `${hex(row.investmentAccountId)}\u0000unresolved\u0000${row.sourceRecordKey}`;
  if (row.fundingEvidence.kind === "source-linked-account")
    return `${hex(row.investmentAccountId)}\u0000${row.fundingEvidence.settlementGroupKey}`;
  if (row.fundingEvidence.kind === "source-settlement-contract") {
    const settlement = addSettlementBusinessDays(row.effectiveOn, row.action, row.fundingEvidence.settlementMarket);
    return settlement ? `${hex(row.investmentAccountId)}\u0000${row.cashCurrency}\u0000${row.fundingEvidence.settlementMarket}\u0000${settlement}` : null;
  }
  return null;
}

function scaledInteger(coefficient: string, scale: number, targetScale: number): bigint {
  return BigInt(coefficient) * 10n ** BigInt(targetScale - scale);
}

function signedNet(rows: readonly InvestmentRow[]): Readonly<{ coefficient: string; scale: number; direction: "inflow" | "outflow" }> {
  const scale = Math.max(...rows.map((row) => row.cashScale));
  const value = rows.reduce((sum, row) => sum + (row.action === "buy" ? scaledInteger(row.cashCoefficient, row.cashScale, scale) : -scaledInteger(row.cashCoefficient, row.cashScale, scale)), 0n);
  return { coefficient: (value < 0n ? -value : value).toString(), scale, direction: value > 0n ? "outflow" : "inflow" };
}

function investmentRelationIdentity(rows: readonly InvestmentRow[], candidate: FundingCandidate) {
  const relationKey = digest("investment-funding-relation-v1", hex(rows[0]!.investmentAccountId), hex(candidate.transactionId), ...rows.map((row) => hex(row.transactionId)).sort());
  const supportFingerprint = digest("investment-funding-relation-support-v2", ...rows.map((row) => hex(row.sourceRecordId)).sort(), hex(candidate.sourceRecordId), ...rows.map((row) => hex(row.transactionId)).sort(), hex(candidate.transactionId));
  return { relationKey, reason: `verified-settlement:${supportFingerprint}` };
}

async function investmentRelationAlreadyCurrent(
  transaction: PGliteTransaction,
  rows: readonly InvestmentRow[],
  candidate: FundingCandidate,
  settlementGroupKey: string,
): Promise<boolean> {
  const identity = investmentRelationIdentity(rows, candidate);
  const existing = await first<Row>(transaction, "SELECT relation_id FROM investment_funding_relations WHERE relation_key = ?", [identity.relationKey]);
  if (!existing) return false;
  const relationId = bytes(existing.relation_id, "Investment relation");
  const latest = await first<Row>(transaction, `SELECT event.event_kind, event.reason FROM investment_funding_relation_events event JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id WHERE event.relation_id = ? ORDER BY event_commit.commit_sequence DESC, encode(event.event_id, 'hex') DESC LIMIT 1`, [relationId]);
  if (latest?.event_kind !== "observed" || latest.reason !== identity.reason) return false;
  const competitors = await query<Row>(transaction, "SELECT relation_id FROM investment_funding_relations WHERE investment_account_id = ? AND settlement_group_key = ? AND relation_id <> ?", [rows[0]!.investmentAccountId, settlementGroupKey, relationId]);
  for (const competitor of competitors) {
    const event = await first<Row>(transaction, `SELECT event.event_kind FROM investment_funding_relation_events event JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id WHERE event.relation_id = ? ORDER BY event_commit.commit_sequence DESC, encode(event.event_id, 'hex') DESC LIMIT 1`, [competitor.relation_id]);
    if (event?.event_kind === "observed") return false;
  }
  return true;
}

async function persistInvestmentRelation(
  transaction: PGliteTransaction,
  rows: readonly InvestmentRow[],
  candidate: FundingCandidate,
  settlementGroupKey: string,
  settlementEffectiveOn: string,
  evidence: Exclude<InvestmentFundingEvidence, { kind: "unresolved" }>,
  commitId: Uint8Array,
): Promise<Readonly<{ relationId: Uint8Array; relationKey: string }>> {
  const net = signedNet(rows);
  const { relationKey, reason } = investmentRelationIdentity(rows, candidate);
  const existing = await first<Row>(transaction, "SELECT relation_id FROM investment_funding_relations WHERE relation_key = ?", [relationKey]);
  const relationId = existing ? bytes(existing.relation_id, "Investment relation") : uuidBytes();
  if (!existing) {
    const sourceLinkageKey = digest("investment-funding-linkage-set-v1", ...rows.map((row) => row.fundingEvidence.kind === "source-settlement-contract" ? row.fundingEvidence.sourceLinkageKey : "").sort());
    await query(transaction, `INSERT INTO investment_funding_relations(relation_id, relation_key, settlement_group_key, investment_account_id, funding_account_id, funding_transaction_id, funding_source_record_id, settlement_effective_on, settlement_model, coefficient, scale, currency, direction, source_linkage_key, evidence_contract_version, created_commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [relationId, relationKey, settlementGroupKey, rows[0]!.investmentAccountId, candidate.accountId, candidate.transactionId, candidate.sourceRecordId, settlementEffectiveOn, evidence.kind === "source-linked-account" ? evidence.settlementModel : "account-currency-date-net", net.coefficient, net.scale, rows[0]!.cashCurrency, net.direction, sourceLinkageKey, evidence.contractVersion, commitId]);
    for (const row of rows)
      await query(transaction, `INSERT INTO investment_funding_relation_members(relation_id, investment_transaction_id, investment_source_record_id, action, coefficient, scale, currency) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [relationId, row.transactionId, row.sourceRecordId, row.action, row.cashCoefficient, row.cashScale, row.cashCurrency]);
  }
  const latest = await first<Row>(transaction, `SELECT event.event_kind, event.reason FROM investment_funding_relation_events event JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id WHERE event.relation_id = ? ORDER BY event_commit.commit_sequence DESC, encode(event.event_id, 'hex') DESC LIMIT 1`, [relationId]);
  if (String(latest?.event_kind ?? "") !== "observed" || String(latest?.reason ?? "") !== reason)
    await query(transaction, `INSERT INTO investment_funding_relation_events(event_id, relation_id, event_kind, reason, commit_id, recorded_at_utc_us) VALUES (?, ?, 'observed', ?, ?, ?) ON CONFLICT DO NOTHING`, [uuidBytes(), relationId, reason, commitId, Date.now() * 1_000]);
  return { relationId, relationKey };
}

async function withdrawInvestmentRelations(
  transaction: PGliteTransaction,
  investmentAccountId: Uint8Array,
  settlementGroupKey: string,
  commitId: Uint8Array,
  replacementRelationId?: Uint8Array,
): Promise<Readonly<{ count: number; transactionIds: readonly Uint8Array[] }>> {
  const rows = await query<Row>(transaction, `SELECT relation.relation_id, relation.funding_transaction_id FROM investment_funding_relations relation WHERE relation.investment_account_id = ? AND relation.settlement_group_key = ?`, [investmentAccountId, settlementGroupKey]);
  let count = 0;
  const transactionIds: Uint8Array[] = [];
  for (const row of rows) {
    const relationId = bytes(row.relation_id, "Investment relation");
    if (replacementRelationId && hex(relationId) === hex(replacementRelationId)) continue;
    const latest = await first<Row>(transaction, `SELECT event.event_kind FROM investment_funding_relation_events event JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id WHERE event.relation_id = ? ORDER BY event_commit.commit_sequence DESC, encode(event.event_id, 'hex') DESC LIMIT 1`, [relationId]);
    if (latest?.event_kind !== "observed") continue;
    await query(transaction, `INSERT INTO investment_funding_relation_events(event_id, relation_id, event_kind, reason, commit_id, recorded_at_utc_us) VALUES (?, ?, 'withdrawn', 'complete-resolution-no-longer-supported', ?, ?) ON CONFLICT DO NOTHING`, [uuidBytes(), relationId, commitId, Date.now() * 1_000]);
    count += 1;
    transactionIds.push(bytes(row.funding_transaction_id, "Funding transaction"));
  }
  return { count, transactionIds };
}

async function resolveInvestmentRelationsInTransaction(
  transaction: PGliteTransaction,
  request: PGliteCanonicalInvestmentRelationResolutionRequest,
  options: PGliteCanonicalCommitOptions,
): Promise<PGliteCanonicalInvestmentRelationResolutionResult> {
  assertPGliteCanonicalCommitNotCancelled(options.signal);
  const investments = await readInvestmentRows(transaction, request.sourceConnectionKey);
  const groups = new Map<string, InvestmentRow[]>();
  for (const row of investments) {
    const key = investmentGroupKey(row);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  let commit: Readonly<{ id: Uint8Array; sequence: number }> | null = null;
  const reasons = new Set<string>();
  const warnings: string[] = [];
  let resolved = 0;
  let withdrawn = 0;
  let noAdmission = 0;
  const affected = new Map<string, Uint8Array>();
  for (const rows of groups.values()) {
    const firstRow = rows[0]!;
    const evidence = firstRow.fundingEvidence;
    const inconsistent = rows.some((row) => row.cashCurrency !== firstRow.cashCurrency || investmentGroupKey(row) !== investmentGroupKey(firstRow));
    if (inconsistent) {
      noAdmission += 1;
      reasons.add("inconsistent-settlement-group");
      continue;
    }
    if (evidence.kind === "unresolved") {
      noAdmission += 1;
      reasons.add("unresolved-funding-evidence");
      continue;
    }
    if (!rows.every((row) => row.complete)) {
      noAdmission += 1;
      reasons.add("incomplete-investment-coverage");
      continue;
    }
    const net = signedNet(rows);
    if (net.coefficient === "0") {
      noAdmission += 1;
      reasons.add("zero-net-settlement");
      continue;
    }
    let settlementEffectiveOn: string | null = null;
    let candidates: FundingCandidate[] = [];
    if (evidence.kind === "source-linked-account") {
      settlementEffectiveOn = evidence.settlementEffectiveOn;
      const accountNo = evidence.fundingAccountNumber.replaceAll(/[\\s-]/gu, "");
      const bankRows = await query<Row>(transaction, `SELECT current_row.transaction_id, revision.source_record_id, financial.account_id, revision.amount_coefficient, revision.amount_scale, revision.currency FROM current_transactions current_row JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id JOIN financial_transactions financial ON financial.transaction_id = current_row.transaction_id JOIN financial_accounts account ON account.account_id = financial.account_id WHERE account.account_no = ? AND revision.effective_on = ? AND revision.direction = ? AND revision.currency = ? AND revision.posting_status = 'posted' AND revision.economic_status = 'normal' AND revision.administrative_state = 'active'`, [accountNo, settlementEffectiveOn, net.direction, firstRow.cashCurrency]);
      candidates = bankRows.filter((row) => exactAmountEquals(String(row.amount_coefficient), Number(row.amount_scale), net.coefficient, net.scale)).map((row) => ({ accountId: bytes(row.account_id, "Funding account"), transactionId: bytes(row.transaction_id, "Funding transaction"), sourceRecordId: bytes(row.source_record_id, "Funding source record"), coefficient: String(row.amount_coefficient), scale: Number(row.amount_scale), currency: String(row.currency) }));
    } else if (evidence.kind === "source-settlement-contract") {
      if (evidence.settlementMarket !== YUANTA_SETTLEMENT_MARKET_US_EQUITY || evidence.settlementMarketContractVersion !== YUANTA_SETTLEMENT_MARKET || evidence.linkageContractVersion !== YUANTA_SETTLEMENT_LINKAGE || evidence.contractVersion !== YUANTA_SETTLEMENT_CONTRACT) {
        noAdmission += 1;
        reasons.add("unsupported-settlement-market");
        continue;
      }
      settlementEffectiveOn = addSettlementBusinessDays(firstRow.effectiveOn, firstRow.action, evidence.settlementMarket);
      if (!settlementEffectiveOn) {
        noAdmission += 1;
        reasons.add("unsupported-settlement-calendar");
        continue;
      }
      candidates = await readFundingCandidates(transaction, settlementEffectiveOn, firstRow.cashCurrency, net.direction, net.coefficient, net.scale, evidence.sourceLinkageKey);
    }
    if (!settlementEffectiveOn || candidates.length !== 1) {
      noAdmission += 1;
      reasons.add(candidates.length === 0 ? "no-complete-funding-candidate" : "ambiguous-funding-candidate");
      if (settlementEffectiveOn && firstRow.complete) {
        const groupKey = `${hex(firstRow.investmentAccountId)}:${settlementEffectiveOn}`;
        const prior = await query<Row>(transaction, `SELECT relation.relation_id FROM investment_funding_relations relation WHERE relation.investment_account_id = ? AND relation.settlement_group_key = ? AND (SELECT event.event_kind FROM investment_funding_relation_events event JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id WHERE event.relation_id = relation.relation_id ORDER BY event_commit.commit_sequence DESC, encode(event.event_id, 'hex') DESC LIMIT 1) = 'observed'`, [firstRow.investmentAccountId, groupKey]);
        if (prior.length > 0) {
          if (!commit) commit = await relationCommit(transaction, "canonical/investment-funding-relation-resolution-v1", options);
          const closed = await withdrawInvestmentRelations(transaction, firstRow.investmentAccountId, groupKey, commit.id);
          withdrawn += closed.count;
          for (const transactionId of closed.transactionIds) affected.set(hex(transactionId), transactionId);
        }
      }
      continue;
    }
    const settlementGroupKey = `${hex(firstRow.investmentAccountId)}:${settlementEffectiveOn}`;
    if (await investmentRelationAlreadyCurrent(transaction, rows, candidates[0]!, settlementGroupKey)) continue;
    if (!commit) commit = await relationCommit(transaction, "canonical/investment-funding-relation-resolution-v1", options);
    const persisted = await persistInvestmentRelation(transaction, rows, candidates[0]!, settlementGroupKey, settlementEffectiveOn, evidence, commit.id);
    affected.set(hex(candidates[0]!.transactionId), candidates[0]!.transactionId);
    resolved += 1;
    // Complete source coverage makes a missing replacement authoritative for
    // this investment settlement group, so stale active relations are closed.
    const closed = await withdrawInvestmentRelations(transaction, firstRow.investmentAccountId, settlementGroupKey, commit.id, persisted.relationId);
    withdrawn += closed.count;
    for (const transactionId of closed.transactionIds) affected.set(hex(transactionId), transactionId);
  }
  if (!commit) {
    return {
      status: "canonical-live",
      outcome: noAdmission > 0 ? "no-admission" : "unchanged",
      resolutionId: null,
      resolved,
      noAdmission,
      reasons: [...reasons].sort(),
      warnings,
    };
  }
  const generation = await first<{ generation_id: number | string }>(transaction, "SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1");
  if (!generation) throw new Error("Active PGlite projection generation is missing.");
  await (options.projection ?? refreshPGliteCurrentProjectionInTransaction)(transaction, {
    commitId: commit.id,
    cutoffSequence: commit.sequence,
    transactionIds: [...affected.values()],
  });
  assertPGliteCanonicalCommitNotCancelled(options.signal);
  return {
    status: "canonical-live",
    outcome: resolved > 0 || withdrawn > 0 ? "changed" : "no-admission",
    resolutionId: id(commit.id, "Investment resolution"),
    resolved,
    noAdmission,
    reasons: [...reasons].sort(),
    warnings,
  };
}

export async function resolvePGliteCanonicalInvestmentFundingRelations(
  store: PGliteStore,
  request: PGliteCanonicalInvestmentRelationResolutionRequest = {},
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalInvestmentRelationResolutionResult> {
  return store.transaction((transaction) => resolveInvestmentRelationsInTransaction(transaction, structuredClone(request), options));
}

export function executePGliteCanonicalInvestmentRelationCommand(
  store: PGliteStore,
  command: PGliteCanonicalInvestmentRelationResolutionCommand | PGliteCanonicalInvestmentRelationResolutionRequest = {},
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalInvestmentRelationResolutionResult> {
  return resolvePGliteCanonicalInvestmentFundingRelations(store, "kind" in command ? command.request : command, options);
}

export async function queryPGliteCurrentLoanRepaymentRelations(
  store: PGliteStore,
  options: { sourceConnectionKey?: string; integrationNamespace?: string } = {},
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const rows = await store.query<Row>(
    `SELECT relation.relation_id, relation.relation_kind,
            relation.from_transaction_id, relation.to_transaction_id,
            relation.from_account_id, relation.to_account_id,
            relation.from_source_record_key, relation.to_source_record_key,
            relation.from_direction, relation.to_direction,
            relation.evidence_source_record_key, relation.evidence_relation_id,
            relation.evidence_contract_version, connection.source_connection_key,
            from_epoch.epoch_key AS from_epoch_key, to_epoch.epoch_key AS to_epoch_key
       FROM transaction_relations relation
       JOIN source_connections connection ON connection.source_connection_id = relation.source_connection_id
       LEFT JOIN identity_epochs from_epoch ON from_epoch.identity_epoch_id = relation.from_identity_epoch_id
       LEFT JOIN identity_epochs to_epoch ON to_epoch.identity_epoch_id = relation.to_identity_epoch_id
      WHERE ($1::text IS NULL OR connection.source_connection_key = $2)
        AND ($3::text IS NULL OR connection.integration_namespace = $4)
        AND COALESCE((SELECT event.event_kind FROM loan_repayment_relation_events event JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id WHERE event.relation_id = relation.relation_id ORDER BY event_commit.commit_sequence DESC, encode(event.event_id, 'hex') DESC LIMIT 1), 'withdrawn') = 'observed'
      ORDER BY relation.relation_key`,
    [options.sourceConnectionKey ?? null, options.sourceConnectionKey ?? null, options.integrationNamespace ?? null, options.integrationNamespace ?? null],
  );
  return rows.rows.map((row) => ({
    relationId: id(row.relation_id, "Loan relation"),
    relationKind: "transfer_counterpart",
    fromTransactionId: id(row.from_transaction_id, "Loan relation source transaction"),
    toTransactionId: id(row.to_transaction_id, "Loan relation target transaction"),
    fromAccountId: id(row.from_account_id, "Loan relation source account"),
    toAccountId: id(row.to_account_id, "Loan relation target account"),
    fromSourceRecordKey: String(row.from_source_record_key),
    toSourceRecordKey: String(row.to_source_record_key),
    fromDirection: String(row.from_direction),
    toDirection: String(row.to_direction),
    sourceConnectionKey: String(row.source_connection_key),
    fromIdentityEpochKey: String(row.from_epoch_key ?? ""),
    toIdentityEpochKey: String(row.to_epoch_key ?? ""),
    evidenceSourceRecordKey: String(row.evidence_source_record_key),
    evidenceRelationId: String(row.evidence_relation_id),
    evidenceContractVersion: String(row.evidence_contract_version),
  }));
}

export async function queryPGliteCurrentLoanRepaymentSettlementGroups(
  store: PGliteStore,
  options: { sourceConnectionKey?: string; integrationNamespace?: string } = {},
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const rows = await store.query<Row>(
    `SELECT group_row.settlement_group_id, group_row.group_key,
            connection.source_connection_key, member.transaction_id,
            member.member_kind, source_record.occurrence_key
       FROM loan_repayment_settlement_groups group_row
       JOIN source_connections connection ON connection.source_connection_id = group_row.source_connection_id
       JOIN loan_repayment_settlement_group_members member ON member.settlement_group_id = group_row.settlement_group_id
       JOIN source_records source_record ON source_record.source_record_id = member.source_record_id
      WHERE ($1::text IS NULL OR connection.source_connection_key = $2)
        AND ($3::text IS NULL OR connection.integration_namespace = $4)
        AND COALESCE((SELECT event.event_kind FROM loan_repayment_relation_events event JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id WHERE event.settlement_group_id = group_row.settlement_group_id ORDER BY event_commit.commit_sequence DESC, encode(event.event_id, 'hex') DESC LIMIT 1), 'withdrawn') = 'observed'
      ORDER BY group_row.group_key, member.transaction_id`,
    [options.sourceConnectionKey ?? null, options.sourceConnectionKey ?? null, options.integrationNamespace ?? null, options.integrationNamespace ?? null],
  );
  const groups = new Map<string, { settlementGroupId: string; groupKey: string; sourceConnectionKey: string; members: Array<Record<string, unknown>> }>();
  for (const row of rows.rows) {
    const settlementGroupId = id(row.settlement_group_id, "Settlement group");
    const group = groups.get(settlementGroupId) ?? { settlementGroupId, groupKey: String(row.group_key), sourceConnectionKey: String(row.source_connection_key), members: [] };
    group.members.push({ transactionId: id(row.transaction_id, "Group transaction"), memberKind: String(row.member_kind), sourceRecordKey: String(row.occurrence_key) });
    groups.set(settlementGroupId, group);
  }
  return [...groups.values()];
}

export async function queryPGliteCurrentInvestmentFundingRelations(
  store: PGliteStore,
  sourceConnectionKey?: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const rows = await store.query<Row>(
    `SELECT relation.relation_id, relation.relation_key, relation.settlement_group_key,
            relation.funding_transaction_id, relation.funding_source_record_id,
            relation.settlement_effective_on, relation.settlement_model,
            relation.coefficient, relation.scale, relation.currency, relation.direction,
            relation.source_linkage_key, COUNT(member.investment_transaction_id)::int AS investment_transaction_count
       FROM investment_funding_relations relation
       LEFT JOIN investment_funding_relation_members member ON member.relation_id = relation.relation_id
       JOIN investment_accounts account ON account.account_id = relation.investment_account_id
       JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
      WHERE ($1::text IS NULL OR connection.source_connection_key = $2)
        AND COALESCE((SELECT event.event_kind FROM investment_funding_relation_events event JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id WHERE event.relation_id = relation.relation_id ORDER BY event_commit.commit_sequence DESC, encode(event.event_id, 'hex') DESC LIMIT 1), 'withdrawn') = 'observed'
      GROUP BY relation.relation_id
      ORDER BY relation.relation_key`,
    [sourceConnectionKey ?? null, sourceConnectionKey ?? null],
  );
  return rows.rows.map((row) => ({
    relationKey: String(row.relation_key),
    fundingTransactionId: id(row.funding_transaction_id, "Funding transaction"),
    fundingSourceRecordId: id(row.funding_source_record_id, "Funding source record"),
    settlementGroupKey: String(row.settlement_group_key),
    settlementEffectiveOn: String(row.settlement_effective_on),
    settlementModel: String(row.settlement_model),
    coefficient: String(row.coefficient),
    scale: Number(row.scale),
    currency: String(row.currency),
    direction: String(row.direction),
    sourceLinkageKey: String(row.source_linkage_key),
    investmentTransactionCount: Number(row.investment_transaction_count),
  }));
}
