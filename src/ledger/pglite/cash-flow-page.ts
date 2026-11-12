import type { CashFlowAmount, CashFlowCurrencyTotals } from "../canonical/cash-flow-inclusion.ts";
import { CASH_FLOW_INCLUSION_POLICY } from "../canonical/cash-flow-inclusion.ts";
import {
  CASH_FLOW_SEARCH_FIELDS,
  cashFlowTransferRole,
  type CashFlowAccountChange,
  type CashFlowCurrencySummary,
  type CashFlowPageDto,
  type CashFlowPageRequest,
  type CashFlowPeriod,
  type CashFlowPeriodTotals,
  type CashFlowSearchField,
  type CashFlowSearchResult,
  type CashFlowTransferSummary,
} from "../../lib/cash-flow/model.ts";
import {
  addExact,
  compareExact,
  exactToNumber,
  negateExact,
  normalizeExact,
  normalizeCurrency,
  subtractExact,
  type ExactAmount,
} from "../../lib/shared-money/exact-money.ts";
import type { CashFlowTransferLink } from "../canonical/cash-flow-transfer.ts";
import { readPGliteCashFlow, type CashFlowReport, type CashFlowReportTransaction, type CashFlowSearchRow } from "./cash-flow.ts";
import { cashFlowMatches, readCashFlowSearchMatches } from "./cash-flow-search.ts";
import { ISO_DATE, type PGliteSpendingReader } from "./spending-sql.ts";

/**
 * The Cash flow page (PRD #456, issue #460): one period's counted flow per
 * currency, compared with the period of the same length just before it, plus
 * the period's transactions. A search narrows the transactions here, in the
 * worker, and counts its matches across every period.
 */

const ZERO: ExactAmount = { coefficient: "0", scale: 0 };
const MAX_QUERY_LENGTH = 200;
const DAY_MS = 86_400_000;

const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const dateOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

function validDate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE.test(value) && dateOf(dayNumber(value)) === value;
}

export function parseCashFlowPageRequest(value: unknown): Readonly<{ startDate: string; endDate: string; query: string | null }> {
  const request = value as Partial<CashFlowPageRequest> | null;
  if (!request || !validDate(request.startDate) || !validDate(request.endDate) || request.startDate > request.endDate)
    throw new Error("Cash flow needs an ISO start date on or before its end date.");
  if (request.query !== undefined && typeof request.query !== "string") throw new Error("A Cash flow search must be text.");
  const query = request.query?.trim().slice(0, MAX_QUERY_LENGTH) ?? "";
  return { startDate: request.startDate, endDate: request.endDate, query: query === "" ? null : query };
}

/** The period of the same number of days that ends the day before `period` starts. */
export function previousCashFlowPeriod(period: Readonly<{ startDate: string; endDate: string }>): CashFlowPeriod {
  const start = dayNumber(period.startDate);
  const days = dayNumber(period.endDate) - start + 1;
  return { startDate: dateOf(start - days), endDate: dateOf(start - 1), days };
}

function periodOf(startDate: string, endDate: string): CashFlowPeriod {
  return { startDate, endDate, days: dayNumber(endDate) - dayNumber(startDate) + 1 };
}

function byAmountDescending<T extends CashFlowAmount>(left: T, right: T): number {
  return compareExact(right.amount, left.amount);
}

function ratio(kept: ExactAmount, inflow: ExactAmount): number | null {
  const whole = exactToNumber(inflow);
  return whole > 0 ? exactToNumber(kept) / whole : null;
}

function periodTotals(totals: CashFlowCurrencyTotals | undefined): CashFlowPeriodTotals {
  const inflow = totals?.inflow.amount ?? ZERO;
  const outflow = totals?.outflow.amount ?? ZERO;
  const kept = normalizeExact(subtractExact(inflow, outflow));
  return { inflow, outflow, kept, keptRatio: ratio(kept, inflow) };
}

const EMPTY_AMOUNT: CashFlowAmount = { amount: ZERO, count: 0 };

const emptyTransfers = (): { pairs: CashFlowTransferSummary["pairs"]; unpaired: CashFlowAmount } => ({
  pairs: { amount: ZERO, count: 0, origins: { evidence: 0, confirmed: 0, manual: 0 } },
  unpaired: EMPTY_AMOUNT,
});

const plus = (total: CashFlowAmount, amount: ExactAmount): CashFlowAmount =>
  ({ amount: normalizeExact(addExact(total.amount, amount)), count: total.count + 1 });

/**
 * Uncounted transfers per currency. A link counts once, at its outflow side's
 * amount, whichever of its sides is in the period; the two sides' amounts are
 * equal, so an inflow side alone stands in for it.
 */
function transferSummaries(report: Pick<CashFlowReport, "transactions" | "transfers">): ReadonlyMap<string, CashFlowTransferSummary> {
  const byCurrency = new Map<string, ReturnType<typeof emptyTransfers>>();
  const linkOf = new Map<string, CashFlowTransferLink>(report.transfers.links.map((link) => [link.linkId, link]));
  const counted = new Map<string, CashFlowReportTransaction>();
  for (const row of report.transactions) {
    const role = cashFlowTransferRole(row);
    if (role === null) continue;
    const currency = normalizeCurrency(row.amount.currency);
    const entry = byCurrency.get(currency) ?? emptyTransfers();
    byCurrency.set(currency, entry);
    if (role === "internal") entry.unpaired = plus(entry.unpaired, row.amount);
    else if (row.direction === "outflow" || !counted.has(row.transferLinkId!)) counted.set(row.transferLinkId!, row);
  }
  for (const [linkId, row] of counted) {
    const entry = byCurrency.get(normalizeCurrency(row.amount.currency))!;
    const origin = linkOf.get(linkId)!.origin.kind;
    entry.pairs = { ...plus(entry.pairs, row.amount), origins: { ...entry.pairs.origins, [origin]: entry.pairs.origins[origin] + 1 } };
  }
  return byCurrency;
}

