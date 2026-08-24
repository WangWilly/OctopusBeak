import { BANK_STATEMENT_CAPABILITIES } from "../../lib/automation/statement-selection.ts";
import type { DatabaseSync } from "node:sqlite";
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
  CATHAY_HUMAN_ATTESTED_V1_MANIFEST,
  isCathayHumanAttestationDurablyActive,
} from "./cathay-human-attestation.ts";
import {
  CTBC_DOMESTIC_DEPOSIT_CONTRACT,
  CTBC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  preflightCtbcDomesticDeposit,
} from "./ctbc-domestic-deposit.ts";
import {
  FUBON_DOMESTIC_DEPOSIT_CONTRACT,
  FUBON_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
  FUBON_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_READINESS,
  FUBON_HUMAN_ATTESTED_V1_MANIFEST,
  isFubonHumanAttestationDurablyActive,
  preflightFubonDomesticDeposit,
} from "./fubon-domestic-deposit.ts";
import {
  HNCB_DOMESTIC_DEPOSIT_CONTRACT,
  HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
  HNCB_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_READINESS,
  HNCB_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  HNCB_HUMAN_ATTESTED_V1_MANIFEST,
  isHncbHumanAttestationDurablyActive,
  preflightHncbDomesticDeposit,
} from "./hncb-domestic-deposit.ts";
import {
  LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_AUTHORITY,
  LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE_VERSION,
  LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_READINESS,
  validateLineBankHumanAttestedV13Fixture,
} from "./linebank-domestic-deposit.ts";
import {
  POST_DOMESTIC_DEPOSIT_CONTRACT,
  POST_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  preflightPostDomesticDeposit,
} from "./post-domestic-deposit.ts";
import {
  SINOPAC_DOMESTIC_DEPOSIT_CONTRACT,
  SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
  SINOPAC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_READINESS,
  SINOPAC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  SINOPAC_HUMAN_ATTESTED_V1_MANIFEST,
  isSinopacHumanAttestationDurablyActive,
  preflightSinopacDomesticDeposit,
} from "./sinopac-domestic-deposit.ts";
import {
  YUANTA_DOMESTIC_DEPOSIT_CONTRACT,
  YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_READINESS,
  YUANTA_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
  isYuantaHumanAttestationV2DurablyActive,
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
    authority: LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_AUTHORITY,
    contractVersion:
      LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE_VERSION,
    workflow: "linebankStatements",
    capability: LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_READINESS,
    fixtureResult: validateLineBankHumanAttestedV13Fixture,
    liveValidation: "complete",
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

function lineBankV13SemanticBlockers(): AdvertisedDomesticDepositSemanticBlocker[] {
  const result = SOURCE_MANIFESTS.linebank.fixtureResult();
  return result.status === "admissible" &&
    result.readiness === "canonical-live" &&
    result.liveValidation === "complete" &&
    result.financialAdmissionBlockers.length === 0
    ? []
    : [...ADVERTISED_DOMESTIC_DEPOSIT_SEMANTIC_BLOCKERS];
}

export type AdvertisedDomesticDepositReadinessBlocker =
  "live-validation-pending" | AdvertisedDomesticDepositSemanticBlocker;

export type AdvertisedDomesticDepositReadinessEntry = {
  sourceId: AdvertisedDomesticDepositSourceId;
  advertisedName: string;
  workflow: string;
  authority: string;
  contractVersion: string;
  capability:
    | "canonical-synthetic"
    | "canonical-live"
    | "canonical-human-attested"
    | "preflight-only";
  fixtureEvidence:
    | "canonical-versioned-synthetic"
    | "canonical-versioned-human-attested"
    | "preflight-versioned-synthetic";
  liveValidation: "pending" | "partial" | "complete";
  providerGuaranteed?: boolean;
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
        ? lineBankV13SemanticBlockers()
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
        : sourceId === "linebank"
          ? "canonical-versioned-human-attested"
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
    (entry.capability === "canonical-synthetic" ||
      entry.capability === "canonical-live" ||
      entry.capability === "canonical-human-attested") &&
    (entry.fixtureEvidence === "canonical-versioned-synthetic" ||
      entry.fixtureEvidence === "canonical-versioned-human-attested") &&
    entry.liveValidation === "complete" &&
    entry.blockers.length === 0
  );
}

