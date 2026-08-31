import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  LOAN_CONTRACT_FIXTURES,
  admitCanonicalLoanCapture,
  commitCanonicalLoanCapture,
  createCanonicalLoanStore,
  createCanonicalLoanCapture,
  FUBON_LOAN_AUTHORITY_ROUTE,
  FUBON_LOAN_LEGACY_AUTHORITY_ROUTE,
  isCanonicalLoanSourceDateBeforeObservedAt,
  queryCanonicalLoanCurrent,
  queryCanonicalLoanHistorical,
  queryCanonicalLoanLineage,
} from "./loan-financial.ts";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositCapture,
} from "./canonical-financial-deposit-writer.ts";
import {
  CANONICAL_SQLITE_FILE,
  createCanonicalSourceStore,
  rebuildCanonicalProjection,
  validateCanonicalSourceStore,
} from "./canonical-source-store.ts";
import {
  buildFubonLoanCapture,
  FUBON_LOAN_LIVE_VALIDATION_ATTESTATION_V1,
  persistFubonLoanCapture,
  queryFubonLoanCurrent,
  queryFubonLoanHistorical,
  queryFubonLoanLineage,
} from "./fubon-loan.ts";
import {
  buildYuantaLoanCapture,
  persistYuantaLoanCapture,
  queryYuantaLoanCurrent,
  queryYuantaLoanHistorical,
  queryYuantaLoanLineage,
  YUANTA_LOAN_LIVE_VALIDATION_ATTESTATION_V1,
  YUANTA_LOAN_SOURCE_EVENT_CODEBOOK_VERSION,
} from "./yuanta-loan.ts";

test("Fubon loan contract correction preserves immutable v1 occurrences", async () => {
  const opaque = (label: string): `sha256:${string}` =>
    `sha256:${label.padEnd(64, "0").slice(0, 64)}`;
  const legacyRoute = "fubon/loan/canonical-v1";
  const legacyPayload = JSON.stringify({
    sourceRecordKey: opaque("legacy-occurrence"),
    balanceSourceEvidence: [
      {
        sourceField: "statement-as-of",
        value: "2026-01-05T23:59:59+08:00",
        precision: "second",
      },
    ],
  });
  const legacyCapture = {
    captureId: "fubon-loan-collision-regression-v1",
    authorityRoute: legacyRoute,
    contractVersion: "loan/canonical/v1.fubon",
    identity: {
      integrationNamespace: "fubon",
      sourceConnectionKey: opaque("legacy-connection"),
      identityEpochKey: opaque("legacy-epoch"),
      stream: "loan",
      recordKind: "fubon-loan-transaction",
      subjectDigest: opaque("legacy-subject"),
      accountNo: opaque("legacy-account"),
      accountType: "loan",
      currency: "TWD",
    },
    observedAt: "2026-02-01T00:00:00.000Z",
    scope: {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: "source-declared-terminal-range",
      completenessRuleVersion: "loan/canonical/v1.fubon",
      absenceAuthority: null,
      contractFingerprint: opaque("legacy-contract"),
      preflightFingerprint: opaque("legacy-preflight"),
      pageCount: 1,
      withdrawalPolicy: "never-infer",
    },
    semantics: {
      postingStatus: "posted",
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      postingRuleVersion: legacyRoute,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: legacyRoute,
      effectiveTimeBasis: "transaction-time",
      effectiveTimeRuleVersion: legacyRoute,
      timeZone: "Asia/Taipei",
      timePrecision: "date",
      timeOrigin: "defaulted_local_midnight",
      requireBalance: false,
      providerGuaranteed: false,
      occurrenceProviderGuaranteed: false,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: 1,
        responseDigest: opaque("legacy-response"),
        proofKind: "source-declared-terminal-range",
        contractFingerprint: opaque("legacy-contract"),
        preflightFingerprint: opaque("legacy-preflight"),
        metadataJson: "{}",
      },
    ],
    records: [
      {
        occurrenceKey: opaque("legacy-occurrence"),
        collisionKey: opaque("legacy-collision"),
        providerKey: opaque("legacy-provider"),
        contentHash: opaque("legacy-content"),
        sequenceLexeme: "1",
        compactJson: legacyPayload,
        amount: { coefficient: "100", scale: 0 },
        balanceAfter: null,
        currency: "TWD",
        direction: "outflow",
        sourceTime: {
          localDate: "2026-01-05",
          localTime: "00:00:00",
          timeZone: "Asia/Taipei",
          epochMilliseconds: Date.parse("2026-01-05T00:00:00+08:00"),
          precision: "date",
          timeOrigin: "defaulted_local_midnight",
        },
        effectiveOn: "2026-01-05",
        transactionDateTimeLocal: "2026-01-05T00:00:00",
        description: null,
      },
    ],
  } satisfies CanonicalFinancialDepositCapture;
  const correctedInput = {
    accountValue: "fubon-collision-regression-account",
    sourceConnectionScope: "fubon-collision-regression-connection",
    observedAt: "2026-02-02T00:00:00.000Z",
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    scope: {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      completeness: "complete-range",
      completenessBasis: "source-declared-terminal-range",
      completenessRuleVersion: "loan/canonical/v2.fubon",
      pageCount: 1,
      terminal: true,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: 1,
        proofKind: "source-declared-terminal-range",
      },
    ],
    counterpartTransactions: [],
    relations: [],
    rows: [
      {
        transactionDate: "2026/01/05",
        transactionContent: "LOAN-DISBURSEMENT",
        transactionAmount: "100.00",
        balanceAfterTransaction: "100.00",
      },
    ],
  } as const;

  const store = createCanonicalLoanStore(":memory:");
  try {
    await commitCanonicalFinancialDepositCapture(
      store,
      admitCanonicalFinancialDepositCapture(legacyCapture),
    );
    const legacyBefore = store.db
      .prepare(
        `SELECT record.payload_json AS payload
         FROM source_records record
         JOIN source_captures capture ON capture.capture_id = record.capture_id
         WHERE capture.authority_route = ?`,
      )
      .get(legacyRoute) as { payload?: string } | undefined;
    assert.equal(legacyBefore?.payload, legacyPayload);

    const corrected = buildFubonLoanCapture(correctedInput);
    assert.equal(corrected.authorityRoute, "fubon/loan/canonical-v2");
    assert.equal(corrected.contractVersion, "loan/canonical/v2.fubon");
    assert.notEqual(
      corrected.records[0]?.sourceRecordKey,
      legacyCapture.records[0]?.occurrenceKey,
    );
    assert.notEqual(
      corrected.identity.subjectDigest,
      legacyCapture.identity.subjectDigest,
    );

    await persistFubonLoanCapture(store, correctedInput);
    const routes = store.db
      .prepare(
        `SELECT authority_route AS route, COUNT(*) AS count
         FROM source_captures
         WHERE authority_route LIKE 'fubon/loan/%'
         GROUP BY authority_route ORDER BY authority_route`,
      )
      .all() as Array<{ route?: string; count?: number }>;
    assert.deepEqual(
      routes.map(({ route, count }) => ({ route, count })),
      [
        { route: "fubon/loan/canonical-v1", count: 1 },
        { route: "fubon/loan/canonical-v2", count: 1 },
      ],
    );
    const legacyAfter = store.db
      .prepare(
        `SELECT record.payload_json AS payload
         FROM source_records record
         JOIN source_captures capture ON capture.capture_id = record.capture_id
         WHERE capture.authority_route = ?`,
      )
      .get(legacyRoute) as { payload?: string } | undefined;
    assert.equal(legacyAfter?.payload, legacyPayload);

    const current = queryCanonicalLoanCurrent(store, { sourceId: "fubon" });
    assert.equal(current.accounts.length, 1);
    assert.equal(current.transactions.length, 1);
    assert.equal(current.balanceObservations.length, 1);
    assert.equal(current.relations.length, 0);
    const historical = queryCanonicalLoanHistorical(store, {
      sourceId: "fubon",
      knowledgeAt: current.knowledgeAt,
      financialAt: "2026-01-31",
    });
    assert.equal(historical.accounts.length, 1);
    assert.equal(historical.transactions.length, 1);
    assert.equal(historical.balanceObservations.length, 1);
    assert.equal(historical.relations.length, 0);
    const allSourcesCurrent = queryCanonicalLoanCurrent(store);
    assert.equal(allSourcesCurrent.accounts.length, 1);
    assert.equal(allSourcesCurrent.transactions.length, 1);
    assert.equal(allSourcesCurrent.balanceObservations.length, 1);
    assert.equal(allSourcesCurrent.relations.length, 0);
    assert.equal(
      queryCanonicalLoanLineage(store, {
        sourceId: "fubon",
        sourceRecordKey: legacyCapture.records[0]!.occurrenceKey,
      }).lineage.length,
      0,
    );
    assert.equal(
      queryCanonicalLoanLineage(store, {
        sourceId: "fubon",
        sourceRecordKey: corrected.records[0]!.sourceRecordKey,
      }).lineage.length,
      1,
    );
  } finally {
    store.close();
  }
});

