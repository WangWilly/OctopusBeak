import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMaicoinInvestmentCapture,
  maicoinStatementPosting,
  maicoinStatementRecordKey,
  parseMaicoinProviderDate,
  type MaicoinStatementBatch,
} from "../canonical/maicoin-crypto-adapters.ts";
import type { InvestmentCaptureInput, InvestmentTwdValuation } from "../canonical/investment-financial.ts";
import { createTestPGlite } from "./baseline-test-template.ts";
import { commitPGliteCanonicalInvestmentCapture } from "./investment.ts";
import { queryPGliteCurrentInvestmentFundingRelations, resolvePGliteCanonicalInvestmentFundingRelations } from "./relations.ts";
import { createSpendingCategoryFixture } from "./spending-test-fixture.ts";
import { PGliteStore } from "./transaction.ts";

const providerDate = parseMaicoinProviderDate("Fri, 25 Sep 2026 10:00:00 GMT");
const history = { startDate: "2017-12-11", endDate: "2026-09-25", complete: true as const };
const DEPOSITS = "/api/v3/fund_transactions/deposits";

type Deposit = Readonly<{ sn: string; currency: string; amount: string; state?: string; at: string }>;

function batches(deposits: readonly Deposit[]): MaicoinStatementBatch[] {
  const rows = (rowType: MaicoinStatementBatch["rowType"]) => rowType === "deposit"
    ? deposits.map(({ at, ...row }) => ({ ...row, created_at: Date.parse(at) }))
    : [];
  return [
    { endpoint: "/api/v3/wallet/spot/trades", walletType: "spot", rowType: "trade", rows: [], history },
    ...([
      [DEPOSITS, "deposit"],
      ["/api/v3/fund_transactions/withdrawals", "withdrawal"],
      ["/api/v3/fund_transactions/transfers", "transfer"],
      ["/api/v3/rewards", "reward"],
      ["/api/v3/converts", "convert"],
    ] as const).map(([endpoint, rowType]) => ({ endpoint, walletType: null, rowType, rows: rows(rowType), history })),
  ];
}

const depositKey = (sn: string) =>
  maicoinStatementRecordKey({ endpoint: DEPOSITS, walletType: null, rowType: "deposit", externalId: `sn:${sn}`, leg: "transaction" });

const BTC_VALUATION: InvestmentTwdValuation = {
  route: "direct", market: "btctwd", close: { coefficient: "3000000", scale: 0 }, candleDay: "2026-09-20",
  value: { coefficient: "1500000", scale: 0, currency: "TWD" },
};

function capture(captureId: string, deposits: readonly Deposit[], valuations: ReadonlyMap<string, InvestmentTwdValuation> = new Map()): InvestmentCaptureInput {
  return buildMaicoinInvestmentCapture({
    captureId,
    providerEmail: "owner@example.test",
    subAccount: "main",
    accountBatches: [{ walletType: "spot", providerDate, accounts: [{ currency: "BTC", balance: "1", locked: "0" }] }],
    statementBatches: batches(deposits),
    statementValuations: valuations,
  });
}

const BTC_DEPOSIT: Deposit = { sn: "d-btc", currency: "btc", amount: "0.5", state: "done", at: "2026-09-20T03:00:00Z" };

async function withStore(run: (store: PGliteStore) => Promise<void>) {
  const store = new PGliteStore(await createTestPGlite("ledger"));
  try {
    await run(store);
  } finally {
    await store.close();
  }
}

async function counts(store: PGliteStore) {
  const count = async (table: string) => Number((await store.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0]?.count);
  return {
    records: await count("source_records"),
    revisions: await count("transaction_revisions"),
    investments: await count("investment_transactions"),
    valuations: await count("investment_transaction_twd_valuations"),
  };
}

async function depositRevisions(store: PGliteStore) {
  return (await store.query<{ posting_status: string; economic_status: string }>(
    `SELECT revision.posting_status, revision.economic_status
       FROM transaction_revisions revision
       JOIN investment_transactions investment ON investment.transaction_id = revision.transaction_id
      ORDER BY revision.revision_number`,
  )).rows.map((row) => `${row.posting_status}/${row.economic_status}`);
}

test("MAX states map through one closed table, and an unknown state is never posted", () => {
  assert.deepEqual(
    [null, "done", "DONE", "rejected", "failed", "canceled", "cancelled", "refunded", "processing", "a-state-max-adds-later", ""]
      .map(maicoinStatementPosting),
    ["posted", "posted", "posted", "canceled", "canceled", "canceled", "canceled", "canceled", "pending", "pending", "pending"],
  );
});

test("a MAX record key ignores state and valuation, so revisable fields can never re-key a record (ADR 0117, 0158)", () => {
  const keys = (input: InvestmentCaptureInput) => input.transactions.map((row) => row.sourceRecordKey);
  const processing = capture("keys-1", [{ ...BTC_DEPOSIT, state: "processing" }]);
  const done = capture("keys-2", [BTC_DEPOSIT], new Map([[depositKey("d-btc"), BTC_VALUATION]]));
  assert.deepEqual(keys(processing), keys(done));
  assert.deepEqual(keys(done), [depositKey("d-btc")]);
  assert.deepEqual(done.transactions[0]?.twdValuation, BTC_VALUATION);
  assert.deepEqual([processing.transactions[0]?.rowType, processing.transactions[0]?.state], ["deposit", "processing"]);
});

