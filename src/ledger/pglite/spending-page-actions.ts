import type { FinancialPageActionResult } from "../../lib/financial/page-actions.ts";
import {
  reconcileSpendingPageActionSummary,
  spendingCanonicalAt,
  type SpendingPageDto,
} from "../../lib/spending/model.ts";
import { spendingPageBehind, type SpendingPageVersion } from "./spending-page.ts";

/**
 * How the Spending page takes a settled Financial page action (ADR 0105,
 * ADR 0136): the action's result carries its exact summary delta, so the
 * live page takes that delta instead of reading the whole page again.
 */

/**
 * The published page with an action's summary delta applied. `page` is null
 * when nothing new is published; `published` says whether the page now shows
 * the action, so a page that cannot take the delta is read again instead.
 */
export function spendingPageAfterAction(
  previous: SpendingPageDto | undefined,
  result: FinancialPageActionResult,
): Readonly<{ page: SpendingPageDto | null; published: boolean }> {
  if (!previous?.purchaseReport.summary)
    return { page: null, published: previous?.purchaseReport.knowledgeAt === result.knowledgeAt };
  try {
    const reconciliation = reconcileSpendingPageActionSummary(
      previous.purchaseReport.summary,
      previous.purchaseReport.knowledgeAt,
      result,
    );
    if (reconciliation.state === "newer-live-version") return { page: null, published: false };
    if (reconciliation.state === "already-current") return { page: null, published: true };
    const { summary } = reconciliation;
    return {
      page: Object.freeze({
        ...previous,
        canonical: spendingCanonicalAt(previous.canonical, summary, result.knowledgeAt),
        purchaseReport: Object.freeze({
          ...previous.purchaseReport,
          knowledgeAt: result.knowledgeAt,
          totalsByCurrency: summary.totalsByCurrency,
          summary,
        }),
      }) satisfies SpendingPageDto,
      published: true,
    };
  } catch {
    // The delta does not apply to this page, so the page is read again instead.
    return { page: null, published: false };
  }
}

/**
 * Whether the page must be read again once actions settle: the store moved
 * past it, which a commit or manual write during the actions does, or the
 * settled action's result never reached it.
 */
export function spendingPageNeedsRecompute(
  page: SpendingPageDto | undefined,
  version: SpendingPageVersion,
  settled: Readonly<{ result: FinancialPageActionResult; published: boolean }> | null,
): boolean {
  if (spendingPageBehind(page, version)) return true;
  return settled !== null && !settled.published && version.knowledgeAt >= settled.result.knowledgeAt;
}
