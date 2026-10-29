import { randomUUID } from "node:crypto";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";
import { insertPGliteCanonicalCommit, type PGliteCanonicalCommitRef } from "./canonical-commit.ts";
import {
  queryCurrentSpendingActionRecords,
  queryPGliteSpendingDirectPair,
  querySpendingRecognition,
  resolvePGliteSpendingCandidate,
  itemCategorizationRows,
  pendingPairRef,
  pendingPairInMonth,
  queryPendingSpendingCandidates,
  recordedAtIso,
  type PGliteSpendingReader,
} from "./spending-query.ts";
import { purchaseRecordCategory } from "../canonical/spending-purchase-report-core.ts";
import type { PurchaseCategory } from "../canonical/purchase-category.ts";
import type {
  SpendingCandidateInput,
  SpendingDecisionInput,
  SpendingDirectUserConfirmationInput,
  SpendingPair,
  SpendingRefundRevisionInput,
  SpendingRefundView,
  SpendingDedupLinkView,
} from "../canonical/spending-recognition-contracts.ts";
import type {
  SpendingPageActionRequest,
  SpendingPageActionResult,
  SpendingSummaryDeltaLine,
  SpendingCandidatePairRef,
  SpendingStrongConfirmRequest,
  SpendingStrongConfirmResult,
} from "../../lib/spending/model.ts";
import { setPGliteSpendingPurchaseCategory } from "./purchase-category-command.ts";
import { transactionPurchaseDate } from "../../lib/spending/purchase-matching.ts";
import type { SpendingPurchaseCategoryRequest } from "../../lib/spending/model.ts";

/** A command may only see the async transaction capability. */
export type PGliteSpendingWriter = Pick<PGliteStore, "query" | "transaction">;

type Row = Readonly<Record<string, unknown>>;

/** Translate the shared SQLite-style placeholders at the PGlite boundary. */
async function txQuery<T>(
  transaction: PGliteTransaction,
  sql: string,
  params: readonly unknown[] = [],
): Promise<{ rows: readonly T[] }> {
  let index = 0;
  const postgresSql = sql.replace(/\?/gu, () => `$${++index}`);
  return transaction.query<T>(postgresSql, params);
}

const LOCAL_USER_ID = "local-user";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const HEX_ID = /^[0-9a-f]{32}$/iu;

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} is required.`);
  return value.trim();
}

function storedString(value: unknown, label: string): string {
  if (value === null || value === undefined || String(value).trim() === "") throw new Error(`${label} is missing.`);
  return String(value);
}

function bytes(value: string, label: string): Uint8Array {
  const clean = required(value, label).toLowerCase();
  if (!UUID.test(clean) && !HEX_ID.test(clean)) throw new Error(`${label} must be a canonical UUID.`);
  return Uint8Array.from(Buffer.from(clean.replaceAll("-", ""), "hex"));
}

function idString(value: unknown): string {
  if (typeof value === "string") {
    const clean = value.toLowerCase();
    if (UUID.test(clean)) return clean;
    if (HEX_ID.test(clean)) return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
  }
  const hex = Buffer.from(value as Uint8Array).toString("hex");
  if (hex.length !== 32) throw new Error("Canonical identity is not a UUID.");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function numberValue(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} is invalid.`);
  return number;
}

function exactRefundCoefficient(value: unknown, scale: unknown): Readonly<{ coefficient: string; scale: number }> {
  const coefficient = required(value, "Refund amount coefficient");
  const normalizedScale = Number(scale);
  if (!/^-?(?:0|[1-9]\d*)$/u.test(coefficient) || !Number.isSafeInteger(normalizedScale) || normalizedScale < 0) {
    throw new Error("Refund amount must be exact.");
  }
  return { coefficient, scale: normalizedScale };
}

function objectJson(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Readonly<Record<string, unknown>>;
}

function stableJson(value: Readonly<Record<string, unknown>>, label: string): string {
  const seen = new WeakSet<object>();
  const normalize = (entry: unknown): unknown => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return entry;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new Error(`${label} must contain finite numbers.`);
      return entry;
    }
    if (Array.isArray(entry)) return entry.map(normalize);
    if (typeof entry === "object") {
      if (seen.has(entry)) throw new Error(`${label} must not be cyclic.`);
      seen.add(entry);
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(entry as object).sort()) {
        const child = normalize((entry as Record<string, unknown>)[key]);
        if (child !== undefined) normalized[key] = child;
      }
      seen.delete(entry);
      return normalized;
    }
    if (entry === undefined) return undefined;
    throw new Error(`${label} contains an unsupported value.`);
  };
  try {
    return JSON.stringify(normalize(value));
  } catch (error) {
    throw new Error(`${label} must be serializable.`, { cause: error });
  }
}

