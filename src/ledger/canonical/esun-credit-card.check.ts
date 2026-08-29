import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  ESUN_CREDIT_CARD_CAPTURE_CONTRACT,
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE,
  ESUN_CREDIT_CARD_MAX_PAGE_SIZE,
  admitEsunCreditCardCapture,
  buildEsunCanonicalCreditCardCapture,
  buildEsunCreditCardAccountIdentityKey,
  buildEsunCreditCardTransactionSourceKey,
  commitEsunCreditCardCapture,
  esunNeutralCreditCardCapture,
  type EsunCreditCardCaptureInput,
  type EsunCreditCardSourceRow,
} from "./esun-credit-card.ts";
import {
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  esunCreditCardHumanAttestedIdentityEpochKey,
  getEsunCreditCardHumanAttestedV2Manifest,
  isEsunCreditCardHumanAttestedAccountKey,
  isEsunCreditCardHumanAttestedV2Active,
} from "./esun-credit-card-human-attestation.ts";
import { createCanonicalSourceStore } from "./canonical-source-store.ts";

const identity = {
  sourceConnectionKey: "esun-connection-synthetic",
  identityEpochKey: "esun-epoch-v1",
  humanAttestedAccountKey: "portfolio_synthetic_esun_v1",
} as const;

const grid = {
  kind: "combined" as const,
  currentPage: 1,
  pageSize: ESUN_CREDIT_CARD_MAX_PAGE_SIZE,
  maximumPageSize: ESUN_CREDIT_CARD_MAX_PAGE_SIZE,
  capturedRowCount: 2,
  terminal: true,
};

const billedRow: EsunCreditCardSourceRow = {
  statementPeriod: "2026-07",
  instrumentKey: "esun_instrument_synthetic_projection_1234",
  cardNumber: "****1234",
  consumeDate: "2026/07/15",
  description: "Synthetic Coffee",
  foreignCurrency: "",
  foreignAmount: "",
  paymentCurrency: "TWD",
  twdAmount: "-123.45",
  paymentStatus: "已入帳",
};

const unbilledRow: EsunCreditCardSourceRow = {
  statementPeriod: "unbilled",
  instrumentKey: "esun_instrument_synthetic_projection_1234",
  cardNumber: "****1234",
  consumeDate: "2026/08/15",
  description: "Synthetic Transit",
  foreignCurrency: "",
  foreignAmount: "",
  paymentCurrency: "TWD",
  twdAmount: "20.00",
  paymentStatus: "未入帳",
};

function options(
  overrides: Partial<
    Parameters<typeof buildEsunCanonicalCreditCardCapture>[0]
  > = {},
) {
  return {
    captureId: "capture-esun-a",
    observedAt: "2026-08-26T00:00:00.000Z",
    startDate: "2025-08-26",
    endDate: "2026-08-26",
    identity,
    statementRows: [billedRow],
    unbilledRows: [unbilledRow],
    grid,
    ...overrides,
  };
}

test("E.SUN v2 is a human-attested portfolio route", () => {
  assert.equal(
    ESUN_CREDIT_CARD_CAPTURE_CONTRACT.authorityRoute,
    ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE,
  );
  assert.equal(
    ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.authority,
    "human-attested-primary-cardholder-portfolio",
  );
  assert.equal(ESUN_CREDIT_CARD_CAPTURE_CONTRACT.providerGuaranteed, false);
  assert.equal(
    ESUN_CREDIT_CARD_CAPTURE_CONTRACT.occurrenceProviderGuaranteed,
    false,
  );
  assert.equal(isEsunCreditCardHumanAttestedV2Active(), true);
  assert.equal(
    getEsunCreditCardHumanAttestedV2Manifest(),
    ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  );
  assert.equal(isEsunCreditCardHumanAttestedAccountKey(identity.humanAttestedAccountKey), true);
  assert.equal(isEsunCreditCardHumanAttestedAccountKey("****1234"), false);
  assert.match(esunCreditCardHumanAttestedIdentityEpochKey(), /^sha256:/u);
});

