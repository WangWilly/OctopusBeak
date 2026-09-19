import { DEFAULT_LEDGER_DIR } from "../../../ledger/db/client.ts";
import type { CanonicalOverviewExpectedSource } from "../../../ledger/canonical/canonical-overview-query.ts";
import type {
  AssetsPageDto,
  AssetsPrimaryDto,
  AssetsPrimarySection,
  AssetsSecondaryDto,
  AssetsSecondarySection,
} from "../types.ts";
import { configuredOverviewSources } from "../../overview/server/expected-sources.ts";
import { mapCanonicalProduct } from "../../shared-ledger/server/canonical-product.ts";
import { createFinancialQuery } from "../../shared-ledger/server/financial-query.ts";
import type {
  FinancialQueryCutoff,
  FinancialQuerySection,
} from "../../shared-ledger/server/financial-query.ts";
import type { AccountRowDto } from "../../shared-ledger/types.ts";
import {
  assertMatchingFinancialSectionKnowledgePoints,
  createFinancialSectionResult,
  type FinancialSectionQueryInput,
} from "../../shared-ledger/financial-section.ts";

export async function loadAssets(
  ledgerDir = DEFAULT_LEDGER_DIR,
  input: {
    expectedSources?: readonly CanonicalOverviewExpectedSource[];
    cutoff?: FinancialQueryCutoff;
    section?: FinancialQuerySection;
  } = {},
): Promise<AssetsPageDto> {
  const expectedSources = input.expectedSources ?? configuredOverviewSources();
  const result = await createFinancialQuery(ledgerDir).current({
    kind: "current",
    product: "assets",
    expectedSources,
    cutoff: input.cutoff,
    section: input.section,
  });
  return mapCanonicalProduct(result.projection, "assets");
}

export function loadAssetsSection(
  section: "primary",
  ledgerDir?: string,
  input?: FinancialSectionQueryInput & {
    expectedSources?: readonly CanonicalOverviewExpectedSource[];
  },
): Promise<AssetsPrimarySection>;
export function loadAssetsSection(
  section: "secondary",
  ledgerDir?: string,
  input?: FinancialSectionQueryInput & {
    expectedSources?: readonly CanonicalOverviewExpectedSource[];
  },
): Promise<AssetsSecondarySection>;
export function loadAssetsSection(
  section: "primary" | "secondary",
  ledgerDir?: string,
  input?: FinancialSectionQueryInput & {
    expectedSources?: readonly CanonicalOverviewExpectedSource[];
  },
): Promise<AssetsPrimarySection | AssetsSecondarySection>;
export async function loadAssetsSection(
  section: "primary" | "secondary",
  ledgerDir = DEFAULT_LEDGER_DIR,
  input: FinancialSectionQueryInput & {
    expectedSources?: readonly CanonicalOverviewExpectedSource[];
  } = {},
): Promise<AssetsPrimarySection | AssetsSecondarySection> {
  const page = await loadAssets(ledgerDir, { ...input, section });
  return section === "primary"
    ? createFinancialSectionResult(section, assetsPrimary(page))
    : createFinancialSectionResult(section, assetsSecondary(page));
}

export function combineAssetsSections(
  primary: AssetsPrimarySection,
  secondary: AssetsSecondarySection,
): AssetsPageDto {
  assertMatchingFinancialSectionKnowledgePoints(primary, secondary);
  return {
    ...primary.value,
    ...secondary.value,
    knowledgePoint: primary.knowledgePoint,
  };
}

function assetsPrimary(page: AssetsPageDto): AssetsPrimaryDto {
  const runtimePage = page as AssetsPageDto & { marginAccounts: AccountRowDto[] };
  return {
    knowledgePoint: page.knowledgePoint ?? 0,
    availability: page.availability,
    coverage: page.coverage,
    sourceGaps: page.sourceGaps,
    importedAt: page.importedAt,
    accounts: page.accounts,
    marginAccounts: runtimePage.marginAccounts,
    positionsByAccount: page.positionsByAccount,
    transactionsByAccount: page.transactionsByAccount,
  } as AssetsPrimaryDto;
}

function assetsSecondary(page: AssetsPageDto): AssetsSecondaryDto {
  return {
    knowledgePoint: page.knowledgePoint ?? 0,
    dailyHistoryByAccount: page.dailyHistoryByAccount,
    dailyHistory: page.dailyHistory,
  };
}
