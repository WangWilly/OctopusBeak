import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CTBC_DOMESTIC_DEPOSIT_CONTRACT,
  CTBC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  CTBC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
  CTBC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  admitCtbcDomesticDepositCaptureEvidence,
  admitCtbcDomesticDepositFinancialCapture,
  commitCanonicalCtbcDomesticDepositCaptureBatch,
  commitCtbcDomesticDepositSourceEvidenceBatch,
  createCtbcDomesticDepositSourceEvidence,
  preflightCtbcDomesticDeposit,
  type CtbcDomesticDepositCaptureEvidence,
} from "./ctbc-domestic-deposit.ts";
import {
  getCtbcHumanAttestedV1Manifest,
  restoreCtbcHumanAttestedV1,
  revokeCtbcHumanAttestedV1,
} from "./ctbc-human-attestation.ts";
import {
  createCanonicalFinancialQuery,
  createCanonicalSourceStore,
  queryCanonicalSourceCurrent,
  queryCanonicalSourceHistorical,
  queryCanonicalSourceLineage,
} from "./canonical-source-store.ts";
import { buildCtbcDomesticDepositReadinessFromLedger } from "./advertised-domestic-deposit-readiness.ts";

assert.equal(
  CTBC_DOMESTIC_DEPOSIT_CONTRACT.authority,
  "ctbc/domestic-deposit/preflight-v1",
);
assert.equal(
  preflightCtbcDomesticDeposit(CTBC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1)
    .status,
  "blocked",
);
assert.equal(
  preflightCtbcDomesticDeposit({
    ...CTBC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
    records: [],
    transport: { noDataCode: "9201", terminalPageObserved: true },
  }).zeroResultEvidence,
  "provider-explicit",
);

const baseCapture: CtbcDomesticDepositCaptureEvidence = {
  evidenceVersion: CTBC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  source: "ctbc",
  product: "domestic-deposit",
  providerGuaranteed: false,
  observedAt: "2026-08-24T10:00:00.000+08:00",
  account: { accountId: "PRIVATE-CTBC-ACCOUNT" },
  queryRange: { startDate: "2026/07/01", endDate: "2026/08/31" },
  responses: [
    {
      rangeOrdinal: 0,
      startDate: "2026/08/01",
      endDate: "2026/08/31",
      code: "0000",
      nextKey: null,
      terminal: true,
      responseShape: {
        hasRsData: true,
        rsDataKind: "object",
        hasDetailList: true,
        detailListIsArray: true,
        detailListRowCount: 1,
        nextKeyPresent: false,
      },
      rows: [
        {
          rowOrdinal: 0,
          values: [
            "2026/08/20",
            "2026/08/19",
            "09:10:11",
            "PRIVATE DESCRIPTION",
            "0",
            "1,250",
            "9,999",
            "PRIVATE NOTE",
          ],
        },
      ],
    },
    {
      rangeOrdinal: 1,
      startDate: "2026/07/01",
      endDate: "2026/07/31",
      code: "9201",
      nextKey: null,
      terminal: true,
      responseShape: {
        hasRsData: true,
        rsDataKind: "null",
        hasDetailList: false,
        detailListIsArray: false,
        detailListRowCount: null,
        nextKeyPresent: false,
      },
      rows: [],
    },
  ],
  provenance: {
    source: "ctbc-ebmw-qu002-011-natural-response",
    rangeInventorySource: "ctbc-ebmw-qu002-010-dateRanges",
    expectedRangeCount: 2,
    responseBodyRetained: false,
    authority: "personal-main",
  },
};

const admitted = admitCtbcDomesticDepositCaptureEvidence(baseCapture);
assert.equal(admitted.status, "admissible");
assert.ok(admitted.capture);
const source = createCtbcDomesticDepositSourceEvidence(
  admitted.capture,
  "ctbc-source-1",
);
assert.equal(source.pages.length, 2);
assert.equal(source.scope.completeness, "complete-range");
assert.equal(source.scope.absenceAuthority, undefined);
assert.equal(source.records.length, 1);
const serializedSource = JSON.stringify(source);
for (const secret of [
  "PRIVATE-CTBC-ACCOUNT",
  "PRIVATE DESCRIPTION",
  "PRIVATE NOTE",
])
  assert.equal(serializedSource.includes(secret), false);

const financialInput = {
  capture: admitted.capture,
  captureId: "ctbc-financial-1",
  humanAttestation: getCtbcHumanAttestedV1Manifest(),
};
const financial = admitCtbcDomesticDepositFinancialCapture(financialInput);
assert.equal(financial.status, "admitted");
assert.ok(financial.capture);
assert.equal(
  financial.capture.authorityRoute,
  CTBC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
);
assert.equal(financial.capture.records[0]?.direction, "inflow");
assert.equal(financial.capture.records[0]?.effectiveOn, "2026-08-20");
assert.equal(financial.capture.records[0]?.sourceTime.localDate, "2026-08-19");
assert.equal(financial.capture.records[0]?.sourceTime.timeZone, "Asia/Taipei");
for (const secret of [
  "PRIVATE-CTBC-ACCOUNT",
  "PRIVATE DESCRIPTION",
  "PRIVATE NOTE",
])
  assert.equal(
    financial.capture.records[0]?.compactJson.includes(secret),
    false,
  );

