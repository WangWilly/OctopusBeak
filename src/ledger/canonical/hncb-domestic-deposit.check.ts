import assert from "node:assert/strict";
import {
  HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  HNCB_DOMESTIC_DEPOSIT_CONTRACT,
  HNCB_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  HNCB_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  HNCB_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_ROUTE,
  HNCB_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RECORD_KIND,
  HNCB_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RULE_VERSION,
  admitHncbDomesticDepositCaptureEvidence,
  admitHncbDomesticDepositFinancialCapture,
  commitHncbDomesticDepositSourceEvidence,
  commitCanonicalHncbDomesticDepositCapture,
  createHncbDomesticDepositSourceEvidence,
  preflightHncbDomesticDeposit,
  getHncbHumanAttestedV1Manifest,
} from "./hncb-domestic-deposit.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCanonicalSourceCaptureAdmission } from "./canonical-source-capture-admission.ts";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  commitCathayDomesticDeposit,
  createCanonicalSourceStore,
  queryCanonicalSourceCurrent,
  queryCanonicalSourceHistorical,
  queryCanonicalSourceLineage,
  validateCanonicalSourceStore,
} from "./canonical-source-store.ts";
import { admitCanonicalFinancialDepositCapture } from "./canonical-financial-deposit-writer.ts";
import { buildHncbDomesticDepositReadinessFromLedger } from "./advertised-domestic-deposit-readiness.ts";

assert.equal(
  HNCB_DOMESTIC_DEPOSIT_CONTRACT.authority,
  "hncb/domestic-deposit/preflight-v1",
);
const positive = preflightHncbDomesticDeposit(
  HNCB_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
);
assert.equal(positive.structuralStatus, "observed");
assert.equal(positive.status, "blocked");

const zero = preflightHncbDomesticDeposit({
  ...HNCB_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  records: [],
  transport: { noDataMessage: "查無資料" },
});
assert.equal(zero.zeroResultEvidence, "provider-explicit");
assert.equal(zero.structuralStatus, "observed");
assert.ok(
  zero.diagnostics.some((item) => item.code === "authority-semantics-unproven"),
);

const absenceWithoutProviderSignal = preflightHncbDomesticDeposit({
  ...HNCB_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  records: [],
});
assert.equal(absenceWithoutProviderSignal.zeroResultEvidence, "unproven");
assert.ok(
  absenceWithoutProviderSignal.diagnostics.some(
    (item) => item.code === "empty-scope-unproven",
  ),
);
const invalid = preflightHncbDomesticDeposit({
  ...HNCB_DOMESTIC_DEPOSIT_SYNTHETIC_FIXTURE_V1,
  records: [{ values: Array(10).fill(""), sourcePostingStatus: "posted" }],
});
assert.ok(
  invalid.diagnostics.some((item) => item.code === "row-width-invalid"),
);