test("a processing deposit that MAX completes writes a second revision and no conflict", async () => {
  await withStore(async (store) => {
    await commitPGliteCanonicalInvestmentCapture(store, { capture: capture("state-1", [{ ...BTC_DEPOSIT, state: "processing" }]) });
    assert.deepEqual(await depositRevisions(store), ["pending/normal"]);
    await commitPGliteCanonicalInvestmentCapture(store, { capture: capture("state-2", [BTC_DEPOSIT]) });
    assert.deepEqual(await depositRevisions(store), ["pending/normal", "posted/normal"]);
    assert.equal((await counts(store)).investments, 1);
  });
});

test("a deposit MAX rejects is posted and canceled", async () => {
  await withStore(async (store) => {
    await commitPGliteCanonicalInvestmentCapture(store, { capture: capture("rejected", [{ ...BTC_DEPOSIT, state: "rejected" }]) });
    assert.deepEqual(await depositRevisions(store), ["posted/canceled"]);
  });
});

test("an unchanged MAX re-sync writes no source record, revision, investment row or valuation", async () => {
  await withStore(async (store) => {
    const valuations = new Map([[depositKey("d-btc"), BTC_VALUATION]]);
    await commitPGliteCanonicalInvestmentCapture(store, { capture: capture("unchanged-1", [BTC_DEPOSIT], valuations) });
    const before = await counts(store);
    await commitPGliteCanonicalInvestmentCapture(store, { capture: capture("unchanged-2", [BTC_DEPOSIT], valuations) });
    assert.deepEqual(await counts(store), before);
  });
});

test("a recapture that newly carries a valuation writes exactly one valuation row, once", async () => {
  await withStore(async (store) => {
    await commitPGliteCanonicalInvestmentCapture(store, { capture: capture("valued-1", [BTC_DEPOSIT]) });
    assert.equal((await counts(store)).valuations, 0);
    const valuations = new Map([[depositKey("d-btc"), BTC_VALUATION]]);
    await commitPGliteCanonicalInvestmentCapture(store, { capture: capture("valued-2", [BTC_DEPOSIT], valuations) });
    const valued = await counts(store);
    assert.equal(valued.valuations, 1);
    assert.deepEqual((await store.query("SELECT price_route, market, close_coefficient, candle_day, value_coefficient, value_scale FROM investment_transaction_twd_valuations")).rows,
      [{ price_route: "direct", market: "btctwd", close_coefficient: "3000000", candle_day: "2026-09-20", value_coefficient: "1500000", value_scale: 0 }]);
    await commitPGliteCanonicalInvestmentCapture(store, { capture: capture("valued-3", [BTC_DEPOSIT], valuations) });
    assert.deepEqual(await counts(store), valued);
    await commitPGliteCanonicalInvestmentCapture(store, { capture: capture("valued-4", [BTC_DEPOSIT]) });
    assert.equal((await counts(store)).valuations, 1, "a commit without a valuation leaves the stored one alone");
    await commitPGliteCanonicalInvestmentCapture(store, { capture: capture("valued-5", [BTC_DEPOSIT],
      new Map([[depositKey("d-btc"), { ...BTC_VALUATION, close: { coefficient: "2", scale: 0 } }]])) });
    assert.deepEqual((await store.query("SELECT close_coefficient FROM investment_transaction_twd_valuations")).rows,
      [{ close_coefficient: "3000000" }], "a close MAX restates later does not replace the admitted valuation or fail the sync");
  });
});

test("an occurrence admitted before ADR 0158 accepts its first recapture and gains its row type", async () => {
  await withStore(async (store) => {
    const legacy = capture("legacy-1", [BTC_DEPOSIT]);
    const stripped: InvestmentCaptureInput = {
      ...legacy,
      transactions: legacy.transactions.map(({ rowType: _rowType, state: _state, posting: _posting, twdValuation: _valuation, ...row }) => row),
    };
    await commitPGliteCanonicalInvestmentCapture(store, { capture: stripped });
    assert.equal((await store.query<{ row_type: string | null }>("SELECT row_type FROM investment_transactions")).rows[0]?.row_type, null);
    await commitPGliteCanonicalInvestmentCapture(store, { capture: capture("legacy-2", [BTC_DEPOSIT], new Map([[depositKey("d-btc"), BTC_VALUATION]])) });
    assert.equal((await store.query<{ row_type: string | null }>("SELECT row_type FROM investment_transactions")).rows[0]?.row_type, "deposit");
    assert.equal((await counts(store)).valuations, 1);
    assert.deepEqual(await depositRevisions(store), ["posted/normal"], "an unchanged booking writes no revision");
  });
});

test("a MAX TWD deposit matches its bank row in the sync that first admits it", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const debit = await fixture.addTransaction({
      amount: "3000", direction: "outflow", date: "2026-09-20", account: "savings",
      accountStream: { namespace: "fubon", stream: "domestic-deposit", accountType: "depository" },
    });
    await commitPGliteCanonicalInvestmentCapture(fixture.store, {
      capture: capture("twd-first-sync", [{ sn: "d-twd", currency: "twd", amount: "3000", state: "done", at: "2026-09-20T04:00:00Z" }]),
    });
    await resolvePGliteCanonicalInvestmentFundingRelations(fixture.store, {});
    const relations = await queryPGliteCurrentInvestmentFundingRelations(fixture.store);
    assert.deepEqual(relations.map((relation) => [relation.fundingTransactionId, relation.direction, relation.coefficient]), [[debit, "outflow", "3000"]]);
  } finally {
    await fixture.close();
  }
});
