import {
  CASH_FLOW_INCLUSION_POLICY,
  canonicalCashFlowKind,
  cashFlowClass,
  cashFlowRule,
  cashFlowTotals,
  categoryShare,
  type CashFlowCategoryShare,
  type CashFlowCurrencyTotals,
  type CashFlowTransaction,
} from "../canonical/cash-flow-inclusion.ts";
import type { CanonicalSpendingCategorization, CanonicalSpendingTransaction } from "../canonical/canonical-spending-contracts.ts";
import { isPersonalCategoryCode } from "../canonical/personal-category-codes.ts";
import { exactFromManualAmount } from "../../lib/manual-assets/manual-assets.ts";
import { absoluteExact, compareExact, sameCurrency, type ExactMoney } from "../../lib/shared-money/exact-money.ts";
import { readKnowledgePoint } from "./knowledge-point.ts";
import { querySpendingReport } from "./spending-facts.ts";
import { bytes, idString, ISO_DATE, pgliteQuery, rows, type PGliteSpendingReader } from "./spending-sql.ts";

/**
 * The Cash flow inclusion query (PRD #456, issue #457): every canonical and
 * Manual Account transaction dated in a range, each with its cash-flow class.
 * Canonical rows come from the same fact reader as Spending, which already
 * leaves out accounts Direct source precedence covers; Preview Financial Data
 * lives in its own tables and never reaches it.
 */

export type CashFlowRequest = Readonly<{ startDate: string; endDate: string }>;

export type CashFlowReport = Readonly<{
  policy: typeof CASH_FLOW_INCLUSION_POLICY;
  knowledgeAt: number;
  startDate: string;
  endDate: string;
  transactions: readonly CashFlowTransaction[];
  totals: readonly CashFlowCurrencyTotals[];
}>;

function direction(value: string): "inflow" | "outflow" {
  if (value === "inflow" || value === "outflow") return value;
  throw new Error(`Transaction direction ${value} is not supported.`);
}

/** A single category or a complete allocation in the booked currency; anything else is unclassified. */
function sharesOf(categorization: CanonicalSpendingCategorization, amount: ExactMoney): readonly CashFlowCategoryShare[] | null {
  if (categorization.mode === "single")
    return isPersonalCategoryCode(categorization.categoryCode) ? [categoryShare(categorization.categoryCode, amount)] : null;
  if (categorization.mode !== "allocated") return null;
  const shares: CashFlowCategoryShare[] = [];
  for (const component of categorization.components ?? []) {
    if (!isPersonalCategoryCode(component.categoryCode) || !sameCurrency(component, amount)) return null;
    shares.push(categoryShare(component.categoryCode, component));
  }
  return shares.length > 0 ? shares : null;
}

const unclassified = (amount: ExactMoney): readonly CashFlowCategoryShare[] => [categoryShare(null, amount)];

/**
 * A refund inherits its original's categories only through `refund_of` or `reversal_of`, as
 * Relation-backed categorization allows: a single category always, an
 * allocation only for a full refund, never a proportional guess.
 */
function inheritedShares(original: CanonicalSpendingTransaction | undefined, amount: ExactMoney): readonly CashFlowCategoryShare[] | null {
  if (!original) return null;
  if (original.categorization.mode === "single") return sharesOf(original.categorization, amount);
  if (original.categorization.mode === "allocated" && sameCurrency(original.amount, amount)
    && compareExact(absoluteExact(original.amount), amount) === 0)
    return sharesOf(original.categorization, amount);
  return null;
}

function counted(transaction: CanonicalSpendingTransaction): boolean {
  return transaction.administrativeState === "active"
    && transaction.postingStatus === "posted"
    && transaction.economicStatus !== "canceled";
}

/** Run one `IN (...)` read per chunk of transaction ids. */
async function byChunk<T extends Record<string, unknown>>(
  reader: PGliteSpendingReader,
  ids: readonly string[],
  sql: (placeholders: string) => string,
  leading: readonly unknown[] = [],
): Promise<T[]> {
  const found: T[] = [];
  for (let start = 0; start < ids.length; start += 2_048) {
    const chunk = ids.slice(start, start + 2_048);
    const params = [...leading, ...chunk.map((id) => bytes(id, "Transaction"))];
    found.push(...rows(await pgliteQuery<T>(reader, sql(chunk.map(() => "?").join(",")), params)));
  }
  return found;
}

