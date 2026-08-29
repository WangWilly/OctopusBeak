import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import {
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  getFubonCreditCardHumanAttestedV1Manifest,
  restoreFubonCreditCardHumanAttestedV1,
  revokeFubonCreditCardHumanAttestedV1,
} from "./fubon-credit-card-human-attestation.ts";
import {
  FUBON_CREDIT_CARD_CAPTURE_CONTRACT,
  admitFubonCreditCardCapture,
  buildFubonCreditCardAccountIdentityKey,
  buildFubonCreditCardStatementEvidenceKey,
  buildFubonCreditCardTransactionSourceKey,
  type FubonCreditCardCaptureInput,
  type FubonCreditCardTransactionInput,
} from "./fubon-credit-card.ts";
import { createCanonicalSourceStore } from "./canonical-source-store.ts";
import { createCanonicalFinancialQuery } from "./canonical-source-store.ts";
import {
  commitFubonCreditCardCapture,
  ensureFubonCreditCardSchema,
} from "./fubon-credit-card.ts";
import {
  fubonCreditCardPanFingerprint,
  fubonCreditCardPanLast4,
  normalizeFubonCreditCardPan,
} from "./fubon-credit-card-pan.ts";

const FUBON_CREDIT_CARD_CONTRACT_VERSION =
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.evidenceVersion;

const completeness = {
  billedPeriods: ["period-1", "period-2", "period-3", "period-4", "period-5", "period-6"],
  unbilledIncluded: true,
  unfiltered: true,
  terminalGrids: true,
  rowCountsMatch: true,
  periodRowCounts: [1, 0, 0, 0, 0, 0],
  unbilledRowCount: 1,
  recordCount: 2,
  settledSummaryEvidencePresent: true,
  grids: [
    ...[1, 0, 0, 0, 0, 0].map((count, index) => ({
      kind: "billed" as const,
      period: `period-${index + 1}`,
      currentPage: 1,
      pageSize: 2_147_483_647,
      maximumPageSize: 2_147_483_647,
      capturedRowCount: count,
      sourceDeclaredRowCount: count,
      sourceDeclaredScopeRowCount: count,
      terminal: true,
      terminalEvidence: "source-declared-total" as const,
    })),
    {
      kind: "unbilled" as const,
      period: "unbilled",
      currentPage: 1,
      pageSize: 2_147_483_647,
      maximumPageSize: 2_147_483_647,
      capturedRowCount: 1,
      sourceDeclaredRowCount: 1,
      sourceDeclaredScopeRowCount: 1,
      terminal: true,
      terminalEvidence: "source-declared-total" as const,
    },
  ],
} as const;

const primaryInstrument = {
  instrumentKey: "instrument-primary-a",
  cardMask: "****1234",
  productName: "SYNTHETIC PLATINUM",
  role: "primary" as const,
  evidence: {
    kind: "explicit-instrument-role" as const,
    sourceRecordKey: "row-purchase-a",
    contractVersion: FUBON_CREDIT_CARD_CONTRACT_VERSION,
  },
};

const secondaryInstrument = {
  instrumentKey: "instrument-primary-b",
  cardMask: "****5678",
  productName: "SYNTHETIC GOLD",
  role: "primary" as const,
  evidence: {
    kind: "explicit-instrument-role" as const,
    sourceRecordKey: "row-purchase-b",
    contractVersion: FUBON_CREDIT_CARD_CONTRACT_VERSION,
  },
};

function transaction(
  overrides: Partial<FubonCreditCardTransactionInput> = {},
): FubonCreditCardTransactionInput {
  return {
    sourceRecordKey: "row-purchase-a",
    occurrenceIndex: 0,
    instrumentKey: primaryInstrument.instrumentKey,
    consumeDate: "2026-08-01",
    postingDate: "2026-08-02",
    direction: "outflow",
    bookedAmount: "123.45",
    bookedCurrency: "TWD",
    description: "SYNTHETIC COFFEE",
    billingStatus: "billed",
    statementKey: "statement-2026-07",
    ...overrides,
  };
}

function capture(
  overrides: Partial<FubonCreditCardCaptureInput> = {},
): FubonCreditCardCaptureInput {
  const identity = overrides.identity ?? {
    sourceConnectionKey: "connection-a",
    identityEpochKey: "epoch-1",
    humanAttestedAccountKey: "portfolio-a",
  };
  return {
    captureId: "capture-a",
    identity,
    observedAt: "2026-08-25T00:00:00.000Z",
    scope: {
      startDate: "2026-01-01",
      endDate: "2026-08-31",
      completeness,
    },
    instruments: [primaryInstrument],
    transactions: [
      transaction(),
      transaction({
        sourceRecordKey: "row-unbilled-a",
        consumeDate: "2026-08-20",
        postingDate: "2026-08-21",
        description: "SYNTHETIC TRANSIT",
        bookedAmount: "20.00",
        billingStatus: "unbilled",
        statementKey: undefined,
      }),
    ],
    statements: [
      {
        statementKey: "statement-2026-07",
        revisionKey: "statement-revision-1",
        cycleStart: "2026-07-01",
        cycleEnd: "2026-07-31",
        issueDate: "2026-08-01",
        dueDate: "2026-08-20",
        currency: "TWD",
        balance: "123.45",
        minimumPayment: "10.00",
        transactionSourceKeys: ["row-purchase-a"],
        evidence: {
          kind: "issuer-settled-cycle-summary",
          sourceRecordKey: buildFubonCreditCardStatementEvidenceKey(
            identity,
            {
              statementKey: "statement-2026-07",
              cycleStart: "2026-07-01",
              cycleEnd: "2026-07-31",
            },
          ),
          settled: true,
        },
      },
    ],
    relations: [],
    ...overrides,
  };
}

function portfolioCapture(): FubonCreditCardCaptureInput {
  const base = capture();
  return {
    ...base,
    captureId: "capture-portfolio",
    instruments: [primaryInstrument, secondaryInstrument],
    transactions: [
      transaction(),
      transaction({
        sourceRecordKey: "row-purchase-b",
        instrumentKey: secondaryInstrument.instrumentKey,
        description: "SYNTHETIC DINNER",
        bookedAmount: "50.00",
      }),
      base.transactions[1]!,
    ],
    scope: {
      ...base.scope,
      completeness: {
        ...completeness,
        periodRowCounts: [2, 0, 0, 0, 0, 0],
        recordCount: 3,
        grids: completeness.grids.map((grid, index) =>
          index === 0
            ? {
                ...grid,
                capturedRowCount: 2,
                sourceDeclaredRowCount: 2,
                sourceDeclaredScopeRowCount: 2,
              }
            : grid,
        ),
      },
    },
    statements: [
      {
        ...base.statements[0]!,
        balance: "173.45",
        transactionSourceKeys: ["row-purchase-a", "row-purchase-b"],
      },
    ],
  };
}

