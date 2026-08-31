import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  CANONICAL_SOURCE_SCHEMA_VERSION,
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  admitCanonicalSourceEvidence,
  commitCathayDomesticDeposit,
  commitCanonicalSourceEvidence,
  createCanonicalFinancialQuery,
  createCanonicalSourceStore,
  createCathayCanonicalFinancialQuery,
  queryCanonicalSourceCurrent,
  queryCanonicalSourceHistorical,
  queryCanonicalSourceLineage,
  openCanonicalDatabase,
  validateCanonicalSourceStore,
  type CanonicalSourceEvidence,
  type CanonicalValidatedSourceEvidence,
} from "./canonical-source-store.ts";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositCapture,
} from "./canonical-financial-deposit-writer.ts";
import {
  admitHncbDomesticDepositCaptureEvidence,
  admitHncbDomesticDepositFinancialCapture,
  commitCanonicalHncbDomesticDepositCapture,
  HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  getHncbHumanAttestedV1Manifest,
} from "./hncb-domestic-deposit.ts";
import {
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE,
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE,
} from "./yuanta-credit-card-human-attestation.ts";

const token = (letter: string) => `sha256:${letter.repeat(64)}`;

const fubonCreditCardFinancialCapture = (
  version: "v1" | "v2",
  captureId: string,
): CanonicalFinancialDepositCapture => {
  const route = `fubon/credit-card/human-attested-${version}`;
  const sourceDate = "2026-08-01";
  const occurrenceKey = token(version === "v1" ? "g" : "h");
  return {
    captureId,
    authorityRoute: route,
    contractVersion: route,
    identity: {
      integrationNamespace: "fubon",
      sourceConnectionKey: token(version === "v1" ? "i" : "j"),
      identityEpochKey: token(version === "v1" ? "k" : "l"),
      stream: "credit-card",
      recordKind: "fubon-credit-card-transaction",
      subjectDigest: token(version === "v1" ? "m" : "n"),
      accountNo: `fubon-${version}-portfolio`,
      accountType: "credit",
      currency: "TWD",
    },
    observedAt: "2026-08-26T00:00:00.000Z",
    scope: {
      startDate: sourceDate,
      endDate: sourceDate,
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: "six-billed-periods-plus-unbilled-terminal-grids",
      completenessRuleVersion: route,
      absenceAuthority: null,
      contractFingerprint: token(version === "v1" ? "o" : "p"),
      preflightFingerprint: token(version === "v1" ? "q" : "r"),
      pageCount: 7,
      withdrawalPolicy: "never-infer",
    },
    semantics: {
      postingStatus: "posted",
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      postingRuleVersion: route,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: route,
      effectiveTimeBasis: "transaction-time",
      effectiveTimeRuleVersion: route,
      timeZone: "Asia/Taipei",
      timePrecision: "date",
      timeOrigin: "defaulted_local_midnight",
      requireBalance: false,
      providerGuaranteed: false,
      occurrenceProviderGuaranteed: false,
    },
    pages: Array.from({ length: 7 }, (_, pageOrdinal) => ({
      pageOrdinal,
      responseCode: "200",
      terminal: true,
      rowCount: pageOrdinal === 0 ? 1 : 0,
      responseDigest: token(version === "v1" ? "s" : "t"),
      proofKind: "source-declared-terminal-grid",
      contractFingerprint: token(version === "v1" ? "o" : "p"),
      preflightFingerprint: token(version === "v1" ? "q" : "r"),
      metadataJson: JSON.stringify({ pageOrdinal }),
    })),
    records: [
      {
        occurrenceKey,
        collisionKey: token(version === "v1" ? "u" : "v"),
        providerKey: "human-attested:no-provider-key",
        humanAttestedOccurrenceKey: occurrenceKey,
        contentHash: token(version === "v1" ? "w" : "x"),
        sequenceLexeme: "observed-source-order:0",
        compactJson: JSON.stringify({
          occurrenceKey,
          amount: { coefficient: "100", scale: 0 },
          currency: "TWD",
          direction: "outflow",
          balanceAfter: null,
        }),
        amount: { coefficient: "100", scale: 0 },
        balanceAfter: null,
        currency: "TWD",
        direction: "outflow",
        sourceTime: {
          localDate: sourceDate,
          localTime: "00:00:00",
          timeZone: "Asia/Taipei",
          epochMilliseconds: Date.parse(`${sourceDate}T00:00:00+08:00`),
          precision: "date",
          timeOrigin: "defaulted_local_midnight",
        },
        effectiveOn: sourceDate,
        transactionDateTimeLocal: `${sourceDate}T00:00:00`,
        description: "historical-only Fubon fixture",
      },
    ],
  };
};

/** A privacy-safe cross-version fixture: both routes share the durable Yuanta
 * source-connection lineage, while their versioned subject/account and
 * transaction identities remain distinct. */
const yuantaCreditCardFinancialCapture = (
  version: "v1" | "v2",
  captureId: string,
): CanonicalFinancialDepositCapture => {
  const route = `yuanta/credit-card/human-attested-${version}`;
  const base = fubonCreditCardFinancialCapture(version, captureId);
  const opaque = (label: string, ordinal: number): `sha256:${string}` =>
    `sha256:${createHash("sha256")
      .update(`yuanta-query-${label}:${ordinal}`)
      .digest("base64url")}`;
  const records = Array.from({ length: 31 }, (_, ordinal) => {
    const sourceDate = "2026-08-01";
    const occurrenceKey = opaque("occurrence", ordinal);
    return {
      ...base.records[0]!,
      occurrenceKey,
      collisionKey: opaque("collision", ordinal),
      humanAttestedOccurrenceKey: occurrenceKey,
      contentHash: opaque("content", ordinal),
      sequenceLexeme: `observed-source-order:${ordinal}`,
      compactJson: JSON.stringify({ ordinal, source: "yuanta-query-fixture" }),
      sourceTime: {
        ...base.records[0]!.sourceTime,
        localDate: sourceDate,
        epochMilliseconds: Date.parse(`${sourceDate}T00:00:00+08:00`),
      },
      effectiveOn: sourceDate,
      transactionDateTimeLocal: `${sourceDate}T00:00:00`,
      description: "historical/current Yuanta route-precedence fixture",
    };
  });
  return {
    ...base,
    authorityRoute: route,
    contractVersion: route,
    identity: {
      ...base.identity,
      integrationNamespace: "yuanta",
      sourceConnectionKey: token("y"),
      identityEpochKey: token("z"),
      recordKind: "yuanta-credit-card-transaction",
      subjectDigest: opaque("subject", version === "v1" ? 1 : 2),
      accountNo: `yuanta-query-${version}-portfolio`,
    },
    scope: {
      ...base.scope,
      completenessBasis:
        version === "v1"
          ? "six-billed-months-plus-unbilled-terminal-no-pager"
          : "six-billed-months-plus-unbilled-terminal-no-pager-plus-settled-summary-cycles",
      completenessRuleVersion: route,
    },
    semantics: {
      ...base.semantics,
      postingRuleVersion: route,
      semanticRuleVersion: route,
      effectiveTimeRuleVersion: route,
    },
    pages: base.pages.map((page, pageOrdinal) => ({
      ...page,
      rowCount: pageOrdinal === 0 ? records.length : 0,
      contractFingerprint: base.scope.contractFingerprint,
      preflightFingerprint: base.scope.preflightFingerprint,
      proofKind: "no-pager-terminal-grid" as const,
    })),
    records,
  };
};

