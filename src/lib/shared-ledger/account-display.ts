import {
  institutionForNamespace,
  institutionNames,
  intermediarySource,
  intermediarySourceName,
  isInstitutionKey,
  type InstitutionKey,
} from "../institutions/institutions.ts";

export type AccountDisplayAccountType =
  | "depository"
  | "credit"
  | "loan"
  | "investment"
  | "other";

export type AccountDisplayInput = Readonly<{
  accountId: string;
  integrationNamespace: string;
  /** The account's stored Institution, which an Intermediary source does not share with its namespace. */
  institutionKey: InstitutionKey;
  stream: string;
  /** The provider identifier, never the internal source-account key. */
  accountNo: string | null;
  /** Display-safe card instrument masks associated with this portfolio. */
  cardMasks?: readonly string[];
  accountType: AccountDisplayAccountType;
  investmentSubtype?: string | null;
  currency?: string | null;
}>;

export type AccountDisplay = Readonly<{
  label: string;
  institution: string;
  product: string;
}>;

export type SourceGapForDisplay = Readonly<{
  label?: string;
  integrationNamespace?: string;
  institutionKey?: string;
  stream?: string;
  accountNo?: string | null;
  reason?: string;
}>;

type AccountDisplayBucket = {
  rows: AccountDisplayInput[];
};

const INSTITUTION_NAMES = institutionNames("en");

/** The name a namespace shows on its own: its Institution for a direct source, the source itself for an Intermediary source. */
function namespaceLabel(namespace: string): string | undefined {
  const normalized = namespace.trim().toLowerCase();
  const key = institutionForNamespace(normalized);
  if (key) return INSTITUTION_NAMES[key];
  const intermediary = intermediarySource(normalized);
  return intermediary ? intermediarySourceName(intermediary, "en") : undefined;
}

const SOURCE_GAP_FALLBACK = "Source not identified";

/**
 * Build stable, human-readable account labels. Provider account numbers are
 * presentation-safe under the canonical contract; internal source keys are
 * never included. The account id is used only to order duplicate rows.
 */
export function buildAccountDisplayMap(
  accounts: readonly AccountDisplayInput[],
): ReadonlyMap<string, AccountDisplay> {
  const buckets = new Map<string, AccountDisplayBucket>();
  for (const account of accounts) {
    const identifier = displayableAccountIdentifier(account);
    const key = [
      normalizeNamespace(account.integrationNamespace),
      account.institutionKey,
      productLabel(account),
      identifier ?? "missing",
    ].join("|");
    const bucket = buckets.get(key) ?? { rows: [] };
    bucket.rows.push(account);
    buckets.set(key, bucket);
  }

  const result = new Map<string, AccountDisplay>();
  for (const bucket of buckets.values()) {
    const rows = [...bucket.rows].sort((left, right) => left.accountId.localeCompare(right.accountId));
    rows.forEach((account, index) => {
      result.set(account.accountId, formatAccountDisplay(
        account,
        index + 1,
        rows.length,
      ));
    });
  }
  return result;
}

export function safeSourceGapLabel(gap: SourceGapForDisplay): string {
  const label = gap.label?.trim();
  const namespace = gap.integrationNamespace?.trim();
  if (
    label
    && !containsInternalAccountIdentifier(label)
    && (!namespace || !looksLikeRawNamespaceLabel(label, namespace))
  ) {
    return label;
  }

  if (!namespace) return SOURCE_GAP_FALLBACK;
  const institution = isInstitutionKey(gap.institutionKey)
    ? INSTITUTION_NAMES[gap.institutionKey]
    : namespaceLabel(namespace);
  if (!institution) return SOURCE_GAP_FALLBACK;
  const stream = gap.stream?.trim();
  if (!stream) return institution;
  const accountType = accountTypeForStream(stream);
  const product = productLabel({
    integrationNamespace: namespace,
    stream,
    accountType,
  });
  const identifier = displayableGapIdentifier(gap);
  return identifier
    ? `${institution} · ${product} · ${identifier}`
    : `${institution} · ${product}`;
}

export function sourceGapCounts(gaps: readonly SourceGapForDisplay[]) {
  return gaps.reduce(
    (counts, gap) => {
      if (gap.reason === "current-value-not-observed") counts.currentValue += 1;
      else if (gap.reason === "source-not-collected") counts.sourceNotCollected += 1;
      else if (gap.reason === "canonical-read-unavailable") counts.canonicalReadUnavailable += 1;
      return counts;
    },
    { currentValue: 0, sourceNotCollected: 0, canonicalReadUnavailable: 0 },
  );
}

