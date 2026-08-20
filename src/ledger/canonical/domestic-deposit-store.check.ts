import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  admitDomesticDepositCapture,
  commitCanonicalDomesticDeposit as commitCanonicalDomesticDepositRaw,
  createDomesticDepositStore,
  queryCurrent,
  queryHistorical,
  queryLineage,
  type DomesticDepositCapture,
  type DomesticDepositValidatedCapture,
} from "./domestic-deposit-store.ts";

const commitCanonicalDomesticDeposit = async (
  store: ReturnType<typeof createDomesticDepositStore>,
  value: DomesticDepositCapture,
) =>
  commitCanonicalDomesticDepositRaw(store, admitDomesticDepositCapture(value));

const capture: DomesticDepositCapture = {
  captureId: "capture-redacted-1",
  sourceConnection: "accessibility.linebank.com.tw",
  stream: "domestic-deposit",
  contractVersion: "preflight-v4",
  identityEpoch: 1,
  accountKey: "sha256:redacted-account",
  scope: {
    startDate: "20260101",
    endDate: "20260102",
    completeness: "transport-exact-single-page",
    evidenceVersion: "domestic-main-twd-v1",
  },
  transport: {
    responseCode: "200",
    pageNbr: 1,
    pageCapacity: 1000,
    reportedRowCount: 1,
    collectedRowCount: 1,
    terminal: true,
  },
  ruleVersions: {
    contract: "preflight-v4",
    matching: "occurrence-v1",
    direction: "historical-v7",
    time: "observed-time-v1",
  },
  observedAt: "2026-01-03T00:00:00.000Z",
  canonicalAdmission: "blocked",
  financialAdmissionBlockers: [
    "provider-identity-guarantee-unproven",
    "posting-semantics-unproven",
    "effective-time-semantics-unproven",
    "cancellation-semantics-unproven",
    "completeness-semantics-unproven",
    "authority-semantics-unproven",
    "revision-semantics-unproven",
    "canonical-financial-writer-unavailable",
  ],
  records: [
    {
      sourceOccurrenceKey: "sha256:occurrence-1",
      baseOccurrenceKey: "sha256:base-1",
      sourceChangeFingerprint: "sha256:source-1",
      accountKey: "sha256:redacted-account",
      sourceConnection: "accessibility.linebank.com.tw",
      stream: "domestic-deposit",
      contractVersion: "preflight-v4",
      identityEpoch: 1,
      sourceSequence: "1",
      occurrenceCounter: 1,
      sourceSequenceKey: "sha256:sequence-1",
      sourceTime: {
        localDate: "20260101",
        localTime: "010203",
        timeZone: "Asia/Taipei",
        epochMilliseconds: 1767200523000,
        basis: "source_observed",
      },
      direction: "inflow",
      sourceDirectionCode: "1",
      amount: { coefficient: "1000", scale: 0 },
      balanceAfter: { coefficient: "10000", scale: 0 },
      currency: "TWD",
      cancellation: "N",
      cancellationFlags: { cncdTxYn: "N", cnclTxYn: "N" },
      provenance: {
        captureId: "capture-redacted-1",
        matchingRuleVersion: "occurrence-v1",
      },
    },
  ],
};

const store = createDomesticDepositStore(":memory:");
await assert.rejects(
  () =>
    commitCanonicalDomesticDepositRaw(
      store,
      capture as DomesticDepositValidatedCapture,
    ),
  /runtime-validated|admission seam/i,
);
const first = await commitCanonicalDomesticDeposit(store, capture);
assert.equal(first.status, "source-record-only");
assert.equal(first.canonicalAdmission, "blocked");
assert.equal(first.addedRecordCount, 1);
assert.equal(first.repeatRecordCount, 0);

const repeat = await commitCanonicalDomesticDeposit(store, {
  ...capture,
  captureId: "capture-redacted-2",
  observedAt: "2026-01-04T00:00:00.000Z",
  records: capture.records.map((record) => ({
    ...record,
    provenance: { ...record.provenance, captureId: "capture-redacted-2" },
  })),
});
assert.equal(repeat.addedRecordCount, 0);
assert.equal(repeat.repeatRecordCount, 1);
assert.equal(queryCurrent(store).records.length, 1);
assert.equal(queryCurrent(store).observations.length, 2);
assert.deepEqual(
  queryCurrent(store).observations.map((observation) => observation.captureId),
  ["capture-redacted-1", "capture-redacted-2"],
);
assert.equal(queryCurrent(store).provenanceCount, 2);
assert.equal(queryCurrent(store).records[0]?.sourceSequence, "1");
assert.equal(queryCurrent(store).records[0]?.occurrenceCounter, 1);
assert.deepEqual(queryCurrent(store).records[0]?.cancellationFlags, {
  cncdTxYn: "N",
  cnclTxYn: "N",
});

const historical = queryHistorical(store, { knowledgeAt: 1 });
assert.equal(historical.kind, "historical");
assert.equal(historical.records.length, 1);
assert.equal(historical.observations.length, 1);
assert.equal(historical.canonicalAdmission, "blocked");
const historicalRepeat = queryHistorical(store, { knowledgeAt: 2 });
assert.equal(historicalRepeat.kind, "historical");
assert.equal(historicalRepeat.observations.length, 2);
const blockedFinancialHistorical = queryHistorical(store, {
  financialAt: "20260101",
});
assert.equal(blockedFinancialHistorical.status, "blocked");
assert.equal(
  blockedFinancialHistorical.reason,
  "effective-time-semantics-unproven",
);