/** The `evidenceKind` the Kind enrichment recorded for each transaction, when it recorded one. */
async function kindEvidence(reader: PGliteSpendingReader, transactionIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const found = await byChunk<{ transaction_id: unknown; evidence_kind: unknown }>(reader, transactionIds, (placeholders) =>
    `SELECT enrichment.transaction_id, (output.provenance_json::jsonb)->>'evidenceKind' AS evidence_kind
       FROM current_transaction_enrichment enrichment
       JOIN enrichment_run_outputs output ON output.assertion_id = enrichment.assertion_id
      WHERE enrichment.field_name = 'kind'
        AND enrichment.transaction_id IN (${placeholders})`);
  return new Map(found.filter((row) => typeof row.evidence_kind === "string")
    .map((row) => [idString(row.transaction_id, "Kind transaction"), row.evidence_kind as string]));
}

/**
 * Each refund's `refund_of` or `reversal_of` original, or null when it names
 * several originals: such a refund is still related, but inherits nothing.
 */
async function refundOriginals(reader: PGliteSpendingReader, refundIds: readonly string[]): Promise<ReadonlyMap<string, string | null>> {
  const originals = new Map<string, string | null>();
  for (const row of await byChunk<{ from_transaction_id: unknown; to_transaction_id: unknown }>(reader, refundIds, (placeholders) =>
    `SELECT DISTINCT from_transaction_id, to_transaction_id
       FROM canonical_credit_card_relations
      WHERE relation_kind IN ('refund_of', 'reversal_of')
        AND from_transaction_id IN (${placeholders})`)) {
    const refund = idString(row.from_transaction_id, "Refund transaction");
    const original = idString(row.to_transaction_id, "Refunded transaction");
    originals.set(refund, originals.has(refund) && originals.get(refund) !== original ? null : original);
  }
  return originals;
}

/** Transactions Spending recognizes as an active refund, the same rows as active_refunds in the Purchase report. */
async function spendingRefunds(reader: PGliteSpendingReader, knowledgeAt: number, transactionIds: readonly string[]): Promise<ReadonlySet<string>> {
  const found = await byChunk<{ transaction_id: unknown }>(reader, transactionIds, (placeholders) =>
    `WITH ranked AS (
       SELECT identity.transaction_id, revision.state, revision.amount_coefficient, revision.occurrence_value,
              ROW_NUMBER() OVER (
                PARTITION BY revision.refund_id
                ORDER BY revision.revision_number DESC, commit_row.commit_sequence DESC, revision.revision_id DESC
              ) AS revision_rank
         FROM spending_refund_revisions revision
         JOIN spending_refund_identities identity ON identity.refund_id = revision.refund_id
         JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
        WHERE commit_row.commit_sequence <= ?
          AND identity.transaction_id IN (${placeholders})
     ) SELECT transaction_id FROM ranked
        WHERE revision_rank = 1 AND state = 'active'
          AND amount_coefficient IS NOT NULL AND occurrence_value IS NOT NULL`, [knowledgeAt]);
  return new Set(found.map((row) => idString(row.transaction_id, "Refund transaction")));
}

