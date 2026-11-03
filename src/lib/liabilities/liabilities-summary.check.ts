import assert from "node:assert/strict";
import test from "node:test";
import type {
  AccountRowDto,
  CreditCardBalanceDto,
  CreditCardStatementDto,
  CurrencyAmountDto,
  DailyHistoryRowDto,
} from "../shared-ledger/types.ts";
import { readLiabilitiesSummary, readMortgageRepaid, type LiabilitiesSummaryInput } from "./liabilities-summary.ts";
import { NO_PROVENANCE, originProvenance } from "../shared-ledger/provenance.ts";
import { valuationDateFor } from "../shared-ledger/twd-valuation.ts";

const PREVIEW = originProvenance("preview");

const twd = (value: number): CurrencyAmountDto[] => [{ currency: "TWD", value }];

function account(id: string, kind: "credit-card" | "loan", value: number, creditCard?: AccountRowDto["creditCard"]): AccountRowDto {
  return {
    id,
    label: `${id} label`,
    institution: id,
    product: kind,
    group: "liability",
    kind,
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
  return { date, netAssets: twd(-owed), dailyChange: [], assets: [], liabilities: twd(owed), accountChanges: [], positionCount: 0, provenance: NO_PROVENANCE };
}

const TODAY = "2026-10-05";

/** The page as the ledger would publish it on TODAY, valuation date included. */
function input(overrides: Partial<LiabilitiesSummaryInput>): LiabilitiesSummaryInput {
  const valuationDate = valuationDateFor(overrides.dailyHistory ?? [], overrides.exchangeRates ?? [], TODAY);
  return { valuationDate, accounts: [], dailyHistory: [], dailyHistoryByAccount: {}, exchangeRates: [], ...overrides };
}

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

test("a counted preview credit balance marks the total; an unknown one adds nothing and leaves the total unmarked", () => {
  const preview = (id: string, value: number | null): AccountRowDto => ({
    ...account(id, "credit-card", value ?? 0),
    amountLines: value === null ? [] : twd(value),
    valueAvailability: value === null ? "unavailable" : "available",
    preview: {
      sourceId: "synthetic", product: "credit_card", lastCollectedAt: "2026-10-05T03:00:00.000Z",
      balanceTime: null, transactions: [],
    },
  });
  const known = readLiabilitiesSummary(input({ accounts: [account("loan", "loan", 100), preview("known", 300)] }), { today: TODAY });
  assert.ok(known.state === "ready" && known.provenance.preview && known.total === 400);
  const unknown = readLiabilitiesSummary(input({ accounts: [account("loan", "loan", 100), preview("unknown", null)] }), { today: TODAY });
  assert.ok(unknown.state === "ready" && !unknown.provenance.preview && unknown.total === 100);
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

test("a closed preview loan that drives the 30-day change marks the total preview", () => {
  const verified = [debtRow("2026-09-01", 1000), debtRow("2026-10-05", 900)];
  const closed = [{ ...debtRow("2026-09-01", 500), provenance: PREVIEW }, { ...debtRow("2026-10-01", 0), provenance: PREVIEW }];
  const summary = readLiabilitiesSummary(input({
    accounts: [account("loan", "loan", 900), previewLoan("preview:closed", "TWD", null, { category: "personal", originalAmount: null, closedAt: "2026-10-01T00:00:00Z" })],
    dailyHistory: [debtRow("2026-09-01", 1500), debtRow("2026-10-01", 1000), debtRow("2026-10-05", 900)],
    dailyHistoryByAccount: { loan: verified, "preview:closed": closed },
  }), { today: TODAY });
  assert.equal(summary.state, "ready");
  if (summary.state !== "ready") return;
  assert.equal(summary.total, 900, "the closed loan owes nothing today");
  assert.equal(summary.trailing?.change, -600);
  assert.deepEqual(summary.trailing?.provenance, PREVIEW);
  assert.deepEqual(summary.provenance, PREVIEW, "the total's 30-day change counts the loan's payoff");
});

function previewLoan(
  id: string,
  currency: string,
  owed: number | null,
  terms: Readonly<{ category: "housing" | "personal" | "other" | null; originalAmount: string | null; closedAt?: string }>,
): AccountRowDto {
  return {
    ...account(id, "loan", 0),
    amountLines: owed === null ? [] : [{ currency, value: owed }],
    valueAvailability: owed === null ? "unavailable" : "available",
    preview: {
      sourceId: "synthetic", product: "loan", lastCollectedAt: "2026-10-05T01:00:00Z", balanceTime: null, transactions: [],
      loan: {
        currency, category: terms.category, originalAmount: terms.originalAmount, interestRate: null, paymentAmount: null,
        nextPaymentDate: null, installmentsPaid: null, installmentsTotal: null, openedOn: null, maturityDate: null,
        closedAt: terms.closedAt ?? null,
      },
    },
  };
}

test("mortgage repaid is one minus the summed balance over the summed original amount, per currency, not a mean of loans", () => {
  const repaid = readMortgageRepaid([
    previewLoan("a", "TWD", 6_000_000, { category: "housing", originalAmount: "8000000" }),
    previewLoan("b", "TWD", 0, { category: "housing", originalAmount: "2000000" }),
    previewLoan("c", "USD", 150_000, { category: "housing", originalAmount: "200000.00" }),
  ]);
  assert.deepEqual(repaid, {
    shares: [
      { currency: "TWD", outstanding: 6_000_000, original: 10_000_000, repaid: 0.4 },
      { currency: "USD", outstanding: 150_000, original: 200_000, repaid: 0.25 },
    ],
    omitted: false,
  });
});

test("mortgage repaid counts only open preview housing loans and notes a mortgage without an original amount", () => {
  const repaid = readMortgageRepaid([
    previewLoan("home", "TWD", 500, { category: "housing", originalAmount: "1000" }),
    previewLoan("no-original", "TWD", 900, { category: "housing", originalAmount: null }),
    previewLoan("personal", "TWD", 10, { category: "personal", originalAmount: "1000" }),
    previewLoan("unlabelled", "TWD", 10, { category: null, originalAmount: "1000" }),
    previewLoan("closed", "TWD", null, { category: "housing", originalAmount: "1000", closedAt: "2026-10-04T01:00:00Z" }),
    account("verified-loan", "loan", 300),
  ]);
  assert.deepEqual(repaid.shares.map((share) => [share.currency, share.outstanding, share.original, share.repaid]), [["TWD", 500, 1000, 0.5]]);
  assert.equal(repaid.omitted, true);
});

test("with no countable mortgage the tile is empty, and an omitted one is still noted", () => {
  assert.deepEqual(readMortgageRepaid([account("verified-loan", "loan", 300)]), { shares: [], omitted: false });
  assert.deepEqual(readMortgageRepaid([previewLoan("x", "TWD", 900, { category: "housing", originalAmount: null })]),
    { shares: [], omitted: true });
});
