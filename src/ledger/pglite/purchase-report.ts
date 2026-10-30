import { SpendingPageVersionError } from "../../lib/spending/page-reader.ts";
import { COUNTED_ACCOUNT_SQL, readPGliteCoveredAccountIds } from "./direct-source-precedence.ts";
import type { PGliteTransaction } from "./transaction.ts";
import { CANONICAL_SPENDING_INCLUSION_POLICY } from "../canonical/spending-inclusion-policy.ts";
import {
  composePurchaseReport,
  withPossibleDuplicates,
  type PurchaseReport,
} from "../canonical/spending-purchase-report-core.ts";
import {
  addToTotals,
  normalizeCurrency,
  normalizeMoney,
  readTotals,
  type MoneyTotalsAccumulator,
} from "../../lib/shared-money/exact-money.ts";
import {
  purchaseCategoryCodes,
  readPurchaseCategory,
  type PurchaseCategory,
} from "../canonical/purchase-category.ts";
import type {
  CurrentSpendingQueryResult,
  HistoricalSpendingQueryResult,
} from "../../lib/shared-ledger/server/financial-query-contracts.ts";
import {
  SPENDING_UNCLASSIFIED_CATEGORY_SELECTOR,
  type SpendingCategoryMonthTotal,
  type SpendingPageActionResult,
  type SpendingPageDto,
  type SpendingPurchaseReportDto,
  type SpendingPurchaseReportSummaryDto,
  type SpendingRecordBasisFilter,
  type SpendingRecordPageDto,
  type SpendingRecordPageRequest,
  type SpendingSummaryDeltaLine,
  type SpendingSummaryDto,
} from "../../lib/spending/model.ts";
import type { MonthPurchaseFact } from "../canonical/spending-month-insights.ts";
import {
  categoryFromRows,
  invoices,
  itemCategorizationFromRow,
  itemCategorizationRows,
  queryPaymentSourceFacts,
  querySpendingRecognition,
  querySpendingReport,
  type CategorizationRow,
  type EnrichmentRow,
  type TransactionRow,
} from "./spending-facts.ts";
import {
  bytes,
  exactMoney,
  idString,
  ISO_DATE,
  latest,
  nullableString,
  numeric,
  optionalMoney,
  pgliteQuery,
  rows,
  stringValue,
  type Money,
  type PGliteSpendingReader,
  type Row,
} from "./spending-sql.ts";

/**
 * The Purchase report: the one interface for Purchase-basis spending
 * (ADR 0024, ADR 0076). It owns the purchase rows in two renditions that
 * apply the same rules: purchaseRowsCte in SQL, for the reads ADR 0028 budgets
 * (summary, record page keyset, month facts, category rows), and the record
 * builder (composePurchaseReport in spending-purchase-report-core.ts) that
 * turns canonical views into Purchase records. Every read below, and every
 * Pairing decision through decide(), goes through one of them.
 */

/** The identities one Pairing decision touches. */
export type PurchasePair = Readonly<{ invoiceIdentityId: string; transactionIdentityId: string }>;

type PurchaseRecord = PurchaseReport["records"][number];

/**
 * Transactions among `transactionIds` that Direct source precedence covers
 * at `knowledgeAt`. A covered transaction's refund does not count, the same
 * as active_refunds in purchaseRowsCte.
 */
async function coveredTransactionIds(
  reader: PGliteSpendingReader,
  knowledgeAt: number,
  transactionIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const unique = [...new Set(transactionIds)];
  if (unique.length === 0) return new Set();
  const coveredAccounts = await readPGliteCoveredAccountIds(reader, knowledgeAt);
  if (coveredAccounts.length === 0) return new Set();
  const covered = new Set<string>();
  for (let start = 0; start < unique.length; start += 2_048) {
    const chunk = unique.slice(start, start + 2_048);
    for (const row of rows(await pgliteQuery<Row>(reader,
      `SELECT transaction_id FROM financial_transactions
        WHERE transaction_id IN (${chunk.map(() => "?").join(",")})
          AND NOT (${COUNTED_ACCOUNT_SQL("account_id")})`,
      [...chunk.map((id) => bytes(id, "Refund transaction")), coveredAccounts],
    ))) covered.add(idString(row.transaction_id, "Refund transaction"));
  }
  return covered;
}

