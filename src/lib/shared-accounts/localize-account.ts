import type { Translation } from "../i18n/i18n.ts";
import { institutionForNamespace } from "../institutions/institutions.ts";
import type { AccountRowDto } from "../shared-ledger/types.ts";

/**
 * Account labels arrive composed in English as "institution · product · id";
 * swap the first two parts for the interface language and keep the provider
 * identifier untouched.
 */
export function localizeAccount(account: AccountRowDto, dictionary: Translation): AccountRowDto {
  const key = institutionForNamespace(account.institutionKey);
  const institution = key ? dictionary.institutions[key] : account.institution;
  const product = (dictionary.accountProducts as Record<string, string>)[account.product] ?? account.product;
  const prefix = `${account.institution} · ${account.product}`;
  const label = account.label.startsWith(prefix)
    ? `${institution} · ${product}${account.label.slice(prefix.length)}`
    : account.label.startsWith(account.institution)
      ? `${institution}${account.label.slice(account.institution.length)}`
      : account.label;
  if (institution === account.institution && product === account.product && label === account.label) return account;
  return { ...account, institution, product, label };
}

export function localizeAccounts(accounts: readonly AccountRowDto[], dictionary: Translation): AccountRowDto[] {
  return accounts.map((account) => localizeAccount(account, dictionary));
}
