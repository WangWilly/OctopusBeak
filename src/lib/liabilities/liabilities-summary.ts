import type { AccountRowDto, CreditCardStatementDto, CurrencyAmountDto } from "../shared-ledger/types.ts";
import { convertToTwd, rateOnOrBefore, type ExchangeRateIndex } from "../shared-money/exchange-rates.ts";
import { mergeProvenance, NO_PROVENANCE, type Provenance } from "../shared-ledger/provenance.ts";
import {
  accountShares,
  daysBetween,
  readLiabilityAllocation,
  type SpanChange,
  readSideValuation,
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
    /** The origins the total and its trailing change count. */
    provenance: Provenance;
  };

const MAX_PAYMENTS = 3;

export function readLiabilitiesSummary(input: LiabilitiesSummaryInput, options: { today: string }): LiabilitiesSummary {
  const side = readSideValuation(input, "liabilities", options.today);
  if (!side) return { state: "empty" };
  const { valuationDate, rates, trailing: netChange } = side;
  const allocation = readLiabilityAllocation(input.accounts, rates, valuationDate, 0);
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
    provenance: mergeProvenance(allocation.provenance, netChange?.provenance ?? NO_PROVENANCE),
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

/** The repaid share of principal for one currency: 1 − Σ outstanding ÷ Σ original. */
export type MortgageRepaidShare = Readonly<{
  currency: string;
  outstanding: number;
  original: number;
  repaid: number;
}>;

export type MortgageRepaid = Readonly<{
  /** One entry per currency with a countable mortgage; empty shows the tile's empty state. */
  shares: readonly MortgageRepaidShare[];
  /** Some open preview mortgages report no original amount, so the shares leave them out. */
  omitted: boolean;
}>;

/**
 * Only open preview loans the source itself labels as housing count. A
 * verified loan carries no category or original amount, so it never does.
 */
export function readMortgageRepaid(accounts: readonly AccountRowDto[]): MortgageRepaid {
  const sums = new Map<string, { outstanding: number; original: number }>();
  let omitted = false;
  for (const account of accounts) {
    const loan = account.preview?.loan;
    const owed = account.amountLines[0];
    if (!loan || loan.category !== "housing" || loan.closedAt !== null || !owed) continue;
    if (loan.originalAmount === null) {
      omitted = true;
      continue;
    }
    const sum = sums.get(loan.currency) ?? { outstanding: 0, original: 0 };
    sum.outstanding += owed.value;
    sum.original += Number(loan.originalAmount);
    sums.set(loan.currency, sum);
  }
  const shares = [...sums.entries()]
    .filter(([, sum]) => sum.original > 0)
    .sort(([left], [right]) => (left === "TWD" ? -1 : right === "TWD" ? 1 : left.localeCompare(right)))
    .map(([currency, sum]) => ({ currency, ...sum, repaid: 1 - sum.outstanding / sum.original }));
  return { shares, omitted };
}
