import { BANK_STATEMENT_CAPABILITIES } from "../../lib/automation/statement-selection.ts";
import type { StatementSelectionGroup } from "../../lib/automation/statement-selection.ts";
import {
  FOREIGN_CURRENCY_DEPOSIT_CONTRACTS,
  FOREIGN_CURRENCY_DEPOSIT_SOURCE_IDS,
  type ForeignCurrencyDepositSourceId,
} from "./foreign-currency-deposit.ts";

const FOREIGN_CURRENCY_DEPOSIT_STATEMENT_TYPE_IDS = new Set([
  "foreign_currency",
  "foreign",
  "accounts",
]);

export type AdvertisedForeignCurrencyDepositSourceId =
  ForeignCurrencyDepositSourceId;

export type AdvertisedForeignCurrencyDepositReadinessEntry = {
  sourceId: AdvertisedForeignCurrencyDepositSourceId;
  advertisedName: string;
  workflow: string;
  authority: string;
  contractVersion: string;
  fixtureEvidence: "canonical-versioned-synthetic";
  accountBoundary: "source-proven-account";
  currencyScope: "row-or-typed-scope";
  amountDirection: "source-proven-debit-credit";
  timePrecision: "source-preserved-date-minute-second";
  completeness: "terminal-complete-range";
  blockers: readonly [];
};

export type AdvertisedForeignCurrencyDepositReadinessGate = {
  status: "blocked" | "release-ready";
  releaseReady: boolean;
  advertisedSourceCount: number;
  unreadySourceIds: AdvertisedForeignCurrencyDepositSourceId[];
};

type ForeignCurrencyRegistry = Record<string, StatementSelectionGroup>;

export function advertisedForeignCurrencyDepositSourceIds(
  registry: ForeignCurrencyRegistry,
): AdvertisedForeignCurrencyDepositSourceId[] {
  return Object.values(registry)
    .filter((group) =>
      group.statementTypes.some((type) =>
        FOREIGN_CURRENCY_DEPOSIT_STATEMENT_TYPE_IDS.has(type.id),
      ),
    )
    .map((group) => group.id)
    .filter(
      (sourceId): sourceId is AdvertisedForeignCurrencyDepositSourceId =>
        (FOREIGN_CURRENCY_DEPOSIT_SOURCE_IDS as readonly string[]).includes(
          sourceId,
        ),
    );
}

const foreignCurrencyRegistrySourceIds = advertisedForeignCurrencyDepositSourceIds(
  BANK_STATEMENT_CAPABILITIES,
);
if (
  foreignCurrencyRegistrySourceIds.length !== FOREIGN_CURRENCY_DEPOSIT_SOURCE_IDS.length ||
  !FOREIGN_CURRENCY_DEPOSIT_SOURCE_IDS.every((sourceId) =>
    foreignCurrencyRegistrySourceIds.includes(sourceId),
  )
) {
  throw new Error(
    "Advertised foreign-currency deposit registry coverage is incomplete.",
  );
}

export const ADVERTISED_FOREIGN_CURRENCY_DEPOSIT_SOURCE_IDS =
  foreignCurrencyRegistrySourceIds;

export const ADVERTISED_FOREIGN_CURRENCY_DEPOSIT_READINESS =
  ADVERTISED_FOREIGN_CURRENCY_DEPOSIT_SOURCE_IDS.map(
    (sourceId): AdvertisedForeignCurrencyDepositReadinessEntry => {
      const advertised = Object.values(BANK_STATEMENT_CAPABILITIES).find(
        (group) => group.id === sourceId,
      );
      if (!advertised)
        throw new Error(`Missing advertised foreign source ${sourceId}.`);
      const contract = FOREIGN_CURRENCY_DEPOSIT_CONTRACTS[sourceId];
      return {
        sourceId,
        advertisedName: advertised.label,
        workflow: contract.workflow,
        authority: contract.authorityRoute,
        contractVersion: contract.contractVersion,
        fixtureEvidence: "canonical-versioned-synthetic",
        accountBoundary: "source-proven-account",
        currencyScope: "row-or-typed-scope",
        amountDirection: "source-proven-debit-credit",
        timePrecision: "source-preserved-date-minute-second",
        completeness: "terminal-complete-range",
        blockers: [],
      };
    },
  );

export function isAdvertisedForeignCurrencyDepositEntryReleaseReady(
  entry: AdvertisedForeignCurrencyDepositReadinessEntry,
): boolean {
  return (
    entry.fixtureEvidence === "canonical-versioned-synthetic" &&
    entry.accountBoundary === "source-proven-account" &&
    entry.currencyScope === "row-or-typed-scope" &&
    entry.amountDirection === "source-proven-debit-credit" &&
    entry.timePrecision === "source-preserved-date-minute-second" &&
    entry.completeness === "terminal-complete-range" &&
    entry.blockers.length === 0
  );
}

export function evaluateAdvertisedForeignCurrencyDepositReadiness(
  entries: readonly AdvertisedForeignCurrencyDepositReadinessEntry[] =
    ADVERTISED_FOREIGN_CURRENCY_DEPOSIT_READINESS,
): AdvertisedForeignCurrencyDepositReadinessGate {
  const unreadySourceIds = entries
    .filter((entry) => !isAdvertisedForeignCurrencyDepositEntryReleaseReady(entry))
    .map((entry) => entry.sourceId);
  return {
    status: unreadySourceIds.length === 0 ? "release-ready" : "blocked",
    releaseReady: unreadySourceIds.length === 0,
    advertisedSourceCount: entries.length,
    unreadySourceIds,
  };
}
