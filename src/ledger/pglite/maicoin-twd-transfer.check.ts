import assert from "node:assert/strict";
import test from "node:test";
import { readPGliteCashFlow } from "./cash-flow.ts";
import { applyPgliteCashFlowTransferSchema } from "./cash-flow-transfer.ts";
import { commitFubon, commitTdccSettlement } from "./direct-source-precedence-fixture.ts";
import { readPGliteCoveredAccountIds } from "./direct-source-precedence.ts";
import { readKnowledgePoint } from "./knowledge-point.ts";
import { applyPgliteManualAssetsSchema } from "./manual-assets.ts";
import { queryPGliteCurrentInvestmentFundingRelations, resolvePGliteCanonicalInvestmentFundingRelations } from "./relations.ts";
import { createSpendingCategoryFixture, type SpendingCategoryFixture } from "./spending-test-fixture.ts";
import { installFinancialStore } from "./store-layout.ts";

const SEPTEMBER = { startDate: "2026-09-01", endDate: "2026-09-30" } as const;
const MAICOIN = { namespace: "maicoin", stream: "investment", accountType: "investment" } as const;
const BANK = { namespace: "fubon", stream: "domestic-deposit", accountType: "depository" } as const;
const idBytes = (id: string) => Buffer.from(id.replaceAll("-", ""), "hex");