function repeatedOccurrenceCapture(
  overrides: Partial<FubonCreditCardCaptureInput> = {},
): FubonCreditCardCaptureInput {
  return capture({
    scope: {
      ...capture().scope,
      completeness: {
        ...completeness,
        periodRowCounts: [2, 0, 0, 0, 0, 0],
        recordCount: 3,
        grids: completeness.grids.map((grid, index) =>
          index === 0
            ? {
                ...grid,
                capturedRowCount: 2,
                sourceDeclaredRowCount: 2,
                sourceDeclaredScopeRowCount: 2,
              }
            : grid,
        ),
      },
    },
    transactions: [
      transaction(),
      transaction({ sourceRecordKey: "row-purchase-b", occurrenceIndex: 1 }),
      capture().transactions[1]!,
    ],
    statements: [
      {
        ...capture().statements[0]!,
        transactionSourceKeys: ["row-purchase-a", "row-purchase-b"],
      },
    ],
    ...overrides,
  });
}

test("Fubon v2 contract is human-attested and keeps cards subordinate to an opaque account", () => {
  assert.equal(FUBON_CREDIT_CARD_CAPTURE_CONTRACT.authorityRoute, FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.authorityRoute);
  assert.equal(FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.authority, "human-attested-primary-cardholder-portfolio");
  assert.equal(FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.semantics.cards, "primary-card-instruments-under-attested-portfolio");
  assert.equal(FUBON_CREDIT_CARD_CAPTURE_CONTRACT.providerGuaranteed, false);
  assert.equal(FUBON_CREDIT_CARD_CAPTURE_CONTRACT.occurrenceProviderGuaranteed, false);
  assert.equal(
    FUBON_CREDIT_CARD_CAPTURE_CONTRACT.transactionIdentityRule,
    "statement-key-or-source-scope-scoped-occurrence-v2",
  );

  const left = capture();
  const right = capture({
    captureId: "capture-b",
    identity: {
      ...left.identity,
      humanAttestedAccountKey: "portfolio-b",
    },
    instruments: [{ ...primaryInstrument, instrumentKey: "instrument-primary-b" }],
  });
  assert.notEqual(
    buildFubonCreditCardAccountIdentityKey(left.identity),
    buildFubonCreditCardAccountIdentityKey(right.identity),
  );
  assert.match(buildFubonCreditCardAccountIdentityKey(left.identity), /^sha256:/);
  assert.equal(admitFubonCreditCardCapture(left).identity.accountType, "credit");
  assert.equal(admitFubonCreditCardCapture(left).identity.accountSubtype, "credit_card");
  assert.notEqual(
    buildFubonCreditCardAccountIdentityKey({
      sourceConnectionKey: "a:b",
      identityEpochKey: "c",
      humanAttestedAccountKey: "account",
    }),
    buildFubonCreditCardAccountIdentityKey({
      sourceConnectionKey: "a",
      identityEpochKey: "b:c",
      humanAttestedAccountKey: "account",
    }),
  );
});

test("one portfolio account persists multiple card instruments with display-safe masks", async () => {
  const store = createCanonicalSourceStore(":memory:");
  try {
    const admitted = admitFubonCreditCardCapture(portfolioCapture());
    const committed = await commitFubonCreditCardCapture(store, admitted);
    assert.equal(committed.transactionCount, 3);
    assert.equal(
      Number(
        (store.db.prepare("SELECT COUNT(*) AS value FROM financial_accounts").get() as {
          value?: number;
        }).value ?? 0,
      ),
      1,
    );
    const instruments = store.db.prepare(
      `SELECT instrument_key, card_mask, role
       FROM fubon_credit_instrument_details ORDER BY instrument_key`,
    ).all() as Array<{ instrument_key?: string; card_mask?: string; role?: string }>;
    assert.equal(instruments.length, 2);
    assert.ok(instruments.every((row) => /^\*{4}\d{4}$/u.test(row.card_mask ?? "")));
    assert.ok(instruments.every((row) => row.role === "primary"));
    const transactionInstruments = store.db.prepare(
      `SELECT DISTINCT instrument_id
       FROM fubon_credit_transaction_details`,
    ).all() as Array<{ instrument_id?: Uint8Array }>;
    assert.equal(transactionInstruments.length, 2);
    const transactionPayloads = store.db.prepare(
      `SELECT payload_json
       FROM source_records
       WHERE record_kind = 'fubon-credit-card-transaction'
       ORDER BY sequence_lexeme`,
    ).all() as Array<{ payload_json?: string }>;
    assert.equal(transactionPayloads.length, 3);
    const parsedPayloads = transactionPayloads.map((row) =>
      JSON.parse(row.payload_json ?? "{}") as Record<string, unknown>,
    );
    assert.deepEqual(
      parsedPayloads.map((payload) => payload.cardMask),
      ["****1234", "****5678", "****1234"],
    );
    assert.ok(
      parsedPayloads.every(
        (payload) =>
          typeof payload.instrumentKey === "string" &&
          /^\*{4}\d{4}$/u.test(String(payload.cardMask)),
      ),
    );
    assert.equal(
      transactionPayloads.some((row) => /4111\s*1111|1234\s*5678/u.test(row.payload_json ?? "")),
      false,
    );
    const roleLineage = store.db.prepare(
      `SELECT instrument.instrument_key, instrument.card_mask,
              json_extract(source.payload_json, '$.instrumentKey') AS payload_instrument_key,
              json_extract(source.payload_json, '$.cardMask') AS payload_card_mask
       FROM fubon_credit_instrument_role_evidence evidence
       JOIN fubon_credit_instrument_details instrument
         ON instrument.instrument_id = evidence.instrument_id
       JOIN source_records source
         ON source.source_record_id = evidence.source_record_id
       ORDER BY instrument.instrument_key`,
    ).all() as Array<{
      instrument_key?: string;
      card_mask?: string;
      payload_instrument_key?: string;
      payload_card_mask?: string;
    }>;
    assert.deepEqual(roleLineage.map((row) => ({ ...row })), [
      {
        instrument_key: "instrument-primary-a",
        card_mask: "****1234",
        payload_instrument_key: "instrument-primary-a",
        payload_card_mask: "****1234",
      },
      {
        instrument_key: "instrument-primary-b",
        card_mask: "****5678",
        payload_instrument_key: "instrument-primary-b",
        payload_card_mask: "****5678",
      },
    ]);
    const persisted = JSON.stringify(
      store.db.prepare(
        `SELECT account_no FROM financial_accounts
         UNION ALL SELECT instrument_key FROM fubon_credit_instrument_details
         UNION ALL SELECT card_mask FROM fubon_credit_instrument_details`,
      ).all(),
    );
    assert.equal(/\d[\d\s-]{11,}\d/u.test(persisted), false);
  } finally {
    store.close();
  }
});

