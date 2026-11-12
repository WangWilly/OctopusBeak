import type {
  FinancialPageActionReply,
  FinancialPageActionRequest,
  FinancialPageActionResult,
} from "../../lib/financial/page-actions.ts";

/**
 * The Financial page actions that run against one store, and when they
 * settle. Every Financial page writes through them; each page decides how to
 * take a settled action, and holds its recompute while actions run
 * (ADR 0105, ADR 0136).
 */
export type FinancialPageActions = Readonly<{
  run(request: FinancialPageActionRequest): Promise<FinancialPageActionReply>;
  /** Whether an action is still running; a page recompute waits for it. */
  inFlight(): boolean;
  /**
   * Hears once each time the last running action settles, with the newest
   * result among the actions that overlapped, or null when none committed.
   */
  onSettled(listener: (result: FinancialPageActionResult | null) => void): () => void;
}>;

export function createFinancialPageActions(
  apply: (request: FinancialPageActionRequest) => Promise<FinancialPageActionReply>,
): FinancialPageActions {
  let running = 0;
  let newest: FinancialPageActionResult | null = null;
  const listeners = new Set<(result: FinancialPageActionResult | null) => void>();
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

