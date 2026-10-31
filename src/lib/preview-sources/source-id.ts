import type { InstitutionKey } from "../institutions/institutions.ts";

export const PREVIEW_PRODUCTS = ["deposit", "credit_card", "time_deposit"] as const;

export type PreviewProduct = (typeof PREVIEW_PRODUCTS)[number];

export const isPreviewProduct = (value: unknown): value is PreviewProduct =>
  PREVIEW_PRODUCTS.includes(value as PreviewProduct);

export class PreviewDataRejected extends Error {
  constructor(reason: string) {
    super(`Preview data rejected: ${reason}`);
    this.name = "PreviewDataRejected";
  }
}

/** `"100"`, `"100.00"`, and `"+100.0"` are the same amount. */
export function amountKey(value: string): string {
  const negative = value.startsWith("-");
  const [whole = "", fraction = ""] = value.replace(/^[+-]/u, "").split(".");
  const digits = `${whole.replace(/^0+(?=\d)/u, "")}${fraction ? `.${fraction.replace(/0+$/u, "")}` : ""}`.replace(/\.$/u, "");
  if (/^0*(?:\.0*)?$/u.test(digits) || digits === "") return "0";
  return `${negative ? "-" : ""}${digits}`;
}

export const PREVIEW_SOURCE_ID = /^[a-z][a-z0-9-]{0,47}$/u;

export const previewTaskId = (source: Readonly<{ id: string }>) => `preview-${source.id}`;

/**
 * The Institution each production Preview source collects from, readable by
 * the interface without loading the sources themselves. A Preview source is
 * not its Institution's supported source, so this names a logo and an
 * account's Institution, never Direct source precedence.
 */
export const PREVIEW_SOURCE_INSTITUTIONS = {
  "nextbank-deposit": "bank-823",
  "skbank-deposit": "bank-103",
  "rakuten-deposit": "bank-826",
  "mega-deposit": "bank-017",
  "taishin-deposit": "bank-812",
  "obank-deposit": "bank-048",
  "firstbank-deposit": "bank-007",
  "kgibank-deposit": "bank-809",
  "ctbc-credit-card": "ctbc",
  "feib-deposit": "bank-805",
} as const satisfies Readonly<Record<string, InstitutionKey>>;
