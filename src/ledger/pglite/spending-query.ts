import { SpendingPageVersionError } from "../../lib/spending/page-reader.ts";
import { COUNTED_ACCOUNT_SQL, readPGliteCoveredAccountIds } from "./direct-source-precedence.ts";
import { createHash } from "node:crypto";
import type {
  CanonicalEInvoiceLineageQuery,
  CanonicalEInvoiceView,
} from "../canonical/einvoice-query-contract.ts";
import type { CanonicalSpendingTransaction } from "../canonical/canonical-spending-contracts.ts";
import type {
  SpendingCandidateView,
  SpendingRecognitionSnapshot,
  SpendingRefundView,
} from "../canonical/spending-recognition-contracts.ts";
import {
  evaluateSpendingMatchCandidates,
  type PurchaseReport,
} from "../canonical/spending-purchase-report-core.ts";
import type { PurchaseLineage } from "../canonical/spending-purchase-contracts.ts";
import type { LineageSpendingQueryResult } from "../../lib/shared-ledger/server/financial-query-contracts.ts";
import type {
  SpendingCandidatePageRequest,
  SpendingCandidatePageDto,
  SpendingCandidatePairRef,
  SpendingPendingOverviewDto,
  SpendingPendingOverviewRequest,
  SpendingMergeLogDto,
  SpendingMergeLogEntry,
  SpendingMergeLogRequest,
  SpendingMerchantStatsDto,
  SpendingMerchantStatsRequest,
  SpendingMonthInsightDto,
  SpendingMonthInsightRequest,
  SpendingPairingCandidatesInput,
  SpendingPairingCandidatesResult,
  SpendingRecordPageRequest,
} from "../../lib/spending/model.ts";
import { createSpendingPairingCandidateViewFromTransaction } from "../../lib/spending/pairing-presentation.ts";
import {
  calendarDayNumber,
  exactMoneyKey,
  type SpendingMatchingInvoice,
  type SpendingMatchingTransaction,
} from "../../lib/spending/purchase-matching.ts";
import {
  createSpendingManualPairingIndex,
  spendingManualPaymentRanking,
  type SpendingManualPaymentCandidate,
} from "../canonical/spending-manual-pairing.ts";
import {
  largestPurchasesByCurrency,
  merchantLabel,
  sameMerchantStats,
  type MonthPurchaseFact,
} from "../canonical/spending-month-insights.ts";
import {
  classifyPendingCandidates,
  type ClassifiedPendingCandidate,
  type PendingCandidateFacts,
} from "../canonical/spending-match-strength.ts";
import { moneyTotals } from "../../lib/shared-money/exact-money.ts";
import {
  invoiceViewFromRow,
  invoices,
  linkFromRow,
  queryCurrentTransactionById,
  queryPaymentSourceFacts,
  querySpendingRecognition,
  recordedAtIso,
  refundFromRow,
} from "./spending-facts.ts";
import {
  purchaseRecordsByIdentity,
  queryCurrentSpending,
  queryCurrentSpendingRecordPage,
  queryCurrentSpendingSummary,
  queryCurrentSpendingSummaryPage,
  queryHistoricalSpending,
  queryMonthPurchaseFacts,
  validSpendingMonth,
  type MonthPurchaseFactsReader,
} from "./purchase-report.ts";
import {
  bytes,
  exactMoney,
  HEX_ID,
  idString,
  jsonValue,
  latest,
  nullableString,
  numeric,
  optionalMoney,
  pairKey,
  pgliteQuery,
  rows,
  stringValue,
  UUID,
  type Money,
  type PGliteSpendingReader,
  type PGliteSpendingStore,
  type Row,
} from "./spending-sql.ts";

export type { PGliteSpendingReader, PGliteSpendingStore } from "./spending-sql.ts";
export { recordedAtIso, querySpendingRecognition } from "./spending-facts.ts";

/**
 * PGlite Spending reads outside the Purchase report: candidate resolution,
 * pending pairs, Pairing ranking, lineage, the merge log, and the facade the
 * worker registry calls. Purchase-basis reads live in purchase-report.ts.
 */

/** Read and validate one direct selection inside the caller's write snapshot. */
export async function queryPGliteSpendingDirectPair(
  reader: PGliteSpendingReader,
  invoiceId: string,
  transactionId: string,
  knowledgeAt: number,
): Promise<Readonly<{ invoice: CanonicalEInvoiceView; payment: CanonicalSpendingTransaction }>> {
  const [invoice] = await invoices(reader, knowledgeAt, false, invoiceId);
  if (!invoice || invoice.revision.state !== "active" || invoice.revision.total === null)
    throw new Error("Spending invoice selection is stale, linked, revoked, or missing.");
  const payment = await queryCurrentTransactionById(reader, knowledgeAt, transactionId);
  if (!payment) throw new Error("Spending payment selection is stale, linked, or ineligible.");
  const linked = rows(await pgliteQuery<Row>(reader,
    `SELECT 1 FROM current_spending_dedup_links
      WHERE invoice_id = ? OR transaction_id = ? LIMIT 1`,
    [bytes(invoiceId, "Invoice identity"), bytes(transactionId, "Transaction identity")],
  ));
  if (linked.length > 0) throw new Error("Spending selection is already linked.");
  return { invoice, payment };
}

type DeterministicCandidatePairRow = PendingCandidateFacts & Readonly<{
  candidateId: string;
  invoiceDate: string;
  transactionDate: string;
  amount: Money;
  algorithm: string;
  algorithmVersion: string;
  similarityEvidence: Readonly<Record<string, unknown>>;
}>;

function deterministicCandidateKey(invoiceId: string, transactionId: string): string {
  return `sha256:${createHash("sha256").update(`${invoiceId}/${transactionId}`).digest("base64url")}`;
}

/**
 * Return every pair that satisfies the canonical inferred candidate rule:
 * exact amount and currency, at most seven calendar days apart. The candidate
 * id is a one-way digest, so an ephemeral id cannot be looked up by itself.
 * Read the two indexed current projections separately, bucket transactions by
 * exact money, and apply the seven-day window in JavaScript. This avoids an
 * invoice-by-transaction numeric join over the whole benchmark fixture while
 * retaining the canonical matcher as the final validator for actions.
 */
