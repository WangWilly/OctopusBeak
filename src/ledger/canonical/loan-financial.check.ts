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
  LEGACY_UNATTRIBUTED_LOAN_RELATION_EVIDENCE_VERSION,
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
  isFubonLoanLiveValidationAttestationValid,
  persistFubonLoanCapture,
  queryFubonLoanCurrent,
  queryFubonLoanHistorical,
  queryFubonLoanLineage,
} from "./fubon-loan.ts";
import { FUBON_LOAN_LIVE_RUN_EVIDENCE_V1 } from "./fubon-loan-live-attestation.fixture.ts";
import {
  buildYuantaLoanCapture,
  persistYuantaLoanCapture,
  queryYuantaLoanCurrent,
  queryYuantaLoanHistorical,
  queryYuantaLoanLineage,
  YUANTA_LOAN_LEGACY_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
  YUANTA_LOAN_LIVE_VALIDATION_ATTESTATION_V1,
  isYuantaLoanLiveValidationAttestationValid,
  YUANTA_LOAN_SOURCE_OCCURRENCE_AMBIGUITY_DIAGNOSTIC_VERSION,
  YUANTA_LOAN_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
  YUANTA_LOAN_SOURCE_EVENT_CODEBOOK_VERSION,
} from "./yuanta-loan.ts";
import { YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1 } from "./yuanta-loan-live-attestation.fixture.ts";

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
  assert.equal(
    isFubonLoanLiveValidationAttestationValid(
      FUBON_LOAN_LIVE_VALIDATION_ATTESTATION_V1,
    ),
    true,
  );
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
      "identity:source-connection-and-loan-account-boundary-observed",
      "money:source-amount-and-loan-boundary-direction-observed",
      "time:source-transaction-and-balance-effective-time-observed",
      "status:source-event-codebook-observed",
      "completeness:provider-terminal-complete-range-observed",
      "queries:current-historical-lineage-reopen-observed",
    ],
  );
  assert.equal(
    FUBON_LOAN_LIVE_VALIDATION_ATTESTATION_V1.fieldEvidenceVersion,
    "loan-live-field-observation/v1",
  );
  assert.equal(
    FUBON_LOAN_LIVE_VALIDATION_ATTESTATION_V1.fieldEvidenceId,
    FUBON_LOAN_LIVE_RUN_EVIDENCE_V1.fieldEvidenceId,
  );
  assert.deepEqual(
    Object.keys(FUBON_LOAN_LIVE_RUN_EVIDENCE_V1.fieldObservations),
    ["identity", "money", "time", "status", "completeness", "queries"],
  );
  assert.equal(
    FUBON_LOAN_LIVE_RUN_EVIDENCE_V1.fieldObservations.completeness.terminalRule,
    "fubon-loan-terminal-v2",
  );
  assert.match(
    FUBON_LOAN_LIVE_VALIDATION_ATTESTATION_V1.runEvidenceId,
    /^sha256:/,
  );
  assert.match(
    FUBON_LOAN_LIVE_VALIDATION_ATTESTATION_V1.runEvidenceArtifact,
    /fubon-loan-live-attestation\.fixture\.ts/u,
  );
});