const evidence = (captureId: string): CanonicalSourceEvidence => ({
  captureId,
  integrationNamespace: "synthetic",
  sourceConnectionKey: token("a"),
  identityEpoch: token("b"),
  stream: "domestic-deposit",
  recordKind: "source-record",
  routeKey: "synthetic/domestic-deposit/v8",
  contractVersion: "synthetic-v8",
  subjectDigest: token("c"),
  observedAt: "2026-08-19T00:00:00.000Z",
  scope: {
    startDate: "20260101",
    endDate: "20260102",
    kind: "point-in-time",
    completeness: "single-page",
    ruleVersion: "synthetic-completeness-v1",
  },
  pages: [
    {
      pageOrdinal: 0,
      responseCode: "200",
      rowCount: 1,
      terminal: true,
      metadata: { pageCount: 1, totalCount: 1 },
    },
  ],
  records: [
    {
      occurrenceKey: token("d"),
      collisionKey: token("7"),
      providerKey: token("e"),
      contentHash: token("f"),
      compact: {
        sourceSequence: "1",
        directionCode: "1",
        amount: { coefficient: "100", scale: 0 },
      },
    },
  ],
});

const lineageRequest = {
  integrationNamespace: "synthetic",
  sourceConnectionKey: token("a"),
  identityEpoch: token("b"),
  stream: "domestic-deposit",
  recordKind: "source-record",
  subjectDigest: token("c"),
  occurrenceKey: token("d"),
} as const;

const directory = await mkdtemp(join(tmpdir(), "canonical-source-v8-"));
try {
  const path = join(directory, "canonical.sqlite");
  const store = createCanonicalSourceStore(path);
  validateCanonicalSourceStore(store);
  assert.equal(
    Number(
      (
        store.db.prepare("PRAGMA user_version").get() as {
          user_version?: number;
        }
      ).user_version,
    ),
    CANONICAL_SOURCE_SCHEMA_VERSION,
  );
  await assert.rejects(
    () =>
      commitCanonicalSourceEvidence(
        store,
        evidence(
          "capture-unbranded",
        ) as unknown as CanonicalValidatedSourceEvidence,
      ),
    /runtime|validated|admission/i,
  );

  const first = await commitCanonicalSourceEvidence(
    store,
    admitCanonicalSourceEvidence(evidence("capture-1")),
  );
  assert.equal(first.status, "durable-source-evidence");
  const repeat = await commitCanonicalSourceEvidence(
    store,
    admitCanonicalSourceEvidence(evidence("capture-2")),
  );
  assert.equal(repeat.status, "durable-source-evidence");
  const current = queryCanonicalSourceCurrent(store);
  assert.equal(current.records.length, 1);
  assert.equal(current.observations.length, 2);
  assert.deepEqual(
    current.observations.map((observation) => observation.captureId),
    ["capture-1", "capture-2"],
  );
  const historical = queryCanonicalSourceHistorical(store, { knowledgeAt: 2 });
  assert.equal(historical.observations.length, 2);
  assert.throws(
    () => queryCanonicalSourceHistorical(store, { effectiveAt: "20260101" }),
    /effective|financial/i,
  );
  const lineage = queryCanonicalSourceLineage(store, lineageRequest);
  assert.equal(lineage.observations.length, 2);
  assert.equal(lineage.provenance.length, 2);
  assert.equal(JSON.stringify(current).includes("rawResponse"), false);
  assert.equal(JSON.stringify(current).includes("headers"), false);
  for (const table of [
    "financial_accounts",
    "financial_transactions",
    "transaction_revisions",
    "assertions",
    "source_sync_states",
    "current_transactions",
  ]) {
    assert.equal(
      (
        store.db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as {
          value?: number;
        }
      ).value,
      0,
      `${table} remains untouched by source-only evidence`,
    );
  }
  assert.equal(
    (
      store.db
        .prepare(
          "SELECT COUNT(*) AS value FROM sqlite_master WHERE name LIKE 'canonical_source_%'",
        )
        .get() as { value?: number }
    ).value,
    0,
  );

  await assert.rejects(
    () =>
      commitCanonicalSourceEvidence(
        store,
        admitCanonicalSourceEvidence({
          ...evidence("capture-conflict"),
          records: [
            {
              ...evidence("capture-conflict").records[0]!,
              providerKey: token("9"),
            },
          ],
        }),
      ),
    /conflict|overwrite/i,
  );
  assert.equal(queryCanonicalSourceCurrent(store).observations.length, 2);
  await assert.rejects(
    () =>
      commitCanonicalSourceEvidence(
        store,
        admitCanonicalSourceEvidence({
          ...evidence("capture-collision"),
          records: [
            {
              ...evidence("capture-collision").records[0]!,
              occurrenceKey: token("8"),
            },
          ],
        }),
      ),
    /collision|conflict|overwrite/i,
  );
  assert.equal(queryCanonicalSourceCurrent(store).observations.length, 2);
  store.close();

  const reopened = createCanonicalSourceStore(path);
  assert.equal(queryCanonicalSourceCurrent(reopened).observations.length, 2);
  reopened.close();
} finally {
  await rm(directory, { recursive: true, force: true });
}

