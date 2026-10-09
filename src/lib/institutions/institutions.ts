import {
  BANK_ROWS,
  BROKER_BRANCH_FIRMS,
  BROKER_FIRM_ROWS,
} from "./institution-tables.generated.ts";

/**
 * The Institutions this app can name, keyed by a stable key the canonical
 * store persists on each Financial Account. Banks and brokers come from the
 * FISC and TWSE registries; platforms are the non-bank services with a source.
 */
const PLATFORM_ROWS = [
  { key: "maicoin", zhTW: "MaiCoin", en: "MaiCoin" },
  { key: "einvoice", zhTW: "電子發票", en: "E-Invoice" },
] as const;

export type InstitutionKind = "bank" | "broker" | "platform";

export type InstitutionKey =
  | (typeof BANK_ROWS)[number]["key"]
  | (typeof BROKER_FIRM_ROWS)[number]["key"]
  | (typeof PLATFORM_ROWS)[number]["key"];

export type Institution = Readonly<{
  key: InstitutionKey;
  kind: InstitutionKind;
  /** Null when no English name is on record; show the Chinese name instead. */
  name: Readonly<{ "zh-TW": string; en: string | null }>;
}>;

const institution = (
  kind: InstitutionKind,
  row: Readonly<{ key: InstitutionKey; zhTW: string; en: string | null }>,
): Institution => Object.freeze({ key: row.key, kind, name: Object.freeze({ "zh-TW": row.zhTW, en: row.en }) });

export const INSTITUTIONS: ReadonlyMap<InstitutionKey, Institution> = new Map(
  [
    ...BANK_ROWS.map((row) => institution("bank", row)),
    ...BROKER_FIRM_ROWS.map((row) => institution("broker", row)),
    ...PLATFORM_ROWS.map((row) => institution("platform", row)),
  ].map((entry) => [entry.key, entry]),
);

const BANK_CODE_INSTITUTIONS: ReadonlyMap<string, InstitutionKey> = new Map(
  BANK_ROWS.map((row) => [row.code, row.key]),
);

const BROKER_FIRM_INSTITUTIONS: ReadonlyMap<string, InstitutionKey> = new Map(
  BROKER_FIRM_ROWS.map((row) => [row.code, row.key]),
);

export function isInstitutionKey(value: unknown): value is InstitutionKey {
  return typeof value === "string" && INSTITUTIONS.has(value as InstitutionKey);
}

/** The Institution for a FISC 3-digit bank head-office code, or null when the code is not a deposit institution. */
export function institutionForBankCode(code: string): InstitutionKey | null {
  return BANK_CODE_INSTITUTIONS.get(code) ?? null;
}

/** The broker firm for a TWSE branch or head-office code, or null when TWSE does not list the code. */
export function institutionForBrokerBranch(code: string): InstitutionKey | null {
  const firm = BROKER_BRANCH_FIRMS[code];
  return firm === undefined ? null : BROKER_FIRM_INSTITUTIONS.get(firm) ?? null;
}

/**
 * How each integration namespace relates to Institutions. A direct source is
 * operated by one Institution. An Intermediary source reports accounts other
 * Institutions maintain, so each of its accounts carries its own Institution.
 */
export type SourceInstitution =
  | Readonly<{ kind: "direct"; institution: LogoInstitutionKey }>
  | Readonly<{ kind: "intermediary" }>;

const direct = (institution: LogoInstitutionKey): SourceInstitution => ({ kind: "direct", institution });

const SOURCE_INSTITUTIONS: Readonly<Record<string, SourceInstitution>> = {
  fubon: direct("fubon"),
  esun: direct("esun"),
  yuanta: direct("yuanta-bank"),
  "yuanta-fund": direct("yuanta-bank"),
  "yuanta-trade": direct("yuanta-securities"),
  cathay: direct("cathay"),
  hncb: direct("hncb"),
  ctbc: direct("ctbc"),
  post: direct("post"),
  sinopac: direct("sinopac"),
  linebank: direct("linebank"),
  einvoice: direct("einvoice"),
  maicoin: direct("maicoin"),
  tdcc: { kind: "intermediary" },
};

export function sourceInstitution(namespace: string): SourceInstitution | null {
  return Object.hasOwn(SOURCE_INSTITUTIONS, namespace) ? SOURCE_INSTITUTIONS[namespace]! : null;
}

/** Institutions with a supported source of their own, a logo, and an interface name. */
export const INSTITUTION_KEYS = [
  "fubon",
  "esun",
  "yuanta-bank",
  "yuanta-securities",
  "cathay",
  "hncb",
  "ctbc",
  "post",
  "sinopac",
  "linebank",
  "einvoice",
  "maicoin",
] as const satisfies readonly InstitutionKey[];

export type LogoInstitutionKey = (typeof INSTITUTION_KEYS)[number];

/** Interface names of the logo institutions, from the one catalog. */
export function institutionNames(locale: "en" | "zh-TW"): Record<LogoInstitutionKey, string> {
  return Object.fromEntries(INSTITUTION_KEYS.map((key) => {
    const name = INSTITUTIONS.get(key)!.name;
    return [key, name[locale] ?? name["zh-TW"]];
  })) as Record<LogoInstitutionKey, string>;
}

const TASK_INSTITUTIONS: Readonly<Record<string, LogoInstitutionKey>> = {
  "fubon-all-statements": "fubon",
  "esun-credit-card-statements": "esun",
  "yuanta-all-statements": "yuanta-bank",
  "yuanta-trade-statements": "yuanta-securities",
  "cathay-all-statements": "cathay",
  "hncb-statements": "hncb",
  "ctbc-statements": "ctbc",
  "post-statements": "post",
  "sinopac-statements": "sinopac",
  "linebank-statements": "linebank",
  "einvoice-personal-invoices": "einvoice",
  "sync-maicoin": "maicoin",
};

/** The Institution that operates a direct source; null for an Intermediary source or an unknown namespace. */
export function institutionForNamespace(namespace: string | undefined): LogoInstitutionKey | null {
  const source = namespace === undefined ? null : sourceInstitution(namespace);
  return source?.kind === "direct" ? source.institution : null;
}

export function institutionForTask(taskId: string): LogoInstitutionKey | null {
  return TASK_INSTITUTIONS[taskId] ?? null;
}

export function institutionLogoFile(key: LogoInstitutionKey): string {
  return `${key}.webp`;
}
