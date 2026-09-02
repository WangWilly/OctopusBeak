import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
  YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  admitYuantaDomesticDepositCaptureEvidence,
  admitYuantaDomesticDepositFinancialCapture,
} from "./yuanta-domestic-deposit.ts";
import { YUANTA_HUMAN_ATTESTED_V2_MANIFEST } from "./yuanta-human-attestation.ts";
import { deriveSourceConnectionIdentityKey } from "./source-connection-identity.ts";
import { ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE } from "./esun-credit-card-human-attestation.ts";
import { YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE } from "./yuanta-credit-card-human-attestation.ts";
import { YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE } from "./yuanta-credit-card-human-attestation.ts";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCapture,
} from "./canonical-financial-deposit-writer.ts";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  commitCathayDomesticDeposit,
  createCanonicalSourceStore,
  queryCanonicalSourceCurrent,
  queryCanonicalSourceHistorical,
  queryCanonicalSourceLineage,
} from "./canonical-source-store.ts";

const evidence = {
  evidenceVersion: YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  source: "yuanta" as const,
  observedAt: "2026-08-21T12:00:00.000+08:00",
  account: {
    value: "YUANTA-ACCOUNT-001",
    label: "臺幣活期存款",
  },
  queryRange: {
    dateRange: "one_month",
    startDate: "2026/08/01",
    endDate: "2026/08/21",
  },
  downloads: [
    {
      filename: "statement.csv",
      byteLength: 128,
      contentDigest: "sha256:yuanta-download" as const,
      columnNames: [
        "帳戶名稱",
        "帳號",
        "帳務日期",
        "交易日期",
        "交易時間",
        "交易說明",
        "支出金額",
        "存入金額",
        "帳面餘額",
        "票據號碼",
        "備註",
      ] as const,
      terminal: true,
      rows: [
        {
          rowOrdinal: 0,
          values: [
            "臺幣活期存款",
            "001",
            "20260802",
            "20260802",
            "09:10:11",
            "PAYMENT",
            "",
            "100",
            "900",
            "",
            "",
          ],
        },
      ],
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
    telemetryVersion: "domestic-deposit-telemetry-v1" as const,
  },
};

const yuantaWriterTestSourceConnectionScope =
  "YUANTA-WRITER-TEST-USER\u0000YUANTA-WRITER-TEST-ACCOUNT";
const yuantaWriterTestSourceConnectionKey = deriveSourceConnectionIdentityKey(
  "yuanta",
  yuantaWriterTestSourceConnectionScope,
);

const structural = admitYuantaDomesticDepositCaptureEvidence(evidence);
assert.equal(structural.status, "admissible");
assert.ok(structural.capture);
const admission = admitYuantaDomesticDepositFinancialCapture({
  capture: structural.capture,
  captureId: "yuanta-writer-route-positive",
  humanAttestation: YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
  sourceConnectionScope: yuantaWriterTestSourceConnectionScope,
  sourceConnectionKey: yuantaWriterTestSourceConnectionKey,
});
assert.equal(admission.status, "admitted");
const admittedCapture = admission.capture;
assert.ok(admittedCapture);
assert.equal(
  admittedCapture.authorityRoute,
  YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
);

// The credit-card worker uses the shared writer as its final admission seam.
// Keep this route-level probe here so a new Fubon contract cannot compile in
// the provider module while remaining unknown to the generic canonical spine.
const fubonCapture = structuredClone(admittedCapture);
fubonCapture.captureId = "fubon-writer-route-positive";
fubonCapture.authorityRoute = "fubon/credit-card/human-attested-v2";
fubonCapture.contractVersion = "fubon/credit-card/human-attested-v2";
Object.assign(fubonCapture.identity, {
  integrationNamespace: "fubon",
  stream: "credit-card",
  recordKind: "fubon-credit-card-transaction",
  accountNo: "fubon-portfolio",
  accountType: "credit",
  currency: "TWD",
});
Object.assign(fubonCapture.scope, {
  completenessBasis: "six-billed-periods-plus-unbilled-terminal-grids",
  completenessRuleVersion: "fubon/credit-card/human-attested-v2",
  pageCount: 7,
  withdrawalPolicy: "never-infer",
});
Object.assign(fubonCapture.semantics, {
  postingStatus: "posted",
  postingOrigin: "human-attested",
  postingBasis: "statement-posted-history",
  postingRuleVersion: "fubon/credit-card/human-attested-v2",
  semanticRuleVersion: "fubon/credit-card/human-attested-v2",
  effectiveTimeBasis: "transaction-time",
  effectiveTimeRuleVersion: "fubon/credit-card/human-attested-v2",
  timeZone: "Asia/Taipei",
  timePrecision: "date",
  timeOrigin: "defaulted_local_midnight",
  requireBalance: false,
  providerGuaranteed: false,
  occurrenceProviderGuaranteed: false,
});
fubonCapture.pages = Array.from({ length: 7 }, (_, pageOrdinal) => ({
  ...fubonCapture.pages[0]!,
  pageOrdinal,
  terminal: true,
  rowCount: pageOrdinal === 0 ? 1 : 0,
}));
const fubonRecord = fubonCapture.records[0]!;
fubonRecord.providerKey = "human-attested:no-provider-key";
fubonRecord.humanAttestedOccurrenceKey = fubonRecord.occurrenceKey;
fubonRecord.sequenceLexeme = "observed-source-order:0";
fubonRecord.sourceTime = {
  localDate: fubonRecord.effectiveOn,
  localTime: "00:00:00",
  timeZone: "Asia/Taipei",
  epochMilliseconds: Date.parse(`${fubonRecord.effectiveOn}T00:00:00+08:00`),
  precision: "date",
  timeOrigin: "defaulted_local_midnight",
};
fubonRecord.transactionDateTimeLocal = `${fubonRecord.effectiveOn}T00:00:00`;
const fubonRouteAdmission = admitCanonicalFinancialDepositCapture(fubonCapture);
assert.equal(
  fubonRouteAdmission.authorityRoute,
  "fubon/credit-card/human-attested-v2",
);
const mixedFubonRoute = structuredClone(fubonCapture);
mixedFubonRoute.captureId = "fubon-writer-route-mixed-version";
mixedFubonRoute.contractVersion = "fubon/credit-card/human-attested-v1";
assert.throws(
  () => admitCanonicalFinancialDepositCapture(mixedFubonRoute),
  /contract version|route profile/i,
);

function humanAttestedCreditCardCapture(source: "esun" | "yuanta") {
  const route =
    source === "esun"
      ? ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE
      : YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE;
  const pageCount = source === "esun" ? 1 : 7;
  const completenessBasis =
    source === "esun"
      ? "default-one-year-combined-grid-page-one-maximum-page-size-card-counts"
      : "six-billed-months-plus-unbilled-terminal-no-pager";
  const capture = structuredClone(admittedCapture!);
  capture.captureId = `${source}-writer-route-positive`;
  capture.authorityRoute = route;
  capture.contractVersion = route;
  Object.assign(capture.identity, {
    integrationNamespace: source,
    stream: "credit-card",
    recordKind: `${source}-credit-card-transaction`,
    accountNo: `${source}-portfolio`,
    accountType: "credit",
    currency: "TWD",
  });
  Object.assign(capture.scope, {
    completenessBasis,
    completenessRuleVersion: route,
    pageCount,
    absenceAuthority: null,
    withdrawalPolicy: "never-infer",
  });
  Object.assign(capture.semantics, {
    postingStatus: "posted",
    postingOrigin: "human-attested",
    postingBasis: "statement-posted-history",
    postingRuleVersion: route,
    semanticRuleVersion: route,
    effectiveTimeBasis: "transaction-time",
    effectiveTimeRuleVersion: route,
    timeZone: "Asia/Taipei",
    timePrecision: "date",
    timeOrigin: "defaulted_local_midnight",
    requireBalance: false,
    providerGuaranteed: false,
    occurrenceProviderGuaranteed: false,
  });
  capture.pages = Array.from({ length: pageCount }, (_, pageOrdinal) => ({
    ...capture.pages[0]!,
    pageOrdinal,
    terminal: true,
    rowCount: pageOrdinal === 0 ? 1 : 0,
  }));
  const record = capture.records[0]!;
  record.providerKey = "human-attested:no-provider-key";
  record.humanAttestedOccurrenceKey = record.occurrenceKey;
  record.sequenceLexeme = "observed-source-order:0";
  record.sourceTime = {
    localDate: record.effectiveOn,
    localTime: "00:00:00",
    timeZone: "Asia/Taipei",
    epochMilliseconds: Date.parse(`${record.effectiveOn}T00:00:00+08:00`),
    precision: "date",
    timeOrigin: "defaulted_local_midnight",
  };
  record.transactionDateTimeLocal = `${record.effectiveOn}T00:00:00`;
  return capture;
}

const esunCapture = humanAttestedCreditCardCapture("esun");
const esunRouteAdmission = admitCanonicalFinancialDepositCapture(esunCapture);
assert.equal(esunRouteAdmission.authorityRoute, ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE);

const yuantaCreditCardCapture = humanAttestedCreditCardCapture("yuanta");
const yuantaCreditCardRouteAdmission = admitCanonicalFinancialDepositCapture(
  yuantaCreditCardCapture,
);
assert.equal(
  yuantaCreditCardRouteAdmission.authorityRoute,
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE,
);

const yuantaCreditCardV2Capture = structuredClone(yuantaCreditCardCapture);
yuantaCreditCardV2Capture.captureId = "yuanta-writer-route-v2-positive";
yuantaCreditCardV2Capture.authorityRoute = YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE;
yuantaCreditCardV2Capture.contractVersion = YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE;
yuantaCreditCardV2Capture.scope.completenessBasis =
  "six-billed-months-plus-unbilled-terminal-no-pager-plus-settled-summary-cycles";
yuantaCreditCardV2Capture.scope.completenessRuleVersion =
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE;
yuantaCreditCardV2Capture.semantics.postingRuleVersion =
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE;
yuantaCreditCardV2Capture.semantics.semanticRuleVersion =
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE;
yuantaCreditCardV2Capture.semantics.effectiveTimeRuleVersion =
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE;
const yuantaCreditCardV2RouteAdmission = admitCanonicalFinancialDepositCapture(
  yuantaCreditCardV2Capture,
);
assert.equal(
  yuantaCreditCardV2RouteAdmission.authorityRoute,
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE,
);

const crossSource = structuredClone(esunCapture);
crossSource.captureId = "esun-writer-route-cross-source";
crossSource.identity.integrationNamespace = "yuanta";
assert.throws(
  () => admitCanonicalFinancialDepositCapture(crossSource),
  /integration namespace|route profile/i,
);

const mixedEsunVersion = structuredClone(esunCapture);
mixedEsunVersion.captureId = "esun-writer-route-mixed-version";
mixedEsunVersion.contractVersion = "esun/credit-card/human-attested-v2";
assert.throws(
  () => admitCanonicalFinancialDepositCapture(mixedEsunVersion),
  /contract version|route profile/i,
);

const mixedYuantaRule = structuredClone(yuantaCreditCardCapture);
mixedYuantaRule.captureId = "yuanta-writer-route-mixed-rule";
mixedYuantaRule.semantics.semanticRuleVersion =
  "esun/credit-card/human-attested-v1";
assert.throws(
  () => admitCanonicalFinancialDepositCapture(mixedYuantaRule),
  /semantics|route profile/i,
);

const mixedYuantaCompletenessRule = structuredClone(yuantaCreditCardCapture);
mixedYuantaCompletenessRule.captureId = "yuanta-writer-route-mixed-completeness-rule";
mixedYuantaCompletenessRule.scope.completenessRuleVersion =
  "esun/credit-card/human-attested-v1";
assert.throws(
  () => admitCanonicalFinancialDepositCapture(mixedYuantaCompletenessRule),
  /completeness rule version|route profile/i,
);

const unknownRoute = structuredClone(admittedCapture);
unknownRoute.authorityRoute = "unknown/domestic-deposit/v1";
assert.throws(
  () => admitCanonicalFinancialDepositCapture(unknownRoute),
  /unknown|unsupported.*route/i,
);

const providerGuaranteed = structuredClone(admittedCapture);
providerGuaranteed.semantics.providerGuaranteed = true;
assert.throws(
  () => admitCanonicalFinancialDepositCapture(providerGuaranteed),
  /provider.*guarantee|occurrence/i,
);

const wrongCurrency = structuredClone(admittedCapture);
wrongCurrency.identity.currency = "USD";
assert.throws(
  () => admitCanonicalFinancialDepositCapture(wrongCurrency),
  /currency/i,
);

const wrongTimeZone = structuredClone(admittedCapture);
wrongTimeZone.semantics.timeZone = "UTC";
assert.throws(
  () => admitCanonicalFinancialDepositCapture(wrongTimeZone),
  /time|timezone|zone/i,
);

const wrongCompleteness = structuredClone(admittedCapture);
(
  wrongCompleteness.scope as { completeness: "complete-range" | "single-page" }
).completeness = "single-page";
assert.throws(
  () => admitCanonicalFinancialDepositCapture(wrongCompleteness),
  /complete|range|completeness/i,
);

const directory = await mkdtemp(join(tmpdir(), "yuanta-financial-writer-v1-"));
try {
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  const committed = await commitCanonicalFinancialDepositCapture(
    store,
    admittedCapture,
  );
  assert.equal(committed.status, "canonical-live");
  assert.equal(committed.transactionCount, 1);
  assert.equal(
    (
      store.db
        .prepare(
          "SELECT COUNT(*) AS value FROM source_captures WHERE authority_route = ?",
        )
        .get(YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY) as { value?: number }
    ).value,
    1,
  );
  assert.equal(
    (
      store.db
        .prepare(
          "SELECT COUNT(*) AS value FROM transaction_revisions WHERE posting_rule_version = ?",
        )
        .get(YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY) as { value?: number }
    ).value,
    1,
  );
  store.close();

  const reopened = createCanonicalSourceStore(
    join(directory, "canonical.sqlite"),
  );
  assert.equal(
    (
      reopened.db
        .prepare("SELECT COUNT(*) AS value FROM current_transactions")
        .get() as { value?: number }
    ).value,
    1,
  );
  const sourceCurrent = queryCanonicalSourceCurrent(reopened);
  assert.equal(sourceCurrent.observations.length, 1);
  const sourceHistorical = queryCanonicalSourceHistorical(reopened, {
    knowledgeAt: committed.commitSequence,
  });
  assert.equal(sourceHistorical.observations.length, 1);
  const sourceLineage = queryCanonicalSourceLineage(reopened, {
    integrationNamespace: admittedCapture.identity.integrationNamespace,
    sourceConnectionKey: admittedCapture.identity.sourceConnectionKey,
    identityEpoch: admittedCapture.identity.identityEpochKey,
    stream: admittedCapture.identity.stream,
    recordKind: admittedCapture.identity.recordKind,
    subjectDigest: admittedCapture.identity.subjectDigest,
    occurrenceKey: admittedCapture.records[0]!.occurrenceKey,
  });
  assert.equal(sourceLineage.observations.length, 1);
  assert.equal(sourceLineage.provenance.length, 1);
  await assert.rejects(
    () => commitCanonicalFinancialDepositCapture(reopened, admittedCapture),
    /overwrite|capture/i,
  );
  assert.equal(
    (
      reopened.db
        .prepare("SELECT COUNT(*) AS value FROM transaction_revisions")
        .get() as { value?: number }
    ).value,
    1,
  );

  const collision = structuredClone(admittedCapture);
  collision.captureId = "yuanta-writer-route-collision";
  collision.records[0]!.occurrenceKey = "sha256:occurrence-changed";
  const collisionAdmission = admitCanonicalFinancialDepositCapture(collision);
  await assert.rejects(
    () => commitCanonicalFinancialDepositCapture(reopened, collisionAdmission),
    /collision|overwrite/i,
  );
  assert.equal(
    (
      reopened.db
        .prepare("SELECT COUNT(*) AS value FROM source_captures")
        .get() as { value?: number }
    ).value,
    1,
  );
  reopened.close();
} finally {
  await rm(directory, { recursive: true, force: true });
}

const mixedDirectory = await mkdtemp(join(tmpdir(), "yuanta-mixed-ledger-v1-"));
try {
  await commitCathayDomesticDeposit(
    mixedDirectory,
    CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  );
  const mixedStore = createCanonicalSourceStore(
    join(mixedDirectory, "canonical.sqlite"),
  );
  await commitCanonicalFinancialDepositCapture(mixedStore, admittedCapture);
  assert.equal(
    (
      mixedStore.db
        .prepare("SELECT COUNT(*) AS value FROM financial_transactions")
        .get() as { value?: number }
    ).value,
    4,
  );
  assert.deepEqual(
    (
      mixedStore.db
        .prepare(
          "SELECT integration_namespace FROM source_connections ORDER BY integration_namespace",
        )
        .all() as Array<{ integration_namespace?: string }>
    ).map((row) => row.integration_namespace),
    ["cathay", "yuanta"],
  );
  mixedStore.close();
} finally {
  await rm(mixedDirectory, { recursive: true, force: true });
}

const creditCardVersionDirectory = await mkdtemp(
  join(tmpdir(), "yuanta-credit-card-v1-v2-coexistence-"),
);
try {
  const versionedStore = createCanonicalSourceStore(
    join(creditCardVersionDirectory, "canonical.sqlite"),
  );
  await commitCanonicalFinancialDepositCapture(
    versionedStore,
    yuantaCreditCardRouteAdmission,
  );
  await commitCanonicalFinancialDepositCapture(
    versionedStore,
    yuantaCreditCardV2RouteAdmission,
  );
  assert.equal(
    (
      versionedStore.db
        .prepare(
          "SELECT COUNT(*) AS value FROM source_captures WHERE authority_route IN (?, ?)",
        )
        .get(
          YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE,
          YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE,
        ) as { value?: number }
    ).value,
    2,
  );
  assert.deepEqual(
    (
      versionedStore.db
        .prepare(
          "SELECT authority_route FROM source_captures WHERE authority_route IN (?, ?) ORDER BY authority_route",
        )
        .all(
          YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE,
          YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE,
        ) as Array<{ authority_route?: string }>
    ).map((row) => row.authority_route),
    [
      YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE,
      YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE,
    ],
  );
  versionedStore.close();
} finally {
  await rm(creditCardVersionDirectory, { recursive: true, force: true });
}