const localSecondDirectory = await mkdtemp(
  join(tmpdir(), "canonical-source-cathay-local-second-"),
);
try {
  const localSecondRaw = CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse
    .replace('"startDate":"2025-08-17"', '"startDate":"2025-08-17T00:00:00"')
    .replace('"endDate":"2026-08-17"', '"endDate":"2026-08-17T23:59:59"')
    .replace(
      '"accountDate":"2026-07-01"',
      '"accountDate":"2026-07-01T00:00:01"',
    )
    .replace(
      '"accountDate":"2026-07-02"',
      '"accountDate":"2026-07-02T12:34:56"',
    )
    .replace(
      '"accountDate":"2026-07-03"',
      '"accountDate":"2026-07-03T23:59:59"',
    );
  const committed = await commitCathayDomesticDeposit(localSecondDirectory, {
    ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    rawResponse: localSecondRaw,
  });
  const query = createCathayCanonicalFinancialQuery(localSecondDirectory);
  const current = await query.current({ kind: "current" });
  assert.equal(current.transactions.length, 3);
  assert.deepEqual(
    current.transactions.map((transaction) => transaction.effectiveOn).sort(),
    ["2026-07-01", "2026-07-02", "2026-07-03"],
  );
  const historical = await query.historical({
    kind: "historical",
    cutoff: {
      kind: "both",
      financialAt: "2026-12-31",
      knowledgeAt: String(committed.commitSequence),
    },
  });
  assert.deepEqual(
    historical.transactions
      .map((transaction) => transaction.effectiveOn)
      .sort(),
    ["2026-07-01", "2026-07-02", "2026-07-03"],
  );
  const lineage = await query.lineage({
    kind: "lineage",
    subject: { kind: "transaction", id: current.transactions[0]!.id },
  });
  assert.equal(lineage.entries.length, 1);
  assert.equal(lineage.entries[0]?.revision.effectiveOn, "2026-07-01");
  const reopened = await createCathayCanonicalFinancialQuery(
    localSecondDirectory,
  ).current({ kind: "current" });
  assert.deepEqual(
    reopened.transactions.map((transaction) => transaction.effectiveOn).sort(),
    ["2026-07-01", "2026-07-02", "2026-07-03"],
  );
  const db = openCanonicalDatabase(localSecondDirectory, { readOnly: true });
  try {
    assert.equal(
      db.prepare("SELECT response_digest FROM capture_scope_pages").get()
        ?.response_digest,
      createHash("sha256").update(localSecondRaw, "utf8").digest("hex"),
    );
    const sourcePayload = String(
      db
        .prepare(
          "SELECT payload_json FROM source_records ORDER BY sequence_lexeme LIMIT 1",
        )
        .get()?.payload_json,
    );
    assert.match(sourcePayload, /2026-07-01T00:00:01/);
    assert.doesNotMatch(sourcePayload, /private-account-date/);
    const revisionRows = (
      db
        .prepare(
          "SELECT effective_on, transaction_date_time_local FROM transaction_revisions ORDER BY effective_on",
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      effective_on: row.effective_on,
      transaction_date_time_local: row.transaction_date_time_local,
    }));
    assert.deepEqual(revisionRows, [
      {
        effective_on: "2026-07-01",
        transaction_date_time_local: "2026-07-01T09:00:00",
      },
      {
        effective_on: "2026-07-02",
        transaction_date_time_local: "2026-07-02T10:15:30",
      },
      {
        effective_on: "2026-07-03",
        transaction_date_time_local: "2026-07-03T11:45:00",
      },
    ]);
  } finally {
    db.close();
  }
} finally {
  await rm(localSecondDirectory, { recursive: true, force: true });
}

for (const [label, startDateValue] of [
  ["local-second-prefix-mismatch", "2025-08-18T00:00:00"],
  ["datetime-minute", "2025-08-17T00:00"],
  ["datetime-invalid-hour", "2025-08-17T24:00:00"],
  ["datetime-invalid-minute", "2025-08-17T23:60:00"],
  ["datetime-invalid-second", "2025-08-17T23:59:60"],
  ["datetime-fractional", "2025-08-17T00:00:00.000+08:00"],
  ["datetime-z", "2025-08-17T00:00:00Z"],
  ["datetime-offset", "2025-08-17T00:00:00+08:00"],
  ["datetime-space", "2025-08-17 00:00:00"],
  ["datetime-garbage", "2025-08-17Tgarbage"],
  ["datetime-short", "2025-08-17T00"],
  ["invalid-calendar", "2025-02-30T00:00:00+08:00"],
  ["compact", "20250817"],
  ["slash", "2025/08/17"],
  ["other", "private-date-shape"],
] as const) {
  const rejectedDirectory = await mkdtemp(
    join(tmpdir(), `canonical-source-cathay-datetime-${label}-`),
  );
  try {
    const rejectedStore = createCanonicalSourceStore(
      join(rejectedDirectory, "canonical.sqlite"),
    );
    rejectedStore.close();
    const rejectedRaw = CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace(
      '"startDate":"2025-08-17"',
      `"startDate":"${startDateValue}"`,
    );
    assert.throws(
      () =>
        commitCathayDomesticDeposit(rejectedDirectory, {
          ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
          rawResponse: rejectedRaw,
        }),
      /response date scope|YYYY-MM-DD|valid calendar date/i,
    );
    const rejectedDb = openCanonicalDatabase(rejectedDirectory, {
      readOnly: true,
    });
    try {
      assert.equal(
        rejectedDb
          .prepare("SELECT COUNT(*) AS count FROM source_captures")
          .get()?.count,
        0,
      );
      assert.equal(
        rejectedDb
          .prepare("SELECT COUNT(*) AS count FROM financial_transactions")
          .get()?.count,
        0,
      );
    } finally {
      rejectedDb.close();
    }
  } finally {
    await rm(rejectedDirectory, { recursive: true, force: true });
  }
}

for (const [label, accountDateValue] of [
  ["account-datetime-invalid-hour", "2026-07-01T24:00:00"],
  ["account-datetime-invalid-minute", "2026-07-01T23:60:00"],
  ["account-datetime-invalid-second", "2026-07-01T23:59:60"],
  ["account-datetime-malformed", "2026-07-01Tgarbage"],
  ["account-datetime-minute", "2026-07-01T00:00"],
  ["account-datetime-fractional", "2026-07-01T00:00:00.000"],
  ["account-datetime-z", "2026-07-01T00:00:00Z"],
  ["account-datetime-offset", "2026-07-01T00:00:00+08:00"],
  ["account-datetime-space", "2026-07-01 00:00:00"],
  ["account-datetime-invalid-calendar", "2026-02-30T00:00:00"],
  ["account-invalid-calendar", "2026-02-30"],
  ["account-compact", "20260701"],
  ["account-slash", "2026/07/01"],
] as const) {
  const rejectedDirectory = await mkdtemp(
    join(tmpdir(), `canonical-source-cathay-account-date-${label}-`),
  );
  try {
    const rejectedStore = createCanonicalSourceStore(
      join(rejectedDirectory, "canonical.sqlite"),
    );
    rejectedStore.close();
    const rejectedRaw = CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace(
      '"accountDate":"2026-07-01"',
      `"accountDate":"${accountDateValue}"`,
    );
    assert.throws(
      () =>
        commitCathayDomesticDeposit(rejectedDirectory, {
          ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
          rawResponse: rejectedRaw,
        }),
      /accountDate|YYYY-MM-DD|valid calendar date/i,
    );
    const rejectedDb = openCanonicalDatabase(rejectedDirectory, {
      readOnly: true,
    });
    try {
      for (const table of [
        "canonical_commits",
        "source_captures",
        "financial_transactions",
        "transaction_revisions",
      ]) {
        assert.equal(
          rejectedDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
            ?.count,
          0,
          `${table} remains empty after rejected accountDate`,
        );
      }
    } finally {
      rejectedDb.close();
    }
  } finally {
    await rm(rejectedDirectory, { recursive: true, force: true });
  }
}