function parseJson(value: unknown): Readonly<Record<string, unknown>> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>;
  const parsed = JSON.parse(String(value ?? "{}"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Stored evidence must be an object.");
  return parsed as Readonly<Record<string, unknown>>;
}

async function latest(reader: PGliteSpendingReader): Promise<number> {
  const result = await reader.query<{ value: number | string }>("SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits");
  return Number(result.rows[0]?.value ?? 0);
}

type CommitRef = PGliteCanonicalCommitRef;

function commit(
  transaction: PGliteTransaction,
  authorityRoute: string,
): Promise<CommitRef> {
  return insertPGliteCanonicalCommit(transaction, {
    kind: "relation_resolution",
    authorityRoute,
    time: { kind: "wall-clock" },
  });
}

async function requirePair(transaction: PGliteTransaction, pair: SpendingPair): Promise<Readonly<{ invoice: Uint8Array; transaction: Uint8Array }>> {
  const invoice = bytes(pair.invoiceId, "Invoice identity");
  const transactionId = bytes(pair.transactionId, "Transaction identity");
  const invoiceResult = await txQuery(transaction, "SELECT 1 FROM einvoice_invoices WHERE invoice_id = ?", [invoice]);
  if (invoiceResult.rows.length === 0) throw new Error("Spending recognition invoice identity does not exist.");
  const transactionResult = await txQuery(transaction, "SELECT 1 FROM financial_transactions WHERE transaction_id = ?", [transactionId]);
  if (transactionResult.rows.length === 0) throw new Error("Spending recognition transaction identity does not exist.");
  return { invoice, transaction: transactionId };
}

async function requireCurrentPair(transaction: PGliteTransaction, pair: SpendingPair): Promise<void> {
  const invoice = bytes(pair.invoiceId, "Invoice identity");
  const transactionId = bytes(pair.transactionId, "Transaction identity");
  const invoiceState = await txQuery<{ state: string }>(transaction,
    `SELECT state FROM einvoice_invoice_revisions
      WHERE invoice_id = ? ORDER BY revision_number DESC, revision_id DESC LIMIT 1`,
    [invoice],
  );
  if (invoiceState.rows[0]?.state !== "active") throw new Error("Direct Spending confirmation invoice identity is stale or inactive.");
  const transactionState = await txQuery<{ administrative_state: string }>(transaction,
    `SELECT revision.administrative_state
       FROM current_transactions current_row
       JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id
      WHERE current_row.transaction_id = ? LIMIT 1`,
    [transactionId],
  );
  if (transactionState.rows[0]?.administrative_state !== "active") throw new Error("Direct Spending confirmation transaction identity is stale, replaced, or inactive.");
}

export async function recordPGliteSpendingMatchCandidate(
  transaction: PGliteTransaction,
  input: SpendingCandidateInput,
): Promise<Readonly<{ candidateId: string; commitSequence: number }>> {
  const pair = await requirePair(transaction, input);
  const algorithm = required(input.algorithm, "Candidate algorithm");
  const algorithmVersion = required(input.algorithmVersion, "Candidate algorithm version");
  const candidateKey = required(input.candidateKey, "Candidate key");
  const evidenceJson = stableJson(objectJson(input.similarityEvidence, "Similarity evidence"), "Similarity evidence");
  const existing = await txQuery<{ candidate_id: unknown; invoice_id: unknown; transaction_id: unknown; algorithm: string; algorithm_version: string; similarity_evidence_json: string; created_commit_id: unknown }>(transaction,
    "SELECT candidate_id, invoice_id, transaction_id, algorithm, algorithm_version, similarity_evidence_json, created_commit_id FROM spending_match_candidates WHERE candidate_key = ?",
    [candidateKey],
  );
  const current = existing.rows[0];
  if (current) {
    if (String(current.algorithm) !== algorithm || String(current.algorithm_version) !== algorithmVersion || String(current.similarity_evidence_json) !== evidenceJson || idString(current.invoice_id) !== input.invoiceId || idString(current.transaction_id) !== input.transactionId) {
      throw new Error("Candidate identity conflicts with earlier evidence.");
    }
    const created = await txQuery<{ commit_sequence: number | string }>(transaction, "SELECT commit_sequence FROM canonical_commits WHERE commit_id = ?", [current.created_commit_id]);
    return { candidateId: idString(current.candidate_id), commitSequence: numberValue(created.rows[0]?.commit_sequence, "Candidate commit sequence") };
  }
  const created = await commit(transaction, "spending/candidate-similarity/v1");
  const candidateId = Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));
  await txQuery(
    transaction,
    `INSERT INTO spending_match_candidates(
       candidate_id, candidate_key, invoice_id, transaction_id, algorithm,
       algorithm_version, similarity_evidence_json, created_commit_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [candidateId, candidateKey, pair.invoice, pair.transaction, algorithm, algorithmVersion, evidenceJson, created.id],
  );
  return { candidateId: idString(candidateId), commitSequence: created.sequence };
}

type DecisionResult = SpendingDedupLinkView | SpendingPair;

async function decide(
  transaction: PGliteTransaction,
  input: SpendingDecisionInput,
  kind: "confirmed" | "denied",
  requireCurrent = false,
  sharedCommit?: CommitRef,
): Promise<DecisionResult> {
  const pair = await requirePair(transaction, input);
  if (requireCurrent) await requireCurrentPair(transaction, input);
  const decisionKey = required(input.decisionKey, "Decision key");
  const evidenceKnowledgeSequence = numberValue(input.evidenceKnowledgeSequence, "Decision evidence knowledge sequence");
  const currentKnowledge = await latest(transaction);
  if (evidenceKnowledgeSequence < 0 || evidenceKnowledgeSequence > currentKnowledge) throw new Error("Decision evidence knowledge sequence is outside canonical history.");
  const evidenceJson = stableJson(objectJson(input.evidence, "Decision evidence"), "Decision evidence");
  const previous = await txQuery<{ event_id: unknown; event_kind: string; invoice_id: unknown; transaction_id: unknown; evidence_json: string; commit_id: unknown; evidence_knowledge_sequence: number | string; decision_origin: string; user_id: string | null; authority_route: string | null; stable_cross_source_reference: string | null }>(transaction,
    "SELECT event_id, event_kind, invoice_id, transaction_id, evidence_json, commit_id, evidence_knowledge_sequence, decision_origin, user_id, authority_route, stable_cross_source_reference FROM spending_dedup_decision_events WHERE decision_key = ?",
    [decisionKey],
  );
  const prior = previous.rows[0];
  if (prior) {
    if (prior.event_kind !== kind || idString(prior.invoice_id) !== input.invoiceId || idString(prior.transaction_id) !== input.transactionId || prior.evidence_json !== evidenceJson) throw new Error("Decision key conflicts with an earlier decision.");
    if (kind === "denied") return input;
    const commitRow = await txQuery<{ commit_sequence: number | string; recorded_at_utc_us: number | string }>(transaction, "SELECT commit_sequence, recorded_at_utc_us FROM canonical_commits WHERE commit_id = ?", [prior.commit_id]);
    return {
      invoiceId: input.invoiceId,
      transactionId: input.transactionId,
      eventId: idString(prior.event_id),
      origin: prior.decision_origin as "user" | "source",
      evidenceKnowledgeSequence: numberValue(prior.evidence_knowledge_sequence, "Decision evidence sequence"),
      decisionCommitSequence: numberValue(commitRow.rows[0]?.commit_sequence, "Decision commit sequence"),
      decidedAt: recordedAtIso(commitRow.rows[0]?.recorded_at_utc_us),
      evidence: parseJson(prior.evidence_json),
      userId: prior.user_id,
      authorityRoute: prior.authority_route,
      stableCrossSourceReference: prior.stable_cross_source_reference,
    };
  }
  const activeInvoice = await txQuery(transaction, "SELECT 1 FROM current_spending_dedup_links WHERE invoice_id = ?", [pair.invoice]);
  const activeTransaction = await txQuery(transaction, "SELECT 1 FROM current_spending_dedup_links WHERE transaction_id = ?", [pair.transaction]);
  if (kind === "confirmed" && (activeInvoice.rows.length || activeTransaction.rows.length)) throw new Error("Spending deduplication is one invoice to one transaction.");
  if (kind === "denied" && (activeInvoice.rows.length || activeTransaction.rows.length)) throw new Error("An active spending link must be revoked before denial.");
  if (input.origin.kind !== "user") throw new Error("PGlite Spending user commands may only use user decision origin.");
  const userId = required(input.origin.userId, "Decision user");
  const created = sharedCommit ?? await commit(transaction, "user/local");
  const eventId = Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));
  await txQuery(
    transaction,
    `INSERT INTO spending_dedup_decision_events(
       event_id, decision_key, invoice_id, transaction_id, event_kind,
       decision_origin, user_id, authority_route, stable_cross_source_reference,
       evidence_json, evidence_knowledge_sequence, commit_id
     ) VALUES (?, ?, ?, ?, ?, 'user', ?, NULL, NULL, ?, ?, ?)`,
    [eventId, decisionKey, pair.invoice, pair.transaction, kind, userId, evidenceJson, evidenceKnowledgeSequence, created.id],
  );
  if (kind === "confirmed") {
    await txQuery(
      transaction,
      `INSERT INTO current_spending_dedup_links(invoice_id, transaction_id, confirmed_event_id, projection_commit_id)
       VALUES (?, ?, ?, ?)`,
      [pair.invoice, pair.transaction, eventId, created.id],
    );
    return {
      invoiceId: input.invoiceId,
      transactionId: input.transactionId,
      eventId: idString(eventId),
      origin: "user",
      evidenceKnowledgeSequence,
      decisionCommitSequence: created.sequence,
      decidedAt: recordedAtIso(created.recordedAtUtcUs),
      evidence: objectJson(input.evidence, "Decision evidence"),
      userId,
      authorityRoute: null,
      stableCrossSourceReference: null,
    };
  }
  return input;
}

export async function confirmPGliteSpendingDedupLink(
  transaction: PGliteTransaction,
  input: SpendingDecisionInput | SpendingDirectUserConfirmationInput,
): Promise<SpendingDedupLinkView> {
  if ("invoiceIdentityId" in input) {
    return await decide(transaction, {
      invoiceId: input.invoiceIdentityId,
      transactionId: input.transactionIdentityId,
      decisionKey: input.decisionKey,
      origin: { kind: "user", userId: input.userId },
      evidenceKnowledgeSequence: input.evidenceKnowledgeSequence,
      evidence: input.evidence,
    }, "confirmed", true) as SpendingDedupLinkView;
  }
  return await decide(transaction, input, "confirmed") as SpendingDedupLinkView;
}

export async function denyPGliteSpendingDedupCandidate(transaction: PGliteTransaction, input: SpendingDecisionInput & { origin: { kind: "user"; userId: string } }): Promise<SpendingPair> {
  return await decide(transaction, input, "denied") as SpendingPair;
}

export async function revokePGliteSpendingDedupLink(transaction: PGliteTransaction, input: SpendingDecisionInput & { origin: { kind: "user"; userId: string } }): Promise<SpendingPair> {
  const pair = await requirePair(transaction, input);
  const decisionKey = required(input.decisionKey, "Decision key");
  const prior = await txQuery<{ event_id: unknown; event_kind: string; invoice_id: unknown; transaction_id: unknown }>(transaction,
    "SELECT event_id, event_kind, invoice_id, transaction_id FROM spending_dedup_decision_events WHERE decision_key = ?",
    [decisionKey],
  );
  const existing = prior.rows[0];
  if (existing) {
    if (existing.event_kind === "revoked" && idString(existing.invoice_id) === input.invoiceId && idString(existing.transaction_id) === input.transactionId) return input;
    throw new Error("Decision key is already used.");
  }
  const active = await txQuery(transaction, "SELECT 1 FROM current_spending_dedup_links WHERE invoice_id = ? AND transaction_id = ?", [pair.invoice, pair.transaction]);
  if (active.rows.length === 0) throw new Error("Cannot revoke an inactive spending deduplication link.");
  const evidenceKnowledgeSequence = numberValue(input.evidenceKnowledgeSequence, "Decision evidence knowledge sequence");
  if (evidenceKnowledgeSequence < 0 || evidenceKnowledgeSequence > await latest(transaction)) throw new Error("Decision evidence knowledge sequence is outside canonical history.");
  const created = await commit(transaction, "user/local");
  await txQuery(
    transaction,
    `INSERT INTO spending_dedup_decision_events(
       event_id, decision_key, invoice_id, transaction_id, event_kind,
       decision_origin, user_id, authority_route, stable_cross_source_reference,
       evidence_json, evidence_knowledge_sequence, commit_id
     ) VALUES (?, ?, ?, ?, 'revoked', 'user', ?, NULL, NULL, ?, ?, ?)`,
    [Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex")), decisionKey, pair.invoice, pair.transaction, required(input.origin.userId, "Decision user"), stableJson(objectJson(input.evidence, "Decision evidence"), "Decision evidence"), evidenceKnowledgeSequence, created.id],
  );
  await txQuery(transaction, "DELETE FROM current_spending_dedup_links WHERE invoice_id = ? AND transaction_id = ?", [pair.invoice, pair.transaction]);
  return input;
}

export async function commitPGliteSpendingRefundRevision(
  transaction: PGliteTransaction,
  input: SpendingRefundRevisionInput,
): Promise<SpendingRefundView> {
  const transactionId = bytes(input.transactionId, "Refund transaction identity");
  if ((await txQuery(transaction, "SELECT 1 FROM financial_transactions WHERE transaction_id = ?", [transactionId])).rows.length === 0) throw new Error("Refund transaction identity does not exist.");
  const stableRefundKey = required(input.stableRefundKey, "Stable refund key");
  const sourceRevisionKey = required(input.sourceRevisionKey, "Refund source revision key");
  if (!Number.isSafeInteger(input.revisionNumber) || input.revisionNumber < 1) throw new Error("Refund revision number must be positive.");
  const authorityRoute = required(input.authorityRoute, "Refund source authority");
  if (/invoice.*cancel|cancel.*invoice/iu.test(authorityRoute) || ("kind" in input.evidence && String(input.evidence.kind).toLowerCase().includes("invoice-cancellation"))) throw new Error("Invoice cancellation is not refund evidence.");
  if ((await txQuery(transaction, "SELECT 1 FROM source_authority_routes WHERE authority_route = ?", [authorityRoute])).rows.length === 0) throw new Error("Refund source authority is not registered.");
  const identityRows = await txQuery<{ refund_id: unknown; transaction_id: unknown }>(transaction, "SELECT refund_id, transaction_id FROM spending_refund_identities WHERE stable_refund_key = ?", [stableRefundKey]);
  let identity = identityRows.rows[0];
  const priorRows = identity
    ? await txQuery<Row>(transaction, "SELECT * FROM spending_refund_revisions WHERE refund_id = ? AND source_revision_key = ?", [identity.refund_id, sourceRevisionKey])
    : { rows: [] as readonly Row[] };
  if (priorRows.rows[0]) {
    const recognition = await querySpendingRecognition(transaction);
    const existing = recognition.refunds.find((refund) => refund.revisionId === idString(priorRows.rows[0]!.revision_id));
    if (existing) return existing;
    const prior = priorRows.rows[0]!;
    const commitRow = await txQuery<{ commit_sequence: number | string }>(transaction, "SELECT commit_sequence FROM canonical_commits WHERE commit_id = ?", [prior.commit_id]);
    return {
      refundId: idString(prior.refund_id),
      stableRefundKey: stableRefundKey,
      transactionId: idString(identity!.transaction_id),
      revisionId: idString(prior.revision_id),
      sourceRevisionKey: storedString(prior.source_revision_key, "Refund source revision key"),
      revisionNumber: numberValue(prior.revision_number, "Refund revision number"),
      revisionKind: storedString(prior.revision_kind, "Refund revision kind") as SpendingRefundView["revisionKind"],
      state: storedString(prior.state, "Refund state") as SpendingRefundView["state"],
      amount: prior.state === "active"
        ? { coefficient: storedString(prior.amount_coefficient, "Refund amount coefficient"), scale: numberValue(prior.amount_scale, "Refund amount scale"), currency: storedString(prior.currency, "Refund currency") }
        : null,
      occurrence: prior.state === "active"
        ? { value: storedString(prior.occurrence_value, "Refund occurrence"), precision: storedString(prior.occurrence_precision, "Refund occurrence precision") as "date" | "minute" | "second", timeZone: storedString(prior.occurrence_time_zone, "Refund occurrence time zone"), basis: storedString(prior.date_basis, "Refund date basis") as "source-occurrence" | "posting-date-fallback" }
        : null,
      authorityRoute: storedString(prior.authority_route, "Refund authority route"),
      provenanceReference: storedString(prior.provenance_reference, "Refund provenance reference"),
      evidence: parseJson(prior.evidence_json),
      commitSequence: numberValue(commitRow.rows[0]?.commit_sequence, "Refund commit sequence"),
    };
  }
  const countRows = identity ? await txQuery<{ value: number | string }>(transaction, "SELECT COALESCE(MAX(revision_number), 0) AS value FROM spending_refund_revisions WHERE refund_id = ?", [identity.refund_id]) : { rows: [{ value: 0 }] };
  const count = Number(countRows.rows[0]?.value ?? 0);
  if (input.revisionNumber !== count + 1) throw new Error("Refund revisions must be contiguous.");
  if (identity && idString(identity.transaction_id) !== input.transactionId) throw new Error("Refund revision cannot move to a replacement transaction identity.");
  const revoked = input.revisionKind === "revoked";
  if (revoked && count === 0) throw new Error("Cannot revoke an unknown refund.");
  if (!revoked && (!input.amount || !input.occurrence)) throw new Error("Active refund requires amount and occurrence facts.");
  const exactAmount = revoked ? null : exactRefundCoefficient(input.amount!.coefficient, input.amount!.scale);
  const amountCoefficient = exactAmount?.coefficient ?? null;
  if (amountCoefficient !== null && !amountCoefficient.startsWith("-") && amountCoefficient !== "0") throw new Error("Refund recognition amount must be negative.");
  const created = await commit(transaction, authorityRoute);
  if (!identity) {
    const refundId = Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));
    await txQuery(transaction, "INSERT INTO spending_refund_identities(refund_id, transaction_id, stable_refund_key, created_commit_id) VALUES (?, ?, ?, ?)", [refundId, transactionId, stableRefundKey, created.id]);
    identity = { refund_id: refundId, transaction_id: transactionId };
  }
  const revisionId = Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));
  await txQuery(
    transaction,
    `INSERT INTO spending_refund_revisions(
       revision_id, refund_id, source_revision_key, revision_number,
       revision_kind, state, amount_coefficient, amount_scale, currency,
       occurrence_value, occurrence_precision, occurrence_time_zone, date_basis,
       authority_route, provenance_reference, evidence_json, commit_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [revisionId, identity.refund_id, sourceRevisionKey, input.revisionNumber, input.revisionKind, revoked ? "revoked" : "active", amountCoefficient, exactAmount?.scale ?? null, revoked ? null : required(input.amount!.currency, "Refund currency"), revoked ? null : required(input.occurrence!.value, "Refund occurrence"), revoked ? null : input.occurrence!.precision, revoked ? null : required(input.occurrence!.timeZone, "Refund occurrence time zone"), revoked ? null : input.occurrence!.basis, authorityRoute, required(input.provenanceReference, "Refund provenance reference"), stableJson(objectJson(input.evidence, "Refund evidence"), "Refund evidence"), created.id],
  );
  const recognition = await querySpendingRecognition(transaction, { knowledgeAt: created.sequence });
  const result = recognition.refunds.find((refund) => refund.revisionId === idString(revisionId));
  if (!result) throw new Error("Committed refund revision cannot be read back.");
  return result;
}

