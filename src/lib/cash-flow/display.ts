import type { Translation } from "../i18n/i18n.ts";
import { institutionLogo, isInstitutionKey, type LogoKey } from "../institutions/institutions.ts";
import { SPENDING_GROUP_COLORS } from "../spending/spending-display.ts";
import type { CashFlowInflowGroup, CashFlowOutflowGroup } from "../../ledger/canonical/cash-flow-inclusion.ts";
import {
  addExact,
  isZeroExact,
  negateExact,
  normalizeExact,
  type ExactAmount,
  type ExactMoney,
} from "../shared-money/exact-money.ts";
import { cashFlowDirection, type CashFlowAccount, type CashFlowRow } from "./model.ts";
import { displaysAsZero } from "../shared-money/money.ts";

/** An outflow group; null is the Unclassified bucket. */
export type OutflowGroupKey = CashFlowOutflowGroup;

const TRANSFERS_OUT_COLOR = "oklch(45% 0.05 265)";

/** Inflow hues sit in the Data Series band; salary takes Settled Green, the rest cycle the remaining series. */
const INFLOW_COLORS = [
  "oklch(47% 0.08 155)",
  "oklch(53% 0.08 320)",
  "oklch(49% 0.06 215)",
  "oklch(56% 0.1 70)",
  "oklch(52% 0.11 250)",
  "oklch(50% 0.05 285)",
] as const;

export function inflowColor(index: number): string {
  return INFLOW_COLORS[index % INFLOW_COLORS.length]!;
}

export function outflowColor(group: OutflowGroupKey): string {
  return group === "transfers_out" ? TRANSFERS_OUT_COLOR : SPENDING_GROUP_COLORS[group ?? "unclassified"];
}

export function inflowGroupLabel(t: Translation, group: CashFlowInflowGroup): string {
  return t.cashFlow.inflowGroups[group];
}

export function outflowGroupLabel(t: Translation, group: OutflowGroupKey): string {
  if (group === null) return t.cashFlow.unclassified;
  return group === "transfers_out" ? t.cashFlow.transfersOut : t.spending.categoryGroups[group];
}

export function accountLabel(t: Translation, account: CashFlowAccount): string {
  if (account.name) return account.name;
  const key = account.institutionKey;
  const institution = key !== null && isInstitutionKey(key) ? t.institutions[key] : t.cashFlow.unknownAccount;
  return account.mask ? `${institution} ${account.mask}` : institution;
}

/** The Institution logo an account shows, or null for a Manual Account or an Institution without one. */
export function accountLogo(account: CashFlowAccount): LogoKey | null {
  const key = account.institutionKey;
  return key !== null && isInstitutionKey(key) ? institutionLogo(key) : null;
}

/** One character for the account mark: the institution's first, or the Manual Account name's. */
export function accountInitial(t: Translation, account: CashFlowAccount): string {
  return Array.from(accountLabel(t, account))[0] ?? "·";
}

/** The row's category, the label the worker's search matches. */
export function rowCategoryText(t: Translation, row: CashFlowRow): string {
  const flow = row.cashFlow;
  switch (flow.class) {
    case "inflow":
      return inflowGroupLabel(t, flow.group);
    case "not_counted":
      return t.cashFlow.notCounted[flow.reason];
    case "unresolved":
      return t.cashFlow.unresolvedTag;
    case "outflow":
    case "refund": {
      const groups = [...new Set(flow.categories.map((share) => share.group))].map((group) => outflowGroupLabel(t, group)).join("、");
      return flow.class === "refund" ? `${t.cashFlow.refund} · ${groups}` : groups;
    }
  }
}

/** The row's title: the counterparty, else the source description, else the note, else its category. */
export function rowTitle(t: Translation, row: CashFlowRow): string {
  return row.details.counterparty ?? row.details.description ?? row.details.note ?? rowCategoryText(t, row);
}

/** What the row adds to the counted net: inflow and refunds up, outflow down, everything else nothing. */
export function countedEffect(row: CashFlowRow): ExactAmount | null {
  switch (row.cashFlow.class) {
    case "inflow":
    case "refund":
      return row.amount;
    case "outflow":
      return negateExact(row.amount);
    default:
      return null;
  }
}

/** The row's amount as the list shows it, signed the way Cash flow counts it. */
export function signedAmount(row: CashFlowRow): ExactMoney {
  const exact = cashFlowDirection(row) === "inflow" ? row.amount : negateExact(row.amount);
  return { ...exact, currency: row.amount.currency };
}

