import type { CashFlowAmount, CashFlowCurrencyTotals } from "../canonical/cash-flow-inclusion.ts";
import { CASH_FLOW_INCLUSION_POLICY } from "../canonical/cash-flow-inclusion.ts";
import { isInstitutionKey, institutionNames } from "../../lib/institutions/institutions.ts";
import { cashFlowCopy } from "../../lib/cash-flow/copy.ts";
import {
  CASH_FLOW_SEARCH_FIELDS,
  type CashFlowAccountChange,
  type CashFlowCurrencySummary,
  type CashFlowPageDto,
  type CashFlowPageRequest,
  type CashFlowPeriod,
  type CashFlowPeriodTotals,
  type CashFlowSearchField,
  type CashFlowSearchResult,
} from "../../lib/cash-flow/model.ts";
import { spendingCopy } from "../../lib/spending/copy.ts";
import {
  addExact,
  compareExact,
  exactToNumber,
  negateExact,
  normalizeExact,
  subtractExact,
  type ExactAmount,
} from "../../lib/shared-money/exact-money.ts";
import { readPGliteCashFlow, type CashFlowReportTransaction } from "./cash-flow.ts";
import { ISO_DATE, type PGliteSpendingReader } from "./spending-sql.ts";

/**
 * The Cash flow page (PRD #456, issue #460): one period's counted flow per
 * currency, compared with the period of the same length just before it, plus
 * the period's transactions. A search narrows the transactions here, in the
 * worker, and counts its matches across every period.
 */

const ZERO: ExactAmount = { coefficient: "0", scale: 0 };
const ALL_PERIODS = { startDate: "0001-01-01", endDate: "9999-12-31" } as const;
const MAX_QUERY_LENGTH = 200;
const LOCALES = ["zh-TW", "en"] as const;
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

/** `2,370`, `NT$300` or `-300.5` as an exact amount; null when the query is not an amount. */
export function amountQuery(query: string): ExactAmount | null {
  const text = query.replace(/[\s,]/gu, "").replace(/^[+\-−]/u, "").replace(/^(?:NT\$|TWD|\$)/iu, "");
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? "";
  return normalizeExact({ coefficient: BigInt(`${match[1]}${fraction}`).toString(), scale: fraction.length });
}

const institutionLabels = LOCALES.map((locale) => institutionNames(locale));

function categoryLabels(transaction: CashFlowReportTransaction): string[] {
  const flow = transaction.cashFlow;
  return LOCALES.flatMap((locale) => {
    const cash = cashFlowCopy[locale].cashFlow;
    const spending = spendingCopy[locale].spending;
    switch (flow.class) {
      case "inflow":
        return [cash.inflowGroups[flow.group]];
      case "not_counted":
        return [cash.notCounted[flow.reason]];
      case "unresolved":
        return [cash.unresolvedTag];
      case "outflow":
      case "refund":
        return [
          ...(flow.class === "refund" ? [cash.refund] : []),
          ...flow.categories.flatMap((share) => share.category === null
            ? [cash.unclassified]
            : [spending.categoryGroups[share.group], spending.personalCategories[share.category]]),
        ];
    }
  });
}

function accountLabels(transaction: CashFlowReportTransaction): string[] {
  const account = transaction.details.account;
  const key = account.institutionKey;
  return [
    ...(key !== null && isInstitutionKey(key) ? institutionLabels.map((names) => names[key]) : []),
    account.mask,
    account.name,
  ].filter((value): value is string => typeof value === "string");
}

/**
 * The fields a transaction matches: a case-insensitive substring of its text
 * fields, and for an amount query, the exact amount.
 */
export function cashFlowMatches(transaction: CashFlowReportTransaction, query: string): readonly CashFlowSearchField[] {
  const needle = query.toLocaleLowerCase();
  const has = (values: readonly (string | null)[]) => values.some((value) => value !== null && value.toLocaleLowerCase().includes(needle));
  const amount = amountQuery(query);
  const matched: Record<CashFlowSearchField, boolean> = {
    description: has([transaction.details.description]),
    counterparty: has([transaction.details.counterparty]),
    category: has(categoryLabels(transaction)),
    account: has(accountLabels(transaction)),
    amount: amount !== null && compareExact(normalizeExact(transaction.amount), amount) === 0,
    note: has([transaction.details.note]),
  };
  return CASH_FLOW_SEARCH_FIELDS.filter((field) => matched[field]);
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

function currencySummaries(current: readonly CashFlowCurrencyTotals[], previous: readonly CashFlowCurrencyTotals[]): CashFlowCurrencySummary[] {
  const previousOf = new Map(previous.map((totals) => [totals.currency, totals]));
  return [...current]
    .sort((left, right) => Number(right.currency === "TWD") - Number(left.currency === "TWD") || left.currency.localeCompare(right.currency))
    .map((totals) => {
      const before = previousOf.get(totals.currency);
      const previousGroup = new Map(before?.outflow.groups.map((group) => [group.group, group.amount]) ?? []);
      const { kept, keptRatio } = periodTotals(totals);
      const transfers = totals.notCounted.find((entry) => entry.reason === "transfer");
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
        transfers: transfers ? { amount: transfers.amount, count: transfers.count } : EMPTY_AMOUNT,
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
  allMatches: readonly CashFlowReportTransaction[],
): CashFlowSearchResult {
  const fields = Object.fromEntries(CASH_FLOW_SEARCH_FIELDS.map((field) => [field, 0])) as Record<CashFlowSearchField, number>;
  for (const matched of inPeriod) for (const field of matched) fields[field] += 1;
  const dates = allMatches.map((transaction) => transaction.date).sort();
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
    const all = await readPGliteCashFlow(reader, ALL_PERIODS);
    search = searchResult(query, matched.map((entry) => entry.fields), all.transactions.filter((transaction) => cashFlowMatches(transaction, query).length > 0));
    transactions = matched.map((entry) => entry.transaction);
  }
  return {
    policy: CASH_FLOW_INCLUSION_POLICY,
    knowledgeAt: current.knowledgeAt,
    period,
    previousPeriod,
    currencies: currencySummaries(current.totals, previous.totals),
    accounts: accountChanges(current.transactions),
    transactions: [...transactions].sort(newestFirst),
    transactionCount: current.transactions.length,
    search,
  };
}