test("instrument mask column is added idempotently to a legacy extension table", () => {
  const store = createCanonicalSourceStore(":memory:");
  try {
    store.db.exec(`
      DROP TABLE IF EXISTS fubon_credit_instrument_details;
      CREATE TABLE fubon_credit_instrument_details (
        instrument_id BLOB PRIMARY KEY CHECK(length(instrument_id) = 16),
        account_id BLOB NOT NULL,
        instrument_key TEXT NOT NULL,
        role TEXT NOT NULL,
        lifecycle TEXT,
        UNIQUE(account_id, instrument_key)
      );
    `);
    ensureFubonCreditCardSchema(store.db);
    ensureFubonCreditCardSchema(store.db);
    const columns = store.db.prepare(
      "PRAGMA table_info(fubon_credit_instrument_details)",
    ).all() as Array<{ name?: string }>;
    assert.equal(columns.filter((column) => column.name === "card_mask").length, 1);
  } finally {
    store.close();
  }
});

test("instrument role evidence rejects source payload mask drift", async () => {
  const store = createCanonicalSourceStore(":memory:");
  try {
    await assert.rejects(
      commitFubonCreditCardCapture(
        {
          db: store.db,
          databasePath: store.databasePath,
          commitClock: store.commitClock,
          beforeFubonCreditExtensionCommit: (db) => {
            const row = db.prepare(
              `SELECT source_record_id, payload_json
               FROM source_records
               WHERE record_kind = 'fubon-credit-card-transaction'
               ORDER BY sequence_lexeme LIMIT 1`,
            ).get() as { source_record_id?: Uint8Array; payload_json?: string } | undefined;
            assert.ok(row?.source_record_id);
            const payload = JSON.parse(row.payload_json ?? "{}") as Record<string, unknown>;
            payload.cardMask = "****9999";
            db.prepare(
              "UPDATE source_records SET payload_json = ? WHERE source_record_id = ?",
            ).run(JSON.stringify(payload), row.source_record_id);
          },
        },
        admitFubonCreditCardCapture(capture()),
      ),
      /inconsistent card mask|source payload is inconsistent/i,
    );
  } finally {
    store.close();
  }
});

test("full PAN identity is normalized, keyed, and never retained in admitted captures", async () => {
  const pan = "4111 1111-1111 1111";
  const normalized = normalizeFubonCreditCardPan(pan);
  assert.equal(normalized, "4111111111111111");
  assert.equal(fubonCreditCardPanLast4(pan), "1111");
  const key = { secret: "synthetic-pan-fingerprint-key", keyVersion: "test-v1" };
  const fingerprint = fubonCreditCardPanFingerprint(pan, key);
  assert.equal(fingerprint.last4, "1111");
  assert.equal(fingerprint.keyVersion, "test-v1");
  assert.equal(
    fubonCreditCardPanFingerprint("4111111111111111", key).fingerprint,
    fingerprint.fingerprint,
  );
  assert.notEqual(
    fubonCreditCardPanFingerprint("4012888888881881", key).fingerprint,
    fingerprint.fingerprint,
  );
  assert.equal(
    buildFubonCreditCardAccountIdentityKey(
      {
        sourceConnectionKey: "connection-a",
        identityEpochKey: "epoch-1",
        fullPan: pan,
      },
      { panFingerprintKey: key },
    ),
    buildFubonCreditCardAccountIdentityKey(
      {
        sourceConnectionKey: "connection-a",
        identityEpochKey: "epoch-1",
        fullPan: "4111111111111111",
      },
      { panFingerprintKey: key },
    ),
  );
  assert.notEqual(
    buildFubonCreditCardAccountIdentityKey(
      {
        sourceConnectionKey: "connection-a",
        identityEpochKey: "epoch-1",
        fullPan: "4012888888881881",
      },
      { panFingerprintKey: key },
    ),
    fingerprint.fingerprint,
  );
  assert.throws(
    () => normalizeFubonCreditCardPan("4111 1111 1111 1112"),
    (error: unknown) => {
      assert.match(String(error), /invalid/i);
      assert.doesNotMatch(String(error), /4111|1112/);
      return true;
    },
  );

  const panIdentity = {
    sourceConnectionKey: "connection-a",
    identityEpochKey: "epoch-1",
    fullPan: pan,
  };
  const { fullPan: _discardedPan, ...panIdentityWithoutPan } = panIdentity;
  const panCapture = capture();
  panCapture.identity = panIdentity;
  panCapture.statements = [
    {
      ...panCapture.statements[0]!,
      evidence: {
        kind: "issuer-settled-cycle-summary",
        sourceRecordKey: buildFubonCreditCardStatementEvidenceKey(
          panIdentity,
          panCapture.statements[0]!,
          { panFingerprintKey: key },
        ),
        settled: true,
      },
    },
  ];
  const admitted = admitFubonCreditCardCapture(panCapture, {
    panFingerprintKey: key,
  });
  assert.equal(admitted.identity.identityMethod, "pan-hmac");
  assert.equal(admitted.identity.panLast4, "1111");
  assert.equal(admitted.identity.panFingerprintKeyVersion, "test-v1");
  assert.equal("fullPan" in admitted.identity, false);
  assert.equal(JSON.stringify(admitted).includes("4111111111111111"), false);
  assert.throws(
    () => admitFubonCreditCardCapture(panCapture),
    /fingerprint key is unavailable/i,
  );
  assert.equal(admitFubonCreditCardCapture(capture()).identity.identityMethod, "human-attested");
  assert.throws(
    () =>
      admitFubonCreditCardCapture({
        ...capture(),
        identity: {
          ...panIdentityWithoutPan,
          panFingerprint: fingerprint.fingerprint,
          panLast4: fingerprint.last4,
          panFingerprintKeyVersion: fingerprint.keyVersion,
        } as never,
      }),
    /derived from an observed PAN/i,
  );

  const store = createCanonicalSourceStore(":memory:");
  try {
    await commitFubonCreditCardCapture(store, admitted);
    const identityRows = store.db.prepare(
      `SELECT identity_method, pan_fingerprint, pan_last4,
              pan_fingerprint_key_version
       FROM fubon_credit_account_identity_details`,
    ).all() as Array<{
      identity_method?: string;
      pan_fingerprint?: string;
      pan_last4?: string;
      pan_fingerprint_key_version?: string;
    }>;
    assert.deepEqual(identityRows.map((row) => ({ ...row })), [{
      identity_method: "pan-hmac",
      pan_fingerprint: admitted.identity.panFingerprint,
      pan_last4: "1111",
      pan_fingerprint_key_version: "test-v1",
    }]);
    const persisted = JSON.stringify(
      store.db.prepare(
        `SELECT account_no FROM financial_accounts
         UNION ALL SELECT payload_json FROM source_records
         UNION ALL SELECT pan_fingerprint FROM fubon_credit_account_identity_details`,
      ).all(),
    );
    assert.equal(persisted.includes("4111111111111111"), false);
  } finally {
    store.close();
  }
});

