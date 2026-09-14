import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  CATHAY_DOMESTIC_DEPOSIT_STREAM,
  CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  commitCathayDomesticDeposit,
} from "./canonical-source-store.ts";
import {
  createCanonicalSourceStore,
  type CanonicalSourceStore,
} from "./canonical-source-store.ts";
import {
  CATHAY_HUMAN_ATTESTED_V1_MANIFEST,
  recordInitialCathayHumanAttestationIfMissing,
} from "./cathay-human-attestation.ts";
import {
  FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2,
  FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
  FUBON_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY,
  FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
  FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN,
  FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS,
  FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS,
  FUBON_DOMESTIC_DEPOSIT_TIME_ZONE,
  FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION,
  FUBON_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS,
  FUBON_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY,
  admitFubonDomesticDepositCaptureEvidence,
  admitFubonDomesticDepositFinancialCapture,
  commitCanonicalFubonDomesticDepositCapture,
  deriveFubonDomesticDepositAccountIdentity,
} from "./fubon-domestic-deposit.ts";
import { FUBON_HUMAN_ATTESTED_V1_MANIFEST } from "./fubon-human-attestation.ts";
import {
  YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  YUANTA_DOMESTIC_DEPOSIT_TELEMETRY_VERSION,
  YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY,
  admitYuantaDomesticDepositCaptureEvidence,
  commitCanonicalYuantaDomesticDepositCapture,
  buildYuantaHumanAttestedFinancialSemantics,
} from "./yuanta-domestic-deposit.ts";
import { YUANTA_HUMAN_ATTESTED_V2_MANIFEST } from "./yuanta-human-attestation.ts";
import {
  HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  HNCB_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  admitHncbDomesticDepositCaptureEvidence,
  commitCanonicalHncbDomesticDepositCapture,
  buildHncbHumanAttestedFinancialSemantics,
} from "./hncb-domestic-deposit.ts";
import { getHncbHumanAttestedV1Manifest } from "./hncb-human-attestation.ts";
import {
  CTBC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  admitCtbcDomesticDepositCaptureEvidence,
  commitCanonicalCtbcDomesticDepositCaptureBatch,
} from "./ctbc-domestic-deposit.ts";
import { getCtbcHumanAttestedV1Manifest } from "./ctbc-human-attestation.ts";
import {
  POST_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  admitPostDomesticDepositCaptureEvidence,
  commitCanonicalPostDomesticDepositCaptureBatch,
} from "./post-domestic-deposit.ts";
import { getPostHumanAttestedV1Manifest } from "./post-human-attestation.ts";
import {
  SINOPAC_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  admitSinopacStatementCaptureEvidence,
  commitCanonicalSinopacDomesticDepositCapture,
  createSinopacPersonalAuthority,
} from "./sinopac-domestic-deposit.ts";
import {
  getSinopacHumanAttestedV1Manifest,
  recordInitialSinopacHumanAttestationIfMissing,
} from "./sinopac-human-attestation.ts";
import { deriveSourceConnectionIdentityKey } from "./source-connection-identity.ts";
import {
  createDomesticDepositStore,
  commitCanonicalLineBankFinancialCapture,
} from "./domestic-deposit-store.ts";
import { validateLineBankHumanAttestedV13Fixture } from "./linebank-domestic-deposit.ts";

/**
 * A deterministic, secret-free source connection used only by the release
 * acceptance fixture.  It deliberately looks like a workflow-derived key,
 * while containing no credential or provider value.
 */
const FUBON_CONNECTION_SCOPE = "READINESS-FUBON-USER\u0000READINESS-FUBON-LOGIN";
const YUANTA_CONNECTION_SCOPE = "READINESS-YUANTA-USER\u0000READINESS-YUANTA-LOGIN";
const FUBON_CONNECTION_KEY = deriveSourceConnectionIdentityKey(
  "fubon",
  FUBON_CONNECTION_SCOPE,
);
const YUANTA_CONNECTION_KEY = deriveSourceConnectionIdentityKey(
  "yuanta",
  YUANTA_CONNECTION_SCOPE,
);