const fenceDirectory = await mkdtemp(join(tmpdir(), "canonical-source-fence-"));
try {
  let clock = 2_000_000;
  const path = join(fenceDirectory, "canonical.sqlite");
  const store = createCanonicalSourceStore(path, {
    commitClock: () => clock--,
  });
  await commitCanonicalSourceEvidence(
    store,
    admitCanonicalSourceEvidence(evidence("fence-base")),
  );
  for (const [captureId, overrides] of [
    ["fence-connection", { sourceConnectionKey: token("1") }],
    ["fence-epoch", { identityEpoch: token("2") }],
    ["fence-subject", { subjectDigest: token("3") }],
  ] as const) {
    await commitCanonicalSourceEvidence(
      store,
      admitCanonicalSourceEvidence({
        ...evidence(captureId),
        ...overrides,
        records: [
          {
            ...evidence(captureId).records[0]!,
            providerKey: token(captureId.at(-1) ?? "4"),
            contentHash: token(captureId.at(-2) ?? "5"),
          },
        ],
      }),
    );
  }
  assert.equal(queryCanonicalSourceCurrent(store).records.length, 4);
  assert.equal(
    queryCanonicalSourceLineage(store, lineageRequest).observations.length,
    1,
  );
  const knowledgeRows = store.db
    .prepare(
      "SELECT recorded_at_utc_us FROM canonical_commits ORDER BY commit_sequence",
    )
    .all() as Array<{ recorded_at_utc_us?: number }>;
  assert.deepEqual(
    knowledgeRows.map((row) => Number(row.recorded_at_utc_us)),
    [2_000_000, 2_000_001, 2_000_002, 2_000_003],
  );
  assert.equal(
    queryCanonicalSourceHistorical(store, { knowledgeAt: 2 }).observations
      .length,
    2,
  );
  assert.equal(
    (
      store.db
        .prepare(
          "SELECT observed_at FROM source_captures ORDER BY rowid LIMIT 1",
        )
        .get() as { observed_at?: string }
    ).observed_at,
    "2026-08-19T00:00:00.000Z",
  );
  assert.equal(
    (
      store.db
        .prepare("SELECT DISTINCT scope_kind FROM capture_scopes")
        .get() as { scope_kind?: string }
    ).scope_kind,
    "point-in-time",
  );
  const snapshotReader = createCanonicalSourceStore(path);
  snapshotReader.db.exec("BEGIN");
  assert.equal(
    (
      snapshotReader.db
        .prepare("SELECT COUNT(*) AS count FROM source_records")
        .get() as { count?: number }
    ).count,
    4,
  );
  await commitCanonicalSourceEvidence(
    store,
    admitCanonicalSourceEvidence({
      ...evidence("fence-snapshot"),
      subjectDigest: token("4"),
    }),
  );
  assert.equal(
    (
      snapshotReader.db
        .prepare("SELECT COUNT(*) AS count FROM source_records")
        .get() as { count?: number }
    ).count,
    4,
  );
  snapshotReader.db.exec("COMMIT");
  assert.equal(queryCanonicalSourceCurrent(snapshotReader).records.length, 5);
  snapshotReader.close();
  store.close();

  const readOnly = openCanonicalDatabase(fenceDirectory, { readOnly: true });
  readOnly.close();
  const financial = createCathayCanonicalFinancialQuery(fenceDirectory);
  const current = await financial.current({ kind: "current" });
  assert.deepEqual(current.accounts, []);
  assert.deepEqual(current.transactions, []);
  assert.equal(current.commitSequence, 0);
  const historical = await financial.historical({
    kind: "historical",
    cutoff: {
      kind: "both",
      financialAt: "2026-08-19",
      knowledgeAt: "4",
    },
  });
  assert.deepEqual(historical.transactions, []);
  const corruptProjection = new DatabaseSync(path);
  const sourceOnlyCommit = corruptProjection
    .prepare(
      "SELECT commit_id FROM canonical_commits ORDER BY commit_sequence LIMIT 1",
    )
    .get() as { commit_id?: unknown };
  corruptProjection
    .prepare(
      "INSERT INTO current_projection_state(generation, commit_id) VALUES (1, ?)",
    )
    .run(sourceOnlyCommit.commit_id as Uint8Array);
  corruptProjection.close();
  assert.throws(
    () => openCanonicalDatabase(fenceDirectory, { readOnly: true }),
    /source-only|financial projection/i,
  );
} finally {
  await rm(fenceDirectory, { recursive: true, force: true });
}