async function queryDeterministicCandidatePairs(
  reader: PGliteSpendingReader,
  pairingTransactions?: readonly PairingTransaction[],
): Promise<readonly DeterministicCandidatePairRow[]> {
  const invoiceRows = rows(await pgliteQuery<Row>(reader,
    `WITH ranked AS (
       SELECT revision.invoice_id, revision.amount_coefficient,
              revision.amount_scale, revision.currency,
              revision.occurrence_value, revision.occurrence_origin,
              revision.seller_name, revision.state,
              ROW_NUMBER() OVER (
                PARTITION BY revision.invoice_id
                ORDER BY revision.revision_number DESC,
                         commit_row.commit_sequence DESC,
                         revision.revision_id DESC
              ) AS revision_rank
         FROM einvoice_invoice_revisions revision
         JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
     )
     SELECT invoice_id, amount_coefficient, amount_scale, currency,
            occurrence_value, occurrence_origin, seller_name
       FROM ranked
      WHERE revision_rank = 1 AND state = 'active' AND amount_coefficient IS NOT NULL`,
  ));
  const transactions = pairingTransactions ?? await queryPairingTransactionsDirect(reader);
  // Parse each date once; the loop below compares every invoice with every same-amount payment.
  const byMoney = new Map<string, { transaction: PairingTransaction; date: string; day: number }[]>();
  for (const transaction of transactions) {
    const key = exactMoneyKey(transaction.amount);
    const date = transaction.consumeDate ?? transaction.postingDate ?? transaction.effectiveOn;
    const entry = { transaction, date, day: calendarDayNumber(date) };
    const bucket = byMoney.get(key);
    if (bucket) bucket.push(entry);
    else byMoney.set(key, [entry]);
  }
  const pairs: DeterministicCandidatePairRow[] = [];
  for (const row of invoiceRows) {
    const amount = exactMoney(row, "amount_coefficient", "amount_scale", "currency");
    const invoiceId = idString(row.invoice_id, "Candidate invoice");
    const invoiceDate = stringValue(row.occurrence_value, "Candidate invoice occurrence");
    const invoiceDateBasis = row.occurrence_origin === "source-reported" ? "purchase-date" as const : "posting-date-fallback" as const;
    const invoiceDay = calendarDayNumber(invoiceDate);
    if (!Number.isFinite(invoiceDay)) continue;
    const candidates = byMoney.get(exactMoneyKey(amount)) ?? [];
    for (const { transaction, date: transactionDate, day } of candidates) {
      const dateDistanceDays = Math.abs(invoiceDay - day);
      if (!Number.isFinite(dateDistanceDays) || dateDistanceDays > 7) continue;
      pairs.push(Object.freeze({
        invoiceId,
        transactionId: transaction.transactionId,
        candidateId: deterministicCandidateKey(invoiceId, transaction.transactionId),
        invoiceDate,
        transactionDate,
        dayDistance: dateDistanceDays,
        invoiceDateBasis,
        transactionDateBasis: transaction.consumeDate ? "purchase-date" as const : "posting-date-fallback" as const,
        sellerName: nullableString(row.seller_name),
        bankDescription: transaction.description,
        amount,
        algorithm: "amount-currency-date-similarity",
        algorithmVersion: "v2",
        similarityEvidence: Object.freeze({
          exactAmountAndCurrency: true,
          calendarDayDistance: dateDistanceDays,
          transactionDateBasis: transaction.consumeDate ? "consume-date" : transaction.postingDate ? "posting-date-fallback" : "effective-date",
        }),
      }));
    }
  }
  pairs.sort((left, right) => left.dayDistance - right.dayDistance || left.invoiceId.localeCompare(right.invoiceId) || left.transactionId.localeCompare(right.transactionId));
  return Object.freeze(pairs);
}

export type PGliteSpendingCandidateResolution = Readonly<{
  knowledgeAt: number;
  candidate: Readonly<{
    invoiceId: string;
    transactionId: string;
    candidateKey: string;
    algorithm: string;
    algorithmVersion: string;
    similarityEvidence: Readonly<Record<string, unknown>>;
  }>;
  durableCandidate: SpendingCandidateView | null;
  invoice: CanonicalEInvoiceView;
  transaction: CanonicalSpendingTransaction;
}>;

/**
 * Resolve a candidate without opening the complete current purchase report.
 * Durable UUID ids are direct indexed reads.  Ephemeral ids are SHA-256 keys,
 * so the bounded exact amount/date SQL search is followed by the canonical
 * pure matcher and digest check.  This preserves duplicate and stale-pair
 * validation while avoiding an invoice-by-transaction JavaScript scan.
 */
export async function resolvePGliteSpendingCandidate(
  reader: PGliteSpendingReader,
  candidateId: string,
  pairHint?: Readonly<{ invoiceId: string; transactionId: string }>,
): Promise<PGliteSpendingCandidateResolution> {
  const cleanCandidateId = candidateId.trim();
  const knowledgeAt = await latest(reader);
  let durableRow: Row | undefined;
  if (UUID.test(cleanCandidateId) || HEX_ID.test(cleanCandidateId)) {
    durableRow = rows(await pgliteQuery<Row>(reader,
      `SELECT candidate_id, candidate_key, invoice_id, transaction_id,
              algorithm, algorithm_version, similarity_evidence_json
         FROM spending_match_candidates
        WHERE candidate_id = ?`,
      [bytes(cleanCandidateId, "Candidate identity")],
    ))[0];
  }
  let invoiceId: string;
  let transactionId: string;
  if (durableRow) {
    invoiceId = idString(durableRow.invoice_id, "Candidate invoice");
    transactionId = idString(durableRow.transaction_id, "Candidate transaction");
    if (pairHint && (pairHint.invoiceId !== invoiceId || pairHint.transactionId !== transactionId))
      throw new Error("Spending candidate hint does not match its durable identity.");
  } else {
    if (!cleanCandidateId.startsWith("sha256:")) throw new Error("Spending candidate is stale or missing.");
    if (pairHint) {
      if (deterministicCandidateKey(pairHint.invoiceId, pairHint.transactionId) !== cleanCandidateId)
        throw new Error("Spending candidate hint does not match its identity.");
      invoiceId = pairHint.invoiceId;
      transactionId = pairHint.transactionId;
    } else {
      const matches = (await queryDeterministicCandidatePairs(reader)).filter((pair) =>
        deterministicCandidateKey(pair.invoiceId, pair.transactionId) === cleanCandidateId,
      );
      if (matches.length === 0) throw new Error("Spending candidate is stale or missing.");
      if (matches.length > 1) throw new Error("Spending candidate is ambiguous.");
      invoiceId = matches[0]!.invoiceId;
      transactionId = matches[0]!.transactionId;
    }
  }
  const [invoice, transaction] = await Promise.all([
    invoices(reader, knowledgeAt, false, invoiceId),
    queryCurrentTransactionById(reader, knowledgeAt, transactionId),
  ]);
  const selectedInvoice = invoice[0];
  if (!selectedInvoice || selectedInvoice.revision.state !== "active" || selectedInvoice.revision.total === null || !transaction) {
    throw new Error("Spending candidate no longer matches current canonical facts.");
  }
  const deterministic = evaluateSpendingMatchCandidates([selectedInvoice], [transaction]);
  if (deterministic.length !== 1) throw new Error("Spending candidate no longer matches current canonical facts.");
  const match = deterministic[0]!;
  const recognition = await queryPGliteSpendingRecognitionPair(reader, { invoiceId, transactionId, knowledgeAt });
  const durableCandidate = durableRow
    ? recognition.candidates.find((candidate) => candidate.candidateId === cleanCandidateId) ?? {
        invoiceId,
        transactionId,
        candidateId: cleanCandidateId,
        algorithm: stringValue(durableRow.algorithm, "Candidate algorithm"),
        algorithmVersion: stringValue(durableRow.algorithm_version, "Candidate algorithm version"),
        similarityEvidence: jsonValue(durableRow.similarity_evidence_json, "Candidate similarity evidence"),
        status: "candidate" as const,
      }
    : null;
  if (durableCandidate && durableCandidate.status !== "candidate") throw new Error("Spending candidate is no longer pending.");
  if (cleanCandidateId.startsWith("sha256:") && recognition.candidates.some((candidate) =>
    candidate.invoiceId === invoiceId && candidate.transactionId === transactionId && candidate.status !== "candidate")) {
    throw new Error("Spending candidate is no longer pending.");
  }
  return Object.freeze({ knowledgeAt, candidate: match, durableCandidate, invoice: selectedInvoice, transaction });
}

