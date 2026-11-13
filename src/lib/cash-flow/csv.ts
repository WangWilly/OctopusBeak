import type { Translation } from "../i18n/i18n.ts";
import type { ExactAmount } from "../shared-money/exact-money.ts";
import { accountLabel, rowCategoryText, rowTitle } from "./display.ts";
import type { CashFlowRow } from "./model.ts";
import { cashFlowTransferRole } from "./model.ts";

/** `flow` is every counted row; `flow_and_transfers` adds both sides of each internal transfer, tagged with a pairing id. */
export type CashFlowCsvContent = "flow" | "flow_and_transfers";

/** The rows `content` exports, in the order given. */
export function cashFlowCsvRows(rows: readonly CashFlowRow[], content: CashFlowCsvContent): readonly CashFlowRow[] {
  return rows.filter((row) => {
    const flow = row.cashFlow.class;
    if (flow === "inflow" || flow === "outflow" || flow === "refund") return true;
    return content === "flow_and_transfers" && cashFlowTransferRole(row) !== null;
  });
}

/** A plain decimal with its sign and its booked scale, from the exact amount: never through a float. */
export function exactDecimalText(amount: ExactAmount): string {
  const { coefficient, scale } = amount;
  const negative = coefficient.startsWith("-");
  const digits = coefficient.replace(/^-/u, "").padStart(scale + 1, "0");
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative && /[1-9]/u.test(digits) ? `-${text}` : text;
}

/** The amount as it moved the account: outflows negative. */
function signedText(row: CashFlowRow): string {
  const text = exactDecimalText(row.amount);
  return row.direction === "outflow" && /[1-9]/u.test(text) ? `-${text}` : text;
}

/** Text from a bank or the person that a spreadsheet would run as a formula is kept as text. */
function inertText(value: string): string {
  return /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll("\"", "\"\"")}"` : value;
}

/**
 * The Cash flow CSV: UTF-8 with a byte-order mark so spreadsheet apps read it
 * as UTF-8, one row per transaction, amounts exact and signed, each row in its
 * own currency and never converted. There is no balance column: Cash flow
 * holds no balance. A pairing id joins the two sides of one internal transfer
 * within this file; an unpaired internal transfer has none.
 */
export function cashFlowCsv(rows: readonly CashFlowRow[], content: CashFlowCsvContent, t: Translation): string {
  const headers = t.cashFlow.csv.columns;
  const pairing = new Map<string, string>();
  const pairingId = (row: CashFlowRow) => {
    if (row.transferLinkId === null || cashFlowTransferRole(row) === null) return "";
    if (!pairing.has(row.transferLinkId)) pairing.set(row.transferLinkId, `T${pairing.size + 1}`);
    return pairing.get(row.transferLinkId)!;
  };
  const withPairing = content === "flow_and_transfers";
  const lines = [
    [headers.date, headers.time, headers.description, headers.category, headers.account, headers.amount, headers.currency,
      headers.note, headers.sourceDescription, ...(withPairing ? [headers.pairing] : [])],
    ...cashFlowCsvRows(rows, content).map((row) => [
      row.date,
      row.details.time ?? "",
      inertText(rowTitle(t, row)),
      inertText(rowCategoryText(t, row)),
      inertText(accountLabel(t, row.details.account)),
      signedText(row),
      row.amount.currency,
      inertText(row.details.note ?? ""),
      inertText(row.details.description ?? ""),
      ...(withPairing ? [pairingId(row)] : []),
    ]),
  ];
  return `﻿${lines.map((cells) => cells.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** `收支流水_20261001-20261005`: the page title and the period's two dates; `downloadCsv` adds `.csv`. */
export function cashFlowCsvName(t: Translation, period: Readonly<{ startDate: string; endDate: string }>): string {
  const compact = (date: string) => date.replaceAll("-", "");
  return `${t.cashFlow.csv.fileName}_${compact(period.startDate)}-${compact(period.endDate)}`;
}
