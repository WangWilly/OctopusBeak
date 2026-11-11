import type { SpendingCandidatePageRequest, SpendingPairingPrewarmInput } from "../model.ts";
import type { PGliteFinancialPort } from "../../pglite-rpc/pglite-financial-contracts.ts";
import { prewarmPGlitePairingCandidates } from "../../../../electron/pglite-financial-registry.ts";

/** Everything the spending desktop service reaches outside itself. */
export type SpendingDesktopServiceDeps = Readonly<{
  financial: PGliteFinancialPort;
}>;

export type SpendingDesktopService = ReturnType<typeof createSpendingDesktopService>;

export function createSpendingDesktopService({ financial }: SpendingDesktopServiceDeps) {
  const candidatePageControllers = new Map<string, AbortController>();
  return {
    async loadCandidatePage(request: SpendingCandidatePageRequest, requestId: unknown) {
      if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 160)
        throw new TypeError("Spending candidate page request id is invalid.");
      if (candidatePageControllers.has(requestId))
        throw new Error("Spending candidate page request id is already active.");
      const controller = new AbortController();
      candidatePageControllers.set(requestId, controller);
      try {
        return await financial.request("financial.spending.candidatePage", [request], { signal: controller.signal });
      } finally {
        if (candidatePageControllers.get(requestId) === controller)
          candidatePageControllers.delete(requestId);
      }
    },
    cancelCandidatePage(requestId: unknown) {
      if (typeof requestId !== "string") return false;
      const controller = candidatePageControllers.get(requestId);
      if (!controller) return false;
      controller.abort();
      return true;
    },
    prewarmPairingCandidates: (input: SpendingPairingPrewarmInput) =>
      prewarmPGlitePairingCandidates(financial, input),
  };
}
