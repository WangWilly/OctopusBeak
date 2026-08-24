import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  POST_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  POST_DOMESTIC_DEPOSIT_CONTRACT,
  POST_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
  POST_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  admitPostDomesticDepositFinancialCapture,
  admitPostDomesticDepositCaptureEvidence,
  commitPostDomesticDepositSourceEvidence,
  commitPostDomesticDepositSourceEvidenceBatch,
  commitCanonicalPostDomesticDepositCaptureBatch,
  createPostDomesticDepositSourceEvidence,
  isPostSha256Token,
  preflightPostDomesticDeposit,
} from "./post-domestic-deposit.ts";
import {
  createCanonicalSourceStore,
  queryCanonicalSourceCurrent,
  queryCanonicalSourceHistorical,
  queryCanonicalSourceLineage,
} from "./canonical-source-store.ts";
import {
  getPostHumanAttestedV1Manifest,
  restorePostHumanAttestedV1,
  revokePostHumanAttestedV1,
} from "./post-human-attestation.ts";
import { buildPostDomesticDepositReadinessFromLedger } from "./advertised-domestic-deposit-readiness.ts";

assert.equal(
  POST_DOMESTIC_DEPOSIT_CONTRACT.authority,
  "post/domestic-deposit/preflight-v1",
);
const positive = preflightPostDomesticDeposit(
  POST_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
);
assert.equal(positive.structuralStatus, "observed");
assert.equal(positive.status, "blocked");
assert.ok(
  positive.diagnostics.some(
    (item) => item.code === "posting-semantics-unproven",
  ),
);

// ITEM absence is normalized to [] by the workflow but carries no explicit provider authority.
const empty = preflightPostDomesticDeposit({
  ...POST_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  records: [],
});
assert.equal(empty.zeroResultEvidence, "unproven");
assert.ok(
  empty.diagnostics.some((item) => item.code === "empty-scope-unproven"),
);

const invalid = preflightPostDomesticDeposit({
  ...POST_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  records: [{ values: ["2026/01/02"], sourceOccurrenceId: "UNPROVEN" }],
  transport: { reportedCount: -1 },
});
for (const code of ["row-width-invalid", "reported-count-invalid"] as const) {
  assert.ok(
    invalid.diagnostics.some((item) => item.code === code),
    code,
  );
}