test("retired Fubon v1 route stays out of every canonical loan query surface", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    const fixture = structuredClone(LOAN_CONTRACT_FIXTURES.fubon);
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(fixture));
    const captureId = store.db
      .prepare(
        "SELECT capture_id, commit_id FROM source_captures WHERE capture_key = ?",
      )
      .get(fixture.captureId) as
      | { capture_id?: Uint8Array; commit_id?: Uint8Array }
      | undefined;
    assert.ok(captureId?.capture_id instanceof Uint8Array);
    assert.ok(captureId?.commit_id instanceof Uint8Array);
    store.db
      .prepare(
        `INSERT OR IGNORE INTO source_authority_routes(
           authority_route, integration_namespace, stream, contract_version,
           created_commit_id
         ) VALUES (?, 'fubon', 'loan', 'loan/canonical/v1.fubon', ?)`,
      )
      .run(FUBON_LOAN_LEGACY_AUTHORITY_ROUTE, captureId.commit_id);
    store.db
      .prepare("UPDATE source_captures SET authority_route = ? WHERE capture_id = ?")
      .run(FUBON_LOAN_LEGACY_AUTHORITY_ROUTE, captureId.capture_id);

    const current = queryCanonicalLoanCurrent(store, { sourceId: "fubon" });
    const historical = queryCanonicalLoanHistorical(store, {
      sourceId: "fubon",
      knowledgeAt: current.knowledgeAt,
      financialAt: "2026-01-31",
    });
    const lineage = queryCanonicalLoanLineage(store, {
      sourceId: "fubon",
      sourceRecordKey: fixture.records[0]!.sourceRecordKey,
    });
    assert.equal(current.accounts.length, 0);
    assert.equal(current.transactions.length, 0);
    assert.equal(current.balanceObservations.length, 0);
    assert.equal(current.relations.length, 0);
    assert.equal(historical.accounts.length, 0);
    assert.equal(historical.transactions.length, 0);
    assert.equal(historical.balanceObservations.length, 0);
    assert.equal(historical.relations.length, 0);
    assert.equal(lineage.lineage.length, 0);
    assert.ok(
      Number(
        (
          store.db
            .prepare("SELECT COUNT(*) AS count FROM source_records")
            .get() as { count?: number }
        ).count ?? 0,
      ) > 0,
    );

    // A route/version mismatch must be hidden as well; checking only the
    // authority route would allow a stale v1 completeness contract through.
    store.db
      .prepare(
        "UPDATE source_captures SET authority_route = ?, completeness_rule_version = ? WHERE capture_id = ?",
      )
      .run(
        FUBON_LOAN_AUTHORITY_ROUTE,
        "loan/canonical/v1.fubon",
        captureId.capture_id,
      );
    const mismatchedVersion = queryCanonicalLoanCurrent(store, {
      sourceId: "fubon",
    });
    assert.equal(mismatchedVersion.accounts.length, 0);
    assert.equal(mismatchedVersion.transactions.length, 0);
    assert.equal(mismatchedVersion.balanceObservations.length, 0);
    assert.equal(mismatchedVersion.relations.length, 0);
  } finally {
    store.close();
  }
});

