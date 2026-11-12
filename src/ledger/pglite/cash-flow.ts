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
 * A refund inherits its original's categories only through `refund_of`, as
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

/** Each refund's one `refund_of` original; a refund naming several originals inherits nothing. */
async function refundOriginals(reader: PGliteSpendingReader, refundIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const originals = new Map<string, string | null>();
  for (let start = 0; start < refundIds.length; start += 2_048) {
    const chunk = refundIds.slice(start, start + 2_048);
    for (const row of rows(await pgliteQuery<{ from_transaction_id: unknown; to_transaction_id: unknown }>(reader,
      `SELECT DISTINCT from_transaction_id, to_transaction_id
         FROM canonical_credit_card_relations
        WHERE relation_kind = 'refund_of'
          AND from_transaction_id IN (${chunk.map(() => "?").join(",")})`,
      chunk.map((id) => bytes(id, "Refund transaction")),
    ))) {
      const refund = idString(row.from_transaction_id, "Refund transaction");
      const original = idString(row.to_transaction_id, "Refunded transaction");
      originals.set(refund, originals.has(refund) && originals.get(refund) !== original ? null : original);
    }
  }
  return new Map([...originals].filter((entry): entry is [string, string] => entry[1] !== null));
}

async function canonicalTransactions(reader: PGliteSpendingReader, knowledgeAt: number, request: CashFlowRequest): Promise<CashFlowTransaction[]> {
  const report = await querySpendingReport(reader, "current", knowledgeAt, null, request);
  const included = report.transactions.filter(counted).map((transaction) => {
    const flowDirection = direction(transaction.direction);
    const amount = { ...absoluteExact(transaction.amount), currency: transaction.amount.currency };
    return { transaction, flowDirection, amount, rule: cashFlowRule(transaction.kind, flowDirection) };
  });
  const uncategorizedRefunds = included
    .filter((entry) => entry.rule.class === "refund" && sharesOf(entry.transaction.categorization, entry.amount) === null)
    .map((entry) => entry.transaction.transactionId);
  const originalOf = await refundOriginals(reader, uncategorizedRefunds);
  const originals = originalOf.size === 0
    ? new Map<string, CanonicalSpendingTransaction>()
    : new Map((await querySpendingReport(reader, "current", knowledgeAt, null, { transactionIds: [...new Set(originalOf.values())] }))
      .transactions.map((original) => [original.transactionId, original]));
  return included.map(({ transaction, flowDirection, amount, rule }) => {
    const own = sharesOf(transaction.categorization, amount);
    const originalId = rule.class === "refund" && own === null ? originalOf.get(transaction.transactionId) : undefined;
    const inherited = originalId === undefined ? null : inheritedShares(originals.get(originalId), amount);
    return {
      transactionId: transaction.transactionId,
      source: "canonical" as const,
      accountId: transaction.accountId,
      date: transaction.consumeDate ?? transaction.effectiveOn,
      amount,
      direction: flowDirection,
      kind: canonicalCashFlowKind(transaction.kind),
      cashFlow: cashFlowClass(rule, inherited ?? own ?? unclassified(amount), inherited ? originalId! : null),
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
