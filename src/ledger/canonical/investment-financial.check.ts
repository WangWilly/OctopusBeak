import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  admitCanonicalInvestmentCapture,
  commitCanonicalInvestmentCapture,
  commitCanonicalInvestmentCaptureBatch,
  createCanonicalInvestmentStore,
  queryCanonicalInvestmentCurrent,
  queryCanonicalInvestmentHistorical,
  queryCanonicalInvestmentLineage,
  type InvestmentCaptureInput,
} from "./investment-financial.ts";

const token = (letter: string) => `sha256:${letter.repeat(64)}`;

function fixture(
  captureId = "yuanta-trade-sanitized-1",
): InvestmentCaptureInput {
  return {
    captureId,
    sourceId: "yuanta-trade",
    authorityRoute: "yuanta-trade/investment/canonical-v1",
    contractVersion: "yuanta-trade/investment/canonical-v1",
    observedAt: "2026-08-31T12:00:00.000Z",
    identity: {
      sourceConnectionKey: token("a"),
      identityEpochKey: token("b"),
      accountKey: token("c"),
      accountType: "investment",
      reportingCurrency: "TWD",
    },
    scope: { effectiveOn: "2026-08-30", complete: true },
    securities: [
      {
        securityKey: "yuanta-trade:TWSE:2330",
        producerSecurityId: "TWSE:2330",
        name: "SANITIZED EQUITY",
        ticker: "2330",
        currency: "TWD",
        identityEvidence: {
          kind: "producer-security-id",
          contractVersion: "yuanta-trade/investment/canonical-v1",
        },
      },
    ],
    holdings: [
      {
        measurementKey: token("d"),
        measurementSubjectKey: token("s"),
        sourceRecordKey: token("e"),
        securityKey: "yuanta-trade:TWSE:2330",
        quantity: { coefficient: "1000", scale: 0 },
        valuation: { coefficient: "500000", scale: 0, currency: "TWD" },
        effectiveOn: "2026-08-30",
        observedAt: "2026-08-31T12:00:00.000Z",
        effectiveTimeEvidence: {
          kind: "source-reported-as-of",
          sourceRecordKey: token("e"),
          sourceField: "as_of_date",
          value: "2026-08-30",
          contractVersion: "yuanta-trade/investment/canonical-v1",
        },
        lineage: {
          page: 0,
          row: 0,
          contractVersion: "yuanta-trade/investment/canonical-v1",
        },
      },
    ],
    transactions: [
      {
        sourceRecordKey: token("f"),
        transactionKey: token("g"),
        securityKey: "yuanta-trade:TWSE:2330",
        action: "buy",
        quantity: { coefficient: "1000", scale: 0 },
        cashEffect: { coefficient: "500000", scale: 0, currency: "TWD" },
        effectiveOn: "2026-08-29",
        fundingEvidence: { kind: "unresolved", sourceRecordKey: token("f") },
      },
    ],
    margin: {
      kind: "embedded",
      amount: { coefficient: "25000", scale: 0, currency: "TWD" },
      effectiveOn: "2026-08-30",
      sourceRecordKey: token("h"),
    },
  };
}