/**
 * Apply a visible month-page decision without rebuilding the 100k-row report.
 * Pair facts, candidate identity, and the data version are all revalidated in
 * the write transaction. The returned compact page is captured at the commit
 * version; the renderer then reloads only its visible month records.
 */
export async function applyPGliteSpendingPageAction(
  writer: PGliteSpendingWriter,
  input: SpendingPageActionRequest,
): Promise<SpendingPageActionResult> {
  const result = await writer.transaction(async (transaction) => {
    const current = await latest(transaction);
    if (!Number.isSafeInteger(input.dataVersion) || input.dataVersion !== current)
      throw new Error("Spending action data version is stale; reload Spending before pairing.");

    let summaryBefore: readonly SpendingSummaryDeltaLine[] = Object.freeze([]);
    if (input.kind === "revoke") {
      const beforeRecords = await queryCurrentSpendingActionRecords(transaction, {
        knowledgeAt: current,
        invoiceIdentityId: input.invoiceIdentityId,
        transactionIdentityId: input.transactionIdentityId,
      });
      const linkedRecord = beforeRecords.find((record) => record.basis === "linked");
      if (!linkedRecord) throw new Error("Spending revoke selection is stale or no longer linked.");
      summaryBefore = Object.freeze([summaryLineFromRecord(linkedRecord)]);
      await revokePGliteSpendingDedupLink(transaction, {
        invoiceId: input.invoiceIdentityId,
        transactionId: input.transactionIdentityId,
        decisionKey: `spending/user/revoke/${input.invoiceIdentityId}/${input.transactionIdentityId}/${current}`,
        origin: { kind: "user", userId: LOCAL_USER_ID },
        evidenceKnowledgeSequence: current,
        evidence: { reason: "user-revoked-link" },
      });
    } else if (input.kind === "direct") {
      const { invoice, payment } = await queryPGliteSpendingDirectPair(
        transaction,
        input.invoiceIdentityId,
        input.transactionIdentityId,
        current,
      );
      summaryBefore = await standaloneSummaryLines(transaction, invoice, payment);
      await confirmPGliteSpendingDedupLink(transaction, {
        invoiceIdentityId: input.invoiceIdentityId,
        transactionIdentityId: input.transactionIdentityId,
        decisionKey: `spending/user/direct/${input.invoiceIdentityId}/${input.transactionIdentityId}/${current}`,
        userId: LOCAL_USER_ID,
        evidenceKnowledgeSequence: current,
        evidence: {
          decisionOrigin: "explicit-user-selection",
          invoice: { identityId: invoice.invoiceId, date: invoice.revision.occurrence.value, amount: invoice.revision.total, label: invoice.revision.seller.name },
          payment: { identityId: payment.transactionId, date: payment.effectiveOn, consumeDate: payment.consumeDate ?? null, postingDate: payment.postingDate ?? null, dateBasis: payment.effectiveDateBasis ?? "effective-date", amount: payment.amount, label: payment.description },
        },
      });
    } else {
      const resolved = await resolvePGliteSpendingCandidate(transaction, input.candidateId, {
        invoiceId: input.invoiceIdentityId,
        transactionId: input.transactionIdentityId,
      });
      if (input.action === "confirm") {
        const { invoice, payment } = await queryPGliteSpendingDirectPair(
          transaction,
          input.invoiceIdentityId,
          input.transactionIdentityId,
          current,
        );
        summaryBefore = await standaloneSummaryLines(transaction, invoice, payment);
      }
      const materialized = await recordPGliteSpendingMatchCandidate(transaction, {
        invoiceId: resolved.candidate.invoiceId,
        transactionId: resolved.candidate.transactionId,
        candidateKey: resolved.candidate.candidateKey,
        algorithm: resolved.candidate.algorithm,
        algorithmVersion: resolved.candidate.algorithmVersion,
        similarityEvidence: resolved.candidate.similarityEvidence,
      });
      const decision: SpendingDecisionInput = {
        invoiceId: resolved.candidate.invoiceId,
        transactionId: resolved.candidate.transactionId,
        decisionKey: `spending/user/${input.action}/${resolved.candidate.candidateKey}`,
        origin: { kind: "user", userId: LOCAL_USER_ID },
        evidenceKnowledgeSequence: Math.max(current, materialized.commitSequence),
        evidence: {
          candidateKey: resolved.candidate.candidateKey,
          algorithm: resolved.candidate.algorithm,
          algorithmVersion: resolved.candidate.algorithmVersion,
          similarityEvidence: resolved.candidate.similarityEvidence,
          decisionOrigin: "local-user",
        },
      };
      if (input.action === "confirm") await confirmPGliteSpendingDedupLink(transaction, decision);
      else await denyPGliteSpendingDedupCandidate(transaction, decision as SpendingDecisionInput & { origin: { kind: "user"; userId: string } });
    }

    const knowledgeAt = await latest(transaction);
    const affectedRecords = await queryCurrentSpendingActionRecords(transaction, {
      knowledgeAt,
      invoiceIdentityId: input.invoiceIdentityId,
      transactionIdentityId: input.transactionIdentityId,
    });
    const summaryAfter = input.action === "deny"
      ? Object.freeze([])
      : Object.freeze(affectedRecords.map(summaryLineFromRecord));
    if (input.action === "confirm" && !affectedRecords.some((record) => record.basis === "linked"))
      throw new Error("Spending confirmation did not produce its linked record.");
    if (input.action === "revoke" && affectedRecords.some((record) => record.basis === "linked"))
      throw new Error("Spending revoke did not restore standalone records.");
    return Object.freeze({
      action: input.action,
      kind: input.kind,
      baseKnowledgeAt: current,
      knowledgeAt,
      invoiceIdentityId: input.invoiceIdentityId,
      transactionIdentityId: input.transactionIdentityId,
      summaryDelta: Object.freeze({ before: summaryBefore, after: summaryAfter }),
      affectedRecords,
    });
  });
  return result;
}

