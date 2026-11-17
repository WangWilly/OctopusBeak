import assert from "node:assert/strict";
import test from "node:test";
import { readCashFlowPage } from "./cash-flow-page.ts";
import { readPGliteCashFlow, type CashFlowReport } from "./cash-flow.ts";
import { applyPgliteCashFlowTransferSchema } from "./cash-flow-transfer.ts";
import { applyPgliteManualAssetsSchema } from "./manual-assets.ts";
import { querySpendingReport } from "./spending-facts.ts";
import { createSpendingCategoryFixture, type FixtureTransactionInput, type SpendingCategoryFixture } from "./spending-test-fixture.ts";
import { cashFlowCsv } from "../../lib/cash-flow/csv.ts";
import { translations } from "../../lib/i18n/i18n.ts";

const SEPTEMBER = { startDate: "2026-09-01", endDate: "2026-09-30" } as const;
const MAICOIN = { namespace: "maicoin", stream: "investment", accountType: "investment" } as const;
const BINANCE = { namespace: "binance", stream: "investment", accountType: "investment" } as const;

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

type MaxInflow = Readonly<{ coin: string; quantity: string; scale?: number; date: string; valueTwd?: number | null; rowType?: "deposit" | "reward" | "convert"; syncs?: number }>;

/** A coin arriving in MAX as the MAX adapter records it: a zero-cash corporate action logged with its statement row. */
function addMaxInflow(fixture: SpendingCategoryFixture, input: MaxInflow) {
  return fixture.addTransaction({
    amount: "0", direction: "inflow", date: input.date, scale: input.scale, account: "max", accountStream: MAICOIN,
    event: { investment: "corporate_action_in", coin: input.coin, quantity: input.quantity, rowType: input.rowType ?? "deposit", valueTwd: input.valueTwd, syncs: input.syncs },
  });
}

function addBinanceWithdrawal(fixture: SpendingCategoryFixture, coin: string, quantity: string, date: string, scale?: number) {
  const input: FixtureTransactionInput = {
    amount: "0", direction: "outflow", date, scale, account: "binance", accountStream: BINANCE,
    event: { investment: "corporate_action_out", coin, quantity, source: "binance" },
  };
  return fixture.addTransaction(input);
}

const rowOf = (report: CashFlowReport, id: string) => report.transactions.find((row) => row.transactionId === id);
const twd = (coefficient: string, scale: number) => ({ coefficient, scale, currency: "TWD" });
const NOT_COUNTED = { class: "not_counted", reason: "investment_move" } as const;

test("a MAX reward and an outside crypto deposit count as income at their logged TWD value, rounded half-up to cents", async () => {
  await withFixture(async (fixture) => {
    const reward = await addMaxInflow(fixture, { coin: "USDT", quantity: "125", scale: 2, date: "2026-09-04", rowType: "reward", valueTwd: 40.005 });
    const salary = await addMaxInflow(fixture, { coin: "USDT", quantity: "1500", date: "2026-09-10", valueTwd: 48123.4449 });
    const report = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual([rowOf(report, reward)?.cashFlow, rowOf(report, reward)?.amount], [{ class: "inflow", group: "income.reward" }, twd("4001", 2)]);
    assert.deepEqual([rowOf(report, salary)?.cashFlow, rowOf(report, salary)?.amount], [{ class: "inflow", group: "income" }, twd("4812344", 2)]);
    const [total] = report.totals;
    assert.equal(total?.currency, "TWD");
    assert.deepEqual([total?.inflow.amount, total?.inflow.count], [{ coefficient: "4816345", scale: 2 }, 2]);
    assert.deepEqual(total?.inflow.groups.map((group) => [group.group, group.amount]),
      [["income", { coefficient: "4812344", scale: 2 }], ["income.reward", { coefficient: "4001", scale: 2 }]]);
  });
});

test("the page's list, account change and CSV show the income row at its value", async () => {
  await withFixture(async (fixture) => {
    const reward = await addMaxInflow(fixture, { coin: "BTC", quantity: "1", scale: 4, date: "2026-09-04", rowType: "reward", valueTwd: 321.5 });
    const page = await readCashFlowPage(fixture.store, SEPTEMBER);
    const row = page.transactions.find((transaction) => transaction.transactionId === reward);
    assert.deepEqual(row?.amount, twd("3215", 1));
    assert.deepEqual(page.accounts.map((account) => account.amount), [{ coefficient: "3215", scale: 1 }]);
    const csv = cashFlowCsv(page.transactions, "flow", translations["zh-TW"]);
    assert.match(csv, /,321\.5,TWD,/u);
  });
});

test("a crypto deposit that uniquely matches a Binance withdrawal is the person's own transfer and stays out", async () => {
  await withFixture(async (fixture) => {
    await addBinanceWithdrawal(fixture, "USDT", "1005", "2026-09-08", 1);
    const deposit = await addMaxInflow(fixture, { coin: "USDT", quantity: "100", date: "2026-09-10", valueTwd: 3200 });
    const report = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual(rowOf(report, deposit)?.cashFlow, NOT_COUNTED);
    assert.equal(report.totals[0]?.inflow.count ?? 0, 0);
  });
});