test("Fubon live readiness rejects a status-only or stale attestation", () => {
  const statusOnly = {
    sourceId: "fubon",
    workflow: "fubonLoanStatements",
    status: "verified-live-run",
    financialValuesRetained: false,
    authenticationSecretsRetained: false,
    rawSourcePayloadRetained: false,
  };
  assert.equal(isFubonLoanLiveValidationAttestationValid(statusOnly), false);

  for (const mutation of [
    { captureContractVersion: "loan/canonical/v1.fubon" },
    { sourceEventCodebookVersion: "fubon/loan-source-event-codebook/v0" },
    { verifiedOn: "2026-08-30" },
    { runEvidenceId: "sha256:stale" },
    { fieldEvidenceId: "sha256:stale" },
    { runEvidenceArtifact: "sanitized:stale-artifact" },
    { financialValuesRetained: true },
    {
      safeAssertions: [
        "source-capture:nonzero",
        "loan-account-identity:nonzero",
      ],
    },
  ]) {
    assert.equal(
      isFubonLoanLiveValidationAttestationValid({
        ...FUBON_LOAN_LIVE_VALIDATION_ATTESTATION_V1,
        ...mutation,
      }),
      false,
      `mutation should invalidate attestation: ${Object.keys(mutation)[0]}`,
    );
  }
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
  assert.equal(
    capture.records[0]?.sourceOccurrenceIdentityRuleVersion,
    YUANTA_LOAN_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
  );
  assert.equal(
    LOAN_CONTRACT_FIXTURES.yuanta.records[0]?.sourceOccurrenceIdentityRuleVersion,
    undefined,
  );
  assert.equal(
    YUANTA_LOAN_LEGACY_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
    "yuanta/loan-source-occurrence/v1",
  );

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

function yuantaOccurrenceInput(
  rows: readonly {
    transactionDate: string;
    postingDate: string;
    paymentItem: string;
    transactionAmount: string;
    balanceAfterTransaction: string;
  }[],
  observedAt = "2026-02-01T00:00:00.000Z",
) {
  return {
    accountValue: "yuanta-occurrence-regression-account",
    sourceConnectionScope: "yuanta-occurrence-regression-connection",
    observedAt,
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    scope: {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      completeness: "complete-range" as const,
      completenessBasis: "source-declared-terminal-range" as const,
      completenessRuleVersion: "loan/canonical/v1.yuanta",
      pageCount: 1,
      terminal: true as const,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200" as const,
        terminal: true as const,
        rowCount: rows.length,
        proofKind: "source-declared-terminal-range" as const,
      },
    ],
    counterpartTransactions: [],
    relations: [],
    rows,
  };
}

test("Yuanta occurrence identity survives reordered rows without a source collision", async () => {
  const rowA = {
    transactionDate: "2026/01/05",
    postingDate: "2026/01/06",
    paymentItem: "LOAN-DISBURSEMENT",
    transactionAmount: "100000.00",
    balanceAfterTransaction: "100000.00",
  };
  const rowB = {
    transactionDate: "2026/01/31",
    postingDate: "2026/01/31",
    paymentItem: "LOAN-PAYMENT",
    transactionAmount: "12500.00",
    balanceAfterTransaction: "87500.00",
  };
  const first = buildYuantaLoanCapture(
    yuantaOccurrenceInput([rowA, rowB]),
  );
  const reordered = buildYuantaLoanCapture(
    yuantaOccurrenceInput(
      [
        {
          ...rowB,
          transactionAmount: "12,500.0",
          balanceAfterTransaction: "87,500.0",
        },
        rowA,
      ],
      "2026-02-02T00:00:00.000Z",
    ),
  );

  assert.equal(first.records[0]?.sourceRecordKey, reordered.records[1]?.sourceRecordKey);
  assert.equal(first.records[1]?.sourceRecordKey, reordered.records[0]?.sourceRecordKey);

  const store = createCanonicalLoanStore(":memory:");
  try {
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(first));
    await assert.doesNotReject(() =>
      commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(reordered)),
    );
    const records = store.db
      .prepare(
        `SELECT occurrence_key AS occurrenceKey, collision_key AS collisionKey,
                provider_key AS providerKey
         FROM source_records
         WHERE occurrence_key IS NOT NULL
         ORDER BY occurrence_key`,
      )
      .all() as Array<{
      occurrenceKey?: string;
      collisionKey?: string;
      providerKey?: string;
    }>;
    assert.equal(records.length, 4);
    assert.equal(new Set(records.map((record) => record.occurrenceKey)).size, 2);
    assert.equal(new Set(records.map((record) => record.collisionKey)).size, 2);
    assert.equal(new Set(records.map((record) => record.providerKey)).size, 2);
  } finally {
    store.close();
  }
});

