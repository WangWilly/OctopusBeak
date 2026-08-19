import { BANK_STATEMENT_CAPABILITIES } from "../../lib/automation/statement-selection.ts";
import {
  ADVERTISED_DOMESTIC_DEPOSIT_SEMANTIC_BLOCKERS,
  type AdvertisedDomesticDepositPreflightResult,
  type AdvertisedDomesticDepositSemanticBlocker,
} from "./advertised-domestic-deposit-preflight.ts";
import {
  CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  CATHAY_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
} from "./cathay-domestic-deposit.ts";
import {
  CTBC_DOMESTIC_DEPOSIT_CONTRACT,
  CTBC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  preflightCtbcDomesticDeposit,
} from "./ctbc-domestic-deposit.ts";
import {
  FUBON_DOMESTIC_DEPOSIT_CONTRACT,
  FUBON_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  preflightFubonDomesticDeposit,
} from "./fubon-domestic-deposit.ts";
import {
  HNCB_DOMESTIC_DEPOSIT_CONTRACT,
  HNCB_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  preflightHncbDomesticDeposit,
} from "./hncb-domestic-deposit.ts";
import {
  LINEBANK_DOMESTIC_DEPOSIT_AUTHORITY,
  LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
  LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE,
  LINEBANK_DOMESTIC_DEPOSIT_READINESS,
  preflightLineBankDomesticDeposit,
  type LineBankPreflightDiagnosticCode,
} from "./linebank-domestic-deposit.ts";
import {
  POST_DOMESTIC_DEPOSIT_CONTRACT,
  POST_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  preflightPostDomesticDeposit,
} from "./post-domestic-deposit.ts";
import {
  SINOPAC_DOMESTIC_DEPOSIT_CONTRACT,
  SINOPAC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  preflightSinopacDomesticDeposit,
} from "./sinopac-domestic-deposit.ts";
import {
  YUANTA_DOMESTIC_DEPOSIT_CONTRACT,
  YUANTA_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  preflightYuantaDomesticDeposit,
} from "./yuanta-domestic-deposit.ts";

const DOMESTIC_DEPOSIT_STATEMENT_TYPE_IDS = new Set([
  "deposit",
  "domestic",
  "accounts",
]);

type StatementCapabilityRegistry = Record<
  string,
  {
    id: string;
    label: string;
    statementTypes: readonly { id: string }[];
  }
>;

/** Derive the release surface from the same capability registry as Settings. */
export function advertisedDomesticDepositSourceIds(
  registry: StatementCapabilityRegistry,
): string[] {
  return Object.values(registry)
    .filter((group) =>
      group.statementTypes.some((type) =>
        DOMESTIC_DEPOSIT_STATEMENT_TYPE_IDS.has(type.id),
      ),
    )
    .map((group) => group.id);
}