type PairingTransaction = SpendingMatchingTransaction & Readonly<{
  stream: string;
  effectiveDateBasis: "consume-date" | "posting-date-fallback" | null;
}>;

/** Read eligible transaction facts from the transactional derived projection. */
async function queryPairingTransactionsDirect(
  reader: PGliteSpendingReader,
  dateBounds?: Readonly<{ start: string; end: string }>,
): Promise<readonly PairingTransaction[]> {
  // One JSON result avoids PGlite's per-row wire parser cost for the 100k
  // supported dataset. The source-neutral ranker below still orders every
  // candidate; SQL only transports current facts without truncating them.
  const packed = await pgliteQuery<{ packed: unknown }>(reader,
    `SELECT json_agg(json_build_array(encode(transaction_id, 'hex'), effective_on,
      description, amount_coefficient, amount_scale, currency,
      consume_date, posting_date, effective_date_basis)) AS packed
       FROM current_spending_pairing_entries entry
      WHERE NOT EXISTS (
              SELECT 1 FROM financial_transactions identity
               WHERE identity.transaction_id = entry.transaction_id AND NOT (${COUNTED_ACCOUNT_SQL("identity.account_id")})
            )
        ${dateBounds ? "AND SUBSTRING(COALESCE(consume_date, posting_date, effective_on), 1, 10) BETWEEN ? AND ?" : ""}`,
    [await readPGliteCoveredAccountIds(reader, await latest(reader)), ...(dateBounds ? [dateBounds.start, dateBounds.end] : [])],
  );
  const value = packed.rows[0]?.packed;
  const resultRows = (Array.isArray(value) ? value : JSON.parse(String(value ?? "[]"))) as readonly (readonly unknown[])[];
  const transactions = Object.freeze(resultRows.map((row) => {
    return Object.freeze({
      transactionId: idString(row[0], "Pairing transaction identity"),
      effectiveOn: stringValue(row[1], "Pairing effective date"),
      consumeDate: nullableString(row[6]),
      postingDate: nullableString(row[7]),
      description: nullableString(row[2]),
      amount: {
        coefficient: stringValue(row[3], "Pairing amount coefficient"),
        scale: numeric(row[4], "Pairing amount scale"),
        currency: stringValue(row[5], "Pairing amount currency"),
      },
      stream: "",
      effectiveDateBasis: row[8] === "consume-date" || row[8] === "posting-date-fallback"
        ? row[8]
        : null,
    } satisfies PairingTransaction);
  }));
  return transactions;
}

async function pairingPresentationStreams(
  reader: PGliteSpendingReader,
  transactionIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (transactionIds.length === 0) return new Map();
  const placeholders = transactionIds.map(() => "?").join(", ");
  const result = await pgliteQuery<Row>(reader,
    `SELECT transaction_row.transaction_id, account.stream
       FROM financial_transactions transaction_row
       JOIN financial_accounts account ON account.account_id = transaction_row.account_id
      WHERE transaction_row.transaction_id IN (${placeholders})`,
    transactionIds.map((id) => bytes(id, "Pairing transaction identity")),
  );
  return new Map(rows(result).map((row) => [
    idString(row.transaction_id, "Pairing transaction identity"),
    stringValue(row.stream, "Pairing transaction stream"),
  ]));
}

/**
 * Read only recognition rows for one pair.  Recognition-only report patches
 * use this narrow view after a command; unrelated candidates and refunds are
 * already present in the immutable pre-command report and do not need to be
 * rescanned from the database.
 */
export async function queryPGliteSpendingRecognitionPair(
  reader: PGliteSpendingReader,
  request: Readonly<{ invoiceId: string; transactionId: string; knowledgeAt?: number }>,
): Promise<SpendingRecognitionSnapshot> {
  const current = await latest(reader);
  const cutoff = request.knowledgeAt ?? current;
  if (!Number.isSafeInteger(cutoff) || cutoff < 0 || cutoff > current) throw new Error("Spending recognition knowledge cutoff is invalid.");
  const invoiceId = bytes(request.invoiceId, "Recognition invoice");
  const transactionId = bytes(request.transactionId, "Recognition transaction");
  const eventRows = rows(await pgliteQuery<Row>(reader,
    `SELECT event.*, commit_row.commit_sequence, commit_row.recorded_at_utc_us
       FROM spending_dedup_decision_events event
       JOIN canonical_commits commit_row ON commit_row.commit_id = event.commit_id
      WHERE event.invoice_id = ? AND event.transaction_id = ?
        AND commit_row.commit_sequence <= ?
      ORDER BY commit_row.commit_sequence DESC, event.event_id DESC
      LIMIT 1`,
    [invoiceId, transactionId, cutoff],
  ));
  const candidateRows = rows(await pgliteQuery<Row>(reader,
    `SELECT candidate.*, created.commit_sequence
       FROM spending_match_candidates candidate
       JOIN canonical_commits created ON created.commit_id = candidate.created_commit_id
      WHERE candidate.invoice_id = ? AND candidate.transaction_id = ?
        AND created.commit_sequence <= ?
      ORDER BY created.commit_sequence, candidate.candidate_id`,
    [invoiceId, transactionId, cutoff],
  ));
  const event = eventRows[0];
  const invoiceText = idString(invoiceId, "Recognition invoice");
  const transactionText = idString(transactionId, "Recognition transaction");
  const eventKind = event ? stringValue(event.event_kind, "Recognition event kind") as SpendingCandidateView["status"] : null;
  const candidates = candidateRows.map((row) => ({
    invoiceId: invoiceText,
    transactionId: transactionText,
    candidateId: idString(row.candidate_id, "Candidate identity"),
    algorithm: stringValue(row.algorithm, "Candidate algorithm"),
    algorithmVersion: stringValue(row.algorithm_version, "Candidate algorithm version"),
    similarityEvidence: jsonValue(row.similarity_evidence_json, "Candidate similarity evidence"),
    status: eventKind ?? "candidate",
  } satisfies SpendingCandidateView));
  return Object.freeze({
    knowledgeAt: cutoff,
    candidates: Object.freeze(candidates),
    activeLinks: Object.freeze(eventKind === "confirmed" && event ? [linkFromRow(event)] : []),
    denied: Object.freeze(eventKind === "denied" ? [{ invoiceId: invoiceText, transactionId: transactionText }] : []),
    refunds: Object.freeze([]),
  });
}

export type PGliteSpendingLineageRequest = Readonly<{
  subject: Readonly<{ kind: "spending-pair" | "refund"; id: string }>;
}>;