function summaryLine(
  date: string,
  amount: Readonly<{ currency: string; coefficient: string; scale: number }> | null,
  category: PurchaseCategory,
): SpendingSummaryDeltaLine {
  return Object.freeze({ date: date.slice(0, 10), amount, category });
}

function summaryLineFromRecord(
  record: SpendingPageActionResult["affectedRecords"][number],
): SpendingSummaryDeltaLine {
  return summaryLine(record.occurrence.value, record.amount
    ? { currency: record.amount.currency, coefficient: record.amount.coefficient, scale: record.amount.scale }
    : null, record.category);
}

/**
 * The invoice-only and bank-only lines a direct confirmation replaces, with
 * their Purchase categories. The bank line is dated by the purchase date the
 * summary buckets it under (consume, then posting, then effective date).
 */
async function standaloneSummaryLines(
  transaction: PGliteTransaction,
  invoice: Awaited<ReturnType<typeof queryPGliteSpendingDirectPair>>["invoice"],
  payment: Awaited<ReturnType<typeof queryPGliteSpendingDirectPair>>["payment"],
): Promise<readonly SpendingSummaryDeltaLine[]> {
  const itemCategorizations = (await itemCategorizationRows(transaction, [invoice.invoiceId])).get(invoice.invoiceId) ?? [];
  const invoiceAmount = invoice.revision.total
    ? { currency: invoice.revision.total.currency, coefficient: invoice.revision.total.coefficient, scale: invoice.revision.total.scale }
    : null;
  return Object.freeze([
    summaryLine(invoice.revision.occurrence.value, invoiceAmount,
      purchaseRecordCategory({ basis: "invoice", amount: invoiceAmount, invoice, transaction: null, itemCategorizations })),
    summaryLine(transactionPurchaseDate(payment).value, payment.amount,
      purchaseRecordCategory({ basis: "bank-transaction", amount: payment.amount, invoice: null, transaction: payment, itemCategorizations: [] })),
  ]);
}