test("billing status is independent and excluded from the transaction identity tuple", () => {
  const billed = transaction({ billingStatus: "billed" });
  const unbilled = transaction({ billingStatus: "unbilled" });
  assert.equal(
    buildFubonCreditCardTransactionSourceKey(
      { ...capture().identity, humanAttestedAccountKey: "portfolio-a" },
      billed,
    ),
    buildFubonCreditCardTransactionSourceKey(
      { ...capture().identity, humanAttestedAccountKey: "portfolio-a" },
      unbilled,
    ),
  );
  const admitted = admitFubonCreditCardCapture(capture());
  assert.equal(admitted.transactions[0]?.postingStatus, "posted");
  assert.equal(admitted.transactions[0]?.billingStatus, "billed");
  assert.equal(admitted.transactions[1]?.postingStatus, "posted");
  assert.equal(admitted.transactions[1]?.billingStatus, "unbilled");
});

test("statement identity scopes credit-card transaction source keys", () => {
  const identity = capture().identity;
  const july = transaction({ statementKey: "statement-2026-07", occurrenceIndex: 0 });
  const june = transaction({ statementKey: "statement-2026-06", occurrenceIndex: 0 });
  assert.notEqual(
    buildFubonCreditCardTransactionSourceKey(identity, july),
    buildFubonCreditCardTransactionSourceKey(identity, june),
  );
});

test("posting date and exact sign/direction mapping are total", () => {
  assert.throws(
    () => admitFubonCreditCardCapture(capture({ transactions: [transaction({ postingDate: undefined })] })),
    /posting date/i,
  );
  assert.throws(
    () => admitFubonCreditCardCapture(capture({ transactions: [transaction({ bookedAmount: "-1.00" })] })),
    /non-negative|amount/i,
  );
  assert.throws(
    () => admitFubonCreditCardCapture(capture({ transactions: [transaction({ signedAmount: "-1.00", direction: "inflow" })] })),
    /sign|direction/i,
  );
  assert.throws(
    () => admitFubonCreditCardCapture(capture({ transactions: [transaction({ signedAmount: "0.00" })] })),
    /sign|direction/i,
  );
});

test("full six-period plus unbilled terminal grid evidence is required", () => {
  const admitted = admitFubonCreditCardCapture(capture());
  assert.equal(admitted.scope.completeness.billedPeriods.length, 6);
  assert.ok(
    admitted.scope.completeness.grids.every(
      (grid) => grid.terminalEvidence === "source-declared-total",
    ),
  );
  for (const invalid of [
    { terminalGrids: false },
    { unfiltered: false },
    { rowCountsMatch: false },
    { billedPeriods: ["period-1"] },
    { unbilledIncluded: false },
    { settledSummaryEvidencePresent: false },
  ])
    assert.throws(
      () =>
        admitFubonCreditCardCapture(
          capture({
            scope: {
              ...capture().scope,
              completeness: { ...completeness, ...invalid },
            },
          }),
        ),
      /complete|period|terminal|count|summary|unbilled/i,
    );
  for (const gridOverride of [
    { currentPage: 2 },
    { pageSize: 100 },
    { terminal: false },
    { sourceDeclaredRowCount: 2 },
    { sourceDeclaredScopeRowCount: 0 },
  ]) {
    const grids = completeness.grids.map((grid, index) =>
      index === 0 ? { ...grid, ...gridOverride } : grid,
    );
    assert.throws(
      () =>
        admitFubonCreditCardCapture(
          capture({
            scope: {
              ...capture().scope,
              completeness: { ...completeness, grids },
            },
          }),
        ),
      /terminal|maximum-page|count|evidence/i,
    );
  }
});

test("short first pages are terminal only without fabricated source totals", () => {
  const shortPageCompleteness = {
    ...completeness,
    grids: completeness.grids.map((grid) => {
      const {
        sourceDeclaredRowCount: _sourceDeclaredRowCount,
        sourceDeclaredScopeRowCount: _sourceDeclaredScopeRowCount,
        ...shortPageGrid
      } = grid;
      return {
        ...shortPageGrid,
        terminalEvidence: "short-page" as const,
      };
    }),
  };
  const admitted = admitFubonCreditCardCapture(
    capture({
      scope: {
        ...capture().scope,
        completeness: shortPageCompleteness,
      },
    }),
  );
  assert.ok(
    admitted.scope.completeness.grids.every(
      (grid) =>
        grid.terminalEvidence === "short-page" &&
        !Object.hasOwn(grid, "sourceDeclaredRowCount") &&
        !Object.hasOwn(grid, "sourceDeclaredScopeRowCount"),
    ),
  );

  for (const invalidGrid of [
    { ...admitted.scope.completeness.grids[0]!, capturedRowCount: 2_147_483_647 },
    { ...admitted.scope.completeness.grids[0]!, currentPage: 2 },
    { ...admitted.scope.completeness.grids[0]!, pageSize: 100 },
    {
      ...admitted.scope.completeness.grids[0]!,
      sourceDeclaredRowCount: 1,
    },
  ]) {
    const grids = admitted.scope.completeness.grids.map((grid, index) =>
      index === 0 ? invalidGrid : grid,
    );
    assert.throws(
      () =>
        admitFubonCreditCardCapture(
          capture({
            scope: {
              ...capture().scope,
              completeness: {
                ...shortPageCompleteness,
                grids: grids as never,
              },
            },
          }),
        ),
      /terminal|maximum-page|count|evidence/i,
    );
  }

  const missingDiscriminator = admitted.scope.completeness.grids.map(
    (grid, index) => {
      if (index !== 0) return grid;
      const { terminalEvidence: _terminalEvidence, ...withoutEvidence } = grid;
      return withoutEvidence;
    },
  );
  assert.throws(
    () =>
      admitFubonCreditCardCapture(
        capture({
          scope: {
            ...capture().scope,
            completeness: {
              ...shortPageCompleteness,
              grids: missingDiscriminator as never,
            },
          },
        }),
      ),
    /terminal|maximum-page|evidence/i,
  );
});