test("loan source-date comparison uses Taipei midnight at an early local time", () => {
  assert.equal(
    isCanonicalLoanSourceDateBeforeObservedAt(
      "2026-01-05",
      "2026-01-04T16:30:00.000Z",
    ),
    true,
  );
  assert.equal(
    isCanonicalLoanSourceDateBeforeObservedAt(
      "2026-01-05",
      "2026-01-05T00:30:00+08:00",
    ),
    true,
  );
  assert.equal(
    isCanonicalLoanSourceDateBeforeObservedAt(
      "2026-01-06",
      "2026-01-04T16:30:00.000Z",
    ),
    false,
  );
});

test("Fubon adapter commits source-scoped exact rows through all query seams", async () => {
  const input = {
    accountValue: "fubon-option-test",
    sourceConnectionScope: "fubon-connection-test",
    observedAt: "2026-02-01T00:00:00.000Z",
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    scope: {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      completeness: "complete-range",
      completenessBasis: "source-declared-terminal-range",
      completenessRuleVersion: "loan/canonical/v2.fubon",
      pageCount: 1,
      terminal: true,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: 2,
        proofKind: "source-declared-terminal-range",
      },
    ],
    counterpartTransactions: [],
    relations: [],
    rows: [
      {
        transactionDate: "2026/01/05",
        transactionContent: "LOAN-DISBURSEMENT",
        transactionAmount: "100000.00",
        balanceAfterTransaction: "100000.00",
      },
      {
        transactionDate: "2026/01/31",
        transactionContent: "LOAN-PAYMENT",
        transactionAmount: "12,500.00",
        balanceAfterTransaction: "87,500.00",
      },
    ],
  } as const;
  const first = buildFubonLoanCapture(input);
  const second = buildFubonLoanCapture({
    ...input,
    observedAt: "2026-02-02T00:00:00.000Z",
  });
  assert.equal(first.identity.accountKey, second.identity.accountKey);
  assert.equal(first.records[0]?.sourceRecordKey, second.records[0]?.sourceRecordKey);
  assert.equal(first.scope.completeness, "complete-range");
  assert.equal(first.records[0]?.postingStatus, "posted");
  assert.equal(first.records[0]?.eventEvidence.sourceCode, "LOAN-DISBURSEMENT");
  assert.equal(first.records[0]?.direction, "outflow");
  assert.deepEqual(first.records[1]?.amount, { coefficient: "1250000", scale: 2 });
  assert.equal(first.records[1]?.eventEvidence.sourceRecordKey, first.records[1]?.sourceRecordKey);
  assert.equal(first.balanceObservations.length, 2);
  assert.equal(first.balanceObservations[1]?.effectiveAt, "2026-01-31");
  assert.equal(first.balanceObservations[1]?.effectiveAtPrecision, "date");
  assert.equal(
    first.balanceObservations[1]?.effectiveTimeEvidence.sourceFieldRole,
    "transaction-date",
  );

  const store = createCanonicalLoanStore(":memory:");
  try {
    const committed = await persistFubonLoanCapture(store, input);
    assert.equal(committed.transactionCount, 2);
    assert.equal(committed.balanceObservationCount, 2);
    const current = queryFubonLoanCurrent(store);
    assert.equal(current.accounts.length, 1);
    assert.equal(current.transactions.length, 2);
    assert.equal(current.balanceObservations.length, 1);
    assert.equal(current.relations.length, 0);
    assert.equal(committed.relationCount, 0);
    assert.equal(
      queryFubonLoanHistorical(store, {
        knowledgeAt: committed.commitSequence,
        financialAt: "2026-01-31",
      }).transactions.length,
      2,
    );
    assert.equal(
      queryFubonLoanLineage(store, {
        sourceRecordKey: first.records[0]!.sourceRecordKey,
      }).lineage.length,
      1,
    );
  } finally {
    store.close();
  }
});

test("Fubon live attestation records only sanitized v2 proof", () => {
  assert.equal(FUBON_LOAN_LIVE_VALIDATION_ATTESTATION_V1.status, "verified-live-run");
  assert.equal(FUBON_LOAN_LIVE_VALIDATION_ATTESTATION_V1.verifiedOn, "2026-08-31");
  assert.equal(
    FUBON_LOAN_LIVE_VALIDATION_ATTESTATION_V1.captureContractVersion,
    "loan/canonical/v2.fubon",
  );
  assert.equal(FUBON_LOAN_LIVE_VALIDATION_ATTESTATION_V1.financialValuesRetained, false);
  assert.equal(FUBON_LOAN_LIVE_VALIDATION_ATTESTATION_V1.authenticationSecretsRetained, false);
  assert.equal(FUBON_LOAN_LIVE_VALIDATION_ATTESTATION_V1.rawSourcePayloadRetained, false);
  assert.deepEqual(
    FUBON_LOAN_LIVE_VALIDATION_ATTESTATION_V1.safeAssertions,
    [
      "source-capture:nonzero",
      "loan-account-identity:nonzero",
      "loan-transaction-facts:nonzero",
      "current-loan-projection:nonzero",
      "loan-lineage:nonzero",
    ],
  );
});

