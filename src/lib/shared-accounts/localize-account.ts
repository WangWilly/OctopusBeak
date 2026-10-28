import type { Translation } from "../i18n/i18n.ts";
import { maskedAccountDigits } from "../overview/overview-format.ts";
import type { AccountKind, AccountRowDto } from "../shared-ledger/types.ts";

/** The interface-language name of an account's kind; every kind must have one. */
export function accountKindLabel(kind: AccountKind, dictionary: Translation): string {
  const labels: Record<AccountKind, string> = {
    bank: dictionary.accounts.bank,
    foreign: dictionary.accounts.foreign,
    fund: dictionary.accounts.fund,
    brokerage: dictionary.accounts.brokerage,
    crypto: dictionary.accounts.crypto,
    "credit-card": dictionary.accounts.creditCard,
    loan: dictionary.accounts.loan,
    other: dictionary.accounts.other,
  };
  return labels[kind];
}

/**
 * Account labels arrive composed in English as "institution · product · id";
 * swap the first two parts for the interface language and keep the provider
 * identifier untouched. An account without a displayable identifier carries
 * its fallback ordinal, so its "Account N" part is localized too.
 */
export function localizeAccount(account: AccountRowDto, dictionary: Translation): AccountRowDto {
  const institution = account.institutionKey ? dictionary.institutions[account.institutionKey] : account.institution;
  const product = (dictionary.accountProducts as Record<string, string>)[account.product] ?? account.product;
  const prefix = `${account.institution} · ${account.product}`;
  const label = account.unidentifiedOrdinal !== undefined
    ? `${institution} · ${product} · ${dictionary.unidentifiedAccount(account.unidentifiedOrdinal)}`
    : account.label.startsWith(prefix)
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

/** `Institution · Product · last four digits`, as account modals title themselves. */
export function accountModalTitle(account: AccountRowDto, dictionary: Translation): string {
  const { institution, product } = localizeAccount(account, dictionary);
  return [institution, product, maskedAccountDigits(account.label)].filter(Boolean).join(" · ");
}
