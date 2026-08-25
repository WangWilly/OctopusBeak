import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import {
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
  getFubonCreditCardHumanAttestedV1Manifest,
  restoreFubonCreditCardHumanAttestedV1,
} from "./fubon-credit-card-human-attestation.ts";
import {
  FUBON_CREDIT_CARD_CAPTURE_CONTRACT,
  admitFubonCreditCardCapture,
  buildFubonCreditCardAccountIdentityKey,
  buildFubonCreditCardTransactionSourceKey,
  type FubonCreditCardCaptureInput,
  type FubonCreditCardTransactionInput,
} from "./fubon-credit-card.ts";
import { createCanonicalSourceStore } from "./canonical-source-store.ts";
import {
  commitFubonCreditCardCapture,
  ensureFubonCreditCardSchema,
  queryFubonCreditCardCurrent,
  queryFubonCreditCardHistorical,
  queryFubonCreditCardLineage,
} from "./fubon-credit-card.ts";

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
} as const;

const primaryInstrument = {
  instrumentKey: "instrument-primary-a",
  cardMask: "****1234",
  productName: "SYNTHETIC PLATINUM",
  role: "primary" as const,
};

function transaction(
  overrides: Partial<FubonCreditCardTransactionInput> = {},
): FubonCreditCardTransactionInput {
  return {
    sourceRecordKey: "row-purchase-a",
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
  return {
    captureId: "capture-a",
    identity: {
      sourceConnectionKey: "connection-a",
      identityEpochKey: "epoch-1",
      humanAttestedAccountKey: "portfolio-a",
    },
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
          sourceRecordKey: "summary-2026-07",
          settled: true,
        },
      },
    ],
    relations: [],
    ...overrides,
  };
}

test("Fubon v1 contract is human-attested and keeps cards subordinate to an opaque account", () => {
  assert.equal(FUBON_CREDIT_CARD_CAPTURE_CONTRACT.authorityRoute, FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute);
  assert.equal(FUBON_CREDIT_CARD_CAPTURE_CONTRACT.providerGuaranteed, false);
  assert.equal(FUBON_CREDIT_CARD_CAPTURE_CONTRACT.occurrenceProviderGuaranteed, false);

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
  assert.match(buildFubonCreditCardAccountIdentityKey(left.identity), /credit-card:portfolio-a$/);
  assert.equal(admitFubonCreditCardCapture(left).identity.accountType, "credit");
  assert.equal(admitFubonCreditCardCapture(left).identity.accountSubtype, "credit_card");
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
});

test("duplicate source identity collides within one capture and unsupported card semantics fail closed", () => {
  assert.throws(
    () =>
      admitFubonCreditCardCapture(
        capture({
          transactions: [transaction(), transaction({ sourceRecordKey: "row-purchase-b" })],
        }),
      ),
    /collision|duplicate|identity/i,
  );
  assert.throws(
    () =>
      admitFubonCreditCardCapture(
        capture({
          instruments: [{ ...primaryInstrument, role: "supplementary" }],
        }),
      ),
    /instrument|supplementary|evidence/i,
  );
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
      relations: [
        {
          kind: "refund_of",
          fromSourceRecordKey: "row-unbilled-a",
          toSourceRecordKey: "row-purchase-a",
          evidence: {
            kind: "explicit-source-linkage",
            sourceRecordKey: "relation-1",
            contractVersion: "fubon/credit-card/human-attested-v1",
          },
        },
      ],
    }),
  );
  assert.equal(explicit.relations.length, 1);
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

test("persistence keeps one authority, pins statement membership, and records provenance", async () => {
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

    const count = (table: string): number =>
      Number((store.db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value?: number }).value ?? 0);
    assert.equal(count("fubon_credit_accounts"), 2);
    assert.equal(count("fubon_credit_card_instruments"), 2);
    assert.equal(count("fubon_credit_card_captures"), 3);
    assert.equal(count("fubon_credit_card_transactions"), 4);
    assert.equal(count("fubon_credit_card_transaction_revisions"), 4);
    assert.equal(count("fubon_credit_card_current_transactions"), 4);
    assert.equal(count("fubon_credit_card_transaction_provenance"), 6);
    assert.equal(count("fubon_credit_card_billing_observations"), 6);
    assert.equal(count("fubon_credit_statements"), 2);
    assert.equal(count("fubon_credit_statement_revisions"), 2);
    assert.equal(count("fubon_credit_statement_memberships"), 2);
    assert.equal(count("fubon_credit_statement_provenance"), 3);
    assert.equal(count("fubon_credit_transaction_relations"), 0);
    const accountFlags = store.db.prepare(
      `SELECT provider_guaranteed, occurrence_provider_guaranteed
       FROM fubon_credit_accounts ORDER BY account_natural_key`,
    ).all() as Array<{ provider_guaranteed?: number; occurrence_provider_guaranteed?: number }>;
    assert.deepEqual(accountFlags.map((row) => ({ ...row })), [
      { provider_guaranteed: 0, occurrence_provider_guaranteed: 0 },
      { provider_guaranteed: 0, occurrence_provider_guaranteed: 0 },
    ]);
    const posted = store.db.prepare(
      `SELECT posting_status FROM fubon_credit_card_transaction_revisions
       ORDER BY revision_id`,
    ).all() as Array<{ posting_status?: string }>;
    assert.equal(posted.length, 4);
    assert.ok(posted.every((row) => row.posting_status === "posted"));
  } finally {
    store.close();
  }

});