const YUANTA_CAPTURE = {
  evidenceVersion: YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  source: "yuanta" as const,
  observedAt: "2026-08-21T12:00:00.000+08:00",
  account: {
    value: "READINESS-YUANTA-ACCOUNT",
    label: "臺幣活期存款 READINESS",
  },
  queryRange: {
    dateRange: "three_months" as const,
    startDate: "2026/08/01",
    endDate: "2026/08/21",
  },
  downloads: [
    {
      filename: "readiness-yuanta-statement.csv",
      byteLength: 256,
      contentDigest: "sha256:readinessYuantaCsvFingerprint" as const,
      columnNames: YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES,
      rows: [
        {
          rowOrdinal: 0,
          values: [
            "臺幣活期存款 READINESS",
            "READINESS-YUANTA-ACCOUNT",
            "20260802",
            "20260802",
            "09:10:11",
            "READINESS DEPOSIT",
            "",
            "100",
            "900",
            "",
            "READINESS NOTE",
          ],
        },
      ],
      terminal: true,
    },
  ],
  provenance: {
    source: "yuanta-ebank-domestic-deposit-csv" as const,
    encoding: "big5" as const,
    responseBodyRetained: false as const,
    semantics: "unresolved" as const,
    querySelector: "#acctno" as const,
    submitSelector: "#submitbutton" as const,
    downloadSelector: "a.order_2.m_color_check" as const,
    telemetryVersion: YUANTA_DOMESTIC_DEPOSIT_TELEMETRY_VERSION,
  },
};

const HNCB_CAPTURE = {
  evidenceVersion: HNCB_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  source: "hncb" as const,
  product: "domestic-deposit" as const,
  providerGuaranteed: false as const,
  observedAt: "2026-08-20T12:00:00.000+08:00",
  account: {
    value: "READINESS-HNCB-ACCOUNT",
    label: "READINESS HNCB ACCOUNT",
  },
  queryRange: { startDate: "2026/08/01", endDate: "2026/08/20" },
  downloads: [
    {
      filename: "readiness-hncb-statement.xls",
      byteLength: 2048,
      contentDigest: "sha256:readinessHncbWorkbookFingerprint" as const,
      columnNames: HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES,
      rows: [
        {
          rowOrdinal: 0,
          values: [
            "2026/08/02",
            "09:10:11",
            "2026/08/03",
            "TWD",
            "100",
            "",
            "900",
            "READINESS DESCRIPTION",
            "READINESS DEPOSITOR",
            "READINESS NOTE",
            "READINESS NUMBER",
          ],
        },
      ],
      terminal: true,
    },
  ],
  provenance: {
    source: "hncb-ebank-domestic-deposit-html-workbook" as const,
    encoding: "big5" as const,
    responseBodyRetained: false as const,
    semantics: "unresolved" as const,
    accountSelector: "select#acct1" as const,
    queryFormSelector: 'form[name="form1"]' as const,
    downloadSelector: 'input[name="excel_download"]' as const,
  },
};

