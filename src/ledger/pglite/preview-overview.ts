import { institutionNames } from "../../lib/institutions/institutions.ts";
import { totalIncomplete } from "../../lib/shared-ledger/preview-account.ts";
import type {
  AccountRowDto,
  CurrencyAmountDto,
  DailyHistoryRowDto,
  PreviewCreditDto,
  SummaryMetricDto,
} from "../../lib/shared-ledger/types.ts";
import { addExact, decimalToExact, type ExactAmount } from "../../lib/shared-money/exact.ts";
import { indexExchangeRates, rateOnOrBefore } from "../../lib/shared-money/exchange-rates.ts";
import type { ExchangeRateRecord } from "../exchange-rates.ts";
import type { PGliteDailyHistory } from "./daily-history.ts";
import { exactAmountToNumber } from "./overview-amount.ts";
import type { PreviewCreditBalanceHistory } from "./preview-credit.ts";
import type {
  PreviewAccountView,
  PreviewBalanceHistory,
  PreviewCreditAccountView,
  PreviewPurchaseView,
  PreviewStatementView,
  PreviewTransactionView,
} from "./preview-financial-data.ts";

export type PreviewBalancePoint = Readonly<{ date: string; currency: string; exact: ExactAmount }>;

export type PreviewBalanceSeries = Readonly<{
  accountId: string;
  label: string;
  side: "asset" | "liability";
  /** From this date on the account counts toward nothing (Preview Time Deposit Closure). */
  closedOn: string | null;
  points: readonly PreviewBalancePoint[];
}>;

export type PreviewCountable = (currency: string, date: string) => boolean;

const INSTITUTION_NAMES = institutionNames("en");
const CURRENCY_ORDER = ["TWD", "USD", "JPY"];

export function previewRowId(previewAccountId: string): string {
  return `preview:${previewAccountId}`;
}

export function exactFromDecimal(amount: string): ExactAmount {
  const [whole, fraction = ""] = amount.replace(/^\+/u, "").split(".");
  return { coefficient: BigInt(`${whole}${fraction}`).toString(), scale: fraction.length };
}

function amountLine(currency: string, exact: ExactAmount): CurrencyAmountDto {
  return { currency, value: exactAmountToNumber(exact), exact: { ...exact } };
}

export function previewAccountRow(
  view: PreviewAccountView,
  transactions: readonly PreviewTransactionView[],
): AccountRowDto {
  const foreign = view.currency !== "TWD";
  const closed = view.timeDeposit?.closedAt !== null && view.timeDeposit?.closedAt !== undefined;
  const balance = closed ? null : view.latestBalance;
  const timeDeposit = view.product === "time_deposit";
  return {
    id: previewRowId(view.previewAccountId),
    label: view.displayLabel,
    institution: INSTITUTION_NAMES[view.institution],
    institutionKey: view.institution,
    product: timeDeposit ? "Time deposit" : foreign ? "Foreign currency account" : "Bank account",
    group: "asset",
    kind: foreign ? "foreign" : "bank",
    typeLabel: foreign ? "Foreign" : "Bank",
    amountLines: balance ? [amountLine(balance.currency, exactFromDecimal(balance.amount))] : [],
    transactionCount: transactions.length,
    assetPositionCount: 0,
    lastUpdated: balance ? balance.observedAt.at.slice(0, 10) : null,
    valueAvailability: balance ? "available" : closed ? "unavailable" : "awaiting",
    preview: {
      sourceId: view.sourceId,
      product: view.product,
      lastCollectedAt: view.lastCollectedAt,
      balanceTime: balance ? { ...balance.observedAt } : null,
      transactions: transactions.map((row) => ({
        amount: row.amount,
        currency: row.currency,
        direction: row.direction,
        postedAt: { ...row.postedAt },
        description: row.description,
      })),
      ...(view.timeDeposit ? { timeDeposit: { ...view.timeDeposit } } : {}),
    },
  };
}

/**
 * A preview credit account is a liability. An unknown used credit leaves the
 * amount lines empty and marks the row unavailable, so no total can read it
 * as zero.
 */