async function withFixture(run: (fixture: SpendingCategoryFixture) => Promise<void>) {
  const fixture = await createSpendingCategoryFixture();
  try {
    await applyPgliteManualAssetsSchema(fixture.store);
    await applyPgliteCashFlowTransferSchema(fixture.store);
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

/** TWD leaving MAX (`out`) or arriving in MAX (`in`), from a withdrawal or deposit statement unless `rowType` says otherwise. */
function addMax(fixture: SpendingCategoryFixture, way: "in" | "out", amount: string, date: string, rowType?: "convert" | "reward") {
  return fixture.addTransaction({
    amount: "0", direction: way === "out" ? "outflow" : "inflow", date, account: "exchange", accountStream: MAICOIN,
    event: { investment: way === "out" ? "corporate_action_out" : "corporate_action_in", twdQuantity: amount, ...(rowType ? { rowType } : {}) },
  });
}

function addBank(fixture: SpendingCategoryFixture, direction: "inflow" | "outflow", amount: string, date: string, account = "savings") {
  return fixture.addTransaction({ amount, direction, date, account, accountStream: BANK });
}

async function kindOf(fixture: SpendingCategoryFixture, transactionId: string): Promise<string | null> {
  return (await fixture.store.query<{ value_text: string }>(
    "SELECT value_text FROM current_transaction_enrichment WHERE transaction_id = $1 AND field_name = 'kind'",
    [idBytes(transactionId)],
  )).rows[0]?.value_text ?? null;
}

const resolve = (fixture: SpendingCategoryFixture) => resolvePGliteCanonicalInvestmentFundingRelations(fixture.store, {});

test("a bank inflow matching a MAX TWD withdrawal reads as an investment withdrawal and leaves Cash flow", async () => {
  await withFixture(async (fixture) => {
    await addMax(fixture, "out", "5000", "2026-09-10");
    const deposit = await addBank(fixture, "inflow", "5000", "2026-09-12");
    assert.equal(await kindOf(fixture, deposit), "receipt");
    assert.deepEqual((await readPGliteCashFlow(fixture.store, SEPTEMBER)).totals[0]?.inflow.count, 1);

    const result = await resolve(fixture);
    assert.equal(result.outcome, "changed");
    assert.equal(await kindOf(fixture, deposit), "transfer.investment_withdrawal");
    const report = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual(report.transactions.find((row) => row.transactionId === deposit)?.cashFlow, { class: "not_counted", reason: "investment_move" });
    assert.deepEqual([report.totals[0]?.inflow.count ?? 0, report.totals[0]?.outflow.count ?? 0], [0, 0]);
    const relations = await queryPGliteCurrentInvestmentFundingRelations(fixture.store);
    assert.deepEqual(relations.map((relation) => [relation.fundingTransactionId, relation.direction, relation.settlementModel, relation.coefficient]),
      [[deposit, "inflow", "single-transaction", "5000"]]);
  });
});

test("a bank outflow matching a MAX TWD deposit reads as an investment contribution", async () => {
  await withFixture(async (fixture) => {
    const debit = await addBank(fixture, "outflow", "3000", "2026-09-14");
    await addMax(fixture, "in", "3000", "2026-09-15");
    await resolve(fixture);
    assert.equal(await kindOf(fixture, debit), "transfer.investment_contribution");
    const report = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual(report.transactions.find((row) => row.transactionId === debit)?.cashFlow, { class: "not_counted", reason: "investment_move" });
  });
});

test("no relation forms for a different amount, a gap over three days, the same direction, or an ambiguous match", async () => {
  await withFixture(async (fixture) => {
    await addMax(fixture, "out", "5000", "2026-09-10");
    const offByOne = await addBank(fixture, "inflow", "5001", "2026-09-10");
    const sameWay = await addBank(fixture, "outflow", "5000", "2026-09-10");
    await addMax(fixture, "out", "6000", "2026-09-10");
    const tooFar = await addBank(fixture, "inflow", "6000", "2026-09-14");
    // One MAX withdrawal, two bank inflows that fit it.
    await addMax(fixture, "out", "7000", "2026-09-20");
    const twinA = await addBank(fixture, "inflow", "7000", "2026-09-20");
    const twinB = await addBank(fixture, "inflow", "7000", "2026-09-21", "other-savings");
    // Two MAX withdrawals that fit one bank inflow.
    await addMax(fixture, "out", "8000", "2026-09-24");
    await addMax(fixture, "out", "8000", "2026-09-25");
    const shared = await addBank(fixture, "inflow", "8000", "2026-09-25");

    const result = await resolve(fixture);
    assert.equal(result.resolutionId, null, "nothing was written");
    assert.deepEqual(await queryPGliteCurrentInvestmentFundingRelations(fixture.store), []);
    for (const id of [offByOne, tooFar, twinA, twinB, shared]) assert.equal(await kindOf(fixture, id), "receipt");
    assert.notEqual(await kindOf(fixture, sameWay), "transfer.investment_contribution");
  });
});

test("a bank deposit committed after the MAX movement forms the relation in its own commit", async () => {
  await withFixture(async (fixture) => {
    await addMax(fixture, "out", "16700", "2026-08-02");
    await commitTdccSettlement(fixture.store, "013", {
      withBalance: false,
      rows: [["20260801090000", "16700.0", "0.0", "16700.0", "跨行轉入"]],
    });
    const relations = await queryPGliteCurrentInvestmentFundingRelations(fixture.store);
    assert.equal(relations.length, 1);
    assert.equal(await kindOf(fixture, String(relations[0]!.fundingTransactionId)), "transfer.investment_withdrawal");
  });
});

test("a later bank row that makes the match ambiguous withdraws the relation, and resolving again writes nothing", async () => {
  await withFixture(async (fixture) => {
    await addMax(fixture, "out", "5000", "2026-09-10");
    const first = await addBank(fixture, "inflow", "5000", "2026-09-11");
    await resolve(fixture);
    assert.equal(await kindOf(fixture, first), "transfer.investment_withdrawal");

    const second = await addBank(fixture, "inflow", "5000", "2026-09-12", "other-savings");
    assert.equal((await resolve(fixture)).outcome, "changed");
    assert.deepEqual(await queryPGliteCurrentInvestmentFundingRelations(fixture.store), []);
    assert.equal(await kindOf(fixture, first), "receipt");
    assert.equal(await kindOf(fixture, second), "receipt");

    const before = await fixture.knowledgeAt();
    await resolve(fixture);
    assert.equal(await fixture.knowledgeAt(), before, "an unchanged match writes no commit");
  });
});

test("a store holding a matched pair gains the relation on its next open, once", async () => {
  await withFixture(async (fixture) => {
    await installFinancialStore(fixture.database);
    // A store written before the pass: the pair is projected and no relation names it.
    await fixture.store.query("DELETE FROM pglite_operational_migrations WHERE migration_key LIKE 'maicoin-twd-funding-%'");
    await addMax(fixture, "out", "5000", "2026-09-10");
    const deposit = await addBank(fixture, "inflow", "5000", "2026-09-10");
    assert.equal(await kindOf(fixture, deposit), "receipt");

    await installFinancialStore(fixture.database);
    assert.equal(await kindOf(fixture, deposit), "transfer.investment_withdrawal");

    const tables = (await fixture.store.query<{ table_name: string }>(
      "SELECT tablename AS table_name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).rows.map((row) => row.table_name);
    const counts = async () => Object.fromEntries(await Promise.all(tables.map(async (table) =>
      [table, Number((await fixture.store.query<{ n: number | string }>(`SELECT count(*) AS n FROM "${table}"`)).rows[0]!.n)])));
    const before = await counts();
    await installFinancialStore(fixture.database);
    assert.deepEqual(await counts(), before, "a second open writes nothing");
  });
});

test("a TDCC copy of a directly synced bank account does not make the match ambiguous", async () => {
  await withFixture(async (fixture) => {
    await commitFubon(fixture.store);
    await commitTdccSettlement(fixture.store, "012", {
      withBalance: false,
      rows: [["20260801090000", "16700.0", "0.0", "16700.0", "跨行轉入"]],
    });
    assert.equal((await readPGliteCoveredAccountIds(fixture.store, await readKnowledgePoint(fixture.store))).length, 1, "the direct account covers the TDCC copy");
    await addMax(fixture, "out", "16700", "2026-08-02");
    const deposit = await addBank(fixture, "inflow", "16700", "2026-08-01");
    await resolve(fixture);
    const relations = await queryPGliteCurrentInvestmentFundingRelations(fixture.store);
    assert.deepEqual(relations.map((relation) => String(relation.fundingTransactionId)), [deposit]);
    assert.equal(await kindOf(fixture, deposit), "transfer.investment_withdrawal");
  });
});

test("a convert or reward moves MAX TWD but never matches a bank row", async () => {
  await withFixture(async (fixture) => {
    await addMax(fixture, "out", "5000", "2026-09-10", "convert");
    await addMax(fixture, "in", "3000", "2026-09-10", "convert");
    await addMax(fixture, "in", "40", "2026-09-10", "reward");
    await addMax(fixture, "out", "7000", "2026-09-10");
    const withdrawn = await addBank(fixture, "inflow", "7000", "2026-09-11");
    const receipt = await addBank(fixture, "inflow", "5000", "2026-09-11");
    const payment = await addBank(fixture, "outflow", "3000", "2026-09-11");
    const small = await addBank(fixture, "outflow", "40", "2026-09-11");
    await resolve(fixture);
    assert.deepEqual((await queryPGliteCurrentInvestmentFundingRelations(fixture.store)).map((relation) => String(relation.fundingTransactionId)), [withdrawn]);
    assert.deepEqual([await kindOf(fixture, receipt), await kindOf(fixture, payment) === "transfer.investment_contribution", await kindOf(fixture, small) === "transfer.investment_contribution"], ["receipt", false, false]);
  });
});