async function invoiceLineage(
  reader: PGliteSpendingReader,
  invoiceId: string,
): Promise<CanonicalEInvoiceLineageQuery | null> {
  const sourceRows = rows(await pgliteQuery<Row>(reader,
    `SELECT revision.revision_id, revision.invoice_id, revision.source_record_id,
            revision.capture_id, revision.source_revision_key, revision.revision_number,
            revision.revision_kind, revision.state, revision.invoice_number,
            revision.random_number, revision.seller_tax_id, revision.seller_name,
            revision.amount_coefficient, revision.amount_scale, revision.currency,
            revision.currency_authority, revision.occurrence_value,
            revision.occurrence_precision, revision.occurrence_time_zone,
            revision.occurrence_origin, revision.authority_route,
            revision.contract_version, revision.provenance_kind,
            revision.provenance_reference, revision.provenance_source_field,
            revision.revocation_reason, invoice.stable_invoice_key,
            connection_scope.source_connection_key,
            epoch.epoch_key AS identity_epoch_key,
            subject.subject_digest, capture.capture_key,
            commit_row.commit_sequence
       FROM einvoice_invoice_revisions revision
       JOIN einvoice_invoices invoice ON invoice.invoice_id = revision.invoice_id
       JOIN source_connections connection_scope ON connection_scope.source_connection_id = invoice.source_connection_id
       JOIN identity_epochs epoch ON epoch.identity_epoch_id = invoice.identity_epoch_id
       JOIN source_subjects subject ON subject.source_subject_id = invoice.source_subject_id
       JOIN source_captures capture ON capture.capture_id = revision.capture_id
       JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
      WHERE revision.invoice_id = ?
      ORDER BY revision.revision_number, commit_row.commit_sequence, revision.revision_id`,
    [bytes(invoiceId, "Invoice identity")],
  ));
  if (sourceRows.length === 0) return null;
  const revisions = Object.freeze(await Promise.all(sourceRows.map((row) => invoiceViewFromRow(reader, row))));
  const first = revisions[0]!;
  const observations = Object.freeze(rows(await pgliteQuery<Row>(reader,
    `SELECT observation.revision_id, observation.source_record_id,
            observation.capture_id, capture.capture_key,
            commit_row.commit_sequence
       FROM einvoice_revision_observations observation
       JOIN source_captures capture ON capture.capture_id = observation.capture_id
       JOIN canonical_commits commit_row ON commit_row.commit_id = observation.commit_id
      WHERE observation.revision_id IN (
        SELECT revision_id FROM einvoice_invoice_revisions WHERE invoice_id = ?
      )
      ORDER BY commit_row.commit_sequence, observation.source_record_id`,
    [bytes(invoiceId, "Invoice identity")],
  )).map((row) => ({
    revisionId: idString(row.revision_id, "Invoice revision"),
    sourceRecordId: idString(row.source_record_id, "Invoice source record"),
    captureId: idString(row.capture_id, "Invoice capture"),
    captureKey: stringValue(row.capture_key, "Invoice capture key"),
    commitSequence: numeric(row.commit_sequence, "Invoice observation commit sequence"),
  })));
  const events = Object.freeze(rows(await pgliteQuery<Row>(reader,
    `SELECT event.event_id, event.invoice_id, event.revision_id,
            event.source_record_id, event.capture_id, capture.capture_key,
            event.event_kind, event.event_at, event.reason,
            commit_row.commit_sequence
       FROM einvoice_revision_events event
       JOIN source_captures capture ON capture.capture_id = event.capture_id
       JOIN canonical_commits commit_row ON commit_row.commit_id = event.commit_id
      WHERE event.invoice_id = ?
      ORDER BY commit_row.commit_sequence, event.event_id`,
    [bytes(invoiceId, "Invoice identity")],
  )).map((row) => ({
    eventId: idString(row.event_id, "Invoice event identity"),
    invoiceId: idString(row.invoice_id, "Invoice identity"),
    revisionId: idString(row.revision_id, "Invoice revision"),
    sourceRecordId: idString(row.source_record_id, "Invoice source record"),
    captureId: idString(row.capture_id, "Invoice capture"),
    captureKey: stringValue(row.capture_key, "Invoice capture key"),
    commitSequence: numeric(row.commit_sequence, "Invoice event commit sequence"),
    kind: stringValue(row.event_kind, "Invoice event kind") as "issued" | "revised" | "revoked" | "observed" | "superseded",
    eventAt: stringValue(row.event_at, "Invoice event timestamp"),
    reason: nullableString(row.reason),
  })));
  return Object.freeze({
    kind: "lineage",
    identity: {
      sourceConnectionKey: first.identity.sourceConnectionKey,
      identityEpoch: first.identity.identityEpoch,
      subjectDigest: first.identity.subjectDigest,
      stableInvoiceKey: first.stableInvoiceKey,
    },
    invoice: revisions.at(-1) ?? null,
    revisions,
    observations,
    events,
    provenanceComplete: revisions.every((revision) => observations.some((observation) => observation.revisionId === revision.revision.revisionId)),
  });
}

async function recognitionLineage(
  reader: PGliteSpendingReader,
  invoiceId: string,
  transactionId: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  return Object.freeze(rows(await pgliteQuery<Row>(reader,
    `SELECT event.*, commit_row.commit_sequence, commit_row.recorded_at_utc_us
       FROM spending_dedup_decision_events event
       JOIN canonical_commits commit_row ON commit_row.commit_id = event.commit_id
      WHERE event.invoice_id = ? AND event.transaction_id = ?
      ORDER BY commit_row.commit_sequence, event.event_id`,
    [bytes(invoiceId, "Invoice identity"), bytes(transactionId, "Transaction identity")],
  )).map((row) => Object.freeze({
    eventId: idString(row.event_id, "Recognition event identity"),
    kind: stringValue(row.event_kind, "Recognition event kind"),
    origin: stringValue(row.decision_origin, "Recognition origin"),
    evidence: jsonValue(row.evidence_json, "Recognition evidence"),
    evidenceKnowledgeSequence: numeric(row.evidence_knowledge_sequence, "Recognition evidence sequence"),
    commitSequence: numeric(row.commit_sequence, "Recognition commit sequence"),
  })));
}

async function refundLineage(
  reader: PGliteSpendingReader,
  stableRefundKey: string,
): Promise<readonly SpendingRefundView[]> {
  const identity = rows(await pgliteQuery<Row>(reader,
    "SELECT refund_id FROM spending_refund_identities WHERE stable_refund_key = ?",
    [stableRefundKey],
  ))[0];
  if (!identity) return Object.freeze([]);
  const rowsForRefund = rows(await pgliteQuery<Row>(reader,
    `SELECT revision.*, identity.stable_refund_key,
            identity.transaction_id, commit_row.commit_sequence
       FROM spending_refund_revisions revision
       JOIN spending_refund_identities identity ON identity.refund_id = revision.refund_id
       JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
      WHERE revision.refund_id = ?
      ORDER BY revision.revision_number, commit_row.commit_sequence, revision.revision_id`,
    [identity.refund_id],
  ));
  return Object.freeze(rowsForRefund.map(refundFromRow));
}

