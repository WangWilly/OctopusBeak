import type {
  AccountRowDto,
  CreditCardStatementDto,
  DailyHistoryRowDto,
  TransactionRowDto,
} from "../shared-ledger/types.ts";
import { historyPointKey } from "../shared-ledger/types.ts";
import { latestStatementRevisions } from "./statement-list.ts";
import { addDays, transactionDay, type DateRange } from "./transaction-filters.ts";

/**
 * `ledger`: cash accounts, whose daily balance is worked back from today's
 * balance through their transactions. `card`: credit cards, read from their
 * statements. `snapshots`: everything else, read from recorded balances,
 * because cash movements alone do not explain an investment or loan value.
 */
export type HistoryKind = "ledger" | "card" | "snapshots";

export type HistoryEntry = {
  kind: "today" | "transaction" | "statement" | "snapshot";
  day: string;
  label: string | null;
  cycle: { start: string; end: string } | null;
  transactionCount: number | null;
  increase: number | null;
  decrease: number | null;
  balance: number;
  note: string | null;
};

export type HistoryPoint = { day: string; balance: number };

export type BalanceHistory = {
  kind: HistoryKind;
  /** Oldest first, for the chart. */
  points: HistoryPoint[];
  /** Newest first, for the table. */
  entries: HistoryEntry[];
  /** Whether recorded snapshots agree with the worked-back ledger; null when nothing to compare. */
  consistent: boolean | null;
};

export type HistoryStats =
  | { kind: "range"; net: number; high: HistoryPoint; low: HistoryPoint }
  | { kind: "card"; lastStatement: HistoryPoint; high: HistoryPoint; average: number };

type HistoryInput = {
  account: AccountRowDto;
  transactions: readonly TransactionRowDto[];
  dailyHistory: readonly DailyHistoryRowDto[];
  currency: string;
  range: DateRange;
  today: string;
  timeZone: string;
};

const MATCH_TOLERANCE = 0.5;

export function historyKind(account: Pick<AccountRowDto, "kind">): HistoryKind {
  if (account.kind === "bank" || account.kind === "foreign") return "ledger";
  if (account.kind === "credit-card") return "card";
  return "snapshots";
}

export function historyCurrencies(
  account: AccountRowDto,
  dailyHistory: readonly DailyHistoryRowDto[],
): string[] {
  const currencies = new Set(account.amountLines.map((amount) => amount.currency));
  for (const row of dailyHistory) for (const amount of row.netAssets) currencies.add(amount.currency);
  return [...currencies];
}

export function buildBalanceHistory(input: HistoryInput): BalanceHistory {
  const kind = historyKind(input.account);
  if (kind === "ledger") return ledgerHistory(input);
  if (kind === "card") return cardHistory(input);
  return snapshotHistory(input);
}

function entry(day: string, balance: number, change: number | null, extra: Partial<HistoryEntry> & Pick<HistoryEntry, "kind">): HistoryEntry {
  return {
    day,
    label: null,
    cycle: null,
    transactionCount: null,
    increase: change !== null && change > 0 ? change : null,
    decrease: change !== null && change < 0 ? -change : null,
    balance,
    note: null,
    ...extra,
  };
}

function currentBalance(account: AccountRowDto, currency: string): number {
  return account.amountLines.find((amount) => amount.currency === currency)?.value ?? 0;
}

function inRange(day: string, range: DateRange) {
  return day >= range.start && day <= range.end;
}

/** Each day's last recorded balance, on the side of the ledger the account sits. */
function recordedBalances(input: HistoryInput): Map<string, number> {
  const side = input.account.group === "liability" ? "liabilities" : "assets";
  const byDay = new Map<string, { key: string; balance: number }>();
  for (const row of input.dailyHistory) {
    const amount = row[side].find((item) => item.currency === input.currency)
      ?? row.netAssets.find((item) => item.currency === input.currency);
    if (!amount) continue;
    const key = historyPointKey(row);
    const current = byDay.get(row.date);
    if (!current || key > current.key) byDay.set(row.date, { key, balance: Math.abs(amount.value) });
  }
  return new Map([...byDay].map(([day, { balance }]) => [day, balance]));
}

