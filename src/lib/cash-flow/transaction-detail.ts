import type { FinancialPageActionRequest } from "../financial/page-actions.ts";
import {
  allocationRemainder,
  categoryAllocationProblem,
  noteProblem,
  noteText,
  parseAllocationAmount,
  type CategoryAllocationComponent,
  type CategoryAllocationProblem,
} from "../financial/transaction-detail.ts";
import { compareExact, type ExactAmount } from "../shared-money/exact-money.ts";
import type { CashFlowRow, CashFlowRowEdit } from "./model.ts";

/** The transaction detail's writes, each a Financial page action (ADR 0136). */
export type CashFlowDetailRequest = Extract<FinancialPageActionRequest, Readonly<{ kind: "category" | "allocation" | "note" | "tag_add" | "tag_remove" }>>;

/** A canonical row the detail can write to; a Manual Account row has no `edit`. */
export type EditableCashFlowRow = CashFlowRow & Readonly<{ details: CashFlowRow["details"] & Readonly<{ edit: CashFlowRowEdit }> }>;

export function editableRow(row: CashFlowRow): row is EditableCashFlowRow {
  return row.source === "canonical" && row.details.edit !== null;
}

export function categoryRequest(row: EditableCashFlowRow, categoryCode: string | null, dataVersion: number): CashFlowDetailRequest {
  return { action: "categorize", kind: "category", purchaseId: row.details.edit.purchaseId, categoryCode, dataVersion };
}

export function allocationRequest(row: EditableCashFlowRow, components: readonly CategoryAllocationComponent[], dataVersion: number): CashFlowDetailRequest {
  return { action: "allocate", kind: "allocation", purchaseId: row.details.edit.purchaseId, components, dataVersion };
}

export function noteRequest(row: EditableCashFlowRow, note: string | null, dataVersion: number): CashFlowDetailRequest {
  return { action: "annotate", kind: "note", transactionId: row.transactionId, note, dataVersion };
}

export function tagAddRequest(row: EditableCashFlowRow, label: string, dataVersion: number): CashFlowDetailRequest {
  return { action: "add", kind: "tag_add", transactionId: row.transactionId, label, dataVersion };
}

export function tagRemoveRequest(row: EditableCashFlowRow, tagId: string, dataVersion: number): CashFlowDetailRequest {
  return { action: "remove", kind: "tag_remove", transactionId: row.transactionId, tagId, dataVersion };
}

/**
 * Whether saving the typed note would write something: a different note, or
 * an empty draft that clears the person's own note. An empty draft over a
 * Derived note writes nothing, since only the user lineage can be cleared.
 */
export function noteSaveEnabled(draft: string, row: EditableCashFlowRow): boolean {
  if (noteProblem(draft) !== null) return false;
  const text = noteText(draft);
  if (text === null) return row.details.edit.userNote;
  return text !== row.details.note;
}

/** One line of the allocation editor as typed. */
export type AllocationDraftLine = Readonly<{ categoryCode: string; amountText: string }>;

/**
 * What the editor shows for a draft: the exact remainder against the booked
 * amount, the components it would send, and the first reason it cannot be
 * saved, by the same rule the worker applies.
 */
export type AllocationDraftState = Readonly<{
  remainder: ExactAmount;
  /** -1 under, 0 exact, 1 over the booked amount. */
  balance: -1 | 0 | 1;
  components: readonly CategoryAllocationComponent[];
  problem: CategoryAllocationProblem | "amount" | "category" | null;
}>;

export function allocationDraftState(row: CashFlowRow, lines: readonly AllocationDraftLine[]): AllocationDraftState {
  const parsed = lines.map((line) => ({ categoryCode: line.categoryCode, amount: parseAllocationAmount(line.amountText) }));
  const typed = parsed.filter((line): line is { categoryCode: string; amount: ExactAmount } => line.amount !== null);
  const remainder = allocationRemainder(row.amount, typed);
  const sign = compareExact(remainder, { coefficient: "0", scale: 0 });
  const balance = sign > 0 ? -1 : sign < 0 ? 1 : 0;
  const components = typed.map((line) => ({ categoryCode: line.categoryCode, amount: { ...line.amount, currency: row.amount.currency } }));
  let problem: AllocationDraftState["problem"] = null;
  if (lines.some((line) => line.categoryCode === "")) problem = "category";
  else if (parsed.some((line) => line.amount === null)) problem = "amount";
  else problem = categoryAllocationProblem(row.amount, components);
  return { remainder, balance, components, problem };
}

/** The editor's first lines: the row's own allocation, else its single category taking the whole amount, then an empty line. */
export function initialAllocationLines(row: EditableCashFlowRow, amountText: (amount: ExactAmount) => string): AllocationDraftLine[] {
  const categorization = row.details.edit.categorization;
  if (categorization.mode === "allocated")
    return categorization.components.map((component) => ({ categoryCode: component.categoryCode, amountText: amountText(component.amount) }));
  const first = categorization.mode === "single" ? categorization.categoryCode : "";
  return [{ categoryCode: first, amountText: amountText(row.amount) }, { categoryCode: "", amountText: "" }];
}

/** A plain decimal for an input: no grouping, every reported decimal kept. */
export function plainAmount(amount: ExactAmount): string {
  const negative = amount.coefficient.startsWith("-");
  const digits = negative ? amount.coefficient.slice(1) : amount.coefficient;
  if (amount.scale === 0) return `${negative ? "-" : ""}${digits}`;
  const padded = digits.padStart(amount.scale + 1, "0");
  return `${negative ? "-" : ""}${padded.slice(0, -amount.scale)}.${padded.slice(-amount.scale)}`;
}

/**
 * Why a write did not land, named from the page read again after it: the row
 * is gone from the period, or it is no longer a canonical row the detail can
 * write. Otherwise null: the store moved on and the person can try again.
 */
export type CashFlowDetailRefusal = "gone" | "not_editable";

export function detailRefusal(transactionId: string, rows: readonly CashFlowRow[]): CashFlowDetailRefusal | null {
  const row = rows.find((entry) => entry.transactionId === transactionId);
  if (!row) return "gone";
  return editableRow(row) ? null : "not_editable";
}