const CTBC_CAPTURE = {
  evidenceVersion: CTBC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  source: "ctbc" as const,
  product: "domestic-deposit" as const,
  providerGuaranteed: false as const,
  observedAt: "2026-08-24T10:00:00.000+08:00",
  account: { accountId: "READINESS-CTBC-ACCOUNT" },
  queryRange: { startDate: "2026/07/01", endDate: "2026/08/31" },
  responses: [
    {
      rangeOrdinal: 0,
      startDate: "2026/08/01",
      endDate: "2026/08/31",
      code: "0000" as const,
      nextKey: null,
      terminal: true as const,
      responseShape: {
        hasRsData: true as const,
        rsDataKind: "object" as const,
        hasDetailList: true as const,
        detailListIsArray: true as const,
        detailListRowCount: 1,
        nextKeyPresent: false as const,
      },
      rows: [
        {
          rowOrdinal: 0,
          values: [
            "2026/08/20",
            "2026/08/19",
            "09:10:11",
            "READINESS DESCRIPTION",
            "0",
            "1,250",
            "9,999",
            "READINESS NOTE",
          ],
        },
      ],
    },
    {
      rangeOrdinal: 1,
      startDate: "2026/07/01",
      endDate: "2026/07/31",
      code: "9201" as const,
      nextKey: null,
      terminal: true as const,
      responseShape: {
        hasRsData: true as const,
        rsDataKind: "null" as const,
        hasDetailList: false as const,
        detailListIsArray: false as const,
        detailListRowCount: null,
        nextKeyPresent: false as const,
      },
      rows: [],
    },
  ],
  provenance: {
    source: "ctbc-ebmw-qu002-011-natural-response" as const,
    rangeInventorySource: "ctbc-ebmw-qu002-010-dateRanges" as const,
    expectedRangeCount: 2,
    responseBodyRetained: false as const,
    authority: "personal-main" as const,
  },
};

const POST_CAPTURE = {
  evidenceVersion: POST_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  source: "post" as const,
  product: "domestic-deposit" as const,
  providerGuaranteed: false as const,
  observedAt: "2026-08-24T09:10:11+08:00",
  account: { value: "READINESS-POST-ACCOUNT" },
  queryRange: { startDate: "2026/02/01", endDate: "2026/08/24" },
  response: {
    httpStatus: 200 as const,
    itemShape: "array" as const,
    rows: [
      {
        rowOrdinal: 0,
        values: [
          "2026/08/20",
          "2026/08/20",
          "08:09:10",
          "READINESS MEMO",
          "",
          "125",
          "900",
          "READINESS NOTE",
        ],
        directionFlag: "inflow" as const,
      },
    ],
    terminal: true as const,
  },
  provenance: {
    source: "ipost-esoaf-eb100200-inquire" as const,
    responseBodyRetained: false as const,
    semantics: "unresolved" as const,
  },
};

const SINOPAC_CAPTURE = {
  evidenceVersion: "capture-evidence-v1" as const,
  source: "sinopac" as const,
  product: "domestic-deposit" as const,
  providerGuaranteed: false as const,
  observedAt: "2026-08-23T12:00:00.000Z",
  account: {
    value: "READINESS-SINOPAC-ACCOUNT",
    label: "READINESS SINOPAC ACCOUNT",
    currency: "TWD" as const,
  },
  queryRange: { startDate: "20260801", endDate: "20260823" },
  downloads: [
    {
      filename: "readiness-sinopac-export.csv",
      byteLength: 1024,
      contentDigest: "sha256:readinessSinopacCsvFingerprint" as const,
      columnNames: SINOPAC_DOMESTIC_DEPOSIT_COLUMN_NAMES,
      rows: [
        {
          rowOrdinal: 0,
          values: [
            "2026/08/02",
            "2026/08/02",
            "09:10",
            "READINESS DESCRIPTION",
            "100",
            "",
            "900",
            "READINESS NOTE",
            "",
          ],
        },
      ],
      queryPeriods: ["2026/08/01 ~ 2026/08/23"],
      terminal: true as const,
    },
  ],
  provenance: {
    source: "sinopac-mma-json-statement-query" as const,
    responseBodyRetained: false as const,
    semantics: "unresolved" as const,
    accountEndpoint: "ws_debitacct.ashx" as const,
    transactionEndpoint: "ws_transdetailMerge.ashx" as const,
  },
};

function writer(store: CanonicalSourceStore) {
  return {
    db: store.db,
    databasePath: store.databasePath,
    commitClock: store.commitClock,
  };
}

function requireCapture<T>(
  result: { status: string; capture: T | null; diagnostics?: readonly string[] },
  label: string,
): T {
  if (result.status !== "admitted" && result.status !== "admissible") {
    throw new Error(
      `${label} readiness fixture admission failed: ${result.diagnostics?.join(", ") ?? result.status}`,
    );
  }
  if (!result.capture) throw new Error(`${label} readiness fixture returned no capture.`);
  return result.capture;
}