test("Yuanta occurrence identity survives a sliding overlap without a source collision", async () => {
  const rowA = {
    transactionDate: "2026/01/05",
    postingDate: "2026/01/06",
    paymentItem: "LOAN-DISBURSEMENT",
    transactionAmount: "100000.00",
    balanceAfterTransaction: "100000.00",
  };
  const rowB = {
    transactionDate: "2026/01/15",
    postingDate: "2026/01/15",
    paymentItem: "LOAN-PAYMENT",
    transactionAmount: "12500.00",
    balanceAfterTransaction: "87500.00",
  };
  const rowC = {
    transactionDate: "2026/01/31",
    postingDate: "2026/01/31",
    paymentItem: "LOAN-FEE",
    transactionAmount: "100.00",
    balanceAfterTransaction: "87400.00",
  };
  const first = buildYuantaLoanCapture(
    yuantaOccurrenceInput([rowA, rowB]),
  );
  const sliding = buildYuantaLoanCapture(
    yuantaOccurrenceInput([rowB, rowC], "2026-02-02T00:00:00.000Z"),
  );
  assert.equal(first.records[1]?.sourceRecordKey, sliding.records[0]?.sourceRecordKey);

  const store = createCanonicalLoanStore(":memory:");
  try {
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(first));
    await assert.doesNotReject(() =>
      commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(sliding)),
    );
    assert.equal(queryYuantaLoanCurrent(store).transactions.length, 3);
  } finally {
    store.close();
  }
});

test("Yuanta same-day payment-item variants receive distinct source identities", async () => {
  const capture = buildYuantaLoanCapture(
    yuantaOccurrenceInput([
      {
        transactionDate: "2026/01/15",
        postingDate: "2026/01/15",
        paymentItem: "LOAN-PAYMENT",
        transactionAmount: "12500.00",
        balanceAfterTransaction: "87500.00",
      },
      {
        transactionDate: "2026/01/15",
        postingDate: "2026/01/15",
        paymentItem: "暫收款",
        transactionAmount: "100.00",
        balanceAfterTransaction: "87400.00",
      },
    ]),
  );
  assert.notEqual(
    capture.records[0]?.sourceRecordKey,
    capture.records[1]?.sourceRecordKey,
  );

  const store = createCanonicalLoanStore(":memory:");
  try {
    await assert.doesNotReject(() =>
      commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(capture)),
    );
    assert.equal(queryYuantaLoanCurrent(store).transactions.length, 2);
  } finally {
    store.close();
  }
});

test("Yuanta indistinguishable duplicate semantic rows fail closed", () => {
  const row = {
    transactionDate: "2026/01/15",
    postingDate: "2026/01/15",
    paymentItem: "LOAN-PAYMENT",
    transactionAmount: "12500.00",
    balanceAfterTransaction: "87500.00",
  };
  assert.throws(
    () => buildYuantaLoanCapture(yuantaOccurrenceInput([row, row])),
    /ambiguous/u,
  );
});

test("Yuanta semantic occurrence correction cannot overwrite prior source evidence", async () => {
  const input = yuantaOccurrenceInput([
    {
      transactionDate: "2026/01/15",
      postingDate: "2026/01/15",
      paymentItem: "LOAN-PAYMENT",
      transactionAmount: "12500.00",
      balanceAfterTransaction: "87500.00",
    },
  ]);
  const original = buildYuantaLoanCapture(input);
  const corrected = buildYuantaLoanCapture({
    ...input,
    observedAt: "2026-02-02T00:00:00.000Z",
    rows: [
      {
        transactionDate: "2026/01/15",
        postingDate: "2026/01/15",
        paymentItem: "LOAN-PAYMENT",
        transactionAmount: "13000.00",
        balanceAfterTransaction: "87000.00",
      },
    ],
  });
  assert.equal(
    original.records[0]?.sourceRecordKey,
    corrected.records[0]?.sourceRecordKey,
  );

  const store = createCanonicalLoanStore(":memory:");
  try {
    await commitCanonicalLoanCapture(store, admitCanonicalLoanCapture(original));
    await assert.rejects(
      () =>
        commitCanonicalLoanCapture(
          store,
          admitCanonicalLoanCapture(corrected),
        ),
      /Source occurrence content overwrite is forbidden/u,
    );
  } finally {
    store.close();
  }
});

test("Yuanta rows with one indistinguishable anchor fail closed as ambiguous", () => {
  assert.throws(
    () =>
      buildYuantaLoanCapture(
        yuantaOccurrenceInput([
          {
            transactionDate: "2026/01/15",
            postingDate: "2026/01/15",
            paymentItem: "LOAN-PAYMENT",
            transactionAmount: "12500.00",
            balanceAfterTransaction: "87500.00",
          },
          {
            transactionDate: "2026/01/15",
            postingDate: "2026/01/15",
            paymentItem: "LOAN-PAYMENT",
            transactionAmount: "13000.00",
            balanceAfterTransaction: "87000.00",
          },
        ]),
      ),
    /ambiguous/u,
  );
});

