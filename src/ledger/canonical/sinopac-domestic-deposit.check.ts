import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  admitCanonicalSourceEvidence,
  commitCanonicalSourceEvidence,
  createCanonicalSourceStore,
  queryCanonicalSourceCurrent,
  queryCanonicalSourceHistorical,
  queryCanonicalSourceLineage,
  validateCanonicalSourceStore,
} from "./canonical-source-store.ts";
import {
  SINOPAC_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  SINOPAC_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_ROUTE,
  SINOPAC_FOREIGN_DEPOSIT_SOURCE_EVIDENCE_ROUTE,
  SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
  admitSinopacStatementCaptureEvidence,
  admitSinopacDomesticDepositFinancialCapture,
  commitCanonicalSinopacDomesticDepositCapture,
  commitCanonicalSinopacDomesticDepositCaptureBatch,
  createSinopacPersonalAuthority,
  commitSinopacStatementSourceEvidence,
  commitSinopacStatementSourceEvidenceBatch,
  createSinopacDomesticDepositSourceEvidence,
  createSinopacForeignCurrencySourceEvidence,
  preflightSinopacDomesticDeposit,
  SINOPAC_DOMESTIC_DEPOSIT_CONTRACT,
  SINOPAC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  getSinopacHumanAttestedV1Manifest,
  type SinopacStatementCaptureEvidence,
} from "./sinopac-domestic-deposit.ts";
import { buildSinopacDomesticDepositReadinessFromLedger } from "./advertised-domestic-deposit-readiness.ts";
import { admitCanonicalFinancialDepositCapture } from "./canonical-financial-deposit-writer.ts";
import {
  restoreSinopacHumanAttestedV1,
  recordInitialSinopacHumanAttestationIfMissing,
  revokeSinopacHumanAttestedV1,
} from "./sinopac-human-attestation.ts";
import {
  admitSinopacForeignCurrencyCaptureEvidence,
  isAdmittedSinopacForeignCurrencyCaptureEvidence,
} from "./sinopac-foreign-deposit.ts";

assert.equal(
  SINOPAC_DOMESTIC_DEPOSIT_CONTRACT.authority,
  "sinopac/domestic-deposit/preflight-v1",
);
assert.equal(
  preflightSinopacDomesticDeposit(SINOPAC_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1)
    .status,
  "blocked",
);

const digest = (letter: string) => `sha256:${letter.repeat(64)}` as const;
const privateAccount = "PRIVATE-SINOPAC-ACCOUNT";
const privateDescription = "PRIVATE-SINOPAC-DESCRIPTION";
const privateNote = "PRIVATE-SINOPAC-NOTE";
const baseCapture: SinopacStatementCaptureEvidence = {
  evidenceVersion: "capture-evidence-v1",
  source: "sinopac",
  product: "domestic-deposit",
  providerGuaranteed: false,
  observedAt: "2026-08-23T12:00:00.000Z",
  account: {
    value: privateAccount,
    label: "PRIVATE ACCOUNT LABEL",
    currency: "TWD",
  },
  queryRange: { startDate: "20260801", endDate: "20260823" },
  downloads: [
    {
      filename: "private-sinopac-export.csv",
      byteLength: 1024,
      contentDigest: digest("a"),
      columnNames: SINOPAC_DOMESTIC_DEPOSIT_COLUMN_NAMES,
      rows: [
        {
          rowOrdinal: 0,
          values: [
            "2026/08/02",
            "2026/08/02",
            "09:10",
            privateDescription,
            "100",
            "",
            "900",
            privateNote,
            "",
          ],
        },
      ],
      queryPeriods: ["2026/08/01 ~ 2026/08/23"],
      terminal: true,
    },
  ],
  provenance: {
    source: "sinopac-mma-json-statement-query",
    responseBodyRetained: false,
    semantics: "unresolved",
    accountEndpoint: "ws_debitacct.ashx",
    transactionEndpoint: "ws_transdetailMerge.ashx",
  },
};

