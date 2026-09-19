import { DEFAULT_LEDGER_DIR } from "../../../ledger/db/client.ts";
import type { CanonicalOverviewExpectedSource } from "../../../ledger/canonical/canonical-overview-query.ts";
import type {
  LiabilitiesPageDto,
  LiabilitiesPrimaryDto,
  LiabilitiesPrimarySection,
  LiabilitiesSecondaryDto,
  LiabilitiesSecondarySection,
} from "../types.ts";
import { configuredOverviewSources } from "../../overview/server/expected-sources.ts";
import { mapCanonicalProduct } from "../../shared-ledger/server/canonical-product.ts";
import { createFinancialQuery } from "../../shared-ledger/server/financial-query.ts";
import type {
  FinancialQueryCutoff,
  FinancialQuerySection,
} from "../../shared-ledger/server/financial-query.ts";
import {
  assertMatchingFinancialSectionKnowledgePoints,
  createFinancialSectionResult,
  type FinancialSectionQueryInput,
} from "../../shared-ledger/financial-section.ts";

export async function loadLiabilities(
  ledgerDir = DEFAULT_LEDGER_DIR,
  input: {
    expectedSources?: readonly CanonicalOverviewExpectedSource[];
    cutoff?: FinancialQueryCutoff;
    section?: FinancialQuerySection;
  } = {},
): Promise<LiabilitiesPageDto> {
  const expectedSources = input.expectedSources ?? configuredOverviewSources();
  const result = await createFinancialQuery(ledgerDir).current({
    kind: "current",
    product: "liabilities",
    expectedSources,
    cutoff: input.cutoff,
    section: input.section,
  });
  return mapCanonicalProduct(result.projection, "liabilities");
}

export function loadLiabilitiesSection(
  section: "primary",
  ledgerDir?: string,
  input?: FinancialSectionQueryInput & {
    expectedSources?: readonly CanonicalOverviewExpectedSource[];
  },
): Promise<LiabilitiesPrimarySection>;
export function loadLiabilitiesSection(
  section: "secondary",
  ledgerDir?: string,
  input?: FinancialSectionQueryInput & {
    expectedSources?: readonly CanonicalOverviewExpectedSource[];
  },
): Promise<LiabilitiesSecondarySection>;
export function loadLiabilitiesSection(
  section: "primary" | "secondary",
  ledgerDir?: string,
  input?: FinancialSectionQueryInput & {
    expectedSources?: readonly CanonicalOverviewExpectedSource[];
  },
): Promise<LiabilitiesPrimarySection | LiabilitiesSecondarySection>;
export async function loadLiabilitiesSection(
  section: "primary" | "secondary",
  ledgerDir = DEFAULT_LEDGER_DIR,
  input: FinancialSectionQueryInput & {
    expectedSources?: readonly CanonicalOverviewExpectedSource[];
  } = {},
): Promise<LiabilitiesPrimarySection | LiabilitiesSecondarySection> {
  const page = await loadLiabilities(ledgerDir, { ...input, section });
  return section === "primary"
    ? createFinancialSectionResult(section, liabilitiesPrimary(page))
    : createFinancialSectionResult(section, liabilitiesSecondary(page));
}

export function combineLiabilitiesSections(
  primary: LiabilitiesPrimarySection,
  secondary: LiabilitiesSecondarySection,
): LiabilitiesPageDto {
  assertMatchingFinancialSectionKnowledgePoints(primary, secondary);
  return {
    ...primary.value,
    ...secondary.value,
    knowledgePoint: primary.knowledgePoint,
  };
}

function liabilitiesPrimary(page: LiabilitiesPageDto): LiabilitiesPrimaryDto {
  const runtimePage = page as LiabilitiesPageDto & { positionsByAccount: Record<string, unknown> };
  return {
    knowledgePoint: page.knowledgePoint ?? 0,
    availability: page.availability,
    coverage: page.coverage,
    sourceGaps: page.sourceGaps,
    importedAt: page.importedAt,
    accounts: page.accounts,
    marginAccounts: page.marginAccounts,
    positionsByAccount: runtimePage.positionsByAccount,
    transactionsByAccount: page.transactionsByAccount,
  } as LiabilitiesPrimaryDto;
}

function liabilitiesSecondary(page: LiabilitiesPageDto): LiabilitiesSecondaryDto {
  return {
    knowledgePoint: page.knowledgePoint ?? 0,
    dailyHistoryByAccount: page.dailyHistoryByAccount,
    dailyHistory: page.dailyHistory,
  };
}