test("shared canonical pages retain the short-page proof discriminator", async () => {
  const store = createCanonicalSourceStore(":memory:");
  try {
    ensureFubonCreditCardSchema(store.db);
    const shortPageCompleteness = {
      ...completeness,
      grids: completeness.grids.map((grid) => {
        const {
          sourceDeclaredRowCount: _sourceDeclaredRowCount,
          sourceDeclaredScopeRowCount: _sourceDeclaredScopeRowCount,
          ...shortPageGrid
        } = grid;
        return { ...shortPageGrid, terminalEvidence: "short-page" as const };
      }),
    };
    await commitFubonCreditCardCapture(
      store,
      admitFubonCreditCardCapture(
        capture({
          scope: {
            ...capture().scope,
            completeness: shortPageCompleteness,
          },
        }),
      ),
    );
    const proofKinds = store.db.prepare(
      "SELECT proof_kind FROM capture_scope_pages ORDER BY page_ordinal",
    ).all() as Array<{ proof_kind?: string }>;
    assert.equal(proofKinds.length, 7);
    assert.ok(proofKinds.every((page) => page.proof_kind === "short-page-terminal-grid"));
  } finally {
    store.close();
  }
});

test("only issuer settled-cycle summaries may establish Statements", () => {
  const admitted = admitFubonCreditCardCapture(capture());
  assert.equal(admitted.statements.length, 1);
  for (const evidence of [
    { kind: "query-month" },
    { kind: "filename" },
    { kind: "transaction-rows" },
    { kind: "unbilled-list" },
  ])
    assert.throws(
      () =>
        admitFubonCreditCardCapture(
          capture({
            statements: [
              {
                ...capture().statements[0]!,
                evidence: evidence as never,
              },
            ],
          }),
        ),
      /settled|statement evidence/i,
    );
  assert.throws(
    () =>
      admitFubonCreditCardCapture(
        capture({
          statements: [
            {
              ...capture().statements[0]!,
              transactionSourceKeys: ["row-unbilled-a"],
            },
          ],
        }),
      ),
    /billed|statement/i,
  );
  assert.throws(
    () =>
      admitFubonCreditCardCapture(
        capture({
          statements: [
            {
              ...capture().statements[0]!,
              evidence: {
                ...capture().statements[0]!.evidence,
                sourceRecordKey: "fabricated-summary-marker",
              },
            },
          ],
        }),
      ),
    /scoped|account|cycle|summary evidence/i,
  );
});

test("billed source evidence may remain without settled Statement membership", () => {
  const admitted = admitFubonCreditCardCapture(
    capture({
      transactions: [
        transaction({
          statementKey: undefined,
          sourceScopeKey: "fubon-source-only-period-v2:sha256:period-source-only",
        }),
        transaction({
          sourceRecordKey: "row-unbilled-a",
          consumeDate: "2026-08-20",
          postingDate: "2026-08-21",
          description: "SYNTHETIC TRANSIT",
          bookedAmount: "20.00",
          billingStatus: "unbilled",
          statementKey: undefined,
        }),
      ],
      statements: [],
    }),
  );
  assert.equal(admitted.statements.length, 0);
  assert.equal(admitted.transactions[0]?.billingStatus, "billed");
  assert.equal(admitted.transactions[0]?.statementKey, undefined);
  assert.equal(
    admitted.transactions[0]?.sourceScopeKey,
    "fubon-source-only-period-v2:sha256:period-source-only",
  );
});

test("stable occurrence ordinal admits identical genuine rows and rejects reused identity", () => {
  const admitted = admitFubonCreditCardCapture(repeatedOccurrenceCapture());
  assert.equal(admitted.transactions.length, 3);
  assert.notEqual(admitted.transactions[0]!.sourceKey, admitted.transactions[1]!.sourceKey);
  assert.throws(
    () =>
      admitFubonCreditCardCapture(
        capture({
          transactions: [transaction(), transaction({ sourceRecordKey: "row-purchase-b" })],
        }),
      ),
    /collision|duplicate|identity|occurrence|source order/i,
  );
  for (const transactions of [
    [
      transaction({ sourceRecordKey: "row-purchase-b", occurrenceIndex: 1 }),
      transaction(),
      capture().transactions[1]!,
    ],
    [
      transaction(),
      transaction({ sourceRecordKey: "row-purchase-b", occurrenceIndex: 2 }),
      capture().transactions[1]!,
    ],
  ])
    assert.throws(
      () =>
        admitFubonCreditCardCapture(
          repeatedOccurrenceCapture({ transactions }),
        ),
      /contiguous|observed source order|occurrence/i,
    );
});

test("all instrument roles require explicit source evidence", () => {
  for (const role of ["primary", "supplementary", "virtual", "replacement"] as const) {
    const instrument = {
      ...primaryInstrument,
      role,
      evidence: {
        ...primaryInstrument.evidence,
        sourceRecordKey: "row-purchase-a",
      },
    };
    assert.equal(
      admitFubonCreditCardCapture(capture({ instruments: [instrument] })).instruments[0]!.role,
      role,
    );
  }
  assert.throws(
    () =>
      admitFubonCreditCardCapture(
        capture({
          instruments: [{ ...primaryInstrument, role: "supplementary", evidence: undefined }],
        }),
      ),
    /instrument|supplementary|evidence/i,
  );
  for (const sourceRecordKey of ["", "fabricated-row-key"]) {
    assert.throws(
      () =>
        admitFubonCreditCardCapture(
          capture({
            instruments: [
              {
                ...primaryInstrument,
                evidence: { ...primaryInstrument.evidence, sourceRecordKey },
              },
            ],
          }),
        ),
      /evidence|source record|same capture|instrument/i,
    );
  }
  assert.throws(
    () =>
      admitFubonCreditCardCapture(
        capture({
          transactions: [transaction({ correctionKey: "correction-1" })],
        }),
      ),
    /correction/i,
  );
});

