import { DEFAULT_LEDGER_DIR } from "../../../ledger/db/client.ts";
import type { CanonicalOverviewExpectedSource } from "../../../ledger/canonical/canonical-overview-query.ts";
import type { AssetsPageDto } from "../types.ts";
import { configuredOverviewSources } from "../../overview/server/expected-sources.ts";
import { mapCanonicalProduct } from "../../shared-ledger/server/canonical-product.ts";
import { createFinancialQuery } from "../../shared-ledger/server/financial-query.ts";

export async function loadAssets(
  ledgerDir = DEFAULT_LEDGER_DIR,
  input: { expectedSources?: readonly CanonicalOverviewExpectedSource[] } = {},
): Promise<AssetsPageDto> {
  const expectedSources = input.expectedSources ?? configuredOverviewSources();
  const result = await createFinancialQuery(ledgerDir).current({
    kind: "current",
    product: "assets",
    expectedSources,
  });
  return mapCanonicalProduct(result.projection, "assets");
}