const admitted = admitSinopacStatementCaptureEvidence(baseCapture);
assert.equal(admitted.status, "admissible");
assert.ok(admitted.capture);
const sourceEvidence = createSinopacDomesticDepositSourceEvidence(
  admitted.capture,
  "sinopac-capture-1",
);
assert.equal(
  sourceEvidence.routeKey,
  SINOPAC_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_ROUTE,
);
assert.equal(sourceEvidence.stream, "domestic-deposit");
assert.equal(sourceEvidence.records.length, 1);
assert.equal(sourceEvidence.records[0]?.compact.amountDirection, "outflow");
assert.doesNotMatch(
  JSON.stringify(sourceEvidence),
  /PRIVATE-SINOPAC-ACCOUNT|PRIVATE ACCOUNT LABEL|PRIVATE-SINOPAC-DESCRIPTION|PRIVATE-SINOPAC-NOTE/,
);

const explicitNoData = admitSinopacStatementCaptureEvidence({
  ...baseCapture,
  downloads: [
    {
      ...baseCapture.downloads[0]!,
      rows: [],
      byteLength: 0,
      contentDigest: digest("b"),
    },
  ],
  zeroResultAuthority: "provider-explicit-no-data",
});
assert.equal(explicitNoData.status, "admissible");
assert.equal(
  createSinopacDomesticDepositSourceEvidence(
    explicitNoData.capture!,
    "sinopac-explicit-no-data-capture",
  ).scope.absenceAuthority,
  "provider-explicit-no-data",
);
assert.equal(
  createSinopacDomesticDepositSourceEvidence(
    admitted.capture!,
    "sinopac-non-empty-capture",
  ).scope.absenceAuthority,
  undefined,
);
const invalid = admitSinopacStatementCaptureEvidence({
  ...baseCapture,
  downloads: [
    {
      ...baseCapture.downloads[0]!,
      rows: [{ ...baseCapture.downloads[0]!.rows[0]!, values: ["bad"] }],
    },
  ],
});
assert.equal(invalid.status, "rejected");
assert.ok(invalid.diagnostics.includes("row-width-invalid"));
assert.equal(
  admitSinopacStatementCaptureEvidence({
    ...baseCapture,
    downloads: [{ ...baseCapture.downloads[0]!, rows: [] }],
  }).diagnostics.includes("zero-result-authority-unproven"),
  true,
);

const foreignCapture = {
  ...baseCapture,
  product: "foreign-currency" as const,
  account: {
    value: privateAccount,
    label: "PRIVATE ACCOUNT LABEL",
    currency: "USD",
  },
};
const nonTerminal = admitSinopacStatementCaptureEvidence({
  ...foreignCapture,
  downloads: [{ ...foreignCapture.downloads[0]!, terminal: false }],
});
assert.equal(nonTerminal.status, "rejected");
assert.ok(nonTerminal.diagnostics.includes("download-terminal-invalid"));
const foreignAdmitted = admitSinopacStatementCaptureEvidence(foreignCapture);
assert.equal(foreignAdmitted.status, "admissible");
assert.ok(foreignAdmitted.capture);
const foreignExplicitNoData = admitSinopacStatementCaptureEvidence({
  ...foreignCapture,
  downloads: [
    {
      ...foreignCapture.downloads[0]!,
      rows: [],
      byteLength: 0,
      contentDigest: digest("c"),
    },
  ],
  zeroResultAuthority: "provider-explicit-no-data",
});
assert.equal(foreignExplicitNoData.status, "admissible");
assert.ok(foreignExplicitNoData.capture);
const foreignEmptyEvidence = createSinopacForeignCurrencySourceEvidence(
  foreignExplicitNoData.capture,
  "sinopac-foreign-explicit-no-data-capture",
);
assert.equal(
  foreignEmptyEvidence.scope.absenceAuthority,
  "provider-explicit-no-data",
);
assert.equal(foreignEmptyEvidence.scope.completeness, "complete-range");
assert.equal(foreignEmptyEvidence.pages[0]?.terminal, true);
const foreignGuardResult =
  admitSinopacForeignCurrencyCaptureEvidence(foreignCapture);