const lineage = queryLineage(store, {
  sourceOccurrenceKey: "sha256:occurrence-1",
  sourceConnection: capture.sourceConnection,
  identityEpoch: capture.identityEpoch,
  stream: capture.stream,
  accountKey: capture.accountKey,
});
assert.equal(lineage.kind, "lineage");
assert.equal(lineage.records.length, 1);
assert.equal(lineage.observations.length, 2);
assert.equal(lineage.expectedObservationCount, 2);
assert.equal(lineage.provenanceComplete, true);
assert.deepEqual(
  lineage.observations.map((observation) => observation.recordId),
  [1, 2],
);
assert.deepEqual(
  lineage.provenance.map((entry) => entry.captureId),
  ["capture-redacted-1", "capture-redacted-2"],
);

const separatedEpoch = await commitCanonicalDomesticDeposit(store, {
  ...capture,
  captureId: "capture-redacted-epoch-2",
  identityEpoch: 2,
  accountKey: "sha256:redacted-account-epoch-2",
  records: [
    {
      ...capture.records[0]!,
      accountKey: "sha256:redacted-account-epoch-2",
      identityEpoch: 2,
      provenance: {
        ...capture.records[0]!.provenance,
        captureId: "capture-redacted-epoch-2",
      },
    },
  ],
});
assert.equal(separatedEpoch.addedRecordCount, 1);
assert.equal(queryCurrent(store).records.length, 2);

await assert.rejects(
  () =>
    commitCanonicalDomesticDeposit(store, {
      ...capture,
      captureId: "capture-redacted-time-collision",
      records: [
        {
          ...capture.records[0]!,
          sourceOccurrenceKey: "sha256:occurrence-time-collision",
          sourceChangeFingerprint: "sha256:source-time-collision",
          sourceSequenceKey: capture.records[0]!.sourceSequenceKey,
          sourceTime: {
            ...capture.records[0]!.sourceTime,
            localTime: "010204",
            epochMilliseconds: 1767200524000,
          },
          provenance: {
            ...capture.records[0]!.provenance,
            captureId: "capture-redacted-time-collision",
          },
        },
      ],
    }),
  /base|collision|conflict|overwrite/i,
);
assert.equal(queryCurrent(store).records.length, 2);

await assert.rejects(
  () =>
    commitCanonicalDomesticDeposit(store, {
      ...capture,
      captureId: "capture-redacted-conflict",
      records: capture.records.map((record) => ({
        ...record,
        sourceChangeFingerprint: "sha256:changed-source",
        amount: { coefficient: "2000", scale: 0 },
        provenance: {
          ...record.provenance,
          captureId: "capture-redacted-conflict",
        },
      })),
    }),
  /conflict|overwrite/i,
);
assert.equal(queryCurrent(store).provenanceCount, 3);

await assert.rejects(
  () =>
    commitCanonicalDomesticDeposit(store, {
      ...capture,
      captureId: "capture-redacted-source-only-conflict",
      records: capture.records.map((record) => ({
        ...record,
        sourceChangeFingerprint: "sha256:changed-source-only",
        provenance: {
          ...record.provenance,
          captureId: "capture-redacted-source-only-conflict",
        },
      })),
    }),
  /conflict|overwrite/i,
);
assert.equal(queryCurrent(store).provenanceCount, 3);

await assert.rejects(
  () =>
    commitCanonicalDomesticDeposit(store, {
      ...capture,
      captureId: "capture-redacted-fabricated-invalid",
      records: [
        {
          ...capture.records[0]!,
          sourceSequence: "not-a-provider-sequence",
          sourceTime: {
            ...capture.records[0]!.sourceTime,
            localDate: "bad-date",
          },
          provenance: {
            ...capture.records[0]!.provenance,
            captureId: "capture-redacted-fabricated-invalid",
          },
        },
      ],
    }),
  /sequence|date|source/i,
);

const persistentDir = await mkdtemp(join(tmpdir(), "linebank-domestic-store-"));
try {
  const persistentPath = join(persistentDir, "canonical.sqlite");
  const durable = createDomesticDepositStore(persistentPath);
  await commitCanonicalDomesticDeposit(durable, capture);
  durable.close();
  const reopened = createDomesticDepositStore(persistentPath);
  assert.equal(queryCurrent(reopened).records.length, 1);
  assert.equal(queryCurrent(reopened).provenanceCount, 1);
  reopened.close();
} finally {
  await rm(persistentDir, { recursive: true, force: true });
}

await assert.rejects(
  () =>
    commitCanonicalDomesticDeposit(store, {
      ...capture,
      captureId: "capture-redacted-reversed-scope",
      scope: {
        ...capture.scope,
        startDate: "20260102",
        endDate: "20260101",
      },
    }),
  /scope start date/i,
);
await assert.rejects(
  () =>
    commitCanonicalDomesticDeposit(store, {
      ...capture,
      captureId: "capture-redacted-weakened-blockers",
      financialAdmissionBlockers: [],
    }),
  /weaken|blocker/i,
);
assert.equal(queryCurrent(store).provenanceCount, 3);

await assert.rejects(
  () =>
    commitCanonicalDomesticDeposit(store, {
      ...capture,
      captureId: "capture-redacted-atomic",
      records: [
        {
          ...capture.records[0]!,
          provenance: {
            ...capture.records[0]!.provenance,
            captureId: "capture-redacted-atomic",
          },
        },
        {
          ...capture.records[0]!,
          sourceOccurrenceKey: "sha256:occurrence-1",
          sourceChangeFingerprint: "sha256:source-2",
          provenance: {
            ...capture.records[0]!.provenance,
            captureId: "capture-redacted-atomic",
          },
        },
      ],
    }),
  /duplicate|conflict|overwrite|count/i,
);
assert.equal(queryCurrent(store).provenanceCount, 3);
store.close();