function fubonFinancialInput(captureId: string) {
  const structural = requireCapture(
    admitFubonDomesticDepositCaptureEvidence(FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2),
    "Fubon structural",
  );
  const identity = deriveFubonDomesticDepositAccountIdentity(
    structural.account,
    FUBON_HUMAN_ATTESTED_V1_MANIFEST,
    FUBON_CONNECTION_KEY,
  );
  return {
    capture: structural,
    captureId,
    sourceConnectionScope: FUBON_CONNECTION_SCOPE,
    sourceConnectionKey: FUBON_CONNECTION_KEY,
    humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
    semantics: {
      evidenceVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
      account: {
        ...identity,
        accountType: "depository" as const,
        currency: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY,
      },
      authority: {
        route: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
        scope: "personal-owned-accounts" as const,
        membershipEffectiveDate: null,
      },
      posting: {
        status: "posted" as const,
        origin: FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN,
        basis: FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS,
        ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      },
      direction: {
        outflowCellIndex: 3 as const,
        inflowCellIndex: 4 as const,
        ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      },
      effectiveTime: {
        basis: FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS,
        timeZone: FUBON_DOMESTIC_DEPOSIT_TIME_ZONE,
        ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      },
      cancellation: {
        rule: "explicit-none-only" as const,
        ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
      },
      completeness: {
        basis: FUBON_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS,
        ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
        absenceAuthority: FUBON_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY,
      },
      occurrence: {
        ruleVersion: FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION,
        providerGuaranteed: false as const,
      },
    },
  };
}

function yuantaFinancialInput(captureId: string) {
  const structural = requireCapture(
    admitYuantaDomesticDepositCaptureEvidence(YUANTA_CAPTURE),
    "Yuanta structural",
  );
  return {
    capture: structural,
    captureId,
    sourceConnectionScope: YUANTA_CONNECTION_SCOPE,
    sourceConnectionKey: YUANTA_CONNECTION_KEY,
    humanAttestation: YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
    semantics: buildYuantaHumanAttestedFinancialSemantics(
      structural,
      YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
      YUANTA_CONNECTION_KEY,
    ),
  };
}

function hncbFinancialInput(captureId: string) {
  const structural = requireCapture(
    admitHncbDomesticDepositCaptureEvidence(HNCB_CAPTURE),
    "HNCB structural",
  );
  const manifest = getHncbHumanAttestedV1Manifest();
  return {
    capture: structural,
    captureId,
    humanAttestation: manifest,
    semantics: buildHncbHumanAttestedFinancialSemantics(structural, manifest),
  };
}

function ctbcFinancialInput(captureId: string) {
  const structural = requireCapture(
    admitCtbcDomesticDepositCaptureEvidence(CTBC_CAPTURE),
    "CTBC structural",
  );
  return {
    capture: structural,
    captureId,
    humanAttestation: getCtbcHumanAttestedV1Manifest(),
  };
}

function postFinancialInput(captureId: string) {
  const structural = requireCapture(
    admitPostDomesticDepositCaptureEvidence(POST_CAPTURE),
    "Post structural",
  );
  return {
    capture: structural,
    captureId,
    humanAttestation: getPostHumanAttestedV1Manifest(),
  };
}

function sinopacFinancialInput(captureId: string, authority: ReturnType<typeof createSinopacPersonalAuthority>) {
  const structural = requireCapture(
    admitSinopacStatementCaptureEvidence(SINOPAC_CAPTURE),
    "SinoPac structural",
  );
  return {
    capture: structural,
    captureId,
    humanAttestation: getSinopacHumanAttestedV1Manifest(),
    personalAuthority: authority,
  };
}

/**
 * Populate every domestic source through its typed financial admission seam.
 * The capture ids are run-scoped so the second call models a fresh recollection
 * while the canonical occurrence identity keeps the financial projection
 * idempotent.
 */
