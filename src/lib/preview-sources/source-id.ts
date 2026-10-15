import type { InstitutionKey } from "../institutions/institutions.ts";

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
} as const satisfies Readonly<Record<string, InstitutionKey>>;
