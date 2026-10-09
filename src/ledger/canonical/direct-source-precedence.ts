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
}>;

/** The direct source that counts an Intermediary-source account's Institution and product. */
export type CoveredBy = Readonly<{
  namespace: string;
  institutionKey: string;
  product: InstitutionProduct;
}>;

const coverageKey = (institutionKey: string, product: InstitutionProduct) => `${institutionKey}\u0000${product}`;

/**
 * Direct source precedence (ADR 0042): an Intermediary-source account is
 * covered while any direct-source account exists for its Institution and
 * product. The accounts given are the ones current at the reader's
 * knowledge point; nothing else, such as settings, decides coverage.
 */
export function directSourceCoverage(accounts: readonly CoverageAccount[]): ReadonlyMap<string, CoveredBy> {
  const direct = new Map<string, string>();
  for (const account of accounts) {
    const product = accountProduct(account);
    if (product === null || sourceInstitution(account.integrationNamespace)?.kind !== "direct") continue;
    const key = coverageKey(account.institutionKey, product);
    const namespace = direct.get(key);
    if (namespace === undefined || account.integrationNamespace < namespace) direct.set(key, account.integrationNamespace);
  }
  const covered = new Map<string, CoveredBy>();
  for (const account of accounts) {
    const product = accountProduct(account);
    if (product === null || sourceInstitution(account.integrationNamespace)?.kind !== "intermediary") continue;
    const namespace = direct.get(coverageKey(account.institutionKey, product));
    if (namespace !== undefined) covered.set(account.accountId, { namespace, institutionKey: account.institutionKey, product });
  }
  return covered;
}