function strongConfirmPairs(input: SpendingStrongConfirmRequest): readonly SpendingCandidatePairRef[] {
  if (!input || typeof input !== "object" || !Array.isArray(input.pairs) || input.pairs.length === 0)
    throw new TypeError("Strong-match confirmation needs at least one shown pair.");
  if (!Number.isSafeInteger(input.shownKnowledgeAt) || input.shownKnowledgeAt < 0)
    throw new TypeError("Strong-match confirmation shown data version is invalid.");
  const pairs = input.pairs.map((pair) => Object.freeze({
    candidateId: required(pair?.candidateId, "Candidate id"),
    invoiceIdentityId: idString(bytes(pair?.invoiceIdentityId, "Invoice identity")),
    transactionIdentityId: idString(bytes(pair?.transactionIdentityId, "Transaction identity")),
  }));
  const keys = new Set(pairs.map((pair) => `${pair.invoiceIdentityId}/${pair.transactionIdentityId}`));
  if (keys.size !== pairs.length) throw new TypeError("Strong-match confirmation lists a pair twice.");
  return pairs;
}

/**
 * Confirm every shown strong pair in one commit, or none. The strong set is
 * recomputed inside the write transaction; a shown pair that is no longer
 * pending or no longer strong rejects the whole batch without a write and
 * returns the recomputed strong set. Other commits since the pairs were shown
 * do not reject by themselves.
 */
