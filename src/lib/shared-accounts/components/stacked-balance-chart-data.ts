import { historyPointKey, type AccountKind, type AccountRowDto, type DailyHistoryRowDto } from "../../shared-ledger/types.ts";

export type BalanceChartMode = "asset" | "liability";
export type BalanceChartFilter = AccountKind | "all";

export type StackedBalancePoint = {
  date: string;
  dateLabel: string;
  time: number;
  value: number;
};

export type StackedBalanceSeries = {
  key: string;
  label: string;
  color: string;
  data: StackedBalancePoint[];
};

export type StackedBalanceChartData = {
  dates: string[];
  series: StackedBalanceSeries[];
  totals: StackedBalancePoint[];
  signature: string;
};

const STACK_COLORS = [
  "oklch(52% 0.11 250)",
  "oklch(52% 0.09 170)",
  "oklch(56% 0.1 70)",
  "oklch(53% 0.08 320)",
  "oklch(50% 0.07 35)",
  "oklch(49% 0.06 215)",
  "oklch(50% 0.05 285)",
  "oklch(46% 0.035 250)",
];
const ASSET_KIND_ORDER: AccountKind[] = ["bank", "fund", "brokerage", "crypto", "foreign"];
const LIABILITY_KIND_ORDER: AccountKind[] = ["credit-card", "loan", "crypto", "other"];
const EPSILON = 0.000001;

export function buildStackedBalanceChartData(options: {
  accounts: AccountRowDto[];
  dailyHistoryByAccount: Record<string, DailyHistoryRowDto[]>;
  filter: BalanceChartFilter;
  currency: string;
  mode: BalanceChartMode;
  limit?: number;
}): StackedBalanceChartData {
  const limit = options.limit ?? 30;
  const accounts = options.accounts.filter(
    (account) =>
      isAccountInMode(account, options.mode) &&
      (options.filter === "all" || account.kind === options.filter),
  );
  const dates = collectDates(accounts, options.dailyHistoryByAccount).slice(-limit);
  const times = uniqueTimes(dates);
  const groups = options.filter === "all"
    ? groupByKind(accounts, options.mode)
    : accounts.map((account) => ({ key: account.id, label: account.label, accounts: [account] }));
  const series = groups
    .map((group, index) => {
      const data = dates.map((date, index) => ({
        date,
        dateLabel: pointLabel(date),
        time: times[index]!,
        value: sumForDate(group.accounts, options.dailyHistoryByAccount, date, options.currency, options.mode),
      }));
      return {
        key: group.key,
        label: group.label,
        color: STACK_COLORS[index % STACK_COLORS.length],
        data,
      };
    })
    .filter((item) => item.data.some((point) => Math.abs(point.value) > EPSILON));
  const totals = dates.map((date, index) => ({
    date,
    dateLabel: pointLabel(date),
    time: times[index]!,
    value: series.reduce((sum, item) => sum + (item.data[index]?.value ?? 0), 0),
  }));

  return {
    dates,
    series,
    totals,
    signature: `${options.mode}:${options.filter}:${options.currency}:${series.map((item) => item.key).join("|")}:${dates.join("|")}`,
  };
}

export function selectStackedBalanceChartSeries(
  chart: StackedBalanceChartData,
  selectedKeys: string[],
): StackedBalanceChartData {
  const selected = new Set(selectedKeys);
  const series = selected.size === 0
    ? chart.series
    : chart.series.filter((item) => selected.has(item.key));
  const visibleSeries = series.length > 0 ? series : chart.series;
  const totals = chart.totals.map((point, index) => ({
    ...point,
    value: visibleSeries.reduce((sum, item) => sum + (item.data[index]?.value ?? 0), 0),
  }));

  return {
    ...chart,
    series: visibleSeries,
    totals,
    signature: `${chart.signature}:selected:${visibleSeries.map((item) => item.key).join("|")}`,
  };
}

function collectDates(
  accounts: AccountRowDto[],
  dailyHistoryByAccount: Record<string, DailyHistoryRowDto[]>,
) {
  return [
    ...new Set(accounts.flatMap((account) => (dailyHistoryByAccount[account.id] ?? []).map(historyPointKey))),
  ].sort((left, right) => left.localeCompare(right));
}

function groupByKind(accounts: AccountRowDto[], mode: BalanceChartMode) {
  const order = mode === "asset" ? ASSET_KIND_ORDER : LIABILITY_KIND_ORDER;
  return order
    .map((kind) => ({
      key: kind,
      label: labelForKind(kind),
      accounts: accounts.filter((account) => account.kind === kind),
    }))
    .filter((group) => group.accounts.length > 0);
}

function labelForKind(kind: AccountKind) {
  return kind
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function dateTime(date: string) {
  const pointAt = date.split("|", 1)[0] ?? date;
  return Date.parse(pointAt.length > 10 ? pointAt : `${pointAt}T00:00:00.000Z`);
}

function uniqueTimes(dates: string[]) {
  const offsets = new Map<number, number>();
  return dates.map((date) => {
    const baseTime = dateTime(date);
    const offset = offsets.get(baseTime) ?? 0;
    offsets.set(baseTime, offset + 1);
    return baseTime + offset;
  });
}

function pointLabel(date: string) {
  const pointAt = date.split("|", 1)[0] ?? date;
  return pointAt.length > 10 ? pointAt.slice(0, 16).replace("T", " ") : pointAt;
}

function isAccountInMode(account: AccountRowDto, mode: BalanceChartMode) {
  return mode === "liability" ? account.group === "liability" : account.group !== "liability";
}

function sumForDate(
  accounts: AccountRowDto[],
  dailyHistoryByAccount: Record<string, DailyHistoryRowDto[]>,
  date: string,
  currency: string,
  mode: BalanceChartMode,
) {
  return accounts.reduce((sum, account) => {
    const row = (dailyHistoryByAccount[account.id] ?? []).find((item) => historyPointKey(item) === date);
    const value = row?.[mode === "asset" ? "assets" : "liabilities"].find((amount) => amount.currency === currency)?.value ?? 0;
    return sum + (mode === "liability" ? Math.abs(value) : value);
  }, 0);
}