test("Yuanta adapter preserves explicit event mapping and exact source evidence", async () => {
  const input = {
    accountValue: "yuanta-option-test",
    sourceConnectionScope: "yuanta-connection-test",
    observedAt: "2026-02-01T00:00:00.000Z",
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    scope: {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      completeness: "complete-range",
      completenessBasis: "source-declared-terminal-range",
      completenessRuleVersion: "loan/canonical/v1.yuanta",
      pageCount: 1,
      terminal: true,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: 1,
        proofKind: "source-declared-terminal-range",
      },
    ],
    counterpartTransactions: [],
    relations: [],
    rows: [
      {
        transactionDate: "2026/01/05",
        postingDate: "2026/01/06",
        paymentItem: "LOAN-PAYMENT",
        transactionAmount: "12,500.00",
        balanceAfterTransaction: "87,500.00",
      },
    ],
  } as const;
  const capture = buildYuantaLoanCapture(input);
  assert.equal(capture.identity.accountKey, buildYuantaLoanCapture(input).identity.accountKey);
  assert.equal(capture.records[0]?.eventKind, "payment");
  assert.equal(capture.records[0]?.direction, "inflow");
  assert.equal(capture.records[0]?.effectiveOn, "2026-01-06");
  assert.deepEqual(capture.records[0]?.amount, { coefficient: "1250000", scale: 2 });
  assert.equal(capture.records[0]?.eventEvidence.contractVersion, capture.contractVersion);

  const store = createCanonicalLoanStore(":memory:");
  try {
    const committed = await persistYuantaLoanCapture(store, input);
    assert.equal(committed.transactionCount, 1);
    const current = queryYuantaLoanCurrent(store);
    assert.equal(current.accounts.length, 1);
    assert.equal(current.transactions.length, 1);
    assert.equal(
      queryYuantaLoanHistorical(store, {
        knowledgeAt: committed.commitSequence,
        financialAt: "2026-01-31",
      }).transactions.length,
      1,
    );
    assert.equal(
      queryYuantaLoanLineage(store, {
        sourceRecordKey: capture.records[0]!.sourceRecordKey,
      }).transactions.length,
      1,
    );
  } finally {
    store.close();
  }
});

test("Yuanta source codebook maps the explicit temporary receipt to payment only", () => {
  const capture = buildYuantaLoanCapture({
    accountValue: "yuanta-option-temporary-receipt-test",
    sourceConnectionScope: "yuanta-connection-test",
    observedAt: "2026-02-01T00:00:00.000Z",
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    scope: {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      completeness: "complete-range",
      completenessBasis: "source-declared-terminal-range",
      completenessRuleVersion: "loan/canonical/v1.yuanta",
      pageCount: 1,
      terminal: true,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: 1,
        proofKind: "source-declared-terminal-range",
      },
    ],
    counterpartTransactions: [],
    relations: [],
    rows: [
      {
        transactionDate: "2026/01/05",
        postingDate: "2026/01/06",
        paymentItem: "暫收款",
        transactionAmount: "10.00",
        balanceAfterTransaction: "90.00",
      },
    ],
  });

  assert.equal(
    YUANTA_LOAN_SOURCE_EVENT_CODEBOOK_VERSION,
    "yuanta/loan-source-event-codebook/v1",
  );
  assert.equal(
    capture.records[0]?.eventEvidence.sourceCode,
    "LOAN-PAYMENT",
  );
  assert.equal(capture.records[0]?.eventKind, "payment");
  assert.equal(capture.records[0]?.direction, "inflow");
  assert.equal(capture.records[0]?.principal, undefined);
  assert.equal(capture.records[0]?.interest, undefined);
  assert.equal(capture.records[0]?.fee, undefined);
  assert.equal(
    YUANTA_LOAN_LIVE_VALIDATION_ATTESTATION_V1.financialValuesRetained,
    false,
  );
});