export function confirmPGliteSpendingStrongCandidates(
  writer: PGliteSpendingWriter,
  input: SpendingStrongConfirmRequest,
): Promise<SpendingStrongConfirmResult> {
  const shown = strongConfirmPairs(input);
  return writer.transaction(async (transaction) => {
    const base = await latest(transaction);
    if (input.shownKnowledgeAt > base) throw new Error("Strong-match confirmation shown data version is in the future.");
    const pending = await queryPendingSpendingCandidates(transaction, base);
    const month = input.month ?? null;
    const strong = pending.pairs.filter((pair) => pair.strength === "strong" && (month === null || pendingPairInMonth(pair, month)));
    const strongByPair = new Map(strong.map((pair) => [`${pair.invoiceId}/${pair.transactionId}`, pair]));
    const conflicts = shown.filter((pair) => !strongByPair.has(`${pair.invoiceIdentityId}/${pair.transactionIdentityId}`));
    if (conflicts.length > 0) {
      return Object.freeze({
        status: "conflict" as const,
        knowledgeAt: base,
        conflicts: Object.freeze(conflicts),
        strongPairs: Object.freeze(strong.map(pendingPairRef)),
      });
    }
    const created = await commit(transaction, "user/local");
    const confirmed: (SpendingCandidatePairRef & Readonly<{ eventId: string }>)[] = [];
    for (const shownPair of shown) {
      const pair = strongByPair.get(`${shownPair.invoiceIdentityId}/${shownPair.transactionIdentityId}`)!;
      const link = await decide(transaction, {
        invoiceId: pair.invoiceId,
        transactionId: pair.transactionId,
        decisionKey: `spending/user/confirmed/${pair.candidateId}`,
        origin: { kind: "user", userId: LOCAL_USER_ID },
        evidenceKnowledgeSequence: base,
        evidence: {
          decisionOrigin: "strong-match-batch",
          candidateKey: pair.candidateId,
          algorithm: pair.algorithm,
          algorithmVersion: pair.algorithmVersion,
          similarityEvidence: pair.similarityEvidence,
          strength: pair.strength,
          reasons: pair.reasons,
          shownKnowledgeAt: input.shownKnowledgeAt,
        },
      }, "confirmed", false, created) as SpendingDedupLinkView;
      if (link.decisionCommitSequence !== created.sequence)
        throw new Error("Strong-match confirmation reused an earlier decision.");
      confirmed.push(Object.freeze({ ...pendingPairRef(pair), eventId: link.eventId }));
    }
    return Object.freeze({
      status: "committed" as const,
      baseKnowledgeAt: base,
      knowledgeAt: created.sequence,
      confirmed: Object.freeze(confirmed),
    });
  });
}

