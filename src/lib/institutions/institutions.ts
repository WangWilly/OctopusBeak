import {
  BANK_ROWS,
  BROKER_BRANCH_FIRMS,
  BROKER_FIRM_ROWS,
} from "./institution-tables.generated.ts";
import { TDCC_FUND_STREAM } from "../../ledger/canonical/tdcc-investment-contract.ts";

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
  | Readonly<{ kind: "direct"; institution: LogoInstitutionKey; investmentStreams: InvestmentStreamProducts }>
  | Readonly<{ kind: "intermediary"; logo: IntermediarySourceLogoKey; investmentStreams: InvestmentStreamProducts }>;

/**
 * The products Direct source precedence decides between. Every depository
 * account is a deposit; an investment account's product is named by its
 * source's stream. Other accounts have no product and are never covered.
 */
export type InstitutionProduct = "deposit" | "securities" | "fund";

type InvestmentStreamProducts = Readonly<Record<string, Exclude<InstitutionProduct, "deposit">>>;

const direct = (institution: LogoInstitutionKey, investmentStreams: InvestmentStreamProducts = {}): SourceInstitution =>
  ({ kind: "direct", institution, investmentStreams });

const SOURCE_INSTITUTIONS: Readonly<Record<string, SourceInstitution>> = {
  fubon: direct("fubon"),
  esun: direct("esun"),
  yuanta: direct("yuanta-bank"),
  "yuanta-fund": direct("yuanta-bank", { investment: "fund" }),
  "yuanta-trade": direct("yuanta-securities", { investment: "securities" }),
  cathay: direct("cathay"),
  hncb: direct("hncb"),
  ctbc: direct("ctbc"),
  post: direct("post"),
  sinopac: direct("sinopac"),
  linebank: direct("linebank"),
  einvoice: direct("einvoice"),
  maicoin: direct("maicoin"),
  tdcc: { kind: "intermediary", logo: "tdcc", investmentStreams: { investment: "securities", [TDCC_FUND_STREAM]: "fund" } },
};

export function sourceInstitution(namespace: string): SourceInstitution | null {
  return Object.hasOwn(SOURCE_INSTITUTIONS, namespace) ? SOURCE_INSTITUTIONS[namespace]! : null;
}

/** An account's product, or null when it is not one Direct source precedence decides. */
export function accountProduct(
  account: Readonly<{ integrationNamespace: string; stream: string; accountType: string }>,
): InstitutionProduct | null {
  if (account.accountType === "depository") return "deposit";
  if (account.accountType !== "investment") return null;
  const streams = sourceInstitution(account.integrationNamespace)?.investmentStreams;
  return streams && Object.hasOwn(streams, account.stream) ? streams[account.stream]! : null;
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

/** Intermediary sources are not Institutions, but each still shows its own logo wherever sources are listed. */
export type IntermediarySourceLogoKey = "tdcc";

export type LogoKey = LogoInstitutionKey | IntermediarySourceLogoKey;

/** Interface names of every catalog Institution. */
export function institutionNames(locale: "en" | "zh-TW"): Record<InstitutionKey, string> {
  return Object.fromEntries([...INSTITUTIONS.values()].map(({ key, name }) =>
    [key, name[locale] ?? name["zh-TW"]])) as Record<InstitutionKey, string>;
}

/** The logo an Institution shows; null for the many catalog Institutions without a source of their own. */
export function institutionLogo(key: InstitutionKey | undefined): LogoInstitutionKey | null {
  return (INSTITUTION_KEYS as readonly string[]).includes(key ?? "") ? key as LogoInstitutionKey : null;
}

/** The Intermediary source a namespace names, or null for a direct source or an unknown namespace. */
export function intermediarySource(namespace: string | undefined): IntermediarySourceLogoKey | null {
  const source = namespace === undefined ? null : sourceInstitution(namespace);
  return source?.kind === "intermediary" ? source.logo : null;
}

const INTERMEDIARY_SOURCE_NAMES: Readonly<Record<IntermediarySourceLogoKey, Readonly<{ "zh-TW": string; en: string }>>> = {
  tdcc: { "zh-TW": "集保 e 存摺", en: "TDCC e-Passbook" },
};

/** The interface name of an Intermediary source, which is not an Institution. */
export function intermediarySourceName(key: IntermediarySourceLogoKey, locale: "en" | "zh-TW"): string {
  return INTERMEDIARY_SOURCE_NAMES[key][locale];
}

const TASK_LOGOS: Readonly<Record<string, LogoKey>> = {
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
  "sync-tdcc": "tdcc",
};

/** The Institution that operates a direct source; null for an Intermediary source or an unknown namespace. */
export function institutionForNamespace(namespace: string | undefined): LogoInstitutionKey | null {
  const source = namespace === undefined ? null : sourceInstitution(namespace);
  return source?.kind === "direct" ? source.institution : null;
}

/** The logo of the source an integration namespace names: its Institution for a direct source, its own for an Intermediary source. */
export function sourceLogo(namespace: string): LogoKey | null {
  const source = sourceInstitution(namespace);
  if (!source) return null;
  return source.kind === "direct" ? source.institution : source.logo;
}

export function sourceLogoForTask(taskId: string): LogoKey | null {
  return TASK_LOGOS[taskId] ?? null;
}

export function institutionLogoFile(key: LogoKey): string {
  return `${key}.webp`;
}