const SOURCE_MANIFESTS = {
  fubon: {
    authority: FUBON_DOMESTIC_DEPOSIT_CONTRACT.authority,
    contractVersion: FUBON_DOMESTIC_DEPOSIT_CONTRACT.contractVersion,
    workflow: FUBON_DOMESTIC_DEPOSIT_CONTRACT.workflow,
    capability: FUBON_DOMESTIC_DEPOSIT_CONTRACT.readiness,
    fixtureResult: () =>
      preflightFubonDomesticDeposit(
        FUBON_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
      ),
    liveValidation: "pending",
  },
  yuanta: {
    authority: YUANTA_DOMESTIC_DEPOSIT_CONTRACT.authority,
    contractVersion: YUANTA_DOMESTIC_DEPOSIT_CONTRACT.contractVersion,
    workflow: YUANTA_DOMESTIC_DEPOSIT_CONTRACT.workflow,
    capability: YUANTA_DOMESTIC_DEPOSIT_CONTRACT.readiness,
    fixtureResult: () =>
      preflightYuantaDomesticDeposit(
        YUANTA_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
      ),
    liveValidation: "pending",
  },
  cathay: {
    authority: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
    contractVersion: CATHAY_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
    workflow: "cathayStatements",
    capability: "canonical-synthetic",
    fixtureResult: null,
    liveValidation: "pending",
  },
  hncb: {
    authority: HNCB_DOMESTIC_DEPOSIT_CONTRACT.authority,
    contractVersion: HNCB_DOMESTIC_DEPOSIT_CONTRACT.contractVersion,
    workflow: HNCB_DOMESTIC_DEPOSIT_CONTRACT.workflow,
    capability: HNCB_DOMESTIC_DEPOSIT_CONTRACT.readiness,
    fixtureResult: () =>
      preflightHncbDomesticDeposit(HNCB_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1),
    liveValidation: "pending",
  },
  ctbc: {
    authority: CTBC_DOMESTIC_DEPOSIT_CONTRACT.authority,
    contractVersion: CTBC_DOMESTIC_DEPOSIT_CONTRACT.contractVersion,
    workflow: CTBC_DOMESTIC_DEPOSIT_CONTRACT.workflow,
    capability: CTBC_DOMESTIC_DEPOSIT_CONTRACT.readiness,
    fixtureResult: () =>
      preflightCtbcDomesticDeposit(CTBC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1),
    liveValidation: "pending",
  },
  post: {
    authority: POST_DOMESTIC_DEPOSIT_CONTRACT.authority,
    contractVersion: POST_DOMESTIC_DEPOSIT_CONTRACT.contractVersion,
    workflow: POST_DOMESTIC_DEPOSIT_CONTRACT.workflow,
    capability: POST_DOMESTIC_DEPOSIT_CONTRACT.readiness,
    fixtureResult: () =>
      preflightPostDomesticDeposit(POST_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1),
    liveValidation: "pending",
  },
  sinopac: {
    authority: SINOPAC_DOMESTIC_DEPOSIT_CONTRACT.authority,
    contractVersion: SINOPAC_DOMESTIC_DEPOSIT_CONTRACT.contractVersion,
    workflow: SINOPAC_DOMESTIC_DEPOSIT_CONTRACT.workflow,
    capability: SINOPAC_DOMESTIC_DEPOSIT_CONTRACT.readiness,
    fixtureResult: () =>
      preflightSinopacDomesticDeposit(
        SINOPAC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
      ),
    liveValidation: "pending",
  },
  linebank: {
    authority: LINEBANK_DOMESTIC_DEPOSIT_AUTHORITY,
    contractVersion: LINEBANK_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
    workflow: "linebankStatements",
    capability: LINEBANK_DOMESTIC_DEPOSIT_READINESS,
    fixtureResult: () =>
      preflightLineBankDomesticDeposit(
        LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE,
      ),
    liveValidation: "partial",
  },
} as const;

export type AdvertisedDomesticDepositSourceId = keyof typeof SOURCE_MANIFESTS;