test("loan canonical writer preserves source-scoped accounts and exact facts", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    const fubon = await commitCanonicalLoanCapture(
      store,
      admitCanonicalLoanCapture(LOAN_CONTRACT_FIXTURES.fubon),
    );
    const yuanta = await commitCanonicalLoanCapture(
      store,
      admitCanonicalLoanCapture(LOAN_CONTRACT_FIXTURES.yuanta),
    );

    assert.equal(fubon.transactionCount, 2);
    assert.equal(fubon.balanceObservationCount, 1);
    assert.equal(fubon.relationCount, 1);
    assert.equal(yuanta.transactionCount, 2);

    const current = queryCanonicalLoanCurrent(store);
    assert.equal(current.accounts.length, 2);
    assert.notEqual(current.accounts[0]?.id, current.accounts[1]?.id);
    assert.equal(
      current.accounts[0]?.accountKey,
      LOAN_CONTRACT_FIXTURES.fubon.identity.accountKey,
    );
    assert.notEqual(
      current.accounts[0]?.accountKey,
      LOAN_CONTRACT_FIXTURES.fubon.identity.accountNo,
    );
    assert.deepEqual(
      current.transactions.map((transaction) => [
        transaction.account.sourceId,
        transaction.direction,
        transaction.amount,
      ]),
      [
        ["fubon", "outflow", { coefficient: "100000", scale: 2 }],
        ["fubon", "inflow", { coefficient: "12500", scale: 2 }],
        ["yuanta", "outflow", { coefficient: "100000", scale: 2 }],
        ["yuanta", "inflow", { coefficient: "12500", scale: 2 }],
      ],
    );
    assert.equal(current.balanceObservations.length, 2);
    assert.equal(
      current.balanceObservations[0]?.balanceKind,
      "loan_outstanding",
    );
    assert.equal(current.relations.length, 2);
    assert.equal(
      current.relations[0]?.evidence.kind,
      "explicit-source-linkage",
    );
    assert.notEqual(current.relations[0]?.fromTransactionId, null);
    assert.notEqual(current.relations[0]?.toTransactionId, null);
    assert.equal(
      Number(
        (
          store.db
            .prepare(
              `SELECT COUNT(*) AS count FROM financial_transactions
               WHERE account_id IN (
                 SELECT account_id FROM financial_accounts WHERE account_type = 'depository'
               )`,
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      2,
    );

    const historical = queryCanonicalLoanHistorical(store, {
      knowledgeAt: fubon.commitSequence,
      financialAt: "2026-01-05",
    });
    assert.equal(historical.accounts.length, 1);
    assert.equal(historical.transactions.length, 1);
    assert.equal(historical.transactions[0]?.direction, "outflow");
    assert.equal(historical.balanceObservations.length, 0);
    assert.equal(historical.relations.length, 1);

    const beforeDisbursement = queryCanonicalLoanHistorical(store, {
      knowledgeAt: fubon.commitSequence,
      financialAt: "2026-01-04",
    });
    assert.equal(beforeDisbursement.transactions.length, 0);
    assert.equal(beforeDisbursement.relations.length, 0);

    const lineage = queryCanonicalLoanLineage(store, {
      sourceId: "fubon",
      sourceRecordKey: LOAN_CONTRACT_FIXTURES.fubon.records[0]!.sourceRecordKey,
    });
    assert.equal(lineage.transactions.length, 1);
    assert.equal(lineage.lineage.length, 1);
    assert.equal(lineage.lineage[0]?.payload.eventKind, "disbursement");
  } finally {
    store.close();
  }
});

test("canonical loan capture preserves explicitly supplied counterpart evidence", () => {
  const fixture = structuredClone(LOAN_CONTRACT_FIXTURES.fubon);
  const rows = fixture.records.map((record) => ({
    sourceRecordKey: record.sourceRecordKey,
    occurrenceIndex: record.occurrenceIndex,
    effectiveOn: record.effectiveOn,
    sourceTime: record.sourceTime,
    sourceCode: record.eventEvidence.sourceCode,
    eventKind: record.eventKind,
    direction: record.direction,
    amount: record.amount,
    description: record.description ?? undefined,
    ...(record.balanceSourceEvidence?.[0]
      ? {
            balance: {
              observationKey: fixture.balanceObservations[0]!.observationKey,
              balance: record.balanceSourceEvidence[0].balance,
              effectiveAt: record.balanceSourceEvidence[0].effectiveAt,
              effectiveAtPrecision: "date" as const,
              effectiveAtTimeOrigin: "source_reported" as const,
              effectiveAtField: record.balanceSourceEvidence[0].effectiveAtField,
            },
        }
      : {}),
  }));
  const rebuilt = createCanonicalLoanCapture({
    captureId: fixture.captureId,
    sourceId: fixture.sourceId,
    identity: fixture.identity,
    observedAt: fixture.observedAt,
    startDate: fixture.scope.startDate,
    endDate: fixture.scope.endDate,
    scope: fixture.scope,
    pages: fixture.pages,
    counterpartTransactions: fixture.counterpartTransactions,
    relations: fixture.relations,
    rows,
  });

  assert.deepEqual(rebuilt.counterpartTransactions, fixture.counterpartTransactions);
  assert.deepEqual(rebuilt.relations, fixture.relations);
  assert.deepEqual(rebuilt.scope, fixture.scope);
  assert.deepEqual(rebuilt.pages, fixture.pages);
});

test("current loan balance selection is deterministic across input order and rebuild", async () => {
  const makeInput = (rows: readonly {
    transactionDate: string;
    transactionAmount: string;
    balanceAfterTransaction: string;
  }[]) => ({
    accountValue: "fubon-balance-order-test",
    sourceConnectionScope: "fubon-balance-order-connection",
    observedAt: "2026-03-01T00:00:00.000Z",
    startDate: "2026-01-01",
    endDate: "2026-02-28",
    scope: {
      startDate: "2026-01-01",
      endDate: "2026-02-28",
      completeness: "complete-range" as const,
      completenessBasis: "source-declared-terminal-range" as const,
      completenessRuleVersion: "loan/canonical/v2.fubon",
      pageCount: 1,
      terminal: true as const,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200" as const,
        terminal: true,
        rowCount: rows.length,
        proofKind: "source-declared-terminal-range" as const,
      },
    ],
    counterpartTransactions: [],
    relations: [],
    rows: rows.map((row) => ({
      transactionDate: row.transactionDate.replaceAll("-", "/"),
      transactionContent: "LOAN-PAYMENT",
      transactionAmount: row.transactionAmount,
      balanceAfterTransaction: row.balanceAfterTransaction,
    })),
  });
  const older = {
    transactionDate: "2026-01-31",
    transactionAmount: "10.00",
    balanceAfterTransaction: "90.00",
  };
  const newer = {
    transactionDate: "2026-02-28",
    transactionAmount: "20.00",
    balanceAfterTransaction: "70.00",
  };
  const firstDir = await mkdtemp(join(tmpdir(), "loan-balance-order-first-"));
  const secondDir = await mkdtemp(join(tmpdir(), "loan-balance-order-second-"));
  try {
    const first = createCanonicalLoanStore(join(firstDir, CANONICAL_SQLITE_FILE));
    await persistFubonLoanCapture(first, makeInput([older, newer]));
    const firstCurrent = queryFubonLoanCurrent(first).balanceObservations;
    assert.deepEqual(firstCurrent.map((balance) => balance.effectiveAt), ["2026-02-28"]);
    await rebuildCanonicalProjection(firstDir);
    const firstAfterRebuild = queryFubonLoanCurrent(first).balanceObservations;
    assert.deepEqual(firstAfterRebuild.map((balance) => balance.effectiveAt), ["2026-02-28"]);
    first.close();

    const second = createCanonicalLoanStore(join(secondDir, CANONICAL_SQLITE_FILE));
    await persistFubonLoanCapture(second, makeInput([newer, older]));
    assert.deepEqual(
      queryFubonLoanCurrent(second).balanceObservations.map((balance) => balance.effectiveAt),
      ["2026-02-28"],
    );
    await rebuildCanonicalProjection(secondDir);
    assert.deepEqual(
      queryFubonLoanCurrent(second).balanceObservations.map((balance) => balance.effectiveAt),
      ["2026-02-28"],
    );
    second.close();
  } finally {
    await rm(firstDir, { recursive: true, force: true });
    await rm(secondDir, { recursive: true, force: true });
  }
});