export function previewCreditAccountRow(
  view: PreviewCreditAccountView,
  purchases: readonly PreviewPurchaseView[],
  statements: readonly PreviewStatementView[],
): AccountRowDto {
  const balance = view.latestBalance;
  const credit: PreviewCreditDto = {
    creditLimit: view.creditLimit,
    usedCredit: balance ? { amount: balance.amount, currency: balance.currency, basis: { ...balance.basis } } : null,
    cards: view.cards.map((card) => ({ ...card })),
    purchases: purchases.map((row) => ({
      sourceRowKey: row.sourceRowKey,
      amount: row.amount,
      currency: row.currency,
      direction: row.direction,
      posting: { ...row.posting },
      consumedAt: { ...row.consumedAt },
      authorizedAt: row.authorizedAt ? { ...row.authorizedAt } : null,
      sourceCardKey: row.sourceCardKey,
      statementKey: row.statementKey,
      description: row.description,
    })),
    statements: statements.map((statement) => ({
      statementKey: statement.statementKey,
      billingPeriod: statement.billingPeriod,
      cycleStart: statement.cycleStart,
      cycleEnd: statement.cycleEnd,
      closingDate: statement.closingDate,
      dueDate: statement.dueDate,
      amount: statement.amount,
      currency: statement.currency,
      minimumPayment: statement.minimumPayment,
      paidAmount: statement.paidAmount,
      paid: statement.paid,
      noPaymentNeeded: statement.noPaymentNeeded,
    })),
  };
  return {
    id: previewRowId(view.previewAccountId),
    label: view.displayLabel,
    institution: INSTITUTION_NAMES[view.institution],
    institutionKey: view.institution,
    product: "Credit card",
    group: "liability",
    kind: "credit-card",
    typeLabel: "Credit card",
    amountLines: balance ? [amountLine(balance.currency, exactFromDecimal(balance.amount))] : [],
    transactionCount: purchases.length,
    assetPositionCount: 0,
    lastUpdated: balance ? balance.observedAt.at.slice(0, 10) : null,
    valueAvailability: balance ? "available" : "unavailable",
    preview: {
      sourceId: view.sourceId,
      product: "credit_card",
      lastCollectedAt: view.lastCollectedAt,
      balanceTime: balance ? { ...balance.observedAt } : null,
      transactions: [],
      credit,
    },
  };
}

export type PreviewSummaryMarkers = Readonly<{
  assets: Pick<SummaryMetricDto, "includesPreview">;
  liabilities: Pick<SummaryMetricDto, "includesPreview" | "incomplete">;
  net: Pick<SummaryMetricDto, "includesPreview" | "incomplete">;
}>;

export function previewSummaryMarkers(accounts: readonly AccountRowDto[]): PreviewSummaryMarkers {
  const counted = (group: AccountRowDto["group"][]) => accounts.some((account) =>
    account.preview && group.includes(account.group) && account.amountLines.length > 0);
  const incomplete = totalIncomplete(accounts);
  const assets = counted(["asset", "investment"]);
  const liabilities = counted(["liability"]);
  return {
    assets: assets ? { includesPreview: true } : {},
    liabilities: { ...(liabilities ? { includesPreview: true } : {}), ...(incomplete ? { incomplete: true } : {}) },
    net: { ...(assets || liabilities ? { includesPreview: true } : {}), ...(incomplete ? { incomplete: true } : {}) },
  };
}