export function containsInternalAccountIdentifier(value: string): boolean {
  return /sha256:/iu.test(value);
}

export function productLabel(account: Pick<AccountDisplayInput, "integrationNamespace" | "stream" | "accountType" | "investmentSubtype">): string {
  const stream = account.stream.trim().toLowerCase();
  if (stream.includes("foreign")) return "Foreign currency account";
  if (stream.includes("credit")) return "Credit card account";
  if (stream.includes("loan")) return "Loan";
  if (stream.includes("fund") || normalizeNamespace(account.integrationNamespace) === "yuantafund") return "Fund";
  if (
    stream.includes("crypto")
    || normalizeNamespace(account.integrationNamespace) === "maicoin"
    || account.investmentSubtype === "crypto_exchange"
    || account.investmentSubtype === "non_custodial_wallet"
  ) return "Crypto account";
  if (stream.includes("broker") || normalizeNamespace(account.integrationNamespace) === "yuantatrade") return "Brokerage account";
  if (stream.includes("domestic") || account.accountType === "depository") return "Bank account";
  if (account.accountType === "investment") return "Investment account";
  if (account.accountType === "credit") return "Credit account";
  if (account.accountType === "loan") return "Loan";
  return "Account";
}

function formatAccountDisplay(
  account: AccountDisplayInput,
  ordinal: number,
  duplicateCount: number,
): AccountDisplay {
  const institution = INSTITUTION_NAMES[account.institutionKey];
  const product = productLabel(account);
  const identifier = displayableAccountIdentifier(account)
    ?? `Account ${ordinal}`;
  const duplicateOrdinal = displayableAccountIdentifier(account) && duplicateCount > 1
    ? ` · ${ordinal}`
    : "";
  return {
    label: `${institution} · ${product} · ${identifier}${duplicateOrdinal}`,
    institution,
    product,
  };
}

function displayableAccountIdentifier(
  account: Pick<AccountDisplayInput, "accountNo" | "cardMasks" | "accountType" | "stream">,
): string | null {
  // `accountNo` is the source-proven portfolio/provider identifier. Card
  // instrument masks are a separate fact; use them only when they are
  // explicitly associated with a credit portfolio by the canonical store.
  const accountNumber = displayableIdentifier(account.accountNo);
  if (account.accountType !== "credit" && !account.stream.toLowerCase().includes("credit"))
    return accountNumber;
  const masks = displayableCardMasks(account.cardMasks);
  if (masks.length === 0) return accountNumber;
  return [accountNumber, ...masks].filter((value): value is string => Boolean(value)).join(", ");
}

function displayableCardMasks(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values
    .map((value) => value.trim())
    .filter((value) => /^\*{4}\d{4}$/u.test(value)))]
    .sort((left, right) => left.localeCompare(right));
}

function displayableGapIdentifier(gap: SourceGapForDisplay): string | null {
  return displayableIdentifier(gap.accountNo);
}

function displayableIdentifier(accountNo: string | null | undefined): string | null {
  const raw = accountNo?.trim() ?? "";
  if (!raw || containsOpaqueToken(raw)) return null;
  // accountNo is the provider identifier under the canonical contract. Keep
  // its complete text, including leading zeroes and provider separators.
  return raw;
}

function containsOpaqueToken(value: string): boolean {
  return /sha256:/iu.test(value);
}

function looksLikeRawNamespaceLabel(label: string, namespace: string): boolean {
  const institution = namespaceLabel(namespace);
  if (institution && label.toLocaleLowerCase().startsWith(institution.toLocaleLowerCase())) return false;
  return new RegExp(`^${escapeRegExp(namespace)}(?:\\s|$)`, "iu").test(label);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function accountTypeForStream(stream: string): AccountDisplayAccountType {
  const normalized = stream.toLowerCase();
  if (normalized.includes("credit")) return "credit";
  if (normalized.includes("loan")) return "loan";
  if (normalized.includes("investment") || normalized.includes("fund") || normalized.includes("crypto")) return "investment";
  return "depository";
}

function normalizeNamespace(value: string): string {
  return value.trim().toLowerCase().replace(/[-_\s]/gu, "");
}