test("billed-to-unbilled observation and statement correction preserve old membership", async () => {
  const store = createCanonicalSourceStore(":memory:");
  try {
    ensureFubonCreditCardSchema(store.db);
    const firstCapture = capture();
    const first = await commitFubonCreditCardCapture(
      store,
      admitFubonCreditCardCapture(firstCapture),
    );
    const correctedRows = [
      transaction({
        bookedAmount: "125.45",
        correctionKey: "correction-a",
        correctionEvidence: {
          kind: "explicit-source-correction",
          sourceRecordKey: "correction-source-a",
          contractVersion: "fubon/credit-card/human-attested-v1",
        },
      }),
      transaction({
        sourceRecordKey: "row-unbilled-a",
        consumeDate: "2026-08-20",
        postingDate: "2026-08-21",
        description: "SYNTHETIC TRANSIT",
        bookedAmount: "20.00",
        billingStatus: "billed",
        statementKey: "statement-2026-07",
      }),
    ];
    const second = await commitFubonCreditCardCapture(
      store,
      admitFubonCreditCardCapture(
        capture({
          captureId: "capture-correction",
          transactions: correctedRows,
          scope: {
            ...firstCapture.scope,
            completeness: {
              ...completeness,
              periodRowCounts: [2, 0, 0, 0, 0, 0],
              unbilledRowCount: 0,
              recordCount: 2,
            },
          },
          statements: [
            {
              ...firstCapture.statements[0]!,
              revisionKey: "statement-revision-2",
              balance: "145.45",
              transactionSourceKeys: ["row-purchase-a", "row-unbilled-a"],
            },
          ],
        }),
      ),
    );
    assert.ok(second.commitSequence > first.commitSequence);
    const firstTransaction = store.db.prepare(
      `SELECT transaction_id FROM fubon_credit_card_source_records
       WHERE capture_id = ? AND source_record_key = ?`,
    ).get(firstCapture.captureId, "row-purchase-a") as { transaction_id?: Uint8Array } | undefined;
    assert.ok(firstTransaction?.transaction_id);
    const currentAmount = store.db.prepare(
      `SELECT r.booked_coefficient, r.booked_scale
       FROM fubon_credit_card_current_transactions c
       JOIN fubon_credit_card_transaction_revisions r ON r.revision_id = c.revision_id
       WHERE c.transaction_id = ?`,
    ).get(firstTransaction.transaction_id) as { booked_coefficient?: string; booked_scale?: number } | undefined;
    assert.equal(currentAmount?.booked_coefficient, "12545");
    assert.equal(Number(currentAmount?.booked_scale), 2);
    const unbilledTransaction = store.db.prepare(
      `SELECT transaction_id FROM fubon_credit_card_source_records
       WHERE capture_id = ? AND source_record_key = ?`,
    ).get("capture-correction", "row-unbilled-a") as { transaction_id?: Uint8Array } | undefined;
    assert.ok(unbilledTransaction?.transaction_id);
    const billing = store.db.prepare(
      `SELECT billing_status FROM fubon_credit_card_billing_observations
       WHERE transaction_id = ? ORDER BY commit_sequence DESC LIMIT 1`,
    ).get(unbilledTransaction.transaction_id) as { billing_status?: string } | undefined;
    assert.equal(billing?.billing_status, "billed");
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS value FROM fubon_credit_statement_revisions").get() as { value?: number }).value ?? 0),
      2,
    );
    const latestStatement = store.db.prepare(
      `SELECT balance_coefficient, balance_scale FROM fubon_credit_statement_revisions
       ORDER BY revision_number DESC LIMIT 1`,
    ).get() as { balance_coefficient?: string; balance_scale?: number } | undefined;
    assert.equal(latestStatement?.balance_coefficient, "14545");
    assert.equal(Number(latestStatement?.balance_scale), 2);

    const oldMembership = store.db.prepare(
      `SELECT m.transaction_revision_id FROM fubon_credit_statement_memberships m
       JOIN fubon_credit_statement_revisions s ON s.statement_revision_id = m.statement_revision_id
       WHERE s.revision_key = ? AND m.source_record_key = ?`,
    ).get("statement-revision-1", "row-purchase-a") as { transaction_revision_id?: Uint8Array } | undefined;
    const newMembership = store.db.prepare(
      `SELECT m.transaction_revision_id FROM fubon_credit_statement_memberships m
       JOIN fubon_credit_statement_revisions s ON s.statement_revision_id = m.statement_revision_id
       WHERE s.revision_key = ? AND m.source_record_key = ?`,
    ).get("statement-revision-2", "row-purchase-a") as { transaction_revision_id?: Uint8Array } | undefined;
    assert.ok(oldMembership?.transaction_revision_id);
    assert.ok(newMembership?.transaction_revision_id);
    assert.notDeepEqual(oldMembership.transaction_revision_id, newMembership.transaction_revision_id);
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS value FROM fubon_credit_statement_memberships").get() as { value?: number }).value ?? 0),
      3,
    );
  } finally {
    store.close();
  }
});

