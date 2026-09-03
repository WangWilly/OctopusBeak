import { BANK_STATEMENT_CAPABILITIES } from "../../lib/automation/statement-selection.ts";
import {
  ADVERTISED_INVESTMENT_SOURCE_IDS,
  type InvestmentSourceId,
} from "./investment-financial.ts";

export type AdvertisedInvestmentReadinessEntry = {
  sourceId: InvestmentSourceId;
  advertisedName: string;
  statementType: "fund" | "brokerage" | "crypto";
  workflow: "yuantaFundStatements" | "yuantaTradeStatements" | "syncMaicoin";
  authority: string;
  accountBoundary: "source-scoped-investment-account";
  securityIdentity: "producer-scoped-stable-key";
  holdingMeasurement: "independent-effective-and-observation-time";
  transactionSemantics: "required-buy-sell-fail-closed";
  marginDebt: "independent-loan-or-margin-loan-observation";
  fundingRelation: "typed-evidence-reserved-no-inference";
  contractComplete: boolean;
  liveValidation: "pending" | "complete";
  blockers: readonly "human-assisted-live-validation-pending"[];
};

const manifests: Record<
  InvestmentSourceId,
  Omit<AdvertisedInvestmentReadinessEntry, "advertisedName">
> = {
  "yuanta-fund": {
    sourceId: "yuanta-fund",
    statementType: "fund",
    workflow: "yuantaFundStatements",
    authority: "yuanta-fund/investment/canonical-v1",
    accountBoundary: "source-scoped-investment-account",
    securityIdentity: "producer-scoped-stable-key",
    holdingMeasurement: "independent-effective-and-observation-time",
    transactionSemantics: "required-buy-sell-fail-closed",
    marginDebt: "independent-loan-or-margin-loan-observation",
    fundingRelation: "typed-evidence-reserved-no-inference",
    contractComplete: true,
    liveValidation: "complete",
    blockers: [],
  },
  "yuanta-trade": {
    sourceId: "yuanta-trade",
    statementType: "brokerage",
    workflow: "yuantaTradeStatements",
    authority: "yuanta-trade/investment/canonical-v1",
    accountBoundary: "source-scoped-investment-account",
    securityIdentity: "producer-scoped-stable-key",
    holdingMeasurement: "independent-effective-and-observation-time",
    transactionSemantics: "required-buy-sell-fail-closed",
    marginDebt: "independent-loan-or-margin-loan-observation",
    fundingRelation: "typed-evidence-reserved-no-inference",
    contractComplete: true,
    liveValidation: "complete",
    blockers: [],
  },
  maicoin: {
    sourceId: "maicoin",
    statementType: "crypto",
    workflow: "syncMaicoin",
    authority: "maicoin/investment/canonical-v1",
    accountBoundary: "source-scoped-investment-account",
    securityIdentity: "producer-scoped-stable-key",
    holdingMeasurement: "independent-effective-and-observation-time",
    transactionSemantics: "required-buy-sell-fail-closed",
    marginDebt: "independent-loan-or-margin-loan-observation",
    fundingRelation: "typed-evidence-reserved-no-inference",
    contractComplete: true,
    liveValidation: "complete",
    blockers: [],
  },
};

function advertisedLabel(sourceId: InvestmentSourceId): string {
  if (sourceId === "maicoin") return "MaiCoin crypto";
  const registryId = sourceId === "yuanta-fund" ? "yuanta" : "yuanta-trade";
  const statementType = sourceId === "yuanta-fund" ? "fund" : "brokerage";
  const group = BANK_STATEMENT_CAPABILITIES[registryId];
  if (!group.statementTypes.some((entry) => entry.id === statementType))
    throw new Error(`Investment source ${sourceId} is no longer advertised.`);
  return `${group.label} ${statementType}`;
}

export const ADVERTISED_INVESTMENT_READINESS: readonly AdvertisedInvestmentReadinessEntry[] =
  Object.freeze(
    ADVERTISED_INVESTMENT_SOURCE_IDS.map((sourceId) => ({
      ...manifests[sourceId],
      advertisedName: advertisedLabel(sourceId),
    })),
  );

export function evaluateAdvertisedInvestmentReadiness(
  entries = ADVERTISED_INVESTMENT_READINESS,
) {
  const contractIncompleteSourceIds = entries
    .filter((entry) => !entry.contractComplete)
    .map((entry) => entry.sourceId);
  const pendingLiveValidationSourceIds = entries
    .filter((entry) => entry.liveValidation !== "complete")
    .map((entry) => entry.sourceId);
  return {
    status:
      contractIncompleteSourceIds.length || pendingLiveValidationSourceIds.length
      ? ("blocked" as const)
      : ("release-ready" as const),
    contractIncompleteSourceIds,
    pendingLiveValidationSourceIds,
    entries,
  };
}