export async function populateCanonicalReadinessLedger(
  store: CanonicalSourceStore,
  runTag: string,
): Promise<void> {
  await commitCanonicalFubonDomesticDepositCapture(
    writer(store),
    fubonFinancialInput(`${runTag}-fubon`),
  );
  await commitCanonicalYuantaDomesticDepositCapture(
    writer(store),
    yuantaFinancialInput(`${runTag}-yuanta`),
  );
  await commitCanonicalHncbDomesticDepositCapture(
    writer(store),
    hncbFinancialInput(`${runTag}-hncb`),
  );
  await commitCanonicalCtbcDomesticDepositCaptureBatch(writer(store), [
    ctbcFinancialInput(`${runTag}-ctbc`),
  ]);
  await commitCanonicalPostDomesticDepositCaptureBatch(writer(store), [
    postFinancialInput(`${runTag}-post`),
  ]);
  recordInitialSinopacHumanAttestationIfMissing(
    store.db,
    SINOPAC_CAPTURE.observedAt,
  );
  const sinopacAuthority = createSinopacPersonalAuthority(store.db);
  await commitCanonicalSinopacDomesticDepositCapture(
    writer(store),
    sinopacFinancialInput(`${runTag}-sinopac`, sinopacAuthority),
  );
}

export type CanonicalReadinessLedgerFixture = {
  directory: string;
  databasePath: string;
  store: CanonicalSourceStore;
  close(): Promise<void>;
};

/**
 * Build a temporary canonical database by running the same typed admissions,
 * canonical commits, and durable attestation event writers used by the
 * production source paths. No provider credentials or live response bodies
 * are used; Cathay deliberately reuses its existing sanitized fixture.
 */
export async function createCanonicalReadinessLedgerFixture(): Promise<CanonicalReadinessLedgerFixture> {
  const directory = await mkdtemp(join(tmpdir(), "octopusbeak-readiness-"));
  const databasePath = join(directory, "canonical.sqlite");
  let store: CanonicalSourceStore | undefined;
  try {
    // Cathay's writer owns its database handle, so let it create the first
    // schema generation before opening the shared source store for the other
    // source-specific financial writers.
    await commitCathayDomesticDeposit(directory, CATHAY_DOMESTIC_DEPOSIT_FIXTURE);
    const lineBankStore = createDomesticDepositStore(databasePath);
    try {
      const lineBank = validateLineBankHumanAttestedV13Fixture();
      if (lineBank.status !== "admissible" || !lineBank.capture) {
        throw new Error(
          `LINE Bank readiness fixture admission failed: ${lineBank.diagnostics.join(", ")}`,
        );
      }
      await commitCanonicalLineBankFinancialCapture(
        lineBankStore,
        lineBank.capture,
      );
    } finally {
      lineBankStore.close();
    }
    store = createCanonicalSourceStore(databasePath);
    recordInitialCathayHumanAttestationIfMissing(
      store.db,
      CATHAY_DOMESTIC_DEPOSIT_FIXTURE.observedAt,
    );
    await populateCanonicalReadinessLedger(store, "initial");
    const fixture: CanonicalReadinessLedgerFixture = {
      directory,
      databasePath,
      store,
      async close() {
        store?.close();
        store = undefined;
        await rm(directory, { recursive: true, force: true });
      },
    };
    return fixture;
  } catch (error) {
    store?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Recollect all non-Cathay sources into an existing fixture store. */
export async function recollectCanonicalReadinessLedger(
  fixture: CanonicalReadinessLedgerFixture,
  runTag = "repeat",
): Promise<void> {
  await populateCanonicalReadinessLedger(fixture.store, runTag);
}

/** Keep this import in the fixture module's public surface for source audits. */
export const CANONICAL_READINESS_FIXTURE_ATTESTATIONS = Object.freeze({
  cathay: CATHAY_HUMAN_ATTESTED_V1_MANIFEST.attestationId,
  fubon: FUBON_HUMAN_ATTESTED_V1_MANIFEST.attestationId,
  yuanta: YUANTA_HUMAN_ATTESTED_V2_MANIFEST.attestationId,
});