test("loan historical queries require both cutoffs", () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    assert.throws(
      () => queryCanonicalLoanHistorical(store, {} as never),
      /both.*financial|cutoff/i,
    );
  } finally {
    store.close();
  }
});

test("loan query uses the versioned canonical schema without runtime DDL", () => {
  const sourceStore = createCanonicalSourceStore(":memory:");
  try {
    const schemaBefore = sourceStore.db
      .prepare("SELECT name, sql FROM sqlite_master ORDER BY name")
      .all();
    assert.throws(
      () => queryCanonicalLoanCurrent(sourceStore),
      /current projection cutoff is missing/i,
    );
    assert.deepEqual(
      sourceStore.db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(),
      schemaBefore,
    );
    assert.equal(
      Number(
        (
          sourceStore.db
            .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 9")
            .get() as { count?: number }
        ).count ?? 0,
      ),
      1,
    );
  } finally {
    sourceStore.close();
  }
});

test("loan event facts remain queryable from typed facts, not source payload JSON", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    await commitCanonicalLoanCapture(
      store,
      admitCanonicalLoanCapture(LOAN_CONTRACT_FIXTURES.fubon),
    );
    store.db
      .prepare(
        `UPDATE source_records SET payload_json = ?
         WHERE occurrence_key = ?`,
      )
      .run(
        JSON.stringify({ eventKind: "fee", direction: "inflow" }),
        LOAN_CONTRACT_FIXTURES.fubon.records[0]!.sourceRecordKey,
      );
    const current = queryCanonicalLoanCurrent(store, { sourceId: "fubon" });
    assert.equal(current.transactions[0]?.eventKind, "disbursement");
    assert.equal(current.transactions[0]?.direction, "outflow");
  } finally {
    store.close();
  }
});

