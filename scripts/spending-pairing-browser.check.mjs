import assert from "node:assert/strict";
import { chromium } from "playwright";
import { record, singleCategory, view } from "./spending-canonical-fixture.mjs";
import {
  createSpendingViteServer,
  spendingDesktopApiInitScript,
} from "./spending-browser-harness.mjs";

const money = (coefficient, currency = "TWD") => ({ coefficient, scale: 0, currency });
const occurrence = (value) => ({
  value,
  precision: "date",
  timeZone: "Asia/Taipei",
  basis: "purchase-date",
});

function transactionRecord(index) {
  const transactionId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
  const date = `2026-07-${String(2 + (index % 20)).padStart(2, "0")}`;
  const amount = money(String(100 + index));
  return {
    purchaseId: `transaction:${transactionId}`,
    basis: "bank-transaction",
    amount,
    occurrence: occurrence(date),
    description: `Payment ${index + 1}`,
    invoice: null,
    transaction: {
      transactionId,
      effectiveOn: date,
      consumeDate: null,
      postingDate: null,
      description: `Payment ${index + 1}`,
      amount,
      stream: "checking",
      effectiveDateBasis: null,
    },
    items: [],
    possibleDuplicate: false,
    candidateIds: [],
    link: null,
    difference: null,
    refund: null,
    category: { mode: "absent" },
    itemCategorizations: [],
    paymentSource: null,
  };
}

const invoiceId = "00000000-0000-4000-8000-000000000001";
const invoiceAmount = money("100");
const invoiceRecordValue = {
  purchaseId: `invoice:${invoiceId}`,
  basis: "invoice",
  amount: invoiceAmount,
  occurrence: occurrence("2026-07-02"),
  description: "Fixture invoice",
  invoice: {
    invoiceId,
    revision: {
      invoiceNumber: "AB-00000001",
      seller: { name: "Fixture invoice" },
      occurrence: occurrence("2026-07-02"),
      total: invoiceAmount,
      items: [],
    },
  },
  transaction: null,
  items: [],
  possibleDuplicate: false,
  candidateIds: [],
  link: null,
  difference: null,
  refund: null,
  category: { mode: "absent" },
  itemCategorizations: [],
  paymentSource: null,
};

const candidateValues = Array.from({ length: 60 }, (_, index) => {
  const transaction = transactionRecord(index);
  return {
    purchaseId: transaction.purchaseId,
    transactionId: transaction.transaction.transactionId,
    description: transaction.description,
    amount: transaction.amount,
    occurrence: transaction.occurrence,
    stream: "checking",
    effectiveDateBasis: null,
  };
});
const purchaseReport = {
  status: "ok",
  kind: "current",
  knowledgeAt: 1,
  financialAt: null,
  records: [invoiceRecordValue, ...Array.from({ length: candidateValues.length }, (_, index) => transactionRecord(index))],
  totalsByCurrency: [{ currency: "TWD", coefficient: String(100 + candidateValues.reduce((sum, candidate) => sum + Number(candidate.amount.coefficient), 0)), scale: 0, count: candidateValues.length + 1 }],
  totalStatus: "complete",
  candidates: [],
};
const canonicalRecord = record({
  id: "fixture-canonical-payment",
  date: "2026-07-02",
  value: 100,
  category: singleCategory("dining"),
  label: "Fixture canonical payment",
});
const canonical = view([canonicalRecord], { selectedMonth: "2026-07" });
const model = { canonical, purchaseReport, invoices: [] };

const server = await createSpendingViteServer();
const address = server.httpServer?.address();
assert.ok(address && typeof address === "object");
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript({ content: spendingDesktopApiInitScript(model) });
  await page.addInitScript(({ candidates }) => {
    window.__pairingRankCalls = [];
    window.octopusBeak.spending.rankPairingCandidates = async (input) => {
      window.__pairingRankCalls.push(input);
      if (input.offset === 50 && window.__pairingRankCalls.length === 2) {
        return {
          dataVersion: 2,
          candidates: candidates.slice(input.offset, input.offset + 50),
          totalCandidateCount: candidates.length,
          nextOffset: input.offset + 50 < candidates.length ? input.offset + 50 : null,
        };
      }
      const offset = input.offset ?? 0;
      const limit = Math.min(input.limit ?? 50, 50);
      const page = candidates.slice(offset, offset + limit);
      const nextOffset = offset + page.length < candidates.length ? offset + page.length : null;
      return { dataVersion: 1, candidates: page, totalCandidateCount: candidates.length, nextOffset };
    };
  }, { candidates: candidateValues });
  await page.addInitScript(() => {
    localStorage.setItem("octopusbeak-locale", "en");
  });
  await page.goto(`http://127.0.0.1:${address.port}/#/spending`);

  await page.locator("[data-purchase-report]").waitFor();
  await page.locator("[data-purchase-record][data-basis='invoice']").first().click();
  await page.locator("[data-purchase-modal] [data-open-pairing]").click();
  await page.locator("[data-pairing-dialog]").waitFor();
  await page.locator("[data-pairing-dialog] .payment-option").first().waitFor();
  assert.equal(
    await page.locator("[data-pairing-dialog] .payment-option").count(),
    50,
    "the pairing dialog initially renders the first globally ranked page",
  );

  await page.locator("[data-show-more-payments]").click();
  await page.waitForTimeout(25);
  assert.equal(
    await page.locator("[data-pairing-dialog] .payment-option").count(),
    50,
    "a stale candidate page must not replace or append to the current ranked page",
  );
  await page.locator("[data-show-more-payments]").click();
  await page.waitForTimeout(25);
  const rankCallCount = await page.evaluate(() => window.__pairingRankCalls.length);
  assert.equal(
    await page.locator("[data-pairing-dialog] .payment-option").count(),
    candidateValues.length,
    "a stale page must restart before appending the remaining candidates",
  );
  const renderedTransactionIds = await page.locator("[data-pairing-dialog] .payment-option input").evaluateAll(
    (inputs) => inputs.map((input) => input.value),
  );
  assert.deepEqual(
    renderedTransactionIds,
    candidateValues.map((candidate) => candidate.transactionId),
    "pagination must preserve canonical candidate order without losing a candidate",
  );
  assert.equal(rankCallCount, 4, "stale pagination restarts, then the current page can be fetched");
  console.log(JSON.stringify({ rankCallCount, candidateCount: renderedTransactionIds.length }));
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
