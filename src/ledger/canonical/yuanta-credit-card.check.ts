import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import {
  YUANTA_CREDIT_CARD_CAPTURE_CONTRACT,
  admitYuantaCreditCardCapture,
  buildYuantaCanonicalCreditCardCapture,
  buildYuantaCreditCardAccountIdentityKey,
  buildYuantaCreditCardTransactionSourceKey,
  commitYuantaCreditCardCapture,
  yuantaNeutralCreditCardCapture,
  type YuantaCreditCardCaptureInput,
  type YuantaCreditCardSourceRow,
  type YuantaCreditCardStatementSummary,
} from "./yuanta-credit-card.ts";
import { createCanonicalSourceStore } from "./canonical-source-store.ts";
import {
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
  getYuantaCreditCardHumanAttestedV1Manifest,
  isYuantaCreditCardHumanAttestedV1Active,
  restoreYuantaCreditCardHumanAttestedV1,
  revokeYuantaCreditCardHumanAttestedV1,
} from "./yuanta-credit-card-human-attestation.ts";

const identity = {
  sourceConnectionKey: "yuanta-connection-synthetic",
  identityEpochKey: "yuanta-credit-card-v1",
  humanAttestedAccountKey: "portfolio_synthetic_yuanta_account",
} as const;

const periods = [
  "115/01",
  "115/02",
  "115/03",
  "115/04",
  "115/05",
  "115/06",
] as const;

const primaryInstrumentKey = `yuanta_instrument_${"A".repeat(43)}`;

function row(
  period: string | null,
  overrides: Partial<YuantaCreditCardSourceRow> = {},
): YuantaCreditCardSourceRow {
  const day = period ? String(periods.indexOf(period as (typeof periods)[number]) + 2).padStart(2, "0") : "20";
  return {
    creditCardNo: "****1234",
    creditCardName: "SYNTHETIC PRIMARY CARD",
    consumeDate: `2026-0${period ? periods.indexOf(period as (typeof periods)[number]) + 1 : 7}-${day}`,
    postedDate: `2026-0${period ? periods.indexOf(period as (typeof periods)[number]) + 1 : 7}-${day}`,
    description: period ? `SYNTHETIC BILLED ${period}` : "SYNTHETIC UNBILLED",
    countryCurrency: "台灣/TWD",
    foreignExchangeDate: "",
    foreignAmount: "",
    twdAmount: "100.00",
    paymentStatus: period ? "已繳" : "",
    period,
    instrumentKey: primaryInstrumentKey,
    ...overrides,
  };
}

function options(
  overrides: Partial<Parameters<typeof buildYuantaCanonicalCreditCardCapture>[0]> = {},
) {
  return {
    captureId: "capture-a",
    observedAt: "2026-08-26T12:00:00+08:00",
    identity,
    billedPeriods: periods,
    billedRows: periods.map((period) => row(period)),
    unbilledRows: [
      row(null, { consumeDate: "2026-07-20", postedDate: "2026-07-21" }),
      row(null, { consumeDate: "2026-07-21", postedDate: "2026-07-22", description: "SYNTHETIC UNBILLED 2" }),
      row(null, { consumeDate: "2026-07-22", postedDate: "2026-07-23", description: "SYNTHETIC UNBILLED 3" }),
      row(null, { consumeDate: "2026-07-23", postedDate: "2026-07-24", description: "SYNTHETIC UNBILLED 4" }),
    ],
    terminalPages: [true, true, true, true, true, true, true],
    ...overrides,
  };
}

function settledSummaries(): YuantaCreditCardStatementSummary[] {
  return periods.map((period, index) => {
    const month = String(index + 1).padStart(2, "0");
    return {
      period,
      cycleStart: `2026-${month}-01`,
      cycleEnd: `2026-${month}-20`,
      issueDate: `2026-${month}-21`,
      dueDate: `2026-${month}-25`,
      balance: "100.00",
      minimumPayment: "10.00",
    };
  });
}

test("Yuanta credit-card v1 is a human-attested portfolio contract", () => {
  assert.equal(
    YUANTA_CREDIT_CARD_CAPTURE_CONTRACT.authorityRoute,
    YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute,
  );
  assert.equal(YUANTA_CREDIT_CARD_CAPTURE_CONTRACT.providerGuaranteed, false);
  assert.equal(
    YUANTA_CREDIT_CARD_CAPTURE_CONTRACT.occurrenceProviderGuaranteed,
    false,
  );
  assert.equal(
    getYuantaCreditCardHumanAttestedV1Manifest().authority,
    "human-attested-primary-cardholder-portfolio",
  );
  assert.equal(isYuantaCreditCardHumanAttestedV1Active(), true);
  assert.match(
    buildYuantaCreditCardAccountIdentityKey(identity),
    /^sha256:/u,
  );
});

