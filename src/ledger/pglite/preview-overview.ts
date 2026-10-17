import { institutionNames } from "../../lib/institutions/institutions.ts";
import type { AccountRowDto, CurrencyAmountDto, DailyHistoryRowDto } from "../../lib/shared-ledger/types.ts";
import { addExact, decimalToExact, type ExactAmount } from "../../lib/shared-money/exact.ts";
import { indexExchangeRates, rateOnOrBefore } from "../../lib/shared-money/exchange-rates.ts";
import type { ExchangeRateRecord } from "../exchange-rates.ts";
import type { PGliteDailyHistory } from "./daily-history.ts";
import { exactAmountToNumber } from "./overview-amount.ts";
import type {
  PreviewAccountView,
  PreviewBalanceHistory,
  PreviewTransactionView,
} from "./preview-financial-data.ts";

export type PreviewBalancePoint = Readonly<{ date: string; currency: string; exact: ExactAmount }>;

export type PreviewBalanceSeries = Readonly<{
  accountId: string;
  label: string;
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
  const balance = view.latestBalance;
  return {
    id: previewRowId(view.previewAccountId),
    label: view.displayLabel,
    institution: INSTITUTION_NAMES[view.institution],
    institutionKey: view.institution,
    product: foreign ? "Foreign currency account" : "Bank account",
    group: "asset",
    kind: foreign ? "foreign" : "bank",
    typeLabel: foreign ? "Foreign" : "Bank",
    amountLines: balance ? [amountLine(balance.currency, exactFromDecimal(balance.amount))] : [],
    transactionCount: transactions.length,
    assetPositionCount: 0,
    lastUpdated: balance ? balance.observedAt.at.slice(0, 10) : null,
    valueAvailability: balance ? "available" : "awaiting",
    preview: {
      sourceId: view.sourceId,
      lastCollectedAt: view.lastCollectedAt,
      balanceTime: balance ? { ...balance.observedAt } : null,
      transactions: transactions.map((row) => ({
        amount: row.amount,
        currency: row.currency,
        direction: row.direction,
        postedAt: { ...row.postedAt },
        description: row.description,
      })),
    },
  };
}

export function previewBalanceSeries(histories: readonly PreviewBalanceHistory[]): PreviewBalanceSeries[] {
  return histories.map((history) => {
    const current = history.observations.filter((observation) => observation.kind === "current");
    const chosen = [...(current.length > 0 ? current : history.observations)]
      .sort((left, right) => Date.parse(left.observedAt.at) - Date.parse(right.observedAt.at));
    const byDate = new Map<string, PreviewBalancePoint>();
    for (const observation of chosen) {
      const date = observation.observedAt.at.slice(0, 10);
      byDate.set(date, { date, currency: observation.currency, exact: exactFromDecimal(observation.amount) });
    }
    return {
      accountId: previewRowId(history.previewAccountId),
      label: history.displayLabel,
      points: [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date)),
    };
  });
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

function add(target: Buckets, currency: string, exact: ExactAmount): void {
  const current = target.get(currency);
  target.set(currency, current ? addExact(current, exact) : exact);
}

function difference(current: Buckets, previous: Buckets): Buckets {
  const result: Buckets = new Map(current);
  for (const [currency, exact] of previous)
    add(result, currency, { coefficient: (-BigInt(exact.coefficient)).toString(), scale: exact.scale });
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

function latestOnOrBefore(points: readonly PreviewBalancePoint[], date: string): PreviewBalancePoint | undefined {
  return points.findLast((point) => point.date <= date);
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
    ...series.flatMap((account) => account.points.map((point) => point.date)),
  ])].sort();
  const rows: DailyHistoryRowDto[] = [];
  let baseIndex = -1;
  let previousNet: Buckets | null = null;
  for (const date of dates) {
    while (baseIndex + 1 < canonical.length && canonical[baseIndex + 1]!.date <= date) baseIndex += 1;
    const base = baseIndex >= 0 ? canonical[baseIndex]! : null;
    const assets = buckets(base?.assets);
    const net = buckets(base?.netAssets);
    const observed: string[] = [];
    let includesPreview = false;
    for (const account of series) {
      const point = latestOnOrBefore(account.points, date);
      if (!point) continue;
      if (point.date === date) observed.push(account.label);
      if (!countable(point.currency, date)) continue;
      add(assets, point.currency, point.exact);
      add(net, point.currency, point.exact);
      includesPreview = true;
    }
    const sameDay = base !== null && base.date === date ? base : null;
    rows.push({
      ...sameDay,
      date,
      netAssets: lines(net),
      dailyChange: previousNet ? lines(difference(net, previousNet)) : [],
      assets: lines(assets),
      liabilities: base?.liabilities.map((line) => ({ ...line })) ?? [],
      accountChanges: [...(sameDay?.accountChanges ?? []), ...observed],
      positionCount: base?.positionCount ?? 0,
      ...(includesPreview ? { includesPreview: true } : {}),
    });
    previousNet = net;
  }
  const dailyHistoryByAccount = { ...history.dailyHistoryByAccount };
  for (const account of series) {
    dailyHistoryByAccount[account.accountId] = account.points.map((point) => ({
      date: point.date,
      netAssets: [amountLine(point.currency, point.exact)],
      dailyChange: [],
      assets: [amountLine(point.currency, point.exact)],
      liabilities: [],
      accountChanges: [account.label],
      positionCount: 0,
      includesPreview: true,
    }));
  }
  return { dailyHistory: rows, dailyHistoryByAccount };
}
