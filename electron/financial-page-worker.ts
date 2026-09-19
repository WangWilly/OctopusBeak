import { parentPort } from "node:worker_threads";
import { loadAssets, loadAssetsSection } from "../src/lib/assets/server/load-assets.ts";
import { loadLiabilities, loadLiabilitiesSection } from "../src/lib/liabilities/server/load-liabilities.ts";
import { loadOverview, loadOverviewSection } from "../src/lib/overview/server/load-overview.ts";
import { configuredOverviewSources } from "../src/lib/overview/server/expected-sources.ts";
import {
  confirmSpendingCandidate,
  denySpendingCandidate,
  loadSpending,
  loadSpendingSection,
  revokeSpendingLink,
} from "../src/lib/spending/server/store.ts";
import type {
  FinancialPageRequest,
  FinancialPageResponse,
} from "./financial-page-worker-client.ts";

if (!parentPort) throw new Error("Financial page worker requires a parent port.");
const port = parentPort;

port.on("message", async (request: FinancialPageRequest) => {
  let response: FinancialPageResponse;
  const requestToken = "requestToken" in request ? request.requestToken : undefined;
  try {
    let value: unknown;
    switch (request.page) {
      case "overview":
        value = await loadOverview(undefined, {
          expectedSources: configuredOverviewSources(),
          cutoff: request.input?.cutoff,
        });
        break;
      case "assets":
        value = await loadAssets(undefined, request.input);
        break;
      case "liabilities":
        value = await loadLiabilities(undefined, request.input);
        break;
      case "spending":
        value = loadSpending(undefined, request.input);
        break;
      case "overview-section":
        value = await loadOverviewSection(request.section, undefined, {
          ...request.input,
          expectedSources: configuredOverviewSources(),
        });
        break;
      case "assets-section":
        value = await loadAssetsSection(request.section, undefined, request.input);
        break;
      case "liabilities-section":
        value = await loadLiabilitiesSection(request.section, undefined, request.input);
        break;
      case "spending-section":
        value = loadSpendingSection(request.section, undefined, request.input);
        break;
      case "spending-action":
        value = request.action === "confirmCandidate"
          ? confirmSpendingCandidate(request.input as Parameters<typeof confirmSpendingCandidate>[0])
          : request.action === "denyCandidate"
            ? denySpendingCandidate(request.input as Parameters<typeof denySpendingCandidate>[0])
            : revokeSpendingLink(request.input as Parameters<typeof revokeSpendingLink>[0]);
        break;
    }
    response = {
      id: request.id,
      ok: true,
      value,
      ...(requestToken === undefined ? {} : { requestToken }),
    };
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(requestToken === undefined ? {} : { requestToken }),
    };
  }
  port.postMessage(response);
});