test("similarity cannot create a relation; explicit source linkage is required", () => {
  assert.throws(
    () =>
      admitFubonCreditCardCapture(
        capture({
          relations: [
            {
              kind: "refund_of",
              fromSourceRecordKey: "row-unbilled-a",
              toSourceRecordKey: "row-purchase-a",
              evidence: { kind: "similarity", score: 1 },
            },
          ],
        }),
      ),
    /explicit|linkage|similarity|relation/i,
  );

  const explicit = admitFubonCreditCardCapture(
    capture({
      transactions: [
        transaction(),
        transaction({
          sourceRecordKey: "row-refund-a",
          consumeDate: "2026-08-20",
          postingDate: "2026-08-21",
          direction: "inflow",
          description: "SYNTHETIC REFUND",
          bookedAmount: "20.00",
          billingStatus: "unbilled",
          statementKey: undefined,
        }),
      ],
      relations: [
        {
          kind: "refund_of",
          fromSourceRecordKey: "row-refund-a",
          toSourceRecordKey: "row-purchase-a",
          evidence: {
            kind: "explicit-source-linkage",
            sourceRecordKey: "row-refund-a",
            contractVersion: FUBON_CREDIT_CARD_CONTRACT_VERSION,
          },
        },
      ],
    }),
  );
  assert.equal(explicit.relations.length, 1);

  for (const invalid of [
    {
      ...explicit,
      relations: [
        {
          ...explicit.relations[0]!,
          evidence: {
            kind: "explicit-source-linkage" as const,
            sourceRecordKey: "fabricated-relation-evidence",
            contractVersion: FUBON_CREDIT_CARD_CONTRACT_VERSION,
          },
        },
      ],
    },
    {
      ...explicit,
      relations: [
        {
          ...explicit.relations[0]!,
          evidence: {
            kind: "explicit-source-linkage" as const,
            sourceRecordKey: "row-unbilled-a",
            contractVersion: FUBON_CREDIT_CARD_CONTRACT_VERSION,
          },
        },
      ],
    },
  ]) {
    assert.throws(
      () => admitFubonCreditCardCapture(invalid as never),
      /endpoint|source record|evidence/i,
    );
  }

  assert.throws(
    () =>
      admitFubonCreditCardCapture(
        capture({
          relations: [
            {
              kind: "refund_of",
              fromSourceRecordKey: "row-unbilled-a",
              toSourceRecordKey: "row-purchase-a",
              evidence: {
                kind: "explicit-source-linkage",
                sourceRecordKey: "row-unbilled-a",
                contractVersion: FUBON_CREDIT_CARD_CONTRACT_VERSION,
              },
            },
          ],
        }),
      ),
    /refund|inflow|outflow|direction/i,
  );

  for (const kind of ["pending_to_posted", "unsupported"] as const) {
    assert.throws(
      () =>
        admitFubonCreditCardCapture(
          capture({
            relations: [
              {
                kind: kind as never,
                fromSourceRecordKey: "row-purchase-a",
                toSourceRecordKey: "row-unbilled-a",
                evidence: {
                  kind: "explicit-source-linkage",
                  sourceRecordKey: "row-purchase-a",
                contractVersion: FUBON_CREDIT_CARD_CONTRACT_VERSION,
                },
              },
            ],
          }),
        ),
      /unsupported|pending|posted|relation/i,
    );
  }
});

test("restores the attestation state after the focused event check", () => {
  const manifest = getFubonCreditCardHumanAttestedV1Manifest();
  if (manifest.status === "revoked")
    restoreFubonCreditCardHumanAttestedV1(
      "2026-08-25T03:00:00.000Z",
      "focused check cleanup",
    );
  assert.equal(getFubonCreditCardHumanAttestedV1Manifest().status, "active");
});

test("persistence uses the shared canonical spine and typed credit extensions", async () => {
  const directory = mkdtempSync(join("/tmp", "fubon-credit-card-canonical-"));
  const databasePath = join(directory, "canonical.sqlite");
  const store = createCanonicalSourceStore(databasePath);
  try {
    ensureFubonCreditCardSchema(store.db);
    const first = await commitFubonCreditCardCapture(
      store,
      admitFubonCreditCardCapture(capture()),
    );
    const repeated = await commitFubonCreditCardCapture(
      store,
      admitFubonCreditCardCapture(
        capture({ captureId: "capture-b" }),
      ),
    );
    assert.equal(first.transactionCount, 2);
    assert.equal(repeated.transactionCount, 2);

    const secondAccount = await commitFubonCreditCardCapture(
      store,
      admitFubonCreditCardCapture(
        capture({
          captureId: "capture-c",
          identity: {
            sourceConnectionKey: "connection-a",
            identityEpochKey: "epoch-1",
            humanAttestedAccountKey: "portfolio-b",
          },
        }),
      ),
    );
    assert.notEqual(first.accountId, secondAccount.accountId);

    const roleEvidenceRows = store.db.prepare(
      `SELECT instrument_id, account_id, capture_id, source_record_id
       FROM fubon_credit_instrument_role_evidence ORDER BY rowid`,
    ).all() as Array<{
      instrument_id: Uint8Array;
      account_id: Uint8Array;
      capture_id: Uint8Array;
      source_record_id: Uint8Array;
    }>;
    assert.throws(
      () =>
        store.db.prepare(
          `INSERT INTO fubon_credit_instrument_role_evidence(
            instrument_id, account_id, capture_id, source_record_id
          ) VALUES (?, ?, ?, ?)`,
        ).run(
          roleEvidenceRows[0]!.instrument_id,
          roleEvidenceRows[0]!.account_id,
          roleEvidenceRows.at(-1)!.capture_id,
          roleEvidenceRows.at(-1)!.source_record_id,
        ),
      /crosses capture, account, or instrument scope/i,
    );
    const summaryEvidenceRows = store.db.prepare(
      `SELECT statement_revision_id, account_id, capture_id, evidence_key,
              evidence_source_record_id
       FROM fubon_credit_statement_summary_evidence ORDER BY rowid`,
    ).all() as Array<{
      statement_revision_id: Uint8Array;
      account_id: Uint8Array;
      capture_id: Uint8Array;
      evidence_key: string;
      evidence_source_record_id: Uint8Array;
    }>;
    assert.throws(
      () =>
        store.db.prepare(
          `INSERT INTO fubon_credit_statement_summary_evidence(
            statement_revision_id, account_id, capture_id, evidence_key,
            evidence_source_record_id
          ) VALUES (?, ?, ?, ?, ?)`,
        ).run(
          summaryEvidenceRows[0]!.statement_revision_id,
          summaryEvidenceRows[0]!.account_id,
          summaryEvidenceRows.at(-1)!.capture_id,
          `${summaryEvidenceRows[0]!.evidence_key}:cross-capture`,
          summaryEvidenceRows.at(-1)!.evidence_source_record_id,
        ),
      /crosses capture or account scope/i,
    );

    const count = (table: string): number =>
      Number((store.db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value?: number }).value ?? 0);
    assert.equal(count("financial_accounts"), 2);
    assert.equal(count("source_captures"), 3);
    assert.equal(count("source_records"), 9);
    assert.equal(count("financial_transactions"), 4);
    assert.equal(count("transaction_revisions"), 4);
    assert.equal(count("assertions"), 4);
    assert.equal(count("assertion_provenance"), 6);
    assert.equal(count("fubon_credit_instrument_details"), 2);
    assert.equal(count("fubon_credit_instrument_role_evidence"), 3);
    assert.equal(count("fubon_credit_transaction_details"), 6);
    assert.equal(count("fubon_credit_statement_details"), 2);
    assert.equal(count("fubon_credit_statement_revision_details"), 2);
    assert.equal(count("fubon_credit_statement_membership_details"), 2);
    assert.equal(count("fubon_credit_statement_summary_evidence"), 3);
    assert.equal(count("fubon_credit_account_identity_details"), 2);
    const committedCaptures = store.db.prepare(
      `SELECT authority_route, completeness_rule_version
       FROM source_captures ORDER BY capture_key`,
    ).all() as Array<{
      authority_route?: string;
      completeness_rule_version?: string;
    }>;
    assert.equal(committedCaptures.length, 3);
    assert.ok(
      committedCaptures.every(
        (row) =>
          row.authority_route === FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.authorityRoute &&
          row.completeness_rule_version === FUBON_CREDIT_CARD_CONTRACT_VERSION,
      ),
      "new Fubon captures must persist the v2 route and completeness contract",
    );
    const summarySourceRecords = store.db.prepare(
      `SELECT record_kind, occurrence_key, payload_json
       FROM source_records
       WHERE record_kind = 'fubon-credit-card-statement-summary'`,
    ).all() as Array<{ record_kind?: string; occurrence_key?: string; payload_json?: string }>;
    assert.equal(summarySourceRecords.length, 3);
    assert.ok(summarySourceRecords.every((row) => row.record_kind === "fubon-credit-card-statement-summary"));
    assert.ok(summarySourceRecords.every((row) => row.occurrence_key?.startsWith("sha256:")));
    assert.ok(summarySourceRecords.every((row) => row.payload_json?.includes("statementKey")));
    assert.equal(count("fubon_credit_relation_details"), 0);
    assert.equal(
      count("sqlite_master WHERE type = 'table' AND name = 'fubon_credit_accounts'"),
      0,
    );
    const posted = store.db.prepare(
      `SELECT posting_status, semantic_rule_version, effective_time_rule_version
       FROM transaction_revisions
       WHERE posting_rule_version = 'fubon/credit-card/human-attested-v2'
       ORDER BY revision_id`,
    ).all() as Array<{
      posting_status?: string;
      semantic_rule_version?: string;
      effective_time_rule_version?: string;
    }>;
    assert.equal(posted.length, 4);
    assert.ok(posted.every((row) => row.posting_status === "posted"));
    assert.ok(
      posted.every(
        (row) =>
          row.semantic_rule_version === FUBON_CREDIT_CARD_CONTRACT_VERSION &&
          row.effective_time_rule_version === FUBON_CREDIT_CARD_CONTRACT_VERSION,
      ),
      "new Fubon transaction revisions must pin v2 semantic and effective-time rules",
    );
    const attestedRows = store.db.prepare(
      `SELECT provider_key, sequence_lexeme FROM source_records
       WHERE record_kind = 'fubon-credit-card-transaction'`,
    ).all() as Array<{ provider_key?: string; sequence_lexeme?: string }>;
    assert.ok(
      attestedRows.every(
        (row) =>
          row.provider_key === "human-attested:no-provider-key" &&
          /^observed-source-order:\d+$/.test(row.sequence_lexeme ?? ""),
      ),
    );
  } finally {
    store.close();
  }

});