/** Read immutable invoice/recognition/refund history in one caller snapshot. */
export async function querySpendingLineage(
  reader: PGliteSpendingReader,
  request: PGliteSpendingLineageRequest,
): Promise<LineageSpendingQueryResult> {
  const subject = request.subject;
  if (subject.kind === "refund") {
    const lineage: PurchaseLineage = {
      kind: "lineage",
      subject: { stableRefundKey: subject.id },
      invoice: null,
      recognition: [],
      refunds: await refundLineage(reader, subject.id),
    };
    return { status: "ok", kind: "lineage", product: "spending", subject, lineage: [lineage] };
  }
  if (subject.kind !== "spending-pair") throw new Error("Spending lineage subject kind is invalid.");
  const [invoiceId, transactionId, extra] = subject.id.split("/");
  if (!invoiceId || !transactionId || extra) throw new Error("Spending pair lineage id must be invoiceId/transactionId.");
  const invoice = (await invoices(reader, await latest(reader), false, invoiceId))[0] ?? null;
  if (!invoice) throw new Error("Spending lineage invoice identity does not exist.");
  const transactionExists = rows(await pgliteQuery<Row>(reader,
    "SELECT 1 FROM financial_transactions WHERE transaction_id = ?",
    [bytes(transactionId, "Transaction identity")],
  )).length > 0;
  if (!transactionExists) throw new Error("Spending lineage transaction identity does not exist.");
  const lineage: PurchaseLineage = {
    kind: "lineage",
    subject: { invoiceId, transactionId },
    invoice: await invoiceLineage(reader, invoiceId),
    recognition: await recognitionLineage(reader, invoiceId, transactionId),
    refunds: [],
  };
  return { status: "ok", kind: "lineage", product: "spending", subject, lineage: [lineage] };
}

export const queryPGliteSpendingLineage = querySpendingLineage;

function matchingInvoice(invoice: CanonicalEInvoiceView): SpendingMatchingInvoice {
  return { revision: { seller: { name: invoice.revision.seller.name }, occurrence: { value: invoice.revision.occurrence.value }, total: invoice.revision.total ? { coefficient: invoice.revision.total.coefficient, scale: invoice.revision.total.scale, currency: invoice.revision.total.currency } : null } };
}

export type PendingSpendingCandidate = ClassifiedPendingCandidate<DeterministicCandidatePairRow> & Readonly<{
  /** The durable candidate when one was materialized for the pair, else the ephemeral digest view. */
  candidate: SpendingCandidateView;
}>;

/** The global pending candidate set at one data version, classified by strength. */
export type PGlitePendingSpendingCandidates = Readonly<{
  knowledgeAt: number;
  pairs: readonly PendingSpendingCandidate[];
}>;

/**
 * Every pending pair across all months: the deterministic candidates whose
 * invoice and payment are both unlinked and whose pair carries no decision
 * event (confirmed, denied, or revoked). Strength is classified over this
 * whole set, so a month or page view never changes a pair's strength.
 */
export async function queryPendingSpendingCandidates(
  reader: PGliteSpendingReader,
  knowledgeAt: number,
  /** The version's eligible pairing transactions, when the caller already read them. */
  pairingTransactions?: readonly PairingTransaction[],
): Promise<PGlitePendingSpendingCandidates> {
  const [deterministic, linkRows, decisionRows, durableRows] = await Promise.all([
    queryDeterministicCandidatePairs(reader, pairingTransactions),
    pgliteQuery<Row>(reader, "SELECT invoice_id, transaction_id FROM current_spending_dedup_links").then(rows),
    pgliteQuery<Row>(reader, "SELECT DISTINCT invoice_id, transaction_id FROM spending_dedup_decision_events").then(rows),
    pgliteQuery<Row>(reader,
      `SELECT candidate.candidate_id, candidate.invoice_id, candidate.transaction_id,
              candidate.algorithm, candidate.algorithm_version, candidate.similarity_evidence_json
         FROM spending_match_candidates candidate
         JOIN canonical_commits created ON created.commit_id = candidate.created_commit_id
        ORDER BY created.commit_sequence, candidate.candidate_id`).then(rows),
  ]);
  const linkedInvoices = new Set(linkRows.map((row) => idString(row.invoice_id, "Linked invoice")));
  const linkedTransactions = new Set(linkRows.map((row) => idString(row.transaction_id, "Linked transaction")));
  const decided = new Set(decisionRows.map((row) => pairKey(
    idString(row.invoice_id, "Decision invoice"),
    idString(row.transaction_id, "Decision transaction"),
  )));
  const durable = new Map<string, SpendingCandidateView>();
  for (const row of durableRows) {
    const invoiceId = idString(row.invoice_id, "Candidate invoice");
    const transactionId = idString(row.transaction_id, "Candidate transaction");
    const key = pairKey(invoiceId, transactionId);
    if (durable.has(key)) continue;
    durable.set(key, Object.freeze({
      invoiceId,
      transactionId,
      candidateId: idString(row.candidate_id, "Candidate identity"),
      algorithm: stringValue(row.algorithm, "Candidate algorithm"),
      algorithmVersion: stringValue(row.algorithm_version, "Candidate algorithm version"),
      similarityEvidence: jsonValue(row.similarity_evidence_json, "Candidate similarity evidence"),
      status: "candidate" as const,
    }));
  }
  const pending = deterministic.filter((pair) =>
    !linkedInvoices.has(pair.invoiceId)
    && !linkedTransactions.has(pair.transactionId)
    && !decided.has(pairKey(pair.invoiceId, pair.transactionId)));
  const pairs = classifyPendingCandidates(pending).map((pair) => Object.freeze({
    ...pair,
    candidate: durable.get(pairKey(pair.invoiceId, pair.transactionId)) ?? Object.freeze({
      invoiceId: pair.invoiceId,
      transactionId: pair.transactionId,
      candidateId: pair.candidateId,
      algorithm: pair.algorithm,
      algorithmVersion: pair.algorithmVersion,
      similarityEvidence: pair.similarityEvidence,
      status: "candidate" as const,
    }),
  }));
  return Object.freeze({ knowledgeAt, pairs: Object.freeze(pairs) });
}

export function pendingPairInMonth(pair: PendingSpendingCandidate, month: string): boolean {
  return pair.invoiceDate.startsWith(`${month}-`) || pair.transactionDate.startsWith(`${month}-`);
}

export function pendingPairRef(pair: PendingSpendingCandidate): SpendingCandidatePairRef {
  return Object.freeze({
    candidateId: pair.candidate.candidateId,
    invoiceIdentityId: pair.invoiceId,
    transactionIdentityId: pair.transactionId,
  });
}