test("complete six billed months plus unbilled rows do not invent statements", () => {
  const capture = buildYuantaCanonicalCreditCardCapture(options());
  assert.equal(capture.identity.accountType, "credit");
  assert.equal(capture.identity.accountSubtype, "credit_card");
  assert.equal(capture.instruments.length, 1);
  assert.equal(capture.instruments[0]?.cardMask, "****1234");
  assert.equal(capture.transactions.length, 10);
  assert.equal(capture.statements.length, 0);
  assert.equal(capture.scope.completeness.settledSummaryEvidencePresent, false);
  assert.equal(
    capture.transactions.filter((transaction) => transaction.billingStatus === "billed").length,
    6,
  );
  assert.equal(
    capture.transactions.filter((transaction) => transaction.billingStatus === "unbilled").length,
    4,
  );
  assert.ok(
    capture.transactions
      .filter((transaction) => transaction.billingStatus === "billed")
      .every((transaction) => transaction.statementKey === undefined),
  );
  assert.ok(
    capture.transactions
      .filter((transaction) => transaction.billingStatus === "unbilled")
      .every((transaction) => transaction.statementKey === undefined),
  );
  assert.equal(capture.scope.completeness.grids.length, 7);
  assert.ok(capture.scope.completeness.grids.every((grid) => grid.terminal));
});

test("only explicit valid summaries create settled statements and memberships", () => {
  const summaries = settledSummaries();
  const capture = buildYuantaCanonicalCreditCardCapture(
    options({ statementSummaries: summaries }),
  );
  assert.equal(capture.statements.length, summaries.length);
  assert.equal(capture.scope.completeness.settledSummaryEvidencePresent, true);
  assert.equal(
    capture.transactions.filter(
      (transaction) => transaction.billingStatus === "billed" && transaction.statementKey,
    ).length,
    6,
  );
  assert.ok(
    capture.statements.every((statement) =>
      statement.transactionSourceKeys.every((sourceRecordKey) =>
        capture.transactions.some(
          (transaction) =>
            transaction.sourceRecordKey === sourceRecordKey &&
            transaction.billingStatus === "billed" &&
            transaction.statementKey === statement.statementKey,
        ),
      ),
    ),
  );
  assert.ok(capture.statements.every((statement) => statement.balance.coefficient === "10000"));
});

test("a partial summary set only creates the supplied settled statements", () => {
  const [summary] = settledSummaries();
  const capture = buildYuantaCanonicalCreditCardCapture(
    options({ statementSummaries: [summary!] }),
  );
  assert.equal(capture.statements.length, 1);
  assert.equal(capture.statements[0]?.balance.coefficient, "10000");
  assert.equal(
    capture.transactions.filter(
      (transaction) => transaction.billingStatus === "billed" && transaction.statementKey,
    ).length,
    1,
  );
  assert.equal(
    capture.transactions.filter(
      (transaction) => transaction.billingStatus === "billed" && !transaction.statementKey,
    ).length,
    5,
  );
});

test("admitted captures map to neutral extension keys and pinned memberships", () => {
  const capture = buildYuantaCanonicalCreditCardCapture(options());
  const neutral = yuantaNeutralCreditCardCapture(capture);
  const sourceKeyBySourceRecordKey = new Map(
    capture.transactions.map((transaction) => [
      transaction.sourceRecordKey,
      transaction.sourceKey,
    ]),
  );

  assert.equal(neutral.integrationNamespace, "yuanta");
  assert.deepEqual(neutral.identity, {
    accountNaturalKey: capture.identity.accountNaturalKey,
    identityMethod: "human-attested",
  });
  assert.equal(neutral.instruments.length, capture.instruments.length);
  assert.equal(
    neutral.instruments[0]?.evidence.sourceRecordKey,
    sourceKeyBySourceRecordKey.get(capture.instruments[0]!.evidence.sourceRecordKey),
  );
  assert.deepEqual(
    neutral.transactions.map((transaction) => transaction.sourceRecordKey),
    capture.transactions.map((transaction) => transaction.sourceKey),
  );
  assert.deepEqual(
    neutral.transactions.map((transaction) => transaction.sourceKey),
    capture.transactions.map((transaction) => transaction.sourceKey),
  );
  assert.deepEqual(
    neutral.statements.map((statement) => statement.transactionSourceKeys),
    capture.statements.map((statement) =>
      statement.transactionSourceKeys.map(
        (sourceRecordKey) => sourceKeyBySourceRecordKey.get(sourceRecordKey),
      ),
    ),
  );
  assert.equal(
    neutral.statements.every((statement) => statement.evidence.settled === true),
    true,
  );
  assert.equal(
    neutral.transactions.filter((transaction) => transaction.billingStatus === "billed")
      .length,
    6,
  );
  assert.equal(
    neutral.transactions.filter((transaction) => transaction.billingStatus === "unbilled")
      .length,
    4,
  );
  assert.equal(neutral.statements.length, 0);
  assert.equal(JSON.stringify(neutral).includes("4111"), false);
});

