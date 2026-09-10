import { parentPort } from "node:worker_threads";
import { loadAssets } from "../src/lib/assets/server/load-assets.ts";
import { loadLiabilities } from "../src/lib/liabilities/server/load-liabilities.ts";
import { loadOverview } from "../src/lib/overview/server/load-overview.ts";
import { configuredOverviewSources } from "../src/lib/overview/server/expected-sources.ts";
import { loadSpending } from "../src/lib/spending/server/store.ts";
import type {
  FinancialPageRequest,
  FinancialPageResponse,
} from "./financial-page-worker-client.ts";

if (!parentPort) throw new Error("Financial page worker requires a parent port.");
const port = parentPort;

port.on("message", async (request: FinancialPageRequest) => {
  let response: FinancialPageResponse;
  try {
    const value = request.page === "overview"
      ? await loadOverview(undefined, { expectedSources: configuredOverviewSources() })
      : request.page === "assets"
        ? await loadAssets()
        : request.page === "liabilities"
          ? await loadLiabilities()
          : loadSpending(undefined, request.input);
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