const incomplete = admitCtbcDomesticDepositCaptureEvidence({
  ...baseCapture,
  responses: [
    {
      ...baseCapture.responses[0]!,
      terminal: false,
      nextKey: "opaque-next",
      responseShape: {
        ...baseCapture.responses[0]!.responseShape,
        nextKeyPresent: true,
      },
    },
    baseCapture.responses[1]!,
  ],
});
assert.equal(incomplete.status, "admissible");
assert.ok(incomplete.capture);
assert.equal(
  createCtbcDomesticDepositSourceEvidence(incomplete.capture, "ctbc-incomplete")
    .scope.completeness,
  "single-page",
);
const incompleteFinancial = admitCtbcDomesticDepositFinancialCapture({
  capture: incomplete.capture,
  captureId: "ctbc-incomplete-financial",
  humanAttestation: getCtbcHumanAttestedV1Manifest(),
});
assert.equal(incompleteFinancial.status, "blocked");
assert.ok(
  incompleteFinancial.diagnostics.includes("terminal-completeness-unproven"),
);

const missingAdvertisedRange = admitCtbcDomesticDepositCaptureEvidence({
  ...baseCapture,
  responses: [baseCapture.responses[0]!],
});
assert.equal(missingAdvertisedRange.status, "rejected");
assert.ok(missingAdvertisedRange.diagnostics.includes("provenance-invalid"));

const cancellation = admitCtbcDomesticDepositCaptureEvidence({
  ...baseCapture,
  responses: [
    {
      ...baseCapture.responses[0]!,
      rows: [
        {
          rowOrdinal: 0,
          values: baseCapture.responses[0]!.rows[0]!.values.with(3, "沖正"),
        },
      ],
    },
    baseCapture.responses[1]!,
  ],
});
assert.equal(cancellation.status, "admissible");
assert.ok(cancellation.capture);
const cancellationFinancial = admitCtbcDomesticDepositFinancialCapture({
  capture: cancellation.capture,
  captureId: "ctbc-cancel",
  humanAttestation: getCtbcHumanAttestedV1Manifest(),
});
assert.equal(cancellationFinancial.status, "blocked");
assert.ok(
  cancellationFinancial.diagnostics.includes("cancellation-unsupported"),
);

const ambiguous = admitCtbcDomesticDepositCaptureEvidence({
  ...baseCapture,
  responses: [
    {
      ...baseCapture.responses[0]!,
      rows: [
        baseCapture.responses[0]!.rows[0]!,
        {
          rowOrdinal: 1,
          values: baseCapture.responses[0]!.rows[0]!.values.with(
            7,
            "different",
          ),
        },
      ],
      responseShape: {
        ...baseCapture.responses[0]!.responseShape,
        detailListRowCount: 2,
      },
    },
    baseCapture.responses[1]!,
  ],
});
assert.equal(ambiguous.status, "admissible");
assert.ok(ambiguous.capture);
const ambiguousFinancial = admitCtbcDomesticDepositFinancialCapture({
  capture: ambiguous.capture,
  captureId: "ctbc-ambiguous",
  humanAttestation: getCtbcHumanAttestedV1Manifest(),
});
assert.equal(ambiguousFinancial.status, "blocked");
assert.ok(ambiguousFinancial.diagnostics.includes("occurrence-ambiguous"));

const zero = admitCtbcDomesticDepositCaptureEvidence({
  ...baseCapture,
  responses: baseCapture.responses.map((response) => ({
    ...response,
    code: "9201" as const,
    rows: [],
    responseShape: {
      hasRsData: true,
      rsDataKind: "null" as const,
      hasDetailList: false,
      detailListIsArray: false,
      detailListRowCount: null,
      nextKeyPresent: false,
    },
  })),
});
assert.equal(zero.status, "admissible");
assert.ok(zero.capture);
const zeroFinancial = admitCtbcDomesticDepositFinancialCapture({
  capture: zero.capture,
  captureId: "ctbc-zero",
  humanAttestation: getCtbcHumanAttestedV1Manifest(),
});
assert.equal(zeroFinancial.status, "admitted");
assert.equal(zeroFinancial.capture?.records.length, 0);
assert.equal(
  zeroFinancial.capture?.scope.absenceAuthority,
  "provider-explicit-no-data",
);

