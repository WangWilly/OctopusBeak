import { COUNTED_ACCOUNT_SQL, readPGliteCoveredAccountIds } from "./direct-source-precedence.ts";
import type {
  CanonicalEInvoiceItemView,
  CanonicalEInvoiceMoneyView,
  CanonicalEInvoiceView,
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
import { CANONICAL_SPENDING_INCLUSION_POLICY } from "../canonical/spending-inclusion-policy.ts";
import type {
  SpendingCandidateView,
  SpendingDedupLinkView,
  SpendingPair,
  SpendingRecognitionSnapshot,
  SpendingRefundView,
} from "../canonical/spending-recognition-contracts.ts";
import {
  cardMaskLastFour,
  type PurchaseItemCategorizationIndex,
  type PurchasePaymentSourceIndex,
} from "../canonical/spending-purchase-report-core.ts";
import type { PurchaseItemCategorization } from "../canonical/purchase-category.ts";
import { isCategoryApplicable } from "../canonical/transaction-taxonomy.ts";
import {
  addExact,
  addToTotals,
  compareExact,
  moneyTotals,
  normalizeExact,
  readTotals,
  sameCurrency,
  type ExactAmount,
  type MoneyTotalsAccumulator,
} from "../../lib/shared-money/exact-money.ts";
import {
  bytes,
  exactMoney,
  idString,
  jsonValue,
  latest,
  nullableString,
  numeric,
  pairKey,
  pgliteQuery,
  rows,
  stringValue,
  type Money,
  type PGliteSpendingReader,
  type Row,
} from "./spending-sql.ts";

/**
 * Canonical fact readers for PGlite Spending: transactions with their
 * enrichment and inclusion, invoices with their items, recognition, item
 * categorizations, and payment source facts. Each reader takes the caller's
 * transaction and returns canonical views; purchase-basis rules live in
 * purchase-report.ts.
 */

export type QueryKind = "current" | "historical";

const EXCLUDED_KIND_PREFIXES = [
  "transfer",
  "cash",
  "investment",
  "payment.credit_card",
  "payment.loan",
] as const;

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

export type TransactionRow = Row & Readonly<{ transaction_id: unknown; revision_id: unknown; account_id: unknown }>;

async function transactionRows(
  reader: PGliteSpendingReader,
  kind: QueryKind,
  knowledgeAt: number,
  financialAt: string | null,
  request: Readonly<{ sourceConnectionKey?: string; accountIds?: readonly string[]; transactionIds?: readonly string[]; startDate?: string; endDate?: string }> = {},
): Promise<readonly TransactionRow[]> {
  const predicates: string[] = [COUNTED_ACCOUNT_SQL("account.account_id")];
  const params: unknown[] = [await readPGliteCoveredAccountIds(reader, kind === "current" ? await latest(reader) : knowledgeAt)];
  if (kind !== "current") {
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
              connection_scope.integration_namespace, account.institution_key, account.stream,
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
              connection_scope.integration_namespace, account.institution_key, account.stream,
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
            source_connection_key, integration_namespace, institution_key, stream,
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

export type EnrichmentRow = Row & Readonly<{ transaction_id: unknown; field_name: unknown }>;
export type CategorizationRow = Row & Readonly<{ transaction_id: unknown; mode: unknown }>;
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

export function categoryFromRows(transaction: TransactionRow, kind: string | null, values: readonly CategorizationRow[], enrichments: readonly EnrichmentRow[]): CanonicalSpendingCategorization {
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
      let total: ExactAmount = { coefficient: "0", scale: 0 };
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
        const amount = { coefficient, scale };
        total = addExact(total, amount);
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
          ...normalizeExact(amount),
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
      if (valid && components.length >= 2 && compareExact(total, exactMoney(transaction)) === 0) {
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
    institutionKey: stringValue(row.institution_key, "Account Institution"),
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
  const totalValues: Money[] = [];
  const classifiedValues: Money[] = [];
  const unclassifiedValues: Money[] = [];
  const gapValues: Money[] = [];
  const categoryValues: MoneyTotalsAccumulator = new Map();
  const categoryOf = new Map<string, { categoryCode: string; taxonomyId: string; taxonomyVersion: string }>();
  for (const original of values) {
    const amount = original.amount;
    const gap = !["inflow", "outflow"].includes(original.direction) || !["pending", "posted"].includes(original.postingStatus) || !["normal", "canceled", "refund", "reversal"].includes(original.economicStatus) || !["active", "deleted", "purged"].includes(original.administrativeState) || original.kind === null;
    let transaction: CanonicalSpendingTransaction;
    if (gap) {
      gapValues.push(amount);
      transaction = { ...original, inclusion: "eligibility-gap", eligibilityGap: "missing-report-inclusion-semantics" };
    } else if (original.administrativeState !== "active" || original.economicStatus !== "normal" || original.postingStatus !== "posted" || original.direction !== "outflow" || excludedKind(original.kind!)) {
      transaction = { ...original, inclusion: "excluded" };
    } else {
      transaction = { ...original, inclusion: "included" };
      included.push(transaction);
      totalValues.push(amount);
      if (transaction.categorization.mode === "absent") unclassifiedValues.push(amount);
      else if (transaction.categorization.mode === "single") {
        classifiedValues.push(amount);
        const category = transaction.categorization;
        addToTotals(categoryValues, amount, (currency) => {
          const key = `${category.categoryCode}|${category.taxonomyId}|${category.taxonomyVersion}|${currency}`;
          categoryOf.set(key, { categoryCode: category.categoryCode!, taxonomyId: category.taxonomyId!, taxonomyVersion: category.taxonomyVersion! });
          return key;
        });
      } else {
        let fullyClassified = true;
        for (const component of transaction.categorization.components ?? []) {
          // A component books into its transaction's currency bucket.
          addToTotals(categoryValues, { ...component, currency: amount.currency }, (currency) => {
            const key = `${component.categoryCode}|${component.taxonomyId}|${component.taxonomyVersion}|${currency}`;
            categoryOf.set(key, { categoryCode: component.categoryCode, taxonomyId: component.taxonomyId, taxonomyVersion: component.taxonomyVersion });
            return key;
          });
          if (!sameCurrency(component, amount)) fullyClassified = false;
        }
        if (fullyClassified) classifiedValues.push(amount);
        else unclassifiedValues.push(amount);
      }
    }
    output.push(transaction);
  }
  const categoryTotalsByCurrency = readTotals(categoryValues).map(({ key, currency, coefficient, scale, count }) => ({
    ...categoryOf.get(key)!,
    currency,
    coefficient,
    scale,
    count,
  })).sort((left, right) => `${left.categoryCode}:${left.taxonomyId}:${left.currency}`.localeCompare(`${right.categoryCode}:${right.taxonomyId}:${right.currency}`));
  const includedCount = included.length;
  const classifiedCount = classifiedValues.length;
  const unclassifiedCount = unclassifiedValues.length;
  const gapCount = gapValues.length;
  return {
    status: "ok",
    kind,
    knowledgePoint: knowledgeAt,
    financialAt,
    inclusionPolicy: CANONICAL_SPENDING_INCLUSION_POLICY,
    transactions: output,
    includedTransactions: included,
    totalsByCurrency: moneyTotals(totalValues),
    categoryTotalsByCurrency,
    unclassifiedByCurrency: moneyTotals(unclassifiedValues),
    classificationCoverage: {
      includedCount,
      classifiedCount,
      unclassifiedCount,
      includedAmountByCurrency: moneyTotals(totalValues),
      classifiedAmountByCurrency: moneyTotals(classifiedValues),
      unclassifiedAmountByCurrency: moneyTotals(unclassifiedValues),
    },
    reportEligibility: { status: gapCount === 0 ? "complete" : "incomplete", gapCount, gapAmountByCurrency: moneyTotals(gapValues) },
    totalStatus: gapCount === 0 ? "complete" : "incomplete",
  };
}

export async function querySpendingReport(
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
export async function queryCurrentTransactionById(
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

export async function invoiceViewFromRow(
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

export async function invoices(
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

export function linkFromRow(row: Row): SpendingDedupLinkView {
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

export function refundFromRow(row: Row): SpendingRefundView {
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
 * Bank-side display facts for the given transactions: the card mask reduced
 * to `****dddd`, and the cycle of the latest statement revision that lists the
 * transaction. Account numbers and instrument keys never leave this query.
 */
export async function queryPaymentSourceFacts(
  reader: PGliteSpendingReader,
  transactionIds: readonly string[],
): Promise<PurchasePaymentSourceIndex> {
  if (transactionIds.length === 0) return new Map();
  // A complete report cannot bind every id; read every current row instead.
  const scoped = transactionIds.length <= 4_096;
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
      ${scoped ? `WHERE current_row.transaction_id IN (${transactionIds.map(() => "?").join(",")})` : ""}`,
    scoped ? transactionIds.map((value) => bytes(value, "Payment source transaction")) : [],
  ));
  const wanted = scoped ? null : new Set(transactionIds);
  return new Map(result.flatMap((row) => {
    const transactionId = idString(row.transaction_id, "Payment source transaction");
    return wanted && !wanted.has(transactionId) ? [] : [[transactionId, Object.freeze({
      cardMask: cardMaskLastFour(nullableString(row.card_mask)),
      billingPeriod: row.cycle_start === null || row.cycle_start === undefined ? null : Object.freeze({
        start: stringValue(row.cycle_start, "Statement cycle start"),
        end: stringValue(row.cycle_end, "Statement cycle end"),
      }),
    })] as const];
  }));
}

export function itemCategorizationFromRow(row: Row): PurchaseItemCategorization {
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