test("idempotently migrates legacy statement evidence lineage without losing rows", async () => {
  const store = createCanonicalSourceStore(":memory:");
  try {
    store.db.exec(`
CREATE TABLE fubon_credit_statement_summary_evidence (
  statement_revision_id BLOB NOT NULL,
  account_id BLOB NOT NULL,
  capture_id BLOB NOT NULL,
  evidence_key TEXT NOT NULL,
  PRIMARY KEY(statement_revision_id, capture_id),
  UNIQUE(account_id, capture_id, evidence_key)
);
INSERT INTO fubon_credit_statement_summary_evidence(
  statement_revision_id, account_id, capture_id, evidence_key
) VALUES (randomblob(16), randomblob(16), randomblob(16), 'legacy-evidence');
CREATE TRIGGER fubon_credit_summary_evidence_scope_guard
BEFORE INSERT ON fubon_credit_statement_summary_evidence
WHEN 1
BEGIN
  SELECT RAISE(ABORT, 'stale legacy summary evidence trigger');
END;
    `);

    ensureFubonCreditCardSchema(store.db);
    ensureFubonCreditCardSchema(store.db);
    const columns = store.db.prepare(
      "PRAGMA table_info(fubon_credit_statement_summary_evidence)",
    ).all() as Array<{ name?: string }>;
    assert.ok(columns.some((column) => column.name === "evidence_source_record_id"));
    assert.equal(
      Number(
        (
          store.db
            .prepare("SELECT COUNT(*) AS value FROM fubon_credit_statement_summary_evidence")
            .get() as { value?: number }
        ).value ?? 0,
      ),
      1,
    );
    assert.throws(
      () =>
        store.db.prepare(
          `INSERT INTO fubon_credit_statement_summary_evidence(
            statement_revision_id, account_id, capture_id, evidence_key,
            evidence_source_record_id
          ) VALUES (randomblob(16), randomblob(16), randomblob(16), 'missing-lineage', NULL)`,
        ).run(),
      /crosses capture or account scope/i,
    );

    await commitFubonCreditCardCapture(
      store,
      admitFubonCreditCardCapture(capture()),
    );
    const migratedRows = store.db.prepare(
      `SELECT evidence_key, evidence_source_record_id
       FROM fubon_credit_statement_summary_evidence
       ORDER BY rowid`,
    ).all() as Array<{ evidence_key?: string; evidence_source_record_id?: Uint8Array | null }>;
    assert.equal(migratedRows.length, 2);
    assert.equal(migratedRows[0]?.evidence_key, "legacy-evidence");
    assert.equal(migratedRows[0]?.evidence_source_record_id, null);
    assert.equal(migratedRows[1]?.evidence_key?.startsWith("sha256:"), true);
    assert.ok(migratedRows[1]?.evidence_source_record_id);
  } finally {
    store.close();
  }
});

test("extension failure rolls back initial attestation and the shared capture atomically", async () => {
  const directory = mkdtempSync(join("/tmp", "fubon-credit-card-atomic-"));
  const base = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  try {
    await assert.rejects(
      commitFubonCreditCardCapture(
        {
          db: base.db,
          databasePath: base.databasePath,
          commitClock: base.commitClock,
          beforeFubonCreditExtensionCommit: () => {
            throw new Error("injected extension failure");
          },
        },
        admitFubonCreditCardCapture(capture()),
      ),
      /injected extension failure/i,
    );
    const count = (table: string): number =>
      Number(
        (base.db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as {
          value?: number;
        }).value ?? 0,
      );
    assert.equal(count("source_captures"), 0);
    assert.equal(count("source_records"), 0);
    const attestationTable = Number(
      (base.db
        .prepare(
          `SELECT COUNT(*) AS value FROM sqlite_master
           WHERE type = 'table' AND name = 'fubon_credit_card_attestation_events'`,
        )
        .get() as { value?: number }).value ?? 0,
    );
    assert.equal(attestationTable, 0);
  } finally {
    base.close();
  }
});