test("complete E.SUN capture produces stable source keys and separate duplicate occurrences", () => {
  const first = buildEsunCanonicalCreditCardCapture(options());
  const second = buildEsunCanonicalCreditCardCapture(
    options({ captureId: "capture-esun-b" }),
  );
  assert.equal(first.scope.completeness.grid.terminal, true);
  assert.equal(first.transactions.length, 2);
  assert.equal(first.instruments.length, 1);
  assert.notEqual(first.captureId, second.captureId);
  assert.deepEqual(
    first.transactions.map((transaction) => transaction.sourceKey),
    second.transactions.map((transaction) => transaction.sourceKey),
  );
  assert.deepEqual(
    first.transactions.map((transaction) => transaction.direction),
    ["outflow", "inflow"],
  );
  assert.deepEqual(
    first.transactions.map((transaction) => transaction.billingStatus),
    ["billed", "unbilled"],
  );

  const duplicate = buildEsunCanonicalCreditCardCapture(
    options({
      statementRows: [billedRow, { ...billedRow }],
      unbilledRows: [],
      grid: { ...grid, capturedRowCount: 2 },
    }),
  );
  assert.equal(duplicate.transactions.length, 2);
  assert.equal(duplicate.transactions[0]?.occurrenceIndex, 0);
  assert.equal(duplicate.transactions[1]?.occurrenceIndex, 1);
  assert.notEqual(
    duplicate.transactions[0]?.sourceKey,
    duplicate.transactions[1]?.sourceKey,
  );
  assert.equal(
    new Set(duplicate.transactions.map((transaction) => transaction.sourceKey)).size,
    2,
  );
});

test("E.SUN billed statement evidence pins only billed source records", () => {
  const capture = buildEsunCanonicalCreditCardCapture(
    options({
      settledPeriods: [
        {
          period: "2026-07",
          cycleStart: "2026-07-01",
          cycleEnd: "2026-07-31",
          issueDate: "2026-07-31",
          dueDate: "2026-08-20",
          balance: "123.45",
          minimumPayment: "12.34",
        },
      ],
    }),
  );
  assert.equal(capture.statements.length, 1);
  assert.equal(capture.statements[0]?.transactionSourceKeys.length, 1);
  assert.equal(
    capture.transactions.find(
      (transaction) => transaction.billingStatus === "unbilled",
    )?.statementKey,
    undefined,
  );
});

test("E.SUN neutral projection preserves opaque identities and billed-only memberships", () => {
  const capture = buildEsunCanonicalCreditCardCapture(
    options({
      settledPeriods: [
        {
          period: "2026-07",
          cycleStart: "2026-07-01",
          cycleEnd: "2026-07-31",
          issueDate: "2026-07-31",
          dueDate: "2026-08-20",
          balance: "123.45",
          minimumPayment: "12.34",
        },
      ],
    }),
  );
  const projected = esunNeutralCreditCardCapture(capture);
  assert.equal(projected.integrationNamespace, "esun");
  assert.deepEqual(projected.identity, {
    accountNaturalKey: capture.identity.accountNaturalKey,
    identityMethod: "human-attested",
  });
  assert.deepEqual(projected.instruments[0], {
    instrumentKey: capture.instruments[0]!.instrumentKey,
    cardMask: capture.instruments[0]!.cardMask,
    role: "primary",
    evidence: {
      sourceRecordKey: capture.transactions[0]!.sourceKey,
    },
  });
  assert.deepEqual(
    projected.transactions.map(({ sourceRecordKey, sourceKey, billingStatus }) => ({
      sourceRecordKey,
      sourceKey,
      billingStatus,
    })),
    capture.transactions.map(({ sourceKey, billingStatus }) => ({
      sourceRecordKey: sourceKey,
      sourceKey,
      billingStatus,
    })),
  );
  assert.equal(projected.statements.length, 1);
  assert.deepEqual(
    projected.statements[0]!.transactionSourceKeys,
    capture.statements[0]!.transactionSourceKeys.map((sourceRecordKey) =>
      capture.transactions.find((transaction) => transaction.sourceRecordKey === sourceRecordKey)!.sourceKey,
    ),
  );
  const billingBySourceRecordKey = new Map<string, "billed" | "unbilled">(
    capture.transactions.map((transaction) => [
      transaction.sourceKey,
      transaction.billingStatus,
    ]),
  );
  assert.ok(
    projected.statements.every((statement) =>
      statement.transactionSourceKeys.every(
        (key) => billingBySourceRecordKey.get(key) === "billed",
      ),
    ),
  );
});

