import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

export const PREVIEW_PRODUCTS = ["deposit", "credit_card", "time_deposit"] as const;

export type PreviewProduct = (typeof PREVIEW_PRODUCTS)[number];

export const isPreviewProduct = (value: unknown): value is PreviewProduct =>
  PREVIEW_PRODUCTS.includes(value as PreviewProduct);

/** An exact decimal lexeme such as `"1234.50"`, never a number. */
export type PreviewAmount = string;

/** An ISO 4217 code. */
export type PreviewCurrency = string;

/** A Taipei local date, optionally with a time, kept at the precision the source gave. */
export type PreviewLocalDate = Readonly<
  | { precision: "day"; value: string }
  | { precision: "minute"; value: string }
  | { precision: "second"; value: string }
>;

export type PreviewObservedAt = Readonly<{ at: string; source: "reported" | "collection-time" }>;

export type PreviewDirection = "inflow" | "outflow" | "unknown";

/**
 * Which (source, product) pairs a read may return. The query predicate is
 * the only place visibility is applied, so an empty list reads nothing.
 */
export type PreviewVisibleProduct = Readonly<{ sourceId: string; product: PreviewProduct }>;

export type PreviewVisibility = Readonly<{ visible: readonly PreviewVisibleProduct[] }>;

export const NO_PREVIEW_VISIBILITY: PreviewVisibility = { visible: [] };

export type PreviewReader = Pick<PGliteStore, "query"> | Pick<PGliteTransaction, "query">;

export const AMOUNT = /^[+-]?\d+(?:\.\d+)?$/u;
export const CURRENCY = /^[A-Z]{3}$/u;
export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
export const BILLING_PERIOD = /^\d{4}-\d{2}$/u;
export const LOCAL_DATE: Readonly<Record<PreviewLocalDate["precision"], RegExp>> = {
  day: DATE_ONLY,
  minute: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u,
  second: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u,
};

export class PreviewDataRejected extends Error {
  constructor(reason: string) {
    super(`Preview data rejected: ${reason}`);
    this.name = "PreviewDataRejected";
  }
}

export function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new PreviewDataRejected(`${field} is missing`);
  return value;
}

export function optionalText(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new PreviewDataRejected(`${field} is not text`);
  return value;
}

export function currency(value: unknown, field: string): string {
  if (typeof value !== "string" || !CURRENCY.test(value)) throw new PreviewDataRejected(`${field} is not an ISO 4217 code`);
  return value;
}

export function amount(value: unknown, field: string): string {
  if (typeof value !== "string" || !AMOUNT.test(value)) throw new PreviewDataRejected(`${field} is not an exact decimal string`);
  return value;
}

export function optionalAmount(value: unknown, field: string): string | null {
  return value === null ? null : amount(value, field);
}

export function instant(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new PreviewDataRejected(`${field} is not a timestamp`);
  return value;
}

export function dateOnly(value: unknown, field: string): string {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) throw new PreviewDataRejected(`${field} is not a YYYY-MM-DD date`);
  return value;
}

export function optionalDateOnly(value: unknown, field: string): string | null {
  return value === null ? null : dateOnly(value, field);
}

export function optionalFlag(value: unknown, field: string): boolean | null {
  if (value === null || typeof value === "boolean") return value;
  throw new PreviewDataRejected(`${field} is not a flag`);
}

export function list(value: unknown, field: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) throw new PreviewDataRejected(`${field} is not a list`);
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) throw new PreviewDataRejected(`${field} is not one of ${allowed.join(", ")}`);
  return value as T;
}

export function localDate(value: unknown, field: string): PreviewLocalDate {
  const candidate = value as Partial<PreviewLocalDate> | null | undefined;
  const precision = oneOf(candidate?.precision, ["day", "minute", "second"], `${field} precision`);
  if (typeof candidate?.value !== "string" || !LOCAL_DATE[precision].test(candidate.value))
    throw new PreviewDataRejected(`${field} does not match its precision`);
  return { precision, value: candidate.value };
}

export function unique(values: Iterable<string>, field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new PreviewDataRejected(`${field} is duplicated`);
    seen.add(value);
  }
}

export function observedAt(at: string, reported: boolean): PreviewObservedAt {
  return { at, source: reported ? "reported" : "collection-time" };
}

/** `"100"`, `"100.00"`, and `"+100.0"` are the same amount. */
export function amountKey(value: PreviewAmount): string {
  const negative = value.startsWith("-");
  const [whole = "", fraction = ""] = value.replace(/^[+-]/u, "").split(".");
  const digits = `${whole.replace(/^0+(?=\d)/u, "")}${fraction ? `.${fraction.replace(/0+$/u, "")}` : ""}`.replace(/\.$/u, "");
  if (/^0*(?:\.0*)?$/u.test(digits) || digits === "") return "0";
  return `${negative ? "-" : ""}${digits}`;
}

/**
 * SQL that keeps a row only when its source and product are visible. The two
 * placeholders take parallel `text[]` arrays of source ids and products.
 */
export function visiblePredicate(sourceColumn: string, productExpression: string, sourceParam: number, productParam: number): string {
  return `EXISTS (SELECT 1 FROM unnest($${sourceParam}::text[], $${productParam}::text[]) AS visible(source_id, product)
    WHERE visible.source_id = ${sourceColumn} AND visible.product = ${productExpression})`;
}

export function visibilityParams(visibility: PreviewVisibility): [readonly string[], readonly string[]] {
  return [visibility.visible.map((entry) => entry.sourceId), visibility.visible.map((entry) => entry.product)];
}