function currencySummaries(
  current: readonly CashFlowCurrencyTotals[],
  previous: readonly CashFlowCurrencyTotals[],
  transfers: ReadonlyMap<string, CashFlowTransferSummary>,
): CashFlowCurrencySummary[] {
  const previousOf = new Map(previous.map((totals) => [totals.currency, totals]));
  return [...current]
    .sort((left, right) => Number(right.currency === "TWD") - Number(left.currency === "TWD") || left.currency.localeCompare(right.currency))
    .map((totals) => {
      const before = previousOf.get(totals.currency);
      const previousGroup = new Map(before?.outflow.groups.map((group) => [group.group, group.amount]) ?? []);
      const { kept, keptRatio } = periodTotals(totals);
      return {
        currency: totals.currency,
        inflow: { ...totals.inflow, groups: [...totals.inflow.groups].sort(byAmountDescending) },
        outflow: {
          ...totals.outflow,
          groups: totals.outflow.groups
            .map((group) => ({ ...group, previous: previousGroup.get(group.group) ?? ZERO }))
            .sort(byAmountDescending),
        },
        kept,
        keptRatio,
        unresolved: totals.unresolved,
        transfers: transfers.get(normalizeCurrency(totals.currency)) ?? emptyTransfers(),
        previous: periodTotals(before),
      };
    });
}

function signed(transaction: CashFlowReportTransaction): ExactAmount {
  return transaction.direction === "inflow" ? transaction.amount : negateExact(transaction.amount);
}

function accountChanges(transactions: readonly CashFlowReportTransaction[]): CashFlowAccountChange[] {
  const changes = new Map<string, { account: CashFlowReportTransaction["details"]["account"]; currency: string; amount: ExactAmount; count: number }>();
  for (const transaction of transactions) {
    const key = `${transaction.accountId}\u0000${transaction.amount.currency}`;
    const prior = changes.get(key);
    changes.set(key, {
      account: transaction.details.account,
      currency: transaction.amount.currency,
      amount: addExact(prior?.amount ?? ZERO, signed(transaction)),
      count: (prior?.count ?? 0) + 1,
    });
  }
  return [...changes.values()]
    .map((change) => ({ ...change, amount: normalizeExact(change.amount) }))
    .sort((left, right) => Number(right.currency === "TWD") - Number(left.currency === "TWD")
      || left.currency.localeCompare(right.currency)
      || compareExact(right.amount, left.amount)
      || left.account.id.localeCompare(right.account.id));
}

/** Newest first; within a day, timed rows by time, then rows without a reported time. */
function newestFirst(left: CashFlowReportTransaction, right: CashFlowReportTransaction): number {
  return right.date.localeCompare(left.date)
    || (right.details.time ?? "").localeCompare(left.details.time ?? "")
    || left.transactionId.localeCompare(right.transactionId);
}

function searchResult(
  query: string,
  inPeriod: readonly (readonly CashFlowSearchField[])[],
  allMatches: readonly CashFlowSearchRow[],
): CashFlowSearchResult {
  const fields = Object.fromEntries(CASH_FLOW_SEARCH_FIELDS.map((field) => [field, 0])) as Record<CashFlowSearchField, number>;
  for (const matched of inPeriod) for (const field of matched) fields[field] += 1;
  const dates = allMatches.map((transaction) => transaction.periodDate).sort();
  return {
    query,
    fields,
    allPeriods: { matches: allMatches.length, firstDate: dates[0] ?? null, lastDate: dates.at(-1) ?? null },
  };
}

/** Read the Cash flow page with the caller's reader, which owns the snapshot. */
export async function readCashFlowPage(reader: PGliteSpendingReader, input: CashFlowPageRequest): Promise<CashFlowPageDto> {
  const request = parseCashFlowPageRequest(input);
  const period = periodOf(request.startDate, request.endDate);
  const previousPeriod = previousCashFlowPeriod(period);
  const current = await readPGliteCashFlow(reader, period);
  const previous = await readPGliteCashFlow(reader, previousPeriod);
  let transactions = current.transactions;
  let search: CashFlowSearchResult | null = null;
  if (request.query !== null) {
    const query = request.query;
    const matched = current.transactions
      .map((transaction) => ({ transaction, fields: cashFlowMatches(transaction, query) }))
      .filter((entry) => entry.fields.length > 0);
    const all = await readCashFlowSearchMatches(reader, current.knowledgeAt, query);
    search = searchResult(query, matched.map((entry) => entry.fields), all);
    transactions = matched.map((entry) => entry.transaction);
  }
  return {
    policy: CASH_FLOW_INCLUSION_POLICY,
    knowledgeAt: current.knowledgeAt,
    period,
    previousPeriod,
    currencies: currencySummaries(current.totals, previous.totals, transferSummaries(current)),
    accounts: accountChanges(current.transactions),
    transactions: [...transactions].sort(newestFirst),
    transactionCount: current.transactions.length,
    search,
  };
}
