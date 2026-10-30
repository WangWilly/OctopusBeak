import type { PGliteStore, PGliteTransaction } from "./transaction.ts";
import type { ExactMoney } from "../../lib/shared-money/exact-money.ts";

/**
 * Row and identity helpers every PGlite Spending reader and command shares.
 * Identities cross this boundary as lowercase hyphenated UUID text and are
 * stored as 16-byte `bytea`; anything else fails closed.
 */

/** A read-only capability accepted by the PGlite Spending query seam. */
export type PGliteSpendingReader = Pick<PGliteStore, "query"> | Pick<PGliteTransaction, "query">;
export type PGliteSpendingStore = Pick<PGliteStore, "query" | "transaction">;

export type Row = Readonly<Record<string, unknown>>;
export type Money = ExactMoney;

export const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
export const HEX_ID = /^[0-9a-f]{32}$/iu;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

export function rows<T extends Row>(result: { rows: readonly T[] }): readonly T[] {
  return result.rows;
}

/**
 * The Spending SQL uses positional `?` parameters. PGlite speaks PostgreSQL,
 * so translate those placeholders here while preserving the caller's
 * parameter order. Spending SQL never contains a literal question mark.
 */
export async function pgliteQuery<T>(
  reader: PGliteSpendingReader,
  sql: string,
  params: readonly unknown[] = [],
  options?: Readonly<{ rowMode?: "array" | "object" }>,
): Promise<{ rows: readonly T[] }> {
  let index = 0;
  const postgresSql = sql.replace(/\?/gu, () => `$${++index}`);
  return reader.query<T>(postgresSql, params, options);
}

export function stringValue(value: unknown, label: string): string {
  if (value === null || value === undefined) throw new Error(`${label} is missing.`);
  return String(value);
}

export function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function numeric(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label} is invalid.`);
  return result;
}

export function jsonValue(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value !== null && typeof value === "object" && !Array.isArray(value))
    return value as Readonly<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return parsed as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw new Error(`${label} is not valid JSON object.`, { cause: error });
  }
}

function hyphenated(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The 16 stored bytes of a canonical UUID given as hyphenated or compact hex text. */
export function bytes(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} is required.`);
  const clean = value.trim().toLowerCase();
  if (!UUID.test(clean) && !HEX_ID.test(clean)) throw new Error(`${label} must be a canonical UUID.`);
  return Uint8Array.from(Buffer.from(clean.replaceAll("-", ""), "hex"));
}

/** Canonical UUID text of a stored `bytea` identity or of UUID text; anything else throws. */
export function idString(value: unknown, label = "Canonical identity"): string {
  if (typeof value === "string") {
    const clean = value.trim().toLowerCase();
    if (UUID.test(clean)) return clean;
    if (HEX_ID.test(clean)) return hyphenated(clean);
    throw new Error(`${label} must be a canonical UUID.`);
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const hex = Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value)).toString("hex");
    if (hex.length !== 32) throw new Error(`${label} must be a canonical UUID.`);
    return hyphenated(hex);
  }
  throw new Error(`${label} must be a canonical UUID.`);
}

export function exactMoney(row: Row, coefficient = "amount_coefficient", scale = "amount_scale", currency = "currency"): Money {
  return {
    coefficient: stringValue(row[coefficient], "Exact amount coefficient"),
    scale: numeric(row[scale], "Exact amount scale"),
    currency: stringValue(row[currency], "Exact amount currency"),
  };
}

export function optionalMoney(row: Row, coefficient: string, scale: string, currency: string): Money | null {
  return row[coefficient] === null || row[coefficient] === undefined ? null : exactMoney(row, coefficient, scale, currency);
}

/** The latest canonical commit sequence: the Spending data version. */
export async function latest(reader: PGliteSpendingReader): Promise<number> {
  const result = await reader.query<{ value: number | string }>("SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits");
  const value = Number(result.rows[0]?.value ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Canonical knowledge point is invalid.");
  return value;
}

export function pairKey(invoiceId: string, transactionId: string): string {
  return `${invoiceId}/${transactionId}`;
}