test("investment capture is atomic, restart-safe, and preserves independent measurements", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canonical-investment-"));
  const path = join(dir, "canonical.sqlite");
  try {
    let store = createCanonicalInvestmentStore(path);
    await commitCanonicalInvestmentCapture(
      store,
      admitCanonicalInvestmentCapture(fixture()),
    );
    await commitCanonicalInvestmentCapture(
      store,
      admitCanonicalInvestmentCapture(fixture("yuanta-trade-sanitized-2")),
    );
    let current = queryCanonicalInvestmentCurrent(store, token("a"));
    assert.equal(current.accounts.length, 1);
    assert.equal(current.securities.length, 1);
    assert.equal(current.holdings.length, 1);
    assert.equal(
      queryCanonicalInvestmentHistorical(store, token("a")).holdings.length,
      2,
    );
    assert.equal(current.transactions[0]?.action, "buy");
    assert.equal(current.marginBalances[0]?.balanceKind, "margin_loan");
    assert.equal(current.transactions[0]?.fundingEvidence.kind, "unresolved");
    assert.equal(current.relations.length, 0);
    store.close();
    store = createCanonicalInvestmentStore(path);
    current = queryCanonicalInvestmentCurrent(store, token("a"));
    assert.equal(current.holdings.length, 1);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("investment admission fails closed for ambiguous actions and unstable security identity", () => {
  assert.throws(
    () =>
      admitCanonicalInvestmentCapture({
        ...fixture(),
        transactions: [
          { ...fixture().transactions[0]!, action: "unknown" as "buy" },
        ],
      }),
    /buy or sell/,
  );
  assert.throws(
    () =>
      admitCanonicalInvestmentCapture({
        ...fixture(),
        securities: [
          { ...fixture().securities[0]!, securityKey: "SANITIZED EQUITY" },
        ],
      }),
    /producer-scoped/,
  );
  assert.doesNotThrow(() =>
    admitCanonicalInvestmentCapture({
      ...fixture(),
      observedAt: "2026-08-30T12:00:00.000Z",
      holdings: [
        { ...fixture().holdings[0]!, observedAt: "2026-08-30T12:00:00.000Z" },
      ],
    }),
  );
  assert.throws(
    () =>
      admitCanonicalInvestmentCapture({
        ...fixture(),
        observedAt: "2026-08-31 12:00:00",
      }),
    /RFC3339/,
  );
  assert.throws(
    () =>
      admitCanonicalInvestmentCapture({
        ...fixture(),
        observedAt: "2026-02-30T12:00:00Z",
      }),
    /RFC3339/,
  );
});

test("a correction target is resolved against prior canonical measurements", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture();
  input.holdings[0] = {
    ...input.holdings[0]!,
    correction: {
      ofMeasurementKey: token("z"),
      stableCorrectionKey: token("y"),
      proofKind: "source-stable-correction-key",
      contractVersion: input.contractVersion,
      priorEffectiveOn: "2026-08-30",
    },
  };
  await assert.rejects(
    commitCanonicalInvestmentCapture(
      store,
      admitCanonicalInvestmentCapture(input),
    ),
    /correction target/,
  );
  store.close();
});

test("a contract-proven correction revises current selection and preserves history", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(fixture("base")),
  );
  const corrected = fixture("correction");
  corrected.observedAt = "2026-09-01T12:00:00.000Z";
  corrected.holdings[0] = {
    ...corrected.holdings[0]!,
    measurementKey: token("i"),
    correction: {
      ofMeasurementKey: token("d"),
      stableCorrectionKey: token("y"),
      proofKind: "source-stable-correction-key",
      contractVersion: corrected.contractVersion,
      priorEffectiveOn: "2026-08-30",
    },
    sourceRecordKey: token("j"),
    observedAt: corrected.observedAt,
    valuation: { coefficient: "510000", scale: 0, currency: "TWD" },
    effectiveTimeEvidence: {
      ...corrected.holdings[0]!.effectiveTimeEvidence,
      sourceRecordKey: token("j"),
    },
  };
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(corrected),
  );
  assert.equal(
    queryCanonicalInvestmentCurrent(store, token("a")).holdings.length,
    1,
  );
  assert.equal(
    queryCanonicalInvestmentHistorical(store, token("a")).holdings.length,
    2,
  );
  assert.equal(
    queryCanonicalInvestmentLineage(store, token("a"), token("d")).holdings
      .length,
    2,
  );
  store.close();
});

