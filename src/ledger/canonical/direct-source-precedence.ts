import {
  accountProduct,
  sourceInstitution,
  type InstitutionProduct,
} from "../../lib/institutions/institutions.ts";

/** What the coverage rule reads of one Financial Account. */
export type CoverageAccount = Readonly<{
  accountId: string;
  integrationNamespace: string;
  stream: string;
  accountType: string;
  institutionKey: string;
  /** Its denomination, or for a multi-currency account every currency of its balances and transactions. */
  currencies: readonly string[];
}>;

/** The direct source that counts an Intermediary-source account's Institution and product. */
export type CoveredBy = Readonly<{
  namespace: string;
  institutionKey: string;
  product: InstitutionProduct;
}>;

const coverageKey = (institutionKey: string, product: InstitutionProduct, currency: string) =>
  `${institutionKey}\u0000${product}\u0000${currency}`;

/**
 * Direct source precedence (ADR 0042, amended by ADR 0048): an
 * Intermediary-source account is covered while every currency it holds is
 * held by a direct-source account for the same Institution and product. The
 * accounts given are the ones current at the reader's knowledge point;
 * nothing else, such as settings, decides coverage.
 */
export function directSourceCoverage(accounts: readonly CoverageAccount[]): ReadonlyMap<string, CoveredBy> {
  const direct = new Map<string, string>();
  for (const account of accounts) {
    const product = accountProduct(account);
    if (product === null || sourceInstitution(account.integrationNamespace)?.kind !== "direct") continue;
    for (const currency of account.currencies) {
      const key = coverageKey(account.institutionKey, product, currency);
      const namespace = direct.get(key);
      if (namespace === undefined || account.integrationNamespace < namespace) direct.set(key, account.integrationNamespace);
    }
  }
  const covered = new Map<string, CoveredBy>();
  for (const account of accounts) {
    const product = accountProduct(account);
    if (product === null || sourceInstitution(account.integrationNamespace)?.kind !== "intermediary") continue;
    const namespaces = account.currencies
      .flatMap((currency) => direct.get(coverageKey(account.institutionKey, product, currency)) ?? [])
      .sort();
    if (namespaces.length === 0 || namespaces.length < account.currencies.length) continue;
    covered.set(account.accountId, { namespace: namespaces[0]!, institutionKey: account.institutionKey, product });
  }
  return covered;
}