/**
 * Build the Purchase records of the given invoices and transactions at the
 * current version, with their item categorizations and payment sources.
 * `candidates: "none"` leaves recognized candidates out, for a caller that
 * attaches its own pending pairs.
 */
export async function purchaseRecordsByIdentity(
  reader: PGliteSpendingReader,
  knowledgeAt: number,
  identities: Readonly<{ invoiceIds: readonly string[]; transactionIds: readonly string[] }>,
  options: Readonly<{ candidates?: "recognized" | "none" }> = {},
): Promise<PurchaseReport> {
  const { invoiceIds, transactionIds } = identities;
  const [invoiceViews, spending, recognition, itemCategorizations, paymentSources] = await Promise.all([
    invoices(reader, knowledgeAt, false, undefined, invoiceIds),
    querySpendingReport(reader, "current", knowledgeAt, null, { transactionIds }),
    querySpendingRecognition(reader, { knowledgeAt, invoiceIds, transactionIds }),
    itemCategorizationRows(reader, invoiceIds),
    queryPaymentSourceFacts(reader, transactionIds),
  ]);
  return composePurchaseReport({
    request: { kind: "current" },
    knowledgeAt,
    invoices: invoiceViews,
    transactions: spending.includedTransactions,
    recognition: options.candidates === "none"
      ? Object.freeze({ ...recognition, candidates: Object.freeze([]) })
      : recognition,
    itemCategorizations,
    paymentSources,
    coveredTransactionIds: await coveredTransactionIds(reader, knowledgeAt, recognition.refunds.map((refund) => refund.transactionId)),
  });
}

/** The complete current Purchase report, with deterministic possible duplicates. */
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
  const [paymentSources, covered] = await Promise.all([
    queryPaymentSourceFacts(reader, spending.includedTransactions.map((transaction) => transaction.transactionId)),
    coveredTransactionIds(reader, knowledgeAt, recognition.refunds.map((refund) => refund.transactionId)),
  ]);
  const purchaseReport = withPossibleDuplicates(composePurchaseReport({
    request: { kind: "current" },
    knowledgeAt,
    invoices: invoiceViews,
    transactions: spending.includedTransactions,
    recognition,
    itemCategorizations,
    paymentSources,
    coveredTransactionIds: covered,
  }), invoiceViews, spending.includedTransactions);
  return { status: "ok", kind: "current", product: "spending", spending, invoices: invoiceViews, purchaseReport };
}

/**
 * The Purchase report at a financial date and knowledge point. Card and
 * statement facts are not versioned by knowledge point, so a historical
 * record's payment source names only its institution.
 */
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
    paymentSources: new Map(),
    coveredTransactionIds: await coveredTransactionIds(reader, request.knowledgeAt, recognition.refunds.map((refund) => refund.transactionId)),
  });
  return {
    status: "ok",
    kind: "historical",
    product: "spending",
    cutoff: { kind: "both", financialAt: request.financialAt, knowledgeAt: String(request.knowledgeAt) },
    projection: purchaseReport,
  };
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