/**
 * Worker-facing command facade. Every method opens one adapter transaction;
 * callers never receive a synchronous database handle or a partially applied
 * Spending mutation.
 */
export function createPGliteSpendingCommands(writer: PGliteSpendingWriter) {
  return Object.freeze({
    recordMatchCandidate: (input: SpendingCandidateInput) => writer.transaction((transaction) => recordPGliteSpendingMatchCandidate(transaction, input)),
    confirmDedupLink: (input: SpendingDecisionInput | SpendingDirectUserConfirmationInput) => writer.transaction((transaction) => confirmPGliteSpendingDedupLink(transaction, input)),
    denyDedupCandidate: (input: SpendingDecisionInput & { origin: { kind: "user"; userId: string } }) => writer.transaction((transaction) => denyPGliteSpendingDedupCandidate(transaction, input)),
    revokeDedupLink: (input: SpendingDecisionInput & { origin: { kind: "user"; userId: string } }) => writer.transaction((transaction) => revokePGliteSpendingDedupLink(transaction, input)),
    commitRefundRevision: (input: SpendingRefundRevisionInput) => writer.transaction((transaction) => commitPGliteSpendingRefundRevision(transaction, input)),
    pageAction: (input: SpendingPageActionRequest) => applyPGliteSpendingPageAction(writer, input),
    setPurchaseCategory: (input: SpendingPurchaseCategoryRequest) => setPGliteSpendingPurchaseCategory(writer, input),
    confirmStrongCandidates: (input: SpendingStrongConfirmRequest) => confirmPGliteSpendingStrongCandidates(writer, input),
  });
}

export type PGliteSpendingCommands = ReturnType<typeof createPGliteSpendingCommands>;