/** Read one pending-pairing slice: one month, or every month when month is null. */
export async function queryCurrentSpendingCandidatePage(
  reader: PGliteSpendingReader,
  request: SpendingCandidatePageRequest,
  cachedPending?: PGlitePendingSpendingCandidates,
): Promise<SpendingCandidatePageDto> {
  const current = await latest(reader);
  if (!Number.isSafeInteger(request.knowledgeAt) || request.knowledgeAt !== current)
    throw new SpendingPageVersionError("candidate", current);
  const month = request.month ?? null;
  if (month !== null && !validSpendingMonth(month)) throw new TypeError("Spending candidate page month is invalid.");
  const offset = Number.isSafeInteger(request.offset) && (request.offset ?? 0) >= 0 ? request.offset ?? 0 : 0;
  const limit = Number.isSafeInteger(request.limit) && (request.limit ?? 0) > 0
    ? Math.min(request.limit ?? 20, 100)
    : 20;
  const pending = cachedPending?.knowledgeAt === current ? cachedPending : await queryPendingSpendingCandidates(reader, current);
  const candidates = month === null ? pending.pairs : pending.pairs.filter((pair) => pendingPairInMonth(pair, month));
  const candidatePage = candidates.slice(offset, offset + limit);
  const invoiceIds = [...new Set(candidatePage.map((item) => item.invoiceId))];
  const transactionIds = [...new Set(candidatePage.map((item) => item.transactionId))];
  // Each item carries its own pending pair, so the records start without recognized candidates.
  const report = await purchaseRecordsByIdentity(reader, current, { invoiceIds, transactionIds }, { candidates: "none" });
  const recordById = new Map(report.records.map((record) => [record.purchaseId, record]));
  const invoiceCandidateIds = new Map<string, string[]>();
  const transactionCandidateIds = new Map<string, string[]>();
  for (const item of candidatePage) {
    (invoiceCandidateIds.get(item.invoiceId) ?? invoiceCandidateIds.set(item.invoiceId, []).get(item.invoiceId)!).push(item.candidate.candidateId);
    (transactionCandidateIds.get(item.transactionId) ?? transactionCandidateIds.set(item.transactionId, []).get(item.transactionId)!).push(item.candidate.candidateId);
  }
  const withCandidateIds = (record: PurchaseReport["records"][number] | undefined, candidateIds: readonly string[] | undefined) => {
    if (!record || !candidateIds?.length) return record ?? null;
    const ids = [...new Set([...record.candidateIds, ...candidateIds])];
    return Object.freeze({ ...record, candidateIds: Object.freeze(ids), possibleDuplicate: true });
  };
  const items = candidatePage.map((item) => {
    const invoiceRecord = withCandidateIds(
      recordById.get(`invoice:${item.invoiceId}`),
      invoiceCandidateIds.get(item.invoiceId),
    );
    if (!invoiceRecord) throw new Error("Spending candidate invoice is not visible at this data version.");
    const paymentRecord = withCandidateIds(
      recordById.get(`transaction:${item.transactionId}`),
      transactionCandidateIds.get(item.transactionId),
    );
    return {
      candidate: Object.freeze({ ...item.candidate, strength: item.strength, reasons: item.reasons }),
      invoiceRecord,
      paymentRecord,
    };
  });
  return Object.freeze({
    schemaVersion: 1,
    knowledgeAt: current,
    month,
    items: Object.freeze(items),
    totalCandidateCount: candidates.length,
    strongCandidateCount: candidates.filter((pair) => pair.strength === "strong").length,
    nextOffset: offset + items.length < candidates.length ? offset + items.length : null,
  });
}

/** The pending count, strong set, and invoice amounts at stake, for one month or all of them. */
export async function queryCurrentSpendingPendingOverview(
  reader: PGliteSpendingReader,
  request: SpendingPendingOverviewRequest,
  cachedPending?: PGlitePendingSpendingCandidates,
): Promise<SpendingPendingOverviewDto> {
  const current = await latest(reader);
  if (!Number.isSafeInteger(request.knowledgeAt) || request.knowledgeAt !== current)
    throw new SpendingPageVersionError("pending-overview", current);
  const pending = cachedPending?.knowledgeAt === current ? cachedPending : await queryPendingSpendingCandidates(reader, current);
  const month = request.month ?? null;
  const pairs = month === null ? pending.pairs : pending.pairs.filter((pair) => pendingPairInMonth(pair, month));
  const affected: (typeof pairs)[number]["amount"][] = [];
  const countedInvoices = new Set<string>();
  for (const pair of pairs) {
    if (countedInvoices.has(pair.invoiceId)) continue;
    countedInvoices.add(pair.invoiceId);
    affected.push(pair.amount);
  }
  const strong = pairs.filter((pair) => pair.strength === "strong");
  return Object.freeze({
    schemaVersion: 1,
    knowledgeAt: current,
    pendingCount: pairs.length,
    strongCount: strong.length,
    affectedByCurrency: Object.freeze(moneyTotals(affected).map((total) => Object.freeze({ ...total }))),
    strongPairs: Object.freeze(strong.map(pendingPairRef)),
  });
}

/** Eligible pairing transactions of one data version and their rank index. */
export type PGlitePairingIndex = Readonly<{
  knowledgeAt: number;
  transactions: readonly PairingTransaction[];
  byId: ReadonlyMap<string, PairingTransaction>;
  index: ReturnType<typeof createSpendingManualPairingIndex>;
}>;

async function queryPGlitePairingIndex(reader: PGliteSpendingReader, knowledgeAt: number): Promise<PGlitePairingIndex> {
  const transactions = await queryPairingTransactionsDirect(reader);
  return Object.freeze({
    knowledgeAt,
    transactions,
    byId: new Map(transactions.map((transaction) => [transaction.transactionId, transaction])),
    index: createSpendingManualPairingIndex(knowledgeAt, transactions),
  });
}

export async function rankPGliteSpendingPaymentCandidates(
  reader: PGliteSpendingReader,
  input: SpendingPairingCandidatesInput,
  pairingIndexAt: (reader: PGliteSpendingReader, knowledgeAt: number) => Promise<PGlitePairingIndex> = queryPGlitePairingIndex,
): Promise<SpendingPairingCandidatesResult> {
  const knowledgeAt = await latest(reader);
  if (knowledgeAt !== input.dataVersion) throw new Error("Spending pairing data version is stale; reload Spending before pairing.");
  const invoice = (await invoices(reader, knowledgeAt, false, input.invoiceIdentityId))[0];
  if (!invoice || invoice.revision.state === "revoked") throw new Error("Spending invoice selection is stale, revoked, or missing.");
  const offset = Number.isSafeInteger(input.offset) && (input.offset ?? 0) >= 0 ? input.offset ?? 0 : 0;
  const limit = Number.isSafeInteger(input.limit) && (input.limit ?? 0) > 0 ? Math.min(input.limit ?? 50, 100) : 50;
  const { byId, index } = await pairingIndexAt(reader, knowledgeAt);
  const ranking = spendingManualPaymentRanking(matchingInvoice(invoice), index);
  const pageRank = ranking.page(offset, limit);
  const selectedRank = input.selectedTransactionId ? ranking.find(input.selectedTransactionId) : undefined;
  const streams = await pairingPresentationStreams(reader, [...new Set([
    ...pageRank.map((candidate) => candidate.transactionId),
    ...(selectedRank ? [selectedRank.transactionId] : []),
  ])]);
  const candidateView = (candidate: SpendingManualPaymentCandidate) => {
    const transaction = byId.get(candidate.transactionId);
    if (!transaction) throw new Error("Spending pairing candidate is missing from the current index.");
    const stream = streams.get(candidate.transactionId);
    if (!stream) throw new Error("Spending pairing candidate account stream is missing.");
    return createSpendingPairingCandidateViewFromTransaction({
      ...transaction,
      stream,
      postingDate: transaction.postingDate ?? (stream === "credit-card" ? transaction.effectiveOn : null),
      effectiveDateBasis: transaction.effectiveDateBasis ?? (stream === "credit-card" ? "posting-date-fallback" : null),
    });
  };
  const candidates = pageRank.map(candidateView);
  return {
    dataVersion: input.dataVersion,
    candidates,
    ...(input.selectedTransactionId !== undefined ? { selectedCandidate: selectedRank ? candidateView(selectedRank) : null } : {}),
    totalCandidateCount: ranking.total,
    nextOffset: offset + candidates.length < ranking.total ? offset + candidates.length : null,
  };
}

