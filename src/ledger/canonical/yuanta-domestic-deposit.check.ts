import assert from "node:assert/strict";
import {
  YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  YUANTA_DOMESTIC_DEPOSIT_CONTRACT,
  YUANTA_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  YUANTA_DOMESTIC_DEPOSIT_TELEMETRY_VERSION,
  YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
  YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY,
  YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
  YUANTA_DOMESTIC_DEPOSIT_LEGACY_SOURCE_EVIDENCE_ROUTE,
  YUANTA_DOMESTIC_DEPOSIT_LEGACY_SOURCE_EVIDENCE_RECORD_KIND,
  YUANTA_DOMESTIC_DEPOSIT_LEGACY_SOURCE_EVIDENCE_RULE_VERSION,
  admitYuantaDomesticDepositFinancialCapture as admitYuantaDomesticDepositFinancialCaptureCore,
  buildYuantaHumanAttestedFinancialSemantics,
  commitCanonicalYuantaDomesticDepositCapture as commitCanonicalYuantaDomesticDepositCaptureCore,
  deriveYuantaDomesticDepositAccountIdentity,
  admitYuantaDomesticDepositCaptureEvidence,
  createYuantaDomesticDepositSourceEvidence as createYuantaDomesticDepositSourceEvidenceCore,
  commitYuantaDomesticDepositSourceEvidence as commitYuantaDomesticDepositSourceEvidenceCore,
  createYuantaDomesticDepositTelemetryManifest,
  preflightYuantaDomesticDeposit,
} from "./yuanta-domestic-deposit.ts";
import { deriveSourceConnectionIdentityKey } from "./source-connection-identity.ts";
import {
  LOAN_CONTRACT_FIXTURES,
  admitCanonicalLoanCapture,
  canonicalLoanSourceIdentity,
  commitCanonicalLoanCapture,
} from "./loan-financial.ts";
import { resolveLoanRepaymentRelations } from "./loan-repayment-relations.ts";
import {
  YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
  YUANTA_HUMAN_ATTESTED_V1_MANIFEST,
  getYuantaHumanAttestedV2Manifest,
  restoreYuantaHumanAttestedV2,
  revokeYuantaHumanAttestedV2,
  yuantaHumanAttestedV2IdentityEpochKey,
  yuantaHumanAttestedIdentityEpochKey,
} from "./yuanta-human-attestation.ts";
import {
  admitCanonicalSourceEvidence,
  commitCanonicalSourceEvidence,
  createCanonicalSourceStore,
  queryCanonicalSourceCurrent,
  queryCanonicalSourceLineage,
} from "./canonical-source-store.ts";
import { buildYuantaDomesticDepositReadinessFromLedger } from "./advertised-domestic-deposit-readiness.ts";
import { recordInitialYuantaHumanAttestationIfMissing } from "./yuanta-human-attestation.ts";

const stableYuantaConnectionScope = "YUANTA-USER-001\u0000YUANTA-LOGIN-001";
const stableYuantaConnectionKey = deriveSourceConnectionIdentityKey(
  "yuanta",
  stableYuantaConnectionScope,
);

function admitYuantaDomesticDepositFinancialCapture(
  input: Parameters<typeof admitYuantaDomesticDepositFinancialCaptureCore>[0],
) {
  return admitYuantaDomesticDepositFinancialCaptureCore({
    sourceConnectionScope: stableYuantaConnectionScope,
    sourceConnectionKey: stableYuantaConnectionKey,
    ...input,
  });
}

function commitCanonicalYuantaDomesticDepositCapture(
  store: Parameters<typeof commitCanonicalYuantaDomesticDepositCaptureCore>[0],
  input: Parameters<typeof commitCanonicalYuantaDomesticDepositCaptureCore>[1],
) {
  return commitCanonicalYuantaDomesticDepositCaptureCore(store, {
    sourceConnectionScope: stableYuantaConnectionScope,
    sourceConnectionKey: stableYuantaConnectionKey,
    ...input,
  });
}

function createYuantaDomesticDepositSourceEvidence(
  capture: Parameters<typeof createYuantaDomesticDepositSourceEvidenceCore>[0],
  captureId: string,
) {
  return createYuantaDomesticDepositSourceEvidenceCore(capture, captureId, {
    sourceConnectionScope: stableYuantaConnectionScope,
    sourceConnectionKey: stableYuantaConnectionKey,
  });
}

function commitYuantaDomesticDepositSourceEvidence(
  store: Parameters<typeof commitYuantaDomesticDepositSourceEvidenceCore>[0],
  capture: Parameters<typeof commitYuantaDomesticDepositSourceEvidenceCore>[1],
  captureId: string,
) {
  return commitYuantaDomesticDepositSourceEvidenceCore(
    store,
    capture,
    captureId,
    {
      sourceConnectionScope: stableYuantaConnectionScope,
      sourceConnectionKey: stableYuantaConnectionKey,
    },
  );
}

assert.equal(
  YUANTA_DOMESTIC_DEPOSIT_CONTRACT.authority,
  "yuanta/domestic-deposit/preflight-v1",
);
const positive = preflightYuantaDomesticDeposit(
  YUANTA_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
);
assert.equal(positive.structuralStatus, "observed");
assert.equal(positive.status, "blocked");
assert.ok(
  positive.diagnostics.some(
    (item) => item.code === "occurrence-identity-unproven",
  ),
);