/**
 * Read the Fubon limited-admission state from durable canonical evidence. The
 * static inventory intentionally remains preflight-only until this probe sees
 * a committed human-attested capture; a fixture or an active manifest alone
 * cannot promote readiness.
 */
export function buildFubonDomesticDepositReadinessFromLedger(
  db: DatabaseSync,
): AdvertisedDomesticDepositReadinessEntry {
  const base = buildReadinessEntry("fubon");
  const durableCaptureCount = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM financial_transactions transaction_row
           JOIN financial_accounts account_row
             ON account_row.account_id = transaction_row.account_id
           JOIN source_records source_record
             ON source_record.source_record_id = (
               SELECT revision.source_record_id
               FROM transaction_revisions revision
               WHERE revision.transaction_id = transaction_row.transaction_id
               ORDER BY revision.revision_number DESC LIMIT 1
             )
           JOIN source_captures capture
             ON capture.capture_id = source_record.capture_id
           WHERE capture.authority_route = ?`,
        )
        .get(FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY) as {
        count?: number;
      }
    ).count ?? 0,
  );
  const durable =
    durableCaptureCount > 0 && isFubonHumanAttestationDurablyActive(db);
  if (!durable) return base;
  return {
    ...base,
    authority: FUBON_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute,
    contractVersion: FUBON_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion,
    capability: FUBON_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_READINESS,
    fixtureEvidence: "canonical-versioned-human-attested",
    liveValidation: "complete",
    providerGuaranteed: false,
    semanticBlockers: [],
    blockers: [],
  };
}

/**
 * Promote Cathay only when its existing canonical domestic-deposit writer has
 * committed financial rows and the separate observed-human attestation chain
 * is active. Synthetic/source-only rows and an attestation manifest without a
 * matching capture remain blocked.
 */
export function buildCathayDomesticDepositReadinessFromLedger(
  db: DatabaseSync,
): AdvertisedDomesticDepositReadinessEntry {
  const base = buildReadinessEntry("cathay");
  const durableCaptureCount = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM financial_transactions transaction_row
           JOIN financial_accounts account_row
             ON account_row.account_id = transaction_row.account_id
           JOIN source_records source_record
             ON source_record.source_record_id = (
               SELECT revision.source_record_id
               FROM transaction_revisions revision
               WHERE revision.transaction_id = transaction_row.transaction_id
               ORDER BY revision.revision_number DESC LIMIT 1
             )
           JOIN source_captures capture
             ON capture.capture_id = source_record.capture_id
           WHERE capture.authority_route = ?`,
        )
        .get(CATHAY_DOMESTIC_DEPOSIT_AUTHORITY) as {
        count?: number;
      }
    ).count ?? 0,
  );
  if (durableCaptureCount === 0 || !isCathayHumanAttestationDurablyActive(db))
    return base;
  return {
    ...base,
    authority: CATHAY_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute,
    contractVersion: CATHAY_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion,
    capability: "canonical-human-attested",
    fixtureEvidence: "canonical-versioned-human-attested",
    liveValidation: "complete",
    providerGuaranteed: false,
    semanticBlockers: [],
    blockers: [],
  };
}

/**
 * Promote Yuanta only when the explicit observed-human-attested route has
 * both a durable active event and at least one durable financial transaction.
 * Source-only evidence and telemetry never promote this entry.
 */
