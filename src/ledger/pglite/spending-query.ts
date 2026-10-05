import { SpendingPageVersionError } from "../../lib/spending/page-reader.ts";
import { createHash } from "node:crypto";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";
import type {
  CanonicalEInvoiceItemView,
  CanonicalEInvoiceMoneyView,
  CanonicalEInvoiceView,
  CanonicalEInvoiceLineageQuery,
} from "../canonical/einvoice-query-contract.ts";
import {
  E_INVOICE_CURRENCY_AUTHORITY,
  E_INVOICE_INTEGRATION_NAMESPACE,
  E_INVOICE_RECORD_KIND,
  E_INVOICE_STREAM,
} from "../canonical/einvoice-contract.ts";
import type {
  CanonicalSpendingCategoryComponent,
  CanonicalSpendingCategorization,
  CanonicalSpendingDisplay,
  CanonicalSpendingReport,
  CanonicalSpendingTransaction,
} from "../canonical/canonical-spending-contracts.ts";
import {
  CANONICAL_SPENDING_INCLUSION_POLICY,
} from "../canonical/spending-inclusion-policy.ts";
import type {
  SpendingCandidateView,
  SpendingDedupLinkView,
  SpendingPair,
  SpendingRecognitionSnapshot,
  SpendingRefundView,
} from "../canonical/spending-recognition-contracts.ts";
import {
  composePurchaseReport,
  evaluateSpendingMatchCandidates,
  purchaseRecordCategory,
  type PurchaseItemCategorizationIndex,
} from "../canonical/spending-purchase-report-core.ts";
import {
  purchaseCategoryCodes,
  readPurchaseCategory,
  type PurchaseCategory,
  type PurchaseItemCategorization,
} from "../canonical/purchase-category.ts";
import type { PurchaseLineage } from "../canonical/spending-purchase-contracts.ts";
import {
  cardMaskLastFour,
  type PurchasePaymentSourceIndex,
  type PurchaseReport,
} from "../canonical/spending-purchase-report-core.ts";
import type {
  CurrentSpendingQueryResult,
  HistoricalSpendingQueryResult,
  LineageSpendingQueryResult,
} from "../../lib/shared-ledger/server/financial-query-contracts.ts";
import {
  SPENDING_UNCLASSIFIED_CATEGORY_SELECTOR,
  type SpendingCategoryMonthTotal,
  type SpendingInvoiceDto,
  type SpendingPageDto,
  type SpendingRecordPageRequest,
  type SpendingRecordPageDto,
  type SpendingCandidatePageRequest,
  type SpendingCandidatePageDto,
  type SpendingCandidatePairRef,
  type SpendingPendingOverviewDto,
  type SpendingPendingOverviewRequest,
  type SpendingMergeLogDto,
  type SpendingMergeLogEntry,
  type SpendingMergeLogRequest,
  type SpendingMerchantStatsDto,
  type SpendingMerchantStatsRequest,
  type SpendingMonthInsightDto,
  type SpendingMonthInsightRequest,
  type SpendingPurchaseReportSummaryDto,
  type SpendingPurchaseReportDto,
  type SpendingSummaryDto,
} from "../../lib/spending/model.ts";
import {
  createSpendingPairingCandidateViewFromTransaction,
} from "../../lib/spending/pairing-presentation.ts";
import {
  calendarDayDistance,
  exactMoneyEqual,
  exactMoneyKey,
  type SpendingMatchingInvoice,
  type SpendingMatchingTransaction,
} from "../../lib/spending/purchase-matching.ts";
import {
  createSpendingManualPairingIndex,
  rankSpendingManualPaymentCandidates,
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
import type {
  SpendingPairingCandidatesInput,
  SpendingPairingCandidatesResult,
} from "../../lib/spending/model.ts";
import { isCategoryApplicable } from "../canonical/transaction-taxonomy.ts";

/** A read-only capability accepted by the PGlite Spending query seam. */
export type PGliteSpendingReader = Pick<PGliteStore, "query"> | Pick<PGliteTransaction, "query">;
export type PGliteSpendingStore = Pick<PGliteStore, "query" | "transaction">;

/**
 * A report snapshot captured by the worker's read transaction.  Commands may
 * reuse this immutable snapshot when their writer is the same store instance;
 * the command still validates the current commit sequence inside its own
 * transaction before applying a mutation.
 */
export type PGliteSpendingSnapshot = CurrentSpendingQueryResult;

const currentSnapshotCache = new WeakMap<object, PGliteSpendingSnapshot>();
const pairingSnapshotCache = new WeakMap<object, Readonly<{
  transactions: readonly CanonicalSpendingTransaction[];
  byId: ReadonlyMap<string, CanonicalSpendingTransaction>;
  index: ReturnType<typeof createSpendingManualPairingIndex>;
}>>();

export function cachePGliteSpendingSnapshot(
  store: PGliteSpendingStore,
  snapshot: PGliteSpendingSnapshot,
): void {
  currentSnapshotCache.set(store, snapshot);
}

export function cachedPGliteSpendingSnapshot(
  store: object,
): PGliteSpendingSnapshot | null {
  return currentSnapshotCache.get(store) ?? null;
}

type Row = Readonly<Record<string, unknown>>;

type Money = Readonly<{ coefficient: string; scale: number; currency: string }>;
type QueryKind = "current" | "historical";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const HEX_ID = /^[0-9a-f]{32}$/iu;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const EXCLUDED_KIND_PREFIXES = [
  "transfer",
  "cash",
  "investment",
  "payment.credit_card",
  "payment.loan",
] as const;

function rows<T extends Row>(result: { rows: readonly T[] }): readonly T[] {
  return result.rows;
}

/**
 * The shared query helpers use positional `?` parameters. PGlite speaks
 * PostgreSQL, so translate those
 * placeholders at this boundary while preserving the caller's parameter
 * order.  Spending queries intentionally do not contain literal question
 * marks in SQL strings.
 */
async function pgliteQuery<T>(
  reader: PGliteSpendingReader,
  sql: string,
  params: readonly unknown[] = [],
  options?: Readonly<{ rowMode?: "array" | "object" }>,
): Promise<{ rows: readonly T[] }> {
  let index = 0;
  const postgresSql = sql.replace(/\?/gu, () => `$${++index}`);
  return reader.query<T>(postgresSql, params, options);
}

function stringValue(value: unknown, label: string): string {
  if (value === null || value === undefined) throw new Error(`${label} is missing.`);
  return String(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function numeric(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label} is invalid.`);
  return result;
}

function jsonValue(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value !== null && typeof value === "object" && !Array.isArray(value))
    return value as Readonly<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return parsed as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw new Error(`${label} is not valid JSON object.`, { cause: error });
  }
}

function bytes(value: string, label: string): Uint8Array {
  const clean = value.trim().toLowerCase();
  if (!UUID.test(clean) && !HEX_ID.test(clean)) throw new Error(`${label} is not a canonical UUID.`);
  return Uint8Array.from(Buffer.from(clean.replaceAll("-", ""), "hex"));
}

function idString(value: unknown, label = "Canonical identity"): string {
  if (typeof value === "string") {
    const clean = value.trim().toLowerCase();
    if (UUID.test(clean)) return clean;
    if (HEX_ID.test(clean)) return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
    return value;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const hex = Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value)).toString("hex");
    if (hex.length !== 32) throw new Error(`${label} is not a canonical UUID.`);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error(`${label} is not a canonical UUID.`);
}

function exactMoney(row: Row, coefficient = "amount_coefficient", scale = "amount_scale", currency = "currency"): Money {
  return {
    coefficient: stringValue(row[coefficient], "Exact amount coefficient"),
    scale: numeric(row[scale], "Exact amount scale"),
    currency: stringValue(row[currency], "Exact amount currency"),
  };
}

function addDecimal(left: Readonly<{ coefficient: bigint; scale: number }>, right: Readonly<{ coefficient: bigint; scale: number }>): { coefficient: bigint; scale: number } {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient: left.coefficient * 10n ** BigInt(scale - left.scale) + right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  };
}

function reducedDecimal(value: Readonly<{ coefficient: bigint; scale: number }>): { coefficient: string; scale: number } {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient: coefficient.toString(), scale };
}

function addTotal(map: Map<string, { amount: { coefficient: bigint; scale: number }; count: number }>, amount: Money): void {
  const currency = amount.currency.toUpperCase();
  const next = { coefficient: BigInt(amount.coefficient), scale: amount.scale };
  const previous = map.get(currency);
  map.set(currency, {
    amount: previous ? addDecimal(previous.amount, next) : next,
    count: (previous?.count ?? 0) + 1,
  });
}

function totals(map: ReadonlyMap<string, { amount: { coefficient: bigint; scale: number }; count: number }>): readonly { currency: string; coefficient: string; scale: number; count: number }[] {
  return [...map.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, value]) => ({
    currency,
    ...reducedDecimal(value.amount),
    count: value.count,
  }));
}

function emptySpendingReport(kind: QueryKind, knowledgePoint: number, financialAt: string | null): CanonicalSpendingReport {
  return {
    status: "ok",
    kind,
    knowledgePoint,
    financialAt,
    inclusionPolicy: CANONICAL_SPENDING_INCLUSION_POLICY,
    transactions: [],
    includedTransactions: [],
    totalsByCurrency: [],
    categoryTotalsByCurrency: [],
    unclassifiedByCurrency: [],
    classificationCoverage: {
      includedCount: 0,
      classifiedCount: 0,
      unclassifiedCount: 0,
      includedAmountByCurrency: [],
      classifiedAmountByCurrency: [],
      unclassifiedAmountByCurrency: [],
    },
    reportEligibility: { status: "complete", gapCount: 0, gapAmountByCurrency: [] },
    totalStatus: "complete",
  };
}

function excludedKind(kind: string): boolean {
  return EXCLUDED_KIND_PREFIXES.some((prefix) => kind === prefix || kind.startsWith(`${prefix}.`));
}

function pairKey(invoiceId: string, transactionId: string): string {
  return `${invoiceId}/${transactionId}`;
}

function occurrenceForTransaction(transaction: CanonicalSpendingTransaction): Readonly<{ value: string; precision: "date" | "minute" | "second"; timeZone: string; basis: "purchase-date" | "posting-date-fallback" }> {
  const value = transaction.consumeDate ?? transaction.postingDate ?? transaction.effectiveOn;
  const basis = transaction.consumeDate ? "purchase-date" : "posting-date-fallback";
  return { value, precision: "date", timeZone: "unknown", basis };
}

async function latest(reader: PGliteSpendingReader): Promise<number> {
  const result = await pgliteQuery<{ value: number | string }>(reader, "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits");
  return numeric(result.rows[0]?.value ?? 0, "Canonical knowledge point");
}

async function activeGeneration(reader: PGliteSpendingReader): Promise<number | null> {
  try {
    const result = await pgliteQuery<{ generation_id: number | string }>(reader,
      "SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1",
    );
    const value = result.rows[0]?.generation_id;
    if (value !== undefined) return numeric(value, "Active projection generation");
  } catch {
    // Older/fresh fixtures may only have the status table. The reviewed
    // baseline contains both tables, but this fallback keeps the query seam
    // useful while a baseline is being assembled.
  }
  try {
    const result = await pgliteQuery<{ generation_id: number | string }>(reader,
      "SELECT generation_id FROM projection_generations WHERE status = 'active' ORDER BY generation_id DESC LIMIT 1",
    );
    const value = result.rows[0]?.generation_id;
    return value === undefined ? null : numeric(value, "Active projection generation");
  } catch {
    return null;
  }
}

type DateFact = Readonly<{ consumeDate: string | null; postingDate: string | null; basis: "consume-date" | "posting-date-fallback" | null }>;

async function transactionDateFacts(
  reader: PGliteSpendingReader,
  revisionIds?: readonly string[],
): Promise<ReadonlyMap<string, DateFact>> {
  const tableRows = rows(await pgliteQuery<{ table_name: string }>(reader,
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('canonical_credit_card_transaction_details', 'fubon_credit_transaction_details')",
  ));
  const result = new Map<string, DateFact>();
  if (revisionIds?.length === 0) return result;
  for (const table of tableRows) {
    const chunks = revisionIds === undefined
      ? [undefined]
      : Array.from({ length: Math.ceil(revisionIds.length / 2_048) }, (_, index) =>
        revisionIds.slice(index * 2_048, (index + 1) * 2_048));
    for (const chunk of chunks) {
      const facts = rows(await pgliteQuery<Row>(reader,
        `SELECT revision_id, consume_date, posting_date, effective_date_basis
           FROM ${table.table_name}
          ${chunk === undefined ? "" : `WHERE revision_id IN (${chunk.map(() => "?").join(",")})`}`,
        chunk?.map((value) => bytes(value, "Transaction revision")) ?? [],
      ));
      for (const row of facts) {
        result.set(idString(row.revision_id, "Transaction revision"), {
          consumeDate: nullableString(row.consume_date),
          postingDate: nullableString(row.posting_date),
          basis: row.effective_date_basis === "consume-date" || row.effective_date_basis === "posting-date-fallback"
            ? row.effective_date_basis
            : null,
        });
      }
    }
  }
  return result;
}

type TransactionRow = Row & Readonly<{ transaction_id: unknown; revision_id: unknown; account_id: unknown }>;

async function transactionRows(
  reader: PGliteSpendingReader,
  kind: QueryKind,
  knowledgeAt: number,
  financialAt: string | null,
  request: Readonly<{ sourceConnectionKey?: string; accountIds?: readonly string[]; transactionIds?: readonly string[]; startDate?: string; endDate?: string }> = {},
): Promise<readonly TransactionRow[]> {
  const predicates: string[] = [];
  const params: unknown[] = [];
  if (kind === "current") {
    predicates.push("1 = 1");
  } else {
    predicates.push("revision_commit.commit_sequence <= ?");
    params.push(knowledgeAt);
    predicates.push("source_assertion.assertion_id IS NOT NULL");
    // PostgreSQL cannot infer the type of a bare `$n IS NULL` parameter.
    // Keep the nullable financial cutoff while giving PGlite an explicit
    // text type.
    predicates.push("(CAST(? AS TEXT) IS NULL OR revision.effective_on <= ?)");
    params.push(financialAt, financialAt);
  }
  if (request.sourceConnectionKey !== undefined) {
    predicates.push("connection_scope.source_connection_key = ?");
    params.push(request.sourceConnectionKey);
  }
  if (request.accountIds !== undefined) {
    if (request.accountIds.length === 0) return [];
    predicates.push(`account.account_id IN (${request.accountIds.map(() => "?").join(",")})`);
    params.push(...request.accountIds.map((value) => bytes(value, "Account identity")));
  }
  if (request.transactionIds !== undefined) {
    if (request.transactionIds.length === 0) return [];
    predicates.push(`transaction_row.transaction_id IN (${request.transactionIds.map(() => "?").join(",")})`);
    params.push(...request.transactionIds.map((value) => bytes(value, "Transaction identity")));
  }
  if (request.startDate !== undefined) {
    predicates.push("revision.effective_on >= ?");
    params.push(request.startDate);
  }
  if (request.endDate !== undefined) {
    predicates.push("revision.effective_on <= ?");
    params.push(request.endDate);
  }
  if (kind === "current") {
    const result = await pgliteQuery<TransactionRow>(reader,
      `SELECT current_row.transaction_id, current_row.revision_id,
              transaction_row.account_id, account.account_no,
              connection_scope.source_connection_key,
              connection_scope.integration_namespace, account.stream,
              revision.amount_coefficient, revision.amount_scale,
              revision.currency, revision.direction, revision.posting_status,
              revision.economic_status, revision.administrative_state,
              revision.effective_on, revision.description
         FROM current_transactions current_row
         JOIN financial_transactions transaction_row ON transaction_row.transaction_id = current_row.transaction_id
         JOIN financial_accounts account ON account.account_id = transaction_row.account_id
         JOIN source_connections connection_scope ON connection_scope.source_connection_id = account.source_connection_id
         JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id
        WHERE ${predicates.join(" AND ")}
        ORDER BY revision.effective_on, current_row.transaction_id`,
      params,
    );
    return rows(result);
  }
  const result = await pgliteQuery<TransactionRow>(reader,
    `WITH source_assertion AS (
       SELECT assertion.revision_id, assertion.assertion_id,
              ROW_NUMBER() OVER (PARTITION BY assertion.revision_id ORDER BY assertion.assertion_id) AS assertion_rank
         FROM source_assertions assertion
         JOIN canonical_commits assertion_commit ON assertion_commit.commit_id = assertion.commit_id
        WHERE assertion_commit.commit_sequence <= ?
     ), ranked AS (
       SELECT transaction_row.transaction_id, revision.revision_id,
              transaction_row.account_id, account.account_no,
              connection_scope.source_connection_key,
              connection_scope.integration_namespace, account.stream,
              revision.amount_coefficient, revision.amount_scale,
              revision.currency, revision.direction, revision.posting_status,
              revision.economic_status, revision.administrative_state,
              revision.effective_on, revision.description,
              ROW_NUMBER() OVER (
                PARTITION BY revision.transaction_id
                ORDER BY revision_commit.commit_sequence DESC,
                         revision.revision_number DESC, revision.revision_id DESC
              ) AS revision_rank
         FROM transaction_revisions revision
         JOIN canonical_commits revision_commit ON revision_commit.commit_id = revision.commit_id
         JOIN financial_transactions transaction_row ON transaction_row.transaction_id = revision.transaction_id
         JOIN financial_accounts account ON account.account_id = transaction_row.account_id
         JOIN source_connections connection_scope ON connection_scope.source_connection_id = account.source_connection_id
         LEFT JOIN source_assertion ON source_assertion.revision_id = revision.revision_id AND source_assertion.assertion_rank = 1
        WHERE ${predicates.join(" AND ")}
     )
     SELECT transaction_id, revision_id, account_id, account_no,
            source_connection_key, integration_namespace, stream,
            amount_coefficient, amount_scale, currency, direction,
            posting_status, economic_status, administrative_state,
            effective_on, description
       FROM ranked
      WHERE revision_rank = 1
      ORDER BY effective_on, transaction_id`,
    [knowledgeAt, ...params],
  );
  return rows(result);
}

type EnrichmentRow = Row & Readonly<{ transaction_id: unknown; field_name: unknown }>;
type CategorizationRow = Row & Readonly<{ transaction_id: unknown; mode: unknown }>;
type TagRow = Row & Readonly<{ transaction_id: unknown; tag_id: unknown }>;

async function enrichmentRows(
  reader: PGliteSpendingReader,
  kind: QueryKind,
  knowledgeAt: number,
  transactionIds?: readonly string[],
): Promise<readonly EnrichmentRow[]> {
  if (transactionIds?.length === 0) return [];
  const filter = transactionIds === undefined
    ? ""
    : ` AND enrichment.transaction_id IN (${transactionIds.map(() => "?").join(",")})`;
  const params = kind === "current"
    ? transactionIds?.map((value) => bytes(value, "Transaction identity")) ?? []
    : [knowledgeAt, ...(transactionIds?.map((value) => bytes(value, "Transaction identity")) ?? [])];
  const result = await pgliteQuery<EnrichmentRow>(reader,
    `SELECT enrichment.transaction_id, enrichment.field_name,
            enrichment.assertion_id, enrichment.value_text, enrichment.origin,
            enrichment.producer_id, enrichment.producer_version,
            enrichment.route_id, enrichment.taxonomy_id,
            enrichment.taxonomy_version, enrichment.taxonomy_dimension,
            enrichment.taxonomy_code, enrichment.projection_commit_id,
            commit_row.commit_sequence AS projection_commit_sequence
       FROM current_transaction_enrichment enrichment
       JOIN canonical_commits commit_row ON commit_row.commit_id = enrichment.projection_commit_id
      WHERE ${kind === "current" ? "TRUE" : "commit_row.commit_sequence <= ?"}${filter}
      ORDER BY enrichment.transaction_id, enrichment.field_name`,
    params,
  );
  return rows(result);
}

async function categoryRows(
  reader: PGliteSpendingReader,
  kind: QueryKind,
  knowledgeAt: number,
  generation: number | null,
  transactionIds?: readonly string[],
): Promise<readonly CategorizationRow[]> {
  if (generation === null) return [];
  if (transactionIds?.length === 0) return [];
  const filter = transactionIds === undefined
    ? ""
    : ` AND projected.transaction_id IN (${transactionIds.map(() => "?").join(",")})`;
  const params = kind === "current"
    ? [generation, ...(transactionIds?.map((value) => bytes(value, "Transaction identity")) ?? [])]
    : [generation, knowledgeAt, ...(transactionIds?.map((value) => bytes(value, "Transaction identity")) ?? [])];
  const result = await pgliteQuery<CategorizationRow>(reader,
    `SELECT projected.transaction_id, projected.assertion_id,
            'user' AS origin, projected.mode, projected.category_code,
            projected.taxonomy_id, projected.taxonomy_version,
            projected.allocation_set_id, NULLIF(projected.component_ordinal, 0) AS component_ordinal,
            projected.amount_coefficient, projected.amount_scale,
            projected.amount_currency, projected.booked_coefficient,
            projected.booked_scale, projected.booked_currency,
            projected.conversion_evidence_kind, projected.conversion_evidence_id,
            projected.conversion_from_currency, projected.conversion_to_currency,
            projected.conversion_evidence_json, projected.projection_commit_id,
            commit_row.commit_sequence AS projection_commit_sequence
       FROM projection_generation_transaction_categorizations projected
       JOIN canonical_commits commit_row ON commit_row.commit_id = projected.projection_commit_id
      WHERE projected.generation_id = ?
        AND ${kind === "current" ? "TRUE" : "commit_row.commit_sequence <= ?"}${filter}
      ORDER BY projected.transaction_id, projected.component_ordinal`,
    params,
  );
  return rows(result);
}

async function tagRows(
  reader: PGliteSpendingReader,
  kind: QueryKind,
  knowledgeAt: number,
  transactionIds?: readonly string[],
): Promise<readonly TagRow[]> {
  if (transactionIds?.length === 0) return [];
  const filter = transactionIds === undefined
    ? ""
    : ` AND tags.transaction_id IN (${transactionIds.map(() => "?").join(",")})`;
  const params = kind === "current"
    ? transactionIds?.map((value) => bytes(value, "Transaction identity")) ?? []
    : [knowledgeAt, ...(transactionIds?.map((value) => bytes(value, "Transaction identity")) ?? [])];
  const result = await pgliteQuery<TagRow>(reader,
      `SELECT tags.transaction_id, tags.tag_id, tags.assertion_id, tags.user_id,
              tags.display_label, tags.normalized_label, tags.lifecycle
         FROM current_transaction_tags tags
         JOIN canonical_commits commit_row ON commit_row.commit_id = tags.projection_commit_id
        WHERE ${kind === "current" ? "TRUE" : "commit_row.commit_sequence <= ?"}${filter}
        ORDER BY tags.transaction_id, tags.normalized_label, tags.tag_id`,
      params,
  );
  return rows(result);
}

function grouped<T extends Row>(values: readonly T[], key: (row: T) => string): ReadonlyMap<string, readonly T[]> {
  const map = new Map<string, T[]>();
  for (const value of values) {
    const bucket = map.get(key(value));
    if (bucket) bucket.push(value);
    else map.set(key(value), [value]);
  }
  return map;
}

function categoryFromRows(transaction: TransactionRow, kind: string | null, values: readonly CategorizationRow[], enrichments: readonly EnrichmentRow[]): CanonicalSpendingCategorization {
  const user = values;
  if (user.length > 0 && kind !== null) {
    const first = user[0]!;
    if (first.mode === "single") {
      const code = nullableString(first.category_code);
      if (code && isCategoryApplicable(code, kind)) {
        return {
          mode: "single",
          origin: "user",
          assertionId: idString(first.assertion_id, "Categorization assertion"),
          categoryCode: code,
          taxonomyId: stringValue(first.taxonomy_id, "Categorization taxonomy"),
          taxonomyVersion: stringValue(first.taxonomy_version, "Categorization taxonomy version"),
        };
      }
    } else {
      const components: CanonicalSpendingCategoryComponent[] = [];
      let total = { coefficient: 0n, scale: 0 };
      const seen = new Set<string>();
      let valid = true;
      for (const row of user) {
        const code = nullableString(row.category_code);
        const coefficient = nullableString(row.booked_coefficient);
        const scale = row.booked_scale === null || row.booked_scale === undefined ? null : numeric(row.booked_scale, "Categorization scale");
        const currency = nullableString(row.booked_currency);
        if (!code || !coefficient || scale === null || !currency || row.component_ordinal === null || row.component_ordinal === undefined || seen.has(code) || !isCategoryApplicable(code, kind)) {
          valid = false;
          break;
        }
        seen.add(code);
        const amount = { coefficient: BigInt(coefficient), scale };
        total = addDecimal(total, amount);
        components.push({
          categoryCode: code,
          origin: "user",
          assertionId: idString(row.assertion_id, "Categorization assertion"),
          provenance: {
            projectionCommitId: row.projection_commit_id === null ? null : idString(row.projection_commit_id, "Categorization commit"),
            projectionCommitSequence: numeric(row.projection_commit_sequence, "Categorization commit sequence"),
          },
          taxonomyId: stringValue(row.taxonomy_id, "Categorization taxonomy"),
          taxonomyVersion: stringValue(row.taxonomy_version, "Categorization taxonomy version"),
          ...reducedDecimal(amount),
          currency,
          ...(row.conversion_evidence_kind && row.conversion_evidence_id && row.conversion_from_currency && row.conversion_to_currency && row.conversion_evidence_json
            ? {
                conversionEvidence: {
                  kind: String(row.conversion_evidence_kind),
                  id: String(row.conversion_evidence_id),
                  fromCurrency: String(row.conversion_from_currency),
                  toCurrency: String(row.conversion_to_currency),
                  json: String(row.conversion_evidence_json),
                },
              }
            : {}),
        });
      }
      const transactionAmount = exactMoney(transaction);
      const normalizedTransaction = { coefficient: BigInt(transactionAmount.coefficient), scale: transactionAmount.scale };
      if (valid && components.length >= 2 && total.coefficient * 10n ** BigInt(Math.max(0, normalizedTransaction.scale - total.scale)) === normalizedTransaction.coefficient * 10n ** BigInt(Math.max(0, total.scale - normalizedTransaction.scale))) {
        return { mode: "allocated", origin: "user", assertionId: idString(first.assertion_id, "Categorization assertion"), components };
      }
    }
  }
  const automatic = enrichments.find((row) => row.field_name === "category");
  const code = nullableString(automatic?.taxonomy_code);
  if (automatic && code && kind !== null && isCategoryApplicable(code, kind)) {
    return {
      mode: "single",
      origin: automatic.origin === "source" ? "source" : "derived",
      assertionId: idString(automatic.assertion_id, "Categorization assertion"),
      categoryCode: code,
      taxonomyId: stringValue(automatic.taxonomy_id, "Categorization taxonomy"),
      taxonomyVersion: stringValue(automatic.taxonomy_version, "Categorization taxonomy version"),
    };
  }
  return { mode: "absent" };
}

function displayFromRows(transaction: TransactionRow, values: readonly Row[]): CanonicalSpendingDisplay {
  const display = values.find((row) => row.field_name === "display_name");
  if (display) {
    return {
      status: display.origin === "user" ? "supported" : "supported",
      value: String(display.value_text),
      origin: String(display.origin),
      displayKind: display.origin === "user" ? "override" : "automatic",
      assertionId: display.assertion_id === null ? null : idString(display.assertion_id, "Display assertion"),
      referenceId: null,
    };
  }
  const description = nullableString(transaction.description);
  return description === null
    ? { status: "absent", value: null, origin: null, displayKind: null, assertionId: null, referenceId: null }
    : { status: "fallback", value: description, origin: "source", displayKind: "source_description", assertionId: null, referenceId: null };
}

function transactionFromRow(row: TransactionRow, fact: DateFact | undefined, categories: readonly CategorizationRow[], enrichments: readonly EnrichmentRow[], tags: readonly TagRow[]): CanonicalSpendingTransaction {
  const stream = stringValue(row.stream, "Account stream");
  const consumeDate = fact?.consumeDate ?? null;
  const postingDate = fact?.postingDate ?? (stream === "credit-card" ? stringValue(row.effective_on, "Effective date") : null);
  const effectiveDateBasis = fact?.basis ?? (stream === "credit-card" ? "posting-date-fallback" : null);
  const kindRow = enrichments.find((candidate) => candidate.field_name === "kind");
  const kind = nullableString(kindRow?.taxonomy_code);
  return {
    transactionId: idString(row.transaction_id, "Transaction identity"),
    revisionId: idString(row.revision_id, "Transaction revision"),
    accountId: idString(row.account_id, "Account identity"),
    accountNumber: nullableString(row.account_no),
    sourceConnectionKey: stringValue(row.source_connection_key, "Source connection key"),
    integrationNamespace: stringValue(row.integration_namespace, "Integration namespace"),
    stream,
    effectiveOn: stringValue(row.effective_on, "Effective date"),
    consumeDate,
    postingDate,
    effectiveDateBasis,
    description: nullableString(row.description),
    amount: exactMoney(row),
    direction: stringValue(row.direction, "Transaction direction"),
    postingStatus: stringValue(row.posting_status, "Posting status"),
    economicStatus: stringValue(row.economic_status, "Economic status"),
    administrativeState: stringValue(row.administrative_state, "Administrative state"),
    kind,
    categorization: categoryFromRows(row, kind, categories, enrichments),
    display: displayFromRows(row, enrichments),
    tags: tags.map((tag) => ({
      tagId: idString(tag.tag_id, "Tag identity"),
      userId: stringValue(tag.user_id, "Tag user"),
      label: stringValue(tag.display_label, "Tag label"),
      normalizedLabel: stringValue(tag.normalized_label, "Tag normalized label"),
      lifecycle: "active" as const,
      assertionId: idString(tag.assertion_id, "Tag assertion"),
      origin: "user" as const,
    })),
    inclusion: "excluded",
  };
}

function spendingReport(kind: QueryKind, knowledgeAt: number, financialAt: string | null, values: readonly CanonicalSpendingTransaction[]): CanonicalSpendingReport {
  const output: CanonicalSpendingTransaction[] = [];
  const included: CanonicalSpendingTransaction[] = [];
  const totalValues = new Map<string, { amount: { coefficient: bigint; scale: number }; count: number }>();
  const classifiedValues = new Map<string, { amount: { coefficient: bigint; scale: number }; count: number }>();
  const unclassifiedValues = new Map<string, { amount: { coefficient: bigint; scale: number }; count: number }>();
  const gapValues = new Map<string, { amount: { coefficient: bigint; scale: number }; count: number }>();
  const categoryValues = new Map<string, { categoryCode: string; taxonomyId: string; taxonomyVersion: string; amount: { coefficient: bigint; scale: number }; count: number; currency: string }>();
  for (const original of values) {
    const amount = original.amount;
    const gap = !["inflow", "outflow"].includes(original.direction) || !["pending", "posted"].includes(original.postingStatus) || !["normal", "canceled", "refund", "reversal"].includes(original.economicStatus) || !["active", "deleted", "purged"].includes(original.administrativeState) || original.kind === null;
    let transaction: CanonicalSpendingTransaction;
    if (gap) {
      addTotal(gapValues, amount);
      transaction = { ...original, inclusion: "eligibility-gap", eligibilityGap: "missing-report-inclusion-semantics" };
    } else if (original.administrativeState !== "active" || original.economicStatus !== "normal" || original.postingStatus !== "posted" || original.direction !== "outflow" || excludedKind(original.kind!)) {
      transaction = { ...original, inclusion: "excluded" };
    } else {
      transaction = { ...original, inclusion: "included" };
      included.push(transaction);
      addTotal(totalValues, amount);
      if (transaction.categorization.mode === "absent") addTotal(unclassifiedValues, amount);
      else if (transaction.categorization.mode === "single") {
        addTotal(classifiedValues, amount);
        const category = transaction.categorization;
        const key = `${category.categoryCode}|${category.taxonomyId}|${category.taxonomyVersion}|${amount.currency.toUpperCase()}`;
        const previous = categoryValues.get(key);
        const categoryAmount = { coefficient: BigInt(amount.coefficient), scale: amount.scale };
        categoryValues.set(key, {
          categoryCode: category.categoryCode!,
          taxonomyId: category.taxonomyId!,
          taxonomyVersion: category.taxonomyVersion!,
          amount: previous ? addDecimal(previous.amount, categoryAmount) : categoryAmount,
          count: (previous?.count ?? 0) + 1,
          currency: amount.currency.toUpperCase(),
        });
      } else {
        let fullyClassified = true;
        for (const component of transaction.categorization.components ?? []) {
          const componentAmount = { coefficient: BigInt(component.coefficient), scale: component.scale };
          const key = `${component.categoryCode}|${component.taxonomyId}|${component.taxonomyVersion}|${amount.currency.toUpperCase()}`;
          const previous = categoryValues.get(key);
          categoryValues.set(key, {
            categoryCode: component.categoryCode,
            taxonomyId: component.taxonomyId,
            taxonomyVersion: component.taxonomyVersion,
            amount: previous ? addDecimal(previous.amount, componentAmount) : componentAmount,
            count: (previous?.count ?? 0) + 1,
            currency: amount.currency.toUpperCase(),
          });
          if (component.currency !== amount.currency) fullyClassified = false;
        }
        if (fullyClassified) addTotal(classifiedValues, amount);
        else addTotal(unclassifiedValues, amount);
      }
    }
    output.push(transaction);
  }
  const categoryTotalsByCurrency = [...categoryValues.values()].sort((left, right) => `${left.categoryCode}:${left.taxonomyId}:${left.currency}`.localeCompare(`${right.categoryCode}:${right.taxonomyId}:${right.currency}`)).map((value) => ({
    categoryCode: value.categoryCode,
    taxonomyId: value.taxonomyId,
    taxonomyVersion: value.taxonomyVersion,
    currency: value.currency,
    ...reducedDecimal(value.amount),
    count: value.count,
  }));
  const includedCount = included.length;
  const classifiedCount = [...classifiedValues.values()].reduce((sum, value) => sum + value.count, 0);
  const unclassifiedCount = [...unclassifiedValues.values()].reduce((sum, value) => sum + value.count, 0);
  const gapCount = [...gapValues.values()].reduce((sum, value) => sum + value.count, 0);
  return {
    status: "ok",
    kind,
    knowledgePoint: knowledgeAt,
    financialAt,
    inclusionPolicy: CANONICAL_SPENDING_INCLUSION_POLICY,
    transactions: output,
    includedTransactions: included,
    totalsByCurrency: totals(totalValues),
    categoryTotalsByCurrency,
    unclassifiedByCurrency: totals(unclassifiedValues),
    classificationCoverage: {
      includedCount,
      classifiedCount,
      unclassifiedCount,
      includedAmountByCurrency: totals(totalValues),
      classifiedAmountByCurrency: totals(classifiedValues),
      unclassifiedAmountByCurrency: totals(unclassifiedValues),
    },
    reportEligibility: { status: gapCount === 0 ? "complete" : "incomplete", gapCount, gapAmountByCurrency: totals(gapValues) },
    totalStatus: gapCount === 0 ? "complete" : "incomplete",
  };
}

async function querySpendingReport(
  reader: PGliteSpendingReader,
  kind: QueryKind,
  knowledgeAt: number,
  financialAt: string | null,
  request: Readonly<{ sourceConnectionKey?: string; accountIds?: readonly string[]; transactionIds?: readonly string[]; startDate?: string; endDate?: string }> = {},
): Promise<CanonicalSpendingReport> {
  const base = await transactionRows(reader, kind, knowledgeAt, financialAt, request);
  if (base.length === 0) return emptySpendingReport(kind, knowledgeAt, financialAt);
  const transactionIds = base.map((row) => idString(row.transaction_id, "Transaction identity"));
  const revisionIds = base.map((row) => idString(row.revision_id, "Transaction revision"));
  // A complete 100k-row report cannot bind every ID in one PostgreSQL query.
  // Read the indexed projection tables once and select the requested rows
  // while assembling the report below.
  const scopedTransactionIds = transactionIds.length > 4_096 ? undefined : transactionIds;
  const scopedRevisionIds = revisionIds.length > 4_096 ? undefined : revisionIds;
  const [facts, enrichments, categories, tags] = await Promise.all([
    transactionDateFacts(reader, scopedRevisionIds),
    enrichmentRows(reader, kind, knowledgeAt, scopedTransactionIds),
    categoryRows(reader, kind, knowledgeAt, await activeGeneration(reader), scopedTransactionIds),
    tagRows(reader, kind, knowledgeAt, scopedTransactionIds),
  ]);
  const enrichmentsBy = grouped(enrichments, (row) => idString(row.transaction_id, "Enrichment transaction"));
  const categoriesBy = grouped(categories, (row) => idString(row.transaction_id, "Categorization transaction"));
  const tagsBy = grouped(tags, (row) => idString(row.transaction_id, "Tag transaction"));
  const transactions = base.map((row) => {
    const id = idString(row.transaction_id, "Transaction identity");
    return transactionFromRow(row, facts.get(idString(row.revision_id, "Transaction revision")), categoriesBy.get(id) ?? [], enrichmentsBy.get(id) ?? [], tagsBy.get(id) ?? []);
  });
  return spendingReport(kind, knowledgeAt, financialAt, transactions);
}

/**
 * Hydrate one current transaction for a recognition command.  The complete
 * report path intentionally reads every enrichment row so it can render all
 * records.  Candidate confirmation only needs the pair being changed; keep
 * this path narrow while still using the same canonical row adapters and
 * inclusion policy as the complete report.
 */
async function queryCurrentTransactionById(
  reader: PGliteSpendingReader,
  knowledgeAt: number,
  transactionId: string,
): Promise<CanonicalSpendingTransaction | null> {
  const base = await transactionRows(reader, "current", knowledgeAt, null, { transactionIds: [transactionId] });
  if (base.length === 0) return null;
  const revisionIds = base.map((row) => idString(row.revision_id, "Transaction revision"));
  const [facts, enrichments, categories, tags, generation] = await Promise.all([
    transactionDateFacts(reader, revisionIds),
    enrichmentRows(reader, "current", knowledgeAt, [transactionId]),
    activeGeneration(reader),
    tagRows(reader, "current", knowledgeAt, [transactionId]),
  ]).then(async ([dateFacts, targetedEnrichments, active, targetedTags]) => [
    dateFacts,
    targetedEnrichments,
    await categoryRows(reader, "current", knowledgeAt, active, [transactionId]),
    targetedTags,
    active,
  ] as const);
  const enrichmentsBy = grouped(enrichments, (row) => idString(row.transaction_id, "Enrichment transaction"));
  const categoriesBy = grouped(categories, (row) => idString(row.transaction_id, "Categorization transaction"));
  const tagsBy = grouped(tags, (row) => idString(row.transaction_id, "Tag transaction"));
  return spendingReport("current", knowledgeAt, null, base.map((row) => {
    const id = idString(row.transaction_id, "Transaction identity");
    return transactionFromRow(
      row,
      facts.get(idString(row.revision_id, "Transaction revision")),
      categoriesBy.get(id) ?? [],
      enrichmentsBy.get(id) ?? [],
      tagsBy.get(id) ?? [],
    );
  })).includedTransactions.find((transaction) => transaction.transactionId === transactionId) ?? null;
}

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
  const transactions = await queryPairingTransactionsDirect(reader);
  const byMoney = new Map<string, PairingTransaction[]>();
  for (const transaction of transactions) {
    const key = exactMoneyKey(transaction.amount);
    const bucket = byMoney.get(key);
    if (bucket) bucket.push(transaction);
    else byMoney.set(key, [transaction]);
  }
  const pairs: DeterministicCandidatePairRow[] = [];
  for (const row of invoiceRows) {
    const amount = exactMoney(row, "amount_coefficient", "amount_scale", "currency");
    const invoiceId = idString(row.invoice_id, "Candidate invoice");
    const invoiceDate = stringValue(row.occurrence_value, "Candidate invoice occurrence");
    const invoiceDateBasis = row.occurrence_origin === "source-reported" ? "purchase-date" as const : "posting-date-fallback" as const;
    const candidates = byMoney.get(exactMoneyKey(amount)) ?? [];
    for (const transaction of candidates) {
      const transactionDate = transaction.consumeDate ?? transaction.postingDate ?? transaction.effectiveOn;
      const dateDistanceDays = calendarDayDistance(invoiceDate, transactionDate);
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
       FROM current_spending_pairing_entries
      WHERE TRUE ${dateBounds ? "AND SUBSTRING(COALESCE(consume_date, posting_date, effective_on), 1, 10) BETWEEN ? AND ?" : ""}`,
    dateBounds ? [dateBounds.start, dateBounds.end] : [],
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

function invoiceMoney(row: Row): CanonicalEInvoiceMoneyView | null {
  if (row.amount_coefficient === null || row.amount_coefficient === undefined) return null;
  return {
    coefficient: stringValue(row.amount_coefficient, "Invoice amount coefficient"),
    scale: numeric(row.amount_scale, "Invoice amount scale"),
    currency: stringValue(row.currency, "Invoice currency") as "TWD",
    currencyAuthority: E_INVOICE_CURRENCY_AUTHORITY,
  };
}

function invoiceItem(row: Row): CanonicalEInvoiceItemView {
  return {
    itemId: idString(row.item_id, "Invoice item identity"),
    sequence: numeric(row.sequence, "Invoice item sequence"),
    completeness: stringValue(row.completeness, "Invoice item completeness") as "complete" | "incomplete",
    name: nullableString(row.name),
    quantity: row.quantity_coefficient === null || row.quantity_coefficient === undefined ? null : { coefficient: String(row.quantity_coefficient), scale: numeric(row.quantity_scale, "Invoice quantity scale") },
    unitPrice: row.unit_price_coefficient === null || row.unit_price_coefficient === undefined ? null : {
      coefficient: String(row.unit_price_coefficient),
      scale: numeric(row.unit_price_scale, "Invoice unit price scale"),
      currency: stringValue(row.unit_price_currency, "Invoice unit price currency") as "TWD",
      currencyAuthority: E_INVOICE_CURRENCY_AUTHORITY,
    },
    amount: row.amount_coefficient === null || row.amount_coefficient === undefined ? null : {
      coefficient: String(row.amount_coefficient),
      scale: numeric(row.amount_scale, "Invoice item amount scale"),
      currency: stringValue(row.amount_currency, "Invoice item currency") as "TWD",
      currencyAuthority: E_INVOICE_CURRENCY_AUTHORITY,
    },
    sourceFacts: jsonValue(row.source_fact_json, "Invoice item source facts"),
  };
}

async function invoiceViewFromRow(
  reader: PGliteSpendingReader,
  row: Row,
  suppliedItemRows?: readonly Row[],
): Promise<CanonicalEInvoiceView> {
  const itemRows = suppliedItemRows ?? rows(await pgliteQuery<Row>(reader,
    `SELECT item_id, sequence, completeness, name,
            quantity_coefficient, quantity_scale,
            unit_price_coefficient, unit_price_scale, unit_price_currency,
            unit_price_currency_authority, amount_coefficient, amount_scale,
            amount_currency, amount_currency_authority, source_fact_json
       FROM einvoice_items WHERE revision_id = ? ORDER BY sequence`,
    [row.revision_id],
  ));
  return Object.freeze({
    invoiceId: idString(row.invoice_id, "Invoice identity"),
    stableInvoiceKey: stringValue(row.stable_invoice_key, "Invoice stable key"),
    identity: {
      integrationNamespace: E_INVOICE_INTEGRATION_NAMESPACE,
      sourceConnectionKey: stringValue(row.source_connection_key, "Invoice source connection"),
      identityEpoch: stringValue(row.identity_epoch_key, "Invoice identity epoch"),
      stream: E_INVOICE_STREAM,
      recordKind: E_INVOICE_RECORD_KIND,
      subjectDigest: stringValue(row.subject_digest, "Invoice subject digest"),
    },
    revision: {
      revisionId: idString(row.revision_id, "Invoice revision"),
      sourceRevisionKey: stringValue(row.source_revision_key, "Invoice source revision key"),
      revisionNumber: numeric(row.revision_number, "Invoice revision number"),
      revisionKind: stringValue(row.revision_kind, "Invoice revision kind") as "issued" | "revised" | "revoked",
      state: stringValue(row.state, "Invoice state") as "active" | "revoked",
      invoiceNumber: stringValue(row.invoice_number, "Invoice number"),
      randomNumber: nullableString(row.random_number),
      seller: { taxId: stringValue(row.seller_tax_id, "Invoice seller tax ID"), name: nullableString(row.seller_name) },
      total: invoiceMoney(row),
      occurrence: {
        value: stringValue(row.occurrence_value, "Invoice occurrence"),
        precision: stringValue(row.occurrence_precision, "Invoice occurrence precision") as "date" | "minute" | "second",
        timeZone: stringValue(row.occurrence_time_zone, "Invoice occurrence time zone"),
        origin: stringValue(row.occurrence_origin, "Invoice occurrence origin") as "source-reported" | "provider-reported-date-fallback",
      },
      authority: { routeKey: stringValue(row.authority_route, "Invoice authority route"), contractVersion: stringValue(row.contract_version, "Invoice contract version") },
      provenance: { kind: stringValue(row.provenance_kind, "Invoice provenance kind") as "provider-record" | "provider-revocation" | "fixture", reference: stringValue(row.provenance_reference, "Invoice provenance reference"), sourceField: nullableString(row.provenance_source_field) },
      revocationReason: nullableString(row.revocation_reason),
      captureId: idString(row.capture_id, "Invoice capture"),
      captureKey: stringValue(row.capture_key, "Invoice capture key"),
      sourceRecordId: idString(row.source_record_id, "Invoice source record"),
      commitSequence: numeric(row.commit_sequence, "Invoice commit sequence"),
      items: itemRows.map(invoiceItem),
    },
  });
}

async function invoiceViewsFromRows(
  reader: PGliteSpendingReader,
  sourceRows: readonly Row[],
): Promise<readonly CanonicalEInvoiceView[]> {
  if (sourceRows.length === 0) return Object.freeze([]);
  const revisionIds = sourceRows.map((row) => row.revision_id);
  const itemRows = rows(await pgliteQuery<Row>(reader,
    `SELECT revision_id, item_id, sequence, completeness, name,
            quantity_coefficient, quantity_scale,
            unit_price_coefficient, unit_price_scale, unit_price_currency,
            unit_price_currency_authority, amount_coefficient, amount_scale,
            amount_currency, amount_currency_authority, source_fact_json
       FROM einvoice_items
      WHERE revision_id IN (${revisionIds.map(() => "?").join(",")})
      ORDER BY revision_id, sequence`,
    revisionIds,
  ));
  const itemsByRevision = new Map<string, Row[]>();
  for (const item of itemRows) {
    const key = idString(item.revision_id, "Invoice item revision");
    const items = itemsByRevision.get(key);
    if (items) items.push(item);
    else itemsByRevision.set(key, [item]);
  }
  const views = await Promise.all(sourceRows.map((row) =>
    invoiceViewFromRow(reader, row, itemsByRevision.get(idString(row.revision_id, "Invoice revision")) ?? []),
  ));
  return Object.freeze(views);
}

async function invoices(
  reader: PGliteSpendingReader,
  knowledgeAt: number,
  historical = false,
  invoiceIdentity?: string,
  invoiceIdentities?: readonly string[],
): Promise<readonly CanonicalEInvoiceView[]> {
  if (invoiceIdentities?.length === 0) return Object.freeze([]);
  const cutoff = historical ? "WHERE source_rows.commit_sequence <= ?" : "";
  const identityFilter = invoiceIdentities !== undefined
    ? `${cutoff ? "AND" : "WHERE"} source_rows.invoice_id IN (${invoiceIdentities.map(() => "?").join(",")})`
    : invoiceIdentity === undefined
      ? ""
      : `${cutoff ? "AND" : "WHERE"} source_rows.invoice_id = ?`;
  if (invoiceIdentity !== undefined && invoiceIdentities !== undefined)
    throw new TypeError("Invoice query accepts one identity filter.");
  const result = await pgliteQuery<Row>(reader,
    `WITH source_rows AS (
       SELECT revision.revision_id, revision.invoice_id, revision.source_record_id,
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
     ), ranked AS (
       SELECT source_rows.*,
              ROW_NUMBER() OVER (PARTITION BY source_rows.invoice_id ORDER BY source_rows.revision_number DESC, source_rows.commit_sequence DESC, source_rows.revision_id DESC) AS revision_rank
         FROM source_rows
         ${cutoff} ${identityFilter}
     )
     SELECT * FROM ranked WHERE revision_rank = 1 ORDER BY commit_sequence, stable_invoice_key`,
    historical
      ? [knowledgeAt, ...(invoiceIdentities?.map((value) => bytes(value, "Invoice identity")) ?? (invoiceIdentity === undefined ? [] : [bytes(invoiceIdentity, "Invoice identity")]))]
      : invoiceIdentities?.map((value) => bytes(value, "Invoice identity")) ?? (invoiceIdentity === undefined ? [] : [bytes(invoiceIdentity, "Invoice identity")]),
  );
  const resultRows = rows(result);
  return invoiceViewsFromRows(reader, resultRows);
}

/** A commit's recorded_at_utc_us as an ISO-8601 UTC instant with millisecond precision. */
export function recordedAtIso(value: unknown): string {
  const microseconds = numeric(value, "Commit recorded time");
  return new Date(Math.floor(microseconds / 1000)).toISOString();
}

function linkFromRow(row: Row): SpendingDedupLinkView {
  return {
    invoiceId: idString(row.invoice_id, "Recognition invoice"),
    transactionId: idString(row.transaction_id, "Recognition transaction"),
    eventId: idString(row.event_id, "Recognition event"),
    origin: stringValue(row.decision_origin, "Recognition origin") as "user" | "source",
    evidenceKnowledgeSequence: numeric(row.evidence_knowledge_sequence, "Recognition evidence sequence"),
    decisionCommitSequence: numeric(row.commit_sequence, "Recognition commit sequence"),
    decidedAt: recordedAtIso(row.recorded_at_utc_us),
    evidence: jsonValue(row.evidence_json, "Recognition evidence"),
    userId: nullableString(row.user_id),
    authorityRoute: nullableString(row.authority_route),
    stableCrossSourceReference: nullableString(row.stable_cross_source_reference),
  };
}

function refundFromRow(row: Row): SpendingRefundView {
  const active = row.state === "active";
  const commitSequence = numeric(row.commit_sequence, "Refund commit sequence");
  return {
    refundId: idString(row.refund_id, "Refund identity"),
    stableRefundKey: stringValue(row.stable_refund_key, "Stable refund key"),
    transactionId: idString(row.transaction_id, "Refund transaction"),
    revisionId: idString(row.revision_id, "Refund revision"),
    sourceRevisionKey: stringValue(row.source_revision_key, "Refund source revision"),
    revisionNumber: numeric(row.revision_number, "Refund revision number"),
    revisionKind: stringValue(row.revision_kind, "Refund revision kind") as SpendingRefundView["revisionKind"],
    state: stringValue(row.state, "Refund state") as SpendingRefundView["state"],
    amount: active ? exactMoney(row) : null,
    occurrence: active ? { value: stringValue(row.occurrence_value, "Refund occurrence"), precision: stringValue(row.occurrence_precision, "Refund occurrence precision") as "date" | "minute" | "second", timeZone: stringValue(row.occurrence_time_zone, "Refund time zone"), basis: stringValue(row.date_basis, "Refund date basis") as "source-occurrence" | "posting-date-fallback" } : null,
    authorityRoute: stringValue(row.authority_route, "Refund authority route"),
    provenanceReference: stringValue(row.provenance_reference, "Refund provenance reference"),
    evidence: jsonValue(row.evidence_json, "Refund evidence"),
    commitSequence,
  };
}

export async function querySpendingRecognition(
  reader: PGliteSpendingReader,
  request: Readonly<{ knowledgeAt?: number; invoiceIds?: readonly string[]; transactionIds?: readonly string[] }> = {},
): Promise<SpendingRecognitionSnapshot> {
  const current = await latest(reader);
  const cutoff = request.knowledgeAt ?? current;
  if (!Number.isSafeInteger(cutoff) || cutoff < 0 || cutoff > current) throw new Error("Spending recognition knowledge cutoff is invalid.");
  const targetedRecognition = request.invoiceIds !== undefined || request.transactionIds !== undefined;
  if (targetedRecognition && !request.invoiceIds?.length && !request.transactionIds?.length) {
    return Object.freeze({ knowledgeAt: cutoff, candidates: Object.freeze([]), activeLinks: Object.freeze([]), denied: Object.freeze([]), refunds: Object.freeze([]) });
  }
  const pairIdentityFilters: string[] = [];
  const pairIdentityParams: unknown[] = [];
  if (request.invoiceIds?.length) {
    pairIdentityFilters.push(`event.invoice_id IN (${request.invoiceIds.map(() => "?").join(",")})`);
    pairIdentityParams.push(...request.invoiceIds.map((value) => bytes(value, "Recognition invoice")));
  }
  if (request.transactionIds?.length) {
    pairIdentityFilters.push(`event.transaction_id IN (${request.transactionIds.map(() => "?").join(",")})`);
    pairIdentityParams.push(...request.transactionIds.map((value) => bytes(value, "Recognition transaction")));
  }
  const pairIdentityFilter = pairIdentityFilters.length > 0 ? `AND (${pairIdentityFilters.join(" OR ")})` : "";
  const pairRows = rows(await pgliteQuery<Row>(reader,
    `WITH ranked AS (
       SELECT event.*, commit_row.commit_sequence, commit_row.recorded_at_utc_us,
              ROW_NUMBER() OVER (PARTITION BY event.invoice_id, event.transaction_id ORDER BY commit_row.commit_sequence DESC, event.event_id DESC) AS event_rank
         FROM spending_dedup_decision_events event
         JOIN canonical_commits commit_row ON commit_row.commit_id = event.commit_id
        WHERE commit_row.commit_sequence <= ? ${pairIdentityFilter}
     ) SELECT * FROM ranked WHERE event_rank = 1`,
    [cutoff, ...pairIdentityParams],
  ));
  const activeLinks: SpendingDedupLinkView[] = [];
  const denied: SpendingPair[] = [];
  const status = new Map<string, SpendingCandidateView["status"]>();
  for (const row of pairRows) {
    const invoiceId = idString(row.invoice_id, "Recognition invoice");
    const transactionId = idString(row.transaction_id, "Recognition transaction");
    const eventKind = stringValue(row.event_kind, "Recognition event kind") as SpendingCandidateView["status"];
    status.set(pairKey(invoiceId, transactionId), eventKind);
    if (eventKind === "confirmed") activeLinks.push(linkFromRow(row));
    else if (eventKind === "denied") denied.push({ invoiceId, transactionId });
  }
  const candidateIdentityFilters: string[] = [];
  const candidateIdentityParams: unknown[] = [];
  if (request.invoiceIds?.length) {
    candidateIdentityFilters.push(`candidate.invoice_id IN (${request.invoiceIds.map(() => "?").join(",")})`);
    candidateIdentityParams.push(...request.invoiceIds.map((value) => bytes(value, "Candidate invoice")));
  }
  if (request.transactionIds?.length) {
    candidateIdentityFilters.push(`candidate.transaction_id IN (${request.transactionIds.map(() => "?").join(",")})`);
    candidateIdentityParams.push(...request.transactionIds.map((value) => bytes(value, "Candidate transaction")));
  }
  const candidateIdentityFilter = candidateIdentityFilters.length > 0 ? `AND (${candidateIdentityFilters.join(" OR ")})` : "";
  const candidateRows = rows(await pgliteQuery<Row>(reader,
    `SELECT candidate.*, created.commit_sequence
       FROM spending_match_candidates candidate
       JOIN canonical_commits created ON created.commit_id = candidate.created_commit_id
      WHERE created.commit_sequence <= ? ${candidateIdentityFilter}
      ORDER BY created.commit_sequence, candidate.candidate_id`,
    [cutoff, ...candidateIdentityParams],
  ));
  const candidates = candidateRows.map((row) => {
    const invoiceId = idString(row.invoice_id, "Candidate invoice");
    const transactionId = idString(row.transaction_id, "Candidate transaction");
    return {
      invoiceId,
      transactionId,
      candidateId: idString(row.candidate_id, "Candidate identity"),
      algorithm: stringValue(row.algorithm, "Candidate algorithm"),
      algorithmVersion: stringValue(row.algorithm_version, "Candidate algorithm version"),
      similarityEvidence: jsonValue(row.similarity_evidence_json, "Candidate similarity evidence"),
      status: status.get(pairKey(invoiceId, transactionId)) ?? "candidate",
    } satisfies SpendingCandidateView;
  });
  const refundIdentityFilter = !request.transactionIds?.length
    ? ""
    : `AND identity.transaction_id IN (${request.transactionIds.map(() => "?").join(",")})`;
  const refundRows = request.transactionIds?.length === 0 ? [] : rows(await pgliteQuery<Row>(reader,
    `WITH ranked AS (
       SELECT revision.*, identity.stable_refund_key,
              identity.transaction_id, commit_row.commit_sequence,
              ROW_NUMBER() OVER (PARTITION BY revision.refund_id ORDER BY revision.revision_number DESC, commit_row.commit_sequence DESC, revision.revision_id DESC) AS revision_rank
         FROM spending_refund_revisions revision
         JOIN spending_refund_identities identity ON identity.refund_id = revision.refund_id
         JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
        WHERE commit_row.commit_sequence <= ? ${refundIdentityFilter}
     ) SELECT * FROM ranked WHERE revision_rank = 1 ORDER BY commit_sequence, refund_id`,
    [cutoff, ...(request.transactionIds?.map((value) => bytes(value, "Refund transaction")) ?? [])],
  ));
  const refunds = refundRows.map(refundFromRow);
  return Object.freeze({ knowledgeAt: cutoff, candidates: Object.freeze(candidates), activeLinks: Object.freeze(activeLinks), denied: Object.freeze(denied), refunds: Object.freeze(refunds.filter((refund) => refund.state === "active")) });
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

function matchingTransaction(transaction: CanonicalSpendingTransaction): SpendingMatchingTransaction {
  return { transactionId: transaction.transactionId, effectiveOn: transaction.effectiveOn, consumeDate: transaction.consumeDate, postingDate: transaction.postingDate, description: transaction.description, amount: transaction.amount };
}

/**
 * Opening Spending must not write a similarity candidate, but it still needs
 * to show deterministic possible duplicates. Keep those hints ephemeral just
 * until a command materializes a candidate.
 */
function withEphemeralCandidates(
  report: PurchaseReport,
  invoiceViews: readonly CanonicalEInvoiceView[],
  transactions: readonly CanonicalSpendingTransaction[],
): PurchaseReport {
  const activePairs = new Set(
    report.records
      .filter((record) => record.basis === "linked" && record.link)
      .map((record) => pairKey(record.link!.invoiceId, record.link!.transactionId)),
  );
  const durableByPair = new Map(
    report.candidates.map((candidate) => [pairKey(candidate.invoiceId, candidate.transactionId), candidate]),
  );
  const deterministic = evaluateSpendingMatchCandidates(invoiceViews, transactions);
  const inferred = deterministic
    .filter((candidate) => !activePairs.has(pairKey(candidate.invoiceId, candidate.transactionId)))
    .map((candidate) => {
      const durable = durableByPair.get(pairKey(candidate.invoiceId, candidate.transactionId));
      if (durable && durable.status !== "candidate") return null;
      return durable ?? {
        invoiceId: candidate.invoiceId,
        transactionId: candidate.transactionId,
        candidateId: candidate.candidateKey,
        algorithm: candidate.algorithm,
        algorithmVersion: candidate.algorithmVersion,
        similarityEvidence: candidate.similarityEvidence,
        status: "candidate" as const,
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
  const candidates = [...report.candidates];
  const known = new Set(candidates.map((candidate) => candidate.candidateId));
  for (const candidate of inferred) if (!known.has(candidate.candidateId)) candidates.push(candidate);
  const byInvoice = new Map<string, string[]>();
  const byTransaction = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (candidate.status !== "candidate") continue;
    const invoiceIds = byInvoice.get(candidate.invoiceId) ?? [];
    invoiceIds.push(candidate.candidateId);
    byInvoice.set(candidate.invoiceId, invoiceIds);
    const transactionIds = byTransaction.get(candidate.transactionId) ?? [];
    transactionIds.push(candidate.candidateId);
    byTransaction.set(candidate.transactionId, transactionIds);
  }
  const records = report.records.map((record) => {
    const ids = [
      ...(record.invoice ? byInvoice.get(record.invoice.invoiceId) ?? [] : []),
      ...(record.transaction ? byTransaction.get(record.transaction.transactionId) ?? [] : []),
    ];
    if (ids.length === 0) return record;
    return {
      ...record,
      candidateIds: Object.freeze([...new Set([...record.candidateIds, ...ids])]),
      possibleDuplicate: true,
    };
  });
  return Object.freeze({
    ...report,
    records: Object.freeze(records),
    totalStatus: records.some((record) => record.possibleDuplicate)
      ? "includes-pending-confirmation"
      : report.totalStatus,
    candidates: Object.freeze(candidates),
  });
}

export type PGliteRecognitionMutation = Readonly<{
  kind: "confirmed" | "denied" | "revoked";
  invoiceId: string;
  transactionId: string;
}>;

export function linkedPurchaseRecord(
  invoice: CanonicalEInvoiceView,
  payment: CanonicalSpendingTransaction,
  link: SpendingDedupLinkView,
  candidateIds: readonly string[],
  itemCategorizations: readonly PurchaseItemCategorization[],
): PurchaseReport["records"][number] {
  const invoiceAmount = invoice.revision.total
    ? { coefficient: invoice.revision.total.coefficient, scale: invoice.revision.total.scale, currency: invoice.revision.total.currency }
    : null;
  return {
    purchaseId: `link:${link.eventId}`,
    basis: "linked",
    amount: payment.amount,
    occurrence: {
      value: invoice.revision.occurrence.value,
      precision: invoice.revision.occurrence.precision,
      timeZone: invoice.revision.occurrence.timeZone,
      basis: invoice.revision.occurrence.origin === "source-reported" ? "purchase-date" : "posting-date-fallback",
    },
    description: invoice.revision.seller.name ?? payment.description,
    invoice,
    transaction: payment,
    items: invoice.revision.items,
    possibleDuplicate: candidateIds.length > 0,
    candidateIds: Object.freeze([...candidateIds]),
    link,
    difference: {
      invoiceAmount,
      bankAmount: payment.amount,
      sameCurrency: invoiceAmount?.currency === payment.amount.currency,
      exactAmountEqual: invoiceAmount ? exactMoneyEqual(invoiceAmount, payment.amount) : false,
    },
    refund: null,
    category: purchaseRecordCategory({ basis: "linked", amount: payment.amount, invoice, transaction: payment, itemCategorizations }),
    itemCategorizations,
    paymentSource: null,
  };
}

export function subtractInvoiceTotal(
  totals: PurchaseReport["totalsByCurrency"],
  removed: Readonly<{ currency: string; coefficient: string; scale: number }> | null,
): PurchaseReport["totalsByCurrency"] {
  if (!removed) return totals;
  return totals.map((entry) => {
    if (entry.currency !== removed.currency) return entry;
    const scale = Math.max(entry.scale, removed.scale);
    const coefficient = BigInt(entry.coefficient) * 10n ** BigInt(scale - entry.scale) -
      BigInt(removed.coefficient) * 10n ** BigInt(scale - removed.scale);
    return { currency: entry.currency, coefficient: coefficient.toString(), scale, count: entry.count - 1 };
  }).filter((entry) => entry.count > 0);
}

function insertPurchaseRecord(
  records: readonly PurchaseReport["records"][number][],
  value: PurchaseReport["records"][number],
): readonly PurchaseReport["records"][number][] {
  const next = [...records];
  let index = next.findIndex((candidate) =>
    candidate.occurrence.value.localeCompare(value.occurrence.value) > 0 ||
    (candidate.occurrence.value === value.occurrence.value && candidate.purchaseId.localeCompare(value.purchaseId) > 0),
  );
  if (index < 0) index = next.length;
  next.splice(index, 0, value);
  return next;
}

function addInvoiceTotal(
  totals: PurchaseReport["totalsByCurrency"],
  added: Readonly<{ currency: string; coefficient: string; scale: number }> | null,
): PurchaseReport["totalsByCurrency"] {
  if (!added) return totals;
  const existing = totals.find((entry) => entry.currency === added.currency);
  if (!existing) {
    return [...totals, { ...added, count: 1 }]
      .sort((left, right) => left.currency.localeCompare(right.currency));
  }
  const scale = Math.max(existing.scale, added.scale);
  const coefficient = BigInt(existing.coefficient) * 10n ** BigInt(scale - existing.scale) +
    BigInt(added.coefficient) * 10n ** BigInt(scale - added.scale);
  return totals
    .map((entry) => entry.currency === added.currency
      ? { currency: entry.currency, coefficient: coefficient.toString(), scale, count: entry.count + 1 }
      : entry)
    .sort((left, right) => left.currency.localeCompare(right.currency));
}

function standaloneInvoiceRecord(
  linked: PurchaseReport["records"][number],
  candidateIds: readonly string[],
): PurchaseReport["records"][number] {
  if (!linked.invoice) throw new Error("Spending revoke cannot restore a missing invoice record.");
  const total = linked.invoice.revision.total
    ? {
        coefficient: linked.invoice.revision.total.coefficient,
        scale: linked.invoice.revision.total.scale,
        currency: linked.invoice.revision.total.currency,
      }
    : null;
  return {
    purchaseId: `invoice:${linked.invoice.invoiceId}`,
    basis: "invoice",
    amount: total,
    occurrence: {
      value: linked.invoice.revision.occurrence.value,
      precision: linked.invoice.revision.occurrence.precision,
      timeZone: linked.invoice.revision.occurrence.timeZone,
      basis: linked.invoice.revision.occurrence.origin === "source-reported" ? "purchase-date" : "posting-date-fallback",
    },
    description: linked.invoice.revision.seller.name,
    invoice: linked.invoice,
    transaction: null,
    items: linked.invoice.revision.items,
    possibleDuplicate: candidateIds.length > 0,
    candidateIds: Object.freeze([...candidateIds]),
    link: null,
    difference: null,
    refund: null,
    category: purchaseRecordCategory({ basis: "invoice", amount: total, invoice: linked.invoice, transaction: null, itemCategorizations: linked.itemCategorizations }),
    itemCategorizations: linked.itemCategorizations,
    paymentSource: null,
  };
}

function standaloneTransactionRecord(
  linked: PurchaseReport["records"][number],
  candidateIds: readonly string[],
): PurchaseReport["records"][number] {
  if (!linked.transaction) throw new Error("Spending revoke cannot restore a missing transaction record.");
  const occurrence = occurrenceForTransaction(linked.transaction);
  return {
    purchaseId: `transaction:${linked.transaction.transactionId}`,
    basis: "bank-transaction",
    amount: linked.transaction.amount,
    occurrence,
    description: linked.transaction.description,
    invoice: null,
    transaction: linked.transaction,
    items: [],
    possibleDuplicate: candidateIds.length > 0,
    candidateIds: Object.freeze([...candidateIds]),
    link: null,
    difference: null,
    refund: null,
    category: purchaseRecordCategory({ basis: "bank-transaction", amount: linked.transaction.amount, invoice: null, transaction: linked.transaction, itemCategorizations: [] }),
    itemCategorizations: [],
    paymentSource: linked.paymentSource,
  };
}

/**
 * Apply a recognition-only mutation to an already composed report.  Invoice
 * and transaction facts are immutable during these commands, so rebuilding
 * the full report would rescan every row for a change to one pair.  The
 * result has the same ordering and totals as composePurchaseReport for the
 * affected confirmation or denial.
 */
export function targetedPGlitePurchaseReportAfterRecognitionMutation(
  before: PurchaseReport,
  recognition: SpendingRecognitionSnapshot,
  mutation: PGliteRecognitionMutation,
): PurchaseReport {
  const target = pairKey(mutation.invoiceId, mutation.transactionId);
  const candidates = before.candidates
    .map((candidate) => {
      if (pairKey(candidate.invoiceId, candidate.transactionId) !== target) return candidate;
      return recognition.candidates.find((next) =>
        pairKey(next.invoiceId, next.transactionId) === target &&
        (next.candidateId === candidate.candidateId ||
          // Ephemeral candidates use the deterministic candidate key while
          // materialization assigns a durable UUID. Preserve the candidate's
          // existing position when that UUID appears after the mutation.
          candidate.candidateId.startsWith("sha256:") === true),
      ) ?? null;
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
  const knownCandidateIds = new Set(candidates.map((candidate) => candidate.candidateId));
  for (const candidate of recognition.candidates) {
    if (pairKey(candidate.invoiceId, candidate.transactionId) === target && !knownCandidateIds.has(candidate.candidateId)) candidates.push(candidate);
  }
  const pendingCandidateIds = new Set(candidates.filter((candidate) => candidate.status === "candidate").map((candidate) => candidate.candidateId));
  const linkedCandidateIds = candidates
    .filter((candidate) => candidate.status === "candidate" && (candidate.invoiceId === mutation.invoiceId || candidate.transactionId === mutation.transactionId))
    .map((candidate) => candidate.candidateId);
  const targetRecord = before.records.find((record) =>
    record.basis === "linked" &&
    record.invoice?.invoiceId === mutation.invoiceId &&
    record.transaction?.transactionId === mutation.transactionId,
  );
  let records: readonly PurchaseReport["records"][number][] = before.records
    .filter((record) => mutation.kind === "confirmed"
      ? record.invoice?.invoiceId !== mutation.invoiceId && record.transaction?.transactionId !== mutation.transactionId
      : mutation.kind === "revoked"
        ? record.purchaseId !== targetRecord?.purchaseId
        : true)
    .map((record) => {
      const candidateIds = record.candidateIds.filter((candidateId) => pendingCandidateIds.has(candidateId));
      const possibleDuplicate = candidateIds.length > 0;
      if (candidateIds.length === record.candidateIds.length && record.possibleDuplicate === possibleDuplicate) return record;
      return { ...record, candidateIds: Object.freeze(candidateIds), possibleDuplicate };
    });
  let totals = before.totalsByCurrency;
  if (mutation.kind === "confirmed") {
    const invoiceRecord = before.records.find((record) => record.invoice?.invoiceId === mutation.invoiceId);
    const paymentRecord = before.records.find((record) => record.transaction?.transactionId === mutation.transactionId);
    if (!invoiceRecord?.invoice || !paymentRecord?.transaction) throw new Error("Spending confirmation cannot build a targeted report patch.");
    const link = recognition.activeLinks.find((candidate) => pairKey(candidate.invoiceId, candidate.transactionId) === target);
    if (!link) throw new Error("Spending confirmation did not produce an active link.");
    records = insertPurchaseRecord(records, linkedPurchaseRecord(invoiceRecord.invoice, paymentRecord.transaction, link, linkedCandidateIds, invoiceRecord.itemCategorizations));
    const invoiceAmount = invoiceRecord.invoice.revision.total
      ? { coefficient: invoiceRecord.invoice.revision.total.coefficient, scale: invoiceRecord.invoice.revision.total.scale, currency: invoiceRecord.invoice.revision.total.currency }
      : null;
    totals = subtractInvoiceTotal(totals, invoiceAmount);
  }
  if (mutation.kind === "revoked") {
    if (!targetRecord?.invoice || !targetRecord.transaction)
      throw new Error("Spending revoke cannot build a targeted report patch.");
    const pendingForInvoice = candidates
      .filter((candidate) => candidate.status === "candidate" && candidate.invoiceId === mutation.invoiceId)
      .map((candidate) => candidate.candidateId);
    const pendingForTransaction = candidates
      .filter((candidate) => candidate.status === "candidate" && candidate.transactionId === mutation.transactionId)
      .map((candidate) => candidate.candidateId);
    records = insertPurchaseRecord(records, standaloneInvoiceRecord(targetRecord, pendingForInvoice));
    records = insertPurchaseRecord(records, standaloneTransactionRecord(targetRecord, pendingForTransaction));
    const invoiceAmount = targetRecord.invoice.revision.total
      ? {
          coefficient: targetRecord.invoice.revision.total.coefficient,
          scale: targetRecord.invoice.revision.total.scale,
          currency: targetRecord.invoice.revision.total.currency,
        }
      : null;
    totals = addInvoiceTotal(totals, invoiceAmount);
  }
  return Object.freeze({
    ...before,
    knowledgeAt: recognition.knowledgeAt,
    records: Object.freeze(records),
    totalsByCurrency: totals,
    totalStatus: records.some((record) => record.possibleDuplicate) ? "includes-pending-confirmation" : "complete",
    candidates: Object.freeze(candidates),
  });
}

export async function queryCurrentSpending(
  reader: PGliteSpendingReader,
  request: Readonly<{ sourceConnectionKey?: string; accountIds?: readonly string[]; transactionIds?: readonly string[]; startDate?: string; endDate?: string }> = {},
): Promise<CurrentSpendingQueryResult> {
  const knowledgeAt = await latest(reader);
  const [spending, invoiceViews, recognition, itemCategorizations] = await Promise.all([
    querySpendingReport(reader, "current", knowledgeAt, null, request),
    invoices(reader, knowledgeAt),
    querySpendingRecognition(reader, { knowledgeAt }),
    itemCategorizationRows(reader),
  ]);
  const purchaseReport = withEphemeralCandidates(composePurchaseReport({
    request: { kind: "current" },
    knowledgeAt,
    invoices: invoiceViews,
    transactions: spending.includedTransactions,
    recognition,
    itemCategorizations,
  }), invoiceViews, spending.includedTransactions);
  return { status: "ok", kind: "current", product: "spending", spending, invoices: invoiceViews, purchaseReport };
}

function jsonRows(value: unknown, label: string): readonly Row[] {
  if (Array.isArray(value)) return value as readonly Row[];
  try {
    const parsed: unknown = JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(parsed)) throw new Error("array required");
    return parsed as readonly Row[];
  } catch (error) {
    throw new Error(`${label} is not valid JSON array.`, { cause: error });
  }
}

function summaryMoneyRows(value: unknown, label: string) {
  return Object.freeze(jsonRows(value, label).map((row) => {
    const coefficient = stringValue(row.coefficient, `${label} coefficient`);
    if (!/^-?\d+(?:\.0+)?$/u.test(coefficient))
      throw new Error(`${label} coefficient is not an integer.`);
    let exactCoefficient = BigInt(coefficient.replace(/\.0+$/u, ""));
    let scale = numeric(row.scale, `${label} scale`);
    while (scale > 0 && exactCoefficient % 10n === 0n) {
      exactCoefficient /= 10n;
      scale -= 1;
    }
    return Object.freeze({
      currency: stringValue(row.currency, `${label} currency`),
      coefficient: exactCoefficient.toString(),
      scale,
      count: numeric(row.count, `${label} count`),
    });
  }));
}

type SpendingRecordCursor = Readonly<{
  schemaVersion: 1;
  knowledgeAt: number;
  month: string | null;
  day: string | null;
  categoryCodes: readonly string[] | null;
  occurrence: string;
  purchaseId: string;
}>;

function spendingRecordCursorToken(cursor: SpendingRecordCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function spendingRecordCursorFromToken(
  token: string | null | undefined,
  request: Readonly<{ knowledgeAt: number; month: string | null; day: string | null; categoryCodes: readonly string[] | null }>,
): SpendingRecordCursor | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Partial<SpendingRecordCursor>;
    if (parsed.schemaVersion !== 1 || parsed.knowledgeAt !== request.knowledgeAt
        || parsed.month !== request.month || parsed.day !== request.day
        || JSON.stringify(parsed.categoryCodes ?? null) !== JSON.stringify(request.categoryCodes)
        || typeof parsed.occurrence !== "string" || !ISO_DATE.test(parsed.occurrence.slice(0, 10))
        || typeof parsed.purchaseId !== "string" || parsed.purchaseId.length === 0)
      throw new Error("invalid cursor fields");
    return parsed as SpendingRecordCursor;
  } catch (error) {
    throw new Error("Spending record cursor is stale or invalid; reload the current page.", { cause: error });
  }
}

function validSpendingMonth(value: string): boolean {
  return /^\d{4}-(?:0[1-9]|1[0-2])$/u.test(value);
}

function validSpendingDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Bank-side display facts for the given transactions: the card mask reduced
 * to `****dddd`, and the cycle of the latest statement revision that lists the
 * transaction. Account numbers and instrument keys never leave this query.
 */
export async function queryPaymentSourceFacts(
  reader: PGliteSpendingReader,
  transactionIds: readonly string[],
): Promise<PurchasePaymentSourceIndex> {
  if (transactionIds.length === 0) return new Map();
  const result = rows(await pgliteQuery<Row>(reader,
    `SELECT current_row.transaction_id, instrument.card_mask, statement.cycle_start, statement.cycle_end
       FROM current_transactions current_row
       LEFT JOIN LATERAL (
         SELECT detail.instrument_id
           FROM canonical_credit_card_transaction_details detail
          WHERE detail.revision_id = current_row.revision_id
          ORDER BY detail.source_record_id
          LIMIT 1
       ) detail ON TRUE
       LEFT JOIN canonical_credit_card_instruments instrument ON instrument.instrument_id = detail.instrument_id
       LEFT JOIN LATERAL (
         SELECT revision.cycle_start, revision.cycle_end
           FROM canonical_credit_card_statement_memberships membership
           JOIN canonical_credit_card_statement_revisions revision
             ON revision.statement_revision_id = membership.statement_revision_id
          WHERE membership.transaction_id = current_row.transaction_id
            AND revision.revision_number = (
              SELECT MAX(latest.revision_number)
                FROM canonical_credit_card_statement_revisions latest
               WHERE latest.statement_id = revision.statement_id)
          ORDER BY revision.cycle_end DESC
          LIMIT 1
       ) statement ON TRUE
      WHERE current_row.transaction_id IN (${transactionIds.map(() => "?").join(",")})`,
    transactionIds.map((value) => bytes(value, "Payment source transaction")),
  ));
  return new Map(result.map((row) => [
    idString(row.transaction_id, "Payment source transaction"),
    Object.freeze({
      cardMask: cardMaskLastFour(nullableString(row.card_mask)),
      billingPeriod: row.cycle_start === null || row.cycle_start === undefined ? null : Object.freeze({
        start: stringValue(row.cycle_start, "Statement cycle start"),
        end: stringValue(row.cycle_end, "Statement cycle end"),
      }),
    }),
  ]));
}

function sqlUuid(expression: string): string {
  const hex = `encode(${expression}, 'hex')`;
  return `substring(${hex} from 1 for 8) || '-' || substring(${hex} from 9 for 4) || '-' || substring(${hex} from 13 for 4) || '-' || substring(${hex} from 17 for 4) || '-' || substring(${hex} from 21 for 12)`;
}

/**
 * Every purchase-basis Spending query starts from the same purchase rows: the
 * active invoices, the eligible transactions, the links joining them, and the
 * refunds. The two leading parameters are the knowledge cutoff, twice.
 */
const PURCHASE_ROWS_CTE = `
    WITH invoice_ranked AS (
      SELECT revision.invoice_id, revision.revision_id, revision.amount_coefficient,
             revision.amount_scale, revision.currency, revision.state,
             revision.occurrence_value, commit_row.commit_sequence,
             ROW_NUMBER() OVER (
               PARTITION BY revision.invoice_id
               ORDER BY revision.revision_number DESC,
                        commit_row.commit_sequence DESC, revision.revision_id DESC
             ) AS revision_rank
        FROM einvoice_invoice_revisions revision
        JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
       WHERE commit_row.commit_sequence <= ?
    ), active_invoices AS MATERIALIZED (
      SELECT invoice_id, revision_id, amount_coefficient, amount_scale, currency, occurrence_value
        FROM invoice_ranked
       WHERE revision_rank = 1 AND state = 'active'
    ), linked_transactions AS MATERIALIZED (
      SELECT current_row.transaction_id, revision.amount_coefficient,
             revision.amount_scale, revision.currency,
             COALESCE(facts.consume_date, facts.posting_date, revision.effective_on) AS occurrence_value
        FROM current_spending_dedup_links active_link
        JOIN current_transactions current_row ON current_row.transaction_id = active_link.transaction_id
        JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id
        JOIN current_transaction_enrichment kind
          ON kind.transaction_id = current_row.transaction_id AND kind.field_name = 'kind'
        LEFT JOIN LATERAL (
          SELECT consume_date, posting_date
            FROM canonical_credit_card_transaction_details detail
           WHERE detail.revision_id = current_row.revision_id
           ORDER BY detail.source_record_id
           LIMIT 1
        ) facts ON TRUE
       WHERE revision.administrative_state = 'active'
         AND revision.economic_status = 'normal'
         AND revision.posting_status = 'posted'
         AND revision.direction = 'outflow'
         AND kind.taxonomy_code IS NOT NULL
         AND kind.taxonomy_code NOT IN ('transfer', 'cash', 'investment', 'payment.credit_card', 'payment.loan')
         AND kind.taxonomy_code NOT LIKE 'transfer.%'
         AND kind.taxonomy_code NOT LIKE 'cash.%'
         AND kind.taxonomy_code NOT LIKE 'investment.%'
         AND kind.taxonomy_code NOT LIKE 'payment.credit_card.%'
         AND kind.taxonomy_code NOT LIKE 'payment.loan.%'
    ), eligible_transactions AS MATERIALIZED (
      SELECT transaction_id, amount_coefficient, amount_scale, currency,
             COALESCE(consume_date, posting_date, effective_on) AS occurrence_value
        FROM current_spending_pairing_entries
      UNION ALL
      SELECT transaction_id, amount_coefficient, amount_scale, currency, occurrence_value
        FROM linked_transactions
    ), valid_links AS MATERIALIZED (
      SELECT active_link.invoice_id, active_link.transaction_id,
             active_link.confirmed_event_id AS event_id
        FROM current_spending_dedup_links active_link
        JOIN active_invoices invoice ON invoice.invoice_id = active_link.invoice_id
        JOIN eligible_transactions transaction_row ON transaction_row.transaction_id = active_link.transaction_id
    ), refund_ranked AS (
      SELECT revision.refund_id, identity.transaction_id,
             revision.amount_coefficient, revision.amount_scale, revision.currency,
             revision.occurrence_value, revision.state, commit_row.commit_sequence,
             ROW_NUMBER() OVER (
               PARTITION BY revision.refund_id
               ORDER BY revision.revision_number DESC,
                        commit_row.commit_sequence DESC, revision.revision_id DESC
             ) AS revision_rank
        FROM spending_refund_revisions revision
        JOIN spending_refund_identities identity ON identity.refund_id = revision.refund_id
        JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
       WHERE commit_row.commit_sequence <= ?
    ), active_refunds AS MATERIALIZED (
      SELECT refund_id, transaction_id, amount_coefficient, amount_scale, currency, occurrence_value
        FROM refund_ranked
       WHERE revision_rank = 1 AND state = 'active'
         AND amount_coefficient IS NOT NULL AND occurrence_value IS NOT NULL
    ), purchase_rows AS MATERIALIZED (
      SELECT 'linked' AS basis, invoice.occurrence_value,
             transaction_row.amount_coefficient, transaction_row.amount_scale, transaction_row.currency,
             invoice.amount_coefficient AS invoice_amount_coefficient,
             invoice.amount_scale AS invoice_amount_scale,
             invoice.currency AS invoice_currency,
             invoice.invoice_id, invoice.revision_id AS invoice_revision_id,
             transaction_row.transaction_id, link.event_id,
             NULL::bytea AS refund_id,
             'link:' || ${sqlUuid("link.event_id")} AS purchase_id
        FROM valid_links link
        JOIN active_invoices invoice ON invoice.invoice_id = link.invoice_id
        JOIN eligible_transactions transaction_row ON transaction_row.transaction_id = link.transaction_id
      UNION ALL
      SELECT 'invoice', invoice.occurrence_value,
             invoice.amount_coefficient, invoice.amount_scale, invoice.currency,
             invoice.amount_coefficient, invoice.amount_scale, invoice.currency,
             invoice.invoice_id, invoice.revision_id, NULL::bytea, NULL::bytea, NULL::bytea,
             'invoice:' || ${sqlUuid("invoice.invoice_id")}
        FROM active_invoices invoice
       WHERE NOT EXISTS (SELECT 1 FROM valid_links link WHERE link.invoice_id = invoice.invoice_id)
      UNION ALL
      SELECT 'bank-transaction', transaction_row.occurrence_value,
             transaction_row.amount_coefficient, transaction_row.amount_scale, transaction_row.currency,
             NULL::text, NULL::bigint, NULL::text,
             NULL::bytea, NULL::bytea, transaction_row.transaction_id, NULL::bytea, NULL::bytea,
             'transaction:' || ${sqlUuid("transaction_row.transaction_id")}
        FROM eligible_transactions transaction_row
       WHERE NOT EXISTS (SELECT 1 FROM valid_links link WHERE link.transaction_id = transaction_row.transaction_id)
         AND NOT EXISTS (SELECT 1 FROM active_refunds refund WHERE refund.transaction_id = transaction_row.transaction_id)
      UNION ALL
      SELECT 'refund', refund.occurrence_value,
             refund.amount_coefficient, refund.amount_scale, refund.currency,
             NULL::text, NULL::bigint, NULL::text,
             NULL::bytea, NULL::bytea, refund.transaction_id, NULL::bytea, refund.refund_id,
             'refund:' || ${sqlUuid("refund.refund_id")}
        FROM active_refunds refund
    )`;

type PurchaseCategoryRow = Readonly<{
  purchaseId: string;
  basis: PurchaseReport["records"][number]["basis"];
  occurrence: string;
  amount: Money | null;
  category: PurchaseCategory;
}>;

function itemCategorizationFromRow(row: Row): PurchaseItemCategorization {
  return {
    sequence: numeric(row.item_sequence, "Item categorization sequence"),
    origin: stringValue(row.origin, "Item categorization origin") as "user" | "derived",
    categoryCode: stringValue(row.category_code, "Item categorization code"),
    taxonomyId: stringValue(row.taxonomy_id, "Item categorization taxonomy"),
    taxonomyVersion: stringValue(row.taxonomy_version, "Item categorization taxonomy version"),
    assertionId: idString(row.assertion_id, "Item categorization assertion"),
  };
}

/** Current item categorizations keyed by invoice id, for the Purchase category reading. */
export async function itemCategorizationRows(
  reader: PGliteSpendingReader,
  invoiceIds?: readonly string[],
): Promise<PurchaseItemCategorizationIndex> {
  if (invoiceIds?.length === 0) return new Map();
  const filter = invoiceIds === undefined
    ? ""
    : ` WHERE categorization.invoice_id IN (${invoiceIds.map(() => "?").join(",")})`;
  const result = await pgliteQuery<Row>(reader,
    `SELECT categorization.invoice_id, categorization.item_sequence, categorization.origin,
            categorization.category_code, categorization.taxonomy_id, categorization.taxonomy_version,
            categorization.assertion_id
       FROM current_einvoice_item_categorizations categorization${filter}
      ORDER BY categorization.invoice_id, categorization.item_sequence`,
    invoiceIds?.map((value) => bytes(value, "Invoice identity")) ?? [],
  );
  const index = new Map<string, PurchaseItemCategorization[]>();
  for (const row of rows(result)) {
    const invoiceId = idString(row.invoice_id, "Item categorization invoice");
    const list = index.get(invoiceId) ?? [];
    list.push(itemCategorizationFromRow(row));
    index.set(invoiceId, list);
  }
  return index;
}

/**
 * Reads every purchase row's category inputs in one query and applies the
 * shared Purchase category reading, so the summary and the record filter never
 * reimplement ADR 0038 precedence in SQL.
 */
async function queryPurchaseCategoryRows(
  reader: PGliteSpendingReader,
  knowledgeAt: number,
  scope: Readonly<{ month?: string | null; day?: string | null }> = {},
): Promise<readonly PurchaseCategoryRow[]> {
  const params: unknown[] = [knowledgeAt, knowledgeAt];
  const monthFilter = scope.month ? "AND SUBSTRING(purchase_rows.occurrence_value, 1, 7) = ?" : "";
  if (scope.month) params.push(scope.month);
  const dayFilter = scope.day ? "AND SUBSTRING(purchase_rows.occurrence_value, 1, 10) = ?" : "";
  if (scope.day) params.push(scope.day);
  const result = await pgliteQuery<Row>(reader, `${PURCHASE_ROWS_CTE}
    SELECT purchase_rows.basis, purchase_rows.occurrence_value, purchase_rows.purchase_id,
           purchase_rows.amount_coefficient, purchase_rows.amount_scale, purchase_rows.currency,
           purchase_rows.invoice_amount_coefficient, purchase_rows.invoice_amount_scale, purchase_rows.invoice_currency,
           purchase_rows.invoice_id, purchase_rows.transaction_id,
           (SELECT kind.taxonomy_code FROM current_transaction_enrichment kind
             WHERE kind.transaction_id = purchase_rows.transaction_id AND kind.field_name = 'kind') AS kind_code,
           (SELECT json_agg(json_build_object(
              'transaction_id', encode(enrichment.transaction_id, 'hex'), 'field_name', enrichment.field_name,
              'taxonomy_code', enrichment.taxonomy_code, 'origin', enrichment.origin,
              'assertion_id', encode(enrichment.assertion_id, 'hex'),
              'taxonomy_id', enrichment.taxonomy_id, 'taxonomy_version', enrichment.taxonomy_version))
              FROM current_transaction_enrichment enrichment
             WHERE enrichment.transaction_id = purchase_rows.transaction_id AND enrichment.field_name = 'category') AS automatic_rows,
           (SELECT json_agg(json_build_object(
              'transaction_id', encode(projected.transaction_id, 'hex'), 'mode', projected.mode,
              'category_code', projected.category_code, 'taxonomy_id', projected.taxonomy_id,
              'taxonomy_version', projected.taxonomy_version, 'assertion_id', encode(projected.assertion_id, 'hex'),
              'component_ordinal', NULLIF(projected.component_ordinal, 0),
              'booked_coefficient', projected.booked_coefficient, 'booked_scale', projected.booked_scale,
              'booked_currency', projected.booked_currency,
              'conversion_evidence_kind', projected.conversion_evidence_kind,
              'conversion_evidence_id', projected.conversion_evidence_id,
              'conversion_from_currency', projected.conversion_from_currency,
              'conversion_to_currency', projected.conversion_to_currency,
              'conversion_evidence_json', projected.conversion_evidence_json,
              'projection_commit_id', encode(projected.projection_commit_id, 'hex'),
              'projection_commit_sequence', commit_row.commit_sequence
            ) ORDER BY projected.component_ordinal)
              FROM projection_generation_transaction_categorizations projected
              JOIN active_projection_generation active ON active.generation_id = projected.generation_id
              JOIN canonical_commits commit_row ON commit_row.commit_id = projected.projection_commit_id
             WHERE projected.transaction_id = purchase_rows.transaction_id) AS user_rows,
           (SELECT json_agg(json_build_object(
              'item_sequence', item.sequence, 'completeness', item.completeness,
              'amount_coefficient', item.amount_coefficient, 'amount_scale', item.amount_scale,
              'amount_currency', item.amount_currency,
              'origin', categorization.origin, 'category_code', categorization.category_code,
              'taxonomy_id', categorization.taxonomy_id, 'taxonomy_version', categorization.taxonomy_version,
              'assertion_id', encode(categorization.assertion_id, 'hex')) ORDER BY item.sequence)
              FROM einvoice_items item
              LEFT JOIN current_einvoice_item_categorizations categorization
                ON categorization.invoice_id = purchase_rows.invoice_id AND categorization.item_sequence = item.sequence
             WHERE item.revision_id = purchase_rows.invoice_revision_id) AS item_rows
      FROM purchase_rows
     WHERE TRUE ${monthFilter} ${dayFilter}
  `, params);
  return rows(result).map((row) => {
    const basis = stringValue(row.basis, "Purchase basis") as PurchaseCategoryRow["basis"];
    const amount = row.amount_coefficient === null || row.amount_coefficient === undefined ? null : exactMoney(row);
    const categorization = row.transaction_id === null || row.transaction_id === undefined
      ? null
      : categoryFromRows(
          row as TransactionRow,
          nullableString(row.kind_code),
          jsonRows(row.user_rows ?? [], "Purchase user categorization rows") as readonly CategorizationRow[],
          jsonRows(row.automatic_rows ?? [], "Purchase automatic categorization rows") as readonly EnrichmentRow[],
        );
    const itemRows = jsonRows(row.item_rows ?? [], "Purchase item rows");
    const invoice = row.invoice_id === null || row.invoice_id === undefined ? null : {
      total: row.invoice_amount_coefficient === null || row.invoice_amount_coefficient === undefined
        ? null
        : exactMoney(row, "invoice_amount_coefficient", "invoice_amount_scale", "invoice_currency"),
      items: itemRows.map((item) => ({
        sequence: numeric(item.item_sequence, "Purchase item sequence"),
        completeness: stringValue(item.completeness, "Purchase item completeness") as "complete" | "incomplete",
        amount: item.amount_coefficient === null || item.amount_coefficient === undefined
          ? null
          : exactMoney(item, "amount_coefficient", "amount_scale", "amount_currency"),
      })),
    };
    const category = readPurchaseCategory({
      basis,
      countedAmount: amount,
      transaction: categorization ? { categorization } : null,
      invoice,
      itemCategorizations: itemRows.filter((item) => item.category_code !== null && item.category_code !== undefined).map(itemCategorizationFromRow),
    });
    return Object.freeze({
      purchaseId: stringValue(row.purchase_id, "Purchase identity"),
      basis,
      occurrence: stringValue(row.occurrence_value, "Purchase occurrence"),
      amount,
      category,
    });
  });
}

function purchaseCategoryMatchesSelectors(category: PurchaseCategory, selectors: ReadonlySet<string>): boolean {
  if (category.mode === "absent") return selectors.has(SPENDING_UNCLASSIFIED_CATEGORY_SELECTOR);
  return purchaseCategoryCodes(category).some((code) => selectors.has(code));
}

function normalizedCategoryCodes(value: SpendingRecordPageRequest["categoryCodes"]): readonly string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((code) => typeof code !== "string" || code.trim() === ""))
    throw new TypeError("Spending record page category codes must be non-empty strings.");
  const unique = [...new Set(value.map((code) => code.trim()))].sort();
  return unique.length === 0 ? null : Object.freeze(unique);
}

function categoryTotalsByMonth(purchases: readonly PurchaseCategoryRow[]): readonly SpendingCategoryMonthTotal[] {
  const values = new Map<string, { month: string; currency: string; categoryCode: string | null; amount: { coefficient: bigint; scale: number }; count: number }>();
  for (const purchase of purchases) {
    if (!purchase.amount) continue;
    const month = purchase.occurrence.slice(0, 7);
    const parts = purchase.category.mode === "split"
      ? purchase.category.components.map((component) => ({ categoryCode: component.categoryCode as string | null, amount: component.amount }))
      : [{ categoryCode: purchase.category.mode === "single" ? purchase.category.categoryCode : null, amount: purchase.amount }];
    for (const part of parts) {
      const currency = part.amount.currency.toUpperCase();
      const key = `${month}|${currency}|${part.categoryCode ?? ""}`;
      const previous = values.get(key);
      const amount = { coefficient: BigInt(part.amount.coefficient), scale: part.amount.scale };
      values.set(key, {
        month, currency, categoryCode: part.categoryCode,
        amount: previous ? addDecimal(previous.amount, amount) : amount,
        count: (previous?.count ?? 0) + 1,
      });
    }
  }
  return Object.freeze([...values.values()]
    .sort((left, right) => left.month.localeCompare(right.month) || left.currency.localeCompare(right.currency) || (left.categoryCode ?? "").localeCompare(right.categoryCode ?? ""))
    .map((value) => Object.freeze({
      month: value.month,
      currency: value.currency,
      categoryCode: value.categoryCode,
      ...reducedDecimal(value.amount),
      count: value.count,
    })));
}

/** Read one version-bound, keyset-paged slice of current Spending records. */
export async function queryCurrentSpendingRecordPage(
  reader: PGliteSpendingReader,
  request: SpendingRecordPageRequest,
): Promise<SpendingRecordPageDto> {
  const current = await latest(reader);
  if (!Number.isSafeInteger(request.knowledgeAt) || request.knowledgeAt !== current)
    throw new SpendingPageVersionError("record", current);
  const month = request.month ?? null;
  const day = request.day ?? null;
  if (month !== null && !validSpendingMonth(month)) throw new TypeError("Spending record page month is invalid.");
  if (day !== null && (!validSpendingDate(day) || month !== day.slice(0, 7)))
    throw new TypeError("Spending record page day must belong to its month.");
  const categoryCodes = normalizedCategoryCodes(request.categoryCodes);
  const cursor = spendingRecordCursorFromToken(request.cursor, { knowledgeAt: current, month, day, categoryCodes });
  const limit = Number.isSafeInteger(request.limit) && (request.limit ?? 0) > 0
    ? Math.min(request.limit ?? 50, 100)
    : 50;
  const monthFilter = month === null ? "" : "AND SUBSTRING(purchase_rows.occurrence_value, 1, 7) = ?";
  const dayFilter = day === null ? "" : "AND SUBSTRING(purchase_rows.occurrence_value, 1, 10) = ?";
  const cursorFilter = cursor === null
    ? ""
    : "AND (purchase_rows.occurrence_value < ? OR (purchase_rows.occurrence_value = ? AND purchase_rows.purchase_id > ?))";
  let matchingPurchaseIds: readonly string[] | null = null;
  if (categoryCodes !== null) {
    const selectors = new Set(categoryCodes);
    matchingPurchaseIds = (await queryPurchaseCategoryRows(reader, current, { month, day }))
      .filter((purchase) => purchaseCategoryMatchesSelectors(purchase.category, selectors))
      .map((purchase) => purchase.purchaseId);
    if (matchingPurchaseIds.length === 0) {
      return Object.freeze({ schemaVersion: 1, knowledgeAt: current, month, day, categoryCodes, records: Object.freeze([]), nextCursor: null });
    }
  }
  const categoryFilter = matchingPurchaseIds === null
    ? ""
    : `AND purchase_rows.purchase_id IN (${matchingPurchaseIds.map(() => "?").join(",")})`;
  const params: unknown[] = [current, current];
  if (month !== null) params.push(month);
  if (day !== null) params.push(day);
  if (cursor !== null) params.push(cursor.occurrence, cursor.occurrence, cursor.purchaseId);
  if (matchingPurchaseIds !== null) params.push(...matchingPurchaseIds);
  params.push(limit + 1);
  const result = await pgliteQuery<Row>(reader, `${PURCHASE_ROWS_CTE}, selected_rows AS (
      SELECT purchase_rows.*
        FROM purchase_rows
       WHERE TRUE ${monthFilter} ${dayFilter} ${cursorFilter} ${categoryFilter}
       ORDER BY purchase_rows.occurrence_value DESC, purchase_rows.purchase_id ASC
       LIMIT ?
    )
    SELECT basis, occurrence_value, invoice_id, transaction_id, event_id, refund_id, purchase_id
      FROM selected_rows
     ORDER BY occurrence_value DESC, purchase_id ASC
  `, params);
  const selected = rows(result);
  const hasNext = selected.length > limit;
  const visibleRows = selected.slice(0, limit);
  const invoiceIds = [...new Set(visibleRows.flatMap((row) => row.invoice_id ? [idString(row.invoice_id, "Spending page invoice")] : []))];
  const transactionIds = [...new Set(visibleRows.flatMap((row) => row.transaction_id ? [idString(row.transaction_id, "Spending page transaction")] : []))];
  const [invoiceViews, spending, recognition, itemCategorizations, paymentSources] = await Promise.all([
    invoices(reader, current, false, undefined, invoiceIds),
    querySpendingReport(reader, "current", current, null, { transactionIds }),
    querySpendingRecognition(reader, { knowledgeAt: current, invoiceIds, transactionIds }),
    itemCategorizationRows(reader, invoiceIds),
    queryPaymentSourceFacts(reader, transactionIds),
  ]);
  const composed = composePurchaseReport({
    request: { kind: "current" },
    knowledgeAt: current,
    invoices: invoiceViews,
    transactions: spending.includedTransactions,
    recognition,
    itemCategorizations,
    paymentSources,
  });
  const recordById = new Map(composed.records.map((record) => [record.purchaseId, record]));
  const pageRecords = visibleRows.flatMap((row) => {
    const purchaseId = stringValue(row.purchase_id, "Spending purchase identity");
    const record = recordById.get(purchaseId);
    return record ? [record] : [];
  });
  const last = visibleRows.at(-1);
  const page: SpendingRecordPageDto = Object.freeze({
    schemaVersion: 1,
    knowledgeAt: current,
    month,
    day,
    categoryCodes,
    records: Object.freeze(pageRecords),
    nextCursor: hasNext && last ? spendingRecordCursorToken({
      schemaVersion: 1,
      knowledgeAt: current,
      month,
      day,
      categoryCodes,
      occurrence: stringValue(last.occurrence_value, "Spending page occurrence"),
      purchaseId: stringValue(last.purchase_id, "Spending page purchase identity"),
    }) : null,
  });
  return page;
}

/** Hydrate only the rows touched by one compact action, without walking the
 * selected month keyset. The caller pins this read to the post-write version.
 */
export async function queryCurrentSpendingActionRecords(
  reader: PGliteSpendingReader,
  request: Readonly<{
    knowledgeAt: number;
    invoiceIdentityId: string;
    transactionIdentityId: string;
  }>,
): Promise<readonly PurchaseReport["records"][number][]> {
  const current = await latest(reader);
  if (!Number.isSafeInteger(request.knowledgeAt) || request.knowledgeAt !== current)
    throw new Error("Spending action records data version is stale; reload Spending.");
  const [invoiceViews, spending, recognition, itemCategorizations, paymentSources] = await Promise.all([
    invoices(reader, current, false, undefined, [request.invoiceIdentityId]),
    querySpendingReport(reader, "current", current, null, {
      transactionIds: [request.transactionIdentityId],
    }),
    querySpendingRecognition(reader, {
      knowledgeAt: current,
      invoiceIds: [request.invoiceIdentityId],
      transactionIds: [request.transactionIdentityId],
    }),
    itemCategorizationRows(reader, [request.invoiceIdentityId]),
    queryPaymentSourceFacts(reader, [request.transactionIdentityId]),
  ]);
  const composed = composePurchaseReport({
    request: { kind: "current" },
    knowledgeAt: current,
    invoices: invoiceViews,
    transactions: spending.includedTransactions,
    recognition,
    itemCategorizations,
    paymentSources,
  });
  return Object.freeze(composed.records.filter((record) =>
    record.invoice?.invoiceId === request.invoiceIdentityId ||
    record.transaction?.transactionId === request.transactionIdentityId));
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
): Promise<PGlitePendingSpendingCandidates> {
  const [deterministic, linkRows, decisionRows, durableRows] = await Promise.all([
    queryDeterministicCandidatePairs(reader),
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

function pendingPairInMonth(pair: PendingSpendingCandidate, month: string): boolean {
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
  const [invoiceViews, spending, recognition, itemCategorizations, paymentSources] = await Promise.all([
    invoices(reader, current, false, undefined, invoiceIds),
    querySpendingReport(reader, "current", current, null, { transactionIds }),
    querySpendingRecognition(reader, { knowledgeAt: current, invoiceIds, transactionIds }),
    itemCategorizationRows(reader, invoiceIds),
    queryPaymentSourceFacts(reader, transactionIds),
  ]);
  const report = composePurchaseReport({
    request: { kind: "current" },
    knowledgeAt: current,
    invoices: invoiceViews,
    transactions: spending.includedTransactions,
    itemCategorizations,
    paymentSources,
    recognition: Object.freeze({
      knowledgeAt: current,
      candidates: Object.freeze([]),
      activeLinks: Object.freeze([]),
      denied: Object.freeze([]),
      refunds: recognition.refunds,
    }),
  });
  const invoicesById = new Map(invoiceViews.map((invoice) => [invoice.invoiceId, invoice]));
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
  const items = candidatePage.flatMap((item) => {
    const invoice = invoicesById.get(item.invoiceId);
    if (!invoice) return [];
    const invoiceRecord = withCandidateIds(
      recordById.get(`invoice:${item.invoiceId}`),
      invoiceCandidateIds.get(item.invoiceId),
    );
    if (!invoiceRecord) throw new Error("Spending candidate invoice is not visible at this data version.");
    const paymentRecord = withCandidateIds(
      recordById.get(`transaction:${item.transactionId}`),
      transactionCandidateIds.get(item.transactionId),
    );
    return [{
      candidate: Object.freeze({ ...item.candidate, strength: item.strength, reasons: item.reasons }),
      invoiceRecord,
      paymentRecord,
    }];
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

/** The global pending count, strong set, and the invoice amounts at stake. */
export async function queryCurrentSpendingPendingOverview(
  reader: PGliteSpendingReader,
  request: SpendingPendingOverviewRequest,
  cachedPending?: PGlitePendingSpendingCandidates,
): Promise<SpendingPendingOverviewDto> {
  const current = await latest(reader);
  if (!Number.isSafeInteger(request.knowledgeAt) || request.knowledgeAt !== current)
    throw new SpendingPageVersionError("pending-overview", current);
  const pending = cachedPending?.knowledgeAt === current ? cachedPending : await queryPendingSpendingCandidates(reader, current);
  const affected = new Map<string, { amount: { coefficient: bigint; scale: number }; count: number }>();
  const countedInvoices = new Set<string>();
  for (const pair of pending.pairs) {
    if (countedInvoices.has(pair.invoiceId)) continue;
    countedInvoices.add(pair.invoiceId);
    addTotal(affected, pair.amount);
  }
  const strong = pending.pairs.filter((pair) => pair.strength === "strong");
  return Object.freeze({
    schemaVersion: 1,
    knowledgeAt: current,
    pendingCount: pending.pairs.length,
    strongCount: strong.length,
    affectedByCurrency: Object.freeze(totals(affected).map((total) => Object.freeze(total))),
    strongPairs: Object.freeze(strong.map(pendingPairRef)),
  });
}

/**
 * Build the current Spending summary from compact indexed facts. The legacy
 * full report remains available through queryCurrentSpending; this query only
 * returns grouped totals/counts and never materializes transaction or invoice
 * view objects on the worker or renderer.
 */
export async function queryCurrentSpendingSummary(
  reader: PGliteSpendingReader,
  request: Readonly<{ knowledgeAt?: number }> = {},
): Promise<SpendingSummaryDto> {
  const current = await latest(reader);
  const knowledgeAt = request.knowledgeAt ?? current;
  if (!Number.isSafeInteger(knowledgeAt) || knowledgeAt < 0 || knowledgeAt !== current)
    throw new Error("Spending summary data version is stale; reload Spending.");

  const result = await pgliteQuery<Row>(reader, `${PURCHASE_ROWS_CTE}, scaled_amounts AS MATERIALIZED (
      SELECT SUBSTRING(occurrence_value, 1, 7) AS month,
             SUBSTRING(occurrence_value, 1, 10) AS date, currency,
             amount_coefficient::numeric * POWER(
               10::numeric, MAX(amount_scale) OVER () - amount_scale
             ) AS coefficient,
             MAX(amount_scale) OVER () AS scale
        FROM purchase_rows
       WHERE amount_coefficient IS NOT NULL
    ), amount_groups AS (
      SELECT GROUPING(month) AS all_months, GROUPING(date) AS all_days,
             month, date, currency, SUM(coefficient)::text AS coefficient,
             MAX(scale) AS scale, COUNT(*) AS count
        FROM scaled_amounts
       GROUP BY GROUPING SETS ((currency), (month, currency), (month, date, currency))
    ), record_groups AS (
      SELECT GROUPING(month) AS all_months, GROUPING(date) AS all_days,
             month, date, COUNT(*) AS record_count, COUNT(DISTINCT date) AS active_day_count
        FROM (
          SELECT SUBSTRING(occurrence_value, 1, 7) AS month,
                 SUBSTRING(occurrence_value, 1, 10) AS date
            FROM purchase_rows
        ) records
       GROUP BY GROUPING SETS ((), (month), (month, date))
    )
    SELECT
      (SELECT record_count FROM record_groups WHERE all_months = 1) AS record_count,
      NULL::bigint AS candidate_count,
      NULL::bigint AS pending_candidate_count,
      COALESCE((SELECT json_agg(json_build_object(
        'currency', currency, 'coefficient', coefficient, 'scale', scale, 'count', count
      ) ORDER BY currency) FROM amount_groups WHERE all_months = 1), '[]'::json) AS totals,
      COALESCE((SELECT json_agg(json_build_object(
        'month', stats.month, 'recordCount', stats.record_count, 'activeDayCount', stats.active_day_count,
        'pendingCandidateCount', NULL,
        'totalsByCurrency', COALESCE((
          SELECT json_agg(json_build_object(
            'currency', amounts.currency, 'coefficient', amounts.coefficient,
            'scale', amounts.scale, 'count', amounts.count
          ) ORDER BY amounts.currency)
            FROM amount_groups amounts
           WHERE amounts.all_months = 0 AND amounts.all_days = 1 AND amounts.month = stats.month
        ), '[]'::json)
      ) ORDER BY stats.month) FROM record_groups stats
         WHERE stats.all_months = 0 AND stats.all_days = 1), '[]'::json) AS months,
      COALESCE((SELECT json_agg(json_build_object(
        'month', stats.month, 'date', stats.date, 'recordCount', stats.record_count,
        'totalsByCurrency', COALESCE((
          SELECT json_agg(json_build_object(
            'currency', amounts.currency, 'coefficient', amounts.coefficient,
            'scale', amounts.scale, 'count', amounts.count
          ) ORDER BY amounts.currency)
            FROM amount_groups amounts
           WHERE amounts.all_months = 0 AND amounts.all_days = 0
             AND amounts.month = stats.month AND amounts.date = stats.date
        ), '[]'::json)
      ) ORDER BY stats.month, stats.date) FROM record_groups stats
         WHERE stats.all_months = 0 AND stats.all_days = 0), '[]'::json) AS days
  `, [knowledgeAt, knowledgeAt]);

  const row = rows(result)[0];
  if (!row) throw new Error("Spending summary query returned no row.");
  const categoryTotals = categoryTotalsByMonth(await queryPurchaseCategoryRows(reader, knowledgeAt));
  const totalsByCurrency = summaryMoneyRows(row.totals, "Spending totals");
  const monthTotals = jsonRows(row.months, "Spending month totals").map((month) => Object.freeze({
    month: stringValue(month.month, "Spending month"),
    recordCount: numeric(month.recordCount, "Spending month record count"),
    activeDayCount: numeric(month.activeDayCount, "Spending active day count"),
    pendingCandidateCount: month.pendingCandidateCount === null
      ? null
      : numeric(month.pendingCandidateCount, "Spending month candidate count"),
    totalsByCurrency: summaryMoneyRows(month.totalsByCurrency, "Spending month totals"),
  }));
  const dayTotals = jsonRows(row.days, "Spending day totals").map((day) => Object.freeze({
    month: stringValue(day.month, "Spending day month"),
    date: stringValue(day.date, "Spending day"),
    recordCount: numeric(day.recordCount, "Spending day record count"),
    totalsByCurrency: summaryMoneyRows(day.totalsByCurrency, "Spending day totals"),
  }));
  const purchaseReport: SpendingPurchaseReportSummaryDto = Object.freeze({
    recordCount: numeric(row.record_count, "Spending record count"),
    candidateCount: row.candidate_count === null ? null : numeric(row.candidate_count, "Spending candidate count"),
    pendingCandidateCount: row.pending_candidate_count === null ? null : numeric(row.pending_candidate_count, "Spending pending candidate count"),
    candidateState: "unloaded",
    currencies: Object.freeze(totalsByCurrency.map((amount) => amount.currency)),
    totalsByCurrency,
    monthTotals: Object.freeze(monthTotals),
    dayTotals: Object.freeze(dayTotals),
    categoryTotalsByMonth: categoryTotals,
  });
  return Object.freeze({
    schemaVersion: 1,
    knowledgeAt,
    availability: purchaseReport.recordCount > 0 ? "available" : "empty",
    inclusionPolicy: CANONICAL_SPENDING_INCLUSION_POLICY,
    purchaseReport: Object.freeze({
      ...purchaseReport,
      kind: "current",
      financialAt: null,
      status: "ok",
      totalStatus: "complete",
    }),
  });
}

export async function queryHistoricalSpending(
  reader: PGliteSpendingReader,
  request: Readonly<{ financialAt: string; knowledgeAt: number }>,
): Promise<HistoricalSpendingQueryResult> {
  if (!ISO_DATE.test(request.financialAt)) throw new Error("Historical Spending financialAt is invalid.");
  const current = await latest(reader);
  if (!Number.isSafeInteger(request.knowledgeAt) || request.knowledgeAt < 0 || request.knowledgeAt > current) throw new Error("Historical Spending knowledgeAt is invalid.");
  const [spending, invoiceViews, recognition] = await Promise.all([
    querySpendingReport(reader, "historical", request.knowledgeAt, request.financialAt),
    invoices(reader, request.knowledgeAt, true),
    querySpendingRecognition(reader, { knowledgeAt: request.knowledgeAt }),
  ]);
  const purchaseReport = composePurchaseReport({
    request: { kind: "historical", financialAt: request.financialAt },
    knowledgeAt: request.knowledgeAt,
    invoices: invoiceViews,
    transactions: spending.includedTransactions,
    recognition,
  });
  return {
    status: "ok",
    kind: "historical",
    product: "spending",
    cutoff: { kind: "both", financialAt: request.financialAt, knowledgeAt: String(request.knowledgeAt) },
    projection: purchaseReport,
  };
}

function invoiceOccurrenceUnixSeconds(invoice: CanonicalEInvoiceView): number {
  const occurrence = invoice.revision.occurrence;
  const suffix = occurrence.precision === "date" ? "T00:00:00" : occurrence.precision === "minute" ? ":00" : "";
  const parsed = Date.parse(`${occurrence.value}${suffix}+08:00`);
  if (!Number.isFinite(parsed)) throw new Error(`Canonical E-Invoice ${invoice.revision.invoiceNumber} has an invalid occurrence.`);
  return Math.floor(parsed / 1000);
}

function spendingInvoiceDto(invoice: CanonicalEInvoiceView): SpendingInvoiceDto {
  const total = invoice.revision.total;
  if (invoice.revision.state === "revoked" || total === null) throw new Error("A revoked or incomplete invoice cannot be projected to Spending.");
  return {
    invoiceKey: invoice.stableInvoiceKey,
    invoiceId: invoice.revision.invoiceNumber,
    issuedAt: invoiceOccurrenceUnixSeconds(invoice),
    amount: Number(total.coefficient) / 10 ** total.scale,
    sellerBusinessAccountNumber: invoice.revision.seller.taxId,
    sellerName: invoice.revision.seller.name,
    sellerAddr: null,
    items: invoice.revision.items.map((item) => ({
      itemKey: item.itemId,
      sequence: item.sequence,
      quantity: item.quantity === null ? null : Number(item.quantity.coefficient) / 10 ** item.quantity.scale,
      unitPrice: item.unitPrice === null ? null : Number(item.unitPrice.coefficient) / 10 ** item.unitPrice.scale,
      paidAmount: item.amount === null ? null : Number(item.amount.coefficient) / 10 ** item.amount.scale,
      productName: item.name,
      category: "other" as const,
      completeness: item.completeness,
    })),
    revisionKind: invoice.revision.revisionKind === "revised" ? "revised" : "issued",
  };
}

function spendingPageFromCurrent(
  result: CurrentSpendingQueryResult,
  request: Readonly<{ selectedMonth?: string; selectedCategory?: string }> = {},
): SpendingPageDto {
  const spending = result.spending;
  const records = spending.transactions.map((transaction) => ({
    transactionId: transaction.transactionId,
    accountId: transaction.accountId,
    accountNumber: transaction.accountNumber,
    sourceConnectionKey: transaction.sourceConnectionKey,
    integrationNamespace: transaction.integrationNamespace,
    stream: transaction.stream,
    date: transaction.effectiveOn,
    dateBasis: (transaction.effectiveDateBasis ?? "effective-date") as "consume-date" | "posting-date-fallback" | "effective-date",
    consumeDate: transaction.consumeDate ?? null,
    postingDate: transaction.postingDate ?? null,
    description: transaction.description,
    amount: { currency: transaction.amount.currency, value: Number(transaction.amount.coefficient) / 10 ** transaction.amount.scale, exact: { coefficient: transaction.amount.coefficient, scale: transaction.amount.scale } },
    kind: transaction.kind,
    category: { mode: transaction.categorization.mode, code: transaction.categorization.mode === "single" ? transaction.categorization.categoryCode ?? null : null, taxonomyId: transaction.categorization.taxonomyId ?? null, taxonomyVersion: transaction.categorization.taxonomyVersion ?? null, labels: null, components: transaction.categorization.components?.map((component) => ({ code: component.categoryCode, taxonomyId: component.taxonomyId, taxonomyVersion: component.taxonomyVersion, labels: null, amount: { currency: component.currency, value: Number(component.coefficient) / 10 ** component.scale, exact: { coefficient: component.coefficient, scale: component.scale } } })) ?? [] },
    display: { label: transaction.display.value, status: transaction.display.status, origin: transaction.display.origin, kind: transaction.display.displayKind },
    tags: transaction.tags.map((tag) => ({ id: tag.tagId, label: tag.label })),
    inclusion: transaction.inclusion,
    eligibilityGap: transaction.eligibilityGap ?? null,
  }));
  const canonical = {
    availability: spending.transactions.length > 0 ? "available" as const : spending.reportEligibility.status === "incomplete" ? "unavailable" as const : "empty" as const,
    policy: { id: spending.inclusionPolicy.id, version: spending.inclusionPolicy.version, name: spending.inclusionPolicy.name },
    knowledgePoint: spending.knowledgePoint,
    selectedMonth: request.selectedMonth ?? null,
    selectedCategory: request.selectedCategory ?? null,
    transactions: records,
    includedTransactions: records.filter((record) => record.inclusion === "included"),
    totalsByCurrency: spending.totalsByCurrency.map((value) => ({ currency: value.currency, value: Number(value.coefficient) / 10 ** value.scale, exact: { coefficient: value.coefficient, scale: value.scale } })),
    categoryTotalsByCurrency: spending.categoryTotalsByCurrency.map((value) => ({ ...value, labels: null, amount: { currency: value.currency, value: Number(value.coefficient) / 10 ** value.scale, exact: { coefficient: value.coefficient, scale: value.scale } } })),
    unclassifiedByCurrency: spending.unclassifiedByCurrency.map((value) => ({ currency: value.currency, value: Number(value.coefficient) / 10 ** value.scale, exact: { coefficient: value.coefficient, scale: value.scale } })),
    classificationCoverage: {
      includedCount: spending.classificationCoverage.includedCount,
      classifiedCount: spending.classificationCoverage.classifiedCount,
      unclassifiedCount: spending.classificationCoverage.unclassifiedCount,
      includedAmountByCurrency: spending.classificationCoverage.includedAmountByCurrency.map((value) => ({ currency: value.currency, value: Number(value.coefficient) / 10 ** value.scale, exact: { coefficient: value.coefficient, scale: value.scale } })),
      classifiedAmountByCurrency: spending.classificationCoverage.classifiedAmountByCurrency.map((value) => ({ currency: value.currency, value: Number(value.coefficient) / 10 ** value.scale, exact: { coefficient: value.coefficient, scale: value.scale } })),
      unclassifiedAmountByCurrency: spending.classificationCoverage.unclassifiedAmountByCurrency.map((value) => ({ currency: value.currency, value: Number(value.coefficient) / 10 ** value.scale, exact: { coefficient: value.coefficient, scale: value.scale } })),
    },
    reportEligibility: { status: spending.reportEligibility.status, gapCount: spending.reportEligibility.gapCount, gapAmountByCurrency: spending.reportEligibility.gapAmountByCurrency.map((value) => ({ currency: value.currency, value: Number(value.coefficient) / 10 ** value.scale, exact: { coefficient: value.coefficient, scale: value.scale } })) },
    totalStatus: spending.totalStatus,
  };
  return {
    canonical,
    purchaseReport: result.purchaseReport,
    invoices: result.invoices
      .filter((invoice) => invoice.revision.state !== "revoked" && invoice.revision.total !== null)
      .map(spendingInvoiceDto),
  };
}

/** Query the page payload without opening SQLite or exposing SQL to callers. */
export async function querySpendingPage(
  reader: PGliteSpendingReader,
  request: Readonly<{ selectedMonth?: string; selectedCategory?: string }> = {},
): Promise<SpendingPageDto> {
  return spendingPageFromCurrent(await queryCurrentSpending(reader), request);
}

function spendingPageFromSummary(
  summary: SpendingSummaryDto,
  request: Readonly<{ selectedMonth?: string; selectedCategory?: string }> = {},
): SpendingPageDto {
  const money = summary.purchaseReport.totalsByCurrency.map((amount) => ({
    currency: amount.currency,
    value: Number(amount.coefficient) / 10 ** amount.scale,
    exact: { coefficient: amount.coefficient, scale: amount.scale },
  }));
  const purchaseReport: SpendingPurchaseReportDto = Object.freeze({
    status: "ok",
    kind: "current",
    knowledgeAt: summary.knowledgeAt,
    financialAt: null,
    records: Object.freeze([]),
    totalsByCurrency: summary.purchaseReport.totalsByCurrency,
    totalStatus: summary.purchaseReport.totalStatus,
    candidates: Object.freeze([]),
    summary: summary.purchaseReport,
  });
  return Object.freeze({
    canonical: Object.freeze({
      availability: summary.availability,
      policy: summary.inclusionPolicy,
      knowledgePoint: summary.knowledgeAt,
      selectedMonth: request.selectedMonth ?? null,
      selectedCategory: request.selectedCategory ?? null,
      transactions: Object.freeze([]),
      includedTransactions: Object.freeze([]),
      totalsByCurrency: money,
      categoryTotalsByCurrency: Object.freeze([]),
      unclassifiedByCurrency: Object.freeze([]),
      classificationCoverage: Object.freeze({
        includedCount: 0,
        classifiedCount: 0,
        unclassifiedCount: 0,
        includedAmountByCurrency: Object.freeze([]),
        classifiedAmountByCurrency: Object.freeze([]),
        unclassifiedAmountByCurrency: Object.freeze([]),
      }),
      reportEligibility: Object.freeze({ status: "complete", gapCount: 0, gapAmountByCurrency: Object.freeze([]) }),
      totalStatus: "complete",
    }),
    purchaseReport,
    invoices: Object.freeze([]),
  });
}

export async function queryCurrentSpendingSummaryPage(
  reader: PGliteSpendingReader,
  request: Readonly<{ selectedMonth?: string; selectedCategory?: string }> = {},
): Promise<SpendingPageDto> {
  return spendingPageFromSummary(await queryCurrentSpendingSummary(reader), request);
}

export async function rankPGliteSpendingPaymentCandidates(
  reader: PGliteSpendingReader,
  input: SpendingPairingCandidatesInput,
): Promise<SpendingPairingCandidatesResult> {
  const knowledgeAt = await latest(reader);
  if (knowledgeAt !== input.dataVersion) throw new Error("Spending pairing data version is stale; reload Spending before pairing.");
  const invoice = (await invoices(reader, knowledgeAt, false, input.invoiceIdentityId))[0];
  if (!invoice || invoice.revision.state === "revoked") throw new Error("Spending invoice selection is stale, revoked, or missing.");
  const offset = Number.isSafeInteger(input.offset) && (input.offset ?? 0) >= 0 ? input.offset ?? 0 : 0;
  const limit = Number.isSafeInteger(input.limit) && (input.limit ?? 0) > 0 ? Math.min(input.limit ?? 50, 100) : 50;
  const transactions = await queryPairingTransactionsDirect(reader);
  const ranked = rankSpendingManualPaymentCandidates(
    matchingInvoice(invoice),
    createSpendingManualPairingIndex(knowledgeAt, transactions),
  );
  const byId = new Map(transactions.map((transaction) => [transaction.transactionId, transaction]));
  const pageRank = ranked.slice(offset, offset + limit);
  const selectedRank = input.selectedTransactionId
    ? ranked.find((candidate) => candidate.transactionId === input.selectedTransactionId)
    : undefined;
  const streams = await pairingPresentationStreams(reader, [...new Set([
    ...pageRank.map((candidate) => candidate.transactionId),
    ...(selectedRank ? [selectedRank.transactionId] : []),
  ])]);
  const candidateView = (candidate: typeof ranked[number]) => {
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
    totalCandidateCount: ranked.length,
    nextOffset: offset + candidates.length < ranked.length ? offset + candidates.length : null,
  };
}

function rankSpendingPaymentCandidatesFromSnapshot(
  snapshot: PGliteSpendingSnapshot,
  input: SpendingPairingCandidatesInput,
): SpendingPairingCandidatesResult {
  const invoice = snapshot.invoices.find((candidate) => candidate.invoiceId === input.invoiceIdentityId);
  if (!invoice || invoice.revision.state === "revoked") throw new Error("Spending invoice selection is stale, revoked, or missing.");
  let pairing = pairingSnapshotCache.get(snapshot);
  if (!pairing) {
    const linkedTransactions = new Set(
      snapshot.purchaseReport.records
        .filter((record) => record.basis === "linked" && record.transaction)
        .map((record) => record.transaction!.transactionId),
    );
    const transactions = Object.freeze(snapshot.spending.includedTransactions.filter((transaction) => !linkedTransactions.has(transaction.transactionId)));
    pairing = Object.freeze({
      transactions,
      byId: new Map(transactions.map((transaction) => [transaction.transactionId, transaction])),
      index: createSpendingManualPairingIndex(snapshot.purchaseReport.knowledgeAt, transactions.map(matchingTransaction)),
    });
    pairingSnapshotCache.set(snapshot, pairing);
  }
  const ranked = rankSpendingManualPaymentCandidates(matchingInvoice(invoice), pairing.index);
  const offset = Number.isSafeInteger(input.offset) && (input.offset ?? 0) >= 0 ? input.offset ?? 0 : 0;
  const limit = Number.isSafeInteger(input.limit) && (input.limit ?? 0) > 0 ? Math.min(input.limit ?? 50, 100) : 50;
  const candidateView = (candidate: typeof ranked[number]) => {
    const transaction = pairing!.byId.get(candidate.transactionId);
    if (!transaction) throw new Error("Spending pairing candidate is missing from the current index.");
    return createSpendingPairingCandidateViewFromTransaction({
      ...matchingTransaction(transaction),
      stream: transaction.stream,
      effectiveDateBasis: transaction.effectiveDateBasis ?? null,
    });
  };
  const candidates = ranked.slice(offset, offset + limit).map(candidateView);
  const selectedRank = input.selectedTransactionId
    ? ranked.find((candidate) => candidate.transactionId === input.selectedTransactionId)
    : undefined;
  return {
    dataVersion: input.dataVersion,
    candidates,
    ...(input.selectedTransactionId !== undefined ? { selectedCandidate: selectedRank ? candidateView(selectedRank) : null } : {}),
    totalCandidateCount: ranked.length,
    nextOffset: offset + candidates.length < ranked.length ? offset + candidates.length : null,
  };
}

/**
 * Counted non-refund purchases of one month with their merchant facts. The
 * month is given directly or as the month of one purchase.
 */
async function queryMonthPurchaseFacts(
  reader: PGliteSpendingReader,
  knowledgeAt: number,
  scope: Readonly<{ month: string } | { purchaseId: string }>,
): Promise<readonly MonthPurchaseFact[]> {
  const monthFilter = "month" in scope
    ? "SUBSTRING(purchase_rows.occurrence_value, 1, 7) = ?"
    : `SUBSTRING(purchase_rows.occurrence_value, 1, 7) = (
         SELECT SUBSTRING(target.occurrence_value, 1, 7) FROM purchase_rows target WHERE target.purchase_id = ?)`;
  const result = rows(await pgliteQuery<Row>(reader, `${PURCHASE_ROWS_CTE}
    SELECT purchase_rows.basis, purchase_rows.purchase_id, purchase_rows.occurrence_value,
           purchase_rows.amount_coefficient, purchase_rows.amount_scale, purchase_rows.currency,
           invoice_revision.seller_tax_id, invoice_revision.seller_name,
           transaction_revision.description
      FROM purchase_rows
      LEFT JOIN einvoice_invoice_revisions invoice_revision ON invoice_revision.revision_id = purchase_rows.invoice_revision_id
      LEFT JOIN current_transactions current_row ON current_row.transaction_id = purchase_rows.transaction_id
      LEFT JOIN transaction_revisions transaction_revision ON transaction_revision.revision_id = current_row.revision_id
     WHERE purchase_rows.basis <> 'refund' AND ${monthFilter}`,
    [knowledgeAt, knowledgeAt, "month" in scope ? scope.month : scope.purchaseId],
  ));
  return result.map((row) => Object.freeze({
    purchaseId: stringValue(row.purchase_id, "Month purchase identity"),
    basis: stringValue(row.basis, "Month purchase basis") as MonthPurchaseFact["basis"],
    occurrence: stringValue(row.occurrence_value, "Month purchase occurrence"),
    amount: optionalMoney(row, "amount_coefficient", "amount_scale", "currency"),
    sellerTaxId: nullableString(row.seller_tax_id),
    sellerName: nullableString(row.seller_name),
    bankDescription: nullableString(row.description),
  }));
}

/** 最高消費: the month's largest single purchase per currency. */
export async function queryCurrentSpendingMonthInsight(
  reader: PGliteSpendingReader,
  request: SpendingMonthInsightRequest,
): Promise<SpendingMonthInsightDto> {
  const current = await latest(reader);
  if (!Number.isSafeInteger(request.knowledgeAt) || request.knowledgeAt !== current)
    throw new SpendingPageVersionError("month-insight", current);
  if (!validSpendingMonth(request.month)) throw new TypeError("Spending month insight month is invalid.");
  const facts = await queryMonthPurchaseFacts(reader, current, { month: request.month });
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
): Promise<SpendingMerchantStatsDto> {
  const current = await latest(reader);
  if (!Number.isSafeInteger(request.knowledgeAt) || request.knowledgeAt !== current)
    throw new SpendingPageVersionError("merchant-stats", current);
  if (typeof request.purchaseId !== "string" || request.purchaseId.trim() === "")
    throw new TypeError("Spending merchant stats purchase id is required.");
  const purchaseId = request.purchaseId.trim();
  const facts = await queryMonthPurchaseFacts(reader, current, { purchaseId });
  const target = facts.find((fact) => fact.purchaseId === purchaseId);
  if (!target) throw new Error("Spending merchant stats purchase is not a current purchase.");
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

function optionalMoney(row: Row, coefficient: string, scale: string, currency: string): Money | null {
  return row[coefficient] === null || row[coefficient] === undefined ? null : exactMoney(row, coefficient, scale, currency);
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
            payment_scope.integration_namespace AS payment_institution
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
       LEFT JOIN source_connections payment_scope ON payment_scope.source_connection_id = payment_account.source_connection_id
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
      pendingCache = await queryPendingSpendingCandidates(transaction, knowledgeAt);
    return pendingCache;
  };
  return Object.freeze({
    // A facade call owns one repeatable-read transaction for every complete
    // report. Callers that already own a transaction may use the lower-level
    // query functions above directly with its PGliteTransaction capability.
    current: async (request?: Parameters<typeof queryCurrentSpending>[1]) => {
      const result = await store.transaction((transaction) => queryCurrentSpending(transaction, request));
      cachePGliteSpendingSnapshot(store, result);
      return result;
    },
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
      store.transaction((transaction) => queryCurrentSpendingMonthInsight(transaction, request)),
    merchantStats: (request: SpendingMerchantStatsRequest) =>
      store.transaction((transaction) => queryCurrentSpendingMerchantStats(transaction, request)),
    mergeLog: (request: SpendingMergeLogRequest) =>
      store.transaction((transaction) => queryCurrentSpendingMergeLog(transaction, request)),
    pendingOverview: async (request: SpendingPendingOverviewRequest) => store.transaction(async (transaction) => {
      const knowledgeAt = await latest(transaction);
      if (knowledgeAt !== request.knowledgeAt)
        throw new SpendingPageVersionError("pending-overview", knowledgeAt);
      return queryCurrentSpendingPendingOverview(transaction, request, await pendingAt(transaction, knowledgeAt));
    }),
    historical: (request: Readonly<{ financialAt: string; knowledgeAt: number }>) => store.transaction((transaction) => queryHistoricalSpending(transaction, request)),
    page: async (request?: Parameters<typeof querySpendingPage>[1]) => {
      let result: CurrentSpendingQueryResult | null = null;
      const page = await store.transaction(async (transaction) => {
        const current = await queryCurrentSpending(transaction);
        result = current;
        return spendingPageFromCurrent(current, request);
      });
      if (result) cachePGliteSpendingSnapshot(store, result);
      return page;
    },
    recognition: (request?: Readonly<{ knowledgeAt?: number }>) => store.transaction((transaction) => querySpendingRecognition(transaction, request)),
    lineage: (request: PGliteSpendingLineageRequest) => store.transaction((transaction) => querySpendingLineage(transaction, request)),
    pairingCandidates: async (request: SpendingPairingCandidatesInput) => {
      const cached = cachedPGliteSpendingSnapshot(store);
      if (cached && cached.purchaseReport.knowledgeAt === request.dataVersion) {
        return store.transaction(async (transaction) => {
          const currentKnowledge = await latest(transaction);
          if (currentKnowledge === request.dataVersion) return rankSpendingPaymentCandidatesFromSnapshot(cached, request);
          return rankPGliteSpendingPaymentCandidates(transaction, request);
        });
      }
      return store.transaction((transaction) => rankPGliteSpendingPaymentCandidates(transaction, request));
    },
  });
}

export type PGliteSpendingQuery = ReturnType<typeof createPGliteSpendingQuery>;
