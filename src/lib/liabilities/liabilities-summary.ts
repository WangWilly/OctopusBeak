import type { AccountRowDto, CreditCardStatementDto, CurrencyAmountDto } from "../shared-ledger/types.ts";
import { convertToTwd, indexExchangeRates, rateOnOrBefore, type ExchangeRateIndex } from "../shared-money/exchange-rates.ts";
import {
  accountLedger,
  accountShares,
  daysBetween,
  readLiabilityAllocation,
  TRAILING_DAYS,
  trailingChange,
  valuationDateFor,
  type SpanChange,
} from "../shared-ledger/twd-valuation.ts";
import type { LiabilitiesPageDto } from "./types.ts";

export type LiabilitiesSummaryInput = Pick<
  LiabilitiesPageDto,
  "accounts" | "dailyHistory" | "dailyHistoryByAccount" | "exchangeRates"
>;

/**
 * What the user owes next. A `statement` is an issued credit-card bill whose
 * due date has not passed. A `card-estimate` is the estimated credit in use on
 * a card with no such bill; it has no due date because none was issued.
 */
export type UpcomingPayment =
  | {
    kind: "statement";
    account: AccountRowDto;
    dueDate: string;
    daysUntil: number;
    amount: CurrencyAmountDto;
    /** Share of all listed payments in TWD; null without a rate. */
    share: number | null;
  }
  | {
    kind: "card-estimate";
    account: AccountRowDto;
    amount: CurrencyAmountDto;
    share: number | null;
  };

/** Credit in use against the limits of the cards that report one, in TWD. */
export type CardUtilization = { used: number; limit: number; ratio: number };

export type LiabilitiesSummary =
  | { state: "empty" }
  | {
    state: "ready";
    total: number;
    accountCount: number;
    valuationDate: string;
    /** The change in what is owed: positive means more debt. */
    trailing: SpanChange | null;
    payments: UpcomingPayment[];
    utilization: CardUtilization | null;
    unconvertedCurrencies: string[];
    shares: ReadonlyMap<string, number>;
  };

const MAX_PAYMENTS = 3;

export function readLiabilitiesSummary(input: LiabilitiesSummaryInput, options: { today: string }): LiabilitiesSummary {
  const valuationDate = valuationDateFor(input.dailyHistory, input.accounts, options.today);
  if (input.accounts.length === 0 || !valuationDate) return { state: "empty" };
  const rates = indexExchangeRates(input.exchangeRates);
  const allocation = readLiabilityAllocation(input.accounts, rates, valuationDate, 0);
  const ownIds = new Set(input.accounts.map((account) => account.id));
  const ledger = accountLedger(
    Object.fromEntries(Object.entries(input.dailyHistoryByAccount).filter(([id]) => ownIds.has(id))),
    rates,
  );
  const dates = input.dailyHistory
    .filter((row) => convertToTwd(row.liabilities, row.date, rates))
    .map((row) => row.date)
    .sort();
  const netChange = trailingChange(dates, ledger, TRAILING_DAYS);
  return {
    state: "ready",
    total: allocation.total,
    accountCount: input.accounts.length,
    valuationDate,
    trailing: netChange && {
      ...netChange,
      change: -netChange.change,
      pct: netChange.pct === null ? null : -netChange.pct,
    },
    payments: upcomingPayments(input.accounts, rates, valuationDate, options.today),
    utilization: cardUtilization(input.accounts, rates, valuationDate),
    unconvertedCurrencies: allocation.unconvertedCurrencies,
    shares: accountShares(input.accounts, rates, valuationDate),
  };
}

function upcomingPayments(
  accounts: readonly AccountRowDto[],
  rates: ExchangeRateIndex,
  valuationDate: string,
  today: string,
): UpcomingPayment[] {
  const bills: Omit<Extract<UpcomingPayment, { kind: "statement" }>, "share">[] = [];
  const estimates: Omit<Extract<UpcomingPayment, { kind: "card-estimate" }>, "share">[] = [];
  for (const account of accounts) {
    if (!account.creditCard) continue;
    const next = currentStatements(account.creditCard.statements)
      .filter((statement) => statement.dueDate >= today && statement.statementBalance.value > 0)
      .sort((left, right) => left.dueDate.localeCompare(right.dueDate))[0];
    if (next) {
      bills.push({
        kind: "statement",
        account,
        dueDate: next.dueDate,
        daysUntil: daysBetween(today, next.dueDate),
        amount: next.statementBalance,
      });
      continue;
    }
    const used = account.creditCard.currentUsedCredit?.amount;
    if (used && used.value > 0) estimates.push({ kind: "card-estimate", account, amount: used });
  }
  bills.sort((left, right) => left.dueDate.localeCompare(right.dueDate));
  estimates.sort((left, right) => right.amount.value - left.amount.value);
  const listed = [...bills, ...estimates].slice(0, MAX_PAYMENTS);
  const twd = listed.map((payment) => convertToTwd([payment.amount], valuationDate, rates)?.value ?? null);
  const total = twd.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return listed.map((payment, index) => ({
    ...payment,
    share: twd[index] === null || total <= 0 ? null : twd[index]! / total,
  }) as UpcomingPayment);
}

/** A reissued statement keeps its key; only its newest revision counts. */
function currentStatements(statements: readonly CreditCardStatementDto[]): CreditCardStatementDto[] {
  const byKey = new Map<string, CreditCardStatementDto>();
  for (const statement of statements) {
    const current = byKey.get(statement.statementKey);
    if (!current || statement.revisionNumber > current.revisionNumber) byKey.set(statement.statementKey, statement);
  }
  return [...byKey.values()];
}

function cardUtilization(
  accounts: readonly AccountRowDto[],
  rates: ExchangeRateIndex,
  valuationDate: string,
): CardUtilization | null {
  let used = 0;
  let limit = 0;
  for (const account of accounts) {
    const balance = account.creditCard?.currentUsedCredit;
    if (!balance?.componentLimit) continue;
    const rate = rateOnOrBefore(rates, balance.amount.currency, valuationDate);
    const cardLimit = exactNumber(balance.componentLimit);
    if (!rate || cardLimit <= 0) continue;
    used += balance.amount.value * rate.twdPerUnit;
    limit += cardLimit * rate.twdPerUnit;
  }
  return limit > 0 ? { used, limit, ratio: used / limit } : null;
}

function exactNumber(exact: { coefficient: string; scale: number }): number {
  return Number(exact.coefficient) / 10 ** exact.scale;
}