function ledgerHistory(input: HistoryInput): BalanceHistory {
  const { range, today, timeZone } = input;
  const transactions = input.transactions
    .filter((row) => row.currency === input.currency)
    .map((row) => ({ row, day: transactionDay(row, timeZone) }))
    .filter(({ day }) => day <= today)
    .sort((left, right) => right.day.localeCompare(left.day));
  const balance = currentBalance(input.account, input.currency);

  const entries: HistoryEntry[] = [];
  if (inRange(today, range)) entries.push(entry(today, balance, null, { kind: "today" }));
  let after = balance;
  for (const { row, day } of transactions) {
    if (inRange(day, range)) {
      entries.push(entry(day, after, row.amount, { kind: "transaction", label: row.label, note: row.note }));
    }
    after -= row.amount;
  }

  // End-of-day balance: today's balance less everything that happened after that day.
  const endOfDay = (day: string) =>
    balance - transactions.filter((item) => item.day > day).reduce((sum, item) => sum + item.row.amount, 0);
  const lastDay = range.end < today ? range.end : today;
  const points: HistoryPoint[] = [];
  for (let day = range.start; day <= lastDay; day = addDays(day, 1)) points.push({ day, balance: endOfDay(day) });

  const recorded = [...recordedBalances(input)].filter(([day]) => day <= today);
  const consistent = recorded.length === 0
    ? null
    : recorded.every(([day, value]) => Math.abs(endOfDay(day) - value) <= MATCH_TOLERANCE);
  return { kind: "ledger", points, entries, consistent };
}

/** The newest revision of each statement in `currency`, oldest statement first. */
function latestStatements(account: AccountRowDto, currency: string): CreditCardStatementDto[] {
  return latestStatementRevisions(account.creditCard?.statements ?? [])
    .filter((statement) => statement.statementBalance.currency === currency)
    .reverse();
}

function cardHistory(input: HistoryInput): BalanceHistory {
  const statements = latestStatements(input.account, input.currency);
  const balance = currentBalance(input.account, input.currency);
  const entries: HistoryEntry[] = [];
  const points: HistoryPoint[] = [];
  statements.forEach((statement, index) => {
    if (!inRange(statement.cycleEnd, input.range)) return;
    const previous = statements[index - 1];
    const value = statement.statementBalance.value;
    points.push({ day: statement.cycleEnd, balance: value });
    entries.unshift(entry(statement.cycleEnd, value, previous ? value - previous.statementBalance.value : null, {
      kind: "statement",
      cycle: { start: statement.cycleStart, end: statement.cycleEnd },
      transactionCount: statement.memberships.length,
    }));
  });
  if (inRange(input.today, input.range)) {
    const last = statements.at(-1);
    points.push({ day: input.today, balance });
    entries.unshift(entry(input.today, balance, last ? balance - last.statementBalance.value : null, { kind: "today" }));
  }
  return { kind: "card", points, entries, consistent: null };
}

function snapshotHistory(input: HistoryInput): BalanceHistory {
  const recorded = [...recordedBalances(input)].sort(([left], [right]) => left.localeCompare(right));
  const entries: HistoryEntry[] = [];
  const points: HistoryPoint[] = [];
  recorded.forEach(([day, balance], index) => {
    if (!inRange(day, input.range)) return;
    const previous = recorded[index - 1];
    points.push({ day, balance });
    entries.unshift(entry(day, balance, previous ? balance - previous[1] : null, { kind: "snapshot" }));
  });
  return { kind: "snapshots", points, entries, consistent: null };
}

export function historyStats(history: BalanceHistory): HistoryStats | null {
  if (history.kind === "card") {
    const statements = history.entries.filter((item) => item.kind === "statement");
    if (statements.length === 0) return null;
    const high = statements.reduce((best, item) => (item.balance > best.balance ? item : best));
    return {
      kind: "card",
      lastStatement: { day: statements[0].day, balance: statements[0].balance },
      high: { day: high.day, balance: high.balance },
      average: statements.reduce((sum, item) => sum + item.balance, 0) / statements.length,
    };
  }
  const { points } = history;
  if (points.length === 0) return null;
  const high = points.reduce((best, point) => (point.balance > best.balance ? point : best));
  const low = points.reduce((best, point) => (point.balance < best.balance ? point : best));
  return { kind: "range", net: points.at(-1)!.balance - points[0].balance, high, low };
}