export function buildYuantaDomesticDepositReadinessFromLedger(
  db: DatabaseSync,
): AdvertisedDomesticDepositReadinessEntry {
  const base = buildReadinessEntry("yuanta");
  const durableCaptureCount = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM financial_transactions transaction_row
           JOIN financial_accounts account_row
             ON account_row.account_id = transaction_row.account_id
           JOIN source_records source_record
             ON source_record.source_record_id = (
               SELECT revision.source_record_id
               FROM transaction_revisions revision
               WHERE revision.transaction_id = transaction_row.transaction_id
               ORDER BY revision.revision_number DESC LIMIT 1
             )
           JOIN source_captures capture
             ON capture.capture_id = source_record.capture_id
           WHERE capture.authority_route = ?`,
        )
        .get(YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY) as {
        count?: number;
      }
    ).count ?? 0,
  );
  if (durableCaptureCount === 0 || !isYuantaHumanAttestationV2DurablyActive(db))
    return base;
  return {
    ...base,
    authority: YUANTA_HUMAN_ATTESTED_V2_MANIFEST.authorityRoute,
    contractVersion: YUANTA_HUMAN_ATTESTED_V2_MANIFEST.evidenceVersion,
    capability: YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_READINESS,
    fixtureEvidence: "canonical-versioned-human-attested",
    liveValidation: "complete",
    providerGuaranteed: false,
    semanticBlockers: [],
    blockers: [],
  };
}

/** Promote HNCB only after an active durable observed attestation and a
 * matching financial capture. Source-only/telemetry captures remain blocked. */
export function buildHncbDomesticDepositReadinessFromLedger(
  db: DatabaseSync,
): AdvertisedDomesticDepositReadinessEntry {
  const base = buildReadinessEntry("hncb");
  const durableCaptureCount = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM financial_transactions transaction_row
           JOIN source_records source_record
             ON source_record.source_record_id = (
               SELECT revision.source_record_id
               FROM transaction_revisions revision
               WHERE revision.transaction_id = transaction_row.transaction_id
               ORDER BY revision.revision_number DESC LIMIT 1
             )
           JOIN source_captures capture
             ON capture.capture_id = source_record.capture_id
           WHERE capture.authority_route = ?`,
        )
        .get(HNCB_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY) as { count?: number }
    ).count ?? 0,
  );
  if (durableCaptureCount === 0 || !isHncbHumanAttestationDurablyActive(db))
    return base;
  return {
    ...base,
    authority: HNCB_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute,
    contractVersion: HNCB_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion,
    capability: HNCB_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_READINESS,
    fixtureEvidence: "canonical-versioned-human-attested",
    liveValidation: "complete",
    providerGuaranteed: false,
    semanticBlockers: [],
    blockers: [],
  };
}

/** Promote SinoPac domestic deposits only after an active durable observed
 * attestation and a matching financial transaction. Foreign deposits remain
 * source-only. */
export function buildSinopacDomesticDepositReadinessFromLedger(
  db: DatabaseSync,
): AdvertisedDomesticDepositReadinessEntry {
  const base = buildReadinessEntry("sinopac");
  const durableCaptureCount = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM financial_transactions transaction_row
           JOIN source_records source_record
             ON source_record.source_record_id = (
               SELECT revision.source_record_id
               FROM transaction_revisions revision
               WHERE revision.transaction_id = transaction_row.transaction_id
               ORDER BY revision.revision_number DESC LIMIT 1
             )
           JOIN source_captures capture
             ON capture.capture_id = source_record.capture_id
           JOIN capture_scopes scope
             ON scope.capture_id = capture.capture_id
           WHERE capture.authority_route = ?
             AND scope.absence_authority IS NULL`,
        )
        .get(SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY) as { count?: number }
    ).count ?? 0,
  );
  if (durableCaptureCount === 0 || !isSinopacHumanAttestationDurablyActive(db))
    return base;
  return {
    ...base,
    authority: SINOPAC_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute,
    contractVersion: SINOPAC_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion,
    capability: SINOPAC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_READINESS,
    fixtureEvidence: "canonical-versioned-human-attested",
    liveValidation: "complete",
    providerGuaranteed: false,
    semanticBlockers: [],
    blockers: [],
  };
}

export function evaluateAdvertisedDomesticDepositReadinessFromLedger(
  db: DatabaseSync,
): AdvertisedDomesticDepositReadinessGate {
  const entries = ADVERTISED_DOMESTIC_DEPOSIT_READINESS.map((entry) =>
    entry.sourceId === "fubon"
      ? buildFubonDomesticDepositReadinessFromLedger(db)
      : entry.sourceId === "cathay"
        ? buildCathayDomesticDepositReadinessFromLedger(db)
        : entry.sourceId === "yuanta"
          ? buildYuantaDomesticDepositReadinessFromLedger(db)
          : entry.sourceId === "hncb"
            ? buildHncbDomesticDepositReadinessFromLedger(db)
            : entry.sourceId === "sinopac"
              ? buildSinopacDomesticDepositReadinessFromLedger(db)
              : entry,
  );
  return evaluateAdvertisedDomesticDepositReadiness(entries);
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