const sourceCapture = {
  evidenceVersion: POST_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  source: "post" as const,
  product: "domestic-deposit" as const,
  providerGuaranteed: false as const,
  observedAt: "2026-08-24T09:10:11+08:00",
  account: { value: "PRIVATE-POST-ACCOUNT" },
  queryRange: { startDate: "2026/02/01", endDate: "2026/08/24" },
  response: {
    httpStatus: 200,
    itemShape: "array" as const,
    rows: [
      {
        rowOrdinal: 0,
        values: [
          "2026/08/20",
          "2026/08/20",
          "08:09:10",
          "PRIVATE-MEMO",
          "",
          "125",
          "900",
          "PRIVATE-NOTE",
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
const admitted = admitPostDomesticDepositCaptureEvidence(sourceCapture);
assert.equal(admitted.status, "admissible");
assert.ok(admitted.capture);
const evidence = createPostDomesticDepositSourceEvidence(
  admitted.capture,
  "post-source-capture-1",
);
assert.equal(evidence.records.length, 1);
assert.equal(evidence.scope.absenceAuthority, undefined);
assert.equal(isPostSha256Token(evidence.subjectDigest), true);
const serializedEvidence = JSON.stringify(evidence);
for (const privateToken of [
  "PRIVATE-POST-ACCOUNT",
  "PRIVATE-MEMO",
  "PRIVATE-NOTE",
  '"125"',
  '"900"',
]) {
  assert.equal(serializedEvidence.includes(privateToken), false, privateToken);
}

const sourceDir = await mkdtemp(join(tmpdir(), "post-source-check-"));
try {
  const databasePath = join(sourceDir, "canonical.sqlite");
  const store = createCanonicalSourceStore(databasePath);
  await commitPostDomesticDepositSourceEvidence(
    store,
    admitted.capture,
    "post-source-capture-1",
  );
  assert.equal(
    Number(
      (
        store.db
          .prepare("SELECT COUNT(*) AS count FROM source_captures")
          .get() as { count: number }
      ).count,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        store.db
          .prepare("SELECT COUNT(*) AS count FROM source_records")
          .get() as { count: number }
      ).count,
    ),
    1,
  );
  await assert.rejects(
    commitPostDomesticDepositSourceEvidence(
      store,
      admitted.capture,
      "post-source-capture-1",
    ),
    /overwrite is forbidden/i,
  );
  store.close();

  const reopened = createCanonicalSourceStore(databasePath);
  assert.equal(
    Number(
      (
        reopened.db
          .prepare("SELECT COUNT(*) AS count FROM source_records")
          .get() as { count: number }
      ).count,
    ),
    1,
  );
  reopened.close();
} finally {
  await rm(sourceDir, { recursive: true, force: true });
}

const emptySource = admitPostDomesticDepositCaptureEvidence({
  ...sourceCapture,
  response: {
    httpStatus: 200,
    itemShape: "absent",
    rows: [],
    terminal: true,
  },
});
assert.equal(emptySource.status, "rejected");
assert.ok(
  emptySource.diagnostics.includes("empty-scope-unproven"),
  emptySource.diagnostics.join(", "),
);

const malformedCapture = admitPostDomesticDepositCaptureEvidence({
  ...sourceCapture,
  account: null,
});
assert.equal(malformedCapture.status, "rejected");
assert.ok(malformedCapture.diagnostics.includes("account-invalid"));

const unsupportedDirection = admitPostDomesticDepositCaptureEvidence({
  ...sourceCapture,
  response: {
    httpStatus: 200,
    itemShape: "array",
    terminal: true,
    rows: [
      {
        ...sourceCapture.response.rows[0]!,
        directionFlag: "unknown",
        values: [
          "2026/08/20",
          "2026/08/20",
          "08:09:10",
          "PRIVATE-MEMO",
          "",
          "",
          "900",
          "PRIVATE-NOTE",
        ],
      },
    ],
  },
});
assert.equal(unsupportedDirection.status, "admissible");
assert.ok(unsupportedDirection.capture);
const unsupportedFinancial = admitPostDomesticDepositFinancialCapture({
  capture: unsupportedDirection.capture,
  captureId: "post-financial-unsupported-direction",
  humanAttestation: getPostHumanAttestedV1Manifest(),
});
assert.equal(unsupportedFinancial.status, "blocked");
assert.ok(unsupportedFinancial.diagnostics.includes("row-direction-unknown"));

const financialInput = {
  capture: admitted.capture,
  captureId: "post-financial-capture-1",
  humanAttestation: getPostHumanAttestedV1Manifest(),
};
const financialAdmission =
  admitPostDomesticDepositFinancialCapture(financialInput);
assert.equal(financialAdmission.status, "admitted");
assert.ok(financialAdmission.capture);
assert.equal(
  financialAdmission.capture.authorityRoute,
  POST_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
);
assert.equal(financialAdmission.capture.records[0]?.direction, "inflow");
assert.equal(financialAdmission.capture.records[0]?.effectiveOn, "2026-08-20");
assert.equal(financialAdmission.capture.scope.absenceAuthority, null);
for (const token of ["PRIVATE-POST-ACCOUNT", "PRIVATE-MEMO", "PRIVATE-NOTE"])
  assert.equal(
    financialAdmission.capture.records[0]?.compactJson.includes(token),
    false,
  );

const financialDir = await mkdtemp(join(tmpdir(), "post-financial-check-"));
try {
  const financialPath = join(financialDir, "canonical.sqlite");
  const financialStore = createCanonicalSourceStore(financialPath);
  const writer = {
    db: financialStore.db,
    databasePath: financialStore.databasePath,
    commitClock: () => financialStore.commitClock(),
  };
  const committed = await commitCanonicalPostDomesticDepositCaptureBatch(
    writer,
    [financialInput],
  );
  assert.equal(committed[0]?.transactionCount, 1);
  assert.equal(
    buildPostDomesticDepositReadinessFromLedger(financialStore.db).capability,
    "canonical-human-attested",
  );
  await assert.rejects(
    commitCanonicalPostDomesticDepositCaptureBatch(writer, [financialInput]),
    /overwrite is forbidden/i,
  );
  const current = queryCanonicalSourceCurrent(financialStore);
  assert.equal(current.status, "durable-source-evidence");
  assert.equal(current.records.length, 1);
  const historical = queryCanonicalSourceHistorical(financialStore, {
    knowledgeAt: committed[0]!.commitSequence,
  });
  assert.equal(historical.status, "durable-source-evidence");
  assert.equal(historical.records.length, 1);
  const sourceRecord = current.records[0]!;
  const lineage = queryCanonicalSourceLineage(financialStore, {
    ...sourceRecord.identity,
    occurrenceKey: sourceRecord.occurrenceKey,
  });
  assert.equal(lineage.status, "durable-source-evidence");
  assert.equal(lineage.records.length, 1);
  assert.equal(lineage.provenanceComplete, true);
  revokePostHumanAttestedV1(
    "2026-08-24T10:09:00+08:00",
    "synthetic-readiness-revocation",
    financialStore.db,
  );
  assert.equal(
    buildPostDomesticDepositReadinessFromLedger(financialStore.db).capability,
    "preflight-only",
  );
  restorePostHumanAttestedV1(
    "2026-08-24T10:10:00+08:00",
    "synthetic-readiness-restoration",
    financialStore.db,
  );
  assert.equal(
    buildPostDomesticDepositReadinessFromLedger(financialStore.db).capability,
    "canonical-human-attested",
  );
  financialStore.close();
} finally {
  await rm(financialDir, { recursive: true, force: true });
}

const atomicDir = await mkdtemp(join(tmpdir(), "post-source-atomic-check-"));
try {
  const atomicStore = createCanonicalSourceStore(
    join(atomicDir, "canonical.sqlite"),
  );
  await assert.rejects(
    commitPostDomesticDepositSourceEvidenceBatch(atomicStore, [
      { capture: admitted.capture, captureId: "post-batch-duplicate" },
      { capture: admitted.capture, captureId: "post-batch-duplicate" },
    ]),
  );
  assert.equal(
    Number(
      (
        atomicStore.db
          .prepare("SELECT COUNT(*) AS count FROM source_captures")
          .get() as { count: number }
      ).count,
    ),
    0,
  );
  atomicStore.close();
} finally {
  await rm(atomicDir, { recursive: true, force: true });
}