test("loan balance corrections require explicit correction evidence and preserve observations", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    await commitCanonicalLoanCapture(
      store,
      admitCanonicalLoanCapture(LOAN_CONTRACT_FIXTURES.fubon),
    );
    const changed = structuredClone(LOAN_CONTRACT_FIXTURES.fubon);
    changed.captureId = "sha256:fubon-balance-correction-capture";
    changed.observedAt = "2026-02-03T02:00:00.000Z";
    changed.counterpartTransactions = changed.counterpartTransactions.map(
      (counterpart) => ({
        ...counterpart,
        captureId: "sha256:fubon-balance-correction-counterpart",
      }),
    );
    changed.balanceObservations = changed.balanceObservations.map(
      (observation) => ({
        ...observation,
        sourceRecordKey: "sha256:fubon-balance-correction-record",
        balance: { coefficient: "87000", scale: 2 },
        effectiveTimeEvidence: {
          ...observation.effectiveTimeEvidence,
          sourceRecordKey: "sha256:fubon-balance-correction-record",
        },
      }),
    );
    changed.records = changed.records.map((record, index) =>
      index === 1
        ? {
            ...record,
            sourceRecordKey: "sha256:fubon-balance-correction-record",
            occurrenceIndex: 3,
            eventEvidence: {
              ...record.eventEvidence,
              sourceRecordKey: "sha256:fubon-balance-correction-record",
            },
            balanceSourceEvidence: record.balanceSourceEvidence?.map(
              (evidence) => ({
                ...evidence,
                balance: { coefficient: "87000", scale: 2 },
                correctionOfObservationKey:
                  changed.balanceObservations[0]!.observationKey,
              }),
            ),
          }
        : record,
    );
    assert.throws(
      () => admitCanonicalLoanCapture(structuredClone(changed)),
      /correction/i,
    );
    changed.balanceObservations = changed.balanceObservations.map(
      (observation) => ({
        ...observation,
        correctionEvidence: {
          kind: "source-correction",
          sourceRecordKey: observation.sourceRecordKey,
          observationKey: observation.observationKey,
          contractVersion: changed.contractVersion,
        },
      }),
    );
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(changed));
    assert.deepEqual(
      queryCanonicalLoanCurrent(store, {
        sourceId: "fubon",
      }).balanceObservations.find(
        (observation) =>
          observation.observationKey ===
          changed.balanceObservations[0]!.observationKey,
      )?.balance,
      {
        coefficient: "87000",
        scale: 2,
      },
    );
    assert.equal(
      Number(
        (
          store.db
            .prepare(
              `SELECT COUNT(*) AS count FROM balance_observations
               WHERE account_id IN (
                 SELECT account_id FROM financial_accounts
                 WHERE account_type = 'loan' AND stream = 'loan'
               )`,
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      1,
    );
    assert.equal(
      Number(
        (
          store.db
            .prepare(
              `SELECT COUNT(*) AS count FROM balance_observation_revisions
               WHERE observation_id IN (SELECT observation_id FROM balance_observations)`,
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      2,
    );
    assert.equal(
      Number(
        (
          store.db
            .prepare(
              `SELECT COUNT(*) AS count FROM transaction_relations
               WHERE account_id IN (
                 SELECT account_id FROM financial_accounts
                 WHERE account_type = 'loan' AND stream = 'loan'
               )`,
            )
            .get() as { count?: number }
        ).count ?? 0,
      ),
      1,
    );
  } finally {
    store.close();
  }
});

test("loan admission binds balance value, kind, and effective time to retained source evidence", () => {
  const fixture = structuredClone(LOAN_CONTRACT_FIXTURES.fubon);
  const observation = fixture.balanceObservations[0]!;
  for (const replacement of [
    { ...observation, balance: { coefficient: "1", scale: 2 } },
    { ...observation, balanceKind: "outstanding_principal" as const },
    {
      ...observation,
      effectiveAt: "2026-01-30",
      effectiveTimeEvidence: {
        ...observation.effectiveTimeEvidence,
        value: "2026-01-30",
      },
    },
  ]) {
    assert.throws(
      () =>
        admitCanonicalLoanCapture({
          ...structuredClone(fixture),
          balanceObservations: [replacement],
        }),
      /balance.*source|source.*balance|source field evidence/i,
    );
  }
});

test("loan relation endpoints must share source connection and identity epoch", () => {
  const fixture = structuredClone(LOAN_CONTRACT_FIXTURES.yuanta);
  assert.throws(
    () =>
      admitCanonicalLoanCapture({
        ...fixture,
        counterpartTransactions: fixture.counterpartTransactions.map(
          (counterpart) => ({
            ...counterpart,
            sourceConnectionKey: "sha256:other-connection",
          }),
        ),
      }),
    /source connection|source scope/i,
  );
  assert.throws(
    () =>
      admitCanonicalLoanCapture({
        ...fixture,
        counterpartTransactions: fixture.counterpartTransactions.map(
          (counterpart) => ({
            ...counterpart,
            identityEpochKey: "sha256:other-epoch",
          }),
        ),
      }),
    /identity epoch|source scope/i,
  );
});

test("empty linkage arrays cannot claim complete relation coverage", () => {
  const fixture = structuredClone(LOAN_CONTRACT_FIXTURES.fubon);
  assert.throws(
    () =>
      admitCanonicalLoanCapture({
        ...fixture,
        relationCoverage: "source-linked-complete",
        counterpartTransactions: [],
        relations: [],
      }),
    /complete.*relation coverage|source-linked.*counterpart|relation evidence/i,
  );
  const admitted = admitCanonicalLoanCapture({
    ...fixture,
    relationCoverage: "not-asserted",
    counterpartTransactions: [],
    relations: [],
  });
  assert.equal(admitted.relationCoverage, "not-asserted");
});

test("loan identity uses accountKey and current queries read projection selections", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    const fixture = structuredClone(LOAN_CONTRACT_FIXTURES.fubon);
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(fixture));
    const persisted = store.db
      .prepare(
        `SELECT account.account_no AS spine_key, identity.account_key, identity.account_no,
                identity.created_commit_id
         FROM loan_account_identities identity
         JOIN financial_accounts account ON account.account_id = identity.account_id
         WHERE identity.account_type = 'loan'`,
      )
      .get() as Record<string, unknown>;
    assert.equal(persisted.spine_key, fixture.identity.accountKey);
    assert.equal(persisted.account_key, fixture.identity.accountKey);
    assert.equal(persisted.account_no, fixture.identity.accountNo);
    assert.ok(persisted.created_commit_id instanceof Uint8Array);

    store.db.exec("DELETE FROM current_transactions");
    assert.equal(
      queryCanonicalLoanCurrent(store, { sourceId: "fubon" }).transactions
        .length,
      2,
    );
    store.db.exec(
      "DELETE FROM current_loan_accounts; DELETE FROM current_loan_balance_observations; DELETE FROM current_loan_relations",
    );
    const current = queryCanonicalLoanCurrent(store, { sourceId: "fubon" });
    assert.equal(current.accounts.length, 0);
    assert.equal(current.balanceObservations.length, 0);
    assert.equal(current.relations.length, 0);
    const historical = queryCanonicalLoanHistorical(store, {
      knowledgeAt: current.knowledgeAt,
      financialAt: "2026-01-31",
      sourceId: "fubon",
    });
    assert.equal(historical.balanceObservations.length, 1);
    assert.equal(historical.relations.length, 1);
  } finally {
    store.close();
  }
});

test("equal display account numbers do not merge different contract account keys", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    const first = structuredClone(LOAN_CONTRACT_FIXTURES.fubon);
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(first));
    const second = structuredClone(first);
    second.captureId = "sha256:second-account-key-capture";
    second.identity = {
      ...second.identity,
      accountKey: "sha256:second-contract-account-key",
    };
    second.counterpartTransactions = second.counterpartTransactions.map(
      (counterpart) => ({
        ...counterpart,
        captureId: "sha256:second-account-key-counterpart",
      }),
    );
    second.relations = second.relations.map((relation) => ({
      ...relation,
      fromAccountKey: second.identity.accountKey,
    }));
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(second));
    const accounts = queryCanonicalLoanCurrent(store, {
      sourceId: "fubon",
    }).accounts;
    assert.equal(accounts.length, 2);
    assert.deepEqual(
      new Set(accounts.map((account) => account.accountNo)),
      new Set([first.identity.accountNo]),
    );
    assert.deepEqual(
      new Set(accounts.map((account) => account.accountKey)),
      new Set([first.identity.accountKey, second.identity.accountKey]),
    );
  } finally {
    store.close();
  }
});