export type CashFlowDay = Readonly<{ date: string; rows: readonly CashFlowRow[]; net: readonly ExactMoney[] }>;

function netByCurrency(rows: readonly CashFlowRow[]): ExactMoney[] {
  const totals = new Map<string, ExactAmount>();
  for (const row of rows) {
    const effect = countedEffect(row);
    if (!effect) continue;
    totals.set(row.amount.currency, addExact(totals.get(row.amount.currency) ?? { coefficient: "0", scale: 0 }, effect));
  }
  return [...totals.entries()]
    .sort(([left], [right]) => Number(right === "TWD") - Number(left === "TWD") || left.localeCompare(right))
    .map(([currency, amount]) => ({ ...normalizeExact(amount), currency }));
}

/** Rows grouped by day, newest first, each with its counted net per currency. */
export function groupByDay(rows: readonly CashFlowRow[]): readonly CashFlowDay[] {
  const days = new Map<string, CashFlowRow[]>();
  for (const row of rows) days.set(row.date, [...(days.get(row.date) ?? []), row]);
  return [...days.entries()].map(([date, dayRows]) => ({ date, rows: dayRows, net: netByCurrency(dayRows) }));
}

export type CashFlowListEntry =
  | Readonly<{ kind: "row"; row: CashFlowRow }>
  | Readonly<{ kind: "zeros"; key: string; account: CashFlowAccount; rows: readonly CashFlowRow[]; total: ExactMoney | null }>;

/**
 * A row that reads as 0 folds only when it has nothing else to show: a
 * counted, collected row with no tags. An undecided kind, a transfer, a manual entry or a tag stays
 * visible on its own row.
 */
function foldable(row: CashFlowRow): boolean {
  return displaysAsZero(row.amount)
    && (row.cashFlow.class === "inflow" || row.cashFlow.class === "outflow" || row.cashFlow.class === "refund")
    && row.source !== "manual"
    && (row.details.edit?.tags.length ?? 0) === 0;
}

/**
 * A day's foldable rows from one account fold into one entry where the first
 * of them stood, so a source that posts several sub-unit rewards a day does
 * not bury the day's real flow. A lone such row stays a row. The entry carries
 * the rows' signed sum when they share a currency.
 */
export function foldZeroRows(date: string, rows: readonly CashFlowRow[]): CashFlowListEntry[] {
  const zeros = new Map<string, CashFlowRow[]>();
  for (const row of rows) {
    if (foldable(row)) zeros.set(row.details.account.id, [...(zeros.get(row.details.account.id) ?? []), row]);
  }
  const entries: CashFlowListEntry[] = [];
  for (const row of rows) {
    const folded = foldable(row) ? zeros.get(row.details.account.id)! : null;
    if (!folded || folded.length < 2) entries.push({ kind: "row", row });
    else if (folded[0] === row) entries.push({ kind: "zeros", key: `${date}:${row.details.account.id}`, account: row.details.account, rows: folded, total: signedTotal(folded) });
  }
  return entries;
}

function signedTotal(rows: readonly CashFlowRow[]): ExactMoney | null {
  const currency = rows[0]?.amount.currency;
  if (!currency || rows.some((row) => row.amount.currency !== currency)) return null;
  const sum = rows.reduce<ExactAmount>((total, row) => addExact(total, signedAmount(row)), { coefficient: "0", scale: 0 });
  return { ...normalizeExact(sum), currency };
}

export function countedNet(rows: readonly CashFlowRow[]): readonly ExactMoney[] {
  return netByCurrency(rows);
}

/** How much of a group's flow one row carries; a refund counts against it. */
export function rowGroupAmount(row: CashFlowRow, group: OutflowGroupKey): ExactAmount | null {
  const flow = row.cashFlow;
  if (flow.class !== "outflow" && flow.class !== "refund") return null;
  const shares = flow.categories.filter((share) => share.group === group);
  if (shares.length === 0) return null;
  const total = shares.reduce<ExactAmount>((sum, share) => addExact(sum, share.amount), { coefficient: "0", scale: 0 });
  return normalizeExact(flow.class === "refund" ? negateExact(total) : total);
}

export function rowTouchesGroup(row: CashFlowRow, group: OutflowGroupKey): boolean {
  const amount = rowGroupAmount(row, group);
  return amount !== null && !isZeroExact(amount);
}

/** A share that is not whole never rounds to 0% or 100%. */
export function percent(share: number, locale: string): string {
  const whole = Math.round(share * 100);
  const nearEdge = (whole === 100 && share < 1) || (whole === 0 && share > 0);
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: nearEdge ? 1 : 0 }).format(share);
}