const digest = (letter: string) => `sha256:${letter.repeat(64)}` as const;
const sourceCapture = {
  evidenceVersion: HNCB_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  source: "hncb" as const,
  product: "domestic-deposit" as const,
  providerGuaranteed: false as const,
  observedAt: "2026-08-20T12:00:00.000+08:00",
  account: {
    value: "SYNTHETIC-HNCB-ACCOUNT-001",
    label: "SYNTHETIC HNCB ACCOUNT LABEL",
  },
  queryRange: {
    startDate: "2026/08/01",
    endDate: "2026/08/20",
  },
  downloads: [
    {
      filename: "synthetic-hncb-statement.xls",
      byteLength: 2048,
      contentDigest: digest("a"),
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
            "PRIVATE DESCRIPTION",
            "PRIVATE DEPOSITOR",
            "PRIVATE NOTE",
            "PRIVATE NUMBER",
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

const admitted = admitHncbDomesticDepositCaptureEvidence(sourceCapture);
assert.equal(admitted.status, "admissible");
assert.ok(admitted.capture);
const sourceEvidence = createHncbDomesticDepositSourceEvidence(
  admitted.capture,
  "hncb-capture-1",
);
assert.equal(
  sourceEvidence.routeKey,
  HNCB_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_ROUTE,
);
assert.equal(
  sourceEvidence.recordKind,
  HNCB_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RECORD_KIND,
);
assert.equal(
  sourceEvidence.scope.ruleVersion,
  HNCB_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_RULE_VERSION,
);
assert.equal(sourceEvidence.scope.completeness, "single-page");
assert.equal(sourceEvidence.records[0]?.compact.amountDirection, "outflow");
assert.equal(
  sourceEvidence.records[0]?.compact.semanticStatus,
  "observed-structural-only",
);
assert.doesNotMatch(
  JSON.stringify(sourceEvidence),
  /SYNTHETIC-HNCB-ACCOUNT|PRIVATE DESCRIPTION|PRIVATE DEPOSITOR|PRIVATE NOTE|PRIVATE NUMBER/,
);
assert.deepEqual(
  createHncbDomesticDepositSourceEvidence(admitted.capture, "hncb-capture-1"),
  sourceEvidence,
);

const rejected = (patch: Record<string, unknown>, expected?: string) => {
  const result = admitHncbDomesticDepositCaptureEvidence({
    ...sourceCapture,
    ...patch,
  } as typeof sourceCapture);
  assert.equal(result.status, "rejected");
  if (expected)
    assert.ok(result.diagnostics.includes(expected as never), expected);
};

rejected({ source: "other" }, "source-invalid");
rejected({ product: "credit-card" }, "source-invalid");
rejected(
  {
    downloads: [
      {
        ...sourceCapture.downloads[0]!,
        rows: [
          {
            ...sourceCapture.downloads[0]!.rows[0]!,
            values: [...sourceCapture.downloads[0]!.rows[0]!.values].with(
              3,
              "USD",
            ),
          },
        ],
      },
    ],
  },
  "row-currency-invalid",
);
rejected(
  {
    downloads: [
      {
        ...sourceCapture.downloads[0]!,
        rows: [
          {
            ...sourceCapture.downloads[0]!.rows[0]!,
            values: [...sourceCapture.downloads[0]!.rows[0]!.values].with(
              0,
              "2026/02/30",
            ),
          },
        ],
      },
    ],
  },
  "row-date-invalid",
);
rejected(
  {
    downloads: [
      {
        ...sourceCapture.downloads[0]!,
        rows: [
          {
            ...sourceCapture.downloads[0]!.rows[0]!,
            values: [...sourceCapture.downloads[0]!.rows[0]!.values].with(
              1,
              "09:10",
            ),
          },
        ],
      },
    ],
  },
  "row-time-invalid",
);
for (const amounts of [
  ["100", "200"],
  ["0", ""],
  ["", "0"],
  ["not-an-amount", ""],
] as const) {
  rejected({
    downloads: [
      {
        ...sourceCapture.downloads[0]!,
        rows: [
          {
            ...sourceCapture.downloads[0]!.rows[0]!,
            values: [...sourceCapture.downloads[0]!.rows[0]!.values]
              .with(4, amounts[0])
              .with(5, amounts[1]),
          },
        ],
      },
    ],
  });
}
rejected(
  {
    downloads: [{ ...sourceCapture.downloads[0]!, terminal: false }],
  },
  "download-terminal-invalid",
);
rejected(
  {
    downloads: [{ ...sourceCapture.downloads[0]!, rows: [] }],
  },
  "zero-result-authority-unproven",
);
const explicitNoData = admitHncbDomesticDepositCaptureEvidence({
  ...sourceCapture,
  zeroResultAuthority: "provider-explicit-no-data",
  downloads: [{ ...sourceCapture.downloads[0]!, rows: [] }],
});
assert.equal(explicitNoData.status, "admissible");

const sourceDirectory = await mkdtemp(join(tmpdir(), "hncb-source-v1-"));
try {
  const store = createCanonicalSourceStore(
    join(sourceDirectory, "canonical.sqlite"),
  );
  validateCanonicalSourceStore(store);
  const first = await commitHncbDomesticDepositSourceEvidence(
    store,
    admitted.capture,
    "hncb-capture-1",
  );
  const repeat = await commitHncbDomesticDepositSourceEvidence(
    store,
    admitted.capture,
    "hncb-capture-2",
  );
  assert.equal(first.status, "durable-source-evidence");
  assert.equal(repeat.status, "durable-source-evidence");
  const current = queryCanonicalSourceCurrent(store);
  assert.equal(current.records.length, 1);
  assert.equal(current.observations.length, 2);
  const historical = queryCanonicalSourceHistorical(store, {
    knowledgeAt: first.commitSequence,
  });
  assert.equal(historical.observations.length, 1);
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
  const registered = store.db
    .prepare(
      "SELECT integration_namespace, stream, contract_version FROM source_authority_routes WHERE authority_route = ?",
    )
    .get(HNCB_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_ROUTE) as Record<
    string,
    unknown
  >;
  assert.equal(registered.integration_namespace, "hncb");
  assert.equal(registered.stream, "domestic-deposit");
  assert.equal(
    registered.contract_version,
    HNCB_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  );
  for (const table of [
    "financial_accounts",
    "financial_transactions",
    "transaction_revisions",
    "assertions",
    "current_transactions",
  ]) {
    assert.equal(
      (
        store.db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as {
          value?: number;
        }
      ).value,
      0,
      `${table} remains empty for HNCB source-only evidence`,
    );
  }
  await assert.rejects(
    () =>
      createCanonicalSourceCaptureAdmission(store).admit({
          ...sourceEvidence,
          captureId: "hncb-capture-conflict",
          records: [{ ...record, occurrenceKey: digest("b") }],
        }),
    /collision|conflict|overwrite/i,
  );
  assert.equal(queryCanonicalSourceCurrent(store).observations.length, 2);
  store.close();
  const reopened = createCanonicalSourceStore(
    join(sourceDirectory, "canonical.sqlite"),
  );
  assert.equal(queryCanonicalSourceCurrent(reopened).observations.length, 2);
  reopened.close();
} finally {
  await rm(sourceDirectory, { recursive: true, force: true });
}

const mixedDirectory = await mkdtemp(join(tmpdir(), "hncb-mixed-bank-v1-"));
try {
  await commitCathayDomesticDeposit(
    mixedDirectory,
    CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  );
  const mixed = createCanonicalSourceStore(
    join(mixedDirectory, "canonical.sqlite"),
  );
  try {
    const cathayFinancialCount = Number(
      (
        mixed.db
          .prepare("SELECT COUNT(*) AS value FROM financial_transactions")
          .get() as { value?: number }
      ).value ?? 0,
    );
    assert.ok(cathayFinancialCount > 0);
    await commitHncbDomesticDepositSourceEvidence(
      mixed,
      admitted.capture,
      "hncb-mixed-source-capture",
    );
    validateCanonicalSourceStore(mixed);
    assert.equal(
      (
        mixed.db
          .prepare(
            "SELECT COUNT(*) AS value FROM source_captures WHERE authority_route = ?",
          )
          .get(HNCB_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_ROUTE) as {
          value?: number;
        }
      ).value,
      1,
    );
    assert.equal(
      (
        mixed.db
          .prepare("SELECT COUNT(*) AS value FROM financial_transactions")
          .get() as { value?: number }
      ).value,
      cathayFinancialCount,
    );
  } finally {
    mixed.close();
  }
  const reopenedMixed = createCanonicalSourceStore(
    join(mixedDirectory, "canonical.sqlite"),
  );
  try {
    validateCanonicalSourceStore(reopenedMixed);
    assert.equal(
      (
        reopenedMixed.db
          .prepare(
            "SELECT COUNT(*) AS value FROM source_captures WHERE authority_route = ?",
          )
          .get(HNCB_DOMESTIC_DEPOSIT_SOURCE_EVIDENCE_ROUTE) as {
          value?: number;
        }
      ).value,
      1,
    );
  } finally {
    reopenedMixed.close();
  }
} finally {
  await rm(mixedDirectory, { recursive: true, force: true });
}

const financialDirectory = await mkdtemp(join(tmpdir(), "hncb-financial-v1-"));
try {
  const store = createCanonicalSourceStore(
    join(financialDirectory, "canonical.sqlite"),
  );
  try {
    assert.equal(
      buildHncbDomesticDepositReadinessFromLedger(store.db).capability,
      "preflight-only",
    );
    const financialInput = {
      capture: admitted.capture,
      captureId: "hncb-financial-capture-1",
      humanAttestation: getHncbHumanAttestedV1Manifest(),
    };
    const admission = admitHncbDomesticDepositFinancialCapture(financialInput);
    assert.equal(admission.status, "admitted");
    assert.ok(admission.capture);
    const admittedFinancialCapture = admission.capture;
    assert.equal(
      admission.capture.identity.accountNo,
      "SYNTHETIC-HNCB-ACCOUNT-001",
    );
    const financialRecord = admission.capture.records[0]!;
    const financialCompact = JSON.parse(financialRecord.compactJson) as Record<
      string,
      unknown
    >;
    assert.equal(financialCompact.accountingDate, "2026-08-03");
    assert.equal(financialCompact.transactionDate, "2026-08-02");
    assert.equal(financialCompact.transactionTime, "09:10:11");
    assert.equal(financialRecord.effectiveOn, "2026-08-02");
    assert.equal(
      financialRecord.transactionDateTimeLocal,
      "2026-08-02T09:10:11",
    );
    assert.deepEqual(financialRecord.sourceTime, {
      localDate: "2026-08-02",
      localTime: "09:10:11",
      timeZone: "Asia/Taipei",
      epochMilliseconds: Date.parse("2026-08-02T09:10:11+08:00"),
    });
    const sharedAccountStructural = admitHncbDomesticDepositCaptureEvidence({
      ...sourceCapture,
      account: {
        value: "SYNTHETIC-HNCB-SHARED-ACCOUNT",
        label: "SYNTHETIC JOINT ACCOUNT",
      },
    });
    assert.equal(sharedAccountStructural.status, "admissible");
    assert.ok(sharedAccountStructural.capture);
    const sharedAccountAdmission = admitHncbDomesticDepositFinancialCapture({
      capture: sharedAccountStructural.capture,
      captureId: "hncb-financial-shared-account",
      humanAttestation: getHncbHumanAttestedV1Manifest(),
    });
    assert.equal(sharedAccountAdmission.status, "blocked");
    assert.ok(
      sharedAccountAdmission.diagnostics.includes("authority-shared-account"),
    );
    const cancellationStructural = admitHncbDomesticDepositCaptureEvidence({
      ...sourceCapture,
      downloads: [
        {
          ...sourceCapture.downloads[0]!,
          rows: [
            {
              ...sourceCapture.downloads[0]!.rows[0]!,
              values: sourceCapture.downloads[0]!.rows[0]!.values.with(
                7,
                "沖正",
              ),
            },
          ],
        },
      ],
    });
    assert.equal(cancellationStructural.status, "admissible");
    assert.ok(cancellationStructural.capture);
    const cancellationAdmission = admitHncbDomesticDepositFinancialCapture({
      capture: cancellationStructural.capture,
      captureId: "hncb-financial-cancellation",
      humanAttestation: getHncbHumanAttestedV1Manifest(),
    });
    assert.equal(cancellationAdmission.status, "blocked");
    assert.ok(
      cancellationAdmission.diagnostics.includes(
        "cancellation-marker-unsupported",
      ),
    );
    assert.throws(
      () =>
        admitCanonicalFinancialDepositCapture({
          ...admittedFinancialCapture,
          authorityRoute: "unknown/hncb/domestic-deposit",
        }),
      /unknown canonical financial authority route/i,
    );
    await commitCanonicalHncbDomesticDepositCapture(
      {
        db: store.db,
        databasePath: store.databasePath,
        commitClock: () => store.commitClock(),
      },
      financialInput,
    );
    assert.equal(
      (
        store.db
          .prepare("SELECT COUNT(*) AS value FROM financial_transactions")
          .get() as { value?: number }
      ).value,
      1,
    );
    assert.equal(
      buildHncbDomesticDepositReadinessFromLedger(store.db).capability,
      "canonical-human-attested",
    );
    await commitCanonicalHncbDomesticDepositCapture(
      {
        db: store.db,
        databasePath: store.databasePath,
        commitClock: () => store.commitClock(),
      },
      { ...financialInput, captureId: "hncb-financial-capture-2" },
    );
    assert.equal(
      (
        store.db
          .prepare("SELECT COUNT(*) AS value FROM financial_transactions")
          .get() as { value?: number }
      ).value,
      1,
    );
    const collisionSource = {
      ...sourceCapture,
      downloads: [
        {
          ...sourceCapture.downloads[0]!,
          rows: [
            sourceCapture.downloads[0]!.rows[0]!,
            {
              ...sourceCapture.downloads[0]!.rows[0]!,
              rowOrdinal: 1,
              values: sourceCapture.downloads[0]!.rows[0]!.values.with(
                7,
                "DIFFERENT DESCRIPTION",
              ),
            },
          ],
        },
      ],
    };
    const collisionStructural =
      admitHncbDomesticDepositCaptureEvidence(collisionSource);
    assert.equal(collisionStructural.status, "admissible");
    assert.ok(collisionStructural.capture);
    const collisionAdmission = admitHncbDomesticDepositFinancialCapture({
      capture: collisionStructural.capture,
      captureId: "hncb-financial-collision",
      humanAttestation: getHncbHumanAttestedV1Manifest(),
    });
    assert.equal(collisionAdmission.status, "blocked");
    assert.ok(collisionAdmission.diagnostics.includes("occurrence-ambiguous"));
    await assert.rejects(
      () =>
        commitCanonicalHncbDomesticDepositCapture(
          {
            db: store.db,
            databasePath: store.databasePath,
            commitClock: () => store.commitClock(),
          },
          {
            capture: collisionStructural.capture!,
            captureId: "hncb-financial-collision",
            humanAttestation: getHncbHumanAttestedV1Manifest(),
          },
        ),
      /canonical admission blocked|occurrence-ambiguous/i,
    );
    assert.equal(
      (
        store.db
          .prepare("SELECT COUNT(*) AS value FROM financial_transactions")
          .get() as { value?: number }
      ).value,
      1,
    );
  } finally {
    store.close();
  }
} finally {
  await rm(financialDirectory, { recursive: true, force: true });
}
