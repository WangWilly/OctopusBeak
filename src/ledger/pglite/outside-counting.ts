import { totalIncomplete } from "../../lib/shared-ledger/preview-account.ts";
import { accountOrigin, mergeProvenance, NO_PROVENANCE, originProvenance, withOrigin } from "../../lib/shared-ledger/provenance.ts";
import type { AccountRowDto, CurrencyAmountDto, DailyHistoryRowDto, SummaryMetricDto } from "../../lib/shared-ledger/types.ts";
import { addExact, decimalToExact, type ExactAmount } from "../../lib/shared-money/exact-money.ts";
import { indexExchangeRates, rateOnOrBefore } from "../../lib/shared-money/exchange-rates.ts";
import type { ExchangeRateRecord } from "../exchange-rates.ts";
import type { PGliteDailyHistory } from "./daily-history.ts";
import { amountLine, type BalancePoint, type BalanceSeries } from "./outside-row.ts";

/** How Outside financial data counts toward the Financial pages' totals, markers and history. */

export type RateCountable = (currency: string, date: string) => boolean;

const CURRENCY_ORDER = ["TWD", "USD", "JPY"];

export type SummaryMarker = Pick<SummaryMetricDto, "provenance" | "incomplete">;

export type SummaryMarkers = Readonly<{
  assets: SummaryMarker;
  liabilities: SummaryMarker;
  net: SummaryMarker;
}>;

/** The origins and completeness of the summary's per-currency totals, which count every row with an amount. */
export function summaryMarkers(accounts: readonly AccountRowDto[]): SummaryMarkers {
  let assets = NO_PROVENANCE;
  let liabilities = NO_PROVENANCE;
  for (const account of accounts) {
    if (account.amountLines.length === 0) continue;
    if (account.group === "liability") liabilities = withOrigin(liabilities, accountOrigin(account));
    else assets = withOrigin(assets, accountOrigin(account));
  }
  const incomplete = totalIncomplete(accounts) ? { incomplete: true } : {};
  return {
    assets: { provenance: assets },
    liabilities: { provenance: liabilities, ...incomplete },
    net: { provenance: mergeProvenance(assets, liabilities), ...incomplete },
  };
}

export function countableWithRates(rates: readonly ExchangeRateRecord[]): RateCountable {
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

function latestOnOrBefore(series: BalanceSeries, date: string): BalancePoint | undefined {
  if (series.closedOn !== null && date >= series.closedOn) return undefined;
  return series.points.findLast((point) => point.date <= date);
}

export function withBalanceSeriesHistory(
  history: PGliteDailyHistory,
  series: readonly BalanceSeries[],
  countable: RateCountable,
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
    let provenance = NO_PROVENANCE;
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
      provenance = withOrigin(provenance, account.marker);
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
      provenance,
    });
    previousNet = net;
  }
  const dailyHistoryByAccount = { ...history.dailyHistoryByAccount };
  for (const account of series) {
    const sign = account.side === "asset" ? 1 : -1;
    const open = account.points.filter((point) => account.closedOn === null || point.date < account.closedOn);
    const last = open.at(-1);
    // A closed account drops to zero on its close date, so a carried-forward value or a change across the close sees it leave.
    const points = last && account.closedOn !== null
      ? [...open, { date: account.closedOn, currency: last.currency, exact: { coefficient: "0", scale: 0 } }]
      : open;
    dailyHistoryByAccount[account.accountId] = points.map((point) => ({
      date: point.date,
      netAssets: [amountLine(point.currency, sign === 1 ? point.exact : negate(point.exact))],
      dailyChange: [],
      assets: account.side === "asset" ? [amountLine(point.currency, point.exact)] : [],
      liabilities: account.side === "liability" ? [amountLine(point.currency, point.exact)] : [],
      accountChanges: [account.label],
      positionCount: 0,
      provenance: originProvenance(account.marker),
    }));
  }
  return { dailyHistory: rows, dailyHistoryByAccount };
}