test("source keys are stable across captures and exact duplicate ordinals are distinct", () => {
  const duplicatedRow = row("115/01", { description: "SAME PURCHASE" });
  const first = buildYuantaCanonicalCreditCardCapture(
    options({
      billedRows: [duplicatedRow, duplicatedRow, ...periods.slice(1).map((period) => row(period))],
      captureId: "capture-one",
    }),
  );
  const second = buildYuantaCanonicalCreditCardCapture(
    options({
      billedRows: [...periods.slice(1).map((period) => row(period)), duplicatedRow, duplicatedRow],
      captureId: "capture-two",
    }),
  );
  const firstKeys = first.transactions.map((transaction) => transaction.sourceKey).sort();
  const secondKeys = second.transactions.map((transaction) => transaction.sourceKey).sort();
  assert.deepEqual(firstKeys, secondKeys);
  const duplicateKeys = first.transactions
    .filter((transaction) => transaction.description === "SAME PURCHASE")
    .map((transaction) => transaction.sourceKey);
  assert.equal(new Set(duplicateKeys).size, 2);
  assert.ok(firstKeys.every((sourceKey) => !sourceKey.includes("capture-one")));
  assert.equal(
    buildYuantaCreditCardTransactionSourceKey(identity, {
      ...first.transactions[0]!,
      billingStatus: "unbilled",
      statementKey: undefined,
      occurrenceIndex: 0,
    }),
    buildYuantaCreditCardTransactionSourceKey(identity, {
      ...first.transactions[0]!,
      billingStatus: "billed",
      statementKey: first.transactions[0]!.statementKey,
      occurrenceIndex: 0,
    }),
  );
});

test("partial, conflicting-instrument, and invalid signed/status rows fail closed", () => {
  assert.throws(
    () => buildYuantaCanonicalCreditCardCapture(options({ billedPeriods: periods.slice(0, 5) })),
    /six billed periods/u,
  );
  assert.throws(
    () =>
      buildYuantaCanonicalCreditCardCapture(
        options({
          billedRows: [
            row("115/01"),
            row("115/01", { creditCardName: "DIFFERENT CARD" }),
            ...periods.slice(1).map((period) => row(period)),
          ],
        }),
      ),
    /conflicts/u,
  );
  const capture = buildYuantaCanonicalCreditCardCapture(options());
  const invalid = {
    ...capture,
    transactions: capture.transactions.map((transaction, index) =>
      index === 0
        ? { ...transaction, signedAmount: "-100.00", direction: "outflow" as const }
        : transaction,
    ),
  } as unknown as YuantaCreditCardCaptureInput;
  assert.throws(() => admitYuantaCreditCardCapture(invalid), /direction|sign/u);
  assert.throws(
    () =>
      admitYuantaCreditCardCapture({
        ...capture,
        transactions: capture.transactions.map((transaction, index) =>
          index === 0
            ? { ...transaction, postingStatus: "pending" as never }
            : transaction,
        ),
      } as unknown as YuantaCreditCardCaptureInput),
    /posted|status/u,
  );
});

test("canonical builder rejects projection, PAN, and last-four-only evidence", () => {
  for (const creditCardNo of [
    "4111-11**-****-1234",
    "4111111111111234",
    "1234",
  ])
    assert.throws(
      () =>
        buildYuantaCanonicalCreditCardCapture(
          options({
            billedRows: options().billedRows.map((sourceRow) => ({
              ...sourceRow,
              creditCardNo,
            })),
          }),
        ),
      /display mask/u,
    );
  assert.throws(
    () =>
      buildYuantaCanonicalCreditCardCapture(
        options({
          billedRows: options().billedRows.map((sourceRow) => ({
            ...sourceRow,
            instrumentKey: "1234",
          })),
        }),
      ),
    /opaque projected instrument key/u,
  );
});

test("same last four with different projected identities remain distinct and stable", () => {
  const secondaryInstrumentKey = `yuanta_instrument_${"B".repeat(43)}`;
  const first = buildYuantaCanonicalCreditCardCapture(
    options({
      billedRows: [
        row("115/01"),
        row("115/02", {
          instrumentKey: secondaryInstrumentKey,
          creditCardNo: "****1234",
          creditCardName: "SYNTHETIC SECOND CARD",
        }),
        ...periods.slice(2).map((period) => row(period)),
      ],
    }),
  );
  const repeated = buildYuantaCanonicalCreditCardCapture(
    options({
      captureId: "capture-b",
      billedRows: [
        row("115/02", {
          instrumentKey: secondaryInstrumentKey,
          creditCardNo: "****1234",
          creditCardName: "SYNTHETIC SECOND CARD",
        }),
        row("115/01"),
        ...periods.slice(2).map((period) => row(period)),
      ],
    }),
  );
  assert.equal(first.instruments.length, 2);
  assert.equal(new Set(first.instruments.map((value) => value.instrumentKey)).size, 2);
  assert.deepEqual(
    first.transactions.map((value) => value.sourceKey).sort(),
    repeated.transactions.map((value) => value.sourceKey).sort(),
  );
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes("411111"), false);
  assert.equal(serialized.includes("4111-11"), false);
});