test("E.SUN commit materializes the shared spine and neutral billed statement extensions", async () => {
  const directory = mkdtempSync(join("/tmp", "esun-credit-card-canonical-"));
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  try {
    const admitted = buildEsunCanonicalCreditCardCapture(
      options({
        settledPeriods: [{
          period: "2026-07",
          cycleStart: "2026-07-01",
          cycleEnd: "2026-07-31",
          issueDate: "2026-07-31",
          dueDate: "2026-08-20",
          balance: "123.45",
          minimumPayment: "12.34",
        }],
      }),
    );
    const committed = await commitEsunCreditCardCapture(store, admitted);
    assert.equal(committed.transactionCount, 2);
    assert.equal(committed.statementCount, 1);
    assert.match(committed.accountId, /^[0-9a-f]{32}$/u);
    const count = (table: string): number =>
      Number((store.db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as {
        value?: number;
      }).value ?? 0);
    assert.equal(count("financial_accounts"), 1);
    assert.equal(count("source_captures"), 1);
    assert.equal(count("financial_transactions"), 2);
    assert.equal(count("canonical_credit_card_account_identities"), 1);
    assert.equal(count("canonical_credit_card_instruments"), 1);
    assert.equal(count("canonical_credit_card_transaction_details"), 2);
    assert.equal(count("canonical_credit_card_statements"), 1);
    assert.equal(count("canonical_credit_card_statement_revisions"), 1);
    assert.equal(count("canonical_credit_card_statement_memberships"), 1);
    assert.equal(count("canonical_credit_card_statement_summary_evidence"), 1);
    const billedMembership = store.db.prepare(`
      SELECT detail.billing_status
      FROM canonical_credit_card_statement_memberships membership
      JOIN canonical_credit_card_transaction_details detail
        ON detail.transaction_id = membership.transaction_id
      WHERE detail.billing_status = 'billed'
    `).get() as { billing_status?: string } | undefined;
    assert.equal(billedMembership?.billing_status, "billed");
    const unbilledMembership = store.db.prepare(`
      SELECT detail.billing_status
      FROM canonical_credit_card_statement_memberships membership
      JOIN canonical_credit_card_transaction_details detail
        ON detail.transaction_id = membership.transaction_id
      WHERE detail.billing_status = 'unbilled'
    `).get() as { billing_status?: string } | undefined;
    assert.equal(unbilledMembership, undefined);
  } finally {
    store.close();
  }
});

test("E.SUN repeated captures retain one account/instrument authority and add provenance", async () => {
  const directory = mkdtempSync(join("/tmp", "esun-credit-card-repeat-"));
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  try {
    const settledPeriods = [{
      period: "2026-07",
      cycleStart: "2026-07-01",
      cycleEnd: "2026-07-31",
      issueDate: "2026-07-31",
      dueDate: "2026-08-20",
      balance: "123.45",
      minimumPayment: "12.34",
    }];
    const first = await commitEsunCreditCardCapture(
      store,
      buildEsunCanonicalCreditCardCapture(options({ settledPeriods })),
    );
    const repeated = await commitEsunCreditCardCapture(
      store,
      buildEsunCanonicalCreditCardCapture(
        options({ captureId: "capture-esun-b", settledPeriods }),
      ),
    );
    assert.equal(repeated.accountId, first.accountId);
    const count = (table: string): number =>
      Number((store.db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as {
        value?: number;
      }).value ?? 0);
    assert.equal(count("financial_accounts"), 1);
    assert.equal(count("financial_transactions"), 2);
    assert.equal(count("canonical_credit_card_account_identities"), 1);
    assert.equal(count("canonical_credit_card_instruments"), 1);
    assert.equal(count("canonical_credit_card_instrument_evidence"), 2);
    assert.equal(count("canonical_credit_card_transaction_details"), 2);
    assert.equal(count("assertion_provenance"), 4);
    assert.equal(count("canonical_credit_card_statement_summary_evidence"), 1);
  } finally {
    store.close();
  }
});

test("E.SUN extension failure rolls back the shared capture and initial attestation", async () => {
  const directory = mkdtempSync(join("/tmp", "esun-credit-card-atomic-"));
  const base = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  try {
    await assert.rejects(
      commitEsunCreditCardCapture(
        {
          db: base.db,
          databasePath: base.databasePath,
          commitClock: base.commitClock,
          beforeEsunCreditExtensionCommit: () => {
            throw new Error("injected E.SUN extension failure");
          },
        },
        buildEsunCanonicalCreditCardCapture(options()),
      ),
      /injected E\.SUN extension failure/i,
    );
    const count = (table: string): number =>
      Number((base.db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as {
        value?: number;
      }).value ?? 0);
    assert.equal(count("source_captures"), 0);
    assert.equal(count("source_records"), 0);
    assert.equal(
      Number((base.db.prepare(`
        SELECT COUNT(*) AS value FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'canonical_credit_card_account_identities',
          'canonical_credit_card_instruments',
          'canonical_credit_card_transaction_details',
          'canonical_credit_card_statements',
          'esun_credit_card_attestation_events'
        )
      `).get() as { value?: number }).value ?? 0),
      0,
    );
  } finally {
    base.close();
  }
});

