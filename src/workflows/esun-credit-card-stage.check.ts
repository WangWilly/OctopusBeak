import assert from "node:assert/strict";
import test from "node:test";
import { productCollectionHandle, type ProductStageRequest } from "../lib/automation/product-collection.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { CreditCardMonthTimeline } from "../ledger/canonical/credit-card-query-inventory.ts";
import { PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND } from "../ledger/pglite/workflow-client.ts";
import {
  esunCurrentUsedCreditFromSummaryResponse,
  stageEsunCreditCard,
  type EsunCreditCardSource,
  type StatementRow,
} from "./esun-credit-card-statements.ts";

const input = {
  credentials: {
    esun_user_id: " user-id-001 ",
    esun_account: " account-009 ",
    esun_password: "password-must-not-escape",
  },
  managedIdentitySecret: "synthetic-esun-managed-secret",
};

const billedRow: StatementRow = {
  cardNumber: "4111-****-****-1234",
  consumeDate: "2026/07/15",
  description: "Synthetic Coffee",
  foreignCurrency: "USD",
  foreignAmount: "10.00",
  paymentCurrency: "TWD",
  twdAmount: "123.45",
  paymentStatus: "billed",
  sourcePaymentStatus: "已入帳",
};
const unbilledRow: StatementRow = {
  cardNumber: "4111-****-****-1234",
  consumeDate: "2026/08/15",
  description: "Synthetic Transit",
  foreignCurrency: "",
  foreignAmount: "",
  paymentCurrency: "TWD",
  twdAmount: "-45.67",
  paymentStatus: "unbilled",
  sourcePaymentStatus: "未入帳",
};

const thirteenMonths: CreditCardMonthTimeline = {
  kind: "past-year-timeline",
  firstMonth: "2026/08",
  lastMonth: "2025/08",
  months: Array.from({ length: 13 }, (_, index) =>
    new Date(Date.UTC(2026, 7 - index, 1)).toISOString().slice(0, 7).replace("-", "/")),
  pageCount: 3,
  monthCount: 13,
  capturedRowCount: 2,
  terminal: true,
  terminalCursor: 4,
};

const [currentUsedCredit] = esunCurrentUsedCreditFromSummaryResponse(
  {
    resultCode: "0000",
    resultTime: "2026-08-26 15:21:22",
    resultBody: { hasCreditCard: true, usedCreditLimit: "46,989", availableCreditLimit: "53,011" },
  },
  {
    endpoint: "https://ebank.esunbank.com.tw/esb/mib-ccm-portal/ccmA1/ccmA1001/home/getCardSummary",
    httpDate: "Wed, 26 Aug 2026 07:21:22 GMT",
  },
);
assert(currentUsedCredit);

const completeSource: EsunCreditCardSource = {
  startDate: "2025/08/26",
  endDate: "2026/08/26",
  rows: [billedRow, unbilledRow],
  timeline: thirteenMonths,
  issuerSummaries: [
    { cycleEnd: "2026/06/30", dueDate: "2026/07/20", balance: "1000", minimumPayment: "100", currency: "TWD" },
    { cycleEnd: "2026/07/31", dueDate: "2026/08/20", balance: "123.45", minimumPayment: "12.34", currency: "TWD" },
  ],
};

/** Runs the build half against a real product handle and records its events and stage calls in one sequence. */
async function stage(source: EsunCreditCardSource) {
  const log: string[] = [];
  const staged: ProductStageRequest[] = [];
  const signal = new AbortController().signal;
  const now = () => "2026-08-26T07:30:00.000Z";
  const event = async (stage: string, outcome: string, code: string) => {
    log.push(`${stage}:${outcome}:${code}`);
  };
  const product = productCollectionHandle({
    now,
    text: strictSourceText,
    signal,
    event,
    stage: (...requests) => {
      staged.push(...requests);
      log.push(...requests.map((request) => `stage:${request.product}`));
    },
    reportActivity: async () => undefined,
    collectionPeriod: () => assert.fail("the build half reads no collection period"),
  });
  try {
    const result = await stageEsunCreditCard(source, input, { event, now, signal }, product);
    return { result, log, staged, error: undefined };
  } catch (error) {
    return { result: undefined, log, staged, error };
  }
}