const v7Directory = await mkdtemp(join(tmpdir(), "canonical-source-v7-"));
try {
  const path = join(v7Directory, "canonical.sqlite");
  assert.throws(
    () =>
      openCanonicalDatabase(v7Directory, {
        injectMigrationFailure: "v7-v8-after-source-copy",
      }),
    /Injected v7-v8 migration failure/,
  );
  const legacy = new DatabaseSync(path);
  assert.equal(
    Number(
      (legacy.prepare("PRAGMA user_version").get() as { user_version?: number })
        .user_version,
    ),
    7,
  );
  assert.equal(
    legacy
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_captures'",
      )
      .get()?.["1"],
    1,
  );
  assert.equal(
    legacy
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_subjects'",
      )
      .get(),
    undefined,
  );
  legacy.close();
  const migrated = createCanonicalSourceStore(path);
  assert.equal(
    Number(
      (
        migrated.db.prepare("PRAGMA user_version").get() as {
          user_version?: number;
        }
      ).user_version,
    ),
    CANONICAL_SOURCE_SCHEMA_VERSION,
  );
  const migratedRevisionSchema = String(
    (
      migrated.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_revisions'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  assert.match(
    migratedRevisionSchema,
    /CHECK\(posting_origin IN .*synthetic_%/,
  );
  assert.match(migratedRevisionSchema, /CHECK\(posting_basis IN .*synthetic_%/);
  assert.match(
    migratedRevisionSchema,
    /CHECK\(posting_rule_version IN .*synthetic-%/,
  );
  assert.match(
    migratedRevisionSchema,
    /esun\/credit-card\/human-attested-v1/,
  );
  assert.match(
    migratedRevisionSchema,
    /yuanta\/credit-card\/human-attested-v1/,
  );
  assert.match(
    migratedRevisionSchema,
    /yuanta\/domestic-deposit\/human-attested-v1/,
  );
  assert.match(
    migratedRevisionSchema,
    /yuanta\/domestic-deposit\/human-attested-v2/,
  );
  assert.match(
    migratedRevisionSchema,
    /hncb\/domestic-deposit\/human-attested-v1/,
  );
  assert.match(
    migratedRevisionSchema,
    /sinopac\/domestic-deposit\/human-attested-v1/,
  );
  assert.match(
    migratedRevisionSchema,
    /CHECK\(semantic_rule_version IN .*synthetic-%/,
  );
  assert.match(
    migratedRevisionSchema,
    /CHECK\(effective_time_rule_version IN .*synthetic-%/,
  );
  assert.match(
    migratedRevisionSchema,
    /effective_time_basis TEXT NOT NULL CHECK\(effective_time_basis IN \('accounting','transaction-time'\)\)/,
  );
  validateCanonicalSourceStore(migrated);
  migrated.close();
} finally {
  await rm(v7Directory, { recursive: true, force: true });
}

const closedRevisionDirectory = await mkdtemp(
  join(tmpdir(), "canonical-source-closed-revision-v8-"),
);
try {
  const path = join(closedRevisionDirectory, "canonical.sqlite");
  await commitCathayDomesticDeposit(
    closedRevisionDirectory,
    CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  );
  const legacy = new DatabaseSync(path);
  const currentRevisionSchema = String(
    (
      legacy
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_revisions'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  const currentObservationSchema = String(
    (
      legacy
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_time_observations'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  const closedObservationSchema = currentObservationSchema.replace(
    "CHECK(time_precision IN ('date','minute','second'))",
    "CHECK(time_precision IN ('date','second'))",
  );
  assert.notEqual(closedObservationSchema, currentObservationSchema);
  const closedRevisionSchema = currentRevisionSchema
    .replace(
      "CHECK(posting_origin IN ('provider_booked_history','human_attested_history','human-attested') OR posting_origin LIKE 'synthetic_%')",
      "CHECK(posting_origin = 'provider_booked_history')",
    )
    .replace(
      "CHECK(posting_basis IN ('query-status-success-with-accounting-date','human-attested-formally-posted','statement-posted-history') OR posting_basis LIKE 'synthetic_%')",
      "CHECK(posting_basis = 'query-status-success-with-accounting-date')",
    )
    .replace(
      "CHECK(posting_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','esun/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v2','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR posting_rule_version LIKE 'synthetic-%' OR posting_rule_version LIKE 'foreign-currency/%' OR posting_rule_version LIKE 'fubon/credit-card/%' OR posting_rule_version LIKE 'fubon/loan/%' OR posting_rule_version LIKE 'yuanta/loan/%' OR posting_rule_version LIKE 'esun/credit-card/%')",
      "CHECK(posting_rule_version = 'cathay/domestic-deposit/v1')",
    )
    .replace(
      "CHECK(semantic_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','esun/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v2','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR semantic_rule_version LIKE 'synthetic-%' OR semantic_rule_version LIKE 'foreign-currency/%' OR semantic_rule_version LIKE 'fubon/credit-card/%' OR semantic_rule_version LIKE 'fubon/loan/%' OR semantic_rule_version LIKE 'yuanta/loan/%' OR semantic_rule_version LIKE 'esun/credit-card/%')",
      "CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1')",
    )
    .replace(
      "CHECK(effective_time_basis IN ('accounting','transaction-time'))",
      "CHECK(effective_time_basis = 'accounting')",
    )
    .replace(
      "CHECK(effective_time_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','esun/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v2','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR effective_time_rule_version LIKE 'synthetic-%' OR effective_time_rule_version LIKE 'foreign-currency/%' OR effective_time_rule_version LIKE 'fubon/credit-card/%' OR effective_time_rule_version LIKE 'fubon/loan/%' OR effective_time_rule_version LIKE 'yuanta/loan/%' OR effective_time_rule_version LIKE 'esun/credit-card/%')",
      "CHECK(effective_time_rule_version = 'cathay/domestic-deposit/v1')",
    );
  assert.notEqual(closedRevisionSchema, currentRevisionSchema);
  assert.doesNotMatch(
    closedRevisionSchema,
    /hncb\/domestic-deposit\/human-attested-v1/,
  );
  const beforeRevisionCount = Number(
    (
      legacy
        .prepare("SELECT COUNT(*) AS count FROM transaction_revisions")
        .get() as { count?: number }
    ).count ?? 0,
  );
  const beforeObservationCount = Number(
    (
      legacy
        .prepare("SELECT COUNT(*) AS count FROM transaction_time_observations")
        .get() as { count?: number }
    ).count ?? 0,
  );
  const sourceAssertionsView = String(
    (
      legacy
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'source_assertions'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  assert.match(sourceAssertionsView, /CREATE VIEW source_assertions/);
  legacy.exec("PRAGMA foreign_keys = OFF");
  legacy.exec(
    "DROP VIEW IF EXISTS source_assertions; DROP INDEX IF EXISTS idx_transaction_revisions_financial_time; DROP INDEX IF EXISTS idx_transaction_revisions_knowledge_time; DROP INDEX IF EXISTS idx_transaction_revisions_lineage; CREATE TABLE transaction_revisions_backup AS SELECT * FROM transaction_revisions; DROP TABLE transaction_revisions;",
  );
  legacy.exec(closedRevisionSchema);
  legacy.exec(
    "INSERT INTO transaction_revisions SELECT * FROM transaction_revisions_backup; DROP TABLE transaction_revisions_backup;",
  );
  legacy.exec(
    "CREATE TABLE transaction_time_observations_backup AS SELECT * FROM transaction_time_observations; DROP TABLE transaction_time_observations;",
  );
  legacy.exec(closedObservationSchema);
  legacy.exec(
    "INSERT INTO transaction_time_observations SELECT * FROM transaction_time_observations_backup; DROP TABLE transaction_time_observations_backup;",
  );
  legacy.exec(sourceAssertionsView);
  legacy.close();

  const migratedClosed = createCanonicalSourceStore(path);
  const widenedRevisionSchema = String(
    (
      migratedClosed.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_revisions'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  assert.match(widenedRevisionSchema, /CHECK\(posting_origin IN .*synthetic_%/);
  assert.match(widenedRevisionSchema, /CHECK\(posting_basis IN .*synthetic_%/);
  assert.match(
    widenedRevisionSchema,
    /CHECK\(posting_rule_version IN .*synthetic-%/,
  );
  assert.match(
    widenedRevisionSchema,
    /esun\/credit-card\/human-attested-v1/,
  );
  assert.match(
    widenedRevisionSchema,
    /yuanta\/credit-card\/human-attested-v1/,
  );
  assert.match(
    widenedRevisionSchema,
    /yuanta\/domestic-deposit\/human-attested-v1/,
  );
  assert.match(
    widenedRevisionSchema,
    /yuanta\/domestic-deposit\/human-attested-v2/,
  );
  assert.match(
    widenedRevisionSchema,
    /hncb\/domestic-deposit\/human-attested-v1/,
  );
  assert.match(
    widenedRevisionSchema,
    /CHECK\(semantic_rule_version IN .*synthetic-%/,
  );
  assert.equal(
    Number(
      (
        migratedClosed.db
          .prepare("SELECT COUNT(*) AS count FROM transaction_revisions")
          .get() as { count?: number }
      ).count ?? 0,
    ),
    beforeRevisionCount,
  );
  const widenedObservationSchema = String(
    (
      migratedClosed.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_time_observations'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  assert.match(
    widenedObservationSchema,
    /time_precision TEXT NOT NULL CHECK\(time_precision IN \('date','minute','second'\)\)/,
  );
  assert.equal(
    Number(
      (
        migratedClosed.db
          .prepare(
            "SELECT COUNT(*) AS count FROM transaction_time_observations",
          )
          .get() as { count?: number }
      ).count ?? 0,
    ),
    beforeObservationCount,
  );
  const widenedQuery = await createCathayCanonicalFinancialQuery(
    closedRevisionDirectory,
  ).current({ kind: "current" });
  assert.equal(widenedQuery.transactions.length, beforeRevisionCount);
  migratedClosed.close();
} finally {
  await rm(closedRevisionDirectory, { recursive: true, force: true });
}

const partialDirectory = await mkdtemp(
  join(tmpdir(), "canonical-source-partial-v8-"),
);
try {
  const path = join(partialDirectory, "canonical.sqlite");
  const complete = createCanonicalSourceStore(path);
  complete.db.exec("DROP TABLE source_record_provenance");
  complete.close();
  assert.throws(
    () => createCanonicalSourceStore(path),
    /v8.*source_record_provenance|source_record_provenance.*missing/i,
  );
} finally {
  await rm(partialDirectory, { recursive: true, force: true });
}

test("v8 to v9 rebuilds the source assertion compatibility view", async () => {
  for (const defect of ["missing", "malformed"] as const) {
    const directory = await mkdtemp(
      join(tmpdir(), `canonical-source-v8-compat-${defect}-`),
    );
    try {
      const path = join(directory, "canonical.sqlite");
      await commitCathayDomesticDeposit(
        directory,
        CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
      );
      const seeded = new DatabaseSync(path);
      const beforeSourceAssertionCount = Number(
        (
          seeded
            .prepare("SELECT COUNT(*) AS count FROM source_assertions")
            .get() as { count?: number }
        ).count ?? 0,
      );
      seeded.close();

      const legacy = new DatabaseSync(path);
      legacy.exec("PRAGMA foreign_keys = OFF");
      legacy.exec("DROP VIEW source_assertions");
      if (defect === "malformed")
        legacy.exec(
          "CREATE VIEW source_assertions AS SELECT assertion_id, transaction_id, revision_id, created_commit_id AS commit_id FROM assertions",
        );
      legacy.exec(
        "DELETE FROM schema_migrations WHERE version = 9; PRAGMA user_version = 8",
      );
      legacy.close();

      const migrated = createCanonicalSourceStore(path);
      const sourceAssertionsView = String(
        (
          migrated.db
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'source_assertions'",
            )
            .get() as { sql?: unknown } | undefined
        )?.sql ?? "",
      );
      assert.match(sourceAssertionsView, /revision\.source_record_id/i);
      assert.equal(
        (
          migrated.db
            .prepare("SELECT COUNT(*) AS count FROM source_assertions")
            .get() as { count?: number }
        ).count,
        beforeSourceAssertionCount,
      );
      validateCanonicalSourceStore(migrated);
      migrated.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

const closedScopeDirectory = await mkdtemp(
  join(tmpdir(), "canonical-source-closed-scope-v8-"),
);
try {
  const path = join(closedScopeDirectory, "canonical.sqlite");
  await commitCathayDomesticDeposit(
    closedScopeDirectory,
    CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  );
  const legacy = new DatabaseSync(path);
  const currentScopeSchema = String(
    (
      legacy
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'capture_scopes'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  const closedScopeSchema = currentScopeSchema.replace(
    "CHECK(absence_authority IN ('comparable-complete-range', 'provider-explicit-no-data'))",
    "CHECK(absence_authority IN ('comparable-complete-range'))",
  );
  assert.notEqual(closedScopeSchema, currentScopeSchema);
  const scopeIndexes = (
    legacy
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'capture_scopes' AND sql IS NOT NULL",
      )
      .all() as Array<{ sql?: unknown }>
  )
    .map((row) => String(row.sql ?? ""))
    .filter(Boolean);
  legacy.exec("PRAGMA foreign_keys = OFF");
  legacy.exec(
    "CREATE TABLE capture_scopes_backup AS SELECT * FROM capture_scopes; DROP TABLE capture_scopes;",
  );
  legacy.exec(closedScopeSchema);
  legacy.exec(
    "INSERT INTO capture_scopes SELECT * FROM capture_scopes_backup; DROP TABLE capture_scopes_backup;",
  );
  for (const index of scopeIndexes) legacy.exec(index);
  legacy.close();

  const migratedScope = createCanonicalSourceStore(path);
  const migratedScopeSchema = String(
    (
      migratedScope.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'capture_scopes'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  assert.match(migratedScopeSchema, /provider-explicit-no-data/);
  assert.equal(
    (
      migratedScope.db
        .prepare("SELECT COUNT(*) AS count FROM capture_scopes")
        .get() as { count?: number }
    ).count,
    1,
  );
  validateCanonicalSourceStore(migratedScope);
  migratedScope.close();
} finally {
  await rm(closedScopeDirectory, { recursive: true, force: true });
}

const orphanDirectory = await mkdtemp(
  join(tmpdir(), "canonical-source-orphan-"),
);
try {
  const path = join(orphanDirectory, "canonical.sqlite");
  assert.throws(
    () =>
      openCanonicalDatabase(orphanDirectory, {
        injectMigrationFailure: "v7-v8-after-source-copy",
      }),
    /Injected v7-v8 migration failure/,
  );
  const legacy = new DatabaseSync(path);
  legacy.exec("PRAGMA foreign_keys = OFF");
  legacy
    .prepare(
      "INSERT INTO source_records(source_record_id, capture_id, commit_id, sequence_lexeme, description, payload_json) VALUES (randomblob(16), randomblob(16), randomblob(16), 'orphan', NULL, '{}')",
    )
    .run();
  legacy.close();
  assert.throws(
    () => createCanonicalSourceStore(path),
    /orphaned|ambiguous scope relations/i,
  );
  const unchanged = new DatabaseSync(path);
  assert.equal(
    Number(
      (
        unchanged.prepare("PRAGMA user_version").get() as {
          user_version?: number;
        }
      ).user_version,
    ),
    7,
  );
  assert.equal(
    (
      unchanged
        .prepare("SELECT COUNT(*) AS count FROM source_records")
        .get() as {
        count?: number;
      }
    ).count,
    1,
  );
  assert.equal(
    unchanged
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_subjects'",
      )
      .get(),
    undefined,
  );
  unchanged.close();
} finally {
  await rm(orphanDirectory, { recursive: true, force: true });
}

const mixedDirectory = await mkdtemp(
  join(tmpdir(), "canonical-source-mixed-v8-"),
);
try {
  await commitCathayDomesticDeposit(
    mixedDirectory,
    CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  );
  const before = await createCathayCanonicalFinancialQuery(
    mixedDirectory,
  ).current({
    kind: "current",
  });
  const path = join(mixedDirectory, "canonical.sqlite");
  const mixed = createCanonicalSourceStore(path);
  await commitCanonicalSourceEvidence(
    mixed,
    admitCanonicalSourceEvidence(evidence("capture-mixed-source-only")),
  );
  mixed.close();
  const reopened = createCanonicalSourceStore(path);
  assert.equal(queryCanonicalSourceCurrent(reopened).observations.length, 1);
  reopened.close();
  const after = await createCathayCanonicalFinancialQuery(
    mixedDirectory,
  ).current({
    kind: "current",
  });
  assert.equal(after.transactions.length, before.transactions.length);
  assert.equal(after.commitSequence, before.commitSequence);
} finally {
  await rm(mixedDirectory, { recursive: true, force: true });
}

const mixedMigrationDirectory = await mkdtemp(
  join(tmpdir(), "canonical-source-mixed-migration-v8-"),
);
try {
  const path = join(mixedMigrationDirectory, "canonical.sqlite");
  await commitCathayDomesticDeposit(
    mixedMigrationDirectory,
    CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  );
  const hncbCaptureInput = {
    evidenceVersion: "capture-evidence-v1" as const,
    source: "hncb" as const,
    product: "domestic-deposit" as const,
    providerGuaranteed: false as const,
    observedAt: "2026-08-20T12:00:00.000+08:00",
    account: {
      value: "SYNTHETIC-HNCB-MIGRATION-001",
      label: "SYNTHETIC HNCB MIGRATION ACCOUNT",
    },
    queryRange: { startDate: "2026/08/01", endDate: "2026/08/20" },
    downloads: [
      {
        filename: "hncb-migration.xls",
        byteLength: 100,
        contentDigest: token("h") as `sha256:${string}`,
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
              "MIGRATION DESCRIPTION",
              "",
              "",
              "MIGRATION REFERENCE",
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
  const structural = admitHncbDomesticDepositCaptureEvidence(hncbCaptureInput);
  assert.equal(structural.status, "admissible");
  assert.ok(structural.capture);
  const financialInput = {
    capture: structural.capture,
    captureId: "hncb-migration-financial-capture",
    humanAttestation: getHncbHumanAttestedV1Manifest(),
  };
  assert.equal(
    admitHncbDomesticDepositFinancialCapture(financialInput).status,
    "admitted",
  );
  const mixed = createCanonicalSourceStore(path);
  const cathayRevisionCount = Number(
    (
      mixed.db
        .prepare(
          "SELECT COUNT(*) AS value FROM transaction_revisions WHERE posting_rule_version = 'cathay/domestic-deposit/v1'",
        )
        .get() as { value?: number }
    ).value ?? 0,
  );
  assert.ok(cathayRevisionCount > 0);
  await commitCanonicalHncbDomesticDepositCapture(
    {
      db: mixed.db,
      databasePath: mixed.databasePath,
      commitClock: () => mixed.commitClock(),
    },
    financialInput,
  );
  const beforeMigrationRows = Number(
    (
      mixed.db
        .prepare("SELECT COUNT(*) AS value FROM transaction_revisions")
        .get() as { value?: number }
    ).value ?? 0,
  );
  assert.equal(beforeMigrationRows, cathayRevisionCount + 1);
  mixed.close();

  const legacy = new DatabaseSync(path);
  const currentRevisionSchema = String(
    (
      legacy
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_revisions'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  const closedRevisionSchema = currentRevisionSchema
    .replace(
      /CHECK\(posting_origin IN \([^)]*\) OR posting_origin LIKE 'synthetic_%'\)/,
      "CHECK(posting_origin = 'provider_booked_history')",
    )
    .replace(
      /CHECK\(posting_basis IN \([^)]*\) OR posting_basis LIKE 'synthetic_%'\)/,
      "CHECK(posting_basis = 'query-status-success-with-accounting-date')",
    )
    .replace(
      /CHECK\(posting_rule_version IN \([^)]*\) OR posting_rule_version LIKE 'synthetic-%'\)/,
      "CHECK(posting_rule_version = 'cathay/domestic-deposit/v1')",
    )
    .replace(
      /CHECK\(semantic_rule_version IN \([^)]*\) OR semantic_rule_version LIKE 'synthetic-%'\)/,
      "CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1')",
    )
    .replace(
      "CHECK(effective_time_basis IN ('accounting','transaction-time'))",
      "CHECK(effective_time_basis = 'accounting')",
    )
    .replace(
      /CHECK\(effective_time_rule_version IN \([^)]*\) OR effective_time_rule_version LIKE 'synthetic-%'\)/,
      "CHECK(effective_time_rule_version = 'cathay/domestic-deposit/v1')",
    );
  assert.notEqual(closedRevisionSchema, currentRevisionSchema);
  const sourceAssertionsView = String(
    (
      legacy
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'source_assertions'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  legacy.exec("PRAGMA foreign_keys = OFF");
  legacy.exec(
    "DROP VIEW IF EXISTS source_assertions; DROP INDEX IF EXISTS idx_transaction_revisions_financial_time; DROP INDEX IF EXISTS idx_transaction_revisions_knowledge_time; DROP INDEX IF EXISTS idx_transaction_revisions_lineage; CREATE TABLE transaction_revisions_backup AS SELECT * FROM transaction_revisions; DROP TABLE transaction_revisions;",
  );
  legacy.exec(closedRevisionSchema);
  // This fixture represents an older closed allowlist with rows written by
  // both providers before the current migration widened the HNCB route.
  legacy.exec("PRAGMA ignore_check_constraints = ON");
  legacy.exec(
    "INSERT INTO transaction_revisions SELECT * FROM transaction_revisions_backup; DROP TABLE transaction_revisions_backup;",
  );
  legacy.exec("PRAGMA ignore_check_constraints = OFF");
  legacy.exec(sourceAssertionsView);
  legacy.close();

  const migrated = createCanonicalSourceStore(path);
  try {
    const widenedRevisionSchema = String(
      (
        migrated.db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_revisions'",
          )
          .get() as { sql?: unknown } | undefined
      )?.sql ?? "",
    );
    assert.match(
      widenedRevisionSchema,
      /hncb\/domestic-deposit\/human-attested-v1/,
    );
    assert.equal(
      (
        migrated.db
          .prepare("SELECT COUNT(*) AS value FROM transaction_revisions")
          .get() as { value?: number }
      ).value,
      beforeMigrationRows,
    );
    assert.equal(
      (
        migrated.db
          .prepare("SELECT COUNT(*) AS value FROM financial_transactions")
          .get() as { value?: number }
      ).value,
      beforeMigrationRows,
    );
    assert.equal(
      (
        migrated.db
          .prepare("SELECT COUNT(*) AS value FROM current_transactions")
          .get() as { value?: number }
      ).value,
      beforeMigrationRows,
    );
    const routeCounts = migrated.db
      .prepare(
        "SELECT posting_rule_version AS route, COUNT(*) AS value FROM transaction_revisions GROUP BY posting_rule_version ORDER BY route",
      )
      .all() as Array<{ route?: string; value?: number }>;
    assert.deepEqual(
      routeCounts.map(({ route, value }) => ({ route, value })),
      [
        { route: "cathay/domestic-deposit/v1", value: cathayRevisionCount },
        { route: "hncb/domestic-deposit/human-attested-v1", value: 1 },
      ],
    );
    validateCanonicalSourceStore(migrated);
  } finally {
    migrated.close();
  }
} finally {
  await rm(mixedMigrationDirectory, { recursive: true, force: true });
}

const fubonQueryDirectory = await mkdtemp(
  join(tmpdir(), "canonical-source-fubon-query-v2-"),
);
try {
  const store = createCanonicalSourceStore(
    join(fubonQueryDirectory, "canonical.sqlite"),
  );
  const v1Commit = await commitCanonicalFinancialDepositCapture(
    store,
    admitCanonicalFinancialDepositCapture(
      fubonCreditCardFinancialCapture("v1", "fubon-historical-v1"),
    ),
  );
  const v2Commit = await commitCanonicalFinancialDepositCapture(
    store,
    admitCanonicalFinancialDepositCapture(
      fubonCreditCardFinancialCapture("v2", "fubon-current-v2"),
    ),
  );
  store.close();

  const v1Query = createCanonicalFinancialQuery(fubonQueryDirectory, {
    integrationNamespace: "fubon",
    postingRuleVersion: "fubon/credit-card/human-attested-v1",
  });
  const v1Current = await v1Query.current({ kind: "current" });
  assert.deepEqual(v1Current.accounts, []);
  assert.deepEqual(
    v1Current.transactions,
    [],
    "superseded Fubon v1 rows cannot enter a current projection query",
  );
  const v1Historical = await v1Query.historical({
    kind: "historical",
    cutoff: {
      kind: "both",
      financialAt: "2026-12-31",
      knowledgeAt: String(v1Commit.commitSequence),
    },
  });
  assert.equal(v1Historical.transactions.length, 1);
  assert.equal(
    v1Historical.transactions[0]?.postingRuleVersion,
    "fubon/credit-card/human-attested-v1",
  );

  const v2Query = createCanonicalFinancialQuery(fubonQueryDirectory, {
    integrationNamespace: "fubon",
    postingRuleVersion: "fubon/credit-card/human-attested-v2",
  });
  const v2Current = await v2Query.current({ kind: "current" });
  assert.equal(v2Current.accounts.length, 1);
  assert.equal(v2Current.transactions.length, 1);
  assert.equal(
    v2Current.transactions[0]?.postingRuleVersion,
    "fubon/credit-card/human-attested-v2",
  );
  const v2Historical = await v2Query.historical({
    kind: "historical",
    cutoff: {
      kind: "both",
      financialAt: "2026-12-31",
      knowledgeAt: String(v2Commit.commitSequence),
    },
  });
  assert.equal(v2Historical.transactions.length, 1);
  assert.equal(
    v2Historical.transactions[0]?.postingRuleVersion,
    "fubon/credit-card/human-attested-v2",
  );

  assert.throws(
    () =>
      createCanonicalFinancialQuery(fubonQueryDirectory, {
        integrationNamespace: "other",
        postingRuleVersion: "fubon/credit-card/human-attested-v2",
      }),
    /unknown|mixed/i,
  );
  assert.throws(
    () =>
      createCanonicalFinancialQuery(fubonQueryDirectory, {
        integrationNamespace: "fubon",
        postingRuleVersion: "fubon/credit-card/human-attested-v3",
      }),
    /unknown|mixed/i,
  );
} finally {
  await rm(fubonQueryDirectory, { recursive: true, force: true });
}

test("Yuanta v2 wins the current view without deleting v1 history", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-source-yuanta-query-v2-precedence-"),
  );
  try {
    const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
    const v1Commit = await commitCanonicalFinancialDepositCapture(
      store,
      admitCanonicalFinancialDepositCapture(
        yuantaCreditCardFinancialCapture("v1", "yuanta-query-v1"),
      ),
    );
    const v2Commit = await commitCanonicalFinancialDepositCapture(
      store,
      admitCanonicalFinancialDepositCapture(
        yuantaCreditCardFinancialCapture("v2", "yuanta-query-v2"),
      ),
    );
    assert.equal(
      Number(
        (store.db.prepare(
          "SELECT COUNT(*) AS value FROM financial_transactions WHERE account_id IN (SELECT account_id FROM financial_accounts WHERE stream = 'credit-card')",
        ).get() as { value?: number }).value,
      ),
      62,
    );
    assert.equal(queryCanonicalSourceCurrent(store).observations.length, 62);
    assert.equal(
      queryCanonicalSourceHistorical(store, {
        knowledgeAt: v2Commit.commitSequence,
      }).observations.length,
      62,
    );
    store.close();

    const v1Query = createCanonicalFinancialQuery(directory, {
      integrationNamespace: "yuanta",
      postingRuleVersion: YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE,
    });
    const v2Query = createCanonicalFinancialQuery(directory, {
      integrationNamespace: "yuanta",
      postingRuleVersion: YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE,
    });
    assert.equal(
      (await v1Query.current({ kind: "current" })).transactions.length,
      0,
      "a complete v2 capture supersedes v1 only in the current view",
    );
    assert.equal(
      (await v2Query.current({ kind: "current" })).transactions.length,
      31,
    );
    assert.equal(
      (
        await v1Query.historical({
          kind: "historical",
          cutoff: {
            kind: "both",
            financialAt: "2026-12-31",
            knowledgeAt: String(v1Commit.commitSequence),
          },
        })
      ).transactions.length,
      31,
      "v1 remains available through its historical route",
    );
    assert.equal(
      (
        await v2Query.historical({
          kind: "historical",
          cutoff: {
            kind: "both",
            financialAt: "2026-12-31",
            knowledgeAt: String(v2Commit.commitSequence),
          },
        })
      ).transactions.length,
      31,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Yuanta v1 current rows remain visible when a v2 scope is incomplete", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-source-yuanta-query-v2-invalid-"),
  );
  try {
    const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
    await commitCanonicalFinancialDepositCapture(
      store,
      admitCanonicalFinancialDepositCapture(
        yuantaCreditCardFinancialCapture("v1", "yuanta-invalid-v1"),
      ),
    );
    await commitCanonicalFinancialDepositCapture(
      store,
      admitCanonicalFinancialDepositCapture(
        yuantaCreditCardFinancialCapture("v2", "yuanta-invalid-v2"),
      ),
    );
    store.db.prepare(
      `UPDATE capture_scopes
       SET terminal = 0
       WHERE capture_id = (
         SELECT capture_id FROM source_captures
         WHERE capture_key = ?
       )`,
    ).run("yuanta-invalid-v2");
    store.close();

    const v1Query = createCanonicalFinancialQuery(directory, {
      integrationNamespace: "yuanta",
      postingRuleVersion: YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE,
    });
    const v2Query = createCanonicalFinancialQuery(directory, {
      integrationNamespace: "yuanta",
      postingRuleVersion: YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE,
    });
    assert.equal(
      (await v1Query.current({ kind: "current" })).transactions.length,
      31,
      "incomplete v2 cannot hide v1 authority",
    );
    assert.equal(
      (await v2Query.current({ kind: "current" })).transactions.length,
      0,
      "incomplete v2 is not current authority",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