test("partial, non-terminal, ambiguous, status, and sign-conflict captures fail closed", () => {
  assert.throws(
    () =>
      buildEsunCanonicalCreditCardCapture(
        options({
          grid: { ...grid, pageSize: 100, maximumPageSize: 100 },
        }),
      ),
    /complete terminal maximum-size grid/i,
  );
  assert.throws(
    () =>
      buildEsunCanonicalCreditCardCapture(
        options({ grid: { ...grid, terminal: false } }),
      ),
    /complete terminal maximum-size grid/i,
  );
  assert.throws(
    () =>
      buildEsunCanonicalCreditCardCapture(
        options({
          statementRows: [
            {
              ...billedRow,
              cardNumber: ["4111", "1111", "1111", "1111"].join(""),
            },
          ],
          unbilledRows: [],
          grid: { ...grid, capturedRowCount: 1 },
        }),
      ),
    /raw card numbers are rejected/i,
  );
  assert.throws(
    () =>
      buildEsunCanonicalCreditCardCapture(
        options({
          statementRows: [billedRow],
          unbilledRows: [{ ...unbilledRow, cardNumber: "****9876" }],
        }),
      ),
    /projected instrument identity conflicts/i,
  );
  assert.throws(
    () =>
      buildEsunCanonicalCreditCardCapture(
        options({
          settledPeriods: [{
            period: "2026-07",
            cycleStart: "2026-07-01",
            cycleEnd: "2026-07-31",
            issueDate: "2026-08-01",
            dueDate: "2026-08-20",
            balance: "123.45",
            minimumPayment: "12.34",
          }],
        }),
      ),
    /cycle or billing dates are invalid/i,
  );
  assert.throws(
    () =>
      buildEsunCanonicalCreditCardCapture(
        options({
          settledPeriods: [{
            period: "2026-07",
            cycleStart: "2026-07-01",
            cycleEnd: "2026-07-31",
            issueDate: "2026-07-31",
            dueDate: "2026-08-20",
            balance: "123.45",
          }],
        }),
      ),
    /minimum-payment evidence/i,
  );
  assert.throws(
    () =>
      buildEsunCanonicalCreditCardCapture(
        options({
          statementRows: [{ ...billedRow, paymentStatus: "未知" }],
          unbilledRows: [],
          grid: { ...grid, capturedRowCount: 1 },
        }),
      ),
    /payment status is unsupported/i,
  );

  const valid = buildEsunCanonicalCreditCardCapture(options());
  const signConflict = structuredClone(valid) as unknown as EsunCreditCardCaptureInput;
  signConflict.transactions = [
    { ...signConflict.transactions[0]!, direction: "inflow" },
    signConflict.transactions[1]!,
  ];
  assert.throws(
    () => admitEsunCreditCardCapture(signConflict),
    /signed amount conflicts with transaction direction/i,
  );
});

test("account and transaction identity never include capture IDs or raw card numbers", () => {
  const first = buildEsunCreditCardAccountIdentityKey(identity);
  const second = buildEsunCreditCardAccountIdentityKey({
    ...identity,
    sourceConnectionKey: "esun-connection-other",
  });
  assert.match(first, /^sha256:/u);
  assert.notEqual(first, second);
  const key = buildEsunCreditCardTransactionSourceKey(identity, {
    instrumentKey: "instrument-synthetic",
    consumeDate: "2026-08-01",
    postingDate: "2026-08-01",
    direction: "outflow",
    bookedAmount: "10.00",
    bookedCurrency: "TWD",
    signedAmount: "-10.00",
    foreignCurrency: null,
    foreignAmount: null,
    description: "Synthetic",
    billingStatus: "unbilled",
    statementKey: undefined,
    occurrenceIndex: 0,
  });
  assert.match(key, /^sha256:/u);
  assert.doesNotMatch(key, /capture-esun|4111111111111111/iu);
});