// Repeated downloads and backfills cannot be merged without a source occurrence key.
const repeated = preflightYuantaDomesticDeposit({
  ...YUANTA_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  records: [
    ...YUANTA_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1.records,
    ...YUANTA_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1.records,
  ],
});
assert.equal(repeated.status, "blocked");
assert.ok(
  repeated.diagnostics.some(
    (item) => item.code === "occurrence-identity-unproven",
  ),
);

const invalid = preflightYuantaDomesticDeposit({
  ...YUANTA_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  scope: { startDate: "2026/04/01", endDate: "2026/03/01" },
  records: [{ values: Array(11).fill(""), sourceDirection: "credit" }],
});
for (const code of [
  "scope-invalid",
  "date-evidence-missing",
  "amount-evidence-missing",
  "unsupported-source-semantics",
] as const) {
  assert.ok(
    invalid.diagnostics.some((item) => item.code === code),
    code,
  );
}
assert.equal(
  preflightYuantaDomesticDeposit({
    ...YUANTA_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
    records: [],
  }).zeroResultEvidence,
  "unproven",
);

const sourceCapture = {
  evidenceVersion: YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  source: "yuanta" as const,
  observedAt: "2026-08-21T12:00:00.000+08:00",
  account: {
    value: "SYNTHETIC-YUANTA-ACCOUNT-123456",
    label: "臺幣活期存款 123456",
  },
  queryRange: {
    dateRange: "three_months",
    startDate: "2026/08/01",
    endDate: "2026/08/21",
  },
  downloads: [
    {
      filename: "synthetic-statement.csv",
      byteLength: 256,
      contentDigest: "sha256:syntheticCsvFingerprint" as const,
      columnNames: YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES,
      rows: [
        {
          rowOrdinal: 0,
          values: [
            "臺幣活期存款 123456",
            "123456",
            "20260802",
            "20260802",
            "09:10:11",
            "SYNTHETIC DESCRIPTION",
            "",
            "100",
            "900",
            "",
            "SYNTHETIC NOTE",
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
    telemetryVersion: YUANTA_DOMESTIC_DEPOSIT_TELEMETRY_VERSION,
  },
};

const admitted = admitYuantaDomesticDepositCaptureEvidence(sourceCapture);
assert.equal(admitted.status, "admissible");
assert.ok(admitted.capture);

const telemetryManifest = createYuantaDomesticDepositTelemetryManifest(
  admitted.capture,
);
assert.equal(telemetryManifest.canonicalAdmission, "blocked");
assert.equal(telemetryManifest.sourceStage, "telemetry-only");
assert.equal(telemetryManifest.queryRange.dateRange, "three_months");
assert.equal(telemetryManifest.downloads[0]?.columnCount, 11);
assert.equal(telemetryManifest.downloads[0]?.rowCount, 1);
assert.equal(telemetryManifest.downloads[0]?.rows[0]?.rowOrdinal, 0);
assert.equal(telemetryManifest.downloads[0]?.rows[0]?.cellDigests.length, 11);
assert.equal(telemetryManifest.downloads[0]?.rows[0]?.amountShape, "inflow");
assert.deepEqual(telemetryManifest.downloads[0]?.rows[0]?.amountClasses, {
  outflow: "empty",
  inflow: "valid-nonzero",
});
const telemetryJson = JSON.stringify(telemetryManifest);
assert.doesNotMatch(
  telemetryJson,
  /123456|SYNTHETIC DESCRIPTION|SYNTHETIC NOTE/,
);
assert.deepEqual(
  createYuantaDomesticDepositTelemetryManifest(admitted.capture),
  telemetryManifest,
);

const financialCaptureEvidence = {
  ...sourceCapture,
  downloads: [
    {
      ...sourceCapture.downloads[0]!,
      terminal: true,
    },
  ],
};
const financialAdmitted = admitYuantaDomesticDepositCaptureEvidence(
  financialCaptureEvidence,
);
assert.equal(financialAdmitted.status, "admissible");
assert.ok(financialAdmitted.capture);
const financialIdentity = deriveYuantaDomesticDepositAccountIdentity(
  financialAdmitted.capture.account,
);
const secondIdentity = deriveYuantaDomesticDepositAccountIdentity({
  value: "SYNTHETIC-YUANTA-ACCOUNT-654321",
  label: "另一個臺幣帳戶",
});
assert.notEqual(financialIdentity.accountNo, secondIdentity.accountNo);
assert.equal(
  financialIdentity.sourceConnectionKey,
  secondIdentity.sourceConnectionKey,
);
assert.equal(
  financialIdentity.identityEpochKey,
  yuantaHumanAttestedV2IdentityEpochKey(YUANTA_HUMAN_ATTESTED_V2_MANIFEST),
);
const semantics = buildYuantaHumanAttestedFinancialSemantics(
  financialAdmitted.capture,
  YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
  stableYuantaConnectionKey,
);
assert.equal(
  semantics.account.currency,
  YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY,
);
assert.equal(
  semantics.authority.route,
  YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
);
assert.equal(semantics.occurrence.providerGuaranteed, false);
const missingYuantaLoginIdentity =
  admitYuantaDomesticDepositFinancialCaptureCore({
    capture: financialAdmitted.capture,
    captureId: "yuanta-manifest-only-must-not-admit",
    humanAttestation: YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
    semantics,
  });
assert.equal(missingYuantaLoginIdentity.status, "blocked");
assert.equal(missingYuantaLoginIdentity.capture, null);
assert.ok(
  missingYuantaLoginIdentity.diagnostics.includes(
    "source-connection-scope-invalid",
  ),
);
assert.ok(
  missingYuantaLoginIdentity.diagnostics.includes(
    "source-connection-key-invalid",
  ),
);
const admittedFinancial = admitYuantaDomesticDepositFinancialCapture({
  capture: financialAdmitted.capture,
  captureId: "yuanta-financial-positive",
  humanAttestation: YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
  semantics,
});
assert.equal(admittedFinancial.status, "admitted");
assert.ok(admittedFinancial.capture);
assert.equal(admittedFinancial.capture.records.length, 1);
assert.deepEqual(admittedFinancial.capture.records[0]?.amount, {
  coefficient: "100",
  scale: 0,
});
assert.equal(admittedFinancial.capture.records[0]?.effectiveOn, "2026-08-02");
assert.equal(
  admittedFinancial.capture.records[0]?.transactionDateTimeLocal,
  "2026-08-02T09:10:11",
);
assert.equal(
  admittedFinancial.capture.records[0]?.sourceTime.timeZone,
  "Asia/Taipei",
);
assert.doesNotMatch(
  admittedFinancial.capture.records[0]?.compactJson ?? "",
  /123456|SYNTHETIC DESCRIPTION|SYNTHETIC NOTE/,
);

for (const sourceIdentity of [
  {},
  {
    sourceConnectionScope: stableYuantaConnectionScope,
    sourceConnectionKey: deriveSourceConnectionIdentityKey(
      "yuanta",
      `${stableYuantaConnectionScope}-OTHER`,
    ),
  },
]) {
  assert.throws(
    () =>
      createYuantaDomesticDepositSourceEvidenceCore(
        financialAdmitted.capture!,
        "yuanta-source-identity-rejected",
        sourceIdentity,
      ),
    /stable caller-supplied|same login/u,
  );
  const rejectedStore = createCanonicalSourceStore(":memory:");
  try {
    await assert.rejects(
      () =>
        commitYuantaDomesticDepositSourceEvidenceCore(
          rejectedStore,
          financialAdmitted.capture!,
          "yuanta-source-identity-rejected",
          sourceIdentity,
        ),
      /stable caller-supplied|same login/u,
    );
    assert.equal(
      rejectedStore.db.prepare("SELECT COUNT(*) AS count FROM source_captures").get()
        ?.count,
      0,
    );
  } finally {
    rejectedStore.close();
  }
}

const yuantaSourceThenFinancialStore = createCanonicalSourceStore(":memory:");
try {
  await commitYuantaDomesticDepositSourceEvidence(
    yuantaSourceThenFinancialStore,
    financialAdmitted.capture,
    "yuanta-stable-source-first",
  );
  await commitCanonicalYuantaDomesticDepositCapture(
    {
      db: yuantaSourceThenFinancialStore.db,
      databasePath: yuantaSourceThenFinancialStore.databasePath,
      commitClock: () => yuantaSourceThenFinancialStore.commitClock(),
    },
    {
      capture: financialAdmitted.capture,
      captureId: "yuanta-stable-financial-recollection",
      humanAttestation: YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
      semantics,
    },
  );
  assert.equal(
    yuantaSourceThenFinancialStore.db
      .prepare(
        "SELECT COUNT(*) AS count FROM source_connections WHERE integration_namespace = 'yuanta'",
      )
      .get()?.count,
    1,
  );
  const yuantaPartitions = yuantaSourceThenFinancialStore.db
      .prepare(
        `SELECT COUNT(*) AS captures,
                COUNT(DISTINCT source_connection_id) AS partitions,
                COUNT(DISTINCT capture_key) AS capture_keys
           FROM source_captures`,
      )
      .get() as { captures: number; partitions: number; capture_keys: number };
  assert.equal(yuantaPartitions.captures, 2);
  assert.equal(yuantaPartitions.partitions, 1);
  assert.equal(yuantaPartitions.capture_keys, 2);
  const yuantaLineage = yuantaSourceThenFinancialStore.db
    .prepare(
      `SELECT COUNT(*) AS rows,
              COUNT(DISTINCT hex(source_record_id) || ':' || hex(capture_id)) AS unique_rows
         FROM source_record_provenance`,
    )
    .get() as { rows: number; unique_rows: number };
  assert.equal(yuantaLineage.rows, yuantaLineage.unique_rows);
} finally {
  yuantaSourceThenFinancialStore.close();
}

const reformattedFinancialCapture = admitYuantaDomesticDepositCaptureEvidence({
  ...financialCaptureEvidence,
  downloads: financialCaptureEvidence.downloads.map((download) => ({
    ...download,
    rows: download.rows.map((row) => ({
      ...row,
      values: row.values.map((value, index) =>
        index === 7 ? "000100.00" : index === 8 ? "000900.0" : value,
      ),
    })),
  })),
}).capture!;
const baselineSourceEvidence = createYuantaDomesticDepositSourceEvidence(
  financialAdmitted.capture,
  "yuanta-domestic-decimal-baseline",
);
const reformattedSourceEvidence = createYuantaDomesticDepositSourceEvidence(
  reformattedFinancialCapture,
  "yuanta-domestic-decimal-reformatted",
);
assert.equal(
  reformattedSourceEvidence.records[0]!.occurrenceKey,
  baselineSourceEvidence.records[0]!.occurrenceKey,
);
assert.equal(
  reformattedSourceEvidence.records[0]!.contentHash,
  baselineSourceEvidence.records[0]!.contentHash,
);
const reformattedFinancial = admitYuantaDomesticDepositFinancialCapture({
  capture: reformattedFinancialCapture,
  captureId: "yuanta-financial-decimal-reformatted",
  humanAttestation: YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
});
assert.equal(reformattedFinancial.status, "admitted");
assert.ok(reformattedFinancial.capture);
assert.equal(
  reformattedFinancial.capture.records[0]!.occurrenceKey,
  admittedFinancial.capture.records[0]!.occurrenceKey,
);
assert.equal(
  reformattedFinancial.capture.records[0]!.contentHash,
  admittedFinancial.capture.records[0]!.contentHash,
);
assert.deepEqual(reformattedFinancial.capture.records[0]!.amount, {
  coefficient: "100",
  scale: 0,
});
assert.deepEqual(reformattedFinancial.capture.records[0]!.balanceAfter, {
  coefficient: "900",
  scale: 0,
});

const accountingVsTransactionDate = admitYuantaDomesticDepositFinancialCapture({
  capture: admitYuantaDomesticDepositCaptureEvidence({
    ...sourceCapture,
    downloads: [
      {
        ...sourceCapture.downloads[0]!,
        terminal: true,
        rows: [
          {
            rowOrdinal: 0,
            values: [
              "臺幣活期存款",
              "123456",
              "20260802",
              "20260803",
              "09:10:11",
              "DATE BOUNDARY",
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
  }).capture!,
  captureId: "yuanta-financial-date-boundary",
  humanAttestation: YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
});
assert.equal(accountingVsTransactionDate.status, "admitted");
assert.equal(
  accountingVsTransactionDate.capture?.records[0]?.effectiveOn,
  "2026-08-03",
);
assert.equal(
  accountingVsTransactionDate.capture?.records[0]?.transactionDateTimeLocal,
  "2026-08-03T09:10:11",
);

let negativeCounter = 0;
const blockedFinancial = (
  rowPatch: string[],
  patch: Record<string, unknown> = {},
) => {
  const result = admitYuantaDomesticDepositCaptureEvidence({
    ...sourceCapture,
    ...patch,
    downloads: [
      {
        ...sourceCapture.downloads[0]!,
        terminal: true,
        rows: [{ rowOrdinal: 0, values: rowPatch }],
      },
    ],
  });
  assert.equal(result.status, "admissible");
  assert.ok(result.capture);
  return admitYuantaDomesticDepositFinancialCapture({
    capture: result.capture,
    captureId: "yuanta-financial-negative-" + String(++negativeCounter),
    humanAttestation: YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
  });
};
assert.ok(
  blockedFinancial([
    "臺幣活期存款",
    "123456",
    "20260802",
    "20260802",
    "09:10:11",
    "沖正交易",
    "",
    "100",
    "900",
    "",
    "",
  ]).diagnostics.includes("cancellation-marker-unsupported"),
);
assert.ok(
  blockedFinancial(
    [
      "共同帳戶",
      "123456",
      "20260802",
      "20260802",
      "09:10:11",
      "SHARED",
      "",
      "100",
      "900",
      "",
      "",
    ],
    {
      account: {
        value: "SYNTHETIC-YUANTA-ACCOUNT-123456",
        label: "共同帳戶",
      },
    },
  ).diagnostics.includes("authority-shared-account"),
);
assert.ok(
  blockedFinancial([
    "臺幣活期存款",
    "123456",
    "20260802",
    "20260802",
    "09:10:11",
    "CONFLICT",
    "50",
    "100",
    "900",
    "",
    "",
  ]).diagnostics.includes("amount-column-conflict"),
);
assert.ok(
  blockedFinancial([
    "臺幣活期存款",
    "123456",
    "20260802",
    "20260802",
    "09:10",
    "NO SECONDS",
    "",
    "100",
    "900",
    "",
    "",
  ]).diagnostics.includes("source-time-invalid"),
);

const duplicateRows = admitYuantaDomesticDepositCaptureEvidence({
  ...financialCaptureEvidence,
  downloads: [
    financialCaptureEvidence.downloads[0]!,
    { ...financialCaptureEvidence.downloads[0]!, filename: "second.csv" },
  ],
});
assert.equal(duplicateRows.status, "admissible");
assert.ok(duplicateRows.capture);
const duplicateAdmission = admitYuantaDomesticDepositFinancialCapture({
  capture: duplicateRows.capture,
  captureId: "yuanta-financial-duplicate",
  humanAttestation: YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
});
assert.ok(duplicateAdmission.diagnostics.includes("occurrence-ambiguous"));
const conflictingRows = admitYuantaDomesticDepositCaptureEvidence({
  ...financialCaptureEvidence,
  downloads: [
    financialCaptureEvidence.downloads[0]!,
    {
      ...financialCaptureEvidence.downloads[0]!,
      filename: "conflict.csv",
      rows: [
        {
          rowOrdinal: 0,
          values: [
            "臺幣活期存款",
            "123456",
            "20260802",
            "20260802",
            "09:10:11",
            "CONFLICTING DESCRIPTION",
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
});
assert.equal(conflictingRows.status, "admissible");
assert.ok(conflictingRows.capture);
const conflictingAdmission = admitYuantaDomesticDepositFinancialCapture({
  capture: conflictingRows.capture,
  captureId: "yuanta-financial-conflicting",
  humanAttestation: YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
});
assert.ok(
  conflictingAdmission.diagnostics.includes("composite-occurrence-collision"),
);

const emptyWithoutAuthority = admitYuantaDomesticDepositCaptureEvidence({
  ...sourceCapture,
  downloads: [{ ...sourceCapture.downloads[0]!, terminal: true, rows: [] }],
});
assert.equal(emptyWithoutAuthority.status, "admissible");
assert.ok(emptyWithoutAuthority.capture);
assert.ok(
  admitYuantaDomesticDepositFinancialCapture({
    capture: emptyWithoutAuthority.capture,
    captureId: "yuanta-financial-empty-unproven",
    humanAttestation: YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
  }).diagnostics.includes("zero-result-authority-unproven"),
);
const emptyWithAuthority = admitYuantaDomesticDepositCaptureEvidence({
  ...sourceCapture,
  zeroResultAuthority: "provider-explicit-no-data",
  downloads: [{ ...sourceCapture.downloads[0]!, terminal: true, rows: [] }],
});
assert.equal(emptyWithAuthority.status, "admissible");
assert.ok(emptyWithAuthority.capture);
assert.equal(
  admitYuantaDomesticDepositFinancialCapture({
    capture: emptyWithAuthority.capture,
    captureId: "yuanta-financial-empty-explicit",
    humanAttestation: YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
  }).status,
  "admitted",
);

revokeYuantaHumanAttestedV2("2026-08-25T00:00:00.000Z", "adapter test revoke");
const revokedAdmission = admitYuantaDomesticDepositFinancialCapture({
  capture: financialAdmitted.capture,
  captureId: "yuanta-financial-revoked",
  humanAttestation: YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
});
assert.equal(revokedAdmission.status, "blocked");
assert.ok(revokedAdmission.diagnostics.includes("human-attestation-revoked"));
restoreYuantaHumanAttestedV2(
  "2026-08-26T00:00:00.000Z",
  "adapter test restore",
);

const shapeCaptures = [
  {
    amountShape: "empty" as const,
    outflow: "",
    inflow: "",
    direction: null,
  },
  {
    amountShape: "conflict" as const,
    outflow: "100",
    inflow: "50",
    direction: null,
  },
  {
    amountShape: "inflow" as const,
    outflow: "0",
    inflow: "100",
    direction: "inflow" as const,
  },
  {
    amountShape: "outflow" as const,
    outflow: "100",
    inflow: "0",
    direction: "outflow" as const,
  },
];
for (const shape of shapeCaptures) {
  const shapeCapture = admitYuantaDomesticDepositCaptureEvidence({
    ...sourceCapture,
    downloads: [
      {
        ...sourceCapture.downloads[0]!,
        rows: [
          {
            rowOrdinal: 0,
            values: [
              ...sourceCapture.downloads[0]!.rows[0]!.values.slice(0, 6),
              shape.outflow,
              shape.inflow,
              ...sourceCapture.downloads[0]!.rows[0]!.values.slice(8),
            ],
          },
        ],
      },
    ],
  });
  assert.equal(shapeCapture.status, "admissible");
  assert.ok(shapeCapture.capture);
  const shapeManifest = createYuantaDomesticDepositTelemetryManifest(
    shapeCapture.capture,
  );
  assert.equal(
    shapeManifest.downloads[0]?.rows[0]?.amountShape,
    shape.amountShape,
  );
  assert.deepEqual(
    shapeManifest.downloads[0]?.rows[0]?.amountClasses,
    shape.outflow === ""
      ? { outflow: "empty", inflow: "empty" }
      : shape.outflow === "0"
        ? { outflow: "valid-zero", inflow: "valid-nonzero" }
        : shape.inflow === "0"
          ? { outflow: "valid-nonzero", inflow: "valid-zero" }
          : { outflow: "valid-nonzero", inflow: "valid-nonzero" },
  );
  const financialShape = admitYuantaDomesticDepositFinancialCapture({
    capture: admitYuantaDomesticDepositCaptureEvidence({
      ...sourceCapture,
      downloads: [
        {
          ...sourceCapture.downloads[0]!,
          terminal: true,
          rows: [
            {
              rowOrdinal: 0,
              values: [
                ...sourceCapture.downloads[0]!.rows[0]!.values.slice(0, 6),
                shape.outflow,
                shape.inflow,
                ...sourceCapture.downloads[0]!.rows[0]!.values.slice(8),
              ],
            },
          ],
        },
      ],
    }).capture!,
    captureId: `yuanta-financial-shape-${shape.amountShape}`,
    humanAttestation: getYuantaHumanAttestedV2Manifest(),
  });
  assert.equal(
    financialShape.status,
    shape.direction === null ? "blocked" : "admitted",
    shape.amountShape,
  );
  if (shape.direction !== null)
    assert.equal(
      financialShape.capture?.records[0]?.direction,
      shape.direction,
    );
  assert.doesNotMatch(
    JSON.stringify(shapeManifest),
    /SYNTHETIC-YUANTA-ACCOUNT|SYNTHETIC DESCRIPTION|SYNTHETIC NOTE/,
  );
  assert.deepEqual(
    createYuantaDomesticDepositTelemetryManifest(shapeCapture.capture),
    shapeManifest,
  );
}

const malformedCapture = admitYuantaDomesticDepositCaptureEvidence({
  ...sourceCapture,
  observedAt: "2026-08-21T12:00:00.000Z",
  downloads: [
    {
      ...sourceCapture.downloads[0]!,
      rows: [{ rowOrdinal: 0, values: ["too", "few"] }],
    },
  ],
});
assert.equal(malformedCapture.status, "rejected");
assert.ok(malformedCapture.diagnostics.includes("observed-at-invalid"));
assert.ok(malformedCapture.diagnostics.includes("row-width-invalid"));

const malformedSemanticShape = admitYuantaDomesticDepositCaptureEvidence({
  ...sourceCapture,
  downloads: [
    {
      ...sourceCapture.downloads[0]!,
      rows: [
        {
          rowOrdinal: 0,
          values: [
            "臺幣活期存款",
            "123456",
            "20261302",
            "20260802",
            "09:10:11",
            "PRIVATE",
            "not-an-amount",
            "100",
            "900",
            "",
            "",
          ],
        },
      ],
    },
  ],
});
assert.equal(malformedSemanticShape.status, "rejected");
assert.ok(malformedSemanticShape.diagnostics.includes("row-date-invalid"));
assert.ok(malformedSemanticShape.diagnostics.includes("row-amount-invalid"));
assert.equal(
  malformedSemanticShape.diagnostics.includes("row-amount-conflict"),
  false,
);

for (const [amount, expectedStatus] of [
  ["1,2", "rejected"],
  ["12,34", "rejected"],
  ["1,23,456", "rejected"],
  ["1,234", "admissible"],
  ["12,345.67", "admissible"],
  ["1234567.89", "admissible"],
] as const) {
  const amountSyntax = admitYuantaDomesticDepositCaptureEvidence({
    ...sourceCapture,
    downloads: [
      {
        ...sourceCapture.downloads[0]!,
        rows: [
          {
            rowOrdinal: 0,
            values: [
              ...sourceCapture.downloads[0]!.rows[0]!.values.slice(0, 6),
              amount,
              "",
              ...sourceCapture.downloads[0]!.rows[0]!.values.slice(8),
            ],
          },
        ],
      },
    ],
  });
  assert.equal(amountSyntax.status, expectedStatus, amount);
  if (expectedStatus === "rejected")
    assert.ok(amountSyntax.diagnostics.includes("row-amount-invalid"), amount);
}

for (const queryRange of [
  undefined,
  null,
  {},
  { dateRange: "three_months", startDate: undefined, endDate: "2026/08/21" },
  { dateRange: "three_months", startDate: "2026/08/01", endDate: null },
  { dateRange: null, startDate: "2026/08/01", endDate: "2026/08/21" },
  { dateRange: "bogus", startDate: "2026/08/01", endDate: "2026/08/21" },
] as const) {
  const malformedRange = admitYuantaDomesticDepositCaptureEvidence({
    ...sourceCapture,
    queryRange: queryRange as never,
  });
  assert.equal(malformedRange.status, "rejected");
  assert.ok(malformedRange.diagnostics.includes("query-range-invalid"));
}

const zeroCapture = admitYuantaDomesticDepositCaptureEvidence({
  ...sourceCapture,
  downloads: [{ ...sourceCapture.downloads[0]!, rows: [] }],
});
assert.equal(zeroCapture.status, "admissible");
assert.ok(zeroCapture.capture);
const zeroTelemetry = createYuantaDomesticDepositTelemetryManifest(
  zeroCapture.capture,
);
assert.equal(zeroTelemetry.downloads[0]?.rowCount, 0);
assert.deepEqual(zeroTelemetry.downloads[0]?.rows, []);

// A source capture written under the pre-zero-sentinel v1 contract remains
// immutable and readable beside the corrected v2 capture for the same row.
const sourceStore = createCanonicalSourceStore(":memory:");
try {
  const correctedEvidence = createYuantaDomesticDepositSourceEvidence(
    financialAdmitted.capture,
    "yuanta-corrected-v2-source",
  );
  const legacyIdentity = deriveYuantaDomesticDepositAccountIdentity(
    financialAdmitted.capture.account,
    YUANTA_HUMAN_ATTESTED_V1_MANIFEST,
  );
  const legacyEvidence = structuredClone(correctedEvidence);
  legacyEvidence.captureId = "yuanta-legacy-v1-source";
  legacyEvidence.sourceConnectionKey = legacyIdentity.sourceConnectionKey;
  legacyEvidence.identityEpoch = legacyIdentity.identityEpochKey;
  legacyEvidence.recordKind =
    YUANTA_DOMESTIC_DEPOSIT_LEGACY_SOURCE_EVIDENCE_RECORD_KIND;
  legacyEvidence.routeKey =
    YUANTA_DOMESTIC_DEPOSIT_LEGACY_SOURCE_EVIDENCE_ROUTE;
  legacyEvidence.contractVersion = "capture-evidence-v1";
  legacyEvidence.scope.ruleVersion =
    YUANTA_DOMESTIC_DEPOSIT_LEGACY_SOURCE_EVIDENCE_RULE_VERSION;
  legacyEvidence.subjectDigest = legacyIdentity.subjectDigest;
  legacyEvidence.records = legacyEvidence.records.map((record) => ({
    ...record,
    occurrenceKey: "sha256:legacy-v1-occurrence",
    collisionKey: "sha256:legacy-v1-collision",
    providerKey: "sha256:legacy-v1-provider",
    contentHash: "sha256:legacy-v1-content",
    compact: {
      ...record.compact,
      evidenceVersion: "capture-evidence-v1",
      amountShape: "conflict",
    },
  }));
  await commitCanonicalSourceEvidence(
    sourceStore,
    admitCanonicalSourceEvidence(legacyEvidence),
  );
  await commitYuantaDomesticDepositSourceEvidence(
    sourceStore,
    financialAdmitted.capture,
    "yuanta-corrected-v2-source",
  );
  await commitYuantaDomesticDepositSourceEvidence(
    sourceStore,
    financialAdmitted.capture,
    "yuanta-corrected-v2-repeat",
  );
  const current = queryCanonicalSourceCurrent(sourceStore);
  assert.equal(current.observations.length, 3);
  assert.equal(
    new Set(
      current.observations.map(
        (observation) => observation.identity.identityEpoch,
      ),
    ).size,
    2,
  );
  const correctedLineage = queryCanonicalSourceLineage(sourceStore, {
    integrationNamespace: "yuanta",
    sourceConnectionKey: correctedEvidence.sourceConnectionKey,
    identityEpoch: correctedEvidence.identityEpoch,
    stream: correctedEvidence.stream,
    recordKind: correctedEvidence.recordKind,
    subjectDigest: correctedEvidence.subjectDigest,
    occurrenceKey: correctedEvidence.records[0]!.occurrenceKey,
  });
  assert.equal(correctedLineage.observations.length, 2);
  const legacyLineage = queryCanonicalSourceLineage(sourceStore, {
    integrationNamespace: "yuanta",
    sourceConnectionKey: legacyEvidence.sourceConnectionKey,
    identityEpoch: legacyEvidence.identityEpoch,
    stream: legacyEvidence.stream,
    recordKind: legacyEvidence.recordKind,
    subjectDigest: legacyEvidence.subjectDigest,
    occurrenceKey: legacyEvidence.records[0]!.occurrenceKey,
  });
  assert.equal(legacyLineage.observations.length, 1);
} finally {
  sourceStore.close();
}

// A durable v1 attestation alone cannot promote readiness; only a current v2
// attestation plus a current-route financial commit can do so.
const readinessStore = createCanonicalSourceStore(":memory:");
try {
  recordInitialYuantaHumanAttestationIfMissing(
    readinessStore.db,
    "2026-08-21T12:00:00.000Z",
  );
  assert.equal(
    buildYuantaDomesticDepositReadinessFromLedger(readinessStore.db).capability,
    "preflight-only",
  );
  await commitCanonicalYuantaDomesticDepositCapture(readinessStore, {
    capture: financialAdmitted.capture,
    captureId: "yuanta-current-v2-financial",
    humanAttestation: getYuantaHumanAttestedV2Manifest(),
  });
  const liveReadiness = buildYuantaDomesticDepositReadinessFromLedger(
    readinessStore.db,
  );
  assert.equal(liveReadiness.capability, "canonical-human-attested");
  assert.equal(
    liveReadiness.authority,
    YUANTA_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
  );
  assert.equal(liveReadiness.providerGuaranteed, false);
} finally {
  readinessStore.close();
}

// A workflow-supplied stable login identity is shared by Yuanta's deposit and
// loan products. It must survive canonical admission while the selected
// account and human-attested epoch remain independently validated.
const stableYuantaManifest = getYuantaHumanAttestedV2Manifest();
const stableYuantaRelationCapture = admitYuantaDomesticDepositCaptureEvidence({
  ...financialCaptureEvidence,
  account: {
    value: "SYNTHETIC-YUANTA-RELATION-ACCOUNT",
    label: "臺幣活期存款 RELATION",
  },
  downloads: financialCaptureEvidence.downloads.map((download) => ({
    ...download,
    rows: download.rows.map((row) => ({
      ...row,
      values: [
        row.values[0],
        row.values[1],
        row.values[2],
        row.values[3],
        row.values[4],
        row.values[5],
        "100",
        "",
        row.values[8],
        row.values[9],
        row.values[10],
      ],
    })),
  })),
});
assert.equal(stableYuantaRelationCapture.status, "admissible");
assert.ok(stableYuantaRelationCapture.capture);
const stableYuantaRelationSemantics =
  buildYuantaHumanAttestedFinancialSemantics(
    stableYuantaRelationCapture.capture,
    stableYuantaManifest,
    stableYuantaConnectionKey,
  );
const stableYuantaAdmission = admitYuantaDomesticDepositFinancialCapture({
  capture: stableYuantaRelationCapture.capture,
  captureId: "yuanta-stable-source-connection",
  humanAttestation: stableYuantaManifest,
  semantics: stableYuantaRelationSemantics,
  sourceConnectionScope: stableYuantaConnectionScope,
  sourceConnectionKey: stableYuantaConnectionKey,
});
assert.equal(
  stableYuantaAdmission.status,
  "admitted",
  stableYuantaAdmission.diagnostics.join(","),
);
assert.equal(
  stableYuantaAdmission.capture?.identity.sourceConnectionKey,
  stableYuantaConnectionKey,
);
assert.equal(
  canonicalLoanSourceIdentity("yuanta", stableYuantaConnectionScope, "LOAN-001")
    .sourceConnectionKey,
  stableYuantaConnectionKey,
);
assert.notEqual(
  stableYuantaConnectionKey,
  deriveSourceConnectionIdentityKey(
    "yuanta",
    "YUANTA-USER-002\u0000YUANTA-LOGIN-001",
  ),
);
assert.notEqual(
  stableYuantaConnectionKey,
  deriveSourceConnectionIdentityKey("fubon", stableYuantaConnectionScope),
);
const mismatchedYuantaEpoch = admitYuantaDomesticDepositFinancialCapture({
  capture: stableYuantaRelationCapture.capture,
  captureId: "yuanta-stable-source-connection-wrong-epoch",
  humanAttestation: stableYuantaManifest,
  semantics: {
    ...stableYuantaRelationSemantics,
    account: {
      ...stableYuantaRelationSemantics.account,
      identityEpochKey: "sha256:yuanta-wrong-epoch",
    },
  },
  sourceConnectionScope: stableYuantaConnectionScope,
  sourceConnectionKey: stableYuantaConnectionKey,
});
assert.equal(mismatchedYuantaEpoch.status, "blocked");
assert.ok(mismatchedYuantaEpoch.diagnostics.includes("account-identity-mismatch"));
const mismatchedYuantaConnection = admitYuantaDomesticDepositFinancialCapture({
  capture: stableYuantaRelationCapture.capture,
  captureId: "yuanta-stable-source-connection-mismatch",
  humanAttestation: stableYuantaManifest,
  semantics: stableYuantaRelationSemantics,
  sourceConnectionScope: stableYuantaConnectionScope,
  sourceConnectionKey: deriveSourceConnectionIdentityKey(
    "yuanta",
    "YUANTA-USER-002\u0000YUANTA-LOGIN-001",
  ),
});
assert.equal(mismatchedYuantaConnection.status, "blocked");
assert.ok(
  mismatchedYuantaConnection.diagnostics.includes(
    "source-connection-key-mismatch",
  ),
);

const stableYuantaRelationStore = createCanonicalSourceStore(":memory:");
try {
  const stableInput = {
    capture: stableYuantaRelationCapture.capture,
    captureId: "yuanta-stable-source-connection-commit",
    humanAttestation: stableYuantaManifest,
    semantics: stableYuantaRelationSemantics,
    sourceConnectionScope: stableYuantaConnectionScope,
    sourceConnectionKey: stableYuantaConnectionKey,
  };
  const committed = await commitCanonicalYuantaDomesticDepositCapture(
    stableYuantaRelationStore,
    stableInput,
  );
  assert.equal(committed.status, "canonical-live");
  assert.equal(
    (
      stableYuantaRelationStore.db
        .prepare(
          "SELECT source_connection_key FROM source_connections WHERE integration_namespace = ?",
        )
        .get("yuanta") as { source_connection_key?: string }
    ).source_connection_key,
    stableYuantaConnectionKey,
  );

  const stableLoanInput = structuredClone(LOAN_CONTRACT_FIXTURES.yuanta);
  stableLoanInput.captureId = "yuanta-stable-source-connection-loan";
  stableLoanInput.identity.sourceConnectionKey = stableYuantaConnectionKey;
  stableLoanInput.relations = [];
  stableLoanInput.counterpartTransactions = [];
  stableLoanInput.relationCoverage = "not-asserted";
  const stableLoan = admitCanonicalLoanCapture(stableLoanInput);
  assert.equal(stableLoan.identity.sourceConnectionKey, stableYuantaConnectionKey);
  await commitCanonicalLoanCapture(stableYuantaRelationStore, stableLoan);
  const stableLoanPayment = stableLoan.records.find(
    (record) => record.eventKind === "payment",
  );
  assert.ok(stableLoanPayment);
  const stableRelation = await resolveLoanRepaymentRelations(
    stableYuantaRelationStore,
    {
      sourceConnectionKey: stableYuantaConnectionKey,
      integrationNamespace: "yuanta",
      explicitLinks: [
        {
          fromCaptureId: stableInput.captureId,
          fromSourceRecordKey:
            stableYuantaAdmission.capture!.records[0]!.occurrenceKey,
          toCaptureId: stableLoan.captureId,
          toSourceRecordKey: stableLoanPayment.sourceRecordKey,
          relationId: "yuanta-stable-source-connection-relation",
          contractVersion: "yuanta/loan-repayment-link/v1",
          evidenceSourceRecordKey:
            stableYuantaAdmission.capture!.records[0]!.occurrenceKey,
        },
      ],
    },
  );
  assert.equal(stableRelation.exactRelationIds.length, 1);
} finally {
  stableYuantaRelationStore.close();
}