/** 最高消費: the month's largest single purchase per currency. */
export async function queryCurrentSpendingMonthInsight(
  reader: PGliteSpendingReader,
  request: SpendingMonthInsightRequest,
  readFacts: MonthPurchaseFactsReader = queryMonthPurchaseFacts,
): Promise<SpendingMonthInsightDto> {
  const current = await latest(reader);
  if (!Number.isSafeInteger(request.knowledgeAt) || request.knowledgeAt !== current)
    throw new SpendingPageVersionError("month-insight", current);
  if (!validSpendingMonth(request.month)) throw new TypeError("Spending month insight month is invalid.");
  const facts = await readFacts(reader, current, { month: request.month });
  return Object.freeze({
    schemaVersion: 1,
    knowledgeAt: current,
    month: request.month,
    largestByCurrency: largestPurchasesByCurrency(facts),
  });
}

/** 本月同商家: the count and total of the purchase's month with its exact merchant identity. */
export async function queryCurrentSpendingMerchantStats(
  reader: PGliteSpendingReader,
  request: SpendingMerchantStatsRequest,
  readFacts: MonthPurchaseFactsReader = queryMonthPurchaseFacts,
): Promise<SpendingMerchantStatsDto> {
  const current = await latest(reader);
  if (!Number.isSafeInteger(request.knowledgeAt) || request.knowledgeAt !== current)
    throw new SpendingPageVersionError("merchant-stats", current);
  if (typeof request.purchaseId !== "string" || request.purchaseId.trim() === "")
    throw new TypeError("Spending merchant stats purchase id is required.");
  const purchaseId = request.purchaseId.trim();
  // The caller's month usually holds the purchase, and month insight reads it too.
  const hinted = request.month && validSpendingMonth(request.month)
    ? await readFacts(reader, current, { month: request.month })
    : null;
  const facts = hinted?.some((fact) => fact.purchaseId === purchaseId)
    ? hinted
    : await readFacts(reader, current, { purchaseId });
  const target = facts.find((fact) => fact.purchaseId === purchaseId);
  // The modal can still show a purchase that the last merge or revoke replaced.
  if (!target) return Object.freeze({
    schemaVersion: 1, knowledgeAt: current, purchaseId, month: null,
    merchant: null, merchantLabel: null, count: 0, totalsByCurrency: Object.freeze([]),
  });
  const stats = sameMerchantStats(facts, purchaseId);
  return Object.freeze({
    schemaVersion: 1,
    knowledgeAt: current,
    purchaseId,
    month: target.occurrence.slice(0, 7),
    merchant: stats?.merchant ?? null,
    merchantLabel: stats?.merchantLabel ?? merchantLabel(target),
    count: stats?.count ?? 1,
    totalsByCurrency: stats?.totalsByCurrency ?? Object.freeze(target.amount
      ? [Object.freeze({ ...target.amount, currency: target.amount.currency.toUpperCase(), count: 1 })]
      : []),
  });
}

type MergeLogCursor = Readonly<{ schemaVersion: 1; knowledgeAt: number; commitSequence: number; eventId: string }>;

function mergeLogCursorFromToken(token: string | null | undefined, knowledgeAt: number): MergeLogCursor | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Partial<MergeLogCursor>;
    if (parsed.schemaVersion !== 1 || parsed.knowledgeAt !== knowledgeAt
        || !Number.isSafeInteger(parsed.commitSequence) || typeof parsed.eventId !== "string" || !UUID.test(parsed.eventId))
      throw new Error("invalid cursor fields");
    return parsed as MergeLogCursor;
  } catch (error) {
    throw new Error("Spending merge log cursor is stale or invalid; reload the merge log.", { cause: error });
  }
}

/** 合併紀錄: every confirmed, denied, and revoked decision, newest first, keyset paged. */
export async function queryCurrentSpendingMergeLog(
  reader: PGliteSpendingReader,
  request: SpendingMergeLogRequest,
): Promise<SpendingMergeLogDto> {
  const current = await latest(reader);
  if (!Number.isSafeInteger(request.knowledgeAt) || request.knowledgeAt !== current)
    throw new SpendingPageVersionError("merge-log", current);
  const cursor = mergeLogCursorFromToken(request.cursor, current);
  const limit = Number.isSafeInteger(request.limit) && (request.limit ?? 0) > 0 ? Math.min(request.limit ?? 50, 100) : 50;
  const params: unknown[] = [current];
  if (cursor) params.push(cursor.commitSequence, cursor.commitSequence, bytes(cursor.eventId, "Merge log cursor event"));
  params.push(limit + 1);
  const result = rows(await pgliteQuery<Row>(reader,
    `SELECT event.event_id, event.event_kind, event.decision_origin, event.invoice_id, event.transaction_id,
            commit_row.commit_sequence, commit_row.recorded_at_utc_us,
            invoice.invoice_number, invoice.seller_name, invoice.occurrence_value,
            invoice.amount_coefficient AS invoice_amount_coefficient, invoice.amount_scale AS invoice_amount_scale,
            invoice.currency AS invoice_currency,
            payment.description AS payment_description, payment.amount_coefficient AS payment_amount_coefficient,
            payment.amount_scale AS payment_amount_scale, payment.currency AS payment_currency,
            COALESCE(detail.consume_date, detail.posting_date, payment.effective_on) AS payment_date,
            payment_account.institution_key AS payment_institution
       FROM spending_dedup_decision_events event
       JOIN canonical_commits commit_row ON commit_row.commit_id = event.commit_id
       LEFT JOIN LATERAL (
         SELECT revision.invoice_number, revision.seller_name, revision.occurrence_value,
                revision.amount_coefficient, revision.amount_scale, revision.currency
           FROM einvoice_invoice_revisions revision
           JOIN canonical_commits revision_commit ON revision_commit.commit_id = revision.commit_id
          WHERE revision.invoice_id = event.invoice_id
          ORDER BY revision.revision_number DESC, revision_commit.commit_sequence DESC, revision.revision_id DESC
          LIMIT 1
       ) invoice ON TRUE
       LEFT JOIN current_transactions current_row ON current_row.transaction_id = event.transaction_id
       LEFT JOIN transaction_revisions payment ON payment.revision_id = current_row.revision_id
       LEFT JOIN financial_transactions payment_identity ON payment_identity.transaction_id = event.transaction_id
       LEFT JOIN financial_accounts payment_account ON payment_account.account_id = payment_identity.account_id
       LEFT JOIN LATERAL (
         SELECT consume_date, posting_date
           FROM canonical_credit_card_transaction_details detail
          WHERE detail.revision_id = current_row.revision_id
          ORDER BY detail.source_record_id
          LIMIT 1
       ) detail ON TRUE
      WHERE commit_row.commit_sequence <= ?
        ${cursor ? "AND (commit_row.commit_sequence < ? OR (commit_row.commit_sequence = ? AND event.event_id > ?))" : ""}
      ORDER BY commit_row.commit_sequence DESC, event.event_id ASC
      LIMIT ?`,
    params,
  ));
  const visible = result.slice(0, limit);
  const paymentSources = await queryPaymentSourceFacts(reader, [...new Set(visible.flatMap((row) =>
    row.payment_amount_coefficient === null || row.payment_amount_coefficient === undefined ? [] : [idString(row.transaction_id, "Merge log transaction")]))]);
  const entries = visible.map((row) => Object.freeze({
    eventId: idString(row.event_id, "Merge log event"),
    kind: stringValue(row.event_kind, "Merge log event kind") as SpendingMergeLogEntry["kind"],
    origin: stringValue(row.decision_origin, "Merge log origin") as SpendingMergeLogEntry["origin"],
    decidedAt: recordedAtIso(row.recorded_at_utc_us),
    commitSequence: numeric(row.commit_sequence, "Merge log commit sequence"),
    invoice: row.invoice_number === null || row.invoice_number === undefined ? null : Object.freeze({
      invoiceId: idString(row.invoice_id, "Merge log invoice"),
      invoiceNumber: stringValue(row.invoice_number, "Merge log invoice number"),
      sellerName: nullableString(row.seller_name),
      occurrence: stringValue(row.occurrence_value, "Merge log invoice occurrence"),
      amount: optionalMoney(row, "invoice_amount_coefficient", "invoice_amount_scale", "invoice_currency"),
    }),
    payment: row.payment_amount_coefficient === null || row.payment_amount_coefficient === undefined ? null : Object.freeze({
      transactionId: idString(row.transaction_id, "Merge log transaction"),
      description: nullableString(row.payment_description),
      date: stringValue(row.payment_date, "Merge log payment date"),
      amount: exactMoney(row, "payment_amount_coefficient", "payment_amount_scale", "payment_currency"),
      institution: stringValue(row.payment_institution, "Merge log payment institution"),
      cardMask: paymentSources.get(idString(row.transaction_id, "Merge log transaction"))?.cardMask ?? null,
    }),
  }));
  const last = entries.at(-1);
  return Object.freeze({
    schemaVersion: 1,
    knowledgeAt: current,
    entries: Object.freeze(entries),
    nextCursor: result.length > limit && last ? Buffer.from(JSON.stringify({
      schemaVersion: 1, knowledgeAt: current, commitSequence: last.commitSequence, eventId: last.eventId,
    } satisfies MergeLogCursor), "utf8").toString("base64url") : null,
  });
}

