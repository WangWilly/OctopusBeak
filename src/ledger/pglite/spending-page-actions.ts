import {
  reconcileSpendingPageActionSummary,
  spendingCanonicalAt,
  type SpendingPageActionReply,
  type SpendingPageActionRequest,
  type SpendingPageActionResult,
  type SpendingPageDto,
} from "../../lib/spending/model.ts";
import { spendingPageBehind, type SpendingPageVersion } from "./spending-page.ts";

/**
 * How a Spending page action reaches the published Spending page (ADR 0105).
 * An action's own result carries its exact summary delta, so the live page
 * takes that delta instead of reading the whole page again, and holds its
 * recompute while actions run.
 */

/** The page actions that run against one store, and when they settle. */
export type SpendingPageActions = Readonly<{
  run(request: SpendingPageActionRequest): Promise<SpendingPageActionReply>;
  /** Whether an action is still running; a page recompute waits for it. */
  inFlight(): boolean;
  /**
   * Hears once each time the last running action settles, with the newest
   * result among the actions that overlapped, or null when none committed.
   */
  onSettled(listener: (result: SpendingPageActionResult | null) => void): () => void;
}>;

export function createSpendingPageActions(
  apply: (request: SpendingPageActionRequest) => Promise<SpendingPageActionReply>,
): SpendingPageActions {
  let running = 0;
  let newest: SpendingPageActionResult | null = null;
  const listeners = new Set<(result: SpendingPageActionResult | null) => void>();
  return Object.freeze({
    run(request) {
      if (running === 0) newest = null;
      running += 1;
      return apply(request).then((reply) => {
        // A strong batch's conflict wrote nothing, so the page has nothing to take.
        if (reply.status === "committed" && (!newest || reply.knowledgeAt >= newest.knowledgeAt)) newest = reply;
        return reply;
      }).finally(() => {
        running -= 1;
        if (running !== 0) return;
        const settled = newest;
        newest = null;
        for (const listener of listeners) {
          try {
            listener(settled);
          } catch {
            // A listener cannot change the action's result or the other listeners.
          }
        }
      });
    },
    inFlight: () => running > 0,
    onSettled(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
}

/**
 * The published page with an action's summary delta applied. `page` is null
 * when nothing new is published; `published` says whether the page now shows
 * the action, so a page that cannot take the delta is read again instead.
 */
export function spendingPageAfterAction(
  previous: SpendingPageDto | undefined,
  result: SpendingPageActionResult,
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
  settled: Readonly<{ result: SpendingPageActionResult; published: boolean }> | null,
): boolean {
  if (spendingPageBehind(page, version)) return true;
  return settled !== null && !settled.published && version.knowledgeAt >= settled.result.knowledgeAt;
}
