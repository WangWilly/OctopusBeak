import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { createSpendingViteServer, spendingDesktopApiInitScript } from "./spending-browser-harness.mjs";
import { record, singleCategory, view } from "./spending-canonical-fixture.mjs";

const total = { currency: "TWD", coefficient: "100", scale: 0, count: 1 };
const model = {
  canonical: view([record({ id: "fixture-payment", date: "2026-10-01", value: 100, category: singleCategory("dining") })]),
  purchaseReport: {
    status: "ok", kind: "current", knowledgeAt: 1, financialAt: null,
    records: [], candidates: [], totalsByCurrency: [total], totalStatus: "complete",
    summary: {
      recordCount: 1, candidateCount: null, pendingCandidateCount: null, candidateState: "unloaded",
      currencies: ["TWD"], totalsByCurrency: [total],
      monthTotals: [{ month: "2026-10", recordCount: 1, activeDayCount: 1, pendingCandidateCount: null, totalsByCurrency: [total] }],
      dayTotals: [{ month: "2026-10", date: "2026-10-01", recordCount: 1, totalsByCurrency: [total] }],
      categoryTotalsByMonth: [{ month: "2026-10", currency: "TWD", categoryCode: null, coefficient: "100", scale: 0, count: 1 }],
    },
  }, invoices: [],
};

function installReads({ model, scenario }) {
  window.__recordCalls = [];
  window.__fail = scenario === "failure";
  window.__candidateCalls = [];
  window.__refreshes = 0;
  window.__ranks = [];
  const pairingScenario = scenario === "pairing-live" || scenario === "action-race";
  window.octopusBeak.spending.rankPairingCandidates = async (input) => {
    window.__ranks.push(input.dataVersion);
    const candidate = { transactionId: "payment-fixture", purchaseId: "transaction:payment-fixture", description: "Payment", amount: { currency: "TWD", coefficient: "100", scale: 0 }, occurrence: { value: "2026-10-01", precision: "date", timeZone: "Asia/Taipei", basis: "purchase-date" }, stream: "checking", effectiveDateBasis: null };
    const candidates = scenario === "pairing-live" && input.dataVersion > 1 ? [] : [candidate];
    return { dataVersion: input.dataVersion, candidates, totalCandidateCount: candidates.length, nextOffset: null, selectedCandidate: input.selectedTransactionId ? candidates[0] ?? null : null };
  };
  window.octopusBeak.spending.applyPageAction = async () => new Promise((resolve) => {
    window.__finishAction = () => resolve({ action: "confirm", kind: "direct", baseKnowledgeAt: 1, knowledgeAt: 2, invoiceIdentityId: "invoice-fixture", transactionIdentityId: "payment-fixture", summaryDelta: { before: [], after: [] }, affectedRecords: [{ ...window.__purchase, description: "Action purchase v2" }] });
  });
  let listener;
  let publication = model;
  const original = window.octopusBeak.dataViews.subscribe;
  window.__publish = (version) => {
    publication = { ...model, purchaseReport: { ...model.purchaseReport, knowledgeAt: version } };
    listener([publication]);
  };
  window.octopusBeak.dataViews.subscribe = async (name, params, onRows, onError) => {
    if (name !== "financial.spending.current") return original(name, params, onRows, onError);
    listener = onRows;
    window.__refreshes += 1;
    if ((scenario === "stale" || scenario === "candidate-stale") && window.__refreshes > 1) publication = { ...model, purchaseReport: { ...model.purchaseReport, knowledgeAt: 2 } };
    queueMicrotask(() => onRows([publication]));
    return () => {};
  };
  window.octopusBeak.spending.cancelCandidatePage = async () => true;
  window.octopusBeak.spending.loadRecordPage = async (request) => {
    window.__recordCalls.push(request.knowledgeAt);
    if (window.__fail) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      throw new Error("Synthetic query failure");
    }
    if (scenario === "stale" && request.knowledgeAt === 1) return { stale: true, knowledgeAt: 2 };
    if (((scenario === "retain" || scenario === "pairing-live") && request.knowledgeAt === 2) || (scenario === "action-race" && request.knowledgeAt === 3)) await new Promise((resolve) => { window.__releaseRead = resolve; });
    const description = `Fixture purchase v${request.knowledgeAt}`;
    const purchase = {
      purchaseId: "transaction:fixture", basis: pairingScenario ? "invoice" : "bank-transaction", amount: { currency: "TWD", coefficient: "100", scale: 0 },
      occurrence: { value: "2026-10-01", precision: "date", timeZone: "Asia/Taipei", basis: "purchase-date" },
      description, invoice: pairingScenario ? { invoiceId: "invoice-fixture", revision: { invoiceNumber: "AB-00000001", seller: { name: description }, occurrence: { value: "2026-10-01", precision: "date", timeZone: "Asia/Taipei", basis: "purchase-date" }, total: { currency: "TWD", coefficient: "100", scale: 0 }, items: [] } } : null,
      transaction: { transactionId: "fixture", effectiveOn: "2026-10-01", consumeDate: null, postingDate: null, description, amount: { currency: "TWD", coefficient: "100", scale: 0 }, stream: "checking", effectiveDateBasis: null },
      items: [], possibleDuplicate: false, candidateIds: [], link: null, difference: null, refund: null,
      category: { mode: "absent" }, itemCategorizations: [], paymentSource: null,
    };
    window.__purchase = purchase;
    return { schemaVersion: 1, knowledgeAt: request.knowledgeAt, month: request.month, day: request.day ?? null, records: [purchase], nextCursor: null };
  };
  window.octopusBeak.spending.loadCandidatePage = async (request) => {
    window.__candidateCalls.push(request.knowledgeAt);
    if (scenario === "candidate-stale" && request.knowledgeAt === 1) return { stale: true, knowledgeAt: 2 };
    return { schemaVersion: 1, knowledgeAt: request.knowledgeAt, month: request.month, items: [], nextOffset: null, totalCandidateCount: 0 };
  };
}