test("independent balance measurements create observations while corrections create revisions", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    const first = structuredClone(LOAN_CONTRACT_FIXTURES.fubon);
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(first));
    const second = structuredClone(first);
    second.captureId = "sha256:independent-balance-capture";
    second.observedAt = "2026-02-03T02:00:00.000Z";
    second.counterpartTransactions = second.counterpartTransactions.map(
      (counterpart) => ({
        ...counterpart,
        captureId: "sha256:independent-balance-counterpart",
      }),
    );
    second.relations = second.relations.map((relation) => ({
      ...relation,
      fromSourceRecordKey: relation.toSourceRecordKey,
      toSourceRecordKey: relation.fromSourceRecordKey,
      fromAccountKey: relation.toAccountKey,
      toAccountKey: relation.fromAccountKey,
      fromDirection: relation.toDirection,
      toDirection: relation.fromDirection,
    }));
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(second));
    assert.equal(
      Number(
        (
          store.db
            .prepare("SELECT COUNT(*) AS count FROM balance_observations")
            .get() as { count: number }
        ).count,
      ),
      2,
    );
    assert.equal(
      Number(
        (
          store.db
            .prepare(
              "SELECT COUNT(*) AS count FROM balance_observation_revisions",
            )
            .get() as { count: number }
        ).count,
      ),
      2,
    );
  } finally {
    store.close();
  }
});

test("file-backed loan current projections survive rebuild and schema migration is stable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-loan-v9-"));
  const databasePath = join(directory, CANONICAL_SQLITE_FILE);
  try {
    const v9Seed = createCanonicalSourceStore(databasePath);
    v9Seed.close();
    const v8 = new DatabaseSync(databasePath);
    v8.exec(`PRAGMA foreign_keys = OFF;
      DROP TABLE current_loan_relations;
      DROP TABLE current_loan_balance_observations;
      DROP TABLE current_loan_accounts;
      DROP TABLE transaction_relation_provenance;
      DROP TABLE transaction_relations;
      DROP TABLE balance_observation_revisions;
      DROP TABLE balance_observations;
      DROP TABLE loan_transaction_facts;
      DROP TABLE loan_account_identities;
      DELETE FROM schema_migrations WHERE version = 9;
      PRAGMA user_version = 8;`);
    v8.close();

    const initial = createCanonicalLoanStore(databasePath);
    await commitCanonicalLoanCapture(
      initial,
      admitCanonicalLoanCapture(LOAN_CONTRACT_FIXTURES.fubon),
    );
    const before = queryCanonicalLoanCurrent(initial, { sourceId: "fubon" });
    assert.deepEqual(
      [before.accounts.length, before.transactions.length, before.balanceObservations.length, before.relations.length],
      [1, 2, 1, 1],
    );
    initial.close();

    await rebuildCanonicalProjection(directory);
    const reopened = createCanonicalLoanStore(databasePath);
    validateCanonicalSourceStore(reopened.sourceStore);
    const after = queryCanonicalLoanCurrent(reopened, { sourceId: "fubon" });
    assert.deepEqual(
      [after.accounts.length, after.transactions.length, after.balanceObservations.length, after.relations.length],
      [1, 2, 1, 1],
    );
    assert.equal(
      Number(
        (
          reopened.db
            .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 9")
            .get() as { count?: number }
        ).count ?? 0,
      ),
      1,
    );
    reopened.close();

    const reopenedAgain = createCanonicalLoanStore(databasePath);
    validateCanonicalSourceStore(reopenedAgain.sourceStore);
    assert.equal(
      Number(
        (
          reopenedAgain.db
            .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 9")
            .get() as { count?: number }
        ).count ?? 0,
      ),
      1,
    );
    reopenedAgain.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("duplicate relation evidence adds provenance without duplicating the edge", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    const first = structuredClone(LOAN_CONTRACT_FIXTURES.yuanta);
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(first));
    const second = structuredClone(first);
    second.captureId = "sha256:relation-provenance-capture";
    second.observedAt = "2026-02-03T02:00:00.000Z";
    second.counterpartTransactions = second.counterpartTransactions.map(
      (counterpart) => ({
        ...counterpart,
        captureId: "sha256:relation-provenance-counterpart",
      }),
    );
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(second));
    assert.equal(
      Number(
        (
          store.db
            .prepare("SELECT COUNT(*) AS count FROM transaction_relations")
            .get() as { count: number }
        ).count,
      ),
      1,
    );
    assert.equal(
      Number(
        (
          store.db
            .prepare(
              "SELECT COUNT(*) AS count FROM transaction_relation_provenance",
            )
            .get() as { count: number }
        ).count,
      ),
      2,
    );
  } finally {
    store.close();
  }
});

test("every loan extension and projection row retains canonical commit lineage", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    await commitCanonicalLoanCapture(
      store,
      admitCanonicalLoanCapture(LOAN_CONTRACT_FIXTURES.fubon),
    );
    for (const query of [
      "SELECT created_commit_id AS commit_id FROM loan_account_identities",
      "SELECT commit_id FROM loan_transaction_facts",
      "SELECT created_commit_id AS commit_id FROM balance_observations",
      "SELECT commit_id FROM balance_observation_revisions",
      "SELECT commit_id FROM transaction_relations",
      "SELECT commit_id FROM transaction_relation_provenance",
      "SELECT projection_commit_id AS commit_id FROM current_loan_accounts",
      "SELECT projection_commit_id AS commit_id FROM current_loan_balance_observations",
      "SELECT projection_commit_id AS commit_id FROM current_loan_relations",
    ]) {
      const rows = store.db.prepare(query).all() as Array<{
        commit_id?: unknown;
      }>;
      assert.ok(rows.length > 0, query);
      assert.equal(
        rows.every(
          (row) =>
            row.commit_id instanceof Uint8Array &&
            row.commit_id.byteLength === 16,
        ),
        true,
        query,
      );
    }
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    store.close();
  }
});
