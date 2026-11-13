import { isPersonalCategoryCode } from "../../ledger/canonical/personal-category-codes.ts";
import {
  addExact,
  compareExact,
  normalizeCurrency,
  normalizeExact,
  subtractExact,
  type ExactAmount,
  type ExactMoney,
} from "../shared-money/exact-money.ts";

/**
 * The rules a transaction detail write must meet, shared by the worker that
 * refuses a write and the renderer that explains the refusal before sending:
 * the worker's message never crosses IPC. Pure, so both sides can import it.
 */

/** One Category Allocation component as a request carries it. */
export type CategoryAllocationComponent = Readonly<{ categoryCode: string; amount: ExactMoney }>;

/** Why an allocation is refused; null means it is complete. */
export type CategoryAllocationProblem =
  /** Fewer than two components: one category is a single categorization. */
  | "too_few"
  | "unknown_category"
  | "duplicate_category"
  /** A component is zero, negative or not an exact amount. */
  | "not_positive"
  /** A component has more decimals than the booked amount. */
  | "too_precise"
  /** A component is not in the booked currency. */
  | "currency"
  /** The components do not add up to the booked amount. */
  | "sum";

const DIGITS = /^\d+$/u;

/** The booked amount less every component; zero exactly when the allocation reconciles. */
export function allocationRemainder(booked: ExactAmount, components: readonly Readonly<{ amount: ExactAmount }>[]): ExactAmount {
  let rest = normalizeExact(booked);
  for (const component of components) rest = subtractExact(rest, component.amount);
  return normalizeExact(rest);
}

/**
 * The first problem that keeps `components` from being a complete Category
 * Allocation of `booked`: at least two registered, distinct categories, each a
 * positive exact amount in the booked currency at no more decimals than it,
 * that sum exactly to it.
 */
export function categoryAllocationProblem(booked: ExactMoney, components: readonly CategoryAllocationComponent[]): CategoryAllocationProblem | null {
  if (components.length < 2) return "too_few";
  const seen = new Set<string>();
  // The source's own scale bounds the decimals, so 1250.50 admits 250.49.
  const bookedScale = booked.scale;
  for (const component of components) {
    if (!isPersonalCategoryCode(component.categoryCode)) return "unknown_category";
    if (seen.has(component.categoryCode)) return "duplicate_category";
    seen.add(component.categoryCode);
    const { coefficient, scale } = component.amount;
    if (!DIGITS.test(coefficient) || !Number.isSafeInteger(scale) || scale < 0 || BigInt(coefficient) === 0n) return "not_positive";
    if (normalizeExact(component.amount).scale > bookedScale) return "too_precise";
    if (normalizeCurrency(component.amount.currency) !== normalizeCurrency(booked.currency)) return "currency";
  }
  return compareExact(allocationRemainder(booked, components), { coefficient: "0", scale: 0 }) === 0 ? null : "sum";
}

/** The components' total, reduced. */
export function allocationTotal(components: readonly Readonly<{ amount: ExactAmount }>[]): ExactAmount {
  return components.reduce<ExactAmount>((sum, component) => addExact(sum, component.amount), { coefficient: "0", scale: 0 });
}

/**
 * Read an amount the person typed: digits with an optional decimal point and
 * thousands commas, never a sign or an exponent. Null when it is not one.
 */
export function parseAllocationAmount(text: string): ExactAmount | null {
  const match = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/u.exec(text.trim());
  if (!match) return null;
  const decimals = match[2] ?? "";
  return normalizeExact({ coefficient: `${match[1]!.replaceAll(",", "")}${decimals}`, scale: decimals.length });
}

export const NOTE_MAX_LENGTH = 500;
export const TAG_LABEL_MAX_LENGTH = 40;

/** A note as stored: trimmed; empty means no note. */
export function noteText(value: string): string | null {
  const text = value.trim();
  return text === "" ? null : text;
}

/** A Tag label as shown: trimmed, inner whitespace collapsed to one space. */
export function tagDisplayLabel(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

/**
 * The form a Tag label is unique by in the user's scope: compatibility
 * normalized, so full-width and half-width forms are one label, and lower case.
 */
export function normalizeTagLabel(value: string): string {
  return tagDisplayLabel(value).normalize("NFKC").toLowerCase();
}

export type TagLabelProblem = "empty" | "too_long";

export function tagLabelProblem(value: string): TagLabelProblem | null {
  const label = tagDisplayLabel(value);
  if (label === "") return "empty";
  return Array.from(label).length > TAG_LABEL_MAX_LENGTH ? "too_long" : null;
}

export function noteProblem(value: string | null): "too_long" | null {
  return value !== null && Array.from(value.trim()).length > NOTE_MAX_LENGTH ? "too_long" : null;
}