assert.equal(foreignGuardResult.status, "admissible");
assert.equal(
  isAdmittedSinopacForeignCurrencyCaptureEvidence(admitted.capture),
  false,
);
assert.equal(
  isAdmittedSinopacForeignCurrencyCaptureEvidence(foreignGuardResult.capture),
  true,
);
const foreignEvidence = createSinopacForeignCurrencySourceEvidence(
  foreignAdmitted.capture,
  "sinopac-foreign-capture-1",
);
assert.equal(
  foreignEvidence.routeKey,
  SINOPAC_FOREIGN_DEPOSIT_SOURCE_EVIDENCE_ROUTE,
);
assert.equal(foreignEvidence.stream, "foreign-currency");
assert.notEqual(sourceEvidence.identityEpoch, foreignEvidence.identityEpoch);
assert.equal(foreignEvidence.scope.completeness, "complete-range");
assert.equal(foreignEvidence.pages.at(-1)?.terminal, true);

const sourceDirectory = await mkdtemp(join(tmpdir(), "sinopac-source-v1-"));
try {
  const store = createCanonicalSourceStore(
    join(sourceDirectory, "canonical.sqlite"),
  );
  try {
    validateCanonicalSourceStore(store);
    const first = await commitSinopacStatementSourceEvidence(
      store,
      admitted.capture,
      "sinopac-capture-1",
    );
    const repeated = await commitSinopacStatementSourceEvidence(
      store,
      admitted.capture,
      "sinopac-capture-2",
    );
    await commitSinopacStatementSourceEvidence(
      store,
      foreignAdmitted.capture,
      "sinopac-foreign-capture-1",
    );
    const emptyCommit = await commitCanonicalSourceEvidence(
      store,
      admitCanonicalSourceEvidence(foreignEmptyEvidence),
    );
    assert.equal(first.status, "durable-source-evidence");
    assert.equal(repeated.status, "durable-source-evidence");
    assert.equal(emptyCommit.observationCount, 0);
    const emptyScope = store.db
      .prepare(
        `SELECT scope.completeness, scope.terminal
         FROM capture_scopes scope
         JOIN source_captures capture ON capture.capture_id = scope.capture_id
         WHERE capture.capture_key = ?`,
      )
      .get("sinopac-foreign-explicit-no-data-capture") as {
      completeness?: unknown;
      terminal?: unknown;
    } | undefined;
    assert.equal(emptyScope?.completeness, "complete-range");
    assert.equal(emptyScope?.terminal, 1);
    assert.equal(queryCanonicalSourceCurrent(store).records.length, 2);
    assert.equal(queryCanonicalSourceCurrent(store).observations.length, 3);
    assert.equal(
      queryCanonicalSourceHistorical(store, {
        knowledgeAt: first.commitSequence,
      }).observations.length,
      1,
    );
    const record = sourceEvidence.records[0]!;
    const lineage = queryCanonicalSourceLineage(store, {
      integrationNamespace: sourceEvidence.integrationNamespace,
      sourceConnectionKey: sourceEvidence.sourceConnectionKey,
      identityEpoch: sourceEvidence.identityEpoch,
      stream: sourceEvidence.stream,
      recordKind: sourceEvidence.recordKind,
      subjectDigest: sourceEvidence.subjectDigest,
      occurrenceKey: record.occurrenceKey,
    });
    assert.equal(lineage.observations.length, 2);
    assert.equal(lineage.provenance.length, 2);
    for (const table of [
      "financial_accounts",
      "financial_transactions",
      "transaction_revisions",
      "current_transactions",
    ]) {
      assert.equal(
        Number(
          (
            store.db
              .prepare(`SELECT COUNT(*) AS value FROM ${table}`)
              .get() as { value?: number }
          ).value ?? 0,
        ),
        0,
        `${table} remains empty for SinoPac source-only evidence`,
      );
    }
    await assert.rejects(
      () =>
        commitCanonicalSourceEvidence(
          store,
          admitCanonicalSourceEvidence({
            ...sourceEvidence,
            captureId: "sinopac-capture-conflict",
            records: [{ ...record, occurrenceKey: digest("b") }],
          }),
        ),
      /collision|conflict|overwrite/i,
    );
    assert.equal(queryCanonicalSourceCurrent(store).observations.length, 3);
  } finally {
    store.close();
  }
  const reopened = createCanonicalSourceStore(
    join(sourceDirectory, "canonical.sqlite"),
  );
  try {
    validateCanonicalSourceStore(reopened);
    assert.equal(queryCanonicalSourceCurrent(reopened).records.length, 2);
  } finally {
    reopened.close();
  }
} finally {
  await rm(sourceDirectory, { recursive: true, force: true });
}

