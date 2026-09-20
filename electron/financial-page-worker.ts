import { parentPort } from "node:worker_threads";
import { loadAssets } from "../src/lib/assets/server/load-assets.ts";
import { loadLiabilities } from "../src/lib/liabilities/server/load-liabilities.ts";
import { loadOverview } from "../src/lib/overview/server/load-overview.ts";
import { configuredOverviewSources } from "../src/lib/overview/server/expected-sources.ts";
import {
  applyAutomationCredentialState,
  loadAutomationCoreSnapshot,
} from "../src/lib/automation/server/desktop-api.ts";
import {
  createFinancialPageBlockLoader,
  type FinancialBlockTarget,
} from "./financial-page-block-loader.ts";
import {
  confirmSpendingCandidate,
  denySpendingCandidate,
  loadSpending,
  prewarmSpendingPairingCandidates,
  rankSpendingPaymentCandidates,
  revokeSpendingLink,
} from "../src/lib/spending/server/store.ts";
import type {
  FinancialPageRequest,
  FinancialPageResponse,
} from "./financial-page-worker-client.ts";

if (!parentPort) throw new Error("Financial page worker requires a parent port.");
const port = parentPort;

const blockLoader = createFinancialPageBlockLoader(async (target, _options, context) => {
  if (target === "automation") {
    const core = loadAutomationCoreSnapshot(
      undefined,
      context?.automationCredentialState?.status,
      context?.automationRuntimeState,
      context?.automationCredentialState?.states,
    );
    return context?.automationCredentialState
      ? applyAutomationCredentialState(core, context.automationCredentialState)
      : core;
  }
  if (target === "overview") {
    return loadOverview(undefined, { expectedSources: configuredOverviewSources() });
  }
  if (target === "assets") {
    return loadAssets(undefined, { expectedSources: configuredOverviewSources() });
  }
  if (target === "liabilities") {
    return loadLiabilities(undefined, { expectedSources: configuredOverviewSources() });
  }
  return loadSpending();
});
const activePairingPrewarmCancellations = new Set<() => void>();

port.postMessage({ id: 0, ok: true, value: { ready: true } });

port.on("message", async (request: FinancialPageRequest) => {
  if (request.page === "spending-pairing") {
    for (const cancel of activePairingPrewarmCancellations) cancel();
  }
  let response: FinancialPageResponse;
  try {
    let value: unknown;
    if (request.page === "spending-pairing-prewarm") {
      let cancelled = false;
      const cancel = () => { cancelled = true; };
      activePairingPrewarmCancellations.add(cancel);
      try {
        value = await prewarmSpendingPairingCandidates(request.input, undefined, () => cancelled);
      } finally {
        activePairingPrewarmCancellations.delete(cancel);
      }
    } else {
      value = request.page === "block"
        ? await blockLoader.load(
          request.target,
          request.block,
          request.options,
          request.target === "automation"
            ? {
              automationCredentialState: request.automationCredentialState,
              automationRuntimeState: request.automationRuntimeState,
            }
            : undefined,
        )
        : request.page === "overview"
        ? await loadOverview(undefined, { expectedSources: configuredOverviewSources() })
        : request.page === "assets"
          ? await loadAssets()
          : request.page === "liabilities"
            ? await loadLiabilities()
            : request.page === "spending-pairing"
              ? rankSpendingPaymentCandidates(request.input)
              : request.page === "spending-action"
                ? request.action === "confirmCandidate"
                  ? confirmSpendingCandidate(request.input as Parameters<typeof confirmSpendingCandidate>[0])
                  : request.action === "denyCandidate"
                    ? denySpendingCandidate(request.input as Parameters<typeof denySpendingCandidate>[0])
                    : revokeSpendingLink(request.input as Parameters<typeof revokeSpendingLink>[0])
                : loadSpending(undefined, request.input);
    }
    response = { id: request.id, ok: true, value };
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  port.postMessage(response);
});
