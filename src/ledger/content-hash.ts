import { createHash } from "node:crypto";

const CONTENT_HASH_IGNORED_KEYS = new Set([
  "query_currency",
  "query_period",
  "查詢幣別",
  "查詢期間",
]);

export function hashBytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function contentHashForRow(
  bank: string,
  product: string,
  row: Record<string, unknown>,
): string {
  return hashBytes(stableStringify({ bank, product, row: contentHashRow(row) }));
}

function contentHashRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !CONTENT_HASH_IGNORED_KEYS.has(key)),
  );
}
