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

const structural = admitYuantaDomesticDepositCaptureEvidence(evidence);
assert.equal(structural.status, "admissible");
assert.ok(structural.capture);
const admission = admitYuantaDomesticDepositFinancialCapture({
  capture: structural.capture,
  captureId: "yuanta-writer-route-positive",
  humanAttestation: YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
});
assert.equal(admission.status, "admitted");
const admittedCapture = admission.capture;
assert.ok(admittedCapture);
assert.equal(
  admittedCapture.authorityRoute,
  YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
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