const atomicBatchDirectory = await mkdtemp(
  join(tmpdir(), "sinopac-source-batch-"),
);
try {
  const store = createCanonicalSourceStore(
    join(atomicBatchDirectory, "canonical.sqlite"),
  );
  try {
    const triggerDb = new DatabaseSync(store.databasePath);
    triggerDb.exec(`
      CREATE TRIGGER reject_second_sinopac_capture
      BEFORE INSERT ON source_captures
      WHEN NEW.capture_key = 'sinopac-atomic-batch-1'
      BEGIN
        SELECT RAISE(ABORT, 'injected later capture failure');
      END;
    `);
    triggerDb.close();
    await assert.rejects(
      () =>
        commitSinopacStatementSourceEvidenceBatch(
          store,
          [admitted.capture!, foreignAdmitted.capture!],
          "sinopac-atomic-batch",
        ),
      /injected later capture failure/i,
    );
    assert.equal(queryCanonicalSourceCurrent(store).records.length, 0);
    assert.equal(
      Number(
        (
          store.db
            .prepare("SELECT COUNT(*) AS value FROM source_captures")
            .get() as { value?: number }
        ).value ?? 0,
      ),
      0,
    );
  } finally {
    store.close();
  }
  const reopened = createCanonicalSourceStore(
    join(atomicBatchDirectory, "canonical.sqlite"),
  );
  try {
    assert.equal(queryCanonicalSourceCurrent(reopened).records.length, 0);
  } finally {
    reopened.close();
  }
} finally {
  await rm(atomicBatchDirectory, { recursive: true, force: true });
}