test("a correction cannot cross Security or measurement-subject identity", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(fixture("subject-base")),
  );
  const correction = fixture("wrong-subject");
  correction.holdings[0] = {
    ...correction.holdings[0]!,
    measurementKey: token("i"),
    measurementSubjectKey: token("x"),
    sourceRecordKey: token("j"),
    effectiveTimeEvidence: {
      ...correction.holdings[0]!.effectiveTimeEvidence,
      sourceRecordKey: token("j"),
    },
    correction: {
      ofMeasurementKey: token("d"),
      stableCorrectionKey: token("y"),
      proofKind: "source-stable-correction-key",
      contractVersion: correction.contractVersion,
      priorEffectiveOn: "2026-08-30",
    },
  };
  await assert.rejects(
    commitCanonicalInvestmentCapture(
      store,
      admitCanonicalInvestmentCapture(correction),
    ),
    /same account, Security, measurement subject/,
  );
  store.close();
});

test("transaction-only Securities remain queryable", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("transaction-only");
  input.holdings = [];
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );
  const current = queryCanonicalInvestmentCurrent(store, token("a"));
  assert.equal(current.holdings.length, 0);
  assert.equal(current.securities.length, 1);
  assert.equal(current.transactions.length, 1);
  store.close();
});

test("independent margin borrowing creates a canonical liability account", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const input = fixture("independent-margin");
  input.margin = {
    kind: "independent-account",
    accountKey: token("m"),
    accountType: "loan",
    amount: { coefficient: "25000", scale: 0, currency: "TWD" },
    effectiveOn: "2026-08-30",
    sourceRecordKey: token("n"),
    identityEvidence: {
      kind: "producer-margin-account-id",
      producerAccountId: "SANITIZED-MARGIN-ACCOUNT",
      contractVersion: input.contractVersion,
    },
  };
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(input),
  );
  const liability = store.db
    .prepare(
      "SELECT account_type AS accountType FROM financial_accounts WHERE stream='investment-margin'",
    )
    .get() as { accountType: string };
  assert.equal(liability.accountType, "loan");
  assert.equal(
    Number(
      (
        store.db
          .prepare(
            "SELECT COUNT(*) AS count FROM source_captures WHERE stream='investment-margin'",
          )
          .get() as { count: number }
      ).count,
    ),
    1,
  );
  store.close();
});

test("identity epoch participates in account identity and Security drift rolls back atomically", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(fixture("epoch-1")),
  );
  const nextEpoch = fixture("epoch-2");
  nextEpoch.identity.identityEpochKey = token("q");
  await commitCanonicalInvestmentCapture(
    store,
    admitCanonicalInvestmentCapture(nextEpoch),
  );
  assert.equal(
    queryCanonicalInvestmentCurrent(store, token("a")).accounts.length,
    2,
  );
  const drift = fixture("security-drift");
  drift.securities[0] = { ...drift.securities[0]!, name: "CHANGED LABEL" };
  await assert.rejects(
    commitCanonicalInvestmentCapture(
      store,
      admitCanonicalInvestmentCapture(drift),
    ),
    /Immutable Security/,
  );
  assert.equal(
    Number(
      (
        store.db
          .prepare(
            "SELECT COUNT(*) AS count FROM source_captures WHERE capture_key='security-drift'",
          )
          .get() as { count: number }
      ).count,
    ),
    0,
  );
  store.close();
});

test("a multi-account investment batch has one atomic visibility boundary", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const first = fixture("batch-first");
  const conflicting = fixture("batch-conflicting");
  conflicting.identity.accountKey = token("r");
  conflicting.securities[0] = {
    ...conflicting.securities[0]!,
    name: "CONFLICTING LABEL",
  };
  await assert.rejects(
    commitCanonicalInvestmentCaptureBatch(store, [
      admitCanonicalInvestmentCapture(first),
      admitCanonicalInvestmentCapture(conflicting),
    ]),
    /Immutable Security/,
  );
  assert.equal(
    Number(
      (
        store.db
          .prepare("SELECT COUNT(*) AS count FROM canonical_commits")
          .get() as {
          count: number;
        }
      ).count,
    ),
    0,
  );
  assert.equal(
    Number(
      (
        store.db
          .prepare("SELECT COUNT(*) AS count FROM investment_accounts")
          .get() as {
          count: number;
        }
      ).count,
    ),
    0,
  );
  store.close();
});