function pointsByDate(observations: readonly Readonly<{ amount: string; currency: string; observedAt: Readonly<{ at: string }> }>[]): PreviewBalancePoint[] {
  const sorted = [...observations].sort((left, right) => Date.parse(left.observedAt.at) - Date.parse(right.observedAt.at));
  const byDate = new Map<string, PreviewBalancePoint>();
  for (const observation of sorted) {
    const date = observation.observedAt.at.slice(0, 10);
    byDate.set(date, { date, currency: observation.currency, exact: exactFromDecimal(observation.amount) });
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export function previewBalanceSeries(histories: readonly PreviewBalanceHistory[]): PreviewBalanceSeries[] {
  return histories.map((history) => {
    const current = history.observations.filter((observation) => observation.kind === "current");
    return {
      accountId: previewRowId(history.previewAccountId),
      label: history.displayLabel,
      side: "asset",
      closedOn: history.closedAt === null ? null : history.closedAt.slice(0, 10),
      points: pointsByDate(current.length > 0 ? current : history.observations),
    };
  });
}

export function previewCreditSeries(histories: readonly PreviewCreditBalanceHistory[]): PreviewBalanceSeries[] {
  return histories.map((history) => ({
    accountId: previewRowId(history.previewAccountId),
    label: history.displayLabel,
    side: "liability",
    closedOn: null,
    points: pointsByDate(history.observations),
  }));
}

export function countableWithRates(rates: readonly ExchangeRateRecord[]): PreviewCountable {
  const index = indexExchangeRates(rates);
  return (currency, date) => rateOnOrBefore(index, currency, date) !== null;
}

type Buckets = Map<string, ExactAmount>;

function buckets(lines: readonly CurrencyAmountDto[] | undefined): Buckets {
  const result: Buckets = new Map();
  for (const line of lines ?? []) {
    const exact = line.exact ?? decimalToExact(line.value);
    if (exact) result.set(line.currency, exact);
  }
  return result;
}

const negate = (exact: ExactAmount): ExactAmount => ({ coefficient: (-BigInt(exact.coefficient)).toString(), scale: exact.scale });

function add(target: Buckets, currency: string, exact: ExactAmount): void {
  const current = target.get(currency);
  target.set(currency, current ? addExact(current, exact) : exact);
}

function difference(current: Buckets, previous: Buckets): Buckets {
  const result: Buckets = new Map(current);
  for (const [currency, exact] of previous) add(result, currency, negate(exact));
  return result;
}

function lines(bucket: Buckets): CurrencyAmountDto[] {
  return [...bucket.entries()]
    .filter(([, exact]) => BigInt(exact.coefficient) !== 0n)
    .sort(([left], [right]) => {
      const leftIndex = CURRENCY_ORDER.indexOf(left);
      const rightIndex = CURRENCY_ORDER.indexOf(right);
      return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex) || left.localeCompare(right);
    })
    .map(([currency, exact]) => amountLine(currency, exact));
}

function latestOnOrBefore(series: PreviewBalanceSeries, date: string): PreviewBalancePoint | undefined {
  if (series.closedOn !== null && date >= series.closedOn) return undefined;
  return series.points.findLast((point) => point.date <= date);
}

export function withPreviewHistory(
  history: PGliteDailyHistory,
  series: readonly PreviewBalanceSeries[],
  countable: PreviewCountable,
): PGliteDailyHistory {
  if (series.length === 0) return history;
  const canonical = [...history.dailyHistory].sort((left, right) => left.date.localeCompare(right.date));
  const dates = [...new Set([
    ...canonical.map((row) => row.date),
    ...series.flatMap((account) => [
      ...account.points.map((point) => point.date),
      ...(account.closedOn === null ? [] : [account.closedOn]),
    ]),
  ])].sort();
  const rows: DailyHistoryRowDto[] = [];
  let baseIndex = -1;
  let previousNet: Buckets | null = null;
  for (const date of dates) {
    while (baseIndex + 1 < canonical.length && canonical[baseIndex + 1]!.date <= date) baseIndex += 1;
    const base = baseIndex >= 0 ? canonical[baseIndex]! : null;
    const assets = buckets(base?.assets);
    const liabilities = buckets(base?.liabilities);
    const net = buckets(base?.netAssets);
    const observed: string[] = [];
    let includesPreview = false;
    for (const account of series) {
      const point = latestOnOrBefore(account, date);
      if (!point) continue;
      if (point.date === date) observed.push(account.label);
      if (!countable(point.currency, date)) continue;
      if (account.side === "asset") {
        add(assets, point.currency, point.exact);
        add(net, point.currency, point.exact);
      } else {
        add(liabilities, point.currency, point.exact);
        add(net, point.currency, negate(point.exact));
      }
      includesPreview = true;
    }
    const sameDay = base !== null && base.date === date ? base : null;
    rows.push({
      ...sameDay,
      date,
      netAssets: lines(net),
      dailyChange: previousNet ? lines(difference(net, previousNet)) : [],
      assets: lines(assets),
      liabilities: lines(liabilities),
      accountChanges: [...(sameDay?.accountChanges ?? []), ...observed],
      positionCount: base?.positionCount ?? 0,
      ...(includesPreview ? { includesPreview: true } : {}),
    });
    previousNet = net;
  }
  const dailyHistoryByAccount = { ...history.dailyHistoryByAccount };
  for (const account of series) {
    const sign = account.side === "asset" ? 1 : -1;
    dailyHistoryByAccount[account.accountId] = account.points.map((point) => ({
      date: point.date,
      netAssets: [amountLine(point.currency, sign === 1 ? point.exact : negate(point.exact))],
      dailyChange: [],
      assets: account.side === "asset" ? [amountLine(point.currency, point.exact)] : [],
      liabilities: account.side === "liability" ? [amountLine(point.currency, point.exact)] : [],
      accountChanges: [account.label],
      positionCount: 0,
      includesPreview: true,
    }));
  }
  return { dailyHistory: rows, dailyHistoryByAccount };
}