const successfulEmptyResponse = {
  ...baseCapture,
  queryRange: { startDate: "2026/08/01", endDate: "2026/08/31" },
  responses: [
    {
      ...baseCapture.responses[0]!,
      rows: [],
      responseShape: {
        ...baseCapture.responses[0]!.responseShape,
        detailListRowCount: 0,
      },
    },
  ],
  provenance: {
    ...baseCapture.provenance,
    expectedRangeCount: 1,
  },
};
assert.equal(
  admitCtbcDomesticDepositCaptureEvidence(successfulEmptyResponse).status,
  "admissible",
);
for (const responseShape of [
  {
    ...successfulEmptyResponse.responses[0]!.responseShape,
    hasRsData: false,
    rsDataKind: "other" as const,
  },
  {
    ...successfulEmptyResponse.responses[0]!.responseShape,
    hasDetailList: false,
    detailListIsArray: false,
    detailListRowCount: null,
  },
  {
    ...successfulEmptyResponse.responses[0]!.responseShape,
    nextKeyPresent: true,
  },
]) {
  const rejected = admitCtbcDomesticDepositCaptureEvidence({
    ...successfulEmptyResponse,
    responses: [
      {
        ...successfulEmptyResponse.responses[0]!,
        responseShape,
      },
    ],
  });
  assert.equal(rejected.status, "rejected");
}

const directory = await mkdtemp(join(tmpdir(), "ctbc-canonical-check-"));
try {
  let store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  let writer = {
    db: store.db,
    databasePath: store.databasePath,
    commitClock: () => store.commitClock(),
  };
  try {
    await commitCtbcDomesticDepositSourceEvidenceBatch(store, [
      { capture: admitted.capture, captureId: "ctbc-source-only" },
    ]);
    assert.equal(
      buildCtbcDomesticDepositReadinessFromLedger(store.db).capability,
      "preflight-only",
    );
    const committed = await commitCanonicalCtbcDomesticDepositCaptureBatch(
      writer,
      [financialInput],
    );
    assert.equal(committed[0]?.transactionCount, 1);
    assert.equal(
      buildCtbcDomesticDepositReadinessFromLedger(store.db).capability,
      "canonical-human-attested",
    );
    store.close();
    const financialQuery = createCanonicalFinancialQuery(directory, {
      integrationNamespace: "ctbc",
      postingRuleVersion: CTBC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    });
    const financialCurrent = await financialQuery.current({ kind: "current" });
    assert.equal(financialCurrent.accounts.length, 1);
    assert.equal(financialCurrent.transactions.length, 1);
    const financialHistorical = await financialQuery.historical({
      kind: "historical",
      cutoff: {
        kind: "both",
        financialAt: "9999-12-31",
        knowledgeAt: String(financialCurrent.commitSequence),
      },
    });
    assert.equal(financialHistorical.transactions.length, 1);
    const financialLineage = await financialQuery.lineage({
      kind: "lineage",
      subject: {
        kind: "transaction",
        id: financialCurrent.transactions[0]!.id,
      },
    });
    assert.equal(financialLineage.entries.length, 1);
    store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
    writer = {
      db: store.db,
      databasePath: store.databasePath,
      commitClock: () => store.commitClock(),
    };
    const current = queryCanonicalSourceCurrent(store);
    assert.equal(current.records.length, 2);
    const historical = queryCanonicalSourceHistorical(store, {
      knowledgeAt: committed[0]!.commitSequence,
    });
    assert.ok(historical.records.length >= 1);
    const financialRecord = current.records.find(
      (record) => record.identity.recordKind === "ctbc-domestic-deposit",
    )!;
    const lineage = queryCanonicalSourceLineage(store, {
      ...financialRecord.identity,
      occurrenceKey: financialRecord.occurrenceKey,
    });
    assert.equal(lineage.provenanceComplete, true);
    await assert.rejects(
      commitCanonicalCtbcDomesticDepositCaptureBatch(writer, [financialInput]),
      /overwrite is forbidden/i,
    );
    revokeCtbcHumanAttestedV1(
      "2026-08-24T11:00:00+08:00",
      "test revoke",
      store.db,
    );
    assert.equal(
      buildCtbcDomesticDepositReadinessFromLedger(store.db).capability,
      "preflight-only",
    );
    restoreCtbcHumanAttestedV1(
      "2026-08-24T12:00:00+08:00",
      "test restore",
      store.db,
    );
    assert.equal(
      buildCtbcDomesticDepositReadinessFromLedger(store.db).capability,
      "canonical-human-attested",
    );
    store.close();
    const reopened = createCanonicalSourceStore(
      join(directory, "canonical.sqlite"),
    );
    assert.equal(
      buildCtbcDomesticDepositReadinessFromLedger(reopened.db).capability,
      "canonical-human-attested",
    );
    reopened.close();
  } finally {
    store.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

const atomicDirectory = await mkdtemp(join(tmpdir(), "ctbc-atomic-check-"));
try {
  const store = createCanonicalSourceStore(
    join(atomicDirectory, "canonical.sqlite"),
  );
  try {
    await assert.rejects(
      commitCtbcDomesticDepositSourceEvidenceBatch(store, [
        { capture: admitted.capture, captureId: "duplicate" },
        { capture: admitted.capture, captureId: "duplicate" },
      ]),
    );
    assert.equal(
      (
        store.db
          .prepare("SELECT COUNT(*) AS count FROM source_captures")
          .get() as { count: number }
      ).count,
      0,
    );
  } finally {
    store.close();
  }
} finally {
  await rm(atomicDirectory, { recursive: true, force: true });
}