test("Yuanta ambiguity diagnostics are bounded and sanitized", () => {
  const sensitiveAccount = "yuanta-sensitive-account-7890";
  const sensitiveDate = "2026/01/15";
  const sensitivePaymentItem = "LOAN-PAYMENT";
  const sensitiveAmount = "12,500.00";
  const sensitiveBalance = "87,500.00";
  const sensitiveCorrectedAmount = "13,000.00";
  const sensitiveCorrectedBalance = "87,000.00";
  const rows = Array.from({ length: 20 }, (_, index) => ({
    transactionDate: sensitiveDate,
    postingDate: sensitiveDate,
    paymentItem: sensitivePaymentItem,
    transactionAmount: index === 1 ? sensitiveCorrectedAmount : sensitiveAmount,
    balanceAfterTransaction:
      index === 1 ? sensitiveCorrectedBalance : sensitiveBalance,
  }));
  const output: unknown[][] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => output.push(args);
  try {
    assert.throws(
      () =>
        buildYuantaLoanCapture({
          ...yuantaOccurrenceInput(rows),
          accountValue: sensitiveAccount,
        }),
      /ambiguous/u,
    );
  } finally {
    console.log = originalLog;
  }

  assert.equal(output.length, 1);
  assert.equal(output[0]?.length, 1);
  const emitted = String(output[0]?.[0]);
  assert.equal(emitted.includes("[Array]"), false);
  assert.equal(emitted.includes("[Object]"), false);
  const envelope = JSON.parse(emitted) as {
    event: string;
    diagnostic: {
      diagnosticVersion: string;
      identityRuleVersion: string;
      duplicateGroupCount: number;
      reportedGroupCount: number;
      groupsTruncated: boolean;
      sourceHeaderAliasPresence: readonly {
        aliasId: string;
        present: boolean;
      }[];
      groups: readonly {
        multiplicity: number;
        rowOrdinalPositions: readonly number[];
        rowOrdinalPositionBuckets: readonly string[];
        omittedMemberCount: number;
        stableAnchorHashes: Readonly<Record<string, string>>;
        changedFieldKinds: readonly string[];
        sourceRowFieldPresence: readonly unknown[];
      }[];
    };
  };
  assert.equal(envelope.event, "yuanta-loan-source-occurrence-ambiguity");
  const diagnostic = envelope.diagnostic;
  assert.equal(
    diagnostic.diagnosticVersion,
    YUANTA_LOAN_SOURCE_OCCURRENCE_AMBIGUITY_DIAGNOSTIC_VERSION,
  );
  assert.equal(
    diagnostic.identityRuleVersion,
    YUANTA_LOAN_SOURCE_OCCURRENCE_IDENTITY_RULE_VERSION,
  );
  assert.equal(diagnostic.duplicateGroupCount, 1);
  assert.equal(diagnostic.reportedGroupCount, 1);
  assert.equal(diagnostic.groupsTruncated, false);
  assert.equal(diagnostic.groups.length, 1);
  assert.equal(diagnostic.groups[0]?.multiplicity, 20);
  assert.equal(diagnostic.groups[0]?.rowOrdinalPositions.length, 16);
  assert.deepEqual(diagnostic.groups[0]?.rowOrdinalPositions.slice(0, 2), [1, 2]);
  assert.deepEqual(diagnostic.groups[0]?.rowOrdinalPositionBuckets, ["1-10", "11-20"]);
  assert.equal(diagnostic.groups[0]?.omittedMemberCount, 4);
  assert.deepEqual(diagnostic.groups[0]?.changedFieldKinds, [
    "transaction-amount",
    "balance-after-transaction",
  ]);
  assert.ok(
    Object.values(diagnostic.groups[0]?.stableAnchorHashes ?? {}).every((value) =>
      /^sha256:[A-Za-z0-9_-]+$/u.test(value),
    ),
  );
  assert.equal(
    diagnostic.sourceHeaderAliasPresence.find(
      (header) => header.aliasId === "provider-transaction-id",
    )?.present,
    false,
  );
  assert.equal(
    diagnostic.sourceHeaderAliasPresence.find(
      (header) => header.aliasId === "overpayment",
    )?.present,
    true,
  );

  const serialized = JSON.stringify(diagnostic);
  for (const sensitive of [
    sensitiveAccount,
    sensitiveDate,
    sensitivePaymentItem,
    sensitiveAmount,
    sensitiveBalance,
    sensitiveCorrectedAmount,
    sensitiveCorrectedBalance,
  ])
    assert.equal(serialized.includes(sensitive), false, sensitive);
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

test("Yuanta live readiness is bound to sanitized versioned run evidence", () => {
  assert.equal(
    isYuantaLoanLiveValidationAttestationValid(
      YUANTA_LOAN_LIVE_VALIDATION_ATTESTATION_V1,
    ),
    true,
  );
  assert.equal(
    YUANTA_LOAN_LIVE_VALIDATION_ATTESTATION_V1.verifiedOn,
    "2026-09-01",
  );
  assert.match(
    YUANTA_LOAN_LIVE_VALIDATION_ATTESTATION_V1.runEvidenceId,
    /^sha256:/,
  );
  assert.match(
    YUANTA_LOAN_LIVE_VALIDATION_ATTESTATION_V1.runEvidenceArtifact,
    /yuanta-loan-live-attestation\.fixture\.ts/u,
  );
  assert.equal(
    YUANTA_LOAN_LIVE_VALIDATION_ATTESTATION_V1.fieldEvidenceId,
    YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.fieldEvidenceId,
  );
  assert.deepEqual(
    Object.keys(YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.fieldObservations),
    ["identity", "money", "time", "status", "completeness", "queries"],
  );
  assert.equal(
    YUANTA_LOAN_LIVE_RUN_EVIDENCE_V1.fieldObservations.completeness.terminalRule,
    "yuanta-loan-terminal-v2",
  );

  for (const mutation of [
    { status: "pending" },
    { verifiedOn: "2026-08-31" },
    { captureContractVersion: "loan/canonical/v0.yuanta" },
    { runEvidenceId: "sha256:stale" },
    { fieldEvidenceId: "sha256:stale" },
    { financialValuesRetained: true },
    { safeAssertions: ["source-capture:nonzero"] },
  ]) {
    assert.equal(
      isYuantaLoanLiveValidationAttestationValid({
        ...YUANTA_LOAN_LIVE_VALIDATION_ATTESTATION_V1,
        ...mutation,
      }),
      false,
      `mutation should invalidate attestation: ${Object.keys(mutation)[0]}`,
    );
  }
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
      "legacy-unattributed",
    );
    assert.equal(
      current.relations[0]?.evidence.evidenceVersion,
      LEGACY_UNATTRIBUTED_LOAN_RELATION_EVIDENCE_VERSION,
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

test("loan relation queries preserve unknown provenance for legacy rows without events", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    const committed = await commitCanonicalLoanCapture(
      store,
      admitCanonicalLoanCapture(LOAN_CONTRACT_FIXTURES.fubon),
    );
    // A v9 relation can predate the v10 lifecycle event table.  Remove only
    // the synthetic event to model that legacy shape while retaining the
    // relation projection and endpoint facts.
    store.db.exec("DELETE FROM loan_repayment_relation_events");

    const current = queryCanonicalLoanCurrent(store, { sourceId: "fubon" });
    const historical = queryCanonicalLoanHistorical(store, {
      sourceId: "fubon",
      knowledgeAt: committed.commitSequence,
      financialAt: "2026-01-31",
    });
    const lineage = queryCanonicalLoanLineage(store, {
      sourceId: "fubon",
      sourceRecordKey: LOAN_CONTRACT_FIXTURES.fubon.records[0]!.sourceRecordKey,
    });

    for (const result of [current, historical, lineage]) {
      assert.equal(result.relations.length, 1);
      assert.equal(result.relations[0]?.evidence.kind, "legacy-unattributed");
      assert.equal(
        result.relations[0]?.evidence.evidenceVersion,
        LEGACY_UNATTRIBUTED_LOAN_RELATION_EVIDENCE_VERSION,
      );
    }
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

test("loan current and historical queries preserve the source-reported time basis", async () => {
  const store = createCanonicalLoanStore(":memory:");
  try {
    await commitCanonicalLoanCapture(
      store,
      admitCanonicalLoanCapture(LOAN_CONTRACT_FIXTURES.fubon),
    );
    const current = queryCanonicalLoanCurrent(store, { sourceId: "fubon" });
    const historical = queryCanonicalLoanHistorical(store, {
      sourceId: "fubon",
      financialAt: "2026-01-31",
      knowledgeAt: current.knowledgeAt,
    });
    assert.deepEqual(
      [
        ...current.transactions,
        ...historical.transactions,
      ].map((transaction) => transaction.effectiveTimeBasis),
      ["source-reported", "source-reported", "source-reported", "source-reported"],
    );
    const persisted = store.db
      .prepare(
        `SELECT DISTINCT effective_time_basis AS basis
         FROM transaction_revisions
         WHERE effective_time_rule_version = 'fubon/loan/canonical-v2'`,
      )
      .all() as Array<{ basis?: unknown }>;
    assert.deepEqual(
      persisted.map((row) => row.basis),
      ["source-reported"],
    );
  } finally {
    store.close();
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

test("loan relation endpoints share a source connection while retaining independent identity epochs", async () => {
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
  const independentEpoch = `sha256:${"1".repeat(64)}`;
  const admitted = admitCanonicalLoanCapture({
    ...fixture,
    counterpartTransactions: fixture.counterpartTransactions.map(
      (counterpart) => ({
        ...counterpart,
        identityEpochKey: independentEpoch,
      }),
    ),
  });
  const store = createCanonicalLoanStore(":memory:");
  try {
    await commitCanonicalLoanCapture(store, admitted);
    const relation = store.db
      .prepare(
        `SELECT from_epoch.epoch_key AS from_epoch_key,
                to_epoch.epoch_key AS to_epoch_key
           FROM transaction_relations relation
           JOIN identity_epochs from_epoch
             ON from_epoch.identity_epoch_id = relation.from_identity_epoch_id
           JOIN identity_epochs to_epoch
             ON to_epoch.identity_epoch_id = relation.to_identity_epoch_id`,
      )
      .get() as { from_epoch_key: string; to_epoch_key: string };
    assert.deepEqual(
      new Set([relation.from_epoch_key, relation.to_epoch_key]),
      new Set([fixture.identity.identityEpochKey, independentEpoch]),
    );
  } finally {
    store.close();
  }
});

test("historical relations require both endpoint financial dates at the cutoff", async () => {
  for (const endpoint of ["from", "to"] as const) {
    const store = createCanonicalLoanStore(":memory:");
    try {
      const committed = await commitCanonicalLoanCapture(
        store,
        admitCanonicalLoanCapture(
          structuredClone(LOAN_CONTRACT_FIXTURES.fubon),
        ),
      );
      const relation = store.db
        .prepare(
          `SELECT from_transaction_id, to_transaction_id
             FROM transaction_relations`,
        )
        .get() as {
        from_transaction_id: Uint8Array;
        to_transaction_id: Uint8Array;
      };
      store.db
        .prepare(
          `UPDATE transaction_revisions SET effective_on = '2026-01-06'
            WHERE transaction_id = ?`,
        )
        .run(
          endpoint === "from"
            ? relation.from_transaction_id
            : relation.to_transaction_id,
        );
      assert.equal(
        queryCanonicalLoanHistorical(store, {
          knowledgeAt: committed.commitSequence,
          financialAt: "2026-01-05",
        }).relations.length,
        0,
        `${endpoint} endpoint after cutoff excludes relation`,
      );
      assert.equal(
        queryCanonicalLoanHistorical(store, {
          knowledgeAt: committed.commitSequence,
          financialAt: "2026-01-06",
        }).relations.length,
        1,
      );
    } finally {
      store.close();
    }
  }
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
      DELETE FROM canonical_contract_purge_commits;
      DELETE FROM canonical_contract_purges;
      DELETE FROM schema_migrations WHERE version > 8;
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