test("an ambiguous match counts on both sides of the ambiguity", async () => {
  await withFixture(async (fixture) => {
    await addBinanceWithdrawal(fixture, "USDT", "100", "2026-09-09");
    await addBinanceWithdrawal(fixture, "USDT", "100", "2026-09-11");
    const deposit = await addMaxInflow(fixture, { coin: "USDT", quantity: "100", date: "2026-09-10", valueTwd: 3200 });
    assert.deepEqual(rowOf(await readPGliteCashFlow(fixture.store, SEPTEMBER), deposit)?.cashFlow, { class: "inflow", group: "income" });
  });
  await withFixture(async (fixture) => {
    await addBinanceWithdrawal(fixture, "ETH", "2", "2026-09-30");
    const first = await addMaxInflow(fixture, { coin: "ETH", quantity: "2", date: "2026-09-29", valueTwd: 150000 });
    // The second deposit lies outside the period, but it still shares the withdrawal.
    await addMaxInflow(fixture, { coin: "ETH", quantity: "2", date: "2026-10-01", valueTwd: 150000 });
    assert.deepEqual(rowOf(await readPGliteCashFlow(fixture.store, SEPTEMBER), first)?.cashFlow, { class: "inflow", group: "income" });
  });
});

test("a withdrawal more than 1% larger, smaller than the deposit, of another coin, or over three days away does not match", async () => {
  await withFixture(async (fixture) => {
    await addBinanceWithdrawal(fixture, "USDT", "1011", "2026-09-05", 1);
    const tooLarge = await addMaxInflow(fixture, { coin: "USDT", quantity: "100", date: "2026-09-05", valueTwd: 3200 });
    await addBinanceWithdrawal(fixture, "SOL", "99", "2026-09-12");
    const tooSmall = await addMaxInflow(fixture, { coin: "SOL", quantity: "100", date: "2026-09-12", valueTwd: 3200 });
    await addBinanceWithdrawal(fixture, "BTC", "1", "2026-09-15");
    const otherCoin = await addMaxInflow(fixture, { coin: "ETH", quantity: "1", date: "2026-09-15", valueTwd: 3200 });
    await addBinanceWithdrawal(fixture, "ADA", "50", "2026-09-20");
    const tooFar = await addMaxInflow(fixture, { coin: "ADA", quantity: "50", date: "2026-09-24", valueTwd: 3200 });
    const report = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    for (const id of [tooLarge, tooSmall, otherCoin, tooFar]) assert.deepEqual(rowOf(report, id)?.cashFlow, { class: "inflow", group: "income" });
  });
});

test("a TWD deposit and a convert leg stay out of Cash flow", async () => {
  await withFixture(async (fixture) => {
    const twdDeposit = await addMaxInflow(fixture, { coin: "TWD", quantity: "5000", date: "2026-09-10", valueTwd: 5000 });
    const converted = await addMaxInflow(fixture, { coin: "USDT", quantity: "30", date: "2026-09-11", rowType: "convert", valueTwd: 960 });
    const report = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    for (const id of [twdDeposit, converted]) assert.deepEqual(rowOf(report, id)?.cashFlow, NOT_COUNTED);
    assert.deepEqual(rowOf(report, twdDeposit)?.amount, twd("0", 0));
  });
});

test("a qualifying row with no logged value is unresolved, never dropped", async () => {
  await withFixture(async (fixture) => {
    const reward = await addMaxInflow(fixture, { coin: "USDT", quantity: "3", date: "2026-09-04", rowType: "reward", valueTwd: null });
    const report = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual(rowOf(report, reward)?.cashFlow, { class: "unresolved" });
    assert.deepEqual([report.totals[0]?.unresolved.count, report.totals[0]?.inflow.count], [1, 0]);
  });
});

test("a statement logged by several syncs counts once, at its latest logged value", async () => {
  await withFixture(async (fixture) => {
    await addMaxInflow(fixture, { coin: "USDT", quantity: "1", date: "2026-09-04", rowType: "reward", valueTwd: 32, syncs: 3 });
    await fixture.store.query("UPDATE maicoin_statement_rows SET value_twd = 999 WHERE captured_at < (SELECT MAX(captured_at) FROM maicoin_statement_rows)");
    const report = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual([report.totals[0]?.inflow.amount, report.totals[0]?.inflow.count], [{ coefficient: "32", scale: 0 }, 1]);
  });
});

test("a store without the statement log reads every MAX row as not counted", async () => {
  await withFixture(async (fixture) => {
    const reward = await addMaxInflow(fixture, { coin: "USDT", quantity: "1", date: "2026-09-04", rowType: "reward", valueTwd: 32 });
    await fixture.store.query("DROP TABLE maicoin_statement_rows");
    assert.deepEqual(rowOf(await readPGliteCashFlow(fixture.store, SEPTEMBER), reward)?.cashFlow, NOT_COUNTED);
  });
});

test("Spending is unchanged by MAX income", async () => {
  await withFixture(async (fixture) => {
    const purchase = await fixture.addTransaction({ amount: "250", date: "2026-09-05" });
    const read = async () => {
      const report = await querySpendingReport(fixture.store, "current", await fixture.knowledgeAt(), null, SEPTEMBER);
      return report.includedTransactions.map((transaction) => [transaction.transactionId, transaction.amount]);
    };
    const before = await read();
    await addMaxInflow(fixture, { coin: "USDT", quantity: "1", date: "2026-09-04", rowType: "reward", valueTwd: 32 });
    await addMaxInflow(fixture, { coin: "USDT", quantity: "100", date: "2026-09-10", valueTwd: 3200 });
    assert.deepEqual(await read(), before);
    assert.deepEqual(before.map(([id]) => id), [purchase]);
  });
});