test("identical occurrences remain distinct while repeated captures add provenance", async () => {
  const directory = mkdtempSync(join("/tmp", "fubon-credit-card-occurrence-"));
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  try {
    await commitFubonCreditCardCapture(
      store,
      admitFubonCreditCardCapture(repeatedOccurrenceCapture()),
    );
    await commitFubonCreditCardCapture(
      store,
      admitFubonCreditCardCapture(
        repeatedOccurrenceCapture({ captureId: "capture-b" }),
      ),
    );
    const count = (table: string): number =>
      Number(
        (store.db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as {
          value?: number;
        }).value ?? 0,
      );
    assert.equal(count("financial_transactions"), 3);
    assert.equal(count("transaction_revisions"), 3);
    assert.equal(count("source_records"), 8);
    assert.equal(count("assertion_provenance"), 6);
  } finally {
    store.close();
  }
});

test("Statement revisions pin billed membership and revision keys cannot be reused", async () => {
  const directory = mkdtempSync(join("/tmp", "fubon-credit-card-statement-"));
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  try {
    await commitFubonCreditCardCapture(
      store,
      admitFubonCreditCardCapture(capture()),
    );
    await assert.rejects(
      commitFubonCreditCardCapture(
        store,
        admitFubonCreditCardCapture(
          repeatedOccurrenceCapture({ captureId: "capture-b" }),
        ),
      ),
      /revision key|membership/i,
    );
    const revised = repeatedOccurrenceCapture({ captureId: "capture-c" });
    revised.statements = [
      { ...revised.statements[0]!, revisionKey: "statement-revision-2" },
    ];
    await commitFubonCreditCardCapture(
      store,
      admitFubonCreditCardCapture(revised),
    );
    const revisionCount = Number(
      (store.db
        .prepare(
          "SELECT COUNT(*) AS value FROM fubon_credit_statement_revision_details",
        )
        .get() as { value?: number }).value ?? 0,
    );
    const membershipCount = Number(
      (store.db
        .prepare(
          "SELECT COUNT(*) AS value FROM fubon_credit_statement_membership_details",
        )
        .get() as { value?: number }).value ?? 0,
    );
    assert.equal(revisionCount, 2);
    assert.equal(membershipCount, 3);
  } finally {
    store.close();
  }
});

test("durable revocation survives reopen until a durable restore event", async () => {
  const directory = mkdtempSync(join("/tmp", "fubon-credit-card-revocation-"));
  const databasePath = join(directory, "canonical.sqlite");
  const first = createCanonicalSourceStore(databasePath);
  try {
    await commitFubonCreditCardCapture(
      first,
      admitFubonCreditCardCapture(capture()),
    );
    revokeFubonCreditCardHumanAttestedV1(
      "2026-08-25T04:00:00.000Z",
      "durable focused revocation",
      first.db,
    );
  } finally {
    first.close();
  }
  restoreFubonCreditCardHumanAttestedV1(
    "2026-08-25T04:01:00.000Z",
    "simulate active code manifest after restart",
  );
  const reopened = createCanonicalSourceStore(databasePath);
  try {
    await assert.rejects(
      commitFubonCreditCardCapture(
        reopened,
        admitFubonCreditCardCapture(capture({ captureId: "capture-b" })),
      ),
      /durable human attestation is revoked/i,
    );
    restoreFubonCreditCardHumanAttestedV1(
      "2026-08-25T04:02:00.000Z",
      "durable focused restore",
      reopened.db,
    );
    await commitFubonCreditCardCapture(
      reopened,
      admitFubonCreditCardCapture(capture({ captureId: "capture-c" })),
    );
  } finally {
    reopened.close();
    if (getFubonCreditCardHumanAttestedV1Manifest().status === "revoked")
      restoreFubonCreditCardHumanAttestedV1(
        "2026-08-25T04:03:00.000Z",
        "focused revocation cleanup",
      );
  }
});

test("generic current, historical, and lineage queries see Fubon after reopen", async () => {
  const directory = mkdtempSync(join("/tmp", "fubon-credit-card-query-"));
  const databasePath = join(directory, "canonical.sqlite");
  const store = createCanonicalSourceStore(databasePath);
  let firstCommitSequence = 0;
  try {
    ensureFubonCreditCardSchema(store.db);
    const first = await commitFubonCreditCardCapture(
      store,
      admitFubonCreditCardCapture(capture()),
    );
    firstCommitSequence = first.commitSequence;
    await commitFubonCreditCardCapture(
      store,
      admitFubonCreditCardCapture(capture({ captureId: "capture-b" })),
    );
    const creditAccount = store.db.prepare(
      `SELECT source_connection_id, identity_epoch_id, created_commit_id
       FROM financial_accounts WHERE stream = 'credit-card' LIMIT 1`,
    ).get() as {
      source_connection_id?: Uint8Array;
      identity_epoch_id?: Uint8Array;
      created_commit_id?: Uint8Array;
    };
    assert.ok(creditAccount.source_connection_id);
    assert.ok(creditAccount.identity_epoch_id);
    assert.ok(creditAccount.created_commit_id);
    store.db.prepare(
      `INSERT INTO financial_accounts(
        account_id, source_connection_id, identity_epoch_id, stream,
        account_no, account_type, currency, created_commit_id
      ) VALUES (?, ?, ?, 'domestic-deposit', ?, 'depository', 'TWD', ?)`,
    ).run(
      randomBytes(16),
      creditAccount.source_connection_id,
      creditAccount.identity_epoch_id,
      "mixed-fubon-domestic-account",
      creditAccount.created_commit_id,
    );

  } finally {
    store.close();
  }
  const query = createCanonicalFinancialQuery(directory, {
    integrationNamespace: "fubon",
    postingRuleVersion: "fubon/credit-card/human-attested-v2",
  });
  const current = await query.current({ kind: "current" });
  assert.equal(current.accounts.length, 1);
  assert.equal(current.accounts[0]?.accountType, "credit");
  assert.equal(current.transactions.length, 2);
  assert.ok(current.transactions.every((transaction) => transaction.timePrecision === "date"));
  assert.ok(
    current.transactions.every(
      (transaction) =>
        transaction.postingRuleVersion === "fubon/credit-card/human-attested-v2",
    ),
  );
  const historical = await query.historical({
    kind: "historical",
    cutoff: {
      kind: "both",
      financialAt: "2026-12-31",
      knowledgeAt: String(firstCommitSequence),
    },
  });
  assert.equal(historical.transactions.length, 2);
  const lineage = await query.lineage({
    kind: "lineage",
    subject: { kind: "transaction", id: current.transactions[0]!.id },
  });
  assert.equal(lineage.entries.length, 1);
  assert.equal(lineage.entries[0]?.provenance.length, 2);
});

console.log("fubon-credit-card.check passed");