/** Money rows the summary SQL grouped by upper-cased currency, at canonical scale. */
function summaryMoneyRows(value: unknown, label: string) {
  return Object.freeze(jsonRows(value, label).map((row) => {
    const coefficient = stringValue(row.coefficient, `${label} coefficient`);
    if (!/^-?\d+(?:\.0+)?$/u.test(coefficient))
      throw new Error(`${label} coefficient is not an integer.`);
    const money = normalizeMoney({
      currency: stringValue(row.currency, `${label} currency`),
      coefficient: coefficient.replace(/\.0+$/u, ""),
      scale: numeric(row.scale, `${label} scale`),
    });
    return Object.freeze({
      currency: money.currency,
      coefficient: money.coefficient,
      scale: money.scale,
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
  query: string | null;
  basis: SpendingRecordBasisFilter | null;
  occurrence: string;
  purchaseId: string;
}>;

function spendingRecordCursorToken(cursor: SpendingRecordCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function spendingRecordCursorFromToken(
  token: string | null | undefined,
  request: Readonly<{ knowledgeAt: number; month: string | null; day: string | null; categoryCodes: readonly string[] | null; query: string | null; basis: SpendingRecordBasisFilter | null }>,
): SpendingRecordCursor | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Partial<SpendingRecordCursor>;
    if (parsed.schemaVersion !== 1 || parsed.knowledgeAt !== request.knowledgeAt
        || parsed.month !== request.month || parsed.day !== request.day
        || JSON.stringify(parsed.categoryCodes ?? null) !== JSON.stringify(request.categoryCodes)
        || (parsed.query ?? null) !== request.query || (parsed.basis ?? null) !== request.basis
        || typeof parsed.occurrence !== "string" || !ISO_DATE.test(parsed.occurrence.slice(0, 10))
        || typeof parsed.purchaseId !== "string" || parsed.purchaseId.length === 0)
      throw new Error("invalid cursor fields");
    return parsed as SpendingRecordCursor;
  } catch (error) {
    throw new Error("Spending record cursor is stale or invalid; reload the current page.", { cause: error });
  }
}

/** A record search: lowercased text for substring matching, and the exact amount it may also denote. */
type SpendingRecordSearch = Readonly<{ text: string; amount: string | null }>;

const SEARCH_AMOUNT = /^(?:0|[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)(?:\.\d+)?$/u;

function recordSearch(query: string | null): SpendingRecordSearch | null {
  if (query === null) return null;
  const trimmed = query.trim();
  if (trimmed === "") return null;
  return Object.freeze({
    text: trimmed.toLowerCase(),
    amount: SEARCH_AMOUNT.test(trimmed) ? trimmed.replaceAll(",", "") : null,
  });
}

function recordBasisFilter(value: SpendingRecordPageRequest["basis"]): SpendingRecordBasisFilter | null {
  if (value === undefined || value === null) return null;
  if (value !== "linked") throw new TypeError("Spending record page basis filter is invalid.");
  return value;
}

export function validSpendingMonth(value: string): boolean {
  return /^\d{4}-(?:0[1-9]|1[0-2])$/u.test(value);
}

function validSpendingDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function sqlUuid(expression: string): string {
  const hex = `encode(${expression}, 'hex')`;
  return `substring(${hex} from 1 for 8) || '-' || substring(${hex} from 9 for 4) || '-' || substring(${hex} from 13 for 4) || '-' || substring(${hex} from 17 for 4) || '-' || substring(${hex} from 21 for 12)`;
}

/**
 * Every purchase-basis Spending query starts from the same purchase rows: the
 * active invoices, the eligible transactions, the links joining them, and the
 * refunds. purchaseRowsParams supplies its leading parameters. A transaction
 * of an account Direct source precedence covers is not eligible, and neither
 * is a refund of one. Only an active refund with an amount and an occurrence
 * counts and replaces its transaction's bank-only row. The record builder
 * applies the same rules (countedPurchaseRefunds), so every row selected here
 * has a built record with the same purchase id, date, and amount.
 *
 * With "month", only the purchases dated in the month passed as the first
 * parameter. Scoping drops unlinked payments of other months before any join;
 * every linked transaction, active invoice, and refund still decides link
 * validity and refund exclusion as for the whole set. The branches avoid joins
 * whose row estimates a month filter would skew: a link carries its invoice
 * and payment columns, and the exclusions are hashed NOT IN lookups (every id
 * involved is NOT NULL).
 */
function purchaseRowsCte(scope: "all" | "month"): string {
  const inMonth = (expression: string) => scope === "month"
    ? `AND SUBSTRING(${expression}, 1, 7) = (SELECT month FROM purchase_scope)`
    : "";
  return `
    WITH ${scope === "month" ? "purchase_scope AS MATERIALIZED (SELECT CAST(? AS text) AS month), " : ""}covered_transactions AS MATERIALIZED (
      SELECT transaction_id FROM financial_transactions WHERE NOT (${COUNTED_ACCOUNT_SQL("account_id")})
    ), invoice_ranked AS (
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
       WHERE transaction_id NOT IN (SELECT transaction_id FROM covered_transactions)
         ${inMonth("COALESCE(consume_date, posting_date, effective_on)")}
      UNION ALL
      SELECT transaction_id, amount_coefficient, amount_scale, currency, occurrence_value
        FROM linked_transactions
       WHERE transaction_id NOT IN (SELECT transaction_id FROM covered_transactions)
    ), valid_links AS MATERIALIZED (
      SELECT active_link.invoice_id, active_link.transaction_id,
             active_link.confirmed_event_id AS event_id,
             invoice.occurrence_value AS invoice_occurrence_value, invoice.revision_id AS invoice_revision_id,
             invoice.amount_coefficient AS invoice_amount_coefficient, invoice.amount_scale AS invoice_amount_scale,
             invoice.currency AS invoice_currency,
             transaction_row.amount_coefficient, transaction_row.amount_scale, transaction_row.currency
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
         AND transaction_id NOT IN (SELECT transaction_id FROM covered_transactions)
    ), purchase_rows AS MATERIALIZED (
      SELECT 'linked' AS basis, link.invoice_occurrence_value AS occurrence_value,
             link.amount_coefficient, link.amount_scale, link.currency,
             link.invoice_amount_coefficient, link.invoice_amount_scale, link.invoice_currency,
             link.invoice_id, link.invoice_revision_id,
             link.transaction_id, link.event_id,
             NULL::bytea AS refund_id,
             'link:' || ${sqlUuid("link.event_id")} AS purchase_id
        FROM valid_links link
       WHERE TRUE ${inMonth("link.invoice_occurrence_value")}
      UNION ALL
      SELECT 'invoice', invoice.occurrence_value,
             invoice.amount_coefficient, invoice.amount_scale, invoice.currency,
             invoice.amount_coefficient, invoice.amount_scale, invoice.currency,
             invoice.invoice_id, invoice.revision_id, NULL::bytea, NULL::bytea, NULL::bytea,
             'invoice:' || ${sqlUuid("invoice.invoice_id")}
        FROM active_invoices invoice
       WHERE invoice.invoice_id NOT IN (SELECT invoice_id FROM valid_links)
         ${inMonth("invoice.occurrence_value")}
      UNION ALL
      SELECT 'bank-transaction', transaction_row.occurrence_value,
             transaction_row.amount_coefficient, transaction_row.amount_scale, transaction_row.currency,
             NULL::text, NULL::bigint, NULL::text,
             NULL::bytea, NULL::bytea, transaction_row.transaction_id, NULL::bytea, NULL::bytea,
             'transaction:' || ${sqlUuid("transaction_row.transaction_id")}
        FROM eligible_transactions transaction_row
       WHERE transaction_row.transaction_id NOT IN (SELECT transaction_id FROM valid_links)
         AND transaction_row.transaction_id NOT IN (SELECT transaction_id FROM active_refunds)
         ${inMonth("transaction_row.occurrence_value")}
      UNION ALL
      SELECT 'refund', refund.occurrence_value,
             refund.amount_coefficient, refund.amount_scale, refund.currency,
             NULL::text, NULL::bigint, NULL::text,
             NULL::bytea, NULL::bytea, refund.transaction_id, NULL::bytea, refund.refund_id,
             'refund:' || ${sqlUuid("refund.refund_id")}
        FROM active_refunds refund
       WHERE TRUE ${inMonth("refund.occurrence_value")}
    )`;
}

const PURCHASE_ROWS_CTE = purchaseRowsCte("all");
const MONTH_PURCHASE_ROWS_CTE = purchaseRowsCte("month");

/** Parameters for purchaseRowsCte; a month selects its "month" scope. */
async function purchaseRowsParams(reader: PGliteSpendingReader, knowledgeAt: number, month?: string | null): Promise<unknown[]> {
  const params = [await readPGliteCoveredAccountIds(reader, knowledgeAt), knowledgeAt, knowledgeAt];
  return month ? [month, ...params] : params;
}


type PurchaseCategoryRow = Readonly<{
  purchaseId: string;
  basis: PurchaseReport["records"][number]["basis"];
  occurrence: string;
  amount: Money | null;
  category: PurchaseCategory;
}>;

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
  const params: unknown[] = await purchaseRowsParams(reader, knowledgeAt, scope.month);
  const dayFilter = scope.day ? "AND SUBSTRING(purchase_rows.occurrence_value, 1, 10) = ?" : "";
  if (scope.day) params.push(scope.day);
  const result = await pgliteQuery<Row>(reader, `${scope.month ? MONTH_PURCHASE_ROWS_CTE : PURCHASE_ROWS_CTE}
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
     WHERE TRUE ${dayFilter}
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
  const values: MoneyTotalsAccumulator = new Map();
  const categoryCodes = new Map<string, string | null>();
  for (const purchase of purchases) {
    if (!purchase.amount) continue;
    const month = purchase.occurrence.slice(0, 7);
    const parts = purchase.category.mode === "split"
      ? purchase.category.components.map((component) => ({ categoryCode: component.categoryCode as string | null, amount: component.amount }))
      : [{ categoryCode: purchase.category.mode === "single" ? purchase.category.categoryCode : null, amount: purchase.amount }];
    for (const part of parts) {
      addToTotals(values, part.amount, (currency) => {
        const key = `${month}|${currency}|${part.categoryCode ?? ""}`;
        categoryCodes.set(key, part.categoryCode);
        return key;
      });
    }
  }
  return Object.freeze(readTotals(values).map(({ key, currency, coefficient, scale, count }) => Object.freeze({
    month: key.slice(0, 7),
    currency,
    categoryCode: categoryCodes.get(key) ?? null,
    coefficient,
    scale,
    count,
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
  if (request.query !== undefined && request.query !== null && typeof request.query !== "string")
    throw new TypeError("Spending record page query must be text.");
  const query = request.query?.trim() ? request.query.trim() : null;
  if (query !== null && month === null) throw new TypeError("Spending record page search needs a month.");
  const search = recordSearch(query);
  const basis = recordBasisFilter(request.basis);
  const cursor = spendingRecordCursorFromToken(request.cursor, { knowledgeAt: current, month, day, categoryCodes, query, basis });
  const limit = Number.isSafeInteger(request.limit) && (request.limit ?? 0) > 0
    ? Math.min(request.limit ?? 50, 100)
    : 50;
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
      return Object.freeze({ schemaVersion: 1, knowledgeAt: current, month, day, categoryCodes, query, basis, records: Object.freeze([]), nextCursor: null });
    }
  }
  const categoryFilter = matchingPurchaseIds === null
    ? ""
    : `AND purchase_rows.purchase_id IN (${matchingPurchaseIds.map(() => "?").join(",")})`;
  const basisFilter = basis === null ? "" : "AND purchase_rows.basis = ?";
  const searchJoins = search === null ? "" : `
        LEFT JOIN einvoice_invoice_revisions search_invoice ON search_invoice.revision_id = purchase_rows.invoice_revision_id
        LEFT JOIN current_transactions search_current ON search_current.transaction_id = purchase_rows.transaction_id
        LEFT JOIN transaction_revisions search_transaction ON search_transaction.revision_id = search_current.revision_id`;
  const searchFilter = search === null ? "" : `AND (
           strpos(LOWER(COALESCE(search_invoice.seller_name, '')), ?) > 0
        OR strpos(LOWER(COALESCE(search_transaction.description, '')), ?) > 0
        ${search.amount === null ? "" : "OR (purchase_rows.amount_coefficient IS NOT NULL AND purchase_rows.amount_coefficient::numeric = CAST(? AS numeric) * POWER(10::numeric, purchase_rows.amount_scale))"})`;
  const params: unknown[] = await purchaseRowsParams(reader, current, month);
  if (day !== null) params.push(day);
  if (cursor !== null) params.push(cursor.occurrence, cursor.occurrence, cursor.purchaseId);
  if (matchingPurchaseIds !== null) params.push(...matchingPurchaseIds);
  if (basis !== null) params.push(basis);
  if (search !== null) params.push(search.text, search.text, ...(search.amount === null ? [] : [search.amount]));
  params.push(limit + 1);
  const result = await pgliteQuery<Row>(reader, `${month === null ? PURCHASE_ROWS_CTE : MONTH_PURCHASE_ROWS_CTE}, selected_rows AS (
      SELECT purchase_rows.*
        FROM purchase_rows ${searchJoins}
       WHERE TRUE ${dayFilter} ${cursorFilter} ${categoryFilter} ${basisFilter} ${searchFilter}
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
  const composed = await purchaseRecordsByIdentity(reader, current, { invoiceIds, transactionIds });
  const recordById = new Map(composed.records.map((record) => [record.purchaseId, record]));
  const unbuilt: string[] = [];
  const pageRecords = visibleRows.flatMap((row) => {
    const purchaseId = stringValue(row.purchase_id, "Spending purchase identity");
    const record = recordById.get(purchaseId);
    if (record) return [record];
    unbuilt.push(purchaseId);
    return [];
  });
  // purchaseRowsCte selected these rows, so the record builder should produce
  // them under the same rules. A miss means the two renditions disagree.
  // Report it loudly but keep the page usable: one disagreeing row must not
  // take the person's whole month away. The month parity checks compare pages
  // with the complete report.
  if (unbuilt.length > 0) {
    console.error("spending-purchase-rules-disagree", { month, day, purchaseIds: unbuilt });
  }
  const last = visibleRows.at(-1);
  const page: SpendingRecordPageDto = Object.freeze({
    schemaVersion: 1,
    knowledgeAt: current,
    month,
    day,
    categoryCodes,
    query,
    basis,
    records: Object.freeze(pageRecords),
    nextCursor: hasNext && last ? spendingRecordCursorToken({
      schemaVersion: 1,
      knowledgeAt: current,
      month,
      day,
      categoryCodes,
      query,
      basis,
      occurrence: stringValue(last.occurrence_value, "Spending page occurrence"),
      purchaseId: stringValue(last.purchase_id, "Spending page purchase identity"),
    }) : null,
  });
  return page;
}


/**
 * Hydrate only the records one Pairing decision touches: every record whose
 * invoice or transaction is in the pair, at the current version.
 */
export async function queryCurrentSpendingActionRecords(
  reader: PGliteSpendingReader,
  request: Readonly<{ knowledgeAt: number } & PurchasePair>,
): Promise<readonly PurchaseRecord[]> {
  const current = await latest(reader);
  if (!Number.isSafeInteger(request.knowledgeAt) || request.knowledgeAt !== current)
    throw new Error("Spending action records data version is stale; reload Spending.");
  const composed = await purchaseRecordsByIdentity(reader, current, {
    invoiceIds: [request.invoiceIdentityId],
    transactionIds: [request.transactionIdentityId],
  });
  return Object.freeze(composed.records.filter((record) =>
    record.invoice?.invoiceId === request.invoiceIdentityId ||
    record.transaction?.transactionId === request.transactionIdentityId));
}

/** A record's summary line: the day and month the summary buckets it under, its counted amount, and its category. */
function summaryLine(record: PurchaseRecord): SpendingSummaryDeltaLine {
  return Object.freeze({
    date: record.occurrence.value.slice(0, 10),
    amount: record.amount
      // The summary groups by upper-cased currency, so the delta must name the same bucket.
      ? { currency: normalizeCurrency(record.amount.currency), coefficient: record.amount.coefficient, scale: record.amount.scale }
      : null,
    category: record.category,
  });
}

/** The lines of `records` except a record the other side holds unchanged, so it moves no total. */
function changedLines(
  records: readonly PurchaseRecord[],
  other: readonly PurchaseRecord[],
): readonly SpendingSummaryDeltaLine[] {
  const unchanged = new Set(other.map((record) => `${record.purchaseId}|${JSON.stringify(summaryLine(record))}`));
  return Object.freeze(records
    .map((record) => ({ key: `${record.purchaseId}|${JSON.stringify(summaryLine(record))}`, line: summaryLine(record) }))
    .filter(({ key }) => !unchanged.has(key))
    .map(({ line }) => line));
}

/**
 * Apply one Pairing decision inside the caller's write transaction. Reads the
 * pair's records under the Purchase report rules, runs `write`, reads them
 * again at the new version, and returns the records after and the summary
 * delta between the two reads. A record that both reads build with the same
 * summary line cancels, so a denial moves no total.
 */
export async function decide(
  transaction: PGliteTransaction,
  pair: PurchasePair,
  write: (transaction: PGliteTransaction) => Promise<unknown>,
): Promise<Readonly<{
  baseKnowledgeAt: number;
  knowledgeAt: number;
  beforeRecords: readonly PurchaseRecord[];
  affectedRecords: SpendingPageActionResult["affectedRecords"];
  summaryDelta: SpendingPageActionResult["summaryDelta"];
}>> {
  const baseKnowledgeAt = await latest(transaction);
  const beforeRecords = await queryCurrentSpendingActionRecords(transaction, { knowledgeAt: baseKnowledgeAt, ...pair });
  await write(transaction);
  const knowledgeAt = await latest(transaction);
  const affectedRecords = await queryCurrentSpendingActionRecords(transaction, { knowledgeAt, ...pair });
  return Object.freeze({
    baseKnowledgeAt,
    knowledgeAt,
    beforeRecords,
    affectedRecords,
    summaryDelta: Object.freeze({ before: changedLines(beforeRecords, affectedRecords), after: changedLines(affectedRecords, beforeRecords) }),
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
             SUBSTRING(occurrence_value, 1, 10) AS date, UPPER(TRIM(currency)) AS currency,
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
  `, await purchaseRowsParams(reader, knowledgeAt));

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

/**
 * Counted non-refund purchases of one month with their merchant facts. The
 * month is given directly or as the month of one purchase.
 */
export type MonthPurchaseFactsScope = Readonly<{ month: string } | { purchaseId: string }>;
export type MonthPurchaseFactsReader = (
  reader: PGliteSpendingReader,
  knowledgeAt: number,
  scope: MonthPurchaseFactsScope,
) => Promise<readonly MonthPurchaseFact[]>;

/** Every non-refund purchase of one month: the month asked for, or the purchase's own month. */
export async function queryMonthPurchaseFacts(
  reader: PGliteSpendingReader,
  knowledgeAt: number,
  scope: MonthPurchaseFactsScope,
): Promise<readonly MonthPurchaseFact[]> {
  const monthFilter = "month" in scope
    ? "TRUE"
    : `SUBSTRING(purchase_rows.occurrence_value, 1, 7) = (
         SELECT SUBSTRING(target.occurrence_value, 1, 7) FROM purchase_rows target WHERE target.purchase_id = ?)`;
  const result = rows(await pgliteQuery<Row>(reader, `${"month" in scope ? MONTH_PURCHASE_ROWS_CTE : PURCHASE_ROWS_CTE}
    SELECT purchase_rows.basis, purchase_rows.purchase_id, purchase_rows.occurrence_value,
           purchase_rows.amount_coefficient, purchase_rows.amount_scale, purchase_rows.currency,
           invoice_revision.seller_tax_id, invoice_revision.seller_name,
           transaction_revision.description
      FROM purchase_rows
      LEFT JOIN einvoice_invoice_revisions invoice_revision ON invoice_revision.revision_id = purchase_rows.invoice_revision_id
      LEFT JOIN current_transactions current_row ON current_row.transaction_id = purchase_rows.transaction_id
      LEFT JOIN transaction_revisions transaction_revision ON transaction_revision.revision_id = current_row.revision_id
     WHERE purchase_rows.basis <> 'refund' AND ${monthFilter}`,
    "month" in scope
      ? await purchaseRowsParams(reader, knowledgeAt, scope.month)
      : [...await purchaseRowsParams(reader, knowledgeAt), scope.purchaseId],
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