test("a complete twelve- or thirteen-month E.SUN source stages one canonical card commit", async () => {
  const twelveMonths: EsunCreditCardSource = {
    ...completeSource,
    startDate: "2025/09/01",
    timeline: { ...thirteenMonths, lastMonth: "2025/09", months: thirteenMonths.months.slice(0, 12), monthCount: 12 },
  };
  for (const source of [completeSource, twelveMonths]) {
    const { result, staged, error } = await stage(source);
    assert.equal(error, undefined, `${source.timeline.monthCount} months stage without error`);
    assert.deepEqual(result, { count: 2 });
    assert.deepEqual(staged.map((item) => [item.product, item.command.kind]), [
      ["credit-card", PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND],
    ]);
  }
});

test("E.SUN stages the card before it validates and stages the current used credit read beside it", async () => {
  const { log, staged, error } = await stage({ ...completeSource, currentUsedCredit: [currentUsedCredit] });
  assert.equal(error, undefined);
  assert.deepEqual(log, [
    "decoding:completed:source-decoding-completed",
    "validation:started:source-validation-started",
    "stage:credit-card",
    "validation:started:current-balance-validation-started",
    "validation:completed:current-balance-validation-completed",
    "stage:current-balance",
  ]);
  assert.equal(staged.length, 2);
});

const incomplete: ReadonlyArray<readonly [string, EsunCreditCardSource]> = [
  ["eleven months", { ...completeSource, timeline: { ...thirteenMonths, monthCount: 11 } }],
  ["a timeline that does not start at the query's end month", {
    ...completeSource,
    timeline: { ...thirteenMonths, firstMonth: "2026/07" },
  }],
  ["a timeline that does not reach the query's start month", {
    ...completeSource,
    timeline: { ...thirteenMonths, lastMonth: "2025/09" },
  }],
  ["a timeline that never reached its terminal page", {
    ...completeSource,
    timeline: { ...thirteenMonths, terminal: false as true },
  }],
  ["a terminal cursor other than four", {
    ...completeSource,
    timeline: { ...thirteenMonths, terminalCursor: 3 as 4 },
  }],
  ["a card number with fewer than four digits", {
    ...completeSource,
    rows: [billedRow, { ...unbilledRow, cardNumber: "****-**12" }],
  }],
  ["a single issuer bill summary", {
    ...completeSource,
    issuerSummaries: completeSource.issuerSummaries.slice(1),
  }],
];

for (const [name, source] of incomplete) {
  test(`an E.SUN source with ${name} is rejected as incomplete before validation starts and stages nothing`, async () => {
    const { log, staged, error } = await stage({ ...source, currentUsedCredit: [currentUsedCredit] });
    assert(error instanceof Error);
    assert.equal(error.message, "E.SUN source is incomplete; Canonical Financial Commit was rejected.");
    assert.deepEqual(log, [
      "decoding:completed:source-decoding-completed",
      "validation:failed:source-validation-rejected",
    ]);
    assert.deepEqual(staged, []);
  });
}

test("an E.SUN bill summary with an invalid date fails as bill-summary validation before decoding completes", async () => {
  const { log, staged, error } = await stage({
    ...completeSource,
    issuerSummaries: [{ ...completeSource.issuerSummaries[0]!, cycleEnd: "2026/02/30" }, completeSource.issuerSummaries[1]!],
  });
  assert(error instanceof Error);
  assert.equal(error.message, "E.SUN bill summary source failed validation.");
  assert.deepEqual(log, ["validation:failed:source-validation-rejected"]);
  assert.deepEqual(staged, []);
});