export function assertAdvertisedDomesticDepositManifestCoverage(
  registrySourceIds: readonly string[],
  manifestSourceIds: readonly string[],
): void {
  const registry = new Set(registrySourceIds);
  const manifests = new Set(manifestSourceIds);
  const missing = registrySourceIds.filter(
    (sourceId) => !manifests.has(sourceId),
  );
  const removed = manifestSourceIds.filter(
    (sourceId) => !registry.has(sourceId),
  );
  if (missing.length > 0 || removed.length > 0) {
    throw new Error(
      [
        missing.length > 0
          ? `Missing advertised domestic source manifests: ${missing.join(", ")}`
          : "",
        removed.length > 0
          ? `Non-advertised domestic source manifests: ${removed.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("; "),
    );
  }
}

const registrySourceIds = advertisedDomesticDepositSourceIds(
  BANK_STATEMENT_CAPABILITIES,
);
const manifestSourceIds = Object.keys(SOURCE_MANIFESTS);
assertAdvertisedDomesticDepositManifestCoverage(
  registrySourceIds,
  manifestSourceIds,
);
export const ADVERTISED_DOMESTIC_DEPOSIT_SOURCE_IDS =
  registrySourceIds as AdvertisedDomesticDepositSourceId[];

const SEMANTIC_BLOCKER_SET = new Set<string>(
  ADVERTISED_DOMESTIC_DEPOSIT_SEMANTIC_BLOCKERS,
);

function semanticBlockersFromPreflight(
  result: AdvertisedDomesticDepositPreflightResult,
): AdvertisedDomesticDepositSemanticBlocker[] {
  if (result.status !== "blocked" || result.structuralStatus !== "observed") {
    throw new Error(`Invalid ${result.source} versioned preflight fixture.`);
  }
  return result.diagnostics
    .map(({ code }) => code)
    .filter((code): code is AdvertisedDomesticDepositSemanticBlocker =>
      SEMANTIC_BLOCKER_SET.has(code),
    );
}

const LINEBANK_DIAGNOSTIC_ADAPTER: Partial<
  Record<
    LineBankPreflightDiagnosticCode,
    AdvertisedDomesticDepositSemanticBlocker
  >
> = {
  "identity-continuity-unproven": "occurrence-identity-unproven",
  "direction-semantics-unproven": "direction-semantics-unproven",
  "posting-semantics-unproven": "posting-semantics-unproven",
  "effective-time-semantics-unproven": "effective-time-semantics-unproven",
};

function lineBankSemanticBlockers(): AdvertisedDomesticDepositSemanticBlocker[] {
  const result = SOURCE_MANIFESTS.linebank.fixtureResult();
  const blockers = new Set<AdvertisedDomesticDepositSemanticBlocker>([
    "account-identity-unproven",
    "completeness-semantics-unproven",
    "authority-semantics-unproven",
  ]);
  for (const { code } of result.diagnostics) {
    const adapted = LINEBANK_DIAGNOSTIC_ADAPTER[code];
    if (adapted) blockers.add(adapted);
  }
  return [...blockers];
}

export type AdvertisedDomesticDepositReadinessBlocker =
  "live-validation-pending" | AdvertisedDomesticDepositSemanticBlocker;

export type AdvertisedDomesticDepositReadinessEntry = {
  sourceId: AdvertisedDomesticDepositSourceId;
  advertisedName: string;
  workflow: string;
  authority: string;
  contractVersion: string;
  capability: "canonical-synthetic" | "preflight-only";
  fixtureEvidence:
    "canonical-versioned-synthetic" | "preflight-versioned-synthetic";
  liveValidation: "pending" | "partial" | "complete";
  semanticBlockers: readonly AdvertisedDomesticDepositSemanticBlocker[];
  blockers: readonly AdvertisedDomesticDepositReadinessBlocker[];
};

function liveValidationBlockers(
  status: AdvertisedDomesticDepositReadinessEntry["liveValidation"],
): readonly ["live-validation-pending"] | readonly [] {
  return status === "complete" ? [] : ["live-validation-pending"];
}

function buildReadinessEntry(
  sourceId: AdvertisedDomesticDepositSourceId,
): AdvertisedDomesticDepositReadinessEntry {
  const manifest = SOURCE_MANIFESTS[sourceId];
  const advertised = Object.values(BANK_STATEMENT_CAPABILITIES).find(
    (group) => group.id === sourceId,
  );
  if (!advertised) throw new Error(`Missing advertised source ${sourceId}.`);

  const semanticBlockers =
    sourceId === "cathay"
      ? []
      : sourceId === "linebank"
        ? lineBankSemanticBlockers()
        : semanticBlockersFromPreflight(
            (
              manifest.fixtureResult as () => AdvertisedDomesticDepositPreflightResult
            )(),
          );
  const liveBlockers = liveValidationBlockers(manifest.liveValidation);
  return {
    sourceId,
    advertisedName: advertised.label,
    workflow: manifest.workflow,
    authority: manifest.authority,
    contractVersion: manifest.contractVersion,
    capability: manifest.capability,
    fixtureEvidence:
      sourceId === "cathay"
        ? "canonical-versioned-synthetic"
        : "preflight-versioned-synthetic",
    liveValidation: manifest.liveValidation,
    semanticBlockers,
    blockers: [...liveBlockers, ...semanticBlockers],
  };
}

/** Executable release inventory derived from the advertised registry and source manifests. */
export const ADVERTISED_DOMESTIC_DEPOSIT_READINESS =
  ADVERTISED_DOMESTIC_DEPOSIT_SOURCE_IDS.map(buildReadinessEntry);

export type AdvertisedDomesticDepositReadinessGate = {
  status: "blocked" | "release-ready";
  releaseReady: boolean;
  advertisedSourceCount: number;
  unreadySourceIds: AdvertisedDomesticDepositSourceId[];
};

export function isAdvertisedDomesticDepositEntryReleaseReady(
  entry: AdvertisedDomesticDepositReadinessEntry,
): boolean {
  return (
    entry.capability === "canonical-synthetic" &&
    entry.fixtureEvidence === "canonical-versioned-synthetic" &&
    entry.liveValidation === "complete" &&
    entry.blockers.length === 0
  );
}

export function evaluateAdvertisedDomesticDepositReadiness(
  entries: readonly AdvertisedDomesticDepositReadinessEntry[] = ADVERTISED_DOMESTIC_DEPOSIT_READINESS,
): AdvertisedDomesticDepositReadinessGate {
  assertAdvertisedDomesticDepositManifestCoverage(
    ADVERTISED_DOMESTIC_DEPOSIT_SOURCE_IDS,
    entries.map(({ sourceId }) => sourceId),
  );
  if (
    new Set(entries.map(({ sourceId }) => sourceId)).size !== entries.length
  ) {
    throw new Error("Duplicate advertised domestic source readiness entry.");
  }
  const unreadySourceIds = entries
    .filter((entry) => !isAdvertisedDomesticDepositEntryReleaseReady(entry))
    .map((entry) => entry.sourceId);
  const releaseReady = unreadySourceIds.length === 0;
  return {
    status: releaseReady ? "release-ready" : "blocked",
    releaseReady,
    advertisedSourceCount: entries.length,
    unreadySourceIds,
  };
}
