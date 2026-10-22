import type { Translation } from "../i18n/i18n.ts";
import type { OverviewPageDto } from "../overview/types.ts";
import { localizeAccount } from "../shared-accounts/localize-account.ts";

/** The imported accounts under these namespaces that have no current value in the current overview, labeled for the interface language. */
export function unvaluedAccountLabels(
  integrationNamespaces: readonly string[],
  overview: Pick<OverviewPageDto, "accounts" | "sourceGaps">,
  dictionary: Translation,
): string[] {
  const namespaces = new Set(integrationNamespaces);
  const accounts = new Map(overview.accounts.map((account) => [account.id, account]));
  return overview.sourceGaps.flatMap((gap) => {
    if (gap.reason !== "current-value-not-observed" || !gap.integrationNamespace || !namespaces.has(gap.integrationNamespace)) return [];
    const account = accounts.get(gap.accountId);
    return account ? [localizeAccount(account, dictionary).label] : [];
  });
}