export function createPGliteSpendingQuery(store: PGliteSpendingStore) {
  let pendingCache: PGlitePendingSpendingCandidates | null = null;
  const pendingAt = async (transaction: PGliteSpendingReader, knowledgeAt: number) => {
    if (pendingCache?.knowledgeAt !== knowledgeAt)
      pendingCache = await queryPendingSpendingCandidates(
        transaction,
        knowledgeAt,
        (await pairingIndexAt(transaction, knowledgeAt)).transactions,
      );
    return pendingCache;
  };
  let pairingCache: Promise<PGlitePairingIndex> | null = null;
  let pairingCacheVersion = -1;
  const pairingIndexAt = (transaction: PGliteSpendingReader, knowledgeAt: number) => {
    if (pairingCacheVersion !== knowledgeAt || !pairingCache) {
      pairingCacheVersion = knowledgeAt;
      pairingCache = queryPGlitePairingIndex(transaction, knowledgeAt);
      pairingCache.catch(() => {
        if (pairingCacheVersion === knowledgeAt) pairingCache = null;
      });
    }
    return pairingCache;
  };
  // A page action makes the month insight and the open purchase's merchant
  // stats reload together; both read the same month, so read it once per version.
  let factsCache: Readonly<{ knowledgeAt: number; byMonth: Map<string, readonly MonthPurchaseFact[]> }> | null = null;
  const monthFacts: MonthPurchaseFactsReader = async (transaction, knowledgeAt, scope) => {
    if (factsCache?.knowledgeAt !== knowledgeAt) factsCache = { knowledgeAt, byMonth: new Map() };
    const { byMonth } = factsCache;
    const cached = "month" in scope
      ? byMonth.get(scope.month)
      : [...byMonth.values()].find((facts) => facts.some((fact) => fact.purchaseId === scope.purchaseId));
    if (cached) return cached;
    const facts = await queryMonthPurchaseFacts(transaction, knowledgeAt, scope);
    const month = "month" in scope ? scope.month : facts[0]?.occurrence.slice(0, 7);
    if (month) byMonth.set(month, facts);
    return facts;
  };
  return Object.freeze({
    // A facade call owns one repeatable-read transaction for every complete
    // report. Callers that already own a transaction may use the lower-level
    // query functions above directly with its PGliteTransaction capability.
    current: (request?: Parameters<typeof queryCurrentSpending>[1]) =>
      store.transaction((transaction) => queryCurrentSpending(transaction, request)),
    summary: (request?: Parameters<typeof queryCurrentSpendingSummary>[1]) =>
      store.transaction((transaction) => queryCurrentSpendingSummary(transaction, request)),
    summaryPage: (request?: Parameters<typeof queryCurrentSpendingSummaryPage>[1]) =>
      store.transaction((transaction) => queryCurrentSpendingSummaryPage(transaction, request)),
    recordPage: (request: SpendingRecordPageRequest) =>
      store.transaction((transaction) => queryCurrentSpendingRecordPage(transaction, request)),
    candidatePage: async (request: SpendingCandidatePageRequest) => store.transaction(async (transaction) => {
      const knowledgeAt = await latest(transaction);
      if (knowledgeAt !== request.knowledgeAt)
        throw new SpendingPageVersionError("candidate", knowledgeAt);
      return queryCurrentSpendingCandidatePage(transaction, request, await pendingAt(transaction, knowledgeAt));
    }),
    monthInsight: (request: SpendingMonthInsightRequest) =>
      store.transaction((transaction) => queryCurrentSpendingMonthInsight(transaction, request, monthFacts)),
    merchantStats: (request: SpendingMerchantStatsRequest) =>
      store.transaction((transaction) => queryCurrentSpendingMerchantStats(transaction, request, monthFacts)),
    mergeLog: (request: SpendingMergeLogRequest) =>
      store.transaction((transaction) => queryCurrentSpendingMergeLog(transaction, request)),
    pendingOverview: async (request: SpendingPendingOverviewRequest) => store.transaction(async (transaction) => {
      const knowledgeAt = await latest(transaction);
      if (knowledgeAt !== request.knowledgeAt)
        throw new SpendingPageVersionError("pending-overview", knowledgeAt);
      return queryCurrentSpendingPendingOverview(transaction, request, await pendingAt(transaction, knowledgeAt));
    }),
    historical: (request: Readonly<{ financialAt: string; knowledgeAt: number }>) => store.transaction((transaction) => queryHistoricalSpending(transaction, request)),
    recognition: (request?: Readonly<{ knowledgeAt?: number }>) => store.transaction((transaction) => querySpendingRecognition(transaction, request)),
    lineage: (request: PGliteSpendingLineageRequest) => store.transaction((transaction) => querySpendingLineage(transaction, request)),
    pairingCandidates: (request: SpendingPairingCandidatesInput) =>
      store.transaction((transaction) => rankPGliteSpendingPaymentCandidates(transaction, request, pairingIndexAt)),
    /** Build the pairing index for the current version so the next dialog open only ranks. */
    prewarmPairing: (dataVersion: number) => store.transaction(async (transaction) => {
      const knowledgeAt = await latest(transaction);
      if (knowledgeAt === dataVersion) await pairingIndexAt(transaction, knowledgeAt);
      return knowledgeAt;
    }),
  });
}

export type PGliteSpendingQuery = ReturnType<typeof createPGliteSpendingQuery>;