test("Spending page reads stop failed retries, recover stale versions and preserve the last complete snapshot", async (t) => {
  let server;
  let browser;
  try {
    server = await createSpendingViteServer();
    browser = await chromium.launch({ headless: true });
    for (const scenario of ["failure", "stale", "candidate-stale", "retain", "pairing-live", "action-race"]) {
      await t.test(scenario, async () => {
        const page = await browser.newPage();
        await page.clock.setFixedTime(new Date("2026-10-05T12:00:00+08:00"));
        try {
          await page.addInitScript(spendingDesktopApiInitScript(model) + `;(${installReads.toString()})(${JSON.stringify({ model, scenario })});`);
          await page.goto(server.resolvedUrls.local[0] + "#/spending");
          if (scenario === "failure") {
            await page.getByRole("alert").filter({ hasText: "Synthetic query failure" }).waitFor();
            await page.waitForTimeout(200);
            assert.deepEqual(await page.evaluate(() => window.__recordCalls), [1]);
            await page.evaluate(() => { window.__fail = false; window.__publish(1); });
            await page.getByText("Fixture purchase v1", { exact: true }).waitFor();
            assert.deepEqual(await page.evaluate(() => window.__recordCalls), [1, 1]);
          } else if (scenario === "stale" || scenario === "candidate-stale") {
            await page.getByText("Fixture purchase v2", { exact: true }).waitFor();
            await page.waitForFunction(() => window.__candidateCalls.at(-1) === 2);
            assert.deepEqual(await page.evaluate(() => window.__recordCalls), [1, 2]);
            assert.deepEqual(await page.evaluate(() => window.__candidateCalls), scenario === "stale" ? [2] : [1, 2]);
            assert.equal(await page.evaluate(() => window.__refreshes), 2);
            assert.equal(await page.getByRole("alert").count(), 0);
          } else if (scenario === "pairing-live" || scenario === "action-race") {
            await page.locator("[data-purchase-record]").click();
            await page.locator("[data-purchase-modal] [data-open-pairing]").click();
            await page.locator('input[name="spending-payment"]').check();
            if (scenario === "action-race") {
              await page.locator("[data-confirm-direct-pair]").click();
              await page.waitForFunction(() => Boolean(window.__finishAction));
            }
            await page.evaluate((version) => window.__publish(version), scenario === "action-race" ? 3 : 2);
            await page.waitForFunction(() => Boolean(window.__releaseRead));
            if (scenario === "pairing-live") {
              await page.waitForFunction(() => window.__ranks.includes(2), undefined, { timeout: 3000 });
              await page.waitForFunction(() => document.querySelector('[data-confirm-direct-pair]')?.disabled);
              assert.equal(await page.locator('input[name="spending-payment"]:checked').count(), 0);
              assert.equal(await page.locator("[data-pairing-dialog]").count(), 1);
              await page.getByText(/selected payment is no longer eligible|原先選擇的付款已無法配對/).waitFor();
            } else {
              await page.evaluate(() => window.__finishAction());
              await page.locator("[data-pairing-dialog]").waitFor({ state: "hidden" });
              assert.equal(await page.getByText("Action purchase v2", { exact: true }).count(), 0);
              assert.equal(await page.locator("[data-spending-updating]").count(), 1);
            }
            await page.evaluate(() => window.__releaseRead());
            await page.getByText(`Fixture purchase v${scenario === "action-race" ? 3 : 2}`, { exact: true }).first().waitFor();
            assert.equal(await page.getByRole("alert").count(), 0);
            assert.deepEqual(await page.evaluate(() => window.__recordCalls), [1, scenario === "action-race" ? 3 : 2]);
          } else {
            await page.getByText("Fixture purchase v1", { exact: true }).waitFor();
            await page.evaluate(() => window.__publish(2));
            await page.waitForFunction(() => Boolean(window.__releaseRead));
            assert.equal(await page.getByText("Fixture purchase v1", { exact: true }).count(), 1);
            assert.equal(await page.locator("[data-spending-updating]").count(), 1);
            await page.evaluate(() => window.__releaseRead());
            await page.getByText("Fixture purchase v2", { exact: true }).waitFor();
            assert.equal(await page.getByText("Fixture purchase v1", { exact: true }).count(), 0);
          }
        } finally { await page.close(); }
      });
    }
  } finally {
    await browser?.close();
    await server?.close();
  }
});
