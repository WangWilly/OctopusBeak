import assert from "node:assert/strict";
import test from "node:test";
import type {
  AccountRowDto,
  CreditCardBalanceDto,
  CreditCardStatementDto,
  CurrencyAmountDto,
  DailyHistoryRowDto,
} from "../shared-ledger/types.ts";
import { readLiabilitiesSummary, type LiabilitiesSummaryInput } from "./liabilities-summary.ts";

const twd = (value: number): CurrencyAmountDto[] => [{ currency: "TWD", value }];

function account(id: string, kind: "credit-card" | "loan", value: number, creditCard?: AccountRowDto["creditCard"]): AccountRowDto {
  return {
    id,
    label: `${id} label`,
    institution: id,
    product: kind,
    group: "liability",
    kind,
    typeLabel: kind,
    amountLines: twd(value),
    transactionCount: 0,
    assetPositionCount: 0,
    lastUpdated: null,
    valueAvailability: "available",
    ...(creditCard ? { creditCard } : {}),
  };
}

function statement(statementKey: string, revisionNumber: number, dueDate: string, balance: number): CreditCardStatementDto {
  return {
    statementId: statementKey,
    statementRevisionId: `${statementKey}-${revisionNumber}`,
    statementKey,
    revisionNumber,
    cycleStart: "2026-08-20",
    cycleEnd: "2026-09-19",
    issueDate: "2026-09-22",
    dueDate,
    currency: "TWD",
    statementBalance: { currency: "TWD", value: balance },
    minimumPayment: null,
    memberships: [],
  };
}

function used(value: number, limit: number | null): CreditCardBalanceDto {
  return {
    balanceKind: "credit_used",
    estimateKind: "estimate",
    estimateBasis: limit === null ? "provider-used-credit" : "credit-limit-minus-available",
    estimateFormula: "limit - available",
    amount: { currency: "TWD", value },
    componentLimit: limit === null ? null : { coefficient: String(limit * 100), scale: 2 },
    componentAvailable: limit === null ? null : { coefficient: String((limit - value) * 100), scale: 2 },
  };
}

function debtRow(date: string, owed: number): DailyHistoryRowDto {
  return { date, netAssets: twd(-owed), dailyChange: [], assets: [], liabilities: twd(owed), accountChanges: [], positionCount: 0 };
}

function input(overrides: Partial<LiabilitiesSummaryInput>): LiabilitiesSummaryInput {
  return { accounts: [], dailyHistory: [], dailyHistoryByAccount: {}, exchangeRates: [], ...overrides };
}

const TODAY = "2026-10-05";

test("no liability account reads as empty", () => {
  assert.deepEqual(readLiabilitiesSummary(input({}), { today: TODAY }), { state: "empty" });
});

test("upcoming payments list unpaid-due statements by date, then estimates for cards without a bill", () => {
  const fubon = account("fubon", "credit-card", 12_870, {
    statements: [
      statement("2026-08", 1, "2026-09-07", 20_000),
      statement("2026-09", 1, "2026-10-07", 15_000),
      statement("2026-09", 2, "2026-10-07", 15_604),
    ],
  });
  const esun = account("esun", "credit-card", 38_452, { statements: [], currentUsedCredit: used(38_452, null) });
  const loan = account("loan", "loan", 1_280_000);
  const summary = readLiabilitiesSummary(input({ accounts: [loan, esun, fubon] }), { today: TODAY });
  assert.equal(summary.state, "ready");
  if (summary.state !== "ready") return;
  assert.deepEqual(summary.payments.map((payment) => [
    payment.kind,
    payment.account.id,
    payment.kind === "statement" ? payment.dueDate : null,
    payment.kind === "statement" ? payment.daysUntil : null,
    payment.amount.value,
  ]), [
    ["statement", "fubon", "2026-10-07", 2, 15_604],
    ["card-estimate", "esun", null, null, 38_452],
  ], "a past-due bill and a superseded revision are not listed, and a loan has no payment facts");
  assert.equal(summary.payments[0]?.share, 15_604 / (15_604 + 38_452));
  assert.equal(summary.total, 12_870 + 38_452 + 1_280_000);
});

test("utilization counts only cards that report a limit", () => {
  const withLimit = account("a", "credit-card", 51_322, { statements: [], currentUsedCredit: used(51_322, 230_000) });
  const withoutLimit = account("b", "credit-card", 9_000, { statements: [], currentUsedCredit: used(9_000, null) });
  const summary = readLiabilitiesSummary(input({ accounts: [withLimit, withoutLimit] }), { today: TODAY });
  assert.deepEqual(summary.state === "ready" && summary.utilization, { used: 51_322, limit: 230_000, ratio: 51_322 / 230_000 });
});

test("no card reporting a limit has no utilization", () => {
  const summary = readLiabilitiesSummary(input({ accounts: [account("loan", "loan", 100)] }), { today: TODAY });
  assert.equal(summary.state === "ready" && summary.utilization, null);
  assert.deepEqual(summary.state === "ready" && summary.payments, []);
});

test("the 30-day change is the change in what is owed, over this page's accounts only", () => {
  const loanHistory = [debtRow("2026-09-01", 1000), debtRow("2026-10-05", 900)];
  const marginHistory = [debtRow("2026-09-01", 0), debtRow("2026-10-05", 5000)];
  const summary = readLiabilitiesSummary(input({
    accounts: [account("loan", "loan", 900)],
    dailyHistory: loanHistory,
    dailyHistoryByAccount: { loan: loanHistory, margin: marginHistory },
  }), { today: TODAY });
  assert.equal(summary.state, "ready");
  if (summary.state !== "ready") return;
  assert.equal(summary.trailing?.change, -100, "paying down 100 is a drop in debt");
  assert.equal(summary.trailing?.pct, -0.1);
});