const financialDirectory = await mkdtemp(
  join(tmpdir(), "sinopac-financial-v1-"),
);
try {
  const store = createCanonicalSourceStore(
    join(financialDirectory, "canonical.sqlite"),
  );
  try {
    assert.equal(
      buildSinopacDomesticDepositReadinessFromLedger(store.db).capability,
      "preflight-only",
    );
    const input = {
      capture: admitted.capture!,
      captureId: "sinopac-financial-capture-1",
      humanAttestation: getSinopacHumanAttestedV1Manifest(),
      personalAuthority: (() => {
        recordInitialSinopacHumanAttestationIfMissing(
          store.db,
          baseCapture.observedAt,
        );
        return createSinopacPersonalAuthority(store.db);
      })(),
    };
    assert.ok(
      admitSinopacDomesticDepositFinancialCapture({
        ...input,
        personalAuthority: undefined,
      }).diagnostics.includes("authority-semantics-unproven"),
    );
    assert.ok(
      admitSinopacDomesticDepositFinancialCapture({
        ...input,
        personalAuthority: { source: "durable-attestation" },
      }).diagnostics.includes("authority-semantics-unproven"),
    );
    const financial = admitSinopacDomesticDepositFinancialCapture(input);
    assert.equal(financial.status, "admitted");
    assert.equal(
      financial.capture?.authorityRoute,
      SINOPAC_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
    );
    assert.equal(financial.capture?.semantics.providerGuaranteed, false);
    assert.equal(financial.capture?.records[0]?.effectiveOn, "2026-08-02");
    assert.equal(
      financial.capture?.records[0]?.transactionDateTimeLocal,
      "2026-08-02T09:10",
    );
    assert.equal(financial.capture?.records[0]?.sourceTime.localTime, "09:10");
    assert.equal(financial.capture?.semantics.timePrecision, "minute");
    assert.equal(financial.capture?.scope.absenceAuthority, null);
    assert.throws(
      () =>
        admitCanonicalFinancialDepositCapture({
          ...financial.capture!,
          scope: {
            ...financial.capture!.scope,
            absenceAuthority: "provider-explicit-no-data",
          },
        }),
      /absence authority/i,
    );
    const zeroFinancial = admitSinopacDomesticDepositFinancialCapture({
      ...input,
      capture: explicitNoData.capture!,
      captureId: "sinopac-zero-financial",
    });
    assert.equal(zeroFinancial.status, "admitted");
    assert.equal(
      zeroFinancial.capture?.scope.absenceAuthority,
      "provider-explicit-no-data",
    );
    const cancellationCapture = admitSinopacStatementCaptureEvidence({
      ...baseCapture,
      downloads: [
        {
          ...baseCapture.downloads[0]!,
          rows: [
            {
              ...baseCapture.downloads[0]!.rows[0]!,
              values: baseCapture.downloads[0]!.rows[0]!.values.with(3, "沖正"),
            },
          ],
        },
      ],
    });
    assert.equal(cancellationCapture.status, "admissible");
    assert.ok(
      admitSinopacDomesticDepositFinancialCapture({
        ...input,
        capture: cancellationCapture.capture!,
        captureId: "sinopac-cancellation",
      }).diagnostics.includes("cancellation-marker-unsupported"),
    );
    const financialCommit = await commitCanonicalSinopacDomesticDepositCapture(
      {
        db: store.db,
        databasePath: store.databasePath,
        commitClock: () => store.commitClock(),
      },
      input,
    );
    assert.equal(queryCanonicalSourceCurrent(store).records.length, 1);
    assert.equal(
      queryCanonicalSourceHistorical(store, {
        knowledgeAt: financialCommit.commitSequence,
      }).observations.length,
      1,
    );
    revokeSinopacHumanAttestedV1(
      "2026-08-23T13:00:00.000+08:00",
      "synthetic readiness revocation",
      store.db,
    );
    assert.ok(
      admitSinopacDomesticDepositFinancialCapture(input).diagnostics.includes(
        "human-attestation-mismatch",
      ),
    );
    assert.equal(
      buildSinopacDomesticDepositReadinessFromLedger(store.db).capability,
      "preflight-only",
    );
    restoreSinopacHumanAttestedV1(
      "2026-08-23T14:00:00.000+08:00",
      "synthetic readiness restoration",
      store.db,
    );
    assert.ok(
      admitSinopacDomesticDepositFinancialCapture(input).diagnostics.includes(
        "authority-semantics-unproven",
      ),
    );
    const restoredAuthority = createSinopacPersonalAuthority(store.db);
    assert.equal(
      buildSinopacDomesticDepositReadinessFromLedger(store.db).capability,
      "canonical-human-attested",
    );
    store.db
      .prepare(
        "UPDATE capture_scopes SET absence_authority = 'provider-explicit-no-data' WHERE absence_authority IS NULL",
      )
      .run();
    assert.equal(
      buildSinopacDomesticDepositReadinessFromLedger(store.db).capability,
      "preflight-only",
    );
    store.db
      .prepare(
        "UPDATE capture_scopes SET absence_authority = NULL WHERE absence_authority = 'provider-explicit-no-data'",
      )
      .run();
    const financialIdentity = financial.capture!.identity;
    const financialRecord = financial.capture!.records[0]!;
    const financialLineage = queryCanonicalSourceLineage(store, {
      integrationNamespace: financialIdentity.integrationNamespace,
      sourceConnectionKey: financialIdentity.sourceConnectionKey,
      identityEpoch: financialIdentity.identityEpochKey,
      stream: financialIdentity.stream,
      recordKind: financialIdentity.recordKind,
      subjectDigest: financialIdentity.subjectDigest,
      occurrenceKey: financialRecord.occurrenceKey,
    });
    assert.equal(financialLineage.observations.length, 1);
    assert.equal(financialLineage.provenance.length, 1);
    assert.equal(
      buildSinopacDomesticDepositReadinessFromLedger(store.db).capability,
      "canonical-human-attested",
    );
    await commitCanonicalSinopacDomesticDepositCapture(
      {
        db: store.db,
        databasePath: store.databasePath,
        commitClock: () => store.commitClock(),
      },
      {
        ...input,
        captureId: "sinopac-financial-capture-repeat",
        humanAttestation: getSinopacHumanAttestedV1Manifest(),
        personalAuthority: restoredAuthority,
      },
    );
    assert.equal(
      Number(
        (
          store.db
            .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
            .get() as { count?: number }
        ).count ?? 0,
      ),
      1,
    );
  } finally {
    store.close();
  }
  const reopened = createCanonicalSourceStore(
    join(financialDirectory, "canonical.sqlite"),
  );
  try {
    assert.equal(
      buildSinopacDomesticDepositReadinessFromLedger(reopened.db).capability,
      "canonical-human-attested",
    );
  } finally {
    reopened.close();
  }
} finally {
  await rm(financialDirectory, { recursive: true, force: true });
}