test("commit preserves a complete no-summary capture without fabricated statements", async () => {
  const directory = mkdtempSync(join("/tmp", "yuanta-credit-card-no-summary-"));
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  try {
    const committed = await commitYuantaCreditCardCapture(
      store,
      buildYuantaCanonicalCreditCardCapture(options()),
    );
    assert.equal(committed.status, "canonical-live");
    assert.equal(committed.transactionCount, 10);
    assert.equal(committed.statementCount, 0);
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM financial_accounts").get() as { n: number }).n),
      1,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM financial_transactions").get() as { n: number }).n),
      10,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM canonical_credit_card_statement_revisions").get() as { n: number }).n),
      0,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM canonical_credit_card_statement_memberships").get() as { n: number }).n),
      0,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM canonical_credit_card_statement_summary_evidence").get() as { n: number }).n),
      0,
    );
  } finally {
    store.close();
  }
});

test("commit writes explicit settled summaries to the shared spine and extensions", async () => {
  const directory = mkdtempSync(join("/tmp", "yuanta-credit-card-canonical-"));
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  try {
    const committed = await commitYuantaCreditCardCapture(
      store,
      buildYuantaCanonicalCreditCardCapture(
        options({ statementSummaries: settledSummaries() }),
      ),
    );
    assert.equal(committed.status, "canonical-live");
    assert.equal(committed.canonicalAdmission, "admitted");
    assert.equal(committed.transactionCount, 10);
    assert.equal(committed.statementCount, 6);
    assert.equal(committed.relationCount, 0);
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM financial_accounts").get() as { n: number }).n),
      1,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM financial_transactions").get() as { n: number }).n),
      10,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM source_records").get() as { n: number }).n),
      16,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM canonical_credit_card_account_identities").get() as { n: number }).n),
      1,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM canonical_credit_card_instruments").get() as { n: number }).n),
      1,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM canonical_credit_card_transaction_details").get() as { n: number }).n),
      10,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM canonical_credit_card_statement_revisions").get() as { n: number }).n),
      6,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM canonical_credit_card_statement_memberships").get() as { n: number }).n),
      6,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM canonical_credit_card_statement_summary_evidence").get() as { n: number }).n),
      6,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM yuanta_credit_card_attestation_events").get() as { n: number }).n),
      1,
    );
    const payloads = store.db.prepare(
      "SELECT payload_json FROM source_records ORDER BY rowid",
    ).all() as Array<{ payload_json?: string }>;
    assert.equal(payloads.some((row) => /4111\s*1111|1234\s*5678/u.test(row.payload_json ?? "")), false);
  } finally {
    store.close();
  }
});

test("repeated Yuanta capture dedupes transactions and adds provenance", async () => {
  const directory = mkdtempSync(join("/tmp", "yuanta-credit-card-repeat-"));
  const store = createCanonicalSourceStore(join(directory, "canonical.sqlite"));
  try {
    const first = await commitYuantaCreditCardCapture(
      store,
      buildYuantaCanonicalCreditCardCapture(
        options({ captureId: "capture-a", statementSummaries: settledSummaries() }),
      ),
    );
    const repeated = await commitYuantaCreditCardCapture(
      store,
      buildYuantaCanonicalCreditCardCapture(
        options({ captureId: "capture-b", statementSummaries: settledSummaries() }),
      ),
    );
    assert.equal(first.transactionCount, 10);
    assert.equal(repeated.transactionCount, 10);
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM financial_transactions").get() as { n: number }).n),
      10,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM transaction_revisions").get() as { n: number }).n),
      10,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM source_records").get() as { n: number }).n),
      26,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM source_record_provenance").get() as { n: number }).n),
      20,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM assertion_provenance").get() as { n: number }).n),
      20,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM canonical_credit_card_transaction_details").get() as { n: number }).n),
      10,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM canonical_credit_card_statement_revisions").get() as { n: number }).n),
      6,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM canonical_credit_card_statement_memberships").get() as { n: number }).n),
      6,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM canonical_credit_card_statement_summary_evidence").get() as { n: number }).n),
      6,
    );
    assert.equal(
      Number((store.db.prepare("SELECT COUNT(*) AS n FROM canonical_credit_card_instrument_evidence").get() as { n: number }).n),
      2,
    );
  } finally {
    store.close();
  }
});