async function canonicalTransactions(reader: PGliteSpendingReader, knowledgeAt: number, request: CashFlowRequest): Promise<CashFlowTransaction[]> {
  const report = await querySpendingReport(reader, "current", knowledgeAt, null, request);
  const counting = report.transactions.filter(counted);
  const evidenceOf = await kindEvidence(reader, counting.map((transaction) => transaction.transactionId));
  const included = counting.map((transaction) => {
    const flowDirection = direction(transaction.direction);
    const amount = { ...absoluteExact(transaction.amount), currency: transaction.amount.currency };
    const evidence = evidenceOf.get(transaction.transactionId) ?? null;
    return { transaction, flowDirection, amount, evidence, rule: cashFlowRule(transaction.kind, flowDirection) };
  });
  const refundIds = included.filter((entry) => entry.rule.class === "refund").map((entry) => entry.transaction.transactionId);
  const originalOf = await refundOriginals(reader, refundIds);
  // A card inflow is a refund by direction alone; only a relation or Spending's refund recognition proves it is one.
  const directionRefunds = included
    .filter((entry) => entry.rule.class === "refund" && entry.evidence === "direction" && !originalOf.has(entry.transaction.transactionId))
    .map((entry) => entry.transaction.transactionId);
  const recognized = await spendingRefunds(reader, knowledgeAt, directionRefunds);
  const unproven = new Set(directionRefunds.filter((id) => !recognized.has(id)));
  const originalIds = [...new Set([...originalOf.values()].filter((id): id is string => id !== null))];
  const originals = originalIds.length === 0
    ? new Map<string, CanonicalSpendingTransaction>()
    : new Map((await querySpendingReport(reader, "current", knowledgeAt, null, { transactionIds: originalIds }))
      .transactions.map((original) => [original.transactionId, original]));
  return included.map(({ transaction, flowDirection, amount, evidence, rule }) => {
    const own = sharesOf(transaction.categorization, amount);
    // Only a refund's own User Categorization outranks Relation-backed categorization.
    const originalId = rule.class === "refund" && transaction.categorization.origin !== "user"
      ? originalOf.get(transaction.transactionId) ?? undefined
      : undefined;
    const inherited = originalId === undefined ? null : inheritedShares(originals.get(originalId), amount);
    return {
      transactionId: transaction.transactionId,
      source: "canonical" as const,
      accountId: transaction.accountId,
      date: transaction.consumeDate ?? transaction.effectiveOn,
      amount,
      direction: flowDirection,
      kind: canonicalCashFlowKind(transaction.kind, evidence),
      cashFlow: unproven.has(transaction.transactionId)
        ? { class: "unresolved" as const }
        : cashFlowClass(rule, inherited ?? own ?? unclassified(amount), inherited ? originalId! : null),
    };
  });
}

type ManualRow = Readonly<{
  transaction_id: string; account_id: string; occurred_on: string; amount: string; currency: string;
  kind: "purchase" | "receipt" | "transfer"; personal_category: string | null; direction: "out" | "in" | null;
}>;

/** A Manual Account's Kind is what the person entered, so it is never a producer fallback. */
async function manualTransactions(reader: PGliteSpendingReader, request: CashFlowRequest): Promise<CashFlowTransaction[]> {
  const result = await reader.query<ManualRow>(
    `SELECT tx.transaction_id, tx.account_id, tx.occurred_on, tx.amount, account.currency,
            tx.kind, tx.personal_category, tx.direction
       FROM manual_transactions tx
       JOIN manual_assets account ON account.asset_id = tx.account_id
      WHERE tx.occurred_on BETWEEN $1 AND $2`,
    [request.startDate, request.endDate],
  );
  return result.rows.map((row) => {
    const flowDirection = row.kind === "purchase" || row.direction === "out" ? "outflow" : "inflow";
    const amount = { ...exactFromManualAmount(row.amount), currency: row.currency };
    const category = isPersonalCategoryCode(row.personal_category) ? row.personal_category : null;
    return {
      transactionId: row.transaction_id,
      source: "manual" as const,
      accountId: row.account_id,
      date: row.occurred_on,
      amount,
      direction: flowDirection,
      kind: { code: row.kind, basis: "evidence" as const },
      cashFlow: cashFlowClass(cashFlowRule(row.kind, flowDirection), [categoryShare(category, amount)], null),
    };
  });
}

/** Classify every transaction dated from `startDate` through `endDate`, both inclusive. */
export async function readPGliteCashFlow(reader: PGliteSpendingReader, request: CashFlowRequest): Promise<CashFlowReport> {
  const { startDate, endDate } = request;
  if (!ISO_DATE.test(startDate) || !ISO_DATE.test(endDate) || startDate > endDate)
    throw new Error("Cash flow needs an ISO start date on or before its end date.");
  const knowledgeAt = await readKnowledgePoint(reader);
  const transactions = [
    ...await canonicalTransactions(reader, knowledgeAt, request),
    ...await manualTransactions(reader, request),
  ].sort((left, right) => left.date.localeCompare(right.date) || left.transactionId.localeCompare(right.transactionId));
  return { policy: CASH_FLOW_INCLUSION_POLICY, knowledgeAt, startDate, endDate, transactions, totals: cashFlowTotals(transactions) };
}