test("typed current, historical, and lineage queries survive canonical reopen", async () => {
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

    const current = queryFubonCreditCardCurrent(store);
    assert.equal(current.status, "canonical-live");
    assert.equal(current.kind, "current");
    assert.equal(current.accounts.length, 1);
    assert.equal(current.accounts[0]?.instruments.length, 1);
    assert.equal(current.accounts[0]?.transactions.length, 2);
    assert.equal(current.accounts[0]?.transactions[0]?.bookedAmount, "123.45");
    assert.equal(current.accounts[0]?.transactions[0]?.billingStatus, "billed");
    assert.equal(current.accounts[0]?.transactions[1]?.billingStatus, "unbilled");
    assert.equal(current.accounts[0]?.transactions[0]?.providerGuaranteed, false);
    assert.equal(current.accounts[0]?.transactions[0]?.occurrenceProviderGuaranteed, false);
    assert.equal(current.accounts[0]?.statements[0]?.currentRevision?.balance, "123.45");
    assert.equal(current.accounts[0]?.statements[0]?.revisions.length, 1);
    assert.equal(current.provenanceCount, 6);

    const historical = queryFubonCreditCardHistorical(store, {
      knowledgeAt: firstCommitSequence,
    });
    assert.equal(historical.status, "canonical-live");
    assert.equal(historical.kind, "historical");
    assert.equal(historical.knowledgeAt, firstCommitSequence);
    assert.equal(historical.accounts.length, 1);
    assert.equal(historical.accounts[0]?.transactions.length, 2);
    assert.equal(historical.accounts[0]?.statements[0]?.revisions.length, 1);
    assert.equal(historical.provenanceCount, 3);

    const lineage = queryFubonCreditCardLineage(store, {
      accountNaturalKey: current.accounts[0]!.accountNaturalKey,
    });
    assert.equal(lineage.status, "canonical-live");
    assert.equal(lineage.kind, "lineage");
    assert.equal(lineage.captures.length, 2);
    assert.equal(lineage.transactions.length, 2);
    assert.equal(lineage.provenance.length, 4);
    assert.equal(lineage.statementMemberships.length, 1);
    assert.equal(lineage.relations.length, 0);
  } finally {
    store.close();
  }

  const reopened = createCanonicalSourceStore(databasePath);
  try {
    const current = queryFubonCreditCardCurrent(reopened);
    assert.equal(current.accounts.length, 1);
    assert.equal(current.accounts[0]?.transactions.length, 2);
    assert.equal(current.provenanceCount, 6);
  } finally {
    reopened.close();
  }
});

test("reopen rejects a Fubon-labelled commit without an exact durable credit capture", () => {
  const directory = mkdtempSync(join("/tmp", "fubon-credit-card-invalid-reopen-"));
  const databasePath = join(directory, "canonical.sqlite");
  const store = createCanonicalSourceStore(databasePath);
  try {
    ensureFubonCreditCardSchema(store.db);
    const commitId = randomBytes(16);
    store.db.prepare(
      `INSERT INTO canonical_commits(
        commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind
      ) VALUES (?, 1, 1, 'fubon/credit-card/human-attested-v1', 'source_capture')`,
    ).run(commitId);
    store.db.prepare(
      `INSERT INTO source_authority_routes(
        authority_route, integration_namespace, stream, contract_version, created_commit_id
      ) VALUES (
        'fubon/credit-card/human-attested-v1', 'fubon', 'credit-card',
        'fubon/credit-card/human-attested-v1', ?
      )`,
    ).run(commitId);
  } finally {
    store.close();
  }
  assert.throws(
    () => createCanonicalSourceStore(databasePath),
    /without durable source provenance evidence/i,
  );
});

console.log("fubon-credit-card.check passed");