const financialBatchDirectory = await mkdtemp(
  join(tmpdir(), "sinopac-financial-batch-v1-"),
);
try {
  const store = createCanonicalSourceStore(
    join(financialBatchDirectory, "canonical.sqlite"),
  );
  try {
    const second = admitSinopacStatementCaptureEvidence({
      ...baseCapture,
      account: {
        value: "SYNTHETIC-SINOPAC-002",
        label: "SECOND",
        currency: "TWD",
      },
      downloads: [
        {
          ...baseCapture.downloads[0]!,
          rows: Array.from({ length: 19 }, (_, rowOrdinal) => ({
            rowOrdinal,
            values: baseCapture.downloads[0]!.rows[0]!.values.with(
              2,
              `09:${String(10 + rowOrdinal).padStart(2, "0")}`,
            )
              .with(4, String(100 + rowOrdinal))
              .with(6, String(900 + rowOrdinal)),
          })),
        },
      ],
    });
    assert.equal(second.status, "admissible");
    const writer = {
      db: store.db,
      databasePath: store.databasePath,
      commitClock: () => store.commitClock(),
    };
    recordInitialSinopacHumanAttestationIfMissing(
      store.db,
      baseCapture.observedAt,
    );
    const personalAuthority = createSinopacPersonalAuthority(store.db);
    await commitCanonicalSinopacDomesticDepositCaptureBatch(writer, [
      {
        capture: admitted.capture!,
        captureId: "sinopac-batch-account-1",
        humanAttestation: getSinopacHumanAttestedV1Manifest(),
        personalAuthority,
      },
      {
        capture: second.capture!,
        captureId: "sinopac-batch-account-2",
        humanAttestation: getSinopacHumanAttestedV1Manifest(),
        personalAuthority,
      },
    ]);
    assert.equal(
      Number(
        (
          store.db
            .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
            .get() as { count?: number }
        ).count ?? 0,
      ),
      20,
    );
    assert.equal(
      Number(
        (
          store.db
            .prepare(
              "SELECT COUNT(*) AS count FROM capture_scopes WHERE absence_authority IS NULL",
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      2,
    );
    const newFirst = admitSinopacStatementCaptureEvidence({
      ...baseCapture,
      account: {
        value: "SYNTHETIC-SINOPAC-003",
        label: "THIRD",
        currency: "TWD",
      },
    });
    const conflictingSecond = admitSinopacStatementCaptureEvidence({
      ...baseCapture,
      account: {
        value: "SYNTHETIC-SINOPAC-002",
        label: "SECOND",
        currency: "TWD",
      },
      downloads: [
        {
          ...baseCapture.downloads[0]!,
          rows: [
            {
              ...baseCapture.downloads[0]!.rows[0]!,
              values: baseCapture.downloads[0]!.rows[0]!.values.with(
                3,
                "DIFFERENT DESCRIPTION",
              ),
            },
          ],
        },
      ],
    });
    assert.equal(newFirst.status, "admissible");
    assert.equal(conflictingSecond.status, "admissible");
    await assert.rejects(
      () =>
        commitCanonicalSinopacDomesticDepositCaptureBatch(writer, [
          {
            capture: newFirst.capture!,
            captureId: "sinopac-batch-rollback-first",
            humanAttestation: getSinopacHumanAttestedV1Manifest(),
            personalAuthority,
          },
          {
            capture: conflictingSecond.capture!,
            captureId: "sinopac-batch-rollback-second",
            humanAttestation: getSinopacHumanAttestedV1Manifest(),
            personalAuthority,
          },
        ]),
      /collision|conflict/i,
    );
    assert.equal(
      Number(
        (
          store.db
            .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
            .get() as { count?: number }
        ).count ?? 0,
      ),
      20,
      "the first account in a failed batch rolls back",
    );
    assert.equal(
      Number(
        (
          store.db
            .prepare("SELECT COUNT(*) AS count FROM financial_accounts")
            .get() as { count?: number }
        ).count ?? 0,
      ),
      2,
    );
  } finally {
    store.close();
  }
} finally {
  await rm(financialBatchDirectory, { recursive: true, force: true });
}
