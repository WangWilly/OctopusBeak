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
};

const candidateValues = Array.from({ length: 11 }, (_, index) => {
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
  totalsByCurrency: [{ currency: "TWD", coefficient: String(100 + candidateValues.reduce((sum, candidate) => sum + Number(candidate.amount.coefficient), 0)), scale: 0, count: 12 }],
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
      if (input.offset === 10) {
        return { dataVersion: 2, candidates: candidates.slice(10), totalCandidateCount: candidates.length, nextOffset: null };
      }
      return { dataVersion: 1, candidates: candidates.slice(0, 10), totalCandidateCount: candidates.length, nextOffset: 10 };
    };
  }, { candidates: candidateValues });
  await page.addInitScript(() => {
    localStorage.setItem("octopusbeak-locale", "en");
  });
  await page.goto(`http://127.0.0.1:${address.port}/#/spending`);

  await page.locator("[data-purchase-report]").waitFor();
  await page.locator("[data-open-pairing]").first().click();
  await page.locator("[data-pairing-dialog]").waitFor();
  await page.locator("[data-pairing-dialog] .payment-option").first().waitFor();
  assert.equal(await page.locator("[data-pairing-dialog] .payment-option").count(), 10);

  await page.locator("[data-show-more-payments]").click();
  await page.waitForTimeout(25);
  const rankCallCount = await page.evaluate(() => window.__pairingRankCalls.length);
  assert.equal(
    await page.locator("[data-pairing-dialog] .payment-option").count(),
    10,
    "a stale second page must not append mixed-generation candidates",
  );
  assert.equal(rankCallCount, 3, "stale pagination restarts at the current page");
  console.log(JSON.stringify({ rankCallCount, candidateCount: 10 }));
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
